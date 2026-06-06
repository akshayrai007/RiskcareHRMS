// chatFileController.js — Chunked 1GB file upload with streaming to disk
// Strategy:
//   1. Files are uploaded in 5MB chunks (multipart form, no memory bloat)
//   2. Chunks are assembled on disk in /tmp/uploads/chat/<uploadId>/
//   3. Final assembled file is served from disk OR stored in DB depending on size
//      - ≤ 10 MB  → store in chat_file_data (bytea) for portability
//      - > 10 MB  → keep on disk, serve via streaming with range support
//   4. A single /api/chat/upload/init  endpoint initialises the session
//      /api/chat/upload/chunk/:uploadId uploads each chunk
//      /api/chat/upload/complete/:uploadId finalises and posts the message
//   5. A /api/chat/files/:id endpoint serves files with streaming + range headers

const db      = require('../config/db');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

// ── Constants ──────────────────────────────────────────────────────────────────
const CHUNK_UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'chunks');
const FILE_UPLOAD_DIR  = path.join(__dirname, '..', '..', 'uploads', 'chat');
const MAX_FILE_BYTES   = 1024 * 1024 * 1024; // 1 GB hard limit
const DB_THRESHOLD     = 10  * 1024 * 1024;  // files ≤ 10MB go into bytea column
const BLOCKED_EXTS     = ['.exe','.bat','.sh','.cmd','.msi','.ps1','.vbs','.scr','.pif'];

// Ensure directories exist
[CHUNK_UPLOAD_DIR, FILE_UPLOAD_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── In-memory upload session tracker (reset on server restart — that's fine) ─
//    For production, replace with Redis: { uploadId -> { gid, empId, name, mime, totalChunks, received } }
const sessions = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────
function isGroupMember(gid, empId) {
  return db.query(
    `SELECT role FROM chat_group_members WHERE group_id=$1 AND employee_id=$2 AND left_at IS NULL`,
    [gid, empId]
  ).then(r => r.rows[0] || null);
}
function emitToGroup(gid, event, data) {
  if (global.io) global.io.to(`group:${gid}`).emit(event, data);
}

// ── Multer for chunk uploads (only) ──────────────────────────────────────────
// Each chunk ≤ 6 MB so memoryStorage is safe here
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }  // 6 MB per chunk
}).single('chunk');

// ── Small-file direct upload (≤ 50 MB, single shot, backwards compat) ────────
const directUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXTS.includes(ext)) return cb(new Error('File type not allowed'));
    cb(null, true);
  }
}).single('file');

exports.directUploadMiddleware = directUpload;

// ════════════════════════════════════════════════════════════════════════════════
// 1. DIRECT UPLOAD (≤ 50 MB, single shot — keeps existing Android/web compat)
// ════════════════════════════════════════════════════════════════════════════════
exports.sendFile = async (req, res) => {
  try {
    const empId = req.user.id;
    const gid   = parseInt(req.params.id);
    if (!await isGroupMember(gid, empId))
      return res.status(403).json({ success: false, message: 'Not a member' });
    if (!req.file)
      return res.status(400).json({ success: false, message: 'No file uploaded' });

    const { originalname, mimetype, size, buffer } = req.file;
    let msgType = 'file';
    if (mimetype.startsWith('image/')) msgType = 'image';
    if (mimetype.startsWith('audio/')) msgType = 'audio';
    if (mimetype.startsWith('video/')) msgType = 'video';

    let fileUrl;
    if (size <= DB_THRESHOLD) {
      // ≤ 10 MB → store in DB
      const row = await db.query(
        `INSERT INTO chat_file_data(original_name, mime_type, file_size, file_data)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [originalname, mimetype, size, buffer]
      );
      fileUrl = `/api/chat/files/${row.rows[0].id}`;
    } else {
      // > 10 MB → write to disk
      const fileId  = uuidv4();
      const diskPath = path.join(FILE_UPLOAD_DIR, fileId);
      fs.writeFileSync(diskPath, buffer);
      // Record in DB without blob
      const row = await db.query(
        `INSERT INTO chat_file_data(original_name, mime_type, file_size, disk_path)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [originalname, mimetype, size, diskPath]
      );
      fileUrl = `/api/chat/files/${row.rows[0].id}`;
    }

    const r = await db.query(`
      INSERT INTO chat_messages(group_id, sender_id, content, message_type, file_name, file_size, file_mime, file_url)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [gid, empId, originalname, msgType, originalname, size, mimetype, fileUrl]);

    const msg = r.rows[0];
    const emp = await db.query(
      `SELECT CONCAT(first_name,' ',last_name) AS name, employee_code FROM employees WHERE id=$1`, [empId]
    );
    const full = { ...msg, sender_name: emp.rows[0]?.name, sender_code: emp.rows[0]?.employee_code, reactions: [], seen_count: 0, delivered_count: 0 };
    emitToGroup(gid, 'message', full);
    res.json({ success: true, data: full });
  } catch (e) {
    console.error('[sendFile]', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════════
// 2. CHUNKED UPLOAD — for files > 50 MB up to 1 GB
// ════════════════════════════════════════════════════════════════════════════════

// POST /api/chat/upload/init
// Body: { groupId, fileName, fileSize, mimeType, totalChunks }
exports.initUpload = async (req, res) => {
  try {
    const empId = req.user.id;
    const { groupId, fileName, fileSize, mimeType, totalChunks } = req.body;

    if (!groupId || !fileName || !fileSize || !totalChunks)
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    if (fileSize > MAX_FILE_BYTES)
      return res.status(400).json({ success: false, message: 'File exceeds 1 GB limit' });

    const ext = path.extname(fileName).toLowerCase();
    if (BLOCKED_EXTS.includes(ext))
      return res.status(400).json({ success: false, message: 'File type not allowed' });

    if (!await isGroupMember(groupId, empId))
      return res.status(403).json({ success: false, message: 'Not a group member' });

    const uploadId = uuidv4();
    const tmpDir   = path.join(CHUNK_UPLOAD_DIR, uploadId);
    fs.mkdirSync(tmpDir, { recursive: true });

    sessions.set(uploadId, {
      gid: parseInt(groupId), empId, fileName, fileSize: parseInt(fileSize),
      mimeType, totalChunks: parseInt(totalChunks), received: new Set(),
      tmpDir, createdAt: Date.now()
    });

    // Clean up stale sessions > 2 hours old
    for (const [id, s] of sessions) {
      if (Date.now() - s.createdAt > 7200000) {
        try { fs.rmSync(s.tmpDir, { recursive: true, force: true }); } catch (_) {}
        sessions.delete(id);
      }
    }

    res.json({ success: true, uploadId });
  } catch (e) {
    console.error('[initUpload]', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// POST /api/chat/upload/chunk/:uploadId
// Form: chunk (binary), chunkIndex (number)
exports.uploadChunk = (req, res) => {
  chunkUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    try {
      const { uploadId } = req.params;
      const chunkIndex   = parseInt(req.body.chunkIndex);
      const session      = sessions.get(uploadId);

      if (!session) return res.status(404).json({ success: false, message: 'Upload session not found' });
      if (session.empId !== req.user.id) return res.status(403).json({ success: false, message: 'Forbidden' });
      if (!req.file)  return res.status(400).json({ success: false, message: 'No chunk data' });

      const chunkPath = path.join(session.tmpDir, `chunk_${String(chunkIndex).padStart(6, '0')}`);
      fs.writeFileSync(chunkPath, req.file.buffer);
      session.received.add(chunkIndex);

      res.json({
        success: true,
        chunkIndex,
        received: session.received.size,
        total: session.totalChunks
      });
    } catch (e) {
      console.error('[uploadChunk]', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  });
};

// POST /api/chat/upload/complete/:uploadId
exports.completeUpload = async (req, res) => {
  const { uploadId } = req.params;
  const session = sessions.get(uploadId);

  if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
  if (session.empId !== req.user.id) return res.status(403).json({ success: false, message: 'Forbidden' });

  if (session.received.size !== session.totalChunks)
    return res.status(400).json({
      success: false,
      message: `Missing chunks: expected ${session.totalChunks}, got ${session.received.size}`
    });

  try {
    // Assemble chunks in order
    const finalId   = uuidv4();
    const finalPath = path.join(FILE_UPLOAD_DIR, finalId);
    const writeStream = fs.createWriteStream(finalPath);

    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(session.tmpDir, `chunk_${String(i).padStart(6, '0')}`);
      const data = fs.readFileSync(chunkPath);
      writeStream.write(data);
    }
    await new Promise((resolve, reject) => {
      writeStream.end();
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // Cleanup temp chunks
    fs.rmSync(session.tmpDir, { recursive: true, force: true });
    sessions.delete(uploadId);

    const { gid, empId, fileName, fileSize, mimeType } = session;

    // Determine storage: ≤ 10 MB → DB, else disk
    let fileUrl;
    if (fileSize <= DB_THRESHOLD) {
      const buffer = fs.readFileSync(finalPath);
      const row = await db.query(
        `INSERT INTO chat_file_data(original_name, mime_type, file_size, file_data)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [fileName, mimeType, fileSize, buffer]
      );
      fs.unlinkSync(finalPath); // remove disk copy after DB insert
      fileUrl = `/api/chat/files/${row.rows[0].id}`;
    } else {
      const row = await db.query(
        `INSERT INTO chat_file_data(original_name, mime_type, file_size, disk_path)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [fileName, mimeType, fileSize, finalPath]
      );
      fileUrl = `/api/chat/files/${row.rows[0].id}`;
    }

    let msgType = 'file';
    if (mimeType.startsWith('image/')) msgType = 'image';
    if (mimeType.startsWith('audio/')) msgType = 'audio';
    if (mimeType.startsWith('video/')) msgType = 'video';

    const r = await db.query(`
      INSERT INTO chat_messages(group_id, sender_id, content, message_type, file_name, file_size, file_mime, file_url)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [gid, empId, fileName, msgType, fileName, fileSize, mimeType, fileUrl]);

    const msg = r.rows[0];
    const emp = await db.query(
      `SELECT CONCAT(first_name,' ',last_name) AS name, employee_code FROM employees WHERE id=$1`, [empId]
    );
    const full = {
      ...msg, sender_name: emp.rows[0]?.name, sender_code: emp.rows[0]?.employee_code,
      reactions: [], seen_count: 0, delivered_count: 0
    };
    emitToGroup(gid, 'message', full);
    res.json({ success: true, data: full });
  } catch (e) {
    console.error('[completeUpload]', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// DELETE /api/chat/upload/abort/:uploadId
exports.abortUpload = (req, res) => {
  const { uploadId } = req.params;
  const session = sessions.get(uploadId);
  if (session && session.empId === req.user.id) {
    try { fs.rmSync(session.tmpDir, { recursive: true, force: true }); } catch (_) {}
    sessions.delete(uploadId);
  }
  res.json({ success: true });
};

// GET /api/chat/upload/status/:uploadId
exports.uploadStatus = (req, res) => {
  const session = sessions.get(req.params.uploadId);
  if (!session || session.empId !== req.user.id)
    return res.status(404).json({ success: false, message: 'Session not found' });
  res.json({ success: true, received: session.received.size, total: session.totalChunks, missing: [...Array(session.totalChunks).keys()].filter(i => !session.received.has(i)) });
};

// ════════════════════════════════════════════════════════════════════════════════
// 3. FILE SERVING — with HTTP Range support (video seek, large downloads)
// ════════════════════════════════════════════════════════════════════════════════
exports.serveFile = async (req, res) => {
  try {
    const fileId = parseInt(req.params.id);
    const row = await db.query(
      `SELECT original_name, mime_type, file_size, file_data, disk_path FROM chat_file_data WHERE id=$1`,
      [fileId]
    );
    if (!row.rows.length) return res.status(404).json({ message: 'File not found' });

    const { original_name, mime_type, file_size, file_data, disk_path } = row.rows[0];
    const safe = encodeURIComponent(original_name);

    if (disk_path) {
      // Large file — stream from disk with Range support
      if (!fs.existsSync(disk_path))
        return res.status(404).json({ message: 'File missing from disk' });

      const stat = fs.statSync(disk_path);
      const total = stat.size;
      const range = req.headers.range;

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${safe}`);

      if (range) {
        const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(startStr, 10);
        const end   = endStr ? parseInt(endStr, 10) : total - 1;
        const chunk = end - start + 1;
        res.writeHead(206, {
          'Content-Range':  `bytes ${start}-${end}/${total}`,
          'Content-Length': chunk,
        });
        fs.createReadStream(disk_path, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Length': total });
        fs.createReadStream(disk_path).pipe(res);
      }
    } else if (file_data) {
      // Small file from DB bytea
      const buf = Buffer.isBuffer(file_data) ? file_data : Buffer.from(file_data);
      res.setHeader('Content-Type', mime_type || 'application/octet-stream');
      res.setHeader('Content-Length', buf.length);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${safe}`);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(buf);
    } else {
      res.status(404).json({ message: 'File data missing' });
    }
  } catch (e) {
    console.error('[serveFile]', e.message);
    res.status(500).json({ message: e.message });
  }
};
