// src/controllers/sendDocumentsController.js
// "Send Documents" feature — HR/Admin/Accounts can push arbitrary documents to any employee.
// Recipients see & download what was sent to them (individually or as ZIP).
//
// Storage: base64 in Postgres (matches documentsController.js — safe on Render ephemeral fs)
// Pattern: mirrors documentsController.js throughout

'use strict';

const db     = require('../config/db');
const multer = require('multer');
const path   = require('path');
const { v4: uuidv4 } = require('uuid');

// ── Roles that may SEND documents ─────────────────────────────────────────────
const SENDER_ROLES = ['hr', 'admin', 'super_admin', 'accounts'];

// ── Multer — memory storage, max 5 files, 10 MB each ─────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },   // 10 MB per file
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx', '.xls', '.xlsx'];
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only PDF, JPG, PNG, DOC, DOCX, XLS, XLSX are allowed'));
  }
});

// Field name "files", up to 5
exports.uploadMiddleware = (req, res, next) => {
  upload.array('files', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message || 'File upload error' });
    next();
  });
};

// ── DB table auto-create — called from server.js initTables block ─────────────
exports.initTables = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS sent_documents (
        id            SERIAL PRIMARY KEY,
        batch_id      UUID NOT NULL,
        recipient_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        sender_id     INTEGER NOT NULL REFERENCES employees(id),
        title         VARCHAR(255),
        note          TEXT,
        original_name VARCHAR(255) NOT NULL,
        file_data     TEXT NOT NULL,
        mime_type     VARCHAR(100),
        file_size     INTEGER,
        sent_at       TIMESTAMP DEFAULT NOW(),
        read_at       TIMESTAMP
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sent_docs_recipient ON sent_documents(recipient_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sent_docs_sender    ON sent_documents(sender_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sent_docs_batch     ON sent_documents(batch_id);`);
    console.log('✅ sent_documents table ready');
  } catch (err) {
    console.error('❌ sendDocumentsController.initTables:', err.message);
  }
};

// ── Access helpers ─────────────────────────────────────────────────────────────

// Is the caller a sender-role (HR / admin / super_admin / accounts)?
function isSenderRole(user) {
  return SENDER_ROLES.includes(user?.role);
}

// Can caller access a specific sent_documents record?
// HR roles: full access. Others: only their own recipient or sender record.
async function canAccess(user, docId) {
  if (isSenderRole(user)) return true;
  const r = await db.query(
    `SELECT id FROM sent_documents WHERE id=$1 AND (recipient_id=$2 OR sender_id=$2)`,
    [docId, user.id]
  );
  return r.rows.length > 0;
}

// Can caller access a batch?
async function canAccessBatch(user, batchId) {
  if (isSenderRole(user)) return true;
  const r = await db.query(
    `SELECT id FROM sent_documents WHERE batch_id=$1 AND (recipient_id=$2 OR sender_id=$2)`,
    [batchId, user.id]
  );
  return r.rows.length > 0;
}

// ── Helper: group flat rows into batch objects ─────────────────────────────────
function groupIntoBatches(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.batch_id)) {
      map.set(row.batch_id, {
        batch_id:       row.batch_id,
        title:          row.title,
        note:           row.note,
        sent_at:        row.sent_at,
        sender_id:      row.sender_id,
        sender_name:    row.sender_name,
        recipient_id:   row.recipient_id,
        recipient_name: row.recipient_name,
        files: []
      });
    }
    map.get(row.batch_id).files.push({
      id:            row.id,
      original_name: row.original_name,
      mime_type:     row.mime_type,
      file_size:     row.file_size,
      read_at:       row.read_at
      // file_data intentionally omitted from list views
    });
  }
  return Array.from(map.values());
}

// ── POST /send-documents/send ─────────────────────────────────────────────────
// Sender attaches up to 5 files and sends them to one recipient.
exports.send = async (req, res) => {
  try {
    if (!isSenderRole(req.user)) {
      return res.status(403).json({ success: false, message: 'Only HR/Admin/Accounts can send documents' });
    }

    const { recipient_id, title, note } = req.body;
    const files = req.files || [];

    if (!recipient_id) return res.status(400).json({ success: false, message: 'recipient_id is required' });
    if (!files.length) return res.status(400).json({ success: false, message: 'At least 1 file is required' });
    if (files.length > 5)  return res.status(400).json({ success: false, message: 'Maximum 5 files per send' });

    // Verify recipient exists
    const recip = await db.query(`SELECT id FROM employees WHERE id=$1`, [parseInt(recipient_id)]);
    if (!recip.rows.length) return res.status(404).json({ success: false, message: 'Recipient not found' });

    const batchId = uuidv4();
    const senderId = req.user.id;

    for (const file of files) {
      const b64 = file.buffer.toString('base64');
      await db.query(
        `INSERT INTO sent_documents
           (batch_id, recipient_id, sender_id, title, note, original_name, file_data, mime_type, file_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          batchId,
          parseInt(recipient_id),
          senderId,
          title?.trim() || null,
          note?.trim()  || null,
          file.originalname,
          b64,
          file.mimetype,
          file.size
        ]
      );
    }

    res.json({ success: true, message: `${files.length} document(s) sent`, data: { batch_id: batchId } });
  } catch (err) {
    console.error('sendDocuments.send:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /send-documents/received ─────────────────────────────────────────────
// List documents sent TO the logged-in user, grouped by batch.
exports.getReceived = async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT
         sd.id, sd.batch_id, sd.title, sd.note, sd.sent_at, sd.read_at,
         sd.original_name, sd.mime_type, sd.file_size,
         sd.sender_id, sd.recipient_id,
         CONCAT(s.first_name,' ',s.last_name) AS sender_name,
         CONCAT(r.first_name,' ',r.last_name) AS recipient_name
       FROM sent_documents sd
       JOIN employees s ON s.id = sd.sender_id
       JOIN employees r ON r.id = sd.recipient_id
       WHERE sd.recipient_id = $1
       ORDER BY sd.sent_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, data: groupIntoBatches(rows.rows) });
  } catch (err) {
    console.error('sendDocuments.getReceived:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /send-documents/sent ──────────────────────────────────────────────────
// List documents SENT BY the logged-in user (HR roles), grouped by batch.
exports.getSent = async (req, res) => {
  try {
    if (!isSenderRole(req.user)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const rows = await db.query(
      `SELECT
         sd.id, sd.batch_id, sd.title, sd.note, sd.sent_at, sd.read_at,
         sd.original_name, sd.mime_type, sd.file_size,
         sd.sender_id, sd.recipient_id,
         CONCAT(s.first_name,' ',s.last_name) AS sender_name,
         CONCAT(r.first_name,' ',r.last_name) AS recipient_name
       FROM sent_documents sd
       JOIN employees s ON s.id = sd.sender_id
       JOIN employees r ON r.id = sd.recipient_id
       WHERE sd.sender_id = $1
       ORDER BY sd.sent_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, data: groupIntoBatches(rows.rows) });
  } catch (err) {
    console.error('sendDocuments.getSent:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /send-documents/file/:id ─────────────────────────────────────────────
// Stream a single file. Marks read_at when recipient opens it.
exports.getFile = async (req, res) => {
  try {
    const docId = parseInt(req.params.id);
    if (!await canAccess(req.user, docId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const r = await db.query(
      `SELECT id, original_name, mime_type, file_size, file_data, recipient_id, read_at
       FROM sent_documents WHERE id=$1`,
      [docId]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'File not found' });

    const doc = r.rows[0];

    // Mark read_at if this is the recipient opening it for the first time
    if (doc.recipient_id === req.user.id && !doc.read_at) {
      await db.query(`UPDATE sent_documents SET read_at=NOW() WHERE id=$1`, [docId]);
    }

    const buffer = Buffer.from(doc.file_data, 'base64');
    res.setHeader('Content-Type',        doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length',      buffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.original_name)}"`);
    res.send(buffer);
  } catch (err) {
    console.error('sendDocuments.getFile:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /send-documents/zip/:batch_id ────────────────────────────────────────
// ZIP all files in a batch and stream the archive.
exports.getZip = async (req, res) => {
  try {
    const batchId = req.params.batch_id;
    if (!await canAccessBatch(req.user, batchId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const r = await db.query(
      `SELECT id, original_name, mime_type, file_data, recipient_id, read_at
       FROM sent_documents WHERE batch_id=$1`,
      [batchId]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Batch not found' });

    // Mark all files in batch as read if this is the recipient
    const firstRow = r.rows[0];
    if (firstRow.recipient_id === req.user.id) {
      await db.query(
        `UPDATE sent_documents SET read_at=NOW() WHERE batch_id=$1 AND recipient_id=$2 AND read_at IS NULL`,
        [batchId, req.user.id]
      );
    }

    const archiver = require('archiver');
    res.setHeader('Content-Type',        'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="documents_${batchId.slice(0,8)}.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => { console.error('ZIP error:', err.message); });
    archive.pipe(res);

    // Handle duplicate filenames within the same batch by appending index
    const seen = new Map();
    for (const row of r.rows) {
      const buf = Buffer.from(row.file_data, 'base64');
      let name = row.original_name;
      if (seen.has(name)) {
        const ext  = path.extname(name);
        const base = path.basename(name, ext);
        seen.set(name, seen.get(name) + 1);
        name = `${base}_${seen.get(name)}${ext}`;
      } else {
        seen.set(row.original_name, 1);
      }
      archive.append(buf, { name });
    }

    await archive.finalize();
  } catch (err) {
    console.error('sendDocuments.getZip:', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── DELETE /send-documents/:id ────────────────────────────────────────────────
// Remove a single sent document. Allowed for sender or HR roles.
exports.deleteDoc = async (req, res) => {
  try {
    const docId = parseInt(req.params.id);

    // Check existence first
    const r = await db.query(
      `SELECT id, sender_id FROM sent_documents WHERE id=$1`,
      [docId]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Document not found' });

    const doc = r.rows[0];
    // Allow: HR roles OR the original sender
    if (!isSenderRole(req.user) && doc.sender_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the sender or HR can delete this document' });
    }

    await db.query(`DELETE FROM sent_documents WHERE id=$1`, [docId]);
    res.json({ success: true, message: 'Document removed' });
  } catch (err) {
    console.error('sendDocuments.deleteDoc:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
