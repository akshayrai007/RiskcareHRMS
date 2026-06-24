// itDeclarationController.js — Enterprise IT Declaration Module v3.0
// Architecture: Controller → Service functions → Repository (DB)
// No hardcoded tax values. All limits/slabs configurable via it_tax_config table.

const db     = require('../config/db');
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

// ── File storage: disk (no base64 in DB) ─────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '../../../../uploads/it-proofs');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.pdf','.jpg','.jpeg','.png'].includes(ext)) cb(null, true);
    else cb(new Error('Only PDF, JPG, PNG allowed'));
  }
});
exports.uploadMiddleware = upload.single('proof_file');

// ── DB Init ───────────────────────────────────────────────────────────────────
exports.initTables = async () => {
  try {
    // Dynamic tax configuration table
    await db.query(`
      CREATE TABLE IF NOT EXISTS it_tax_config (
        id           SERIAL PRIMARY KEY,
        fy           VARCHAR(10) NOT NULL,
        config_key   VARCHAR(80) NOT NULL,
        config_value TEXT NOT NULL,
        description  TEXT,
        updated_by   INTEGER,
        updated_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(fy, config_key)
      );`);

    // Seed default config for FY 2025-26 if not exists
    const fys = ['2025-26','2024-25','2023-24'];
    for (const fy of fys) {
      const defaults = [
        ['std_deduction_old',   '50000',   'Standard deduction (Old Regime)'],
        ['std_deduction_new',   '75000',   'Standard deduction (New Regime) FY26'],
        ['limit_80c',           '150000',  'Section 80C max limit'],
        ['limit_80ccd1b',       '50000',   'NPS 80CCD(1B) additional limit'],
        ['limit_80d_self',      '25000',   '80D self + family max'],
        ['limit_80d_parents',   '25000',   '80D parents max (non-senior)'],
        ['limit_80d_parents_sr','50000',   '80D parents max (senior citizen)'],
        ['limit_sec24b',        '200000',  'Home Loan Interest Sec 24(b)'],
        ['limit_80dd_normal',   '75000',   '80DD normal disability'],
        ['limit_80dd_severe',   '125000',  '80DD severe disability (>=80%)'],
        ['limit_80u_normal',    '75000',   '80U normal disability'],
        ['limit_80u_severe',    '125000',  '80U severe disability (>=80%)'],
        ['limit_80ddb_below60', '40000',   '80DDB below 60 years'],
        ['limit_80ddb_sr',      '100000',  '80DDB senior citizen'],
        ['cess_rate',           '4',       'Health & Education Cess %'],
        ['rebate_87a_old',      '500000',  'Old Regime rebate threshold (taxable income)'],
        ['rebate_87a_old_amt',  '12500',   'Old Regime max rebate amount'],
        ['rebate_87a_new',      '700000',  'New Regime rebate threshold'],
        ['rebate_87a_new_amt',  '25000',   'New Regime max rebate amount'],
        ['landlord_pan_thresh', '100000',  'Landlord PAN mandatory if annual rent > this'],
        ['declaration_start',   `${fy.split('-')[0]}-04-01`, 'Declaration window start'],
        ['declaration_end',     `20${fy.split('-')[1]}-03-31`, 'Declaration window end'],
        ['proof_start',         `${fy.split('-')[0]}-11-01`, 'Proof upload window start'],
        ['proof_end',           `20${fy.split('-')[1]}-02-28`, 'Proof upload window end'],
        // Old Regime slabs: slab1_low|slab1_high|slab1_rate (pipe-delimited array)
        ['old_slabs', '0|250000|0,250001|500000|5,500001|1000000|20,1000001|999999999|30', 'Old Regime slabs: low|high|rate% comma-separated'],
        // New Regime slabs FY26
        ['new_slabs', '0|300000|0,300001|600000|5,600001|900000|10,900001|1200000|15,1200001|1500000|20,1500001|999999999|30', 'New Regime slabs'],
      ];
      for (const [k, v, d] of defaults) {
        await db.query(
          `INSERT INTO it_tax_config(fy, config_key, config_value, description)
           VALUES($1,$2,$3,$4) ON CONFLICT(fy, config_key) DO NOTHING`,
          [fy, k, v, d]
        );
      }
    }

    // Main declaration table (extended)
    await db.query(`
      CREATE TABLE IF NOT EXISTS it_declarations (
        id                    SERIAL PRIMARY KEY,
        employee_id           INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        financial_year        VARCHAR(10) NOT NULL,
        regime                VARCHAR(10) DEFAULT 'old',

        -- HRA
        rent_paid_monthly     NUMERIC(14,2) DEFAULT 0,
        annual_rent           NUMERIC(14,2) DEFAULT 0,
        landlord_name         VARCHAR(200),
        landlord_pan          VARCHAR(20),
        hra_city_type         VARCHAR(10) DEFAULT 'metro',

        -- 80C
        sec80c_pf             NUMERIC(14,2) DEFAULT 0,
        sec80c_ppf            NUMERIC(14,2) DEFAULT 0,
        sec80c_lic            NUMERIC(14,2) DEFAULT 0,
        sec80c_elss           NUMERIC(14,2) DEFAULT 0,
        sec80c_nsc            NUMERIC(14,2) DEFAULT 0,
        sec80c_home_loan      NUMERIC(14,2) DEFAULT 0,
        sec80c_tuition        NUMERIC(14,2) DEFAULT 0,
        sec80c_fd             NUMERIC(14,2) DEFAULT 0,
        sec80c_other          NUMERIC(14,2) DEFAULT 0,

        -- NPS
        sec80ccd_nps          NUMERIC(14,2) DEFAULT 0,

        -- 80D
        sec80d_self           NUMERIC(14,2) DEFAULT 0,
        sec80d_parents        NUMERIC(14,2) DEFAULT 0,
        sec80d_senior_parent  BOOLEAN DEFAULT FALSE,

        -- Home Loan Sec24b
        sec24b_home_loan      NUMERIC(14,2) DEFAULT 0,
        homeloan_provider     VARCHAR(200),
        homeloan_address      TEXT,

        -- 80E Education Loan
        sec80e_edu_loan       NUMERIC(14,2) DEFAULT 0,

        -- 80G Donation
        sec80g_donation       NUMERIC(14,2) DEFAULT 0,
        sec80g_institution    VARCHAR(200),
        sec80g_pan            VARCHAR(20),
        sec80g_category       VARCHAR(10),

        -- 80DD Dependent Disability
        sec80dd_amount        NUMERIC(14,2) DEFAULT 0,
        sec80dd_dependent     VARCHAR(200),
        sec80dd_relation      VARCHAR(100),
        sec80dd_pct           NUMERIC(5,2) DEFAULT 0,

        -- 80U Self Disability
        sec80u_amount         NUMERIC(14,2) DEFAULT 0,
        sec80u_pct            NUMERIC(5,2) DEFAULT 0,
        sec80u_category       VARCHAR(50),

        -- 80DDB Medical Treatment
        sec80ddb_amount       NUMERIC(14,2) DEFAULT 0,
        sec80ddb_disease      VARCHAR(200),
        sec80ddb_patient      VARCHAR(200),
        sec80ddb_relation     VARCHAR(100),

        -- LTA
        lta_amount            NUMERIC(14,2) DEFAULT 0,
        lta_destination       VARCHAR(300),
        lta_travel_period     VARCHAR(100),

        -- Previous Employment (both regimes)
        prev_employer         VARCHAR(300),
        prev_employer_tan     VARCHAR(20),
        prev_period           VARCHAR(100),
        prev_gross_salary     NUMERIC(14,2) DEFAULT 0,
        prev_taxable_income   NUMERIC(14,2) DEFAULT 0,
        prev_tds              NUMERIC(14,2) DEFAULT 0,
        prev_pf               NUMERIC(14,2) DEFAULT 0,

        -- House Property (stored as JSONB array for multiple properties)
        house_properties      JSONB DEFAULT '[]',

        -- Other Income
        other_savings_int     NUMERIC(14,2) DEFAULT 0,
        other_fd_int          NUMERIC(14,2) DEFAULT 0,
        other_dividend        NUMERIC(14,2) DEFAULT 0,
        other_misc            NUMERIC(14,2) DEFAULT 0,

        -- Computed totals
        total_80c             NUMERIC(14,2) DEFAULT 0,
        total_deductions      NUMERIC(14,2) DEFAULT 0,
        estimated_tax         NUMERIC(14,2) DEFAULT 0,
        monthly_tds           NUMERIC(14,2) DEFAULT 0,

        -- Workflow status
        -- draft → submitted → under_review → approved → proof_pending
        -- → proof_submitted → verification_pending → verified
        -- rejected / reopened also possible
        status                VARCHAR(30) DEFAULT 'draft',
        hr_comment            TEXT,
        submitted_at          TIMESTAMPTZ,
        reviewed_at           TIMESTAMPTZ,
        reviewed_by           INTEGER REFERENCES employees(id),
        approved_at           TIMESTAMPTZ,
        approved_by           INTEGER REFERENCES employees(id),
        proof_submitted_at    TIMESTAMPTZ,
        verified_at           TIMESTAMPTZ,
        verified_by           INTEGER REFERENCES employees(id),
        locked                BOOLEAN DEFAULT FALSE,

        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(employee_id, financial_year)
      );`);

    // Proof documents table — no base64, disk path only
    await db.query(`
      CREATE TABLE IF NOT EXISTS it_proof_documents (
        id               SERIAL PRIMARY KEY,
        declaration_id   INTEGER NOT NULL REFERENCES it_declarations(id) ON DELETE CASCADE,
        employee_id      INTEGER NOT NULL REFERENCES employees(id),
        section          VARCHAR(50) NOT NULL,
        section_label    VARCHAR(200),
        doc_type         VARCHAR(80),
        file_name        VARCHAR(500),
        file_path        VARCHAR(1000),
        file_size        INTEGER,
        mime_type        VARCHAR(100),
        status           VARCHAR(20) DEFAULT 'pending',
        hr_comment       TEXT,
        uploaded_at      TIMESTAMPTZ DEFAULT NOW(),
        reviewed_at      TIMESTAMPTZ,
        reviewed_by      INTEGER REFERENCES employees(id)
      );`);

    // Audit log
    await db.query(`
      CREATE TABLE IF NOT EXISTS it_audit_logs (
        id           SERIAL PRIMARY KEY,
        declaration_id INTEGER REFERENCES it_declarations(id),
        action       VARCHAR(80) NOT NULL,
        performed_by INTEGER,
        details      JSONB,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );`);

    console.log('✅ IT Declaration v3 tables ready');
  } catch (err) {
    console.error('❌ IT Declaration init error:', err.message);
  }
};

// ── Config loader ─────────────────────────────────────────────────────────────
async function loadConfig(fy) {
  const res = await db.query(
    `SELECT config_key, config_value FROM it_tax_config WHERE fy=$1`, [fy]
  );
  const cfg = {};
  res.rows.forEach(r => { cfg[r.config_key] = r.config_value; });
  return cfg;
}

function cfgN(cfg, key, def = 0) { return parseFloat(cfg[key] ?? def); }

function parseSlabs(slabStr) {
  if (!slabStr) return [];
  return slabStr.split(',').map(s => {
    const [low, high, rate] = s.split('|');
    return { low: parseFloat(low), high: parseFloat(high), rate: parseFloat(rate) };
  });
}

// ── Tax Engine (pure function, no DB calls) ───────────────────────────────────
function applySlabs(income, slabs) {
  let tax = 0;
  for (const s of slabs) {
    if (income <= s.low) break;
    tax += (Math.min(income, s.high) - s.low) * (s.rate / 100);
  }
  return tax;
}

function computeTax(taxableIncome, regime, cfg) {
  const slabStr = regime === 'new' ? cfg.new_slabs : cfg.old_slabs;
  const slabs   = parseSlabs(slabStr);
  let tax = applySlabs(taxableIncome, slabs);

  // Rebate 87A
  const rebateThresh = regime === 'new'
    ? cfgN(cfg, 'rebate_87a_new', 700000)
    : cfgN(cfg, 'rebate_87a_old', 500000);
  const rebateAmt = regime === 'new'
    ? cfgN(cfg, 'rebate_87a_new_amt', 25000)
    : cfgN(cfg, 'rebate_87a_old_amt', 12500);
  if (taxableIncome <= rebateThresh) tax = Math.max(0, tax - rebateAmt);

  const cessRate = cfgN(cfg, 'cess_rate', 4) / 100;
  return Math.round(tax + tax * cessRate);
}

function calcDeductions(d, cfg, salRow) {
  const lim80c      = cfgN(cfg, 'limit_80c', 150000);
  const limNps      = cfgN(cfg, 'limit_80ccd1b', 50000);
  const lim80dSelf  = cfgN(cfg, 'limit_80d_self', 25000);
  const lim80dPar   = d.sec80d_senior_parent ? cfgN(cfg, 'limit_80d_parents_sr', 50000) : cfgN(cfg, 'limit_80d_parents', 25000);
  const limHLoan    = cfgN(cfg, 'limit_sec24b', 200000);
  const lim80ddN    = cfgN(cfg, 'limit_80dd_normal', 75000);
  const lim80ddS    = cfgN(cfg, 'limit_80dd_severe', 125000);
  const lim80uN     = cfgN(cfg, 'limit_80u_normal', 75000);
  const lim80uS     = cfgN(cfg, 'limit_80u_severe', 125000);
  const lim80ddbB60 = cfgN(cfg, 'limit_80ddb_below60', 40000);

  const c80c = Math.min(
    (parseFloat(d.sec80c_pf||0)) + (parseFloat(d.sec80c_ppf||0)) + (parseFloat(d.sec80c_lic||0)) +
    (parseFloat(d.sec80c_elss||0)) + (parseFloat(d.sec80c_nsc||0)) + (parseFloat(d.sec80c_home_loan||0)) +
    (parseFloat(d.sec80c_tuition||0)) + (parseFloat(d.sec80c_fd||0)) + (parseFloat(d.sec80c_other||0)),
    lim80c
  );
  const nps      = Math.min(parseFloat(d.sec80ccd_nps||0), limNps);
  const d80d     = Math.min(parseFloat(d.sec80d_self||0), lim80dSelf) + Math.min(parseFloat(d.sec80d_parents||0), lim80dPar);
  const homeloan = Math.min(parseFloat(d.sec24b_home_loan||0), limHLoan);
  const edu      = parseFloat(d.sec80e_edu_loan||0);
  const donation = parseFloat(d.sec80g_donation||0);
  const ddPct    = parseFloat(d.sec80dd_pct||0);
  const d80dd    = ddPct >= 80 ? lim80ddS : (ddPct > 0 ? lim80ddN : 0);
  const uPct     = parseFloat(d.sec80u_pct||0);
  const d80u     = uPct >= 80 ? lim80uS : (uPct > 0 ? lim80uN : 0);
  const d80ddb   = Math.min(parseFloat(d.sec80ddb_amount||0), lim80ddbB60);
  const lta      = parseFloat(d.lta_amount||0);

  // HRA Exemption
  let hraExempt = 0;
  if (salRow && parseFloat(d.rent_paid_monthly||0) > 0) {
    const annRent   = parseFloat(d.rent_paid_monthly||0) * 12;
    const annBasic  = parseFloat(salRow.basic||0) * 12;
    const annHRA    = parseFloat(salRow.hra||0) * 12;
    const isMetro   = (d.hra_city_type || 'metro') === 'metro';
    hraExempt = Math.max(0, Math.min(
      annHRA,
      annRent - annBasic * 0.1,
      annBasic * (isMetro ? 0.5 : 0.4)
    ));
  }

  // House Property (net) — sum across properties
  let houseNetLoss = 0;
  const props = Array.isArray(d.house_properties) ? d.house_properties : [];
  for (const p of props) {
    const rental  = parseFloat(p.rental_income||0);
    const munTax  = parseFloat(p.municipal_tax||0);
    const intPaid = parseFloat(p.interest_paid||0);
    const netAnnVal = rental - munTax;
    const stdDed    = netAnnVal * 0.3;
    const netHPInc  = netAnnVal - stdDed - intPaid;
    houseNetLoss += netHPInc; // negative = loss (deductible up to 2L for SOP)
  }
  const hpDeduction = Math.min(Math.max(0, -houseNetLoss), 200000);

  return {
    c80c, nps, d80d, homeloan, edu, donation, d80dd, d80u, d80ddb, lta,
    hraExempt, hpDeduction,
    total: c80c + nps + d80d + homeloan + edu + donation + d80dd + d80u + d80ddb
  };
}

// ── GET /it-declaration ───────────────────────────────────────────────────────
exports.getDeclaration = async (req, res) => {
  try {
    const reqUser = req.user;
    const empId   = req.query.employee_id ? parseInt(req.query.employee_id) : reqUser.id;
    const fy      = req.query.fy || '2025-26';
    const isPriv  = ['super_admin','admin','hr','accounts'].includes(reqUser.role);
    if (!isPriv && empId !== reqUser.id)
      return res.status(403).json({ success:false, message:'Access denied' });

    const result = await db.query(`
      SELECT d.*,
             CONCAT(e.first_name,' ',e.last_name) AS employee_name,
             e.employee_code, e.pan_number, e.joining_date, e.city, e.ctc,
             e.basic_salary, e.hra AS hra_component,
             dept.name AS department,
             des.title AS designation,
             COALESCE(ess.gross_salary, 0) AS gross_salary,
             COALESCE(ess.basic, 0) AS basic,
             COALESCE(ess.hra, 0)   AS hra
      FROM it_declarations d
      JOIN employees e ON d.employee_id = e.id
      LEFT JOIN departments  dept ON e.department_id  = dept.id
      LEFT JOIN designations des  ON e.designation_id = des.id
      LEFT JOIN employee_salary_structure ess ON ess.employee_id = e.id
      WHERE d.employee_id=$1 AND d.financial_year=$2`,
      [empId, fy]
    );

    let data = result.rows[0] || null;
    if (data) {
      const docs = await db.query(
        `SELECT id, section, section_label, doc_type, file_name, file_size, mime_type, status, hr_comment, uploaded_at
         FROM it_proof_documents WHERE declaration_id=$1 ORDER BY section, uploaded_at`,
        [data.id]
      );
      data.proof_documents = docs.rows;
      if (typeof data.house_properties === 'string') {
        try { data.house_properties = JSON.parse(data.house_properties); } catch { data.house_properties = []; }
      }
    }

    // Also fetch employee info even if no declaration yet
    if (!data) {
      const emp = await db.query(`
        SELECT e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
               e.pan_number, e.joining_date, e.city, e.ctc,
               dept.name AS department, des.title AS designation,
               COALESCE(ess.gross_salary, 0) AS gross_salary,
               COALESCE(ess.basic, 0) AS basic,
               COALESCE(ess.hra, 0)   AS hra
        FROM employees e
        LEFT JOIN departments  dept ON e.department_id  = dept.id
        LEFT JOIN designations des  ON e.designation_id = des.id
        LEFT JOIN employee_salary_structure ess ON ess.employee_id = e.id
        WHERE e.id=$1`, [empId]);
      return res.json({ success:true, data:null, employee: emp.rows[0] || null });
    }

    res.json({ success:true, data, employee: {
      employee_code: data.employee_code, employee_name: data.employee_name,
      pan_number: data.pan_number, joining_date: data.joining_date,
      city: data.city, ctc: data.ctc, department: data.department,
      designation: data.designation, gross_salary: data.gross_salary,
      basic: data.basic, hra: data.hra
    }});
  } catch (err) {
    console.error('[getDeclaration]', err.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
};

// ── GET /it-declaration/all ───────────────────────────────────────────────────
exports.getAllDeclarations = async (req, res) => {
  try {
    const { fy = '2025-26', status } = req.query;
    let q = `
      SELECT d.id, d.employee_id, d.financial_year, d.regime, d.status, d.locked,
             d.total_80c, d.total_deductions, d.estimated_tax, d.monthly_tds,
             d.submitted_at, d.reviewed_at, d.approved_at, d.hr_comment,
             CONCAT(e.first_name,' ',e.last_name) AS employee_name,
             e.employee_code, e.pan_number, dept.name AS department,
             des.title AS designation,
             (SELECT COUNT(*) FROM it_proof_documents p WHERE p.declaration_id=d.id) AS proof_count,
             (SELECT COUNT(*) FROM it_proof_documents p WHERE p.declaration_id=d.id AND p.status='pending') AS pending_proofs
      FROM it_declarations d
      JOIN employees e ON d.employee_id = e.id
      LEFT JOIN departments  dept ON e.department_id  = dept.id
      LEFT JOIN designations des  ON e.designation_id = des.id
      WHERE d.financial_year=$1`;
    const params = [fy];
    if (status) { params.push(status); q += ` AND d.status=$${params.length}`; }
    q += ` ORDER BY d.submitted_at DESC NULLS LAST, e.first_name`;
    const result = await db.query(q, params);
    res.json({ success:true, data:result.rows });
  } catch (err) {
    console.error('[getAllDeclarations]', err.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
};

// ── GET /it-declaration/:id ───────────────────────────────────────────────────
exports.getDeclarationById = async (req, res) => {
  try {
    const reqUser = req.user;
    const declId  = parseInt(req.params.id);
    if (isNaN(declId)) return res.status(400).json({ success:false, message:'Invalid id' });
    const result = await db.query(`
      SELECT d.*, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
             e.employee_code, e.pan_number, e.joining_date, e.ctc, e.city,
             dept.name AS department, des.title AS designation,
             COALESCE(ess.gross_salary,0) AS gross_salary,
             COALESCE(ess.basic,0) AS basic, COALESCE(ess.hra,0) AS hra
      FROM it_declarations d
      JOIN employees e ON d.employee_id = e.id
      LEFT JOIN departments  dept ON e.department_id  = dept.id
      LEFT JOIN designations des  ON e.designation_id = des.id
      LEFT JOIN employee_salary_structure ess ON ess.employee_id = e.id
      WHERE d.id=$1`, [declId]);
    if (!result.rows.length) return res.status(404).json({ success:false, message:'Not found' });
    const decl = result.rows[0];
    const isPriv = ['super_admin','admin','hr','accounts'].includes(reqUser.role);
    if (!isPriv && decl.employee_id !== reqUser.id)
      return res.status(403).json({ success:false, message:'Access denied' });
    const docs = await db.query(
      `SELECT id, section, section_label, doc_type, file_name, file_size, mime_type, status, hr_comment, uploaded_at
       FROM it_proof_documents WHERE declaration_id=$1 ORDER BY section`, [declId]);
    decl.proof_documents = docs.rows;
    const audit = await db.query(
      `SELECT al.*, CONCAT(e.first_name,' ',e.last_name) AS actor_name
       FROM it_audit_logs al LEFT JOIN employees e ON al.performed_by=e.id
       WHERE al.declaration_id=$1 ORDER BY al.created_at DESC`, [declId]);
    decl.audit_logs = audit.rows;
    if (typeof decl.house_properties === 'string') {
      try { decl.house_properties = JSON.parse(decl.house_properties); } catch { decl.house_properties = []; }
    }
    res.json({ success:true, data:decl });
  } catch (err) {
    console.error('[getDeclarationById]', err.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
};

// ── POST /it-declaration ──────────────────────────────────────────────────────
exports.saveDeclaration = async (req, res) => {
  try {
    const empId = req.user.id;
    const b     = req.body;
    const fy    = b.financial_year || '2025-26';
    const action= b.action || 'save';

    // Check if locked
    const existing = await db.query(
      `SELECT status, locked FROM it_declarations WHERE employee_id=$1 AND financial_year=$2`,
      [empId, fy]
    );
    if (existing.rows.length) {
      const ex = existing.rows[0];
      if (ex.locked) return res.status(403).json({ success:false, message:'Declaration is locked. Contact HR to reopen.' });
      if (['approved','verified'].includes(ex.status) && action !== 'save')
        return res.status(403).json({ success:false, message:'Approved declarations cannot be re-submitted.' });
    }

    // Window validation
    const cfg = await loadConfig(fy);
    const now = new Date();
    if (action === 'submit') {
      const declEnd = cfg.declaration_end ? new Date(cfg.declaration_end) : null;
      if (declEnd && now > declEnd)
        return res.status(400).json({ success:false, message:`Declaration window closed on ${declEnd.toDateString()}` });
    }

    // Compute totals via tax engine
    const salRow = await db.query(
      `SELECT basic, hra, gross_salary FROM employee_salary_structure WHERE employee_id=$1`, [empId]
    );
    const sal = salRow.rows[0] || {};
    const deductions = calcDeductions(b, cfg, sal);
    const c80c = deductions.c80c;
    const totalDed = deductions.total;
    const stdDed   = cfgN(cfg, 'std_deduction_old', 50000);
    const annGross = parseFloat(sal.gross_salary||0) * 12;
    const prevSal  = parseFloat(b.prev_gross_salary||0);
    const otherInc = parseFloat(b.other_savings_int||0) + parseFloat(b.other_fd_int||0) +
                     parseFloat(b.other_dividend||0) + parseFloat(b.other_misc||0);
    const taxableOld = Math.max(0, annGross + prevSal + otherInc - stdDed - deductions.hraExempt - totalDed);
    const estTax     = computeTax(taxableOld, 'old', cfg);
    const monthlyTds = Math.round(estTax / 12);

    const status = action === 'submit' ? 'submitted' : 'draft';
    const submittedAt = action === 'submit' ? new Date() : null;

    const houseProps = b.house_properties
      ? (typeof b.house_properties === 'string' ? b.house_properties : JSON.stringify(b.house_properties))
      : '[]';

    const result = await db.query(`
      INSERT INTO it_declarations (
        employee_id, financial_year, regime,
        rent_paid_monthly, annual_rent, landlord_name, landlord_pan, hra_city_type,
        sec80c_pf, sec80c_ppf, sec80c_lic, sec80c_elss, sec80c_nsc,
        sec80c_home_loan, sec80c_tuition, sec80c_fd, sec80c_other,
        sec80ccd_nps, sec80d_self, sec80d_parents, sec80d_senior_parent,
        sec24b_home_loan, homeloan_provider, homeloan_address,
        sec80e_edu_loan, sec80g_donation, sec80g_institution, sec80g_pan, sec80g_category,
        sec80dd_amount, sec80dd_dependent, sec80dd_relation, sec80dd_pct,
        sec80u_amount, sec80u_pct, sec80u_category,
        sec80ddb_amount, sec80ddb_disease, sec80ddb_patient, sec80ddb_relation,
        lta_amount, lta_destination, lta_travel_period,
        prev_employer, prev_employer_tan, prev_period, prev_gross_salary,
        prev_taxable_income, prev_tds, prev_pf,
        house_properties,
        other_savings_int, other_fd_int, other_dividend, other_misc,
        total_80c, total_deductions, estimated_tax, monthly_tds,
        status, submitted_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
        $41,$42,$43,$44,$45,$46,$47,$48,$49,$50,
        $51,$52,$53,$54,$55,$56,$57,$58,$59,$60,NOW()
      )
      ON CONFLICT(employee_id, financial_year) DO UPDATE SET
        regime=$3, rent_paid_monthly=$4, annual_rent=$5, landlord_name=$6, landlord_pan=$7, hra_city_type=$8,
        sec80c_pf=$9, sec80c_ppf=$10, sec80c_lic=$11, sec80c_elss=$12, sec80c_nsc=$13,
        sec80c_home_loan=$14, sec80c_tuition=$15, sec80c_fd=$16, sec80c_other=$17,
        sec80ccd_nps=$18, sec80d_self=$19, sec80d_parents=$20, sec80d_senior_parent=$21,
        sec24b_home_loan=$22, homeloan_provider=$23, homeloan_address=$24,
        sec80e_edu_loan=$25, sec80g_donation=$26, sec80g_institution=$27, sec80g_pan=$28, sec80g_category=$29,
        sec80dd_amount=$30, sec80dd_dependent=$31, sec80dd_relation=$32, sec80dd_pct=$33,
        sec80u_amount=$34, sec80u_pct=$35, sec80u_category=$36,
        sec80ddb_amount=$37, sec80ddb_disease=$38, sec80ddb_patient=$39, sec80ddb_relation=$40,
        lta_amount=$41, lta_destination=$42, lta_travel_period=$43,
        prev_employer=$44, prev_employer_tan=$45, prev_period=$46, prev_gross_salary=$47,
        prev_taxable_income=$48, prev_tds=$49, prev_pf=$50,
        house_properties=$51::jsonb,
        other_savings_int=$52, other_fd_int=$53, other_dividend=$54, other_misc=$55,
        total_80c=$56, total_deductions=$57, estimated_tax=$58, monthly_tds=$59,
        status = CASE WHEN it_declarations.locked = TRUE THEN it_declarations.status
                      WHEN it_declarations.status IN ('approved','verified') THEN it_declarations.status
                      ELSE $60 END,
        submitted_at = CASE WHEN $61::timestamptz IS NOT NULL AND it_declarations.submitted_at IS NULL
                            THEN $61 ELSE it_declarations.submitted_at END,
        updated_at = NOW()
      RETURNING *`,
      [empId, fy, b.regime||'old',
       parseFloat(b.rent_paid_monthly||0), parseFloat(b.rent_paid_monthly||0)*12,
       b.landlord_name||null, b.landlord_pan||null, b.hra_city_type||'metro',
       parseFloat(b.sec80c_pf||0), parseFloat(b.sec80c_ppf||0), parseFloat(b.sec80c_lic||0),
       parseFloat(b.sec80c_elss||0), parseFloat(b.sec80c_nsc||0), parseFloat(b.sec80c_home_loan||0),
       parseFloat(b.sec80c_tuition||0), parseFloat(b.sec80c_fd||0), parseFloat(b.sec80c_other||0),
       parseFloat(b.sec80ccd_nps||0), parseFloat(b.sec80d_self||0), parseFloat(b.sec80d_parents||0),
       b.sec80d_senior_parent === 'true' || b.sec80d_senior_parent === true,
       parseFloat(b.sec24b_home_loan||0), b.homeloan_provider||null, b.homeloan_address||null,
       parseFloat(b.sec80e_edu_loan||0), parseFloat(b.sec80g_donation||0),
       b.sec80g_institution||null, b.sec80g_pan||null, b.sec80g_category||null,
       parseFloat(b.sec80dd_amount||0), b.sec80dd_dependent||null, b.sec80dd_relation||null, parseFloat(b.sec80dd_pct||0),
       parseFloat(b.sec80u_amount||0), parseFloat(b.sec80u_pct||0), b.sec80u_category||null,
       parseFloat(b.sec80ddb_amount||0), b.sec80ddb_disease||null, b.sec80ddb_patient||null, b.sec80ddb_relation||null,
       parseFloat(b.lta_amount||0), b.lta_destination||null, b.lta_travel_period||null,
       b.prev_employer||null, b.prev_employer_tan||null, b.prev_period||null,
       parseFloat(b.prev_gross_salary||0), parseFloat(b.prev_taxable_income||0),
       parseFloat(b.prev_tds||0), parseFloat(b.prev_pf||0),
       houseProps,
       parseFloat(b.other_savings_int||0), parseFloat(b.other_fd_int||0),
       parseFloat(b.other_dividend||0), parseFloat(b.other_misc||0),
       c80c, totalDed, estTax, monthlyTds,
       status, submittedAt]
    );

    // Audit
    await db.query(
      `INSERT INTO it_audit_logs(declaration_id, action, performed_by, details) VALUES($1,$2,$3,$4)`,
      [result.rows[0].id, action === 'submit' ? 'SUBMITTED' : 'SAVED', empId, { status }]
    );

    // Notify HR on submit
    if (action === 'submit') {
      await db.query(
        `INSERT INTO notifications(employee_id, title, message, type)
         SELECT e.id,'📋 New IT Declaration Submitted',
           'Employee ' || $1 || ' submitted IT Declaration for FY ' || $2, 'it_declaration'
         FROM employees e WHERE e.role IN ('hr','accounts') AND e.is_active=TRUE`,
        [req.user.employee_code || req.user.id, fy]
      ).catch(() => {});
    }

    res.json({ success:true, data:result.rows[0], message: action==='submit' ? 'Declaration submitted to HR!' : 'Saved as draft' });
  } catch (err) {
    console.error('[saveDeclaration]', err.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
};

// ── POST /it-declaration/proof ────────────────────────────────────────────────
exports.uploadProof = async (req, res) => {
  try {
    const empId = req.user.id;
    const { declaration_id, section, section_label, doc_type } = req.body;
    const file  = req.file;
    if (!file) return res.status(400).json({ success:false, message:'No file uploaded' });
    if (!declaration_id || !section)
      return res.status(400).json({ success:false, message:'declaration_id and section required' });

    // Check window
    const declRow = await db.query(
      `SELECT id, financial_year FROM it_declarations WHERE id=$1 AND employee_id=$2`,
      [declaration_id, empId]
    );
    if (!declRow.rows.length) return res.status(403).json({ success:false, message:'Declaration not found' });

    const fy  = declRow.rows[0].financial_year;
    const cfg = await loadConfig(fy);
    const proofEnd = cfg.proof_end ? new Date(cfg.proof_end) : null;
    if (proofEnd && new Date() > proofEnd)
      return res.status(400).json({ success:false, message:`Proof upload window closed on ${proofEnd.toDateString()}` });

    // Store file metadata (no base64)
    const relPath = path.relative(process.cwd(), file.path).replace(/\\/g, '/');

    await db.query(`
      INSERT INTO it_proof_documents
        (declaration_id, employee_id, section, section_label, doc_type, file_name, file_path, file_size, mime_type, status, uploaded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',NOW())`,
      [declaration_id, empId, section, section_label||section, doc_type||section,
       file.originalname, relPath, file.size, file.mimetype]
    );

    // Audit
    await db.query(
      `INSERT INTO it_audit_logs(declaration_id, action, performed_by, details)
       VALUES($1,'PROOF_UPLOADED',$2,$3)`,
      [declaration_id, empId, { section, file_name: file.originalname }]
    );

    res.json({ success:true, message:'Proof uploaded successfully' });
  } catch (err) {
    console.error('[uploadProof]', err.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
};

// ── GET /it-declaration/proof/:id ─────────────────────────────────────────────
exports.getProof = async (req, res) => {
  try {
    const reqUser = req.user;
    const proofId = parseInt(req.params.id);
    const result  = await db.query(
      `SELECT p.*, d.employee_id FROM it_proof_documents p
       JOIN it_declarations d ON p.declaration_id=d.id WHERE p.id=$1`, [proofId]
    );
    if (!result.rows.length) return res.status(404).json({ success:false, message:'Not found' });
    const proof = result.rows[0];
    const isPriv = ['hr','accounts','admin','super_admin'].includes(reqUser.role);
    if (!isPriv && proof.employee_id !== reqUser.id)
      return res.status(403).json({ success:false, message:'Access denied' });

    const absPath = path.resolve(process.cwd(), proof.file_path);
    if (!fs.existsSync(absPath))
      return res.status(404).json({ success:false, message:'File not found on server' });
    res.setHeader('Content-Type', proof.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${proof.file_name}"`);
    fs.createReadStream(absPath).pipe(res);
  } catch (err) {
    console.error('[getProof]', err.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
};

// ── GET /it-declaration/proofs ────────────────────────────────────────────────
exports.getProofsByDeclaration = async (req, res) => {
  try {
    const declId = parseInt(req.query.declaration_id);
    if (!declId) return res.status(400).json({ success:false, message:'declaration_id required' });
    const result = await db.query(
      `SELECT id, section, section_label, doc_type, file_name, file_size, mime_type, status, hr_comment, uploaded_at
       FROM it_proof_documents WHERE declaration_id=$1 ORDER BY section, uploaded_at`, [declId]
    );
    res.json({ success:true, data:result.rows });
  } catch (err) {
    console.error('[getProofsByDeclaration]', err.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
};

// ── DELETE /it-declaration/proof/:id ─────────────────────────────────────────
exports.deleteProof = async (req, res) => {
  try {
    const empId   = req.user.id;
    const proofId = parseInt(req.params.id);
    const result  = await db.query(
      `SELECT p.*, d.employee_id, d.status FROM it_proof_documents p
       JOIN it_declarations d ON p.declaration_id=d.id WHERE p.id=$1`, [proofId]
    );
    if (!result.rows.length) return res.status(404).json({ success:false, message:'Not found' });
    const proof = result.rows[0];
    if (proof.employee_id !== empId && !['hr','admin','super_admin'].includes(req.user.role))
      return res.status(403).json({ success:false, message:'Access denied' });
    if (['approved','verified'].includes(proof.status))
      return res.status(400).json({ success:false, message:'Cannot delete a verified proof' });
    // Remove file from disk
    const absPath = path.resolve(process.cwd(), proof.file_path);
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    await db.query(`DELETE FROM it_proof_documents WHERE id=$1`, [proofId]);
    res.json({ success:true, message:'Proof deleted' });
  } catch (err) {
    console.error('[deleteProof]', err.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
};

// ── POST /it-declaration/:id/review — approve/reject/send_back ────────────────
exports.reviewDeclaration = async (req, res) => {
  try {
    const { action, comment } = req.body;
    const declId = parseInt(req.params.id);
    const hrId   = req.user.id;
    const validActions = ['approve','reject','send_back','request_clarification','reopen'];
    if (!validActions.includes(action))
      return res.status(400).json({ success:false, message:'Invalid action' });

    const statusMap = {
      approve: 'approved', reject: 'rejected',
      send_back: 'draft', request_clarification: 'draft', reopen: 'draft'
    };
    const newStatus = statusMap[action];
    const locked    = action === 'approve';

    await db.query(`
      UPDATE it_declarations SET
        status=$1, hr_comment=$2, reviewed_at=NOW(), reviewed_by=$3,
        locked=$4,
        approved_at = CASE WHEN $5='approved' THEN NOW() ELSE approved_at END,
        approved_by = CASE WHEN $5='approved' THEN $3 ELSE approved_by END
      WHERE id=$6`,
      [newStatus, comment||null, hrId, locked, newStatus, declId]
    );

    // Audit
    await db.query(
      `INSERT INTO it_audit_logs(declaration_id, action, performed_by, details)
       VALUES($1,$2,$3,$4)`,
      [declId, action.toUpperCase(), hrId, { comment, new_status: newStatus }]
    );

    // Notify employee
    const decl = await db.query(
      `SELECT employee_id, financial_year FROM it_declarations WHERE id=$1`, [declId]
    );
    if (decl.rows.length) {
      const { employee_id, financial_year } = decl.rows[0];
      const msgMap = {
        approve: `✅ Your IT Declaration for FY ${financial_year} has been approved.`,
        reject:  `❌ Your IT Declaration for FY ${financial_year} was rejected. ${comment ? 'Reason: '+comment : ''}`,
        send_back: `↩️ Your IT Declaration for FY ${financial_year} has been sent back for revision. ${comment||''}`,
        request_clarification: `❓ HR has requested clarification on your IT Declaration for FY ${financial_year}. ${comment||''}`,
        reopen: `🔓 Your IT Declaration for FY ${financial_year} has been reopened by HR.`
      };
      await db.query(
        `INSERT INTO notifications(employee_id, title, message, type) VALUES($1,$2,$3,'it_declaration')`,
        [employee_id, `IT Declaration ${action}d`, msgMap[action]]
      ).catch(() => {});
    }

    res.json({ success:true, message:`Declaration ${action}d` });
  } catch (err) {
    console.error('[reviewDeclaration]', err.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
};

// ── POST /it-declaration/proof/:id/review ────────────────────────────────────
exports.reviewProof = async (req, res) => {
  try {
    const { action, comment } = req.body;
    const proofId = parseInt(req.params.id);
    const hrId    = req.user.id;
    if (!['approve','reject'].includes(action))
      return res.status(400).json({ success:false, message:'action must be approve or reject' });
    await db.query(
      `UPDATE it_proof_documents SET status=$1, hr_comment=$2, reviewed_at=NOW(), reviewed_by=$3 WHERE id=$4`,
      [action==='approve' ? 'approved' : 'rejected', comment||null, hrId, proofId]
    );
    res.json({ success:true, message:`Proof ${action}d` });
  } catch (err) {
    console.error('[reviewProof]', err.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
};

// ── GET /it-declaration/tax-preview — Full dual-regime breakdown ──────────────
exports.taxPreview = async (req, res) => {
  try {
    const empId = req.query.employee_id ? parseInt(req.query.employee_id) : req.user.id;
    const fy    = req.query.fy || '2025-26';
    const cfg   = await loadConfig(fy);

    const salRes = await db.query(
      `SELECT ess.gross_salary, ess.basic, ess.hra, e.city
       FROM employee_salary_structure ess JOIN employees e ON ess.employee_id=e.id
       WHERE ess.employee_id=$1`, [empId]
    );
    if (!salRes.rows.length)
      return res.json({ success:false, message:'Salary structure not set up. Ask HR.' });
    const sal       = salRes.rows[0];
    const annGross  = parseFloat(sal.gross_salary||0) * 12;

    // Get declaration if any
    const declRes = await db.query(
      `SELECT * FROM it_declarations WHERE employee_id=$1 AND financial_year=$2`, [empId, fy]
    );
    const d = declRes.rows[0] || {};
    if (d.house_properties && typeof d.house_properties==='string') {
      try { d.house_properties = JSON.parse(d.house_properties); } catch { d.house_properties = []; }
    }

    const deductions = calcDeductions(d, cfg, sal);
    const prevSal  = parseFloat(d.prev_gross_salary||0);
    const otherInc = parseFloat(d.other_savings_int||0) + parseFloat(d.other_fd_int||0) +
                     parseFloat(d.other_dividend||0) + parseFloat(d.other_misc||0);
    const prevTds  = parseFloat(d.prev_tds||0);

    // ── OLD REGIME ──
    const stdOld      = cfgN(cfg, 'std_deduction_old', 50000);
    const hraEx       = deductions.hraExempt;
    const grossOld    = annGross + prevSal + otherInc;
    const taxableOld  = Math.max(0, grossOld - stdOld - hraEx - deductions.total - deductions.hpDeduction);
    const taxOld      = computeTax(taxableOld, 'old', cfg);
    const netTaxOld   = Math.max(0, taxOld - prevTds);
    const monthsRem   = Math.max(1, 12 - new Date().getMonth());

    // ── NEW REGIME ──
    const stdNew      = cfgN(cfg, 'std_deduction_new', 75000);
    const grossNew    = annGross + prevSal + otherInc;
    const taxableNew  = Math.max(0, grossNew - stdNew);
    const taxNew      = computeTax(taxableNew, 'new', cfg);
    const netTaxNew   = Math.max(0, taxNew - prevTds);

    const recommended = netTaxOld <= netTaxNew ? 'old' : 'new';
    const savings     = Math.abs(netTaxOld - netTaxNew);

    // Build reasons for recommendation
    const reasons = [];
    if (deductions.c80c >= cfgN(cfg,'limit_80c',150000)*0.9) reasons.push(`80C fully utilized (${fmt(deductions.c80c)})`);
    if (hraEx > 0) reasons.push(`HRA exemption of ${fmt(hraEx)}`);
    if (deductions.homeloan > 0) reasons.push(`Home Loan Interest (${fmt(deductions.homeloan)})`);
    if (deductions.nps > 0) reasons.push(`NPS 80CCD(1B) (${fmt(deductions.nps)})`);
    if (deductions.d80d > 0) reasons.push(`Medical Insurance 80D (${fmt(deductions.d80d)})`);
    if (reasons.length === 0 && recommended === 'new') reasons.push('Standard Deduction ₹75,000 in New Regime exceeds applicable deductions');

    res.json({ success:true, data: {
      annual_gross:  Math.round(annGross),
      prev_salary:   Math.round(prevSal),
      other_income:  Math.round(otherInc),
      old_regime: {
        std_deduction:   stdOld,
        hra_exemption:   Math.round(hraEx),
        deduction_80c:   Math.round(deductions.c80c),
        deduction_nps:   Math.round(deductions.nps),
        deduction_80d:   Math.round(deductions.d80d),
        deduction_homeloan: Math.round(deductions.homeloan),
        deduction_80e:   Math.round(deductions.edu),
        deduction_80g:   Math.round(deductions.donation),
        deduction_80dd:  Math.round(deductions.d80dd),
        deduction_80u:   Math.round(deductions.d80u),
        deduction_80ddb: Math.round(deductions.d80ddb),
        deduction_lta:   Math.round(deductions.lta),
        house_property:  Math.round(deductions.hpDeduction),
        total_deductions:Math.round(deductions.total),
        taxable_income:  Math.round(taxableOld),
        tax_before_cess: Math.round(taxOld / 1.04),
        cess:            Math.round(taxOld - taxOld / 1.04),
        tax:             Math.round(taxOld),
        prev_tds:        Math.round(prevTds),
        net_tax:         Math.round(netTaxOld),
        monthly_tds:     Math.round(netTaxOld / monthsRem),
      },
      new_regime: {
        std_deduction:   stdNew,
        taxable_income:  Math.round(taxableNew),
        tax_before_cess: Math.round(taxNew / 1.04),
        cess:            Math.round(taxNew - taxNew / 1.04),
        tax:             Math.round(taxNew),
        prev_tds:        Math.round(prevTds),
        net_tax:         Math.round(netTaxNew),
        monthly_tds:     Math.round(netTaxNew / monthsRem),
      },
      recommended,
      savings: Math.round(savings),
      recommendation_reasons: reasons,
    }});
  } catch (err) {
    console.error('[taxPreview]', err.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
};
function fmt(n) { return '₹'+(parseFloat(n)||0).toLocaleString('en-IN'); }

// ── GET /it-declaration/config ─────────────────────────────────────────────────
exports.getConfig = async (req, res) => {
  try {
    const fy  = req.query.fy || '2025-26';
    const res2= await db.query(`SELECT * FROM it_tax_config WHERE fy=$1 ORDER BY config_key`, [fy]);
    res.json({ success:true, data:res2.rows });
  } catch (err) {
    res.status(500).json({ success:false, message:'Server error' });
  }
};

// ── POST /it-declaration/config ───────────────────────────────────────────────
exports.saveConfig = async (req, res) => {
  try {
    const { fy, config_key, config_value, description } = req.body;
    if (!fy || !config_key || config_value === undefined)
      return res.status(400).json({ success:false, message:'fy, config_key, config_value required' });
    await db.query(`
      INSERT INTO it_tax_config(fy, config_key, config_value, description, updated_by, updated_at)
      VALUES($1,$2,$3,$4,$5,NOW())
      ON CONFLICT(fy, config_key) DO UPDATE SET
        config_value=$3, description=$4, updated_by=$5, updated_at=NOW()`,
      [fy, config_key, String(config_value), description||null, req.user.id]
    );
    res.json({ success:true, message:'Config saved' });
  } catch (err) {
    res.status(500).json({ success:false, message:'Server error' });
  }
};

// ── GET /it-declaration/dashboard ─────────────────────────────────────────────
exports.getDashboard = async (req, res) => {
  try {
    const fy = req.query.fy || '2025-26';
    const r  = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='draft')            AS draft,
        COUNT(*) FILTER (WHERE status='submitted')        AS submitted,
        COUNT(*) FILTER (WHERE status='approved')         AS approved,
        COUNT(*) FILTER (WHERE status='rejected')         AS rejected,
        COUNT(*) FILTER (WHERE status='verified')         AS verified,
        COUNT(*) FILTER (WHERE proof_submitted_at IS NOT NULL AND status='approved') AS proof_submitted,
        COUNT(*) FILTER (WHERE locked=TRUE)               AS locked_count,
        SUM(estimated_tax)                                AS total_estimated_tax,
        SUM(monthly_tds)                                  AS total_monthly_tds
      FROM it_declarations WHERE financial_year=$1`, [fy]
    );
    res.json({ success:true, data:r.rows[0] });
  } catch (err) {
    res.status(500).json({ success:false, message:'Server error' });
  }
};
