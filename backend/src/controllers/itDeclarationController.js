const CONFIG = require('../Main_file');
// src/controllers/itDeclarationController.js
// Investment Declaration + Proof Upload + HR Review

const db      = require('../config/db');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

// ── Multer — memory storage for proof docs ────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }, // 5MB per file
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.pdf','.jpg','.jpeg','.png'].includes(ext)) cb(null, true);
    else cb(new Error('Only PDF, JPG, PNG allowed'));
  }
});
exports.uploadMiddleware = upload.single('proof_file');

// ── DB Init — run once on startup ─────────────────────────────────────────────
exports.initTables = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS it_declarations (
        id                  SERIAL PRIMARY KEY,
        employee_id         INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        financial_year      VARCHAR(10) NOT NULL,  -- e.g. '2024-25'
        regime              VARCHAR(10) DEFAULT 'old', -- 'old' or 'new'
        -- HRA
        rent_paid_monthly   NUMERIC(12,2) DEFAULT 0,
        landlord_name       VARCHAR(200),
        landlord_pan        VARCHAR(20),
        -- 80C
        sec80c_pf           NUMERIC(12,2) DEFAULT 0,
        sec80c_ppf          NUMERIC(12,2) DEFAULT 0,
        sec80c_lic          NUMERIC(12,2) DEFAULT 0,
        sec80c_elss         NUMERIC(12,2) DEFAULT 0,
        sec80c_nsc          NUMERIC(12,2) DEFAULT 0,
        sec80c_home_loan    NUMERIC(12,2) DEFAULT 0,
        sec80c_tuition      NUMERIC(12,2) DEFAULT 0,
        sec80c_other        NUMERIC(12,2) DEFAULT 0,
        -- 80D
        sec80d_self         NUMERIC(12,2) DEFAULT 0,
        sec80d_parents      NUMERIC(12,2) DEFAULT 0,
        -- 80E
        sec80e_edu_loan     NUMERIC(12,2) DEFAULT 0,
        -- 24b
        sec24b_home_loan    NUMERIC(12,2) DEFAULT 0,
        -- 80G
        sec80g_donation     NUMERIC(12,2) DEFAULT 0,
        -- 80CCD
        sec80ccd_nps        NUMERIC(12,2) DEFAULT 0,
        -- Computed totals
        total_80c           NUMERIC(12,2) DEFAULT 0,
        total_deductions    NUMERIC(12,2) DEFAULT 0,
        -- Status
        status              VARCHAR(20) DEFAULT 'draft', -- draft/submitted/approved/rejected
        hr_comment          TEXT,
        submitted_at        TIMESTAMP,
        reviewed_at         TIMESTAMP,
        reviewed_by         INTEGER REFERENCES employees(id),
        created_at          TIMESTAMP DEFAULT NOW(),
        updated_at          TIMESTAMP DEFAULT NOW(),
        UNIQUE(employee_id, financial_year)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS it_proof_documents (
        id              SERIAL PRIMARY KEY,
        declaration_id  INTEGER NOT NULL REFERENCES it_declarations(id) ON DELETE CASCADE,
        employee_id     INTEGER NOT NULL REFERENCES employees(id),
        section         VARCHAR(50) NOT NULL, -- e.g. '80C_LIC', 'HRA', '80D'
        section_label   VARCHAR(100),
        filename        VARCHAR(255),
        original_name   VARCHAR(255),
        file_data       TEXT,         -- base64 stored in DB
        mime_type       VARCHAR(100),
        file_size       INTEGER,
        status          VARCHAR(20) DEFAULT 'pending', -- pending/approved/rejected
        hr_comment      TEXT,
        uploaded_at     TIMESTAMP DEFAULT NOW(),
        reviewed_at     TIMESTAMP,
        reviewed_by     INTEGER REFERENCES employees(id)
      );
    `);
    console.log('✅ IT Declaration tables ready');
  } catch (err) {
    console.error('❌ IT Declaration table init error:', err.message);
  }
};

// ── Helper: calculate totals ──────────────────────────────────────────────────
function calcTotals(d) {
  const c80c = Math.min(
    (parseFloat(d.sec80c_pf       || 0)) +
    (parseFloat(d.sec80c_ppf      || 0)) +
    (parseFloat(d.sec80c_lic      || 0)) +
    (parseFloat(d.sec80c_elss     || 0)) +
    (parseFloat(d.sec80c_nsc      || 0)) +
    (parseFloat(d.sec80c_home_loan|| 0)) +
    (parseFloat(d.sec80c_tuition  || 0)) +
    (parseFloat(d.sec80c_other    || 0)),
    150000  // 80C cap
  );
  const total =
    c80c +
    Math.min(parseFloat(d.sec80d_self    || 0), 25000) +
    Math.min(parseFloat(d.sec80d_parents || 0), 50000) +
    parseFloat(d.sec80e_edu_loan  || 0) +
    Math.min(parseFloat(d.sec24b_home_loan || 0), 200000) +
    parseFloat(d.sec80g_donation  || 0) +
    Math.min(parseFloat(d.sec80ccd_nps   || 0), 50000);
  return { total_80c: c80c, total_deductions: total };
}

// ── GET /it-declaration — get own or specific employee declaration ─────────────
exports.getDeclaration = async (req, res) => {
  try {
    const reqUser = req.user;
    const empId   = req.query.employee_id ? parseInt(req.query.employee_id) : reqUser.id;
    const fy      = req.query.fy;

    if (!['super_admin','admin','hr','accounts'].includes(reqUser.role) && empId !== reqUser.id)
      return res.status(403).json({ success: false, message: 'Access denied' });

    let query = `SELECT d.*, CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.employee_code
                 FROM it_declarations d
                 JOIN employees e ON d.employee_id = e.id
                 WHERE d.employee_id=$1`;
    const params = [empId];
    if (fy) { query += ` AND d.financial_year=$2`; params.push(fy); }
    query += ` ORDER BY d.financial_year DESC LIMIT 1`;

    const result = await db.query(query, params);
    if (!result.rows.length)
      return res.json({ success: true, data: null });

    const decl = result.rows[0];
    const docs = await db.query(
      `SELECT id, section, section_label, original_name, mime_type, file_size, status, hr_comment, uploaded_at
       FROM it_proof_documents WHERE declaration_id=$1 ORDER BY section`,
      [decl.id]
    );
    decl.proof_documents = docs.rows;
    res.json({ success: true, data: decl });
  } catch (err) {
    console.error('[getDeclaration]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /it-declaration/all — HR/Accounts sees all employees ──────────────────
exports.getAllDeclarations = async (req, res) => {
  try {
    const { fy, status } = req.query;
    let query = `
      SELECT d.id, d.employee_id, d.financial_year, d.regime, d.status,
             d.total_80c, d.total_deductions, d.submitted_at, d.reviewed_at,
             CONCAT(e.first_name,' ',e.last_name) AS employee_name,
             e.employee_code, dept.name AS department,
             (SELECT COUNT(*) FROM it_proof_documents p WHERE p.declaration_id=d.id) AS proof_count,
             (SELECT COUNT(*) FROM it_proof_documents p WHERE p.declaration_id=d.id AND p.status='pending') AS pending_proofs
      FROM it_declarations d
      JOIN employees e ON d.employee_id = e.id
      LEFT JOIN departments dept ON e.department_id = dept.id
      WHERE 1=1`;
    const params = [];
    if (fy)     { params.push(fy);     query += ` AND d.financial_year=$${params.length}`; }
    if (status) { params.push(status); query += ` AND d.status=$${params.length}`; }
    query += ` ORDER BY d.submitted_at DESC NULLS LAST, e.first_name`;

    const result = await db.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[getAllDeclarations]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /it-declaration/:id — get a specific declaration by ID (HR/Accounts/Admin) ──
// FIX: This route was missing — caused "Could not load declaration details" error
exports.getDeclarationById = async (req, res) => {
  try {
    const reqUser = req.user;
    const declId  = parseInt(req.params.id);

    if (isNaN(declId))
      return res.status(400).json({ success: false, message: 'Invalid declaration id' });

    const result = await db.query(
      `SELECT d.*, CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.employee_code
       FROM it_declarations d
       JOIN employees e ON d.employee_id = e.id
       WHERE d.id=$1`,
      [declId]
    );
    if (!result.rows.length)
      return res.status(404).json({ success: false, message: 'Declaration not found' });

    const decl = result.rows[0];

    // Employees can only view their own; HR, Accounts, Admin, Super-Admin can view all
    if (!['super_admin','admin','hr','accounts'].includes(reqUser.role) && decl.employee_id !== reqUser.id)
      return res.status(403).json({ success: false, message: 'Access denied' });

    const docs = await db.query(
      `SELECT id, section, section_label, original_name, mime_type, file_size, status, hr_comment, uploaded_at
       FROM it_proof_documents WHERE declaration_id=$1 ORDER BY section`,
      [decl.id]
    );
    decl.proof_documents = docs.rows;
    res.json({ success: true, data: decl });
  } catch (err) {
    console.error('[getDeclarationById]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── POST /it-declaration — save/update declaration ────────────────────────────
exports.saveDeclaration = async (req, res) => {
  try {
    const empId = req.user.id;
    const {
      financial_year, regime = 'old',
      rent_paid_monthly = 0, landlord_name = '', landlord_pan = '',
      sec80c_pf = 0, sec80c_ppf = 0, sec80c_lic = 0, sec80c_elss = 0,
      sec80c_nsc = 0, sec80c_home_loan = 0, sec80c_tuition = 0, sec80c_other = 0,
      sec80d_self = 0, sec80d_parents = 0, sec80e_edu_loan = 0,
      sec24b_home_loan = 0, sec80g_donation = 0, sec80ccd_nps = 0,
      action = 'save'  // 'save' or 'submit'
    } = req.body;

    if (!financial_year)
      return res.status(400).json({ success: false, message: 'financial_year required' });

    const { total_80c, total_deductions } = calcTotals(req.body);
    const status = action === 'submit' ? 'submitted' : 'draft';
    const submittedAt = action === 'submit' ? new Date() : null;

    const result = await db.query(`
      INSERT INTO it_declarations (
        employee_id, financial_year, regime,
        rent_paid_monthly, landlord_name, landlord_pan,
        sec80c_pf, sec80c_ppf, sec80c_lic, sec80c_elss, sec80c_nsc,
        sec80c_home_loan, sec80c_tuition, sec80c_other,
        sec80d_self, sec80d_parents, sec80e_edu_loan,
        sec24b_home_loan, sec80g_donation, sec80ccd_nps,
        total_80c, total_deductions, status, submitted_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
        $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,NOW()
      )
      ON CONFLICT(employee_id, financial_year) DO UPDATE SET
        regime=$3, rent_paid_monthly=$4, landlord_name=$5, landlord_pan=$6,
        sec80c_pf=$7, sec80c_ppf=$8, sec80c_lic=$9, sec80c_elss=$10, sec80c_nsc=$11,
        sec80c_home_loan=$12, sec80c_tuition=$13, sec80c_other=$14,
        sec80d_self=$15, sec80d_parents=$16, sec80e_edu_loan=$17,
        sec24b_home_loan=$18, sec80g_donation=$19, sec80ccd_nps=$20,
        total_80c=$21, total_deductions=$22,
        status = CASE WHEN it_declarations.status IN ('approved','rejected') THEN it_declarations.status ELSE $23 END,
        submitted_at = CASE WHEN $24::timestamp IS NOT NULL AND it_declarations.submitted_at IS NULL THEN $24 ELSE it_declarations.submitted_at END,
        updated_at = NOW()
      RETURNING *`,
      [empId, financial_year, regime, rent_paid_monthly, landlord_name, landlord_pan,
       sec80c_pf, sec80c_ppf, sec80c_lic, sec80c_elss, sec80c_nsc,
       sec80c_home_loan, sec80c_tuition, sec80c_other,
       sec80d_self, sec80d_parents, sec80e_edu_loan,
       sec24b_home_loan, sec80g_donation, sec80ccd_nps,
       total_80c, total_deductions, status, submittedAt]
    );

    res.json({ success: true, data: result.rows[0], message: action === 'submit' ? 'Declaration submitted for HR approval!' : 'Declaration saved as draft' });
  } catch (err) {
    console.error('[saveDeclaration]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── POST /it-declaration/proof — upload proof document ───────────────────────
exports.uploadProof = async (req, res) => {
  try {
    const empId = req.user.id;
    const { declaration_id, section, section_label } = req.body;
    const file = req.file;

    if (!file)         return res.status(400).json({ success: false, message: 'No file uploaded' });
    if (!declaration_id || !section)
      return res.status(400).json({ success: false, message: 'declaration_id and section required' });

    // Verify declaration belongs to this employee
    const declCheck = await db.query(
      `SELECT id FROM it_declarations WHERE id=$1 AND employee_id=$2`,
      [declaration_id, empId]
    );
    if (!declCheck.rows.length)
      return res.status(403).json({ success: false, message: 'Declaration not found' });

    const base64 = file.buffer.toString('base64');

    // Upsert — one proof per section per declaration
    const result = await db.query(`
      INSERT INTO it_proof_documents
        (declaration_id, employee_id, section, section_label, filename, original_name, file_data, mime_type, file_size, status, uploaded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',NOW())
      ON CONFLICT DO NOTHING
      RETURNING id`,
      [declaration_id, empId, section, section_label || section,
       file.originalname, file.originalname, base64, file.mimetype, file.size]
    );

    // If conflict (already exists), update it
    if (!result.rows.length) {
      await db.query(`
        UPDATE it_proof_documents
        SET original_name=$1, file_data=$2, mime_type=$3, file_size=$4,
            status='pending', hr_comment=NULL, uploaded_at=NOW()
        WHERE declaration_id=$5 AND section=$6`,
        [file.originalname, base64, file.mimetype, file.size, declaration_id, section]
      );
    }

    res.json({ success: true, message: 'Proof uploaded successfully!' });
  } catch (err) {
    console.error('[uploadProof]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /it-declaration/proofs?declaration_id=X — list proofs for HR modal ───
exports.getProofsByDeclaration = async (req, res) => {
  try {
    const declId = parseInt(req.query.declaration_id);
    if (!declId) return res.status(400).json({ success: false, message: 'declaration_id required' });
    const result = await db.query(
      `SELECT id, section, section_label, original_name, mime_type, status, hr_comment, uploaded_at
       FROM it_proof_documents WHERE declaration_id = $1 ORDER BY uploaded_at ASC`,
      [declId]
    );
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[getProofsByDeclaration]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /it-declaration/proof/:id — download/view proof ──────────────────────
// FIX: Expanded access to also allow admin/super_admin (for completeness in HR Review)
exports.getProof = async (req, res) => {
  try {
    const reqUser = req.user;
    const proofId = parseInt(req.params.id);

    const result = await db.query(
      `SELECT p.*, d.employee_id FROM it_proof_documents p
       JOIN it_declarations d ON p.declaration_id = d.id
       WHERE p.id=$1`, [proofId]
    );
    if (!result.rows.length)
      return res.status(404).json({ success: false, message: 'Proof not found' });

    const proof = result.rows[0];

    // HR, Accounts, Admin, Super-Admin can view all proofs; employees can only view their own
    const isPrivileged = ['hr','accounts','admin','super_admin'].includes(reqUser.role);
    if (!isPrivileged && proof.employee_id !== reqUser.id)
      return res.status(403).json({ success: false, message: 'Access denied' });

    const buffer = Buffer.from(proof.file_data, 'base64');
    res.setHeader('Content-Type', proof.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${proof.original_name}"`);
    res.send(buffer);
  } catch (err) {
    console.error('[getProof]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── POST /it-declaration/:id/review — HR approves/rejects declaration ─────────
exports.reviewDeclaration = async (req, res) => {
  try {
    const { action, comment } = req.body; // action: 'approve' or 'reject'
    const declId  = parseInt(req.params.id);
    const hrId    = req.user.id;

    if (!['approve','reject'].includes(action))
      return res.status(400).json({ success: false, message: 'action must be approve or reject' });

    const status = action === 'approve' ? 'approved' : 'rejected';
    await db.query(
      `UPDATE it_declarations SET status=$1, hr_comment=$2, reviewed_at=NOW(), reviewed_by=$3 WHERE id=$4`,
      [status, comment || null, hrId, declId]
    );

    // Notify employee
    const decl = await db.query(`SELECT employee_id, financial_year FROM it_declarations WHERE id=$1`, [declId]);
    if (decl.rows.length) {
      const { employee_id, financial_year } = decl.rows[0];
      await db.query(
        `INSERT INTO notifications(employee_id, title, message, type)
         VALUES($1,$2,$3,'it_declaration')`,
        [employee_id,
         action === 'approve' ? '✅ IT Declaration Approved' : '❌ IT Declaration Rejected',
         action === 'approve'
           ? `Your IT Declaration for FY ${financial_year} has been approved.`
           : `Your IT Declaration for FY ${financial_year} was rejected. Reason: ${comment || 'No reason given'}`
        ]
      );
    }

    res.json({ success: true, message: `Declaration ${status}` });
  } catch (err) {
    console.error('[reviewDeclaration]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── POST /it-declaration/proof/:id/review — HR reviews individual proof ───────
exports.reviewProof = async (req, res) => {
  try {
    const { action, comment } = req.body;
    const proofId = parseInt(req.params.id);
    const hrId    = req.user.id;

    if (!['approve','reject'].includes(action))
      return res.status(400).json({ success: false, message: 'action must be approve or reject' });

    await db.query(
      `UPDATE it_proof_documents SET status=$1, hr_comment=$2, reviewed_at=NOW(), reviewed_by=$3 WHERE id=$4`,
      [action === 'approve' ? 'approved' : 'rejected', comment || null, hrId, proofId]
    );

    res.json({ success: true, message: `Proof ${action}d` });
  } catch (err) {
    console.error('[reviewProof]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /it-declaration/tax-preview — compute tax live ───────────────────────
exports.taxPreview = async (req, res) => {
  try {
    const empId = req.query.employee_id ? parseInt(req.query.employee_id) : req.user.id;
    const fy    = req.query.fy;

    // Get salary structure
    const salRes = await db.query(
      `SELECT ess.gross_salary, ess.basic, ess.hra, e.city
       FROM employee_salary_structure ess
       JOIN employees e ON ess.employee_id = e.id
       WHERE ess.employee_id=$1`, [empId]
    );
    if (!salRes.rows.length)
      return res.json({ success: false, message: 'Salary structure not set up yet. Ask HR to configure your salary.' });

    const sal        = salRes.rows[0];
    const annualGross= parseFloat(sal.gross_salary || 0) * 12;
    const annualBasic= parseFloat(sal.basic        || 0) * 12;
    const annualHRA  = parseFloat(sal.hra          || 0) * 12;

    // Get declaration if exists
    let decl = null;
    if (fy) {
      const declRes = await db.query(
        `SELECT * FROM it_declarations WHERE employee_id=$1 AND financial_year=$2`,
        [empId, fy]
      );
      if (declRes.rows.length) decl = declRes.rows[0];
    }

    const stdDeduction = 50000;

    // HRA Exemption (least of 3 rules)
    const rentPaidAnnual = parseFloat(decl?.rent_paid_monthly || 0) * 12;
    const isMetro        = /mumbai|delhi|kolkata|chennai/i.test(sal.city || '');
    const hraExemption   = rentPaidAnnual > 0 ? Math.min(
      annualHRA,
      rentPaidAnnual - (annualBasic * 0.1),
      annualBasic * (isMetro ? 0.5 : 0.4)
    ) : 0;

    const { total_deductions } = decl ? calcTotals(decl) : { total_deductions: 0 };

    // Old Regime
    const oldTaxableIncome = Math.max(0,
      annualGross - stdDeduction - Math.max(0, hraExemption) - total_deductions
    );
    const oldTax = calcOldTax(oldTaxableIncome);

    // New Regime (no deductions except std)
    const newTaxableIncome = Math.max(0, annualGross - 75000); // std deduction ₹75k for new regime FY25
    const newTax = calcNewTax(newTaxableIncome);

    res.json({
      success: true,
      data: {
        annual_gross:       Math.round(annualGross),
        std_deduction:      stdDeduction,
        hra_exemption:      Math.max(0, Math.round(hraExemption)),
        total_vi_a:         Math.round(total_deductions),
        old_regime: {
          taxable_income: Math.round(oldTaxableIncome),
          tax:            Math.round(oldTax),
          monthly_tds:    Math.round(oldTax / 12)
        },
        new_regime: {
          taxable_income: Math.round(newTaxableIncome),
          tax:            Math.round(newTax),
          monthly_tds:    Math.round(newTax / 12)
        },
        recommended: oldTax <= newTax ? 'old' : 'new'
      }
    });
  } catch (err) {
    console.error('[taxPreview]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Tax slab calculators ──────────────────────────────────────────────────────
function calcOldTax(income) {
  if (income <= 250000) return 0;
  let tax = 0;
  if (income > 1000000) { tax += (income - 1000000) * 0.30; income = 1000000; }
  if (income > 500000)  { tax += (income - 500000)  * 0.20; income = 500000; }
  if (income > 250000)  { tax += (income - 250000)  * 0.05; }
  // Rebate u/s 87A — if income <= 5L, full tax rebate
  if (income <= 500000) tax = 0;
  return tax + (tax * 0.04); // 4% cess
}

function calcNewTax(income) {
  if (income <= 300000) return 0;
  let tax = 0;
  const slabs = [
    [300000,  600000,  0.05],
    [600000,  900000,  0.10],
    [900000,  1200000, 0.15],
    [1200000, 1500000, 0.20],
    [1500000, Infinity,0.30],
  ];
  for (const [low, high, rate] of slabs) {
    if (income > low) {
      tax += (Math.min(income, high) - low) * rate;
    }
  }
  // Rebate u/s 87A — if income <= 7L, full rebate
  if (income <= 700000) tax = 0;
  return tax + (tax * 0.04); // 4% cess
}
