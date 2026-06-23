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

// Multiple files in one request, up to 10, field name "files"
exports.uploadMultiMiddleware = upload.array('files', 10);

// Roles allowed to view/edit ANY employee's documents
const HR_ROLES = ['hr', 'admin', 'super_admin'];

// ── Fixed document checklist definition ────────────────────────────────────────
// key must be stable — used as the unique identifier per employee per document
const DOCUMENT_DEFS = [
  { key: 'resume',                label: 'Resume / CV',                                mandatory: true  },
  { key: 'broker_qual_renewal',   label: 'Broker Qualification & Renewal Certificate', mandatory: false },
  { key: 'broker_training',       label: 'Broker Training',                            mandatory: false },
  { key: 'passport_photo',        label: 'Passport size photograph',                   mandatory: true  },
  { key: 'appointment_ack',       label: 'Acknowledgement Copy of Appointment Letter', mandatory: true  },
  { key: 'aadhaar_card',          label: 'Aadhaar Card',                               mandatory: true  },
  { key: 'pan_card',              label: 'PAN Card',                                   mandatory: true  },
  { key: 'id_residence_proof',    label: 'Proof of ID & Residence Address',            mandatory: true  },
  { key: 'tenth_marksheet',       label: '10th Marksheet / Certificate',               mandatory: true  },
  { key: 'twelfth_marksheet',     label: '12th Marksheet / Certificate',               mandatory: true  },
  { key: 'graduation_marksheet',  label: 'Graduation Marksheet',                       mandatory: true  },
  { key: 'post_graduation_cert',  label: 'Post Graduation Certificate',                mandatory: false },
  { key: 'last3_payslips',        label: 'Last 3 Months Pay Slips or Bank Statement',  mandatory: true  },
  { key: 'bank_statement_salary', label: 'Bank Statement with AC Details or Cancelled Cheque', mandatory: true },
  { key: 'offer_promo_letter',    label: 'Offer Letter / Appointment Letter & Promotion / Increment Letter', mandatory: true },
  { key: 'relieving_letter',      label: 'Resignation Acceptance / Relieving Letter / Experience Letter', mandatory: true },
  { key: 'uan_pf_document',       label: 'UAN / PF Document',                          mandatory: true  },
  { key: 'passport_dl_voterid',   label: 'Passport / Driving Licence / Voter ID',      mandatory: true  },
  { key: 'other_certificates',    label: 'Other Certificates',                         mandatory: false },
];

exports.DOCUMENT_DEFS = DOCUMENT_DEFS;

// ── DB Init — run once on startup ──────────────────────────────────────────────
exports.initTables = async () => {
  try {
    // NOTE: no UNIQUE(employee_id, doc_key) here — multiple files per doc_key are allowed.
    await db.query(`
      CREATE TABLE IF NOT EXISTS employee_doc_checklist (
        id              SERIAL PRIMARY KEY,
        employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        doc_key         VARCHAR(50) NOT NULL,
        original_name   VARCHAR(255),
        file_data       TEXT,        -- base64 stored in DB
        mime_type       VARCHAR(100),
        file_size       INTEGER,
        uploaded_by     INTEGER REFERENCES employees(id),
        uploaded_at     TIMESTAMP DEFAULT NOW()
      );
    `);

    // Deployments created before this change have the old UNIQUE(employee_id, doc_key)
    // constraint, which blocks multiple files per doc type. Drop it if present.
    // The name below is Postgres' default auto-generated name for this constraint;
    // we look it up dynamically as a fallback in case it was ever renamed.
    await db.query(`
      DO $$
      DECLARE c_name text;
      BEGIN
        SELECT conname INTO c_name
        FROM pg_constraint
        WHERE conrelid = 'employee_doc_checklist'::regclass
          AND contype = 'u';
        IF c_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE employee_doc_checklist DROP CONSTRAINT %I', c_name);
        END IF;
      END $$;
    `);

    // Non-unique index for fast per-employee/per-doc-type lookups (replaces the old
    // implicit unique index now that multiple rows per key are allowed).
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_emp_doc_checklist_emp_key
        ON employee_doc_checklist(employee_id, doc_key);
    `);

    console.log('✅ Employee Documents table ready (multi-file support)');
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
       FROM employee_doc_checklist
       WHERE employee_id = $1
       ORDER BY doc_key, uploaded_at DESC`,
      [targetId]
    );

    // Group by doc_key — each key can now have multiple uploaded files
    const byKey = {};
    result.rows.forEach(r => {
      if (!byKey[r.doc_key]) byKey[r.doc_key] = [];
      byKey[r.doc_key].push(r);
    });

    const data = DOCUMENT_DEFS.map(def => ({
      ...def,
      uploaded: !!(byKey[def.key] && byKey[def.key].length),
      documents: byKey[def.key] || []   // array — may contain 0, 1, or many files
    }));

    res.json({ success: true, data, employee_id: targetId });
  } catch (err) {
    console.error('[getDocuments]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── POST /documents/upload — upload a document for an employee ────────────────
// body: employee_id, doc_key ; file: multipart field "file"
// Each call adds a NEW row — multiple files per doc_key are allowed.
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
      INSERT INTO employee_doc_checklist
        (employee_id, doc_key, original_name, file_data, mime_type, file_size, uploaded_by, uploaded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
      [targetId, doc_key, file.originalname, base64, file.mimetype, file.size, reqUser.id]
    );

    res.json({ success: true, message: 'Document uploaded successfully' });
  } catch (err) {
    console.error('[uploadDocument]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── POST /documents/upload-multi — upload MULTIPLE files for one doc_key ──────
// body: employee_id, doc_key ; files: multipart field "files" (up to 10)
exports.uploadMultiDocument = async (req, res) => {
  try {
    const reqUser = req.user;
    const { employee_id, doc_key } = req.body;
    const files = req.files;

    if (!files || !files.length) return res.status(400).json({ success: false, message: 'No files uploaded' });
    if (!doc_key)                 return res.status(400).json({ success: false, message: 'doc_key required' });

    const targetId = employee_id ? parseInt(employee_id) : reqUser.id;
    if (!canAccess(reqUser, targetId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const validKey = DOCUMENT_DEFS.some(d => d.key === doc_key);
    if (!validKey) return res.status(400).json({ success: false, message: 'Invalid doc_key' });

    for (const file of files) {
      const base64 = file.buffer.toString('base64');
      await db.query(`
        INSERT INTO employee_doc_checklist
          (employee_id, doc_key, original_name, file_data, mime_type, file_size, uploaded_by, uploaded_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [targetId, doc_key, file.originalname, base64, file.mimetype, file.size, reqUser.id]
      );
    }

    res.json({ success: true, message: `${files.length} file(s) uploaded successfully` });
  } catch (err) {
    console.error('[uploadMultiDocument]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /documents/file/:id — view/download a document ────────────────────────
exports.getFile = async (req, res) => {
  try {
    const reqUser = req.user;
    const docId = parseInt(req.params.id);

    const result = await db.query(
      `SELECT * FROM employee_doc_checklist WHERE id = $1`, [docId]
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

    const result = await db.query(`SELECT employee_id FROM employee_doc_checklist WHERE id = $1`, [docId]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Document not found' });

    if (!canAccess(reqUser, result.rows[0].employee_id)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    await db.query(`DELETE FROM employee_doc_checklist WHERE id = $1`, [docId]);
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

// ── GET /documents/download-zip/:employee_id — zip of all docs + excel sheets ─
exports.downloadZip = async (req, res) => {
  try {
    const reqUser = req.user;
    const empId   = parseInt(req.params.employee_id);
    if (!canAccess(reqUser, empId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Get employee info
    const empRes = await db.query(
      `SELECT employee_code, first_name, last_name FROM employees WHERE id=$1`, [empId]
    );
    const emp = empRes.rows[0];
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    const empName = `${emp.first_name}_${emp.last_name}`.replace(/[^a-zA-Z0-9_]/g,'_');

    // Get all uploaded documents
    const docsRes = await db.query(
      `SELECT doc_key, original_name, file_data, mime_type FROM employee_doc_checklist WHERE employee_id=$1`,
      [empId]
    );

    // Get prev employment and qualifications
    const empDocsDb = require('../config/db');
    let prevEmpRows = [], qualRows = [];
    try {
      const pe = await empDocsDb.query(
        `SELECT * FROM employee_previous_employment WHERE employee_id=$1 ORDER BY from_date DESC NULLS LAST`, [empId]
      );
      prevEmpRows = pe.rows;
    } catch(_) {}
    try {
      const qu = await empDocsDb.query(
        `SELECT * FROM employee_qualifications WHERE employee_id=$1 ORDER BY passing_year DESC NULLS LAST`, [empId]
      );
      qualRows = qu.rows;
    } catch(_) {}

    const archiver = require('archiver');
    const archive  = archiver('zip', { zlib:{ level:6 } });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${empName}_documents.zip"`);
    archive.pipe(res);

    // Add uploaded files into Documents/ folder
    const keyCount = {};
    for (const doc of docsRes.rows) {
      if (!doc.file_data) continue;
      const buf = Buffer.from(doc.file_data, 'base64');
      const defLabel = (DOCUMENT_DEFS.find(d => d.key === doc.doc_key)?.label || doc.doc_key)
        .replace(/[/\\:*?"<>|]/g,'_');
      keyCount[doc.doc_key] = (keyCount[doc.doc_key] || 0) + 1;
      const count  = keyCount[doc.doc_key];
      const ext    = doc.original_name.includes('.') ? doc.original_name.split('.').pop() : 'bin';
      const fname  = count > 1 ? `${defLabel}_${count}.${ext}` : `${defLabel}.${ext}`;
      archive.append(buf, { name: `Documents/${fname}` });
    }

    // Build Previous Employment Excel
    if (prevEmpRows.length) {
      const XLSX = require('xlsx');
      const peData = prevEmpRows.map(r => ({
        'Company Name':      r.company_name || '',
        'Designation':       r.designation  || '',
        'From Date':         r.from_date    ? new Date(r.from_date).toLocaleDateString('en-IN') : '',
        'To Date':           r.to_date      ? new Date(r.to_date).toLocaleDateString('en-IN')   : '',
        'Job Type':          r.job_type     || '',
        'City':              r.city         || '',
        'State':             r.state        || '',
        'PF Number':         r.pf_number    || '',
        'Prev Manager':      r.prev_manager_name  || '',
        'Manager Phone':     r.prev_manager_phone || '',
        'Manager Email':     r.prev_manager_email || '',
        'Prev HR Name':      r.prev_hr_name  || '',
        'HR Phone':          r.prev_hr_phone || '',
        'HR Email':          r.prev_hr_email || '',
        'Company Address':   r.company_address    || '',
        'Reason for Leaving':r.reason_for_leaving || '',
        'Overseas':          r.is_overseas ? 'Yes' : 'No',
        'Relevant':          r.is_relevant  ? 'Yes' : 'No',
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(peData), 'Previous Employment');
      const xlsBuf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
      archive.append(xlsBuf, { name: 'Previous_Employment.xlsx' });
    }

    // Build Qualifications Excel
    if (qualRows.length) {
      const XLSX = require('xlsx');
      const months = ['','January','February','March','April','May','June','July','August','September','October','November','December'];
      const quData = qualRows.map(r => ({
        'Qualification':          r.qualification          || '',
        'Degree':                 r.degree                 || '',
        'Specialization':         r.specialization         || '',
        'Institute Name':         r.institute_name         || '',
        'Board / University':     r.board_university       || '',
        'Mode of Education':      r.mode_of_education      || '',
        'State / Location':       r.state_location         || '',
        'Grade / %':              r.grade_percentage       || '',
        'Passing Month':          r.passing_month ? months[r.passing_month] : '',
        'Passing Year':           r.passing_year           || '',
        'Academic Achievements':  r.academic_achievements  || '',
        'Remarks':                r.remarks                || '',
        'Highest Qualification':  r.is_highest ? 'Yes' : 'No',
      }));
      const wb2 = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb2, XLSX.utils.json_to_sheet(quData), 'Qualifications');
      const xlsBuf2 = XLSX.write(wb2, { type:'buffer', bookType:'xlsx' });
      archive.append(xlsBuf2, { name: 'Qualifications.xlsx' });
    }

    archive.finalize();
  } catch (err) {
    console.error('[downloadZip]', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Server error' });
  }
};
