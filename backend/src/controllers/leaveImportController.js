// leaveImportController.js
// Import leave data from external system Excel exports:
//   POST /leave/import/status  — LeaveStatusReport  → leave_requests
//   POST /leave/import/summary — LeaveSummaryReport → leave_balances

const db     = require('../config/db');
const XLSX   = require('xlsx');
const multer = require('multer');

exports.uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(xlsx|xls)$/.test(file.originalname.toLowerCase())) cb(null, true);
    else cb(new Error('Only Excel files allowed'));
  }
}).single('file');

// ── Helpers ──────────────────────────────────────────────────────────────────

const LEAVE_TYPE_MAP = {
  'earned leave':          'EL',
  'sick or casual leave':  'CL',
  'maternity leave':       'ML',
  'sick leave':            'SL',
  'casual leave':          'CL',
};

const STATUS_MAP = {
  'leave approved':  'approved',
  'leave initiated': 'pending',
  'leave rejected':  'rejected',
};

// Parse dd-Mon-yyyy or dd-mm-yyyy → ISO YYYY-MM-DD
function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // dd-Mon-yyyy e.g. 05-Feb-2026
  const m1 = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m1) {
    const months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
    const mo = months[m1[2].toLowerCase()];
    if (!mo) return null;
    return `${m1[3]}-${String(mo).padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
  }
  // dd-mm-yyyy
  const m2 = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2,'0')}-${m2[1].padStart(2,'0')}`;
  // already ISO
  const m3 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m3) return `${m3[1]}-${m3[2]}-${m3[3]}`;
  return null;
}

// From/To Session values: 1=first-half 2=second-half/full-day 4=full-day
// Combos: 1/2=full 1/1=first-half 2/2=second-half 1/4=full(treat as full)
function parseSessions(from, to) {
  const f = parseInt(from, 10), t = parseInt(to, 10);
  if (f === 1 && t === 1) return { is_half_day: true,  half_day_type: 'first'  };
  if (f === 2 && t === 2) return { is_half_day: true,  half_day_type: 'second' };
  return                         { is_half_day: false, half_day_type: null     };
}

// ── Status Report Import ──────────────────────────────────────────────────────
// Columns: SL No | Employee ID | Employee Name | Leave Type | Applied Date |
//          From Date | To Date | From Session | To Session | No of Days |
//          Reason | Status
exports.importStatusReport = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success:false, message:'No file uploaded' });

    const wb   = XLSX.read(req.file.buffer, { type:'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'' });
    const header = (rows[0] || []).map(h => String(h).trim().toLowerCase());
    const data   = rows.slice(1).filter(r => r[0]);

    const col = k => header.indexOf(k);
    const iEmpId    = col('employee id');
    const iLvType   = col('leave type');
    const iApplied  = col('applied date');
    const iFrom     = col('from date');
    const iTo       = col('to date');
    const iFromSess = col('from session');
    const iToSess   = col('to session');
    const iDays     = col('no of days');
    const iReason   = col('reason');
    const iStatus   = col('status');

    // Load leave types
    const ltRes = await db.query(`SELECT id, code FROM leave_types WHERE is_active=true`);
    const ltByCode = {};
    ltRes.rows.forEach(r => { ltByCode[r.code] = r.id; });

    // Load employee_id by employee_code
    const empRes = await db.query(`SELECT id, employee_code FROM employees`);
    const empByCode = {};
    empRes.rows.forEach(r => { empByCode[r.employee_code.trim()] = r.id; });

    const inserted = [], skipped = [], flagged = [];

    for (const row of data) {
      const empCode = String(row[iEmpId] || '').trim();
      const lvName  = String(row[iLvType] || '').trim().toLowerCase();
      const lvCode  = LEAVE_TYPE_MAP[lvName];
      const status  = STATUS_MAP[String(row[iStatus] || '').trim().toLowerCase()];
      const fromD   = parseDate(row[iFrom]);
      const toD     = parseDate(row[iTo]);
      const applD   = parseDate(row[iApplied]);
      const days    = parseFloat(row[iDays]) || 0;
      const reason  = String(row[iReason] || '').trim();

      const fromSess = row[iFromSess], toSess = row[iToSess];
      const unusualSess = !([`${fromSess}/${toSess}`].every(s => ['1/2','1/1','2/2','1/4'].includes(s)));

      // Flag issues
      const issues = [];
      if (!empByCode[empCode]) issues.push(`Employee ${empCode} not found in HRMS`);
      if (!lvCode)             issues.push(`Unknown leave type: "${row[iLvType]}"`);
      if (!lvCode || !ltByCode[lvCode]) issues.push(`Leave type ${lvCode} not configured in HRMS`);
      if (!fromD || !toD)      issues.push(`Invalid date: from="${row[iFrom]}" to="${row[iTo]}"`);
      if (!status)             issues.push(`Unknown status: "${row[iStatus]}"`);
      if (String(fromSess)+'/'+String(toSess) === '1/4') issues.push(`Unusual session combo 1/4 — treated as full day`);

      if (issues.length) {
        flagged.push({ employee: empCode, from: row[iFrom], issues });
        continue;
      }

      const empId  = empByCode[empCode];
      const ltId   = ltByCode[lvCode];
      const { is_half_day, half_day_type } = parseSessions(fromSess, toSess);

      // Skip exact duplicates
      const dup = await db.query(
        `SELECT id FROM leave_requests WHERE employee_id=$1 AND leave_type_id=$2 AND from_date=$3 AND to_date=$4 LIMIT 1`,
        [empId, ltId, fromD, toD]
      );
      if (dup.rows.length) { skipped.push({ employee:empCode, from:fromD, to:toD, reason:'duplicate' }); continue; }

      await db.query(
        `INSERT INTO leave_requests
           (employee_id, leave_type_id, from_date, to_date, days_requested, reason,
            status, is_half_day, half_day_type, created_at, actioned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [empId, ltId, fromD, toD, days, reason, status, is_half_day, half_day_type,
         applD || fromD, status === 'approved' ? applD || fromD : null]
      );
      inserted.push({ employee:empCode, from:fromD, to:toD, type:lvCode, status });
    }

    res.json({
      success: true,
      summary: { total: data.length, inserted: inserted.length, skipped: skipped.length, flagged: flagged.length },
      flagged,
      skipped: skipped.slice(0, 20),
    });
  } catch (err) {
    console.error('leaveImport statusReport error:', err);
    res.status(500).json({ success:false, message: err.message });
  }
};

// ── Summary Report Import ─────────────────────────────────────────────────────
// Columns: SL No | Employee ID | Employee Name | Leave Type | Date of Joining |
//          Carried Over Previous Year | Leaves Encashed | Leaves Credited |
//          Leave Granted | Leave Applied | Leave Availed | Leaves Lapsed |
//          Leaves Available | Deducted | Credit Comments
exports.importSummaryReport = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success:false, message:'No file uploaded' });

    const year = parseInt(req.body.year || new Date().getFullYear(), 10);
    const wb   = XLSX.read(req.file.buffer, { type:'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'' });
    const header = (rows[0] || []).map(h => String(h).trim().toLowerCase());
    const data   = rows.slice(1).filter(r => r[0]);

    const col = k => header.indexOf(k);
    const iEmpId    = col('employee id');
    const iLvType   = col('leave type');
    const iCarried  = col('carried over previous year');
    const iCredited = col('leaves credited');
    const iGranted  = col('leave granted');
    const iAvailed  = col('leave availed');
    const iLapsed   = col('leaves lapsed');
    const iAvail    = col('leaves available');

    // Load leave types
    const ltRes = await db.query(`SELECT id, code FROM leave_types WHERE is_active=true`);
    const ltByCode = {};
    ltRes.rows.forEach(r => { ltByCode[r.code] = r.id; });

    // Load employees
    const empRes = await db.query(`SELECT id, employee_code FROM employees`);
    const empByCode = {};
    empRes.rows.forEach(r => { empByCode[r.employee_code.trim()] = r.id; });

    const upserted = [], flagged = [];

    for (const row of data) {
      const empCode = String(row[iEmpId] || '').trim();
      const lvName  = String(row[iLvType] || '').trim().toLowerCase();
      const lvCode  = LEAVE_TYPE_MAP[lvName];

      const issues = [];
      if (!empByCode[empCode]) issues.push(`Employee ${empCode} not found in HRMS`);
      if (!lvCode)             issues.push(`Unknown leave type: "${row[iLvType]}"`);
      if (!lvCode || !ltByCode[lvCode]) issues.push(`Leave type ${lvCode} not configured in HRMS`);

      if (issues.length) { flagged.push({ employee:empCode, leaveType:row[iLvType], issues }); continue; }

      const empId  = empByCode[empCode];
      const ltId   = ltByCode[lvCode];
      const carry  = parseFloat(row[iCarried])  || 0;
      const alloc  = parseFloat(row[iCredited]) || 0;  // Leaves Credited = what was given this year
      const granted= parseFloat(row[iGranted])  || 0;
      const used   = parseFloat(row[iAvailed])  || 0;  // Availed = actually taken
      const avail  = parseFloat(row[iAvail])    || 0;

      await db.query(
        `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated, carry_forward, used, pending, available)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7)
         ON CONFLICT (employee_id, leave_type_id, year)
         DO UPDATE SET allocated=$4, carry_forward=$5, used=$6, available=$7, pending=0`,
        [empId, ltId, year, alloc + granted, carry, used, avail]
      );
      upserted.push({ employee: empCode, leaveType: lvCode, year, allocated: alloc+granted, used, available: avail });
    }

    res.json({
      success: true,
      summary: { total: data.length, upserted: upserted.length, flagged: flagged.length },
      flagged,
    });
  } catch (err) {
    console.error('leaveImport summaryReport error:', err);
    res.status(500).json({ success:false, message: err.message });
  }
};
