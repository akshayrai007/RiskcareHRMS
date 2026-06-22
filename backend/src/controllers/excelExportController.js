const ExcelJS = require('exceljs');
const db      = require('../config/db');

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

// ── Helper: build weekly off set ─────────────────────────────────────────────
function buildWeeklyOff(yr, mon) {
  const numDays = new Date(yr, mon, 0).getDate();
  const off = new Set();
  for (let d = 1; d <= numDays; d++) {
    const dt = new Date(yr, mon - 1, d);
    const dow = dt.getDay();
    if (dow === 0) { off.add(d); continue; }
    if (dow === 6) {
      let sat = 0;
      for (let dd = 1; dd <= d; dd++)
        if (new Date(yr, mon - 1, dd).getDay() === 6) sat++;
      if (sat === 2 || sat === 4) off.add(d);
    }
  }
  return off;
}

// ── Absent Report Excel ───────────────────────────────────────────────────────
exports.downloadAbsentReportExcel = async (req, res) => {
  try {
    const role = req.user.role;
    if (!['hr','super_admin','admin','accounts'].includes(role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const mon    = parseInt(req.query.month)  || new Date().getMonth() + 1;
    const yr     = parseInt(req.query.year)   || new Date().getFullYear();
    const search = req.query.search || '';
    const numDays = new Date(yr, mon, 0).getDate();
    const monthName = MONTHS[mon - 1];

    const weeklyOff = buildWeeklyOff(yr, mon);
    const holidays  = await db.query(
      `SELECT EXTRACT(DAY FROM date)::int AS day FROM holidays
       WHERE EXTRACT(MONTH FROM date)=$1 AND EXTRACT(YEAR FROM date)=$2`, [mon, yr]
    );
    const holSet = new Set(holidays.rows.map(h => h.day));

    // Working days list
    const workingDays = [];
    for (let d = 1; d <= numDays; d++) {
      if (!weeklyOff.has(d) && !holSet.has(d)) workingDays.push(d);
    }

    // Fetch employees
    let empWhere = 'WHERE e.is_active = true';
    let empP = [];
    if (search) {
      empWhere += ` AND (LOWER(CONCAT(e.first_name,' ',e.last_name)) LIKE $1 OR LOWER(e.employee_code) LIKE $1)`;
      empP.push(`%${search.toLowerCase()}%`);
    }
    const employees = await db.query(
      `SELECT e.id, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name,
              d.name AS department, des.title AS designation
       FROM employees e
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       ${empWhere} ORDER BY e.first_name`, empP
    );

    // Fetch attendance
    let attQ = `SELECT employee_id, EXTRACT(DAY FROM date)::int AS day, status
                FROM attendance
                WHERE EXTRACT(MONTH FROM date)=$1 AND EXTRACT(YEAR FROM date)=$2`;
    const attP = [mon, yr];
    if (search && empP.length) {
      attQ += ` AND employee_id IN (SELECT id FROM employees WHERE is_active=true AND (LOWER(CONCAT(first_name,' ',last_name)) LIKE $3 OR LOWER(employee_code) LIKE $3))`;
      attP.push(`%${search.toLowerCase()}%`);
    }
    const attendance = await db.query(attQ, attP);
    const attIndex = {};
    for (const r of attendance.rows) {
      if (!attIndex[r.employee_id]) attIndex[r.employee_id] = {};
      attIndex[r.employee_id][r.day] = r.status;
    }

    // ── Build workbook ────────────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator = 'RiskCare HRMS';
    const ws = wb.addWorksheet(`Absent Report ${monthName} ${yr}`, {
      views: [{ freezeRow: 3, freezeCol: 5 }]
    });

    // Title row
    ws.mergeCells(1, 1, 1, 5 + workingDays.length);
    const titleCell = ws.getCell(1, 1);
    titleCell.value = `ABSENT REPORT — ${monthName.toUpperCase()} ${yr}`;
    titleCell.font  = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    titleCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a5f' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 28;

    // Sub-title
    ws.mergeCells(2, 1, 2, 5 + workingDays.length);
    const subCell = ws.getCell(2, 1);
    subCell.value = `${employees.rows.length} employee(s) · ${workingDays.length} working days · A = Absent, P = Present, L = On Leave, H = Holiday`;
    subCell.font  = { italic: true, size: 10, color: { argb: 'FF555555' } };
    subCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFe8edf2' } };
    subCell.alignment = { horizontal: 'center' };
    ws.getRow(2).height = 18;

    // Header row: fixed columns + one column per working day
    const headerRow = ws.getRow(3);
    const fixedCols = ['Emp Code', 'Employee Name', 'Department', 'Designation', 'Absent Days'];
    fixedCols.forEach((h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = h;
      cell.font  = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a5f' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFAAAAAA' } } };
    });

    workingDays.forEach((d, i) => {
      const dt  = new Date(yr, mon - 1, d);
      const dow = ['Su','Mo','Tu','We','Th','Fr','Sa'][dt.getDay()];
      const cell = headerRow.getCell(6 + i);
      cell.value = `${String(d).padStart(2,'0')}\n${dow}`;
      cell.font  = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: dt.getDay() === 6 ? 'FF3d5a80' : 'FF1e3a5f' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFAAAAAA' } } };
    });
    headerRow.height = 32;

    // Data rows
    employees.rows.forEach((emp, ri) => {
      const empAtt = attIndex[emp.id] || {};
      let absentCount = 0;
      const row = ws.getRow(4 + ri);
      const rowBg = ri % 2 === 0 ? 'FFFFFFFF' : 'FFf8fafc';

      // Fixed cols
      const fixedVals = [emp.employee_code, emp.name, emp.department || '—', emp.designation || '—'];
      fixedVals.forEach((v, ci) => {
        const cell = row.getCell(ci + 1);
        cell.value = v;
        cell.font  = ci === 0 ? { bold: true, size: 10, color: { argb: 'FF1e3a5f' } } : { size: 10 };
        cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
        cell.alignment = { vertical: 'middle', horizontal: ci === 0 ? 'center' : 'left' };
        cell.border = { right: { style: 'thin', color: { argb: 'FFe2e8f0' } }, bottom: { style: 'thin', color: { argb: 'FFe2e8f0' } } };
      });

      // Day columns
      workingDays.forEach((d, di) => {
        const status = empAtt[d];
        let label, bgColor, fontColor;

        if (!status || status === 'absent') {
          label = 'A'; bgColor = 'FFffe4e6'; fontColor = 'FFdc2626'; absentCount++;
        } else if (status === 'present') {
          label = 'P'; bgColor = 'FFdcfce7'; fontColor = 'FF16a34a';
        } else if (['on_leave','half-day'].includes(status)) {
          label = 'L'; bgColor = 'FFfef9c3'; fontColor = 'FFca8a04';
        } else if (status === 'late') {
          label = 'P*'; bgColor = 'FFfff7ed'; fontColor = 'FFea580c';
        } else if (status === 'regularized') {
          label = 'R'; bgColor = 'FFe0e7ff'; fontColor = 'FF4338ca';
        } else {
          label = status.charAt(0).toUpperCase(); bgColor = rowBg; fontColor = 'FF666666';
        }

        const cell = row.getCell(6 + di);
        cell.value = label;
        cell.font  = { bold: true, size: 9, color: { argb: fontColor } };
        cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { right: { style: 'hair', color: { argb: 'FFcccccc' } }, bottom: { style: 'hair', color: { argb: 'FFcccccc' } } };
      });

      // Absent count cell
      const countCell = row.getCell(5);
      countCell.value = absentCount;
      countCell.font  = { bold: true, size: 11, color: { argb: absentCount > 5 ? 'FFdc2626' : absentCount > 2 ? 'FFca8a04' : 'FF16a34a' } };
      countCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
      countCell.alignment = { horizontal: 'center', vertical: 'middle' };
      countCell.border = { right: { style: 'thin', color: { argb: 'FFe2e8f0' } }, bottom: { style: 'thin', color: { argb: 'FFe2e8f0' } } };
      row.height = 20;
    });

    // Legend row
    const legendRow = ws.getRow(4 + employees.rows.length + 1);
    legendRow.getCell(1).value = 'Legend:';
    legendRow.getCell(1).font  = { bold: true, size: 9 };
    const legend = [['A','Absent','FFffe4e6','FFdc2626'],['P','Present','FFdcfce7','FF16a34a'],['L','Leave','FFfef9c3','FFca8a04'],['P*','Late','FFfff7ed','FFea580c'],['R','Regularized','FFe0e7ff','FF4338ca']];
    legend.forEach(([lbl, desc, bg, fg], i) => {
      const c1 = legendRow.getCell(2 + i * 2);
      c1.value = lbl; c1.font = { bold: true, size: 9, color: { argb: fg } };
      c1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      c1.alignment = { horizontal: 'center' };
      legendRow.getCell(3 + i * 2).value = desc;
      legendRow.getCell(3 + i * 2).font = { size: 9 };
    });

    // Column widths
    ws.getColumn(1).width = 10;
    ws.getColumn(2).width = 22;
    ws.getColumn(3).width = 14;
    ws.getColumn(4).width = 16;
    ws.getColumn(5).width = 10;
    workingDays.forEach((_, i) => { ws.getColumn(6 + i).width = 5; });

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Absent_Report_${monthName}_${yr}.xlsx"`);
    return res.send(buf);

  } catch (err) {
    console.error('[downloadAbsentReportExcel]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Leave Summary Excel ───────────────────────────────────────────────────────
exports.downloadLeaveSummaryExcel = async (req, res) => {
  try {
    const role = req.user.role;
    if (!['hr','super_admin','admin','accounts'].includes(role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const yr     = parseInt(req.query.year) || new Date().getFullYear();
    const search = req.query.search || '';

    let empWhere = 'WHERE e.is_active = true';
    let empP = [];
    if (search) {
      empWhere += ` AND (LOWER(CONCAT(e.first_name,' ',e.last_name)) LIKE $1 OR LOWER(e.employee_code) LIKE $1)`;
      empP.push(`%${search.toLowerCase()}%`);
    }
    const employees = await db.query(
      `SELECT e.id, e.employee_code,
              CONCAT(e.first_name,' ',e.last_name) AS name,
              d.name AS department, des.title AS designation
       FROM employees e
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       ${empWhere} ORDER BY e.first_name`, empP
    );

    const empIds = employees.rows.map(e => e.id);
    if (!empIds.length) {
      return res.status(404).json({ success: false, message: 'No employees found' });
    }

    const balRes = await db.query(
      `SELECT lb.employee_id, lt.code,
              COALESCE(lb.allocated,0)     AS allocated,
              COALESCE(lb.used,0)          AS used,
              COALESCE(lb.pending,0)       AS pending,
              COALESCE(lb.carry_forward,0) AS carry_forward,
              GREATEST(0, COALESCE(lb.allocated,0) + COALESCE(lb.carry_forward,0)
                        - COALESCE(lb.used,0) - COALESCE(lb.pending,0)) AS available
       FROM leave_types lt
       LEFT JOIN leave_balances lb
         ON lb.leave_type_id = lt.id AND lb.employee_id = ANY($1) AND lb.year = $2
       WHERE lt.code IN ('EL','SL','CL') AND lt.is_active = true`,
      [empIds, yr]
    );
    const balMap = {};
    for (const r of balRes.rows) {
      if (!balMap[r.employee_id]) balMap[r.employee_id] = {};
      balMap[r.employee_id][r.code] = r;
    }

    // ── Build workbook ────────────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`Leave Summary ${yr}`, {
      views: [{ freezeRow: 3, freezeCol: 4 }]
    });

    const LEAVE_TYPES = [
      { code: 'EL', label: 'Earned Leave (EL)',  hdrBg: 'FFfce7ef', hdrFg: 'FF881337', cellBg: 'FFfff1f5' },
      { code: 'SL', label: 'Sick Leave (SL)',     hdrBg: 'FFdcfce7', hdrFg: 'FF14532d', cellBg: 'FFf0fdf4' },
      { code: 'CL', label: 'Casual Leave (CL)',   hdrBg: 'FFfef9c3', hdrFg: 'FF713f12', cellBg: 'FFfefce8' },
    ];

    // Row 1: Title
    ws.mergeCells(1, 1, 1, 4 + LEAVE_TYPES.length * 3);
    const t = ws.getCell(1, 1);
    t.value = `LEAVE BALANCE SUMMARY — ${yr}`;
    t.font  = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    t.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a5f' } };
    t.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 28;

    // Row 2: Group headers (EL / SL / CL spanning 3 cols each)
    const grpRow = ws.getRow(2);
    // blank first 4 cols
    for (let c = 1; c <= 4; c++) {
      const cell = grpRow.getCell(c);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFe8edf2' } };
    }
    LEAVE_TYPES.forEach((lt, i) => {
      const startCol = 5 + i * 3;
      ws.mergeCells(2, startCol, 2, startCol + 2);
      const cell = grpRow.getCell(startCol);
      cell.value = lt.label;
      cell.font  = { bold: true, size: 11, color: { argb: lt.hdrFg } };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: lt.hdrBg } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { left: { style: 'medium', color: { argb: 'FFaaaaaa' } } };
    });
    grpRow.height = 24;

    // Row 3: Sub-headers
    const subRow = ws.getRow(3);
    ['Emp Code', 'Employee Name', 'Department', 'Designation'].forEach((h, i) => {
      const cell = subRow.getCell(i + 1);
      cell.value = h;
      cell.font  = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a5f' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { bottom: { style: 'medium', color: { argb: 'FF888888' } } };
    });
    LEAVE_TYPES.forEach((lt, i) => {
      ['Allocated', 'Used', 'Available'].forEach((h, j) => {
        const col = 5 + i * 3 + j;
        const cell = subRow.getCell(col);
        cell.value = h;
        cell.font  = { bold: true, size: 9, color: { argb: lt.hdrFg } };
        cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: lt.hdrBg } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          left:   j === 0 ? { style: 'medium', color: { argb: 'FFaaaaaa' } } : { style: 'thin', color: { argb: 'FFcccccc' } },
          bottom: { style: 'medium', color: { argb: 'FF888888' } }
        };
      });
    });
    subRow.height = 20;

    // Data rows
    employees.rows.forEach((emp, ri) => {
      const b = balMap[emp.id] || {};
      const row = ws.getRow(4 + ri);
      const rowBg = ri % 2 === 0 ? 'FFFFFFFF' : 'FFf8fafc';

      [emp.employee_code, emp.name, emp.department || '—', emp.designation || '—'].forEach((v, ci) => {
        const cell = row.getCell(ci + 1);
        cell.value = v;
        cell.font  = ci === 0 ? { bold: true, size: 10, color: { argb: 'FF1e3a5f' } } : { size: 10 };
        cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
        cell.alignment = { vertical: 'middle', horizontal: ci === 0 ? 'center' : 'left' };
        cell.border = { right: { style: 'thin', color: { argb: 'FFe2e8f0' } }, bottom: { style: 'thin', color: { argb: 'FFe2e8f0' } } };
      });

      LEAVE_TYPES.forEach((lt, i) => {
        const bal = b[lt.code] || { allocated: 0, used: 0, available: 0 };
        [
          { val: parseFloat(bal.allocated), key: 'alloc' },
          { val: parseFloat(bal.used),      key: 'used'  },
          { val: parseFloat(bal.available), key: 'avail' },
        ].forEach(({ val, key }, j) => {
          const col  = 5 + i * 3 + j;
          const cell = row.getCell(col);
          cell.value = val;
          cell.numFmt = '0.0';
          const fgColor = key === 'used'  ? 'FFdc2626'
                        : key === 'avail' ? 'FF16a34a'
                        : 'FF374151';
          cell.font  = { bold: key !== 'alloc', size: 10, color: { argb: fgColor } };
          cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: val > 0 && key === 'avail' ? lt.cellBg : rowBg } };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          cell.border = {
            left:   j === 0 ? { style: 'medium', color: { argb: 'FFaaaaaa' } } : { style: 'hair', color: { argb: 'FFcccccc' } },
            right:  { style: 'hair', color: { argb: 'FFcccccc' } },
            bottom: { style: 'thin', color: { argb: 'FFe2e8f0' } }
          };
        });
      });
      row.height = 18;
    });

    // Column widths
    ws.getColumn(1).width = 10;
    ws.getColumn(2).width = 24;
    ws.getColumn(3).width = 16;
    ws.getColumn(4).width = 18;
    for (let i = 0; i < LEAVE_TYPES.length * 3; i++) ws.getColumn(5 + i).width = 11;

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Leave_Summary_${yr}.xlsx"`);
    return res.send(buf);

  } catch (err) {
    console.error('[downloadLeaveSummaryExcel]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};
