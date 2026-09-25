// itDeclarationController.js — Enterprise IT Declaration Module v3.1 (FIXED)
// FIX LOG:
//   1. saveDeclaration: was ALWAYS computing tax using 'old' regime hardcoded → now regime-aware
//   2. saveDeclaration: new regime was wrongly deducting HRA + 80C + 80D etc → new regime only gets stdDed + employerNPS
//   3. saveDeclaration: standard deduction was always ₹50,000 → now ₹75,000 for new regime
//   4. taxPreview: HRA exempt was excluded from taxableOld hpDeduction — now included properly
//   5. taxPreview: otherInc was including capital_gains for new regime too — kept consistent (both regimes)
//   6. HRA Exemption: now uses annual_rent field if available, falls back to rent_paid_monthly * 12
//   7. PF (Employee) auto-included in 80C if not already declared (since payroll deducts it)

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
    const alters = [
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS annual_rent NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS landlord_name VARCHAR(200)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS landlord_pan VARCHAR(20)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS hra_city_type VARCHAR(10) DEFAULT 'metro'`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80c_pf NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80c_ppf NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80c_lic NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80c_elss NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80c_nsc NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80c_home_loan NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80c_tuition NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80c_fd NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80c_other NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80ccd_nps NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80d_self NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80d_parents NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80d_senior_parent BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec24b_home_loan NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS homeloan_provider VARCHAR(200)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS homeloan_address TEXT`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80e_edu_loan NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80g_donation NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80g_institution VARCHAR(200)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80g_pan VARCHAR(20)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80g_category VARCHAR(10)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80dd_amount NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80dd_dependent VARCHAR(200)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80dd_relation VARCHAR(100)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80dd_pct NUMERIC(5,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80u_amount NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80u_pct NUMERIC(5,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80u_category VARCHAR(50)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80ddb_amount NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80ddb_disease VARCHAR(200)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80ddb_patient VARCHAR(200)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS sec80ddb_relation VARCHAR(100)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS lta_amount NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS lta_destination VARCHAR(300)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS lta_travel_period VARCHAR(100)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS prev_employer VARCHAR(300)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS prev_employer_tan VARCHAR(20)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS prev_period VARCHAR(100)`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS prev_gross_salary NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS prev_taxable_income NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS prev_tds NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS prev_pf NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS house_properties JSONB DEFAULT '[]'`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS other_savings_int NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS other_fd_int NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS other_capital_gains NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS other_dividend NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS other_misc NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS employer_nps NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS total_80c NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS total_deductions NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS estimated_tax NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS monthly_tds NUMERIC(14,2) DEFAULT 0`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS approved_by INTEGER`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS proof_submitted_at TIMESTAMPTZ`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS verified_by INTEGER`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`,
      `ALTER TABLE it_declarations ADD COLUMN IF NOT EXISTS reviewed_by INTEGER`,
      `ALTER TABLE it_proof_documents ADD COLUMN IF NOT EXISTS doc_type VARCHAR(80)`,
      `ALTER TABLE it_proof_documents ADD COLUMN IF NOT EXISTS section_label VARCHAR(200)`,
      `ALTER TABLE it_proof_documents ADD COLUMN IF NOT EXISTS file_name VARCHAR(500)`,
      `ALTER TABLE it_proof_documents ADD COLUMN IF NOT EXISTS file_path VARCHAR(1000)`,
      `ALTER TABLE it_proof_documents ADD COLUMN IF NOT EXISTS file_size INTEGER`,
      `ALTER TABLE it_proof_documents ADD COLUMN IF NOT EXISTS mime_type VARCHAR(100)`,
      `ALTER TABLE it_proof_documents ADD COLUMN IF NOT EXISTS hr_comment TEXT`,
      `ALTER TABLE it_proof_documents ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'`,
      `ALTER TABLE it_proof_documents ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`,
      `ALTER TABLE it_proof_documents ADD COLUMN IF NOT EXISTS reviewed_by INTEGER`,
    ];
    for (const sql of alters) { await db.query(sql).catch(()=>{}); }

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

    const fys = ['2030-31','2029-30','2028-29','2027-28','2026-27','2025-26','2024-25','2023-24'];
    for (const fy of fys) {
      const fyStart = fy.split('-')[0];
      const fyEnd   = '20' + fy.split('-')[1];
      const fyNum   = parseInt(fyStart, 10);
      // New Regime (sec 115BAC) parameters differ by FY
      //  FY23-24: 0-3L 0, 3-6L 5, 6-9L 10, 9-12L 15, 12-15L 20, 15L+ 30 | rebate 7L/25k | std 50k
      //  FY24-25: 0-3L 0, 3-7L 5, 7-10L 10, 10-12L 15, 12-15L 20, 15L+ 30 | rebate 7L/25k | std 75k
      //  FY25-26 onwards: 0-4L 0, 4-8L 5, 8-12L 10, 12-16L 15, 16-20L 20, 20-24L 25, 24L+ 30 | rebate 12L/60k | std 75k
      const NEW_SLABS = fyNum >= 2025
        ? '0|400000|0,400001|800000|5,800001|1200000|10,1200001|1600000|15,1600001|2000000|20,2000001|2400000|25,2400001|999999999|30'
        : fyNum === 2024
          ? '0|300000|0,300001|700000|5,700001|1000000|10,1000001|1200000|15,1200001|1500000|20,1500001|999999999|30'
          : '0|300000|0,300001|600000|5,600001|900000|10,900001|1200000|15,1200001|1500000|20,1500001|999999999|30';
      const NEW_REBATE_THRESH = fyNum >= 2025 ? '1200000' : '700000';
      const NEW_REBATE_AMT    = fyNum >= 2025 ? '60000'   : '25000';
      const NEW_STD           = fyNum >= 2024 ? '75000'   : '50000';
      const defaults = [
        ['std_deduction_old',   '50000',   'Standard deduction (Old Regime)'],
        ['std_deduction_new',   NEW_STD,   'Standard deduction (New Regime)'],
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
        ['rebate_87a_new',      NEW_REBATE_THRESH, 'New Regime rebate threshold (taxable income)'],
        ['rebate_87a_new_amt',  NEW_REBATE_AMT,    'New Regime max rebate amount'],
        ['landlord_pan_thresh', '100000',  'Landlord PAN mandatory if annual rent > this'],
        ['declaration_start',   `${fyStart}-04-01`,  'Declaration window start'],
        ['declaration_end',     `${fyEnd}-03-31`,    'Declaration window end'],
        ['proof_start',         `${fyStart}-06-01`,  'Proof upload window start'],
        ['proof_end',           `${fyEnd}-03-31`,    'Proof upload window end'],
        ['old_slabs', '0|250000|0,250001|500000|5,500001|1000000|20,1000001|999999999|30', 'Old Regime slabs: low|high|rate%'],
        ['old_slabs_senior', '0|300000|0,300001|500000|5,500001|1000000|20,1000001|999999999|30', 'Old Regime slabs: resident senior citizen (60-79)'],
        ['old_slabs_super',  '0|500000|0,500001|1000000|20,1000001|999999999|30', 'Old Regime slabs: resident super senior citizen (80+)'],
        ['surcharge_slabs',  '5000000|10,10000000|15,20000000|25,50000000|37', 'Surcharge: income_above|rate% (applies on tax when taxable income exceeds the threshold)'],
        ['surcharge_cap_new','25', 'Max surcharge % under New Regime'],
        ['limit_80d_self_sr','50000', '80D self + family max (senior citizen)'],
        ['new_slabs', NEW_SLABS, 'New Regime slabs: low|high|rate%'],
      ];
      for (const [k, v, d] of defaults) {
        await db.query(
          `INSERT INTO it_tax_config(fy, config_key, config_value, description)
           VALUES($1,$2,$3,$4) ON CONFLICT(fy, config_key) DO NOTHING`,
          [fy, k, v, d]
        );
      }
      // Migrate rows seeded earlier with the outdated FY23-24 values (HR-customised values are left alone)
      if (fyNum >= 2025) {
        const OLD_SLABS = '0|300000|0,300001|600000|5,600001|900000|10,900001|1200000|15,1200001|1500000|20,1500001|999999999|30';
        const fixes = [
          ['new_slabs', OLD_SLABS, NEW_SLABS],
          ['rebate_87a_new', '700000', NEW_REBATE_THRESH],
          ['rebate_87a_new_amt', '25000', NEW_REBATE_AMT],
        ];
        for (const [k, oldV, newV] of fixes) {
          await db.query(
            `UPDATE it_tax_config SET config_value=$1, updated_at=NOW()
             WHERE fy=$2 AND config_key=$3 AND config_value=$4`,
            [newV, fy, k, oldV]
          );
        }
      }
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS it_declarations (
        id                    SERIAL PRIMARY KEY,
        employee_id           INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        financial_year        VARCHAR(10) NOT NULL,
        regime                VARCHAR(10) DEFAULT 'old',
        rent_paid_monthly     NUMERIC(14,2) DEFAULT 0,
        annual_rent           NUMERIC(14,2) DEFAULT 0,
        landlord_name         VARCHAR(200),
        landlord_pan          VARCHAR(20),
        hra_city_type         VARCHAR(10) DEFAULT 'metro',
        sec80c_pf             NUMERIC(14,2) DEFAULT 0,
        sec80c_ppf            NUMERIC(14,2) DEFAULT 0,
        sec80c_lic            NUMERIC(14,2) DEFAULT 0,
        sec80c_elss           NUMERIC(14,2) DEFAULT 0,
        sec80c_nsc            NUMERIC(14,2) DEFAULT 0,
        sec80c_home_loan      NUMERIC(14,2) DEFAULT 0,
        sec80c_tuition        NUMERIC(14,2) DEFAULT 0,
        sec80c_fd             NUMERIC(14,2) DEFAULT 0,
        sec80c_other          NUMERIC(14,2) DEFAULT 0,
        sec80ccd_nps          NUMERIC(14,2) DEFAULT 0,
        sec80d_self           NUMERIC(14,2) DEFAULT 0,
        sec80d_parents        NUMERIC(14,2) DEFAULT 0,
        sec80d_senior_parent  BOOLEAN DEFAULT FALSE,
        sec24b_home_loan      NUMERIC(14,2) DEFAULT 0,
        homeloan_provider     VARCHAR(200),
        homeloan_address      TEXT,
        sec80e_edu_loan       NUMERIC(14,2) DEFAULT 0,
        sec80g_donation       NUMERIC(14,2) DEFAULT 0,
        sec80g_institution    VARCHAR(200),
        sec80g_pan            VARCHAR(20),
        sec80g_category       VARCHAR(10),
        sec80dd_amount        NUMERIC(14,2) DEFAULT 0,
        sec80dd_dependent     VARCHAR(200),
        sec80dd_relation      VARCHAR(100),
        sec80dd_pct           NUMERIC(5,2) DEFAULT 0,
        sec80u_amount         NUMERIC(14,2) DEFAULT 0,
        sec80u_pct            NUMERIC(5,2) DEFAULT 0,
        sec80u_category       VARCHAR(50),
        sec80ddb_amount       NUMERIC(14,2) DEFAULT 0,
        sec80ddb_disease      VARCHAR(200),
        sec80ddb_patient      VARCHAR(200),
        sec80ddb_relation     VARCHAR(100),
        lta_amount            NUMERIC(14,2) DEFAULT 0,
        lta_destination       VARCHAR(300),
        lta_travel_period     VARCHAR(100),
        prev_employer         VARCHAR(300),
        prev_employer_tan     VARCHAR(20),
        prev_period           VARCHAR(100),
        prev_gross_salary     NUMERIC(14,2) DEFAULT 0,
        prev_taxable_income   NUMERIC(14,2) DEFAULT 0,
        prev_tds              NUMERIC(14,2) DEFAULT 0,
        prev_pf               NUMERIC(14,2) DEFAULT 0,
        house_properties      JSONB DEFAULT '[]',
        other_savings_int     NUMERIC(14,2) DEFAULT 0,
        other_fd_int          NUMERIC(14,2) DEFAULT 0,
        other_capital_gains   NUMERIC(14,2) DEFAULT 0,
        other_dividend        NUMERIC(14,2) DEFAULT 0,
        other_misc            NUMERIC(14,2) DEFAULT 0,
        employer_nps          NUMERIC(14,2) DEFAULT 0,
        total_80c             NUMERIC(14,2) DEFAULT 0,
        total_deductions      NUMERIC(14,2) DEFAULT 0,
        estimated_tax         NUMERIC(14,2) DEFAULT 0,
        monthly_tds           NUMERIC(14,2) DEFAULT 0,
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

    await db.query(`
      CREATE TABLE IF NOT EXISTS it_audit_logs (
        id           SERIAL PRIMARY KEY,
        declaration_id INTEGER REFERENCES it_declarations(id),
        action       VARCHAR(80) NOT NULL,
        performed_by INTEGER,
        details      JSONB,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );`);

    console.log('✅ IT Declaration v3.1 tables ready');
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

// ── Tax Engine ────────────────────────────────────────────────────────────────
function applySlabs(income, slabs) {
  let tax = 0;
  for (const s of slabs) {
    // Slabs are stored as 300001|600000, so the effective lower bound is low-1
    const lo = s.low > 0 ? s.low - 1 : 0;
    if (income <= lo) break;
    tax += (Math.min(income, s.high) - lo) * (s.rate / 100);
  }
  return tax;
}

// Age group as on last day of the FY (a person turning 60/80 during the FY is treated as senior/super senior)
function getAgeGroup(dob, fy) {
  if (!dob) return 'below60';
  let y, m, d;
  if (dob instanceof Date) { y = dob.getFullYear(); m = dob.getMonth(); d = dob.getDate(); }
  else {
    const mt = String(dob).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!mt) return 'below60';
    y = +mt[1]; m = +mt[2] - 1; d = +mt[3];
  }
  if (!y) return 'below60';
  const fyEndYear = 2000 + parseInt(String(fy || '').split('-')[1], 10);
  if (!fyEndYear) return 'below60';
  let age = fyEndYear - y;
  if (m > 2 || (m === 2 && d > 31)) age -= 1;   // birthday after 31 March
  return age >= 80 ? 'super_senior' : age >= 60 ? 'senior' : 'below60';
}

const DEFAULT_SLABS = {
  old_slabs:        '0|250000|0,250001|500000|5,500001|1000000|20,1000001|999999999|30',
  old_slabs_senior: '0|300000|0,300001|500000|5,500001|1000000|20,1000001|999999999|30',
  old_slabs_super:  '0|500000|0,500001|1000000|20,1000001|999999999|30',
};
const DEFAULT_SURCHARGE = '5000000|10,10000000|15,20000000|25,50000000|37';

// Full breakdown: slab tax -> 87A rebate (+ marginal relief) -> surcharge (+ marginal relief) -> cess
function computeTaxDetail(taxableIncome, regime, cfg, ageGroup = 'below60') {
  const slabKey = regime === 'new' ? 'new_slabs'
    : ageGroup === 'super_senior' ? 'old_slabs_super'
    : ageGroup === 'senior'       ? 'old_slabs_senior'
    : 'old_slabs';
  const slabs = parseSlabs(cfg[slabKey] || DEFAULT_SLABS[slabKey] || cfg.old_slabs);

  const rebateThresh = regime === 'new' ? cfgN(cfg, 'rebate_87a_new', 1200000) : cfgN(cfg, 'rebate_87a_old', 500000);
  const rebateAmt    = regime === 'new' ? cfgN(cfg, 'rebate_87a_new_amt', 60000) : cfgN(cfg, 'rebate_87a_old_amt', 12500);

  // Tax after 87A (and its marginal relief) but before surcharge/cess, for any income
  const taxBeforeSurcharge = (inc) => {
    let t = applySlabs(inc, slabs);
    if (inc <= rebateThresh) t = Math.max(0, t - rebateAmt);
    else if (regime === 'new') t = Math.min(t, inc - rebateThresh);   // marginal relief on 87A
    return t;
  };

  const slabTax = applySlabs(taxableIncome, slabs);
  const tax     = taxBeforeSurcharge(taxableIncome);

  // Surcharge
  const sl = (cfg.surcharge_slabs || DEFAULT_SURCHARGE).split(',').map(x => {
    const [above, rate] = x.split('|'); return { above: parseFloat(above), rate: parseFloat(rate) };
  }).sort((p, q) => p.above - q.above);
  const capNew   = cfgN(cfg, 'surcharge_cap_new', 25);
  const rateAt   = (inc) => {
    let r = 0;
    for (const x of sl) if (inc > x.above) r = x.rate;
    return regime === 'new' ? Math.min(r, capNew) : r;
  };
  const surRate = rateAt(taxableIncome);
  let surcharge = tax * surRate / 100;
  if (surRate > 0) {
    // Marginal relief: extra (tax + surcharge) can't exceed the income above the threshold
    const thr = sl.filter(x => taxableIncome > x.above).pop().above;
    const prevTotal = taxBeforeSurcharge(thr) * (1 + rateAt(thr) / 100);
    const total     = tax + surcharge;
    if (total - prevTotal > taxableIncome - thr) surcharge = Math.max(0, prevTotal + (taxableIncome - thr) - tax);
  }

  const cessRate = cfgN(cfg, 'cess_rate', 4) / 100;
  const beforeCess = tax + surcharge;
  const cess  = beforeCess * cessRate;
  const total = Math.round(beforeCess + cess);
  return {
    slab_tax:            Math.round(slabTax),
    rebate:              Math.round(Math.max(0, slabTax - tax)),
    tax_before_surcharge:Math.round(tax),
    surcharge_rate:      surRate,
    surcharge:           Math.round(surcharge),
    tax_before_cess:     Math.round(beforeCess),
    cess:                total - Math.round(beforeCess),
    total,
  };
}

function computeTax(taxableIncome, regime, cfg, ageGroup = 'below60') {
  return computeTaxDetail(taxableIncome, regime, cfg, ageGroup).total;
}

// ── FIX: HRA Exemption helper (used in both saveDeclaration & taxPreview) ─────
// Min of: (a) actual HRA received, (b) rent paid - 10% of basic, (c) 50%/40% of basic
function calcHRAExempt(d, salRow) {
  const rentMonthly = parseFloat(d.rent_paid_monthly || 0);
  if (!salRow || rentMonthly <= 0) return 0;

  // Use annual_rent if filled, else derive from monthly
  const annRent  = parseFloat(d.annual_rent || 0) > 0
    ? parseFloat(d.annual_rent)
    : rentMonthly * 12;
  const annBasic = parseFloat(salRow.basic || 0) * 12;
  const annHRA   = parseFloat(salRow.hra || 0) * 12;
  const isMetro  = (d.hra_city_type || 'metro') === 'metro';

  return Math.max(0, Math.min(
    annHRA,                          // (a) HRA component received
    annRent - annBasic * 0.1,        // (b) rent paid minus 10% of basic
    annBasic * (isMetro ? 0.5 : 0.4) // (c) 50% or 40% of basic
  ));
}

// ── Deductions calculator (OLD REGIME only — new regime doesn't use this) ─────
function calcDeductions(d, cfg, salRow) {
  const lim80c      = cfgN(cfg, 'limit_80c', 150000);
  const limNps      = cfgN(cfg, 'limit_80ccd1b', 50000);
  const lim80dSelf  = (salRow && salRow.age_group && salRow.age_group !== 'below60')
    ? cfgN(cfg, 'limit_80d_self_sr', 50000)
    : cfgN(cfg, 'limit_80d_self', 25000);
  const lim80dPar   = d.sec80d_senior_parent
    ? cfgN(cfg, 'limit_80d_parents_sr', 50000)
    : cfgN(cfg, 'limit_80d_parents', 25000);
  const limHLoan    = cfgN(cfg, 'limit_sec24b', 200000);
  const lim80ddN    = cfgN(cfg, 'limit_80dd_normal', 75000);
  const lim80ddS    = cfgN(cfg, 'limit_80dd_severe', 125000);
  const lim80uN     = cfgN(cfg, 'limit_80u_normal', 75000);
  const lim80uS     = cfgN(cfg, 'limit_80u_severe', 125000);
  const lim80ddbB60 = cfgN(cfg, 'limit_80ddb_below60', 40000);

  // FIX: Auto-include PF (employee share) in 80C if employee hasn't manually entered it
  // PF = 12% of basic (employee share). If salary structure exists, use it.
  // Only auto-fill if the declared sec80c_pf is 0 (employee didn't fill it)
  let pfAuto = 0;
  if (salRow && parseFloat(d.sec80c_pf || 0) === 0) {
    pfAuto = parseFloat(salRow.basic || 0) * 12 * 0.12; // 12% of annual basic
  }
  const pfDeclared = parseFloat(d.sec80c_pf || 0);
  const pfForCalc  = pfDeclared > 0 ? pfDeclared : pfAuto;

  const c80c = Math.min(
    pfForCalc +
    parseFloat(d.sec80c_ppf     || 0) +
    parseFloat(d.sec80c_lic     || 0) +
    parseFloat(d.sec80c_elss    || 0) +
    parseFloat(d.sec80c_nsc     || 0) +
    parseFloat(d.sec80c_home_loan || 0) +
    parseFloat(d.sec80c_tuition || 0) +
    parseFloat(d.sec80c_fd      || 0) +
    parseFloat(d.sec80c_other   || 0),
    lim80c
  );

  const nps      = Math.min(parseFloat(d.sec80ccd_nps || 0), limNps);
  const d80d     = Math.min(parseFloat(d.sec80d_self || 0), lim80dSelf)
                 + Math.min(parseFloat(d.sec80d_parents || 0), lim80dPar);
  const homeloan = Math.min(parseFloat(d.sec24b_home_loan || 0), limHLoan);
  const edu      = parseFloat(d.sec80e_edu_loan || 0);
  const donation = parseFloat(d.sec80g_donation || 0);
  const ddPct    = parseFloat(d.sec80dd_pct || 0);
  const d80dd    = ddPct >= 80 ? lim80ddS : (ddPct > 0 ? lim80ddN : 0);
  const uPct     = parseFloat(d.sec80u_pct || 0);
  const d80u     = uPct >= 80 ? lim80uS : (uPct > 0 ? lim80uN : 0);
  const d80ddb   = Math.min(parseFloat(d.sec80ddb_amount || 0), lim80ddbB60);
  const lta      = parseFloat(d.lta_amount || 0);

  // HRA Exemption
  const hraExempt = calcHRAExempt(d, salRow);

  // House Property — net loss (SOP capped at 2L)
  let houseNetLoss = 0;
  const props = Array.isArray(d.house_properties) ? d.house_properties : [];
  for (const p of props) {
    const rental    = parseFloat(p.rental_income || 0);
    const munTax    = parseFloat(p.municipal_tax || 0);
    const intPaid   = parseFloat(p.interest_paid || 0);
    const netAnnVal = rental - munTax;
    const stdDed    = netAnnVal * 0.3;
    const netHPInc  = netAnnVal - stdDed - intPaid;
    houseNetLoss += netHPInc;
  }
  const hpDeduction = Math.min(Math.max(0, -houseNetLoss), 200000);

  return {
    c80c, nps, d80d, homeloan, edu, donation, d80dd, d80u, d80ddb, lta,
    hraExempt, hpDeduction, pfAuto,
    total: c80c + nps + d80d + homeloan + edu + donation + d80dd + d80u + d80ddb
  };
}

// ── MASTER TAX COMPUTATION (used by both saveDeclaration and taxPreview) ──────
// Returns computed values for whichever regime is passed
function computeRegimeTax(regime, d, cfg, sal, prevSal, otherInc) {
  const annGross = parseFloat(sal.gross_salary || 0) * 12;

  if (regime === 'new') {
    // NEW REGIME: Only std deduction (₹75k) + employer NPS (80CCD2)
    // NO HRA, NO 80C, NO 80D, NO home loan, NO other deductions
    const stdNew      = cfgN(cfg, 'std_deduction_new', 75000);
    const employerNps = parseFloat(d.employer_nps || 0);
    const taxableNew  = Math.max(0, annGross + prevSal + otherInc - stdNew - employerNps);
    const detail      = computeTaxDetail(taxableNew, 'new', cfg, sal && sal.age_group);
    const tax         = detail.total;
    return {
      taxableIncome:   taxableNew,
      tax,
      detail,
      stdDeduction:    stdNew,
      employerNps,
      totalDeductions: stdNew + employerNps,
      c80c:            0,
    };
  } else {
    // OLD REGIME: Full deductions — 80C, HRA, 80D, home loan etc.
    const deductions = calcDeductions(d, cfg, sal);
    const stdOld     = cfgN(cfg, 'std_deduction_old', 50000);
    const taxableOld = Math.max(0,
      annGross + prevSal + otherInc
      - stdOld
      - deductions.hraExempt
      - deductions.total
      - deductions.hpDeduction
    );
    const detail = computeTaxDetail(taxableOld, 'old', cfg, sal && sal.age_group);
    const tax = detail.total;
    return {
      taxableIncome:   taxableOld,
      tax,
      detail,
      stdDeduction:    stdOld,
      hraExempt:       deductions.hraExempt,
      hpDeduction:     deductions.hpDeduction,
      totalDeductions: deductions.total,
      c80c:            deductions.c80c,
      deductions,
    };
  }
}

// ── GET /it-declaration ───────────────────────────────────────────────────────
exports.getDeclaration = async (req, res) => {
  try {
    const reqUser = req.user;
    const empId   = req.query.employee_id ? parseInt(req.query.employee_id) : reqUser.id;
    const fy      = req.query.fy || '2025-26';
    const isPriv  = ['super_admin','hr','accounts'].includes(reqUser.role);
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
    const isPriv = ['super_admin','hr','accounts'].includes(reqUser.role);
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
    const reqUser = req.user;
    const isPriv  = ['super_admin','hr','accounts'].includes(reqUser.role);
    const b       = req.body;
    const empId   = (isPriv && b.employee_id) ? parseInt(b.employee_id) : reqUser.id;
    const fy      = b.financial_year || '2025-26';
    const action  = b.action || 'save';
    const regime  = b.regime || 'old'; // ✅ FIX: read regime from request

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

    const cfg = await loadConfig(fy);
    const now = new Date();
    if (action === 'submit' && !isPriv) {
      const declEnd = cfg.declaration_end ? new Date(cfg.declaration_end) : null;
      if (declEnd && now > declEnd)
        return res.status(400).json({ success:false, message:`Declaration window closed on ${declEnd.toDateString()}` });
    }

    // Fetch salary structure
    const salRow = await db.query(
      `SELECT ess.basic, ess.hra, ess.gross_salary, e.date_of_birth
       FROM employees e
       LEFT JOIN employee_salary_structure ess ON ess.employee_id = e.id
       WHERE e.id=$1`, [empId]
    );
    const sal = salRow.rows[0] || {};
    sal.age_group = getAgeGroup(sal.date_of_birth, fy);

    const prevSal  = parseFloat(b.prev_gross_salary || 0);
    const otherInc = parseFloat(b.other_savings_int || 0) + parseFloat(b.other_fd_int || 0) +
                     parseFloat(b.other_dividend || 0) + parseFloat(b.other_misc || 0);
    // Note: capital gains are kept separate as they may have different tax treatment

    // ✅ FIX: Use regime-aware tax computation
    const computed = computeRegimeTax(regime, b, cfg, sal, prevSal, otherInc);
    const estTax   = computed.tax;

    // Monthly TDS: same formula as taxPreview — spread remaining tax over remaining months
    const prevTdsForSave = parseFloat(b.prev_tds || 0);
    const netTaxForSave  = Math.max(0, estTax - prevTdsForSave);
    const paidResForSave = await db.query(
      `SELECT COALESCE(SUM(tds),0) AS paid FROM payroll
       WHERE employee_id=$1 AND ((year=$2 AND month>=4) OR (year=$3 AND month<=3))`,
      [empId, parseInt(fy.slice(0, 4)), parseInt(fy.slice(0, 4)) + 1]
    );
    const tdsPaidForSave = parseFloat(paidResForSave.rows[0].paid) || 0;
    const nowMForSave    = new Date().getMonth() + 1;
    const monthsRemForSave = nowMForSave >= 4 ? 16 - nowMForSave : 4 - nowMForSave;
    const monthlyTds = Math.round(Math.max(0, netTaxForSave - tdsPaidForSave) / Math.max(1, monthsRemForSave));

    // For storage: always compute 80C total for reference (even in new regime, we store what was declared)
    const deductionsForStorage = calcDeductions(b, cfg, sal);
    const c80cForStorage       = deductionsForStorage.c80c;
    const totalDedForStorage   = regime === 'new'
      ? computed.totalDeductions
      : computed.totalDeductions;

    const status      = action === 'submit' ? 'submitted' : 'draft';
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
        other_savings_int, other_fd_int, other_capital_gains, other_dividend, other_misc,
        employer_nps,
        total_80c, total_deductions, estimated_tax, monthly_tds,
        status, submitted_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
        $41,$42,$43,$44,$45,$46,$47,$48,$49,$50,
        $51,$52,$53,$54,$55,$56,$57,$58,$59,$60,
        $61,$62,$63,NOW()
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
        other_savings_int=$52, other_fd_int=$53, other_capital_gains=$54, other_dividend=$55, other_misc=$56,
        employer_nps=$57,
        total_80c=$58, total_deductions=$59, estimated_tax=$60, monthly_tds=$61,
        status = CASE WHEN it_declarations.locked = TRUE THEN it_declarations.status
                      WHEN it_declarations.status IN ('approved','verified') THEN it_declarations.status
                      ELSE $62 END,
        submitted_at = CASE WHEN $63::timestamptz IS NOT NULL AND it_declarations.submitted_at IS NULL
                            THEN $63 ELSE it_declarations.submitted_at END,
        updated_at = NOW()
      RETURNING *`,
      [empId, fy, regime,
       parseFloat(b.rent_paid_monthly || 0),
       parseFloat(b.annual_rent || 0) > 0 ? parseFloat(b.annual_rent) : parseFloat(b.rent_paid_monthly || 0) * 12,
       b.landlord_name || null, b.landlord_pan || null, b.hra_city_type || 'metro',
       parseFloat(b.sec80c_pf || 0), parseFloat(b.sec80c_ppf || 0), parseFloat(b.sec80c_lic || 0),
       parseFloat(b.sec80c_elss || 0), parseFloat(b.sec80c_nsc || 0), parseFloat(b.sec80c_home_loan || 0),
       parseFloat(b.sec80c_tuition || 0), parseFloat(b.sec80c_fd || 0), parseFloat(b.sec80c_other || 0),
       parseFloat(b.sec80ccd_nps || 0), parseFloat(b.sec80d_self || 0), parseFloat(b.sec80d_parents || 0),
       b.sec80d_senior_parent === 'true' || b.sec80d_senior_parent === true,
       parseFloat(b.sec24b_home_loan || 0), b.homeloan_provider || null, b.homeloan_address || null,
       parseFloat(b.sec80e_edu_loan || 0), parseFloat(b.sec80g_donation || 0),
       b.sec80g_institution || null, b.sec80g_pan || null, b.sec80g_category || null,
       parseFloat(b.sec80dd_amount || 0), b.sec80dd_dependent || null, b.sec80dd_relation || null, parseFloat(b.sec80dd_pct || 0),
       parseFloat(b.sec80u_amount || 0), parseFloat(b.sec80u_pct || 0), b.sec80u_category || null,
       parseFloat(b.sec80ddb_amount || 0), b.sec80ddb_disease || null, b.sec80ddb_patient || null, b.sec80ddb_relation || null,
       parseFloat(b.lta_amount || 0), b.lta_destination || null, b.lta_travel_period || null,
       b.prev_employer || null, b.prev_employer_tan || null, b.prev_period || null,
       parseFloat(b.prev_gross_salary || 0), parseFloat(b.prev_taxable_income || 0),
       parseFloat(b.prev_tds || 0), parseFloat(b.prev_pf || 0),
       houseProps,
       parseFloat(b.other_savings_int || 0), parseFloat(b.other_fd_int || 0),
       parseFloat(b.other_capital_gains || 0), parseFloat(b.other_dividend || 0), parseFloat(b.other_misc || 0),
       parseFloat(b.employer_nps || 0),
       c80cForStorage, totalDedForStorage, estTax, monthlyTds,
       status, submittedAt]
    );

    await db.query(
      `INSERT INTO it_audit_logs(declaration_id, action, performed_by, details) VALUES($1,$2,$3,$4)`,
      [result.rows[0].id, action === 'submit' ? 'SUBMITTED' : 'SAVED', empId,
       { status, regime, estimated_tax: estTax, monthly_tds: monthlyTds }]
    );

    if (action === 'submit') {
      await db.query(
        `INSERT INTO notifications(employee_id, title, message, type)
         SELECT e.id,'📋 New IT Declaration Submitted',
           'Employee ' || $1 || ' submitted IT Declaration for FY ' || $2, 'it_declaration'
         FROM employees e WHERE e.role IN ('hr','accounts') AND e.is_active=TRUE`,
        [req.user.employee_code || req.user.id, fy]
      ).catch(() => {});
    }

    res.json({
      success: true,
      data: result.rows[0],
      message: action === 'submit' ? 'Declaration submitted to HR!' : 'Saved as draft',
      // FIX: Return computed breakdown for frontend to display
      tax_summary: {
        regime,
        annual_gross:     Math.round(parseFloat(sal.gross_salary || 0) * 12),
        taxable_income:   Math.round(computed.taxableIncome),
        estimated_tax:    estTax,
        net_tax:          Math.round(netTaxForSave),
        tds_paid_ytd:     Math.round(tdsPaidForSave),
        months_remaining: monthsRemForSave,
        monthly_tds:      monthlyTds,
        std_deduction:    computed.stdDeduction,
        total_deductions: Math.round(computed.totalDeductions),
      }
    });
  } catch (err) {
    console.error('[saveDeclaration]', err.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
};

// ── POST /it-declaration/proof ────────────────────────────────────────────────
exports.uploadProof = async (req, res) => {
  try {
    const reqUser = req.user;
    const isPriv  = ['super_admin','hr','accounts'].includes(reqUser.role);
    const { declaration_id, section, section_label, doc_type } = req.body;
    const file  = req.file;
    if (!file) return res.status(400).json({ success:false, message:'No file uploaded' });
    if (!declaration_id || !section)
      return res.status(400).json({ success:false, message:'declaration_id and section required' });

    const declRow = isPriv
      ? await db.query(`SELECT id, financial_year, employee_id FROM it_declarations WHERE id=$1`, [declaration_id])
      : await db.query(`SELECT id, financial_year, employee_id FROM it_declarations WHERE id=$1 AND employee_id=$2`, [declaration_id, reqUser.id]);
    if (!declRow.rows.length) return res.status(403).json({ success:false, message:'Declaration not found or access denied' });

    const { financial_year: fy, employee_id: empId } = declRow.rows[0];
    const cfg = await loadConfig(fy);
    const proofEnd = cfg.proof_end ? new Date(cfg.proof_end) : null;
    if (proofEnd && new Date() > proofEnd && !isPriv)
      return res.status(400).json({ success:false, message:`Proof upload window closed on ${proofEnd.toDateString()}` });

    const absFilePath = file.path;

    await db.query(`
      INSERT INTO it_proof_documents
        (declaration_id, employee_id, section, section_label, doc_type, file_name, file_path, file_size, mime_type, status, uploaded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',NOW())`,
      [declaration_id, empId, section, section_label || section, doc_type || section,
       file.originalname, absFilePath, file.size, file.mimetype]
    );

    await db.query(
      `INSERT INTO it_audit_logs(declaration_id, action, performed_by, details)
       VALUES($1,'PROOF_UPLOADED',$2,$3)`,
      [declaration_id, reqUser.id, { section, file_name: file.originalname }]
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
    const isPriv = ['super_admin','hr','accounts'].includes(reqUser.role);
    if (!isPriv && proof.employee_id !== reqUser.id)
      return res.status(403).json({ success:false, message:'Access denied' });

    const UPLOAD_DIR_ABS = path.join(__dirname, '../../../../uploads/it-proofs');
    const candidatePaths = [
      proof.file_path,
      path.resolve(process.cwd(), proof.file_path),
      path.join(UPLOAD_DIR_ABS, path.basename(proof.file_path)),
      path.resolve(__dirname, '../../../../', proof.file_path),
    ].filter(Boolean);

    let absPath = null;
    for (const p of candidatePaths) {
      try { if (fs.existsSync(p)) { absPath = p; break; } } catch(_) {}
    }
    if (!absPath)
      return res.status(404).json({ success:false, message:'File not found on server' });
    res.setHeader('Content-Type', proof.mime_type || 'application/octet-stream');
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
    if (proof.employee_id !== empId && !['super_admin','hr','accounts'].includes(req.user.role))
      return res.status(403).json({ success:false, message:'Access denied' });
    if (['approved','verified'].includes(proof.status))
      return res.status(400).json({ success:false, message:'Cannot delete a verified proof' });

    const UPLOAD_DIR_ABS2 = path.join(__dirname, '../../../../uploads/it-proofs');
    const candidates2 = [
      proof.file_path,
      path.resolve(process.cwd(), proof.file_path),
      path.join(UPLOAD_DIR_ABS2, path.basename(proof.file_path)),
      path.resolve(__dirname, '../../../../', proof.file_path),
    ].filter(Boolean);
    let absPath = null;
    for (const p of candidates2) {
      try { if (fs.existsSync(p)) { absPath = p; break; } } catch(_) {}
    }
    if (absPath && fs.existsSync(absPath)) fs.unlinkSync(absPath);
    await db.query(`DELETE FROM it_proof_documents WHERE id=$1`, [proofId]);
    res.json({ success:true, message:'Proof deleted' });
  } catch (err) {
    console.error('[deleteProof]', err.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
};

// ── POST /it-declaration/:id/review ──────────────────────────────────────────
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
        approved_at = CASE WHEN $5='approved' THEN NOW()
                          WHEN $5 IN ('draft','rejected') THEN NULL
                          ELSE approved_at END,
        approved_by = CASE WHEN $5='approved' THEN $3
                          WHEN $5 IN ('draft','rejected') THEN NULL
                          ELSE approved_by END
      WHERE id=$6`,
      [newStatus, comment || null, hrId, locked, newStatus, declId]
    );

    await db.query(
      `INSERT INTO it_audit_logs(declaration_id, action, performed_by, details)
       VALUES($1,$2,$3,$4)`,
      [declId, action.toUpperCase(), hrId, { comment, new_status: newStatus }]
    );

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
      [action === 'approve' ? 'approved' : 'rejected', comment || null, hrId, proofId]
    );
    res.json({ success:true, message:`Proof ${action}d` });
  } catch (err) {
    console.error('[reviewProof]', err.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
};

// ── GET /it-declaration/tax-preview ──────────────────────────────────────────
exports.taxPreview = async (req, res) => {
  try {
    const empId = req.query.employee_id ? parseInt(req.query.employee_id) : req.user.id;
    const fy    = req.query.fy || '2025-26';
    const cfg   = await loadConfig(fy);

    const salRes = await db.query(
      `SELECT ess.gross_salary, ess.basic, ess.hra, e.city, e.date_of_birth, e.joining_date
       FROM employee_salary_structure ess JOIN employees e ON ess.employee_id=e.id
       WHERE ess.employee_id=$1`, [empId]
    );
    if (!salRes.rows.length)
      return res.json({ success:false, message:'Salary structure not set up. Ask HR.' });
    const sal      = salRes.rows[0];
    sal.age_group  = getAgeGroup(sal.date_of_birth, fy);
    // Months this employee actually earns from this employer in the FY (mid-year joiners < 12)
    const fyStartYr = parseInt(fy.slice(0, 4));
    let monthsEmployed = 12;
    if (sal.joining_date) {
      let jY, jM;
      if (sal.joining_date instanceof Date) { jY = sal.joining_date.getFullYear(); jM = sal.joining_date.getMonth() + 1; }
      else { const mt = String(sal.joining_date).match(/^(\d{4})-(\d{2})/); if (mt) { jY = +mt[1]; jM = +mt[2]; } }
      if (jY) monthsEmployed = Math.max(0, Math.min(12, 12 - ((jY * 12 + jM) - (fyStartYr * 12 + 4))));
    }
    // computeRegimeTax annualises gross_salary x 12, so scale the monthly figure by months employed / 12
    sal.gross_salary = parseFloat(sal.gross_salary || 0) * monthsEmployed / 12;
    const annGross = parseFloat(sal.gross_salary || 0) * 12;

    const declRes = await db.query(
      `SELECT * FROM it_declarations WHERE employee_id=$1 AND financial_year=$2`, [empId, fy]
    );
    const d = declRes.rows[0] || {};
    if (d.house_properties && typeof d.house_properties === 'string') {
      try { d.house_properties = JSON.parse(d.house_properties); } catch { d.house_properties = []; }
    }

    const prevSal  = parseFloat(d.prev_gross_salary || 0);
    const otherInc = parseFloat(d.other_savings_int || 0) + parseFloat(d.other_fd_int || 0) +
                     parseFloat(d.other_dividend || 0) + parseFloat(d.other_misc || 0) +
                     parseFloat(d.other_capital_gains || 0);
    const prevTds  = parseFloat(d.prev_tds || 0);

    // ── OLD REGIME ────────────────────────────────────────────────────────────
    const oldComputed = computeRegimeTax('old', d, cfg, sal, prevSal, otherInc);
    const taxOld      = oldComputed.tax;
    const netTaxOld   = Math.max(0, taxOld - prevTds);

    // ── NEW REGIME ────────────────────────────────────────────────────────────
    const newComputed = computeRegimeTax('new', d, cfg, sal, prevSal, otherInc);
    const taxNew      = newComputed.tax;
    const netTaxNew   = Math.max(0, taxNew - prevTds);

    const nowM        = new Date().getMonth() + 1;                 // 1-12
    const monthsRem   = nowM >= 4 ? 16 - nowM : 4 - nowM;          // months left in the FY incl. this one (Apr=12 ... Mar=1)

    // TDS already deducted through payroll in this FY — the payroll template subtracts this
    // too, so the "Monthly TDS" shown here now matches what payroll will actually deduct.
    const fyStart = parseInt(fy.slice(0, 4));
    const paidRes = await db.query(
      `SELECT COALESCE(SUM(tds),0) AS paid FROM payroll
       WHERE employee_id=$1 AND ((year=$2 AND month>=4) OR (year=$3 AND month<=3))`,
      [empId, fyStart, fyStart + 1]);
    const tdsPaidYtd = parseFloat(paidRes.rows[0].paid) || 0;
    const recommended = netTaxOld <= netTaxNew ? 'old' : 'new';
    const savings     = Math.abs(netTaxOld - netTaxNew);

    // Build recommendation reasons
    const reasons = [];
    const ded = oldComputed.deductions || {};
    if (ded.c80c >= cfgN(cfg, 'limit_80c', 150000) * 0.9) reasons.push(`80C fully utilized (${fmt(ded.c80c)})`);
    if ((ded.hraExempt || 0) > 0) reasons.push(`HRA exemption of ${fmt(ded.hraExempt)}`);
    if ((ded.homeloan || 0) > 0) reasons.push(`Home Loan Interest Sec 24(b) (${fmt(ded.homeloan)})`);
    if ((ded.nps || 0) > 0) reasons.push(`NPS 80CCD(1B) (${fmt(ded.nps)})`);
    if ((ded.d80d || 0) > 0) reasons.push(`Medical Insurance 80D (${fmt(ded.d80d)})`);
    if (reasons.length === 0 && recommended === 'new')
      reasons.push('Standard Deduction ₹75,000 in New Regime exceeds applicable deductions');

    res.json({ success:true, data: {
      age_group:     sal.age_group,
      annual_gross:  Math.round(annGross),
      prev_salary:   Math.round(prevSal),
      other_income:  Math.round(otherInc),
      old_regime: {
        std_deduction:      oldComputed.stdDeduction,
        hra_exemption:      Math.round(oldComputed.hraExempt || 0),
        deduction_80c:      Math.round(ded.c80c || 0),
        deduction_nps:      Math.round(ded.nps || 0),
        deduction_80d:      Math.round(ded.d80d || 0),
        deduction_homeloan: Math.round(ded.homeloan || 0),
        deduction_80e:      Math.round(ded.edu || 0),
        deduction_80g:      Math.round(ded.donation || 0),
        deduction_80dd:     Math.round(ded.d80dd || 0),
        deduction_80u:      Math.round(ded.d80u || 0),
        deduction_80ddb:    Math.round(ded.d80ddb || 0),
        deduction_lta:      Math.round(ded.lta || 0),
        house_property:     Math.round(oldComputed.hpDeduction || 0),
        total_deductions:   Math.round(oldComputed.totalDeductions),
        taxable_income:     Math.round(oldComputed.taxableIncome),
        slab_tax:             oldComputed.detail.slab_tax,
        rebate_87a:           oldComputed.detail.rebate,
        tax_before_surcharge: oldComputed.detail.tax_before_surcharge,
        surcharge_rate:       oldComputed.detail.surcharge_rate,
        surcharge:            oldComputed.detail.surcharge,
        tax_before_cess:    oldComputed.detail.tax_before_cess,
        cess:               oldComputed.detail.cess,
        tax:                Math.round(taxOld),
        prev_tds:           Math.round(prevTds),
        net_tax:            Math.round(netTaxOld),
        tds_paid_ytd:       Math.round(tdsPaidYtd),
        monthly_tds:        Math.round(Math.max(0, netTaxOld - tdsPaidYtd) / monthsRem),
      },
      new_regime: {
        std_deduction:   newComputed.stdDeduction,
        employer_nps:    Math.round(newComputed.employerNps || 0),
        taxable_income:  Math.round(newComputed.taxableIncome),
        slab_tax:             newComputed.detail.slab_tax,
        rebate_87a:           newComputed.detail.rebate,
        tax_before_surcharge: newComputed.detail.tax_before_surcharge,
        surcharge_rate:       newComputed.detail.surcharge_rate,
        surcharge:            newComputed.detail.surcharge,
        tax_before_cess: newComputed.detail.tax_before_cess,
        cess:            newComputed.detail.cess,
        tax:             Math.round(taxNew),
        prev_tds:        Math.round(prevTds),
        net_tax:         Math.round(netTaxNew),
        tds_paid_ytd:    Math.round(tdsPaidYtd),
        monthly_tds:     Math.round(Math.max(0, netTaxNew - tdsPaidYtd) / monthsRem),
      },
      months_remaining: monthsRem,
      months_employed:  monthsEmployed,
      recommended,
      savings: Math.round(savings),
      recommendation_reasons: reasons,
      zero_tax_note: taxNew === 0
        ? `No tax under New Regime — taxable income is within the Section 87A rebate limit of ${fmt(cfgN(cfg, 'rebate_87a_new', 1200000))}`
        : null,
    }});
  } catch (err) {
    console.error('[taxPreview]', err.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
};

function fmt(n) { return '₹' + (parseFloat(n) || 0).toLocaleString('en-IN'); }

// ── GET /it-declaration/config ────────────────────────────────────────────────
exports.getConfig = async (req, res) => {
  try {
    const fy   = req.query.fy || '2025-26';
    const res2 = await db.query(`SELECT * FROM it_tax_config WHERE fy=$1 ORDER BY config_key`, [fy]);
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
      [fy, config_key, String(config_value), description || null, req.user.id]
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

// ── GET /it-declaration/export-excel ─────────────────────────────────────────
exports.exportExcel = async (req, res) => {
  try {
    const XLSX = require('xlsx-js-style');
    const { fy = '2025-26', status } = req.query;
    const baseUrl = process.env.BACKEND_URL || req.protocol + '://' + req.get('host');
    const token   = (req.headers.authorization || '').replace('Bearer ', '');

    let q = `
      SELECT d.*,
             CONCAT(e.first_name,' ',e.last_name) AS employee_name,
             e.employee_code, e.pan_number,
             dept.name AS department, des.title AS designation
      FROM it_declarations d
      JOIN employees e ON d.employee_id = e.id
      LEFT JOIN departments  dept ON e.department_id  = dept.id
      LEFT JOIN designations des  ON e.designation_id = des.id
      WHERE d.financial_year = $1`;
    const params = [fy];
    if (status) { params.push(status); q += ` AND d.status = $${params.length}`; }
    q += ` ORDER BY e.employee_code, e.first_name`;

    const decls = (await db.query(q, params)).rows;
    if (!decls.length)
      return res.status(404).json({ success: false, message: 'No declarations found for selected filters.' });

    const declIds = decls.map(d => d.id);
    const proofRows = (await db.query(
      `SELECT id, declaration_id, section, section_label, doc_type, file_name, file_size, mime_type, status AS proof_status, uploaded_at
       FROM it_proof_documents WHERE declaration_id = ANY($1) ORDER BY declaration_id, section, uploaded_at`,
      [declIds]
    )).rows;

    const proofsMap = {};
    for (const p of proofRows) {
      if (!proofsMap[p.declaration_id]) proofsMap[p.declaration_id] = {};
      if (!proofsMap[p.declaration_id][p.section]) proofsMap[p.declaration_id][p.section] = [];
      proofsMap[p.declaration_id][p.section].push(p);
    }

    const C = {
      hdBg:'C0272D', hdFg:'FFFFFF', shBg:'1E3A5F', shFg:'FFFFFF',
      lbBg:'F5F6FB', lbFg:'374151', vaBg:'FFFFFF', vaFg:'111827',
      phBg:'2E7D32', phFg:'FFFFFF', prBg1:'F0FDF4', prBg2:'FFFFFF',
      numFg:'1D4ED8', totBg:'FEF3C7', totFg:'92400E',
      pendFg:'D97706', apprFg:'15803D', rejFg:'BE123C',
    };

    const font      = (bold, sz, color, name='Calibri') => ({ name, sz:sz||11, bold:!!bold, color:{rgb:color||'000000'} });
    const fill      = (rgb) => ({ patternType:'solid', fgColor:{rgb} });
    const border    = () => ({ top:{style:'thin',color:{rgb:'D1D5DB'}}, bottom:{style:'thin',color:{rgb:'D1D5DB'}}, left:{style:'thin',color:{rgb:'D1D5DB'}}, right:{style:'thin',color:{rgb:'D1D5DB'}} });
    const thickBorder = () => ({ top:{style:'medium',color:{rgb:'9CA3AF'}}, bottom:{style:'medium',color:{rgb:'9CA3AF'}}, left:{style:'medium',color:{rgb:'9CA3AF'}}, right:{style:'medium',color:{rgb:'9CA3AF'}} });

    const labelCell = (v) => ({ v, t:'s', s:{ font:font(true,10,C.lbFg), fill:fill(C.lbBg), alignment:{horizontal:'left',vertical:'center'}, border:border() }});
    const valCell   = (v, isNum) => ({ v:v??'', t:typeof v==='number'?'n':'s', s:{ font:{name:'Calibri',sz:10,bold:false,color:{rgb:isNum?C.numFg:C.vaFg}}, fill:fill(C.vaBg), alignment:{horizontal:typeof v==='number'?'right':'left',vertical:'center'}, border:border(), numFmt:typeof v==='number'?'#,##0.00':undefined }});
    const totLabelCell = (v) => ({ v, t:'s', s:{ font:font(true,10,C.totFg), fill:fill(C.totBg), alignment:{horizontal:'left',vertical:'center'}, border:thickBorder() }});
    const totValCell   = (v) => ({ v:v??0, t:'n', s:{ font:font(true,10,C.totFg), fill:fill(C.totBg), alignment:{horizontal:'right',vertical:'center'}, border:thickBorder(), numFmt:'#,##0.00' }});
    const sectionCell  = (v) => ({ v, t:'s', s:{ font:font(true,10,C.shFg), fill:fill(C.shBg), alignment:{horizontal:'left',vertical:'center'}, border:border() }});
    const proofHdrCell = (v) => ({ v, t:'s', s:{ font:font(true,9,C.phFg), fill:fill(C.phBg), alignment:{horizontal:'center',vertical:'center'}, border:border() }});
    const proofValCell = (v, rowI, link) => {
      const bg = rowI%2===0 ? C.prBg1 : C.prBg2;
      const o = { v:v??'', t:'s', s:{ font:{name:'Calibri',sz:9,color:{rgb:'374151'}}, fill:fill(bg), alignment:{horizontal:'left',vertical:'center',wrapText:true}, border:border() }};
      if (link) o.l = { Target:link, Tooltip:'Click to view proof' };
      return o;
    };
    const proofStatusCell = (v, rowI) => {
      const bg = rowI%2===0 ? C.prBg1 : C.prBg2;
      const fg = v==='approved' ? C.apprFg : v==='rejected' ? C.rejFg : C.pendFg;
      return { v:v??'', t:'s', s:{ font:{name:'Calibri',sz:9,bold:true,color:{rgb:fg}}, fill:fill(bg), alignment:{horizontal:'center',vertical:'center'}, border:border() }};
    };

    const n = (v) => parseFloat(v||0);
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-IN') : '—';

    const wb = XLSX.utils.book_new();

    for (const d of decls) {
      const sectionProofs = proofsMap[d.id] || {};
      const data = [];
      let row = 0;
      const merges = [
        { s:{r:0,c:0}, e:{r:0,c:5} },
        { s:{r:1,c:0}, e:{r:1,c:5} },
      ];

      const addRow = (...cells) => { cells.forEach((c, col) => { data.push({r:row, c:col, cell:c}); }); row++; };
      const addBlank = () => { data.push({r:row,c:0,cell:{v:'',t:'s',s:{}}}); row++; };
      const addSection = (title, icon) => {
        addBlank();
        data.push({r:row, c:0, cell:sectionCell(`  ${icon}  ${title}`)});
        for(let c=1;c<6;c++) data.push({r:row,c,cell:{v:'',t:'s',s:{fill:fill(C.shBg),border:border()}}});
        merges.push({ s:{r:row,c:0}, e:{r:row,c:5} });
        row++;
      };
      const addLV = (label, val, label2, val2) => {
        addRow(
          labelCell(label), valCell(val, typeof val==='number'),
          label2 ? labelCell(label2) : {v:'',t:'s',s:{fill:fill(C.vaBg),border:border()}},
          label2 ? valCell(val2, typeof val2==='number') : {v:'',t:'s',s:{fill:fill(C.vaBg),border:border()}},
          {v:'',t:'s',s:{fill:fill(C.vaBg),border:border()}},
          {v:'',t:'s',s:{fill:fill(C.vaBg),border:border()}}
        );
      };
      const addProofs = (section) => {
        const proofs = sectionProofs[section] || [];
        if (!proofs.length) return;
        addRow(proofHdrCell('📎 Proof'), proofHdrCell('Document'), proofHdrCell('File Name'), proofHdrCell('Size'), proofHdrCell('Status'), proofHdrCell('View Link'));
        proofs.forEach((p, i) => {
          const viewUrl = `${baseUrl}/api/it-declaration/proof/${p.id}?token=${token}`;
          addRow(
            proofValCell(p.section_label || p.doc_type, i),
            proofValCell(p.doc_type, i),
            proofValCell(p.file_name, i),
            proofValCell(p.file_size ? Math.round(p.file_size/1024)+' KB' : '—', i),
            proofStatusCell(p.proof_status, i),
            proofValCell(viewUrl, i, viewUrl)
          );
        });
      };

      // Title Banner
      for(let c=0;c<6;c++) data.push({r:row, c, cell: c===0
        ? {v:`IT Declaration Export  —  FY ${fy}`, t:'s', s:{font:{name:'Calibri',sz:14,bold:true,color:{rgb:C.hdFg}}, fill:fill(C.hdBg), alignment:{horizontal:'left',vertical:'center'}, border:thickBorder()}}
        : {v:'', t:'s', s:{font:font(false,14,C.hdFg), fill:fill(C.hdBg), border:thickBorder()}}
      });
      row++;
      for(let c=0;c<6;c++) data.push({r:row, c, cell: {
        v: c===0 ? `${d.employee_name}  |  ${d.employee_code}  |  PAN: ${d.pan_number||'N/A'}  |  ${(d.regime||'OLD').toUpperCase()} Regime  |  Status: ${(d.status||'draft').toUpperCase()}` : '',
        t:'s', s:{font:{name:'Calibri',sz:10,bold:true,color:{rgb:'1E3A5F'}}, fill:fill('EFF6FF'), alignment:{horizontal:'left',vertical:'center'}, border:border()}
      }});
      row++;
      addBlank();

      addSection('EMPLOYEE DETAILS', '👤');
      addLV('Department', d.department||'—', 'Designation', d.designation||'—');
      addLV('PAN Number', d.pan_number||'—', 'Regime', (d.regime||'old').toUpperCase());
      addLV('Status', (d.status||'draft').toUpperCase(), 'Submitted At', fmtDate(d.submitted_at));
      addLV('HR Comment', d.hr_comment||'—', 'Reviewed At', fmtDate(d.reviewed_at));

      addSection('HRA / RENT', '🏠');
      addLV('Rent Paid Monthly (₹)', n(d.rent_paid_monthly), 'Annual Rent (₹)', n(d.annual_rent));
      addLV('Landlord Name', d.landlord_name||'—', 'Landlord PAN', d.landlord_pan||'—');
      addLV('HRA City Type', d.hra_city_type||'—');
      addProofs('HRA');

      addSection('SEC 80C — INVESTMENTS & SAVINGS', '💰');
      addLV('EPF (₹)', n(d.sec80c_pf), 'PPF (₹)', n(d.sec80c_ppf));
      addLV('LIC Premium (₹)', n(d.sec80c_lic), 'ELSS Mutual Fund (₹)', n(d.sec80c_elss));
      addLV('NSC (₹)', n(d.sec80c_nsc), 'Home Loan Principal (₹)', n(d.sec80c_home_loan));
      addLV('Tuition Fees (₹)', n(d.sec80c_tuition), 'Tax Saving FD (₹)', n(d.sec80c_fd));
      addLV('Other 80C', n(d.sec80c_other));
      addRow(totLabelCell('Total 80C (capped at ₹1,50,000)'), totValCell(n(d.total_80c)),
             {v:'',t:'s',s:{fill:fill(C.totBg),border:thickBorder()}},{v:'',t:'s',s:{fill:fill(C.totBg),border:thickBorder()}},
             {v:'',t:'s',s:{fill:fill(C.totBg),border:thickBorder()}},{v:'',t:'s',s:{fill:fill(C.totBg),border:thickBorder()}});
      addProofs('80C');

      addSection('NPS — 80CCD(1B)', '📈');
      addLV('Employee NPS 80CCD(1B)', n(d.sec80ccd_nps), 'Employer NPS (80CCD2)', n(d.employer_nps));
      addProofs('80CCD');

      addSection('HEALTH INSURANCE — 80D', '🏥');
      addLV('Self & Family (80D)', n(d.sec80d_self), 'Parents (80D)', n(d.sec80d_parents));
      addLV('Senior Citizen Parent', d.sec80d_senior_parent ? 'Yes' : 'No');
      addProofs('80D');

      addSection('HOME LOAN INTEREST — SEC 24B', '🏡');
      addLV('Interest Amount (₹)', n(d.sec24b_home_loan), 'Loan Provider', d.homeloan_provider||'—');
      addLV('Property Address', d.homeloan_address||'—');
      addProofs('HP');

      addSection('EDUCATION LOAN — 80E', '🎓');
      addLV('Interest on Edu Loan', n(d.sec80e_edu_loan));
      addProofs('80E');

      addSection('DONATIONS — 80G', '🤝');
      addLV('Donation Amount', n(d.sec80g_donation), 'Institution', d.sec80g_institution||'—');
      addLV('Institution PAN', d.sec80g_pan||'—', 'Category', d.sec80g_category||'—');
      addProofs('80G');

      addSection('DISABILITY & MEDICAL — 80DD / 80U / 80DDB', '♿');
      addLV('80DD Dependent Disability (₹)', n(d.sec80dd_amount), '80U Self Disability (₹)', n(d.sec80u_amount));
      addLV('80DD Dependent Name', d.sec80dd_dependent||'—', '80DD Relation', d.sec80dd_relation||'—');
      addLV('80DD Disability %', d.sec80dd_pct||'—', '80U Disability %', d.sec80u_pct||'—');
      addLV('80U Category', d.sec80u_category||'—');
      addLV('80DDB Disease Name', d.sec80ddb_disease||'—', '80DDB Amount (₹)', n(d.sec80ddb_amount));
      addLV('80DDB Patient Name', d.sec80ddb_patient||'—', '80DDB Relation', d.sec80ddb_relation||'—');
      addProofs('80DD'); addProofs('80U'); addProofs('80DDB');

      addSection('LEAVE TRAVEL ALLOWANCE (LTA)', '✈️');
      addLV('LTA Amount', n(d.lta_amount), 'Destination', d.lta_destination||'—');
      addLV('Travel Period', d.lta_travel_period||'—');
      addProofs('LTA');

      addSection('PREVIOUS EMPLOYMENT', '🏢');
      addLV('Employer Name', d.prev_employer||'—', 'TAN', d.prev_employer_tan||'—');
      addLV('Period', d.prev_period||'—', 'Gross Salary (₹)', n(d.prev_gross_salary));
      addLV('Taxable Income (₹)', n(d.prev_taxable_income), 'TDS Deducted (₹)', n(d.prev_tds));
      addLV('PF (₹)', n(d.prev_pf));
      addProofs('PREV_EMP');

      addSection('OTHER INCOME', '📊');
      addLV('Savings Bank Interest', n(d.other_savings_int), 'FD Interest', n(d.other_fd_int));
      addLV('Dividend Income', n(d.other_dividend), 'Miscellaneous', n(d.other_misc));
      addLV('Capital Gains', n(d.other_capital_gains));

      // Summary
      addBlank();
      data.push({r:row,c:0,cell:{v:`  📋  SUMMARY — ${(d.regime||'old').toUpperCase()} REGIME`,t:'s',
        s:{font:{name:'Calibri',sz:11,bold:true,color:{rgb:'92400E'}},fill:fill('FEF3C7'),
           alignment:{horizontal:'left',vertical:'center'},border:thickBorder()}}});
      for(let c=1;c<6;c++) data.push({r:row,c,cell:{v:'',t:'s',s:{fill:fill('FEF3C7'),border:thickBorder()}}});
      merges.push({ s:{r:row,c:0}, e:{r:row,c:5} });
      row++;
      addRow(totLabelCell('Total Deductions'), totValCell(n(d.total_deductions)),
             totLabelCell('Estimated Annual Tax'), totValCell(n(d.estimated_tax)),
             {v:'',t:'s',s:{fill:fill(C.totBg),border:thickBorder()}},
             {v:'',t:'s',s:{fill:fill(C.totBg),border:thickBorder()}});
      addRow(totLabelCell('Monthly TDS'), totValCell(n(d.monthly_tds)),
             {v:'',t:'s',s:{fill:fill(C.totBg),border:thickBorder()}},
             {v:'',t:'s',s:{fill:fill(C.totBg),border:thickBorder()}},
             {v:'',t:'s',s:{fill:fill(C.totBg),border:thickBorder()}},
             {v:'',t:'s',s:{fill:fill(C.totBg),border:thickBorder()}});

      const ws = {};
      const maxR = row;
      for (const { r, c, cell } of data) { ws[XLSX.utils.encode_cell({ r, c })] = cell; }
      ws['!ref']   = XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:maxR,c:5} });
      ws['!cols']  = [{ wch:32 },{ wch:20 },{ wch:32 },{ wch:20 },{ wch:14 },{ wch:52 }];
      ws['!merges']= merges;
      ws['!rows']  = []; ws['!rows'][0] = { hpt:28 }; ws['!rows'][1] = { hpt:20 };

      const sheetName = `${d.employee_code} - ${d.employee_name}`
        .replace(/[:\\\\/\?\*\[\]]/g, '').substring(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }

    const buf   = XLSX.write(wb, { type:'buffer', bookType:'xlsx', cellStyles:true });
    const fname = `IT_Declaration_${fy.replace('-','_')}${status?'_'+status:''}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(buf);
  } catch (err) {
    console.error('[exportExcel]', err.message, err.stack);
    res.status(500).json({ success:false, message:'Export failed: ' + err.message });
  }
};


// ── Payroll integration: monthly TDS on salary ───────────────────────────────
// Used by payrollController when building the monthly payroll template.
//   Projected annual income = previous-employer salary
//                           + salary already paid this FY (payroll table; catch-up at structure gross if a month is missing)
//                           + THIS month's earned gross (paid-days based)
//                           + structure gross x remaining months
//   Annual tax   = same engine as the IT Declaration (regime chosen by the employee, New Regime if none)
//   This month's TDS = (annual tax - previous-employer TDS - TDS already deducted this FY) / months left in FY
exports.estimateMonthlyTds = async (empId, month, year, earnedGrossThisMonth) => {
  const fy      = month >= 4 ? `${year}-${String(year + 1).slice(2)}` : `${year - 1}-${String(year).slice(2)}`;
  const fyStart = month >= 4 ? year : year - 1;
  const cfg     = await loadConfig(fy);
  if (!cfg.new_slabs) return { tds: 0, note: `No tax config for FY ${fy}` };

  const salRes = await db.query(
    `SELECT ess.gross_salary, ess.basic, ess.hra, ess.tax_regime, e.date_of_birth, e.joining_date
     FROM employees e LEFT JOIN employee_salary_structure ess ON ess.employee_id = e.id
     WHERE e.id=$1`, [empId]);
  const sal = salRes.rows[0];
  const structGross = parseFloat(sal && sal.gross_salary) || 0;
  if (!sal || structGross <= 0) return { tds: 0, note: 'No salary structure' };

  const declRes = await db.query(
    `SELECT * FROM it_declarations WHERE employee_id=$1 AND financial_year=$2`, [empId, fy]);
  const d = declRes.rows[0] || {};
  if (d.house_properties && typeof d.house_properties === 'string') {
    try { d.house_properties = JSON.parse(d.house_properties); } catch { d.house_properties = []; }
  }
  // Regime: the employee's own IT Declaration choice wins; otherwise the regime HR set on the
  // salary structure; otherwise New Regime (default for everyone).
  const regime   = d.id ? (d.regime === 'old' ? 'old' : 'new') : (sal.tax_regime === 'old' ? 'old' : 'new');
  const prevSal  = parseFloat(d.prev_gross_salary || 0);
  const prevTds  = parseFloat(d.prev_tds || 0);
  // capital gains are taxed at special rates and are not part of salary TDS
  const otherInc = parseFloat(d.other_savings_int || 0) + parseFloat(d.other_fd_int || 0) +
                   parseFloat(d.other_dividend || 0) + parseFloat(d.other_misc || 0);

  const histRes = await db.query(
    `SELECT month, year, gross_salary, tds FROM payroll
     WHERE employee_id=$1 AND ((year=$2 AND month>=4) OR (year=$3 AND month<=3))`,
    [empId, fyStart, fyStart + 1]);
  const hist = {}; histRes.rows.forEach(r => { hist[`${r.year}-${r.month}`] = r; });

  // Joining month as (year, month) — parsed from the calendar date so server timezone can't shift it
  let jY = 0, jM = 0;
  if (sal.joining_date) {
    if (sal.joining_date instanceof Date) { jY = sal.joining_date.getFullYear(); jM = sal.joining_date.getMonth() + 1; }
    else { const mt = String(sal.joining_date).match(/^(\d{4})-(\d{2})/); if (mt) { jY = +mt[1]; jM = +mt[2]; } }
  }
  const joinedBy = (y, m) => !jY || (y * 12 + m) >= (jY * 12 + jM);

  let projected = 0, tdsPaid = 0, monthsLeft = 0;   // prevSal is added inside computeRegimeTax — don't add it twice
  for (let i = 0; i < 12; i++) {
    const m = ((3 + i) % 12) + 1;                 // 4,5,...,12,1,2,3
    const y = m >= 4 ? fyStart : fyStart + 1;
    const key = `${y}-${m}`;
    const ord = y * 12 + m, cur = year * 12 + month;
    if (ord < cur) {                               // past month
      if (!joinedBy(y, m)) { /* before joining — not this employer's income, even if a stray payroll row exists */ }
      else if (hist[key]) { projected += parseFloat(hist[key].gross_salary) || 0; tdsPaid += parseFloat(hist[key].tds) || 0; }
      else projected += structGross;   // no payroll row: assume full salary (catch-up TDS)
    } else if (ord === cur) {                      // this month: actual earned (paid-days based)
      projected += earnedGrossThisMonth; monthsLeft += 1;
    } else {                                       // future month
      if (joinedBy(y, m)) projected += structGross; monthsLeft += 1;
    }
  }

  const sal2 = { ...sal, gross_salary: projected / 12, age_group: getAgeGroup(sal.date_of_birth, fy) };
  const computed = computeRegimeTax(regime, d, cfg, sal2, prevSal, otherInc);
  const remaining = Math.max(0, computed.tax - prevTds - tdsPaid);
  let tds = monthsLeft > 0 ? Math.round(remaining / monthsLeft) : 0;
  tds = Math.max(0, Math.min(tds, Math.round(earnedGrossThisMonth)));
  // Components so the Excel template can recompute TDS live when HR edits days / bonus:
  //   taxable = base_income + this month's gross - deductions ; TDS = (annual tax - already_deducted) / months_left
  const totalIncome = projected + prevSal + otherInc;
  const out = { base_income: Math.round(totalIncome - earnedGrossThisMonth), deductions: Math.round(Math.max(0, totalIncome - computed.taxableIncome)),
                already_deducted: Math.round(prevTds + tdsPaid),
                tds, fy, regime, joined: jY ? `${jY}-${String(jM).padStart(2,'0')}` : null, has_declaration: !!d.id, projected_gross: Math.round(projected), prev_salary: Math.round(prevSal),
                annual_tax: computed.tax, taxable_income: Math.round(computed.taxableIncome), tds_paid_ytd: tdsPaid, months_left: monthsLeft };
  console.log('[TDS estimate]', empId, JSON.stringify(out));
  return out;
};


// ── Slab parameters for the payroll template's live TDS formulas ─────────────
// Slabs are flattened to (threshold, incremental rate) pairs so Excel can compute
// tax with one SUMPRODUCT:  tax = SUM( (T > threshold) * (T - threshold) * step )
exports.getTdsSheetParams = async (fy) => {
  const cfg = await loadConfig(fy);
  const flat = (str) => {
    const sl = parseSlabs(str);
    let prev = 0;
    return sl.map(x => { const lo = x.low > 0 ? x.low - 1 : 0; const step = (x.rate - prev) / 100; prev = x.rate; return { lo, step }; });
  };
  return {
    fy,
    newSlabs: flat(cfg.new_slabs || ''),
    oldSlabs: flat(cfg.old_slabs || DEFAULT_SLABS.old_slabs),
    rebateNew: cfgN(cfg, 'rebate_87a_new', 1200000), rebateNewAmt: cfgN(cfg, 'rebate_87a_new_amt', 60000),
    rebateOld: cfgN(cfg, 'rebate_87a_old', 500000),  rebateOldAmt: cfgN(cfg, 'rebate_87a_old_amt', 12500),
    cess: cfgN(cfg, 'cess_rate', 4) / 100,
  };
};
