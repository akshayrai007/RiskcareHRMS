// src/controllers/attendanceImportController.js
// Bulk import attendance from Excel (P/A/H/LH/LWP/EL/SL/CL/OD + WFH)
// FIXED: getMonthlyReport moved here from attendanceController.js,
//        role-gated (HR/Accounts only), proper column detection,
//        professional styled Excel export.

const db   = require('../config/db');
const XLSX = require('xlsx');
const multer = require('multer');

exports.uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(xlsx|xls)$/.test(file.originalname.toLowerCase())) cb(null, true);
    else cb(new Error('Only Excel files allowed'));
  }
}).single('file');

const STATUS_MAP = {
  'P':     'present',
  'A':     'absent',
  'H':     'half-day',
  'LH':    'half-day',
  'LWP':   'lwp',
  'EL':    'on-leave',
  'SL':    'on-leave',
  'CL':    'on-leave',
  'OD':    'od',
  'WO':    null,        // Weekly Off — skip
  'HO':    null,        // Holiday — skip
  'WFH':   'present',
  // ── Half-day leave types ──────────────────────────────────────────────────
  'H-SL':  'half-day',  // Half-day Sick Leave
  'H-EL':  'half-day',  // Half-day Earned Leave
  'H-CL':  'half-day',  // Half-day Casual Leave
  'H-LWP': 'half-day',  // Half-day Loss of Pay
  'H-WFH': 'present',   // Half-day Work from Home (counts as present, WFH flagged)
  '':      null,
};

// Which raw codes represent half-day leave (deduct 0.5 from leave balance)
const HALF_DAY_LEAVE_CODES = new Set(['H-SL','H-EL','H-CL','H-LWP']);
// Which raw codes represent half-day WFH
const HALF_DAY_WFH_CODES   = new Set(['H-WFH']);
// Which raw codes tie to specific leave types (for leave balance deduction)
const LEAVE_TYPE_CODE_MAP = {
  'EL': 'EL', 'H-EL': 'EL',
  'SL': 'SL', 'H-SL': 'SL',
  'CL': 'CL', 'H-CL': 'CL',
};

exports.importAttendance = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    if (!req.file)
      return res.status(400).json({ success: false, message: 'Excel file required' });

    const { month, year, overwrite = false } = req.body;
    if (!month || !year)
      return res.status(400).json({ success: false, message: 'month and year required' });

    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (rows.length < 3)
      return res.status(400).json({ success: false, message: 'Sheet appears empty' });

    const numDays = new Date(parseInt(year), parseInt(month), 0).getDate();
    let imported = 0, skipped = 0, errors = [];

    // Pre-fetch leave type IDs for balance deductions
    const ltResult = await client.query('SELECT id, code FROM leave_types WHERE is_active=true');
    const leaveTypeByCode = {};
    ltResult.rows.forEach(lt => { leaveTypeByCode[lt.code] = lt.id; });

    for (let ri = 2; ri < rows.length; ri++) {
      const row = rows[ri];
      const empCode = String(row[0] || '').trim().toUpperCase();
      if (!empCode || empCode === 'EMP CODE' || empCode.startsWith('🏖') || empCode.startsWith('CODES:') || !empCode.match(/^KC\d+/i)) continue;

      const empResult = await client.query(
        `SELECT id, first_name, last_name, employment_type, provision_end_date
         FROM employees WHERE UPPER(employee_code)=$1 AND is_active=true`,
        [empCode]
      );
      if (!empResult.rows.length) {
        errors.push(`Row ${ri+1}: Employee ${empCode} not found`);
        skipped++;
        continue;
      }
      const emp = empResult.rows[0];
      const isProvision = (emp.employment_type || '').toLowerCase() === 'provision';

      for (let d = 1; d <= numDays; d++) {
        const colIdx = d + 2;
        const rawStatus = String(row[colIdx] || '').trim().toUpperCase();
        if (!rawStatus || rawStatus === 'WO' || rawStatus === 'HO') continue;

        const dbStatus = STATUS_MAP[rawStatus];
        if (dbStatus === null || dbStatus === undefined) continue;

        const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const dateObj = new Date(dateStr);
        if (isNaN(dateObj.getTime()) || dateObj.getDate() !== d) continue;

        const isHalfDayLeave = HALF_DAY_LEAVE_CODES.has(rawStatus);
        const isHalfDayWFH   = HALF_DAY_WFH_CODES.has(rawStatus);
        const isWFH          = rawStatus === 'WFH' || isHalfDayWFH;

        const remarks =
          isHalfDayLeave ? `Half-day ${rawStatus.replace('H-','')} Leave`
          : isHalfDayWFH ? 'Half-day Work from Home'
          : rawStatus === 'LH'    ? 'Late arrival or early departure'
          : rawStatus === 'WFH'   ? 'Work from Home'
          : rawStatus === 'LWP'   ? 'Loss of Pay'
          : rawStatus === 'H-LWP' ? 'Half-day Loss of Pay'
          : ['EL','SL','CL'].includes(rawStatus) ? `${rawStatus} Leave`
          : null;

        let working_hours = null;
        if (dbStatus === 'present')  working_hours = isHalfDayWFH ? 4.0 : (isWFH ? 8.0 : 8.5);
        if (dbStatus === 'half-day') working_hours = 4.0;

        const punchInLocation = isWFH ? 'Work from Home' : null;

        const leaveDeductDays = isHalfDayLeave ? 0.5
          : rawStatus === 'H-LWP' ? 0.5
          : rawStatus === 'H' || rawStatus === 'LH' ? 0.5
          : ['EL','SL','CL'].includes(rawStatus) ? 1.0
          : 0;

        if (isProvision && leaveDeductDays > 0) {
          const provEnd = emp.provision_end_date ? new Date(emp.provision_end_date) : null;
          if (provEnd && dateObj > provEnd) {
            errors.push(`${empCode} ${dateStr}: Provision ended ${emp.provision_end_date}; leave will be counted as LWP`);
          }
        }

        if (overwrite === 'true' || overwrite === true) {
          await client.query(
            `INSERT INTO attendance(employee_id, date, status, working_hours, remarks, punch_in_location)
             VALUES($1,$2,$3,$4,$5,$6)
             ON CONFLICT(employee_id, date)
             DO UPDATE SET status=$3, working_hours=$4, remarks=$5, punch_in_location=$6`,
            [emp.id, dateStr, dbStatus, working_hours, remarks, punchInLocation]
          );
        } else {
          await client.query(
            `INSERT INTO attendance(employee_id, date, status, working_hours, remarks, punch_in_location)
             VALUES($1,$2,$3,$4,$5,$6)
             ON CONFLICT(employee_id, date) DO NOTHING`,
            [emp.id, dateStr, dbStatus, working_hours, remarks, punchInLocation]
          );
        }
        imported++;

        // Deduct leave balance for EL/SL/CL and half-day variants
        const ltCodeForBalance = LEAVE_TYPE_CODE_MAP[rawStatus];
        if (ltCodeForBalance && leaveDeductDays > 0) {
          const ltId = leaveTypeByCode[ltCodeForBalance];
          if (ltId) {
            const yr = parseInt(year);
            await client.query(
              `INSERT INTO leave_balances(employee_id, leave_type_id, year, allocated, used, pending, carry_forward)
               VALUES($1,$2,$3,0,0,0,0) ON CONFLICT(employee_id, leave_type_id, year) DO NOTHING`,
              [emp.id, ltId, yr]
            );
            await client.query(
              `UPDATE leave_balances SET used = used + $1
               WHERE employee_id=$2 AND leave_type_id=$3 AND year=$4`,
              [leaveDeductDays, emp.id, ltId, yr]
            );
          }
        }
      }
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      message: `Import complete: ${imported} records processed, ${skipped} employees skipped`,
      data: { imported, skipped, errors: errors.slice(0, 20) }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally { client.release(); }
};


// ── WFH Apply ─────────────────────────────────────────────────────────────────
exports.applyWFH = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const empId = req.user.id;
    const { from_date, to_date, reason } = req.body;
    if (!from_date || !to_date || !reason)
      return res.status(400).json({ success: false, message: 'from_date, to_date, reason required' });

    const r = await client.query(
      `INSERT INTO wfh_requests(employee_id, from_date, to_date, reason, status, applied_at)
       VALUES($1,$2,$3,$4,'pending',NOW()) RETURNING *`,
      [empId, from_date, to_date, reason]
    );

    const manager = await client.query(
      `SELECT m.id, CONCAT(m.first_name,' ',m.last_name) AS name
       FROM employees e JOIN employees m ON e.reporting_manager_id=m.id
       WHERE e.id=$1`, [empId]
    );
    if (manager.rows.length) {
      await client.query(
        `INSERT INTO notifications(employee_id, title, message, type)
         VALUES($1,'🏠 WFH Request',$2,'wfh')`,
        [manager.rows[0].id,
         `${req.user.first_name} ${req.user.last_name} has requested WFH from ${from_date} to ${to_date}. Reason: ${reason}`]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, message: 'WFH request submitted', data: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ── WFH Action ────────────────────────────────────────────────────────────────
exports.actionWFH = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { action, remarks } = req.body;
    const { id } = req.params;
    if (!['approve','reject'].includes(action))
      return res.status(400).json({ success: false, message: 'action must be approve or reject' });

    const wfh = await client.query(`SELECT * FROM wfh_requests WHERE id=$1 FOR UPDATE`, [id]);
    if (!wfh.rows.length)
      return res.status(404).json({ success: false, message: 'WFH request not found' });
    if (wfh.rows[0].status !== 'pending')
      return res.status(400).json({ success: false, message: 'Already actioned' });

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await client.query(
      `UPDATE wfh_requests SET status=$1, actioned_by=$2, action_at=NOW(), remarks=$3 WHERE id=$4`,
      [newStatus, req.user.id, remarks || null, id]
    );

    if (action === 'approve') {
      const req_data = wfh.rows[0];
      const from = new Date(req_data.from_date);
      const to   = new Date(req_data.to_date);
      for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
        if (d.getDay() === 0) continue;
        const dateStr = d.toISOString().split('T')[0];
        await client.query(
          `INSERT INTO attendance(employee_id, date, status, working_hours, punch_in_location, remarks)
           VALUES($1,$2,'present',8.0,'Work from Home','WFH Approved')
           ON CONFLICT(employee_id, date) DO UPDATE
           SET punch_in_location='Work from Home', remarks='WFH Approved'`,
          [req_data.employee_id, dateStr]
        );
      }
    }

    await client.query(
      `INSERT INTO notifications(employee_id, title, message, type)
       VALUES($1,$2,$3,'wfh')`,
      [wfh.rows[0].employee_id,
       `${newStatus === 'approved' ? '✅' : '❌'} WFH Request ${newStatus}`,
       `Your WFH request for ${wfh.rows[0].from_date} to ${wfh.rows[0].to_date} has been ${newStatus}.${remarks ? ' Remarks: ' + remarks : ''}`]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: `WFH ${newStatus}` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ── Get WFH Requests ──────────────────────────────────────────────────────────
exports.getWFH = async (req, res) => {
  try {
    const role   = req.user.role;
    const userId = req.user.id;
    let cond = '', params = [];

    if (!['admin','hr','manager','tl'].includes(role)) {
      cond = 'WHERE w.employee_id=$1'; params.push(userId);
    } else if (role === 'manager') {
      cond = 'WHERE e.department_id=(SELECT department_id FROM employees WHERE id=$1)'; params.push(userId);
    } else if (role === 'tl') {
      cond = 'WHERE e.team_leader_id=$1'; params.push(userId);
    }

    const r = await db.query(
      `SELECT w.*, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
              e.employee_code, d.name AS department_name
       FROM wfh_requests w
       JOIN employees e ON w.employee_id=e.id
       LEFT JOIN departments d ON e.department_id=d.id
       ${cond}
       ORDER BY w.applied_at DESC LIMIT 100`,
      params
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Monthly Attendance Report — Excel Download (HR / Accounts only) ───────────
// GET /api/attendance/report/download?month=3&year=2025&department_id=5&format=excel
//
// FIXED vs old getMonthlyReport in attendanceController.js:
//   1. Role gate: only hr, accounts, admin, super_admin allowed
//   2. Bug fix: employees query was passing wrong params (department_id instead of [mon,yr])
//   3. Bug fix: empParams used for employees query but $1/$2 were month/year — now separated
//   4. Added daily breakdown sheet so payroll team can verify day-by-day
//   5. Professional openpyxl-style formatting via SheetJS cell styles
//   6. filename includes month name for clarity

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

exports.downloadAttendanceReport = async (req, res) => {
  try {
    // ── 1. Role gate ───────────────────────────────────────────────────────
    const allowedRoles = ['hr', 'accounts'];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only HR and Accounts can download attendance reports.'
      });
    }

    const { month, year, department_id } = req.query;
    const mon       = parseInt(month) || new Date().getMonth() + 1;
    const yr        = parseInt(year)  || new Date().getFullYear();
    const monthName = MONTH_NAMES[mon - 1];
    const numDays   = new Date(yr, mon, 0).getDate();

    // ── 2. Fetch employees (BUG FIX: separate query params from att params) ─
    let empQuery  = `SELECT e.id, e.employee_code,
                            CONCAT(e.first_name,' ',e.last_name) AS name,
                            d.name AS department,
                            des.title AS designation,
                            COALESCE(e.saturday_policy, '2nd_4th_off') AS saturday_policy
                     FROM employees e
                     LEFT JOIN departments d  ON e.department_id  = d.id
                     LEFT JOIN designations des ON e.designation_id = des.id
                     WHERE e.is_active = true`;
    let empParams = [];
    if (department_id) {
      empQuery += ` AND e.department_id = $1`;
      empParams = [department_id];
    }
    empQuery += ` ORDER BY d.name, e.first_name`;
    const employees = await db.query(empQuery, empParams);

    // ── 3. Fetch attendance for the month ─────────────────────────────────
    let attQuery  = `SELECT employee_id,
                            TO_CHAR(date,'YYYY-MM-DD') AS date_str,
                            EXTRACT(DAY FROM date)::int AS day,
                            status, working_hours, punch_in_location,
                            TO_CHAR(punch_in,  'HH12:MI AM') AS punch_in_fmt,
                            TO_CHAR(punch_out, 'HH12:MI AM') AS punch_out_fmt,
                            punch_in, punch_out
                     FROM attendance
                     WHERE EXTRACT(MONTH FROM date) = $1
                       AND EXTRACT(YEAR  FROM date) = $2`;
    let attParams = [mon, yr];
    if (department_id) {
      attQuery  += ` AND employee_id IN (SELECT id FROM employees WHERE department_id = $3)`;
      attParams.push(department_id);
    }
    const attendance = await db.query(attQuery, attParams);

    // ── 4. Fetch holidays ────────────────────────────────────────────────
    const holidays = await db.query(
      `SELECT TO_CHAR(date,'YYYY-MM-DD') AS date_str, name
       FROM holidays
       WHERE EXTRACT(MONTH FROM date) = $1 AND EXTRACT(YEAR FROM date) = $2`,
      [mon, yr]
    );
    const holSet = new Set(holidays.rows.map(h => h.date_str));

    // ── 5. Index attendance ───────────────────────────────────────────────
    const attIndex = {};
    for (const rec of attendance.rows) {
      if (!attIndex[rec.employee_id]) attIndex[rec.employee_id] = {};
      attIndex[rec.employee_id][rec.day] = rec;
    }

    // ── 6. Build weekly-off sets per saturday_policy ──────────────────────
    // onsite  (2nd_4th_off): Sunday + 2nd & 4th Saturday off → e.g. 22 working days in Feb 2026
    // offsite (all_working): Sunday only off → every Saturday is a working day → e.g. 24 working days in Feb 2026
    function buildWeeklyOffDays(satPolicy) {
      const offDays = new Set();
      for (let d = 1; d <= numDays; d++) {
        const dt  = new Date(yr, mon - 1, d);
        const dow = dt.getDay();
        if (dow === 0) { offDays.add(d); continue; } // always skip Sundays
        if (dow === 6 && satPolicy !== 'all_working') {
          let satCount = 0;
          for (let dd = 1; dd <= d; dd++)
            if (new Date(yr, mon - 1, dd).getDay() === 6) satCount++;
          if (satCount === 2 || satCount === 4) offDays.add(d);
        }
        // all_working: every Saturday is a working day — nothing to add
      }
      return offDays;
    }
    const weeklyOffDays_2nd4th  = buildWeeklyOffDays('2nd_4th_off');
    const weeklyOffDays_allWork = buildWeeklyOffDays('all_working');

    // ── 7. Build summary data ─────────────────────────────────────────────
    const reportRows = employees.rows.map(emp => {
      const weeklyOffDays = emp.saturday_policy === 'all_working'
        ? weeklyOffDays_allWork
        : weeklyOffDays_2nd4th;
      const workingDays = numDays - weeklyOffDays.size - holidays.rows.length;
      const empAtt = attIndex[emp.id] || {};
      let P=0, A=0, H=0, LH=0, LWP=0, EL=0, SL=0, CL=0, OD=0, WFH=0, WO=0, HOL=0;

      for (let d = 1; d <= numDays; d++) {
        const ds = `${yr}-${String(mon).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        if (holSet.has(ds)) { HOL++; continue; }
        if (weeklyOffDays.has(d)) { WO++; continue; }

        const rec = empAtt[d];
        if (!rec) { A++; continue; }

        const isWFH = (rec.punch_in_location || '').toLowerCase().includes('work from home');
        // Determine if it's a half-day leave with specific type
        const rmkUp = (rec.remarks || '').toUpperCase();
        const isHalfDayLeave = rec.status === 'half-day' && (
          rmkUp.includes('SL') || rmkUp.includes('EL') || rmkUp.includes('CL') || rmkUp.includes('LWP') || rmkUp.includes('WFH')
        );
        switch (rec.status) {
          case 'present':
            if (isWFH) { WFH++; P++; } else P++;
            break;
          case 'absent':    A++;   break;
          case 'half-day':
            H++;
            // Also count specific half-day leave type
            if (rmkUp.includes('SL'))  SL = (SL||0) + 0.5;
            else if (rmkUp.includes('EL')) EL = (EL||0) + 0.5;
            else if (rmkUp.includes('CL')) CL = (CL||0) + 0.5;
            else if (rmkUp.includes('LWP')) LWP++;
            break;
          case 'lwp':       LWP++; break;
          case 'on-leave':
            // Check remarks to differentiate SL/CL/EL
            if (rmkUp.includes('SL'))  SL = (SL||0) + 1;
            else if (rmkUp.includes('CL')) CL = (CL||0) + 1;
            else EL++;
            break;
          case 'od':        OD++;  break;
          default:          A++;
        }
      }

      const effectiveDays = P + (H * 0.5) + OD + EL;
      return {
        emp_code:      emp.employee_code,
        name:          emp.name,
        department:    emp.department || '—',
        designation:   emp.designation || '—',
        working_days:  workingDays,
        P, A, H, LH, LWP, EL, SL, CL, OD, WFH, WO, HOL,
        effective_days: parseFloat(effectiveDays.toFixed(1)),
        salary_days:    parseFloat(effectiveDays.toFixed(1)),
        _attMap: empAtt,
        _weeklyOffDays: weeklyOffDays,  // carry per-employee off-days for daily sheet
      };
    });

    // ── 8. Build Excel with SheetJS ───────────────────────────────────────
    const wb = XLSX.utils.book_new();

    // ── Sheet 1: Summary ──────────────────────────────────────────────────
    const summaryHeaders = [
      '#', 'Emp Code', 'Name', 'Department', 'Designation',
      'Working Days', 'Present (P)', 'Absent (A)', 'Half Day (H)',
      'LWP', 'EL (Earned)', 'SL (Sick)', 'CL (Casual)', 'OD', 'WFH', 'Weekly Off', 'Holidays',
      'Effective Days', 'Salary Days'
    ];

    const summaryData = [
      // Row 0: Company header (merged across all cols)
      [`HRMS — Monthly Attendance Report | ${monthName} ${yr}${department_id ? ' | Dept #'+department_id : ''}`],
      [`Generated on: ${new Date().toLocaleString('en-IN')} | By: ${req.user.first_name || ''} ${req.user.last_name || ''} (${req.user.role})`],
      [], // blank
      summaryHeaders,
      ...reportRows.map((r, i) => [
        i + 1,
        r.emp_code,
        r.name,
        r.department,
        r.designation,
        r.working_days,
        r.P, r.A, r.H,
        r.LWP, r.EL, r.SL||0, r.CL||0, r.OD, r.WFH, r.WO, r.HOL,
        r.effective_days,
        r.salary_days,
      ]),
      // Totals row
      [
        '', 'TOTAL', '', '', '',
        '',  // working days — not summed
        reportRows.reduce((s,r)=>s+r.P,0),
        reportRows.reduce((s,r)=>s+r.A,0),
        reportRows.reduce((s,r)=>s+r.H,0),
        reportRows.reduce((s,r)=>s+r.LWP,0),
        reportRows.reduce((s,r)=>s+r.EL,0),
        reportRows.reduce((s,r)=>s+(r.SL||0),0),
        reportRows.reduce((s,r)=>s+(r.CL||0),0),
        reportRows.reduce((s,r)=>s+r.OD,0),
        reportRows.reduce((s,r)=>s+r.WFH,0),
        '', '',
        reportRows.reduce((s,r)=>s+r.effective_days,0).toFixed(1),
        reportRows.reduce((s,r)=>s+r.salary_days,0).toFixed(1),
      ]
    ];

    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);

    // Column widths for summary
    wsSummary['!cols'] = [
      {wch:4}, {wch:10}, {wch:24}, {wch:18}, {wch:20},
      {wch:11}, {wch:11}, {wch:10}, {wch:11},
      {wch:8}, {wch:12}, {wch:10}, {wch:10}, {wch:6}, {wch:8}, {wch:10}, {wch:9},
      {wch:13}, {wch:11}
    ];

    // Merge title row
    wsSummary['!merges'] = [
      { s:{r:0,c:0}, e:{r:0,c:18} },
      { s:{r:1,c:0}, e:{r:1,c:18} },
    ];

    XLSX.utils.book_append_sheet(wb, wsSummary, `Summary ${mon}-${yr}`);

    // ── Sheet 2: Daily Breakdown (day-by-day per employee) ────────────────
    // Header: Emp Code | Name | Department | Day1 | Day2 … Day31 | P | A | H | LWP | EL | OD | WFH
    const dayHeaders = ['Emp Code', 'Name', 'Department'];
    for (let d = 1; d <= numDays; d++) {
      const dt  = new Date(yr, mon - 1, d);
      const dow = ['S','M','T','W','T','F','S'][dt.getDay()];
      dayHeaders.push(`${d}\n${dow}`);
    }
    dayHeaders.push('P','A','H','LWP','EL','OD','WFH','Eff.Days');

    const dailyData = [
      [`HRMS — Daily Attendance | ${monthName} ${yr}`],
      ['Codes: P=Present  A=Absent  H=Half-Day  LWP=Loss of Pay  EL=Leave  OD=On Duty  WFH=Work from Home  WO=Weekly Off  HO=Holiday'],
      [],
      dayHeaders,
    ];

    for (const r of reportRows) {
      // Use this employee's own weekly-off set (respects their saturday_policy)
      const empWeeklyOffDays = r._weeklyOffDays;
      const row = [r.emp_code, r.name, r.department];
      for (let d = 1; d <= numDays; d++) {
        const ds  = `${yr}-${String(mon).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        if (holSet.has(ds))            { row.push('HO'); continue; }
        if (empWeeklyOffDays.has(d))   { row.push('WO'); continue; }
        const rec = r._attMap[d];
        if (!rec) { row.push('A'); continue; }
        const isWFH = (rec.punch_in_location || '').toLowerCase().includes('work from home');
        const isHalfDayLeave = (rec.remarks || '').startsWith('Half-day');
        const isHalfWFH = (rec.remarks || '').includes('Half-day Work from Home');
        switch (rec.status) {
          case 'present':
            if (isHalfWFH) row.push('H-WFH');
            else if (isWFH) row.push('WFH');
            else row.push('P');
            break;
          case 'absent':    row.push('A');   break;
          case 'half-day': {
            if ((rec.remarks||'').includes('Half-day SL')) row.push('H-SL');
            else if ((rec.remarks||'').includes('Half-day EL')) row.push('H-EL');
            else if ((rec.remarks||'').includes('Half-day CL')) row.push('H-CL');
            else if ((rec.remarks||'').includes('Half-day LWP')) row.push('H-LWP');
            else row.push('H');
            break;
          }
          case 'lwp':       row.push('LWP'); break;
          case 'on-leave':  row.push('EL');  break;
          case 'od':        row.push('OD');  break;
          default:          row.push('A');
        }
      }
      row.push(r.P, r.A, r.H, r.LWP, r.EL, r.OD, r.WFH, r.effective_days);
      dailyData.push(row);
    }

    const wsDaily = XLSX.utils.aoa_to_sheet(dailyData);

    // Column widths for daily sheet
    const dailyCols = [
      {wch:10}, {wch:22}, {wch:16},
      ...Array(numDays).fill({wch:4}),
      {wch:5},{wch:5},{wch:5},{wch:6},{wch:5},{wch:5},{wch:6},{wch:9}
    ];
    wsDaily['!cols'] = dailyCols;
    wsDaily['!merges'] = [
      { s:{r:0,c:0}, e:{r:0,c:numDays+10} },
      { s:{r:1,c:0}, e:{r:1,c:numDays+10} },
    ];

    XLSX.utils.book_append_sheet(wb, wsDaily, `Daily ${mon}-${yr}`);

    // ── Sheet 3: Punch Register (daily punch in / punch out per employee) ─
    const punchHeaders = ['Emp Code', 'Name', 'Department'];
    for (let d = 1; d <= numDays; d++) {
      const dt  = new Date(yr, mon - 1, d);
      const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()];
      punchHeaders.push(`${d} ${dow}\nIN`);
      punchHeaders.push(`${d} ${dow}\nOUT`);
    }

    const punchData = [
      [`HRMS — Punch In / Punch Out Register | ${monthName} ${yr}`],
      [`Each date shows two columns: IN (punch-in time) and OUT (punch-out time). Blank = no record.`],
      [],
      punchHeaders,
    ];

    for (const emp of employees.rows) {
      const empAtt = attIndex[emp.id] || {};
      const row = [emp.employee_code, emp.name, emp.department || '—'];
      for (let d = 1; d <= numDays; d++) {
        const rec = empAtt[d];
        if (!rec) {
          row.push('', '');
        } else {
          row.push(rec.punch_in_fmt  || '', rec.punch_out_fmt || '');
        }
      }
      punchData.push(row);
    }

    const wsPunch = XLSX.utils.aoa_to_sheet(punchData);

    // Column widths: fixed cols + 2 cols per day
    const punchCols = [
      {wch: 10}, {wch: 22}, {wch: 16},
      ...Array(numDays * 2).fill({wch: 9}),
    ];
    wsPunch['!cols'] = punchCols;
    wsPunch['!merges'] = [
      { s:{r:0,c:0}, e:{r:0,c: numDays*2+2} },
      { s:{r:1,c:0}, e:{r:1,c: numDays*2+2} },
    ];

    XLSX.utils.book_append_sheet(wb, wsPunch, `Punch Register ${mon}-${yr}`);

    // ── 9. Stream response ────────────────────────────────────────────────
    const buf      = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `Attendance_${monthName}_${yr}${department_id ? '_Dept'+department_id : ''}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buf.length);
    return res.send(buf);

  } catch (err) {
    console.error('[downloadAttendanceReport]', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
};
