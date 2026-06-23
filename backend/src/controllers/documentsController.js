// src/controllers/documentsController.js
// Employee Documents module
// - Every employee can view/add/edit their OWN documents
// - HR (and admin/super_admin) can view/edit/save documents for ANY employee

const db     = require('../config/db');
const multer = require('multer');
const path   = require('path');

// ── Multer — memory storage for document uploads ──────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }, // 5MB per file
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx'].includes(ext)) cb(null, true);
    else cb(new Error('Only PDF, JPG, PNG, DOC, DOCX allowed'));
  }
});
exports.uploadMiddleware = upload.single('file');

// Roles allowed to view/edit ANY employee's documents
const HR_ROLES = ['hr', 'admin', 'super_admin'];

// ── Fixed document checklist definition ────────────────────────────────────────
// key must be stable — used as the unique identifier per employee per document
const DOCUMENT_DEFS = [
  { key: 'broker_qual_renewal',   label: 'Broker Qualification & Renewal certificate', mandatory: false },
  { key: 'broker_training',       label: 'Broker Training',                            mandatory: false },
  { key: 'passport_photo',        label: 'Passport size photograph',                   mandatory: true  },
  { key: 'appointment_ack',       label: 'Acknowledgement copy of Appointment Letter', mandatory: true  },
  { key: 'aadhaar_card',          label: 'Aadhaar Card',                               mandatory: true  },
  { key: 'bank_statement_salary', label: 'Bank statement with AC details or Cancelled cheque copy for salary processing', mandatory: true },
  { key: 'qualification_cert',    label: 'Qualification Certificate',                  mandatory: true  },
  { key: 'last3_payslips',        label: 'Last 3 months pay slips or Bank statement',  mandatory: true  },
  { key: 'resume_cv',             label: 'Resume/Curriculum Vitae',                     mandatory: true  },
  { key: 'offer_promo_letter',    label: 'Offer Letter/Appointment Letter & Promotion/Increment Letter', mandatory: true },
  { key: 'other_certificates',    label: 'Other Certificates',                          mandatory: true  },
  { key: 'pan_card',              label: 'PAN Card',                                   mandatory: true  },
  { key: 'id_residence_proof',    label: 'Proof of ID & Residence address',             mandatory: true  },
  { key: 'relieving_letter',      label: 'Resignation Acceptance/Relieving Letter/Experience Letter', mandatory: true },
];

exports.DOCUMENT_DEFS = DOCUMENT_DEFS;

// ── DB Init — run once on startup ──────────────────────────────────────────────
exports.initTables = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS employee_documents (
        id              SERIAL PRIMARY KEY,
        employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        doc_key         VARCHAR(50) NOT NULL,
        original_name   VARCHAR(255),
        file_data       TEXT,        -- base64 stored in DB
        mime_type       VARCHAR(100),
        file_size       INTEGER,
        uploaded_by     INTEGER REFERENCES employees(id),
        uploaded_at     TIMESTAMP DEFAULT NOW(),
        UNIQUE(employee_id, doc_key)
      );
    `);
    console.log('✅ Employee Documents table ready');
  } catch (err) {
    console.error('❌ Employee Documents table init error:', err.message);
  }
};

// ── Helper: can the requesting user act on this employee's documents? ─────────
function canAccess(reqUser, targetEmployeeId) {
  if (HR_ROLES.includes(reqUser.role)) return true;
  return parseInt(targetEmployeeId) === parseInt(reqUser.id);
}

// ── GET /documents/checklist — static document definition list ────────────────
exports.getChecklistDefs = async (_req, res) => {
  res.json({ success: true, data: DOCUMENT_DEFS });
};

// ── GET /documents?employee_id=X — get checklist + upload status for an employee
// If employee_id omitted, defaults to the requesting user's own documents.
exports.getDocuments = async (req, res) => {
  try {
    const reqUser = req.user;
    const targetId = req.query.employee_id ? parseInt(req.query.employee_id) : reqUser.id;

    if (!canAccess(reqUser, targetId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const result = await db.query(
      `SELECT id, doc_key, original_name, mime_type, file_size, uploaded_at
       FROM employee_documents WHERE employee_id = $1`,
      [targetId]
    );
    const byKey = {};
    result.rows.forEach(r => { byKey[r.doc_key] = r; });

    const data = DOCUMENT_DEFS.map(def => ({
      ...def,
      uploaded: !!byKey[def.key],
      document: byKey[def.key] || null
    }));

    res.json({ success: true, data, employee_id: targetId });
  } catch (err) {
    console.error('[getDocuments]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── POST /documents/upload — upload/replace a document for an employee ────────
// body: employee_id, doc_key ; file: multipart field "file"
exports.uploadDocument = async (req, res) => {
  try {
    const reqUser = req.user;
    const { employee_id, doc_key } = req.body;
    const file = req.file;

    if (!file)     return res.status(400).json({ success: false, message: 'No file uploaded' });
    if (!doc_key)  return res.status(400).json({ success: false, message: 'doc_key required' });

    const targetId = employee_id ? parseInt(employee_id) : reqUser.id;
    if (!canAccess(reqUser, targetId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const validKey = DOCUMENT_DEFS.some(d => d.key === doc_key);
    if (!validKey) return res.status(400).json({ success: false, message: 'Invalid doc_key' });

    const base64 = file.buffer.toString('base64');

    await db.query(`
      INSERT INTO employee_documents
        (employee_id, doc_key, original_name, file_data, mime_type, file_size, uploaded_by, uploaded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (employee_id, doc_key)
      DO UPDATE SET original_name=$3, file_data=$4, mime_type=$5, file_size=$6,
                    uploaded_by=$7, uploaded_at=NOW()`,
      [targetId, doc_key, file.originalname, base64, file.mimetype, file.size, reqUser.id]
    );

    res.json({ success: true, message: 'Document uploaded successfully' });
  } catch (err) {
    console.error('[uploadDocument]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /documents/file/:id — view/download a document ────────────────────────
exports.getFile = async (req, res) => {
  try {
    const reqUser = req.user;
    const docId = parseInt(req.params.id);

    const result = await db.query(
      `SELECT * FROM employee_documents WHERE id = $1`, [docId]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Document not found' });

    const doc = result.rows[0];
    if (!canAccess(reqUser, doc.employee_id)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const buffer = Buffer.from(doc.file_data, 'base64');
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${doc.original_name}"`);
    res.send(buffer);
  } catch (err) {
    console.error('[getFile]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── DELETE /documents/:id — remove an uploaded document ────────────────────────
exports.deleteDocument = async (req, res) => {
  try {
    const reqUser = req.user;
    const docId = parseInt(req.params.id);

    const result = await db.query(`SELECT employee_id FROM employee_documents WHERE id = $1`, [docId]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Document not found' });

    if (!canAccess(reqUser, result.rows[0].employee_id)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    await db.query(`DELETE FROM employee_documents WHERE id = $1`, [docId]);
    res.json({ success: true, message: 'Document removed' });
  } catch (err) {
    console.error('[deleteDocument]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /documents/employees — list of employees for HR picker ─────────────────
exports.getEmployeesForPicker = async (req, res) => {
  try {
    if (!HR_ROLES.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const result = await db.query(
      `SELECT id, employee_code, first_name, last_name
       FROM employees WHERE is_active = true ORDER BY first_name ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[getEmployeesForPicker]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
