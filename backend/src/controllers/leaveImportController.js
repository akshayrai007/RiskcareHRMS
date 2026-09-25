// leaveImportController.js — Import leave requests from Excel template
// POST /leave/import/requests
// Template columns: Employee ID | Employee Name | Leave Type Code | From Date |
//   To Date | Applied Date | Days | Reason | Status | Half Day (Yes/No) | Half Day Type

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

exports.importLeaveRequests = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success:false, message:'No file uploaded' });

    const wb   = XLSX.read(req.file.buffer, { type:'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval:'' });

    // Load leave types by code
    const ltRes = await db.query(`SELECT id, code FROM leave_types WHERE is_active=true`);
    const ltByCode = {};
    ltRes.rows.forEach(r => { ltByCode[r.code.trim().toUpperCase()] = r.id; });

    // Load employees by code
    const empRes = await db.query(`SELECT id, employee_code FROM employees`);
    const empByCode = {};
    empRes.rows.forEach(r => { empByCode[(r.employee_code||'').trim().toUpperCase()] = r.id; });

    let inserted = 0, skipped = 0;
    const errors = [], flagged = [];

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      for (const row of rows) {
        const empCode = String(row['Employee ID'] || '').trim().toUpperCase();
        const lvCode  = String(row['Leave Type Code'] || '').trim().toUpperCase();
        const fromD   = String(row['From Date'] || '').trim();
        const toD     = String(row['To Date'] || '').trim();
        const applD   = String(row['Applied Date'] || '').trim() || fromD;
        const days    = parseFloat(row['Days']) || 0;
        const reason  = String(row['Reason'] || '').trim();
        const status  = String(row['Status'] || 'pending').trim().toLowerCase();
        const isHalf  = String(row['Half Day (Yes/No)'] || '').trim().toLowerCase() === 'yes';
        const halfType= String(row['Half Day Type (First Half/Second Half)'] || '').trim().toLowerCase()
                          .replace('first half','first').replace('second half','second') || null;

        const issues = [];
        if (!empByCode[empCode]) issues.push(`Employee "${empCode}" not found`);
        if (!ltByCode[lvCode])   issues.push(`Leave type "${lvCode}" not found`);
        if (!fromD || !toD)      issues.push('Missing From/To Date');

        if (issues.length) {
          flagged.push({ row: empCode, issues });
          skipped++;
          continue;
        }

        // Skip exact duplicates
        const dup = await client.query(
          `SELECT id FROM leave_requests WHERE employee_id=$1 AND leave_type_id=$2 AND from_date=$3 AND to_date=$4 LIMIT 1`,
          [empByCode[empCode], ltByCode[lvCode], fromD, toD]
        );
        if (dup.rows.length) { skipped++; continue; }

        await client.query(
          `INSERT INTO leave_requests
             (employee_id, leave_type_id, from_date, to_date, days_requested, reason,
              status, is_half_day, half_day_type, created_at, actioned_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            empByCode[empCode], ltByCode[lvCode], fromD, toD, days, reason, status,
            isHalf, isHalf ? halfType : null,
            applD || fromD,
            status === 'approved' ? applD || fromD : null,
          ]
        );
        inserted++;
      }

      await client.query('COMMIT');
      res.json({
        success: true,
        message: `Inserted ${inserted}, skipped ${skipped} (duplicates + errors)`,
        summary: { total: rows.length, inserted, skipped, flagged: flagged.length },
        flagged,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('leaveImport requests error:', err);
    res.status(500).json({ success:false, message: err.message });
  }
};
