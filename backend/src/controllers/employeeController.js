const CONFIG = require('../Main_file');
// src/controllers/employeeController.js
// UPDATED: provision/contractual/permanent support + dual employee code series
// KC10000+  -> permanent & provision employees
// Cont0001+ -> contractual employees
const bcrypt = require('bcryptjs');

// ── IST-safe date formatter ───────────────────────────────────────────────────
// Server runs on Render (UTC). toISOString() gives wrong date for IST users
// after 18:30 IST (midnight UTC). Always use this instead of toISOString().
function toISTDateString(date) {
  if (!date) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.timezone || 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(date)); // returns "YYYY-MM-DD" in IST
}
const { getEmployeeRegion } = require('../config/regionHelper');
const db = require('../config/db');

// Auto-generate employee code
async function generateEmployeeCode(client, employeeCategory) {
  const isContractual = (employeeCategory || '').toLowerCase() === 'contractual';
  if (isContractual) {
    const res = await client.query(
      `SELECT employee_code FROM employees WHERE employee_code ILIKE '${CONFIG.contractualEmpCodePrefix}%' ORDER BY id DESC LIMIT 1`
    );
    let nextNum = 1;
    if (res.rows.length) {
      const m = res.rows[0].employee_code.match(/\d+/);
      if (m) nextNum = parseInt(m[0]) + 1;
    }
    return `Cont${String(nextNum).padStart(4, '0')}`;
  } else {
    const res = await client.query(
      `SELECT employee_code FROM employees WHERE employee_code ILIKE '${CONFIG.permanentEmpCodePrefix}%' ORDER BY id DESC LIMIT 1`
    );
    let nextNum = 10000;
    if (res.rows.length) {
      const m = res.rows[0].employee_code.match(/\d+/);
      if (m) nextNum = Math.max(parseInt(m[0]) + 1, 10000);
    }
    return `KC${nextNum}`;
  }
}

// Get All (role-filtered)
exports.getAll = async (req, res) => {
  try {
    const { department_id, search, role: filterRole, is_active, employee_category,
            reporting_manager_id } = req.query;
    const userRole = req.user.role;
    const userId   = req.user.id;

    let conditions = [];
    let params = [];
    let idx = 1;

    if (is_active === 'false') {
      // Separated tab: deactivated OR completed-separation (even if LWD is future)
      conditions.push("(e.is_active = false OR EXISTS (SELECT 1 FROM separations sep WHERE sep.employee_id = e.id AND sep.status = 'completed'))");
    } else {
      // Directory tab: active only, exclude completed-separation employees
      conditions.push("(e.is_active = true AND NOT EXISTS (SELECT 1 FROM separations sep WHERE sep.employee_id = e.id AND sep.status = 'completed'))");
    }

    if (userRole === 'manager') {
      // If reporting_manager_id is explicitly passed (e.g. from movement.html), don't add dept filter
      // The reporting_manager_id condition will be added below
      if (!reporting_manager_id) {
        conditions.push(`e.department_id = (SELECT department_id FROM employees WHERE id=$${idx++})`);
        params.push(userId);
      }
    } else if (userRole === 'tl') {
      conditions.push(`(e.team_leader_id=$${idx} OR e.id=$${idx})`);
      params.push(userId); idx++;
    } else if (userRole === 'employee') {
      conditions.push(`e.id=$${idx++}`);
      params.push(userId);
    }

    if (department_id)       { conditions.push(`e.department_id=$${idx++}`);           params.push(parseInt(department_id)); }
    if (filterRole)          { conditions.push(`e.role=$${idx++}`);                        params.push(filterRole); }
    if (employee_category)   { conditions.push(`e.employee_category=$${idx++}`);           params.push(employee_category); }
    // reporting_manager_id filter — used by movement.html to show only direct reports
    if (reporting_manager_id){ conditions.push(`e.reporting_manager_id=$${idx++}`);        params.push(parseInt(reporting_manager_id)); }
    if (search) {
      conditions.push(
        `(LOWER(CONCAT(e.first_name,' ',e.last_name)) LIKE LOWER($${idx})
          OR LOWER(e.email)         LIKE LOWER($${idx})
          OR LOWER(e.employee_code) LIKE LOWER($${idx})
          OR e.phone LIKE $${idx})`
      );
      params.push(`%${search}%`); idx++;
    }

    const result = await db.query(
      `SELECT
         e.id, e.employee_code, e.first_name, e.last_name, e.email, e.phone,
         e.gender, e.joining_date, e.role, e.is_active, e.employment_type,
         e.employee_category, e.provision_end_date, e.confirmed_date,
         e.saturday_policy,
         e.department_id, e.designation_id, e.reporting_manager_id, e.team_leader_id,
         e.basic_salary, e.ctc, e.city,
         e.separation_date, e.separation_type, e.separation_reason,
         sep_active.last_working_date AS sep_last_working_date,
         d.name   AS department_name,
         des.title AS designation_title,
         CONCAT(m.first_name,' ',m.last_name)   AS manager_name,
         CONCAT(tl.first_name,' ',tl.last_name) AS team_leader_name,
         pc.overall_status AS confirmation_status,
         e.provision_end_date - CURRENT_DATE    AS days_to_confirmation
       FROM employees e
       LEFT JOIN departments  d   ON e.department_id  = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       LEFT JOIN employees    m   ON e.reporting_manager_id = m.id
       LEFT JOIN employees    tl  ON e.team_leader_id  = tl.id
       LEFT JOIN provision_confirmations pc ON pc.employee_id = e.id
       LEFT JOIN separations sep_active ON sep_active.employee_id = e.id AND sep_active.status = 'completed'
       WHERE ${conditions.join(' AND ')}
       ORDER BY d.name, e.first_name`,
      params
    );
    res.json({ success: true, data: result.rows, total: result.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get Contacts — open to all authenticated users (HR, Accounts, Reporting Manager lookup)
// Used by AI chatbot for all roles including employee/tl/manager
exports.getContacts = async (req, res) => {
  try {
    const { type, manager_id } = req.query;
    // type = 'hr' | 'accounts' | 'manager'
    // manager_id = specific employee id (for reporting manager lookup)

    let conditions = ["e.is_active = true"];
    let params = [];
    let idx = 1;

    if (type === 'hr') {
      conditions.push(`e.role = $${idx++}`);
      params.push('hr');
    } else if (type === 'accounts') {
      conditions.push(`e.role = $${idx++}`);
      params.push('accounts');
    } else if (type === 'admin') {
      conditions.push(`e.role IN ('admin','super_admin','hr')`);
    } else if (type === 'manager' && manager_id) {
      conditions.push(`e.id = $${idx++}`);
      params.push(parseInt(manager_id));
    } else {
      return res.status(400).json({ success: false, message: 'Invalid type' });
    }

    const result = await db.query(
      `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.email, e.phone,
              e.role, e.is_active,
              d.name AS department_name, des.title AS designation_title
       FROM employees e
       LEFT JOIN departments  d   ON e.department_id  = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.first_name`,
      params
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get One
exports.getOne = async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const role     = req.user.role;
    const userId   = req.user.id;

    if (role === 'employee' && targetId !== userId)
      return res.status(403).json({ success: false, message: 'Access denied' });

    const result = await db.query(
      `SELECT e.*,
         d.name AS department_name, des.title AS designation_title,
         CONCAT(m.first_name,' ',m.last_name)   AS manager_name,
         CONCAT(tl.first_name,' ',tl.last_name) AS team_leader_name,
         pc.overall_status AS confirmation_status,
         pc.manager_status, pc.hr_status, pc.initiated_at, pc.confirmed_at
       FROM employees e
       LEFT JOIN departments  d   ON e.department_id  = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       LEFT JOIN employees    m   ON e.reporting_manager_id = m.id
       LEFT JOIN employees    tl  ON e.team_leader_id  = tl.id
       LEFT JOIN provision_confirmations pc ON pc.employee_id = e.id
       WHERE e.id=$1`,
      [targetId]
    );

    if (!result.rows.length)
      return res.status(404).json({ success: false, message: 'Employee not found' });

    const emp = result.rows[0];
    if (!['admin','super_admin','hr'].includes(role) && targetId !== userId) {
      delete emp.password_hash; delete emp.pan_number;
      delete emp.aadhar_number; delete emp.bank_account;
      delete emp.bank_ifsc;     delete emp.uan_number;
    } else {
      delete emp.password_hash;
    }

    res.json({ success: true, data: emp });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Create — Supports employee_category: permanent | provision | contractual
exports.create = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const {
      employee_code, first_name, last_name = '', email, phone, gender,
      date_of_birth, joining_date, department_id, designation_id,
      reporting_manager_id, team_leader_id, role = 'employee',
      employment_type = 'Full-Time',
      employee_category = 'permanent',
      password,
      basic_salary = 0, hra = 0, special_allowance = 0, travel_allowance = 0, ctc = 0,
      pan_number, aadhar_number, bank_name, bank_account, bank_ifsc, bank_branch,
      address_line1, city, state, pincode, blood_group, level
    } = req.body;

    if (!first_name || !email)
      return res.status(400).json({ success: false, message: 'first_name and email are required' });

    const validCats = ['permanent', 'provision', 'contractual'];
    if (!validCats.includes(employee_category))
      return res.status(400).json({ success: false, message: `employee_category must be: ${validCats.join(', ')}` });

    const finalCode = employee_code || await generateEmployeeCode(client, employee_category);

    const jDate = joining_date ? new Date(joining_date) : new Date();
    let provisionEndDate = null;
    if (employee_category === 'provision') {
      const pe = new Date(jDate);
      pe.setMonth(pe.getMonth() + 6);
      provisionEndDate = toISTDateString(pe); // FIX: IST instead of UTC
    }

    const pwHash = await bcrypt.hash(password || finalCode, 10);

    const result = await client.query(
      `INSERT INTO employees (
         employee_code, first_name, last_name, email, phone, gender,
         date_of_birth, joining_date, department_id, designation_id,
         reporting_manager_id, team_leader_id, role, password_hash,
         employment_type, employee_category, provision_end_date,
         basic_salary, hra, special_allowance, travel_allowance, ctc,
         pan_number, aadhar_number, bank_name, bank_account, bank_ifsc, bank_branch,
         address_line1, city, state, pincode, blood_group, level, is_active, saturday_policy
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                 $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,true,$35)
       RETURNING id, employee_code, first_name, last_name, email, role, employee_category, provision_end_date`,
      [finalCode, first_name, last_name, email, phone||null, gender||null,
       date_of_birth||null, toISTDateString(jDate), // FIX: IST instead of UTC
       department_id||null, designation_id||null,
       reporting_manager_id||null, team_leader_id||null,
       role, pwHash, employment_type||'Full-Time', employee_category, provisionEndDate,
       basic_salary||0, hra||0, special_allowance||0, travel_allowance||0, ctc||0,
       pan_number||null, aadhar_number||null,
       bank_name||null, bank_account||null, bank_ifsc||null, bank_branch||null,
       address_line1||null, city||null, state||null, pincode||null, blood_group||null, level||null,
       req.body.saturday_policy || '2nd_4th_off']
    );

    const newEmp = result.rows[0];
    const yr = new Date().getFullYear();

    // Auto-seed leave balances based on joining date and category
    // Rule: < 6 months from today → PL=6 (all categories)
    //       >= 6 months → EL=18, CL=6, SL=6 (permanent & contractual confirmed)
    //       provision category still on provision period → PL=6 only
    {
      const today = new Date();
      const sixMonthMark = new Date(jDate);
      sixMonthMark.setMonth(sixMonthMark.getMonth() + 6);
      const isUnderSixMonths = today < sixMonthMark;

      const ltRes = await client.query(
        `SELECT id, code FROM leave_types WHERE is_active=true AND code IN ('EL','CL','SL','PL','LWP','OD')`
      );
      const ltMap = {};
      for (const lt of ltRes.rows) ltMap[lt.code] = lt.id;

      if (isUnderSixMonths || employee_category === 'provision') {
        // PL = 6 upfront, no EL/CL/SL yet
        if (ltMap['PL']) {
          await client.query(
            `INSERT INTO leave_balances(employee_id,leave_type_id,year,allocated,used,pending,carry_forward)
             VALUES($1,$2,$3,6,0,0,0) ON CONFLICT DO NOTHING`,
            [newEmp.id, ltMap['PL'], yr]
          );
        }
      } else {
        // >= 6 months: full EL/CL/SL
        const allocations = { EL: 18, CL: 6, SL: 6 };
        for (const [code, alloc] of Object.entries(allocations)) {
          if (ltMap[code]) {
            await client.query(
              `INSERT INTO leave_balances(employee_id,leave_type_id,year,allocated,used,pending,carry_forward)
               VALUES($1,$2,$3,$4,0,0,0) ON CONFLICT DO NOTHING`,
              [newEmp.id, ltMap[code], yr, alloc]
            );
          }
        }
      }
    }

    await client.query('COMMIT');

    // Send welcome email to new employee (async, don't block response)
    const emailSvc = require('../config/emailService');
    emailSvc.notifyNewEmployee(newEmp.id, password || finalCode).catch(console.error);

    res.status(201).json({
      success: true,
      message: `${employee_category.charAt(0).toUpperCase()+employee_category.slice(1)} employee created. Code: ${finalCode}`,
      data: { ...newEmp, auto_generated_code: !employee_code }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (err.code === '23505')
      return res.status(400).json({ success: false, message: 'Employee code or email already exists' });
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// Update
exports.update = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const allowed = [
      'first_name','last_name','email','phone','alternate_phone',
      'gender','date_of_birth','blood_group','marital_status',
      'joining_date','department_id','designation_id','reporting_manager_id','team_leader_id',
      'role','employment_type','employee_category','provision_end_date','confirmed_date',
      'basic_salary','hra','special_allowance','gratuity','conveyance','travel_allowance','ctc',
      'pan_number','aadhar_number','uan_number','pf_number',
      'bank_name','bank_account','bank_ifsc','bank_branch',
      'address_line1','permanent_address','city','state','pincode',
      'probation_end_date','exit_date','notes',
      'is_active','is_wfh_permanent','level','saturday_policy',
      'separation_date','separation_type','separation_reason','employee_type',
      'deactivation_remark'
    ];

    const sets = [], params = []; let idx = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        sets.push(`${key}=$${idx++}`);
        // last_name and first_name must never be null — use empty string
        const nullableKeys = ['last_name','first_name'];
        params.push(req.body[key] === '' && !nullableKeys.includes(key) ? null : (req.body[key] ?? ''));
      }
    }

    if (req.body.password) {
      sets.push(`password_hash=$${idx++}`);
      params.push(await bcrypt.hash(req.body.password, 10));
    }

    if (!sets.length) return res.status(400).json({ success: false, message: 'Nothing to update' });

    sets.push(`updated_at=NOW()`);
    params.push(id);
    await db.query(`UPDATE employees SET ${sets.join(',')} WHERE id=$${idx}`, params);
    res.json({ success: true, message: 'Employee updated' });
  } catch (err) {
    console.error('[update employee error]', err.message, err.detail || '');
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
};

// Reset Password
exports.resetPassword = async (req, res) => {
  try {
    const { employee_id, new_password = 'Admin@1234' } = req.body;
    const hash = await bcrypt.hash(new_password, 10);
    await db.query(`UPDATE employees SET password_hash=$1 WHERE id=$2`, [hash, employee_id]);
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Hard-delete employee (admin/hr/accounts only)
exports.deleteEmployee = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid employee ID' });

    // Prevent deleting yourself
    if (req.user.id === id)
      return res.status(400).json({ success: false, message: 'You cannot delete your own account' });

    const existing = await db.query(`SELECT id, first_name, last_name, employee_code FROM employees WHERE id=$1`, [id]);
    if (!existing.rows.length)
      return res.status(404).json({ success: false, message: 'Employee not found' });

    await db.query(`DELETE FROM employees WHERE id=$1`, [id]);
    res.json({ success: true, message: `Employee ${existing.rows[0].employee_code} deleted permanently` });
  } catch (err) {
    console.error('[delete employee error]', err.message, err.detail || '');
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
};

// Preview next auto-generated employee code (for HR UI)
exports.previewNextCode = async (req, res) => {
  try {
    const { employee_category = 'permanent' } = req.query;
    const client = await db.getClient();
    try {
      const code = await generateEmployeeCode(client, employee_category);
      res.json({ success: true, data: { next_code: code, category: employee_category } });
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Export Employees to Excel
exports.exportExcel = async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const result = await db.query(
      `SELECT
         e.employee_code, e.first_name, e.last_name, e.email, e.phone,
         e.gender, e.date_of_birth, e.joining_date,
         d.name AS department, des.title AS designation,
         e.role, e.employment_type, e.employee_category, e.level,
         e.basic_salary, e.ctc,
         e.pan_number, e.aadhar_number, e.uan_number, e.pf_number,
         e.bank_name, e.bank_account, e.bank_ifsc,
         e.city, e.state,
         CONCAT(m.first_name,' ',m.last_name) AS reporting_manager,
         e.is_active
       FROM employees e
       LEFT JOIN departments  d   ON e.department_id  = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       LEFT JOIN employees    m   ON e.reporting_manager_id = m.id
       WHERE e.is_active = true
       ORDER BY d.name, e.first_name`
    );

    const rows = result.rows.map(r => ({
      'Employee Code':     r.employee_code,
      'First Name':        r.first_name,
      'Last Name':         r.last_name || '',
      'Email':             r.email,
      'Phone':             r.phone || '',
      'Gender':            r.gender || '',
      'Date of Birth':     r.date_of_birth ? toISTDateString(r.date_of_birth) : '',
      'Date of Joining':   r.joining_date  ? toISTDateString(r.joining_date)  : '',
      'Department':        r.department || '',
      'Designation':       r.designation || '',
      'Role':              r.role,
      'Employment Type':   r.employment_type || '',
      'Category':          r.employee_category || '',
      'Level':             r.level || '',
      'Basic Salary':      r.basic_salary || 0,
      'CTC Annual':        r.ctc || 0,
      'PAN Number':        r.pan_number || '',
      'Aadhar Number':     r.aadhar_number || '',
      'UAN Number':        r.uan_number || '',
      'PF Number':         r.pf_number || '',
      'Bank Name':         r.bank_name || '',
      'Bank Account':      r.bank_account || '',
      'Bank IFSC':         r.bank_ifsc || '',
      'City':              r.city || '',
      'State':             r.state || '',
      'Reporting Manager': r.reporting_manager || '',
    }));

    const wb  = XLSX.utils.book_new();
    const ws  = XLSX.utils.json_to_sheet(rows);

    // Column widths
    ws['!cols'] = [
      {wch:14},{wch:16},{wch:16},{wch:28},{wch:14},
      {wch:8}, {wch:14},{wch:14},{wch:16},{wch:24},
      {wch:12},{wch:14},{wch:12},{wch:8}, {wch:13},
      {wch:13},{wch:14},{wch:16},{wch:14},{wch:18},
      {wch:20},{wch:20},{wch:13},{wch:14},{wch:16},{wch:20},
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Employees');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const today = toISTDateString(new Date()); // FIX: IST instead of UTC
    res.setHeader('Content-Disposition', `attachment; filename="employees_${today}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Export failed' });
  }
};

// Master Excel Export — All employees + their attendance for selected month

// ── Shared Punch Register Sheet Builder ──────────────────────────────────────
// Color logic mirrors attendance register:
//   Punch-IN  ≤ 10:30 → Green (on time)  | > 10:30 → Orange (late)  | missing → light red bg
//   Punch-OUT ≥ 18:30 → Blue (full day)  | < 18:30 → Purple (early) | missing → light red bg
//   Weekend col → dark pink header (matches attendance sheet)
//   Holiday col → grey header
//   Deactivated employee → rows in pale red, merged remark after last punch day
async function buildPunchRegisterSheet(wb, employees, m, y, MONTH_NAMES, punchMapIn, holidaysByRegion, getEmployeeRegion) {
  const ExcelJS = require('exceljs');
  const daysInMonth = new Date(y, m, 0).getDate();
  const dayNms = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const totalCols = 3 + daysInMonth * 2 + 3; // 3 info + 2*days + 3 summary cols

  const ws = wb.addWorksheet(`Punch Register ${MONTH_NAMES[m-1]} ${y}`, {
    views: [{ state: 'frozen', xSplit: 3, ySplit: 3 }]
  });

  // ── Row 1: Title ─────────────────────────────────────────────────────────
  try { ws.mergeCells(1, 1, 1, totalCols); } catch(_) {}
  const t = ws.getCell(1,1);
  t.value = `HRMS — Daily Punch In / Punch Out Register | ${MONTH_NAMES[m-1]} ${y}`;
  t.font  = { bold:true, size:13, color:{argb:'FFFFFFFF'} };
  t.fill  = { type:'pattern', pattern:'solid', fgColor:{argb:'FF0D47A1'} };
  t.alignment = { horizontal:'center', vertical:'middle' };
  ws.getRow(1).height = 28;

  // ── Row 2: Legend ────────────────────────────────────────────────────────
  try { ws.mergeCells(2, 1, 2, totalCols); } catch(_) {}
  const leg = ws.getCell(2,1);
  leg.value = '🟢 IN ≤10:30 On Time  |  🟠 IN >10:30 Late  |  🔵 OUT ≥18:30 Full Day  |  🟣 OUT <18:30 Early  |  🟧 MPO=Missing PunchOut  |  🏠 WFH  |  🚗 OD  |  🏖 EL=Leave  |  💸 LWP  |  ½=Half Day  |  WO=Weekend  |  HOL=Holiday';
  leg.font  = { size:8, italic:true, color:{argb:'FF37474F'} };
  leg.fill  = { type:'pattern', pattern:'solid', fgColor:{argb:'FFE3F2FD'} };
  leg.alignment = { horizontal:'left', vertical:'middle', indent:1 };
  ws.getRow(2).height = 16;

  // ── Row 3: Fixed col headers ─────────────────────────────────────────────
  const hdrFill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF1565C0'} };
  const hdrFont = { bold:true, size:9, color:{argb:'FFFFFFFF'} };
  ['Emp Code','Name','Department'].forEach((h,i) => {
    const c = ws.getCell(3, i+1);
    c.value=h; c.font=hdrFont; c.fill=hdrFill;
    c.alignment={horizontal:'center',vertical:'middle'};
    c.border={bottom:{style:'medium',color:{argb:'FFFFFFFF'}}};
  });

  // ── Row 3: Day date headers (merged IN+OUT per day) ──────────────────────
  let satCnt = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow    = new Date(y, m-1, d).getDay();
    if (dow === 6) satCnt++;
    const isWeekend = dow === 0 || (dow === 6 && (satCnt === 2 || satCnt === 4));
    const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isHoliday = (holidaysByRegion.all || new Set()).has(dateStr);
    const col = 3 + (d-1)*2 + 1;

    // Merged date header
    try { ws.mergeCells(3, col, 3, col+1); } catch(e){}
    const dc = ws.getCell(3, col);
    dc.value = `${d}\n${dayNms[dow]}`;
    const hBg = isWeekend ? 'FF880E4F' : isHoliday ? 'FF607D8B' : 'FF1565C0';
    const hFg = 'FFFFFFFF';
    dc.font  = { bold:true, size:8, color:{argb:hFg} };
    dc.fill  = { type:'pattern', pattern:'solid', fgColor:{argb:hBg} };
    dc.alignment = { horizontal:'center', vertical:'middle', wrapText:true };
    dc.border = { bottom:{style:'thin',color:{argb:'FFFFFFFF'}} };
  }

  // Summary headers
  ['Total\nDays', 'On\nTime', 'Late\nIN'].forEach((h,i) => {
    const c = ws.getCell(3, 3+daysInMonth*2+1+i);
    c.value=h; c.font={bold:true,size:8,color:{argb:'FFFFFFFF'}};
    c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF00695C'}};
    c.alignment={horizontal:'center',vertical:'middle',wrapText:true};
  });
  ws.getRow(3).height = 24;

  // ── Fixed col widths ──────────────────────────────────────────────────────
  ws.getColumn(1).width = 10;
  ws.getColumn(2).width = 22;
  ws.getColumn(3).width = 16;
  for (let d = 1; d <= daysInMonth; d++) {
    ws.getColumn(3+(d-1)*2+1).width = 9;
    ws.getColumn(3+(d-1)*2+2).width = 9;
  }
  ws.getColumn(3+daysInMonth*2+1).width = 7;
  ws.getColumn(3+daysInMonth*2+2).width = 7;
  ws.getColumn(3+daysInMonth*2+3).width = 7;

  // ── Group separator tracker (onsite → offsite → deactivated) ─────────────
  let lastGrp = null;
  let grpOffset = 0;

  employees.forEach((e, ri) => {
    const isDeact   = e.is_active === false;
    const isOffsite = !isDeact && e.saturday_policy === 'all_working';
    const grp = isDeact ? 'deactivated' : isOffsite ? 'offsite' : 'onsite';

    if (grp !== lastGrp) {
      const sepRow = ri + 4 + grpOffset;
      grpOffset++;
      const grpLabel = grp==='onsite' ? '🏢 ONSITE EMPLOYEES'
                     : grp==='offsite' ? '🌐 OFFSITE EMPLOYEES'
                     : '❌ DEACTIVATED EMPLOYEES';
      const grpBg = grp==='onsite' ? 'FF1B5E20' : grp==='offsite' ? 'FF0D47A1' : 'FF4A0000';
      try { ws.mergeCells(sepRow, 1, sepRow, totalCols); } catch(ex){}
      const sc = ws.getCell(sepRow,1);
      sc.value=grpLabel;
      sc.font={bold:true,size:10,color:{argb:'FFFFFFFF'}};
      sc.fill={type:'pattern',pattern:'solid',fgColor:{argb:grpBg}};
      sc.alignment={horizontal:'left',vertical:'middle',indent:1};
      ws.getRow(sepRow).height=18;
      lastGrp=grp;
    }

    const row   = ri + 4 + grpOffset;
    const isAlt = ri % 2 === 1;
    const rowBg = isDeact ? (isAlt?'FFFFF5F5':'FFFFFFEE')
                : isOffsite ? (isAlt?'FFE3F2FD':'FFFFFFFF')
                : (isAlt?'FFE8F5E9':'FFFFFFFF');

    // Info cells
    [e.employee_code, `${e.first_name} ${e.last_name||''}`.trim(), e.department||''].forEach((v,ci) => {
      const c = ws.getCell(row, ci+1);
      c.value=v;
      c.font={size:9, bold: ci===1, color:{argb: isDeact?'FF9E0000':'FF000000'}};
      c.fill={type:'pattern',pattern:'solid',fgColor:{argb:rowBg}};
      c.alignment={vertical:'middle'};
      c.border={right:{style:'hair'},bottom:{style:'hair'}};
    });

    const empPunch = punchMapIn[e.id] || {};
    const empReg   = getEmployeeRegion(e.city||'', e.state||'');
    const empHols  = empReg==='north' ? holidaysByRegion.north : holidaysByRegion.south_west;
    let punchSatCnt = 0;
    let totalPunched=0, onTimeCnt=0, lateCnt=0;

    // For deactivated: find last punch day, merge rest
    const punchDays = Object.keys(empPunch).map(Number);
    const lastPunchDay = punchDays.length ? Math.max(...punchDays) : 0;

    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(y,m-1,d).getDay();
      if (dow===6) punchSatCnt++;
      const isWeekend = dow===0 || (dow===6 && (punchSatCnt===2||punchSatCnt===4));
      const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const isHol   = empHols.has(dateStr);
      const col     = 3+(d-1)*2+1;

      // Deactivated: merge remaining days after last punch day
      if (isDeact && d === lastPunchDay + 1 && d <= daysInMonth) {
        try { ws.mergeCells(row, col, row, 3+daysInMonth*2); } catch(ex){}
        const mc = ws.getCell(row, col);
        mc.value = e.deactivation_remark
          ? `❌ ${e.deactivation_remark}`
          : `❌ Account deactivated${e.separation_date?' on '+e.separation_date:''}`;
        mc.font  = {bold:true,size:8,color:{argb:'FFB71C1C'},italic:true};
        mc.fill  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF3F3'}};
        mc.alignment = {horizontal:'left',vertical:'middle',wrapText:false};
        mc.border = {right:{style:'medium',color:{argb:'FFEF9A9A'}},bottom:{style:'hair'}};
        break;
      }
      if (isDeact && d > lastPunchDay) break;

      const punch  = empPunch[d] || {in:'',out:'',inH:-1,outH:-1,inM:-1,outM:-1,status:'',hours:0};
      const status = punch.status;
      const inC    = ws.getCell(row, col);
      const outC   = ws.getCell(row, col+1);

      if (isWeekend) {
        // ── Weekend ───────────────────────────────────────────────────────
        inC.fill = outC.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFECE0E8'}};
        inC.value='WO'; outC.value='';
        inC.font = {size:7,color:{argb:'FFB71C1C'},bold:true};
        outC.font = {size:7,color:{argb:'FFBDBDBD'}};

      } else if (isHol) {
        // ── Holiday ───────────────────────────────────────────────────────
        inC.fill = outC.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFE0E5E8'}};
        inC.value='HOL'; outC.value='';
        inC.font={size:7,color:{argb:'FF546E7A'},bold:true};
        outC.font={size:7,color:{argb:'FFBDBDBD'}};

      } else if (status === 'wfh') {
        // ── WFH — no physical punch, show WFH across both cols ────────────
        try { ws.mergeCells(row, col, row, col+1); } catch(ex){}
        inC.value = punch.in ? `🏠 IN:${punch.in}` : '🏠 WFH';
        inC.font  = {bold:true,size:8,color:{argb:'FF006064'}};
        inC.fill  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFE0F7FA'}};
        inC.alignment = {horizontal:'center',vertical:'middle'};
        inC.border = {right:{style:'hair'},bottom:{style:'hair'}};
        if (punch.in) { totalPunched++; const inH=punch.inH,inM=punch.inM; if((inH<10)||(inH===10&&inM<=30)) onTimeCnt++; else lateCnt++; }
        continue;

      } else if (status === 'od') {
        // ── OD — Outdoor Duty, may or may not have punch ──────────────────
        try { ws.mergeCells(row, col, row, col+1); } catch(ex){}
        inC.value = punch.in ? `🚗 IN:${punch.in}` : '🚗 OD';
        inC.font  = {bold:true,size:8,color:{argb:'FF00695C'}};
        inC.fill  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFE8F5E9'}};
        inC.alignment = {horizontal:'center',vertical:'middle'};
        inC.border = {right:{style:'hair'},bottom:{style:'hair'}};
        if (punch.in) { totalPunched++; const inH=punch.inH,inM=punch.inM; if((inH<10)||(inH===10&&inM<=30)) onTimeCnt++; else lateCnt++; }
        continue;

      } else if (status === 'on-leave' || status === 'lwp') {
        // ── On Leave / LWP — no punch expected ────────────────────────────
        try { ws.mergeCells(row, col, row, col+1); } catch(ex){}
        inC.value = status==='lwp' ? '💸 LWP' : '🏖 EL';
        inC.font  = {bold:true,size:8,color:{argb:'FF1A237E'}};
        inC.fill  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFE8EAF6'}};
        inC.alignment = {horizontal:'center',vertical:'middle'};
        inC.border = {right:{style:'hair'},bottom:{style:'hair'}};
        continue;

      } else if (status === 'half-day') {
        // ── Half Day — has punch-in, punch-out is early ───────────────────
        if (punch.in) {
          const inH=punch.inH, inM=punch.inM;
          const isOnTime=(inH<10)||(inH===10&&inM<=30);
          inC.value=punch.in;
          inC.font={bold:true,size:8,color:{argb:isOnTime?'FF1B5E20':'FFE65100'}};
          inC.fill={type:'pattern',pattern:'solid',fgColor:{argb:isOnTime?'FFE8F5E9':'FFFFF3E0'}};
          totalPunched++; if(isOnTime) onTimeCnt++; else lateCnt++;
          outC.value = punch.out || '½';
          outC.font  = {bold:true,size:8,color:{argb:'FF6A1B9A'}};
          outC.fill  = {type:'pattern',pattern:'solid',fgColor:{argb:'FFF3E5F5'}};
        } else {
          // Half day with no punch recorded
          try { ws.mergeCells(row, col, row, col+1); } catch(ex){}
          inC.value='½ DAY'; inC.font={bold:true,size:8,color:{argb:'FF6A1B9A'}};
          inC.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF3E5F5'}};
          inC.alignment={horizontal:'center',vertical:'middle'};
          inC.border={right:{style:'hair'},bottom:{style:'hair'}};
          continue;
        }

      } else if (status === 'missing_punch_out') {
        // ── Missing Punch Out — has IN, no OUT ────────────────────────────
        const inH=punch.inH, inM=punch.inM;
        const isOnTime=(inH<10)||(inH===10&&inM<=30);
        inC.value=punch.in||'?';
        inC.font={bold:true,size:8,color:{argb:isOnTime?'FF1B5E20':'FFE65100'}};
        inC.fill={type:'pattern',pattern:'solid',fgColor:{argb:isOnTime?'FFE8F5E9':'FFFFF3E0'}};
        if(punch.in){totalPunched++; if(isOnTime) onTimeCnt++; else lateCnt++;}
        outC.value='MPO';
        outC.font={bold:true,size:8,color:{argb:'FFFFFFFF'}};
        outC.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFF6F00'}};

      } else if (punch.in) {
        // ── Normal present / late — has punch in ─────────────────────────
        const inH=punch.inH, inM=punch.inM;
        const isOnTime=(inH<10)||(inH===10&&inM<=30);
        const inBg=isOnTime?'FFE8F5E9':'FFFFF3E0';
        const inFg=isOnTime?'FF1B5E20':'FFE65100';
        inC.value=punch.in;
        inC.font={bold:true,size:8,color:{argb:inFg}};
        inC.fill={type:'pattern',pattern:'solid',fgColor:{argb:inBg}};
        totalPunched++; if(isOnTime) onTimeCnt++; else lateCnt++;

        if (punch.out) {
          const outH=punch.outH,outM=punch.outM;
          const isFullDay=(outH>18)||(outH===18&&outM>=30);
          outC.value=punch.out;
          outC.font={bold:true,size:8,color:{argb:isFullDay?'FF0D47A1':'FF6A1B9A'}};
          outC.fill={type:'pattern',pattern:'solid',fgColor:{argb:isFullDay?'FFE3F2FD':'FFF3E5F5'}};
        } else {
          // Punched in but no punch out (shouldn't happen after MPO fix, but safety net)
          outC.value='—';
          outC.font={bold:true,size:8,color:{argb:'FFBDBDBD'}};
          outC.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFDE8E8'}};
        }

      } else {
        // ── No record for this working day ────────────────────────────────
        inC.value=''; outC.value='';
        inC.fill=outC.fill={type:'pattern',pattern:'solid',fgColor:{argb:rowBg}};
      }

      [inC, outC].forEach(c => {
        c.alignment={horizontal:'center',vertical:'middle'};
        c.border={right:{style:'hair'},bottom:{style:'hair'}};
      });
    }

    // Summary cells
    [[totalPunched,'FF00695C'],[onTimeCnt,'FF2E7D32'],[lateCnt,'FFE65100']].forEach(([v,fg],i) => {
      const c = ws.getCell(row, 3+daysInMonth*2+1+i);
      c.value=v||'';
      c.font={bold:true,size:9,color:{argb:v>0?fg:'FFBDBDBD'}};
      c.fill={type:'pattern',pattern:'solid',fgColor:{argb:rowBg}};
      c.alignment={horizontal:'center',vertical:'middle'};
      c.border={right:{style:'thin'},bottom:{style:'hair'}};
    });

    ws.getRow(row).height=18;
  });

  return ws;
}

exports.exportMasterExcel = async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    // ── 1. Employees + salary structure ─────────────────────────────────────
    const empResult = await db.query(`
      SELECT e.id, e.employee_code, e.first_name, e.last_name, e.email, e.phone,
             e.gender, e.date_of_birth, e.joining_date,
             d.name AS department, des.title AS designation,
             e.role, e.employment_type, e.employee_category, e.level,
             e.city, e.state,
             COALESCE(e.saturday_policy, '2nd_4th_off') AS saturday_policy,
             e.pan_number, e.aadhar_number, e.uan_number, e.pf_number,
             e.bank_name, e.bank_account, e.bank_ifsc,
             CONCAT(m.first_name,' ',m.last_name) AS reporting_manager,
             COALESCE(s.basic,e.basic_salary,0)         AS basic,
             COALESCE(s.hra,e.hra,0)                    AS hra,
             COALESCE(s.conveyance,e.conveyance,0)      AS conveyance,
             COALESCE(s.special_allowance,e.special_allowance,0) AS special_allowance,
             COALESCE(s.gratuity,0)                     AS gratuity,
             COALESCE(s.gross_salary,0)                 AS gross_salary,
             COALESCE(s.pf_employee,0)                  AS pf_employee,
             COALESCE(s.pf_employer,0)                  AS pf_employer,
             COALESCE(s.pf_admin,0)                     AS pf_admin,
             COALESCE(s.esi_employee,0)                 AS esi_employee,
             COALESCE(s.esi_employer,0)                 AS esi_employer,
             COALESCE(s.professional_tax,0)             AS professional_tax,
             COALESCE(s.lwf,0)                          AS lwf,
             COALESCE(s.tds,0)                          AS tds,
             COALESCE(s.total_deductions,0)             AS total_deductions,
             COALESCE(s.net_salary,0)                   AS net_salary,
             COALESCE(s.ctc_monthly,0)                  AS ctc_monthly,
             COALESCE(s.ctc_annual,e.ctc,0)             AS ctc_annual,
             e.is_active,
             e.deactivation_remark,
             e.separation_date,
             e.is_wfh_permanent
      FROM employees e
      LEFT JOIN departments  d   ON e.department_id  = d.id
      LEFT JOIN designations des ON e.designation_id = des.id
      LEFT JOIN employees    m   ON e.reporting_manager_id = m.id
      LEFT JOIN employee_salary_structure s ON s.employee_id = e.id
      WHERE (
        e.is_active = true
        OR (
          -- Include employees deactivated this month or later
          e.is_active = false
          AND (
            e.separation_date IS NULL
            OR e.separation_date >= MAKE_DATE($1::int, $2::int, 1)
          )
          AND EXISTS (
            SELECT 1 FROM attendance a
            WHERE a.employee_id = e.id
              AND EXTRACT(MONTH FROM a.date) = $2
              AND EXTRACT(YEAR  FROM a.date) = $1
          )
        )
        OR (
          -- Include future-LWD completed separations
          EXISTS (
            SELECT 1 FROM separations sep
            WHERE sep.employee_id = e.id AND sep.status = 'completed'
            AND sep.last_working_date >= MAKE_DATE($1::int, $2::int, 1)
          )
        )
      )
      ORDER BY
        CASE WHEN e.is_active = false THEN 2
             WHEN COALESCE(e.saturday_policy,'2nd_4th_off') = 'all_working' THEN 1
             ELSE 0 END,
        d.name, e.first_name`, [y, m]);
    const employees = empResult.rows;

    // ── 2. Attendance for the month ─────────────────────────────────────────
    const attResult = await db.query(`
      SELECT employee_id, TO_CHAR(date, 'YYYY-MM-DD') AS date_str, status, working_hours,
             punch_in, punch_out
      FROM attendance
      WHERE EXTRACT(MONTH FROM date) = $1 AND EXTRACT(YEAR FROM date) = $2`,
      [m, y]);

    const attMap = {};
    const punchMap = {}; // For punch-in/out counts per employee
    for (const row of attResult.rows) {
      if (!attMap[row.employee_id]) attMap[row.employee_id] = {};
      attMap[row.employee_id][row.date_str] = row.status;
      if (!punchMap[row.employee_id]) punchMap[row.employee_id] = { punchIn: 0, punchOut: 0, missingPunchOut: 0 };
      if (row.punch_in)  punchMap[row.employee_id].punchIn++;
      if (row.punch_out) punchMap[row.employee_id].punchOut++;
      if (row.punch_in && !row.punch_out) punchMap[row.employee_id].missingPunchOut++;
    }

    const daysInMonth = new Date(y, m, 0).getDate();

    // ── Holidays for this month (both regions) — used in Sheet 1 + Sheet 2 ──
    const holResult = await db.query(`
      SELECT TO_CHAR(date,'YYYY-MM-DD') AS date_str, region
      FROM holidays
      WHERE EXTRACT(MONTH FROM date) = $1 AND EXTRACT(YEAR FROM date) = $2`,
      [m, y]);
    const holidaysByRegion = { all: new Set(), north: new Set(), south_west: new Set() };
    for (const h of holResult.rows) {
      if (h.region === 'all') { holidaysByRegion.all.add(h.date_str); holidaysByRegion.north.add(h.date_str); holidaysByRegion.south_west.add(h.date_str); }
      else if (h.region === 'north') holidaysByRegion.north.add(h.date_str);
      else if (h.region === 'south_west') holidaysByRegion.south_west.add(h.date_str);
    }

    // ── Status → display label & color ──────────────────────────────────────
    const STATUS_STYLE = {
      'present':     { label: 'P',    bg: '00C853', fg: 'FFFFFF' }, // green
      'late':        { label: 'L',    bg: 'FFD600', fg: '000000' }, // yellow
      'absent':      { label: 'A',    bg: 'D50000', fg: 'FFFFFF' }, // red
      'missing_punch_out': { label: 'MPO', bg: 'FF6F00', fg: 'FFFFFF' }, // amber — punched in, no punch out
      'on-leave':    { label: 'EL',   bg: '2962FF', fg: 'FFFFFF' }, // blue
      'lwp':         { label: 'LWP',  bg: 'FF6D00', fg: 'FFFFFF' }, // orange
      'half-day':    { label: 'H',    bg: 'AA00FF', fg: 'FFFFFF' }, // purple
      'h-el':        { label: 'H-EL', bg: '7B1FA2', fg: 'FFFFFF' }, // dark purple
      'h-cl':        { label: 'H-CL', bg: '880E4F', fg: 'FFFFFF' }, // pink-purple
      'h-sl':        { label: 'H-SL', bg: 'AD1457', fg: 'FFFFFF' }, // pink
      'h-lwp':       { label: 'H-LWP',bg: 'BF360C', fg: 'FFFFFF' }, // dark orange
      'h-wfh':       { label: 'H-WFH',bg: '00897B', fg: 'FFFFFF' }, // teal
      'od':          { label: 'OD',   bg: '00BCD4', fg: 'FFFFFF' }, // cyan
      'wfh':         { label: 'WFH',  bg: '80CBC4', fg: '000000' }, // teal
      'regularized': { label: 'R',    bg: '558B2F', fg: 'FFFFFF' }, // dark green
      'holiday':     { label: 'HOL',  bg: 'CFD8DC', fg: '37474F' }, // grey
      'weekend':     { label: 'WO',   bg: 'ECEFF1', fg: '90A4AE' }, // light grey
    };

    const wb = new ExcelJS.Workbook();
    wb.creator = 'HRMS';
    wb.created = new Date();

    // ════════════════════════════════════════════════════════════════════════
    // SHEET 1 — ATTENDANCE REGISTER
    // ════════════════════════════════════════════════════════════════════════
    const ws1 = wb.addWorksheet(`Attendance ${MONTH_NAMES[m-1]} ${y}`, {
      views: [{ state: 'frozen', xSplit: 5, ySplit: 2 }]
    });

    // ── Header row 1: Title ─────────────────────────────────────────────────
    const totalCols = 5 + daysInMonth + 9; // info + days + totals (9 summary cols)
    try { ws1.mergeCells(1, 1, 1, totalCols); } catch(_) {}
    const titleCell = ws1.getCell(1, 1);
    titleCell.value = `HRMS — Attendance Register | ${MONTH_NAMES[m-1]} ${y}`;
    titleCell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B5E20' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws1.getRow(1).height = 28;

    // ── Header row 2: Columns ───────────────────────────────────────────────
    const infoHeaders = ['Emp Code', 'Name', 'Department', 'Designation', 'Category'];
    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E7D32' } };
    const headerFont = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    const headerAlign = { horizontal: 'center', vertical: 'middle', wrapText: true };

    infoHeaders.forEach((h, i) => {
      const cell = ws1.getCell(2, i + 1);
      cell.value = h;
      cell.font = headerFont;
      cell.fill = headerFill;
      cell.alignment = headerAlign;
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
    });

    // Day headers with day-of-week
    const dayNames = ['Su','Mo','Tu','We','Th','Fr','Sa'];
    let satCountHdr = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      if (dow === 6) satCountHdr++;
      const isSunday = dow === 0;
      const is2nd4thSat = dow === 6 && (satCountHdr === 2 || satCountHdr === 4);
      const isWeekOff = isSunday || is2nd4thSat;
      const cell = ws1.getCell(2, 5 + d);
      cell.value = `${d}\n${dayNames[dow]}`;
      cell.font = { bold: true, size: 9, color: { argb: isWeekOff ? 'FFFF1744' : 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isWeekOff ? 'FF880E4F' : 'FF2E7D32' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
    }

    // Total headers
    [
      { h: 'Paid Leave',      bg: 'FF2E7D32' },
      { h: 'Unpaid Leave',    bg: 'FFC62828' },
      { h: 'Paid Half Day',   bg: 'FF6A1B9A' },
      { h: 'Unpaid Half Day', bg: 'FFE65100' },
      { h: 'Total Paid',      bg: 'FF1565C0' },
      { h: 'Total Unpaid',    bg: 'FF880E4F' },
      { h: 'Total Absent',    bg: 'FFD50000' },
      { h: 'Late',            bg: 'FFF57F17' },
      { h: 'Total Present',   bg: 'FF00695C' },
    ].forEach(({ h, bg }, i) => {
      const cell = ws1.getCell(2, 5 + daysInMonth + 1 + i);
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 8 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    ws1.getRow(2).height = 30;

    // ── Data rows — with ONSITE / OFFSITE / DEACTIVATED group separators ────
    let masterLastGroup = null;
    let masterGroupOffset = 0;

    employees.forEach((e, ri) => {
      const isDeactivated = e.is_active === false;
      const isOffsite     = !isDeactivated && e.saturday_policy === 'all_working';
      const group = isDeactivated ? 'deactivated' : isOffsite ? 'offsite' : 'onsite';

      // ── Insert group separator row when group changes ─────────────────────
      if (group !== masterLastGroup) {
        const sepRow = ri + 3 + masterGroupOffset;
        masterGroupOffset++;
        const groupLabel = group === 'onsite'  ? '🏢 ONSITE EMPLOYEES'
                         : group === 'offsite' ? '🌐 OFFSITE EMPLOYEES'
                         :                       '❌ DEACTIVATED EMPLOYEES';
        const groupBg    = group === 'onsite'  ? 'FF1B5E20'
                         : group === 'offsite' ? 'FF0D47A1'
                         :                      'FF4A0000';
        try { ws1.mergeCells(sepRow, 1, sepRow, totalCols); } catch(_) {}
        const sc = ws1.getCell(sepRow, 1);
        sc.value = groupLabel;
        sc.font  = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
        sc.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: groupBg } };
        sc.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
        ws1.getRow(sepRow).height = 18;
        masterLastGroup = group;
      }

      const row    = ri + 3 + masterGroupOffset;
      const isAlt  = ri % 2 === 1;
      const rowBg  = isDeactivated ? (isAlt ? 'FFFFF5F5' : 'FFFFFFEE')
                   : isOffsite     ? (isAlt ? 'FFE3F2FD' : 'FFFFFFFF')
                   :                 (isAlt ? 'FFF1F8E9' : 'FFFFFFFF');

      // Info cells
      [e.employee_code, `${e.first_name} ${e.last_name||''}`.trim(),
       e.department||'', e.designation||'', e.employee_category||''].forEach((v, ci) => {
        const cell = ws1.getCell(row, ci + 1);
        cell.value = v;
        cell.font = { size: 9, color: { argb: isDeactivated ? 'FF9E0000' : 'FF000000' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
        cell.alignment = { vertical: 'middle' };
        cell.border = { right: { style: 'hair' }, bottom: { style: 'hair' } };
      });

      let attPaidLeave = 0, attUnpaidLeave = 0, attPaidHalfDay = 0, attUnpaidHalfDay = 0;
      let attLate = 0, attAbsent = 0, attPresent = 0;
      let satCountRow = 0;
      const empIsOffsite2 = e.saturday_policy === 'all_working';
      const empReg2 = getEmployeeRegion(e.city || '', e.state || '');
      const empHolSet2 = empReg2 === 'north' ? holidaysByRegion.north : holidaysByRegion.south_west;

      if (isDeactivated) {
        // ── Deactivated: show actual attendance then merge remaining with remark
        const empAttDays2 = Object.keys(attMap[e.id] || {})
          .map(ds => parseInt(ds.split('-')[2]))
          .filter(d => d >= 1 && d <= daysInMonth);
        const lastAttDay2 = empAttDays2.length ? Math.max(...empAttDays2) : 0;
        let satDeact = 0;
        for (let d = 1; d <= daysInMonth; d++) {
          const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          const dow2 = new Date(y, m-1, d).getDay();
          if (dow2 === 6) satDeact++;
          const isWO2 = dow2 === 0 || (!empIsOffsite2 && dow2 === 6 && (satDeact===2||satDeact===4));
          if (d <= lastAttDay2) {
            let status2 = isWO2 ? 'weekend' : (empHolSet2.has(dateStr) && !((attMap[e.id]||{})[dateStr]) ? 'holiday' : ((attMap[e.id]||{})[dateStr]||''));
            const style2 = STATUS_STYLE[status2] || { label: '', bg: 'FFF5F5', fg: '9E0000' };
            const cell2  = ws1.getCell(row, 5 + d);
            cell2.value = style2.label;
            cell2.font  = { bold: true, size: 8, color: { argb: 'FF' + style2.fg } };
            cell2.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + style2.bg } };
            cell2.alignment = { horizontal: 'center', vertical: 'middle' };
            cell2.border = { right: { style: 'hair' }, bottom: { style: 'hair' } };
          }
        }
        if (lastAttDay2 < daysInMonth) {
          try { ws1.unMergeCells(row, 5+lastAttDay2+1, row, 5+daysInMonth); } catch(_){}
          try { ws1.mergeCells(row, 5 + lastAttDay2 + 1, row, 5 + daysInMonth); } catch(_) {}
          const rc = ws1.getCell(row, 5 + lastAttDay2 + 1);
          rc.value = e.deactivation_remark ? `❌ TERMINATED — ${e.deactivation_remark}` : `❌ Account deactivated${e.separation_date?' on '+e.separation_date:''}`;
          rc.font  = { bold: true, size: 8, color: { argb: 'FFB71C1C' }, italic: true };
          rc.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3F3' } };
          rc.alignment = { horizontal: 'left', vertical: 'middle' };
          rc.border = { right: { style: 'medium', color: { argb: 'FFEF9A9A' } }, bottom: { style: 'hair' } };
        }
      } else {
        // ── Active employee — normal attendance cells ──────────────────────
        for (let d = 1; d <= daysInMonth; d++) {
          const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          const dow = new Date(y, m - 1, d).getDay();
          if (dow === 6) satCountRow++;
          const is2nd4thSat = !empIsOffsite2 && dow === 6 && (satCountRow === 2 || satCountRow === 4);
          const isWeekOff   = dow === 0 || is2nd4thSat;
          let status = isWeekOff ? 'weekend'
            : (empHolSet2.has(dateStr) && !((attMap[e.id]||{})[dateStr]) ? 'holiday'
            : ((attMap[e.id]||{})[dateStr]||''));
          const style = STATUS_STYLE[status] || { label: '', bg: isAlt ? 'F1F8E9' : 'FFFFFF', fg: '000000' };
          const cell  = ws1.getCell(row, 5 + d);
          cell.value = style.label;
          cell.font  = { bold: true, size: 8, color: { argb: 'FF' + style.fg } };
          cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + style.bg } };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          cell.border = { right: { style: 'hair' }, bottom: { style: 'hair' } };
          if (!isWeekOff) {
            if (['present','regularized','od','wfh','holiday'].includes(status)) attPresent++;
            else if (status === 'late')     { attPresent++; attLate++; }
            else if (status === 'on-leave') { attPaidLeave++; attPresent++; }
            else if (['half-day','h-el','h-cl','h-sl','h-wfh'].includes(status)) { attPaidHalfDay++; attPresent++; }
            else if (status === 'h-lwp')   attUnpaidHalfDay++;
            else if (status === 'lwp')     attUnpaidLeave++;
            else if (status === 'absent')  attAbsent++;
          }
        }
      }

      const attTotalPaid   = attPresent;
      const attTotalUnpaid = attUnpaidLeave + attUnpaidHalfDay;
      [
        [attPaidLeave,     'FF2E7D32'],
        [attUnpaidLeave,   'FFC62828'],
        [attPaidHalfDay,   'FF6A1B9A'],
        [attUnpaidHalfDay, 'FFE65100'],
        [attTotalPaid,     'FF1565C0'],
        [attTotalUnpaid,   'FF880E4F'],
        [attAbsent,        'FFD50000'],
        [attLate,          'FFF57F17'],
        [attPresent,       'FF00695C'],
      ].forEach(([v, color], i) => {
        const cell = ws1.getCell(row, 5 + daysInMonth + 1 + i);
        cell.value = v;
        cell.font  = { bold: true, size: 9, color: { argb: color } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
        cell.border = { right: { style: 'thin' }, bottom: { style: 'hair' } };
      });

      ws1.getRow(row).height = 18;
    });


    // Column widths — attendance sheet
    ws1.getColumn(1).width = 10;
    ws1.getColumn(2).width = 20;
    ws1.getColumn(3).width = 14;
    ws1.getColumn(4).width = 20;
    ws1.getColumn(5).width = 12;
    for (let d = 1; d <= daysInMonth; d++) ws1.getColumn(5 + d).width = 5;
    for (let i = 1; i <= 9; i++) ws1.getColumn(5 + daysInMonth + i).width = 10;

    // ── Legend row ──────────────────────────────────────────────────────────
    const legendRow = employees.length + 4 + masterGroupOffset;
    try { ws1.mergeCells(legendRow, 1, legendRow, totalCols); } catch(_) {}
    const legendCell = ws1.getCell(legendRow, 1);
    legendCell.value = 'LEGEND:  P=Present  A=Absent  L=Late  EL=Paid Leave (CL/SL/EL) — counts as Present for salary  LWP=Unpaid Leave  H=Half Day  H-EL=Half EL  H-CL=Half CL  H-SL=Half SL  H-LWP=Half LWP (Unpaid)  H-WFH=Half WFH  OD=On Duty  WFH=Work From Home  R=Regularized  WO=Week Off  HOL=Holiday';
    legendCell.font = { italic: true, size: 8, color: { argb: 'FF37474F' } };
    legendCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECEFF1' } };
    legendCell.alignment = { horizontal: 'left', vertical: 'middle' };
    ws1.getRow(legendRow).height = 16;

    // ════════════════════════════════════════════════════════════════════════
    // SHEET 2 — SALARY BREAKUP
    // ════════════════════════════════════════════════════════════════════════
    const ws2 = wb.addWorksheet('Salary Breakup', {
      views: [{ state: 'frozen', xSplit: 4, ySplit: 2 }]
    });

    // Title
    const salCols = 34;
    try { ws2.mergeCells(1, 1, 1, salCols); } catch(_) {}
    const salTitle = ws2.getCell(1, 1);
    salTitle.value = `HRMS — Salary Breakup | ${MONTH_NAMES[m-1]} ${y}`;
    salTitle.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    salTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D47A1' } };
    salTitle.alignment = { horizontal: 'center', vertical: 'middle' };
    ws2.getRow(1).height = 28;

    // Group headers
    const groups = [
      { label: 'EMPLOYEE INFO',          cols: 4,  color: 'FF1565C0' },
      { label: 'EARNINGS',               cols: 6,  color: 'FF2E7D32' },
      { label: 'EMPLOYEE DEDUCTIONS',    cols: 6,  color: 'FFC62828' },
      { label: 'EMPLOYER CONTRIBUTIONS', cols: 4,  color: 'FF6A1B9A' },
      { label: 'ATTENDANCE & TOTALS',    cols: 14, color: 'FF37474F' },
    ];
    let colOffset = 1;
    groups.forEach(g => {
      try { ws2.mergeCells(2, colOffset, 2, colOffset + g.cols - 1); } catch(_) {}
      const cell = ws2.getCell(2, colOffset);
      cell.value = g.label;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: g.color } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      colOffset += g.cols;
    });
    ws2.getRow(2).height = 22;

    // salHeaders column headers (holidaysByRegion already fetched above for Sheet 1)

    // Fetch active advance EMIs for this month
    const advResult = await db.query(`
      SELECT employee_id, SUM(monthly_emi) AS total_emi
      FROM advance_salary
      WHERE status IN ('approved')
        AND auto_deduct = TRUE
        AND (
          (emi_start_year < $2) OR
          (emi_start_year = $2 AND emi_start_month <= $1)
        )
        AND (
          (emi_end_year > $2) OR
          (emi_end_year = $2 AND emi_end_month >= $1) OR
          (emi_end_year IS NULL)
        )
        AND balance_remaining > 0
      GROUP BY employee_id`,
      [m, y]);

    const emiMap = {};
    for (const row of advResult.rows) {
      emiMap[row.employee_id] = parseFloat(row.total_emi) || 0;
    }

    const salHeaders = [
      // EMPLOYEE INFO (4)
      'Emp Code','Name','Department','Designation',
      // EARNINGS (6)
      'Basic','HRA','Conveyance','Special Allow','Gratuity','Gross Salary',
      // EMPLOYEE DEDUCTIONS (6): PF, ESI, PT, TDS, Advance EMI, Total
      'PF (Emp)','ESI (Emp)','Prof Tax','TDS','Advance EMI','Total Deductions',
      // EMPLOYER CONTRIBUTIONS (4)
      'PF (Employer)','ESI (Employer)','PF Admin','Total Employer Cost',
      // ATTENDANCE & TOTALS (14)
      'Paid Leave','Unpaid Leave','Paid Half Day','Unpaid Half Day',
      'Present Days','Working Days','LOP Days',
      'Punch-In Count','Punch-Out Count','Missed Punch-Out',
      'Earned Gross','Earned Net','Advance EMI','Net Payable'
    ];
    const subHeaderColors = [
      'FF1565C0','FF1565C0','FF1565C0','FF1565C0',
      'FF388E3C','FF388E3C','FF388E3C','FF388E3C','FF388E3C','FF1B5E20',
      'FFE53935','FFE53935','FFE53935','FFE53935','FFB71C1C','FF7F0000',
      'FF8E24AA','FF8E24AA','FF8E24AA','FF4A148C',
      'FF2E7D32','FFC62828','FF6A1B9A','FFE65100',
      'FF00695C','FF004D40','FFB71C1C',
      'FF01579B','FF006064','FFB71C1C',  // Punch-In, Punch-Out, Missed Punch-Out
      'FF006064','FF004D40','FFE65100','FF1B5E20'
    ];
    salHeaders.forEach((h, i) => {
      const cell = ws2.getCell(3, i + 1);
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: subHeaderColors[i] } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
    });
    ws2.getRow(3).height = 32;

    // Salary data rows
    employees.forEach((e, ri) => {
      const row = ri + 4;
      const isAlt = ri % 2 === 1;
      const bgColor = isAlt ? 'FFE8EAF6' : 'FFFFFFFF';

      // Count present/absent/half days for salary calculation
      // Rules:
      //   present/late/od/wfh/regularized/holiday/on-leave → fully paid, presentDays++
      //   half-day / h-el / h-cl / h-sl / h-wfh            → PAID half day (leave balance used): 0.5 present paid, 0.5 day leave paid → full day paid (presentDays += 0.5 only, lopDays += 0)
      //   h-lwp                                             → UNPAID half day: 0.5 day present + 0.5 day LOP (presentDays += 0.5, lopDays += 0.5)
      //   lwp                                               → full day LOP
      //   absent (weekday)                                  → full day LOP
      let presentDays = 0, lopDays = 0;
      let salPaidLeave = 0, salUnpaidLeave = 0, salPaidHalfDay = 0, salUnpaidHalfDay = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const dow = new Date(y, m - 1, d).getDay();
        const status = (attMap[e.id] || {})[dateStr] || '';
        if (['present','late','regularized','od','wfh'].includes(status)) {
          // Fully paid work statuses
          presentDays++;
        } else if (status === 'holiday') {
          // Public holiday — paid day off
          presentDays++;
        } else if (status === 'on-leave') {
          // Full paid leave (EL/CL/SL with balance) — fully paid
          presentDays++;
          salPaidLeave++;
        } else if (['half-day','h-el','h-cl','h-sl','h-wfh'].includes(status)) {
          // Paid half day — employee worked 0.5, leave covers 0.5 → full day paid
          presentDays += 0.5;
          salPaidHalfDay++;
        } else if (status === 'h-lwp') {
          // Unpaid half day — employee worked 0.5, other 0.5 is LOP
          presentDays += 0.5;
          lopDays += 0.5;
          salUnpaidHalfDay++;
        } else if (status === 'lwp') {
          // Full unpaid leave — full LOP
          lopDays += 1;
          salUnpaidLeave++;
        } else if ((status === 'absent' || status === 'missing_punch_out') && dow !== 0 && dow !== 6) {
          // Absent / missed punch-out on a weekday — full LOP
          lopDays++;
        }
      }

      // Working days — always full month (salary is calculated for full month)
      // Subtract regional holidays (national + region-specific)
      const empRegion = getEmployeeRegion(e.city || '', e.state || '');
      const empHolidays = empRegion === 'north' ? holidaysByRegion.north : holidaysByRegion.south_west;

      let workingDays = 0, satCount = 0;
      const isOffsite = e.saturday_policy === 'all_working';
      for (let d = 1; d <= daysInMonth; d++) {
        const dow = new Date(y, m - 1, d).getDay();
        if (dow === 6) satCount++;
        const is2nd4thSat = !isOffsite && dow === 6 && (satCount === 2 || satCount === 4);
        const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const isHoliday = empHolidays.has(dateStr);
        if (dow !== 0 && !is2nd4thSat && !isHoliday) workingDays++;
      }

      // Salary figures — USE EXACTLY WHAT HR DEFINED IN DB, NO RECALCULATION
      const basic      = parseFloat(e.basic)             || 0;
      const hra        = parseFloat(e.hra)               || 0;
      const conveyance = parseFloat(e.conveyance)        || 0;
      const special    = parseFloat(e.special_allowance) || 0;
      const gratuity   = parseFloat(e.gratuity)          || 0;
      const gross      = parseFloat(e.gross_salary)      || 0;
      const pfEmp      = parseFloat(e.pf_employee)       || 0;
      const esiEmp     = parseFloat(e.esi_employee)      || 0;
      const pt         = parseFloat(e.professional_tax)  || 0;
      const lwf        = parseFloat(e.lwf)               || 0;
      const tds        = parseFloat(e.tds)               || 0;
      const pfEmr      = parseFloat(e.pf_employer)       || 0;
      const esiEmr     = parseFloat(e.esi_employer)      || 0;
      const pfAdm      = parseFloat(e.pf_admin)          || 0;
      // Remove LWF from total deductions (LWF column removed per HR instruction)
      const totalDed   = Math.max(0, (parseFloat(e.total_deductions) || 0) - lwf);
      // netFull = gross - deductions without LWF
      const netFull    = gross - totalDed;

      // EMI for this employee this month
      const emiDeduction = emiMap[e.id] || 0;

      // earnedGross = proportional gross based on attendance
      // earnedNet   = proportional net (after statutory deductions from DB)
      // netPayable  = earnedNet - EMI (EMI deducted only once here)
      const earnedGross = workingDays > 0 ? Math.round((gross    * presentDays) / workingDays) : 0;
      const earnedNet   = workingDays > 0 ? Math.round((netFull  * presentDays) / workingDays) : 0;
      const netPayable  = Math.max(0, earnedNet - emiDeduction);

      const empPunch = punchMap[e.id] || { punchIn: 0, punchOut: 0, missingPunchOut: 0 };

      const values = [
        e.employee_code, `${e.first_name} ${e.last_name||''}`.trim(),
        e.department||'', e.designation||'',
        basic, hra, conveyance, special, gratuity, gross,
        // Deductions — statutory only (from DB), then EMI separately, then total
        pfEmp, esiEmp, pt, tds, emiDeduction, totalDed,
        pfEmr, esiEmr, pfAdm, pfEmr + esiEmr + pfAdm,
        salPaidLeave, salUnpaidLeave, salPaidHalfDay, salUnpaidHalfDay,
        presentDays, workingDays, lopDays,
        empPunch.punchIn, empPunch.punchOut, empPunch.missingPunchOut,
        earnedGross, earnedNet, emiDeduction, netPayable
      ];

      values.forEach((v, ci) => {
        const cell = ws2.getCell(row, ci + 1);
        cell.value = v;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
        cell.border = { right: { style: 'hair' }, bottom: { style: 'hair' } };
        cell.font = { size: 9 };
        if (ci >= 4) {
          cell.numFmt = (ci >= 20 && ci <= 23) ? '0' : (ci >= 24 && ci <= 29) ? '0.0' : '₹#,##0.00';
          cell.alignment = { horizontal: 'right', vertical: 'middle' };
          // Net Payable (col index 33) — bold green
          if (ci === 33) {
            cell.font = { bold: true, size: 10, color: { argb: 'FF1B5E20' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isAlt ? 'FFC8E6C9' : 'FFE8F5E9' } };
          }
          // Missed Punch-Out (col index 29) — red if > 0
          if (ci === 29 && v > 0) {
            cell.font = { bold: true, size: 9, color: { argb: 'FFD50000' } };
          }
          // Advance EMI cols (index 14 = deduction col, index 32 = totals col) — orange if > 0
          if ((ci === 14 || ci === 32) && v > 0) {
            cell.font = { bold: true, size: 9, color: { argb: 'FFE65100' } };
          }
        } else {
          cell.alignment = { vertical: 'middle' };
        }
      });
      ws2.getRow(row).height = 16;
    });

    // Column widths — 34 columns (added Punch-In Count, Punch-Out Count, Missed Punch-Out)
    [10,22,14,22, 12,10,12,14,10,13, 10,10,9,10,12,15, 13,13,10,16, 10,10,10,10, 10,11,9, 11,12,13, 13,13,11,14].forEach((w, i) => {
      ws2.getColumn(i + 1).width = w;
    });

    // ════════════════════════════════════════════════════════════════════════
    // SHEET 3 — EMPLOYEE DIRECTORY
    // ════════════════════════════════════════════════════════════════════════
    const ws3 = wb.addWorksheet('Employee Directory', {
      views: [{ state: 'frozen', xSplit: 3, ySplit: 2 }]
    });

    try { ws3.mergeCells(1, 1, 1, 20); } catch(_) {}
    const dirTitle = ws3.getCell(1, 1);
    dirTitle.value = `HRMS — Employee Directory | Generated ${new Date().toLocaleDateString('' + (CONFIG.currencyLocale||'en-IN') + "'")}`;
    dirTitle.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
    dirTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4E342E' } };
    dirTitle.alignment = { horizontal: 'center', vertical: 'middle' };
    ws3.getRow(1).height = 26;

    const dirHeaders = ['Emp Code','Name','Email','Phone','Gender','DOB','Joining Date',
      'Department','Designation','Role','Category','Level','City','State',
      'PAN','Aadhar','UAN','PF No','Bank','Account','IFSC','Manager'];
    dirHeaders.forEach((h, i) => {
      const cell = ws3.getCell(2, i + 1);
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6D4C41' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    ws3.getRow(2).height = 22;

    employees.forEach((e, ri) => {
      const row = ri + 3;
      const isAlt = ri % 2 === 1;
      const vals = [
        e.employee_code, `${e.first_name} ${e.last_name||''}`.trim(), e.email, e.phone||'',
        e.gender||'',
        e.date_of_birth ? toISTDateString(new Date(e.date_of_birth)) : '',
        e.joining_date  ? toISTDateString(new Date(e.joining_date))  : '',
        e.department||'', e.designation||'', e.role, e.employee_category||'', e.level||'',
        e.city||'', e.state||'',
        e.pan_number||'', e.aadhar_number||'', e.uan_number||'', e.pf_number||'',
        e.bank_name||'', e.bank_account||'', e.bank_ifsc||'', e.reporting_manager||''
      ];
      vals.forEach((v, ci) => {
        const cell = ws3.getCell(row, ci + 1);
        cell.value = v;
        cell.font = { size: 9 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isAlt ? 'FFFBE9E7' : 'FFFFFFFF' } };
        cell.alignment = { vertical: 'middle' };
        cell.border = { right: { style: 'hair' }, bottom: { style: 'hair' } };
      });
      ws3.getRow(row).height = 16;
    });

    [10,22,28,13,8,12,12,16,22,10,12,7,14,14,14,16,14,18,20,20,13,22].forEach((w, i) => {
      ws3.getColumn(i + 1).width = w;
    });

    // ── Sheet 4: Punch Register ───────────────────────────────────────────────
    // Fetch punch data for master sheet
    const masterPunchResult = await db.query(`
      SELECT employee_id,
             EXTRACT(DAY FROM date)::int AS day,
             status,
             TO_CHAR(punch_in,  'HH12:MI AM') AS punch_in_fmt,
             TO_CHAR(punch_out, 'HH12:MI AM') AS punch_out_fmt,
             EXTRACT(HOUR   FROM punch_in)::int  AS punch_in_h,
             EXTRACT(MINUTE FROM punch_in)::int  AS punch_in_m,
             EXTRACT(HOUR   FROM punch_out)::int AS punch_out_h,
             EXTRACT(MINUTE FROM punch_out)::int AS punch_out_m,
             working_hours
      FROM attendance
      WHERE EXTRACT(MONTH FROM date) = $1 AND EXTRACT(YEAR FROM date) = $2`,
      [m, y]);
    const masterPunchMap = {};
    for (const row of masterPunchResult.rows) {
      if (!masterPunchMap[row.employee_id]) masterPunchMap[row.employee_id] = {};
      masterPunchMap[row.employee_id][row.day] = {
        in:   row.punch_in_fmt  || '',
        out:  row.punch_out_fmt || '',
        inH:  row.punch_in_h  ?? -1,
        inM:  row.punch_in_m  ?? -1,
        outH: row.punch_out_h ?? -1,
        outM: row.punch_out_m ?? -1,
        status: row.status || '',
        hours: parseFloat(row.working_hours || 0),
      };
    }
    // Fetch master holidays for punch register
    const masterHolResult = await db.query(
      `SELECT TO_CHAR(date,'YYYY-MM-DD') AS date_str, region FROM holidays
       WHERE EXTRACT(MONTH FROM date)=$1 AND EXTRACT(YEAR FROM date)=$2`, [m, y]);
    const masterHolsByRegion = { all: new Set(), north: new Set(), south_west: new Set() };
    for (const h of masterHolResult.rows) {
      if (h.region==='all') { masterHolsByRegion.all.add(h.date_str); masterHolsByRegion.north.add(h.date_str); masterHolsByRegion.south_west.add(h.date_str); }
      else if (h.region==='north') masterHolsByRegion.north.add(h.date_str);
      else if (h.region==='south_west') masterHolsByRegion.south_west.add(h.date_str);
    }
    // Build master employees list with is_active + saturday_policy fields
    const masterEmpForPunch = empResult.rows.map(e => ({
      id: e.id, employee_code: e.employee_code,
      first_name: e.first_name, last_name: e.last_name,
      department: e.department, city: e.city, state: e.state,
      saturday_policy: e.saturday_policy || '2nd_4th_off',
      is_active: e.is_active !== false,
      deactivation_remark: e.deactivation_remark || null,
      separation_date: e.separation_date || null,
    }));
    await buildPunchRegisterSheet(wb, masterEmpForPunch, m, y, MONTH_NAMES, masterPunchMap, masterHolsByRegion, getEmployeeRegion);

    // ── Send response ────────────────────────────────────────────────────────
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Disposition', `attachment; filename="HRMS_Master_${MONTH_NAMES[m-1]}${y}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);

  } catch (err) {
    console.error('[exportMasterExcel]', err.message, err.stack);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// ATTENDANCE REGISTER ONLY — called from Attendance page "Download Attendance"
// Generates ONLY Sheet 1 (Attendance Register) — no salary or directory data
// ════════════════════════════════════════════════════════════════════════════
exports.exportAttendanceRegister = async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    // ── Employees (basic info only — no salary data needed) ─────────────────
    const empResult = await db.query(`
      SELECT e.id, e.employee_code, e.first_name, e.last_name,
             d.name AS department, des.title AS designation,
             e.employee_category,
             COALESCE(e.saturday_policy, '2nd_4th_off') AS saturday_policy,
             e.city, e.state,
             e.is_active,
             e.is_wfh_permanent,
             e.deactivation_remark,
             e.separation_date,
             e.separation_type
      FROM employees e
      LEFT JOIN departments  d   ON e.department_id  = d.id
      LEFT JOIN designations des ON e.designation_id = des.id
      WHERE (
        e.is_active = true
        OR (
          e.is_active = false
          AND (e.separation_date IS NULL OR e.separation_date >= MAKE_DATE($1::int, $2::int, 1))
          AND EXISTS (
            SELECT 1 FROM attendance a
            WHERE a.employee_id = e.id
              AND EXTRACT(MONTH FROM a.date) = $2
              AND EXTRACT(YEAR  FROM a.date) = $1
          )
        )
        OR (
          EXISTS (
            SELECT 1 FROM separations sep
            WHERE sep.employee_id = e.id AND sep.status = 'completed'
            AND sep.last_working_date >= MAKE_DATE($1::int, $2::int, 1)
          )
        )
      )
      ORDER BY
        CASE WHEN e.is_active = false THEN 2
             WHEN COALESCE(e.saturday_policy,'2nd_4th_off') = 'all_working' THEN 1
             ELSE 0 END,
        d.name, e.first_name`, [y, m]);
    const employees = empResult.rows;

    // ── Attendance for the month ─────────────────────────────────────────────
    const attResult = await db.query(`
      SELECT employee_id, TO_CHAR(date, 'YYYY-MM-DD') AS date_str, status
      FROM attendance
      WHERE EXTRACT(MONTH FROM date) = $1 AND EXTRACT(YEAR FROM date) = $2`,
      [m, y]);
    const attMap = {};
    for (const row of attResult.rows) {
      if (!attMap[row.employee_id]) attMap[row.employee_id] = {};
      attMap[row.employee_id][row.date_str] = row.status;
    }

    const daysInMonth = new Date(y, m, 0).getDate();

    // ── Holidays ─────────────────────────────────────────────────────────────
    const holResult = await db.query(`
      SELECT TO_CHAR(date,'YYYY-MM-DD') AS date_str, region
      FROM holidays
      WHERE EXTRACT(MONTH FROM date) = $1 AND EXTRACT(YEAR FROM date) = $2`,
      [m, y]);
    const holidaysByRegion = { all: new Set(), north: new Set(), south_west: new Set() };
    for (const h of holResult.rows) {
      if (h.region === 'all') { holidaysByRegion.all.add(h.date_str); holidaysByRegion.north.add(h.date_str); holidaysByRegion.south_west.add(h.date_str); }
      else if (h.region === 'north') holidaysByRegion.north.add(h.date_str);
      else if (h.region === 'south_west') holidaysByRegion.south_west.add(h.date_str);
    }

    const STATUS_STYLE = {
      'present':     { label: 'P',    bg: '00C853', fg: 'FFFFFF' },
      'late':        { label: 'L',    bg: 'FFD600', fg: '000000' },
      'absent':      { label: 'A',    bg: 'D50000', fg: 'FFFFFF' },
      'missing_punch_out': { label: 'MPO', bg: 'FF6F00', fg: 'FFFFFF' },
      'on-leave':    { label: 'EL',   bg: '2962FF', fg: 'FFFFFF' },
      'lwp':         { label: 'LWP',  bg: 'FF6D00', fg: 'FFFFFF' },
      'half-day':    { label: 'H',    bg: 'AA00FF', fg: 'FFFFFF' },
      'h-el':        { label: 'H-EL', bg: '7B1FA2', fg: 'FFFFFF' },
      'h-cl':        { label: 'H-CL', bg: '880E4F', fg: 'FFFFFF' },
      'h-sl':        { label: 'H-SL', bg: 'AD1457', fg: 'FFFFFF' },
      'h-lwp':       { label: 'H-LWP',bg: 'BF360C', fg: 'FFFFFF' },
      'h-wfh':       { label: 'H-WFH',bg: '00897B', fg: 'FFFFFF' },
      'od':          { label: 'OD',   bg: '00BCD4', fg: 'FFFFFF' },
      'wfh':         { label: 'WFH',  bg: '80CBC4', fg: '000000' },
      'regularized': { label: 'R',    bg: '558B2F', fg: 'FFFFFF' },
      'holiday':     { label: 'HOL',  bg: 'CFD8DC', fg: '37474F' },
      'weekend':     { label: 'WO',   bg: 'ECEFF1', fg: '90A4AE' },
    };

    const wb = new ExcelJS.Workbook();
    wb.creator = 'HRMS';
    wb.created = new Date();

    // ── Sheet 1 — Attendance Register (identical to exportMasterExcel Sheet 1) ─
    const ws1 = wb.addWorksheet(`Attendance ${MONTH_NAMES[m-1]} ${y}`, {
      views: [{ state: 'frozen', xSplit: 5, ySplit: 2 }]
    });

    const totalCols = 5 + daysInMonth + 9;
    try { ws1.mergeCells(1, 1, 1, totalCols); } catch(_) {}
    const titleCell = ws1.getCell(1, 1);
    titleCell.value = `HRMS — Attendance Register | ${MONTH_NAMES[m-1]} ${y}`;
    titleCell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B5E20' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws1.getRow(1).height = 28;

    const infoHeaders = ['Emp Code', 'Name', 'Department', 'Designation', 'Category'];
    const headerFill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E7D32' } };
    const headerFont  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    const headerAlign = { horizontal: 'center', vertical: 'middle', wrapText: true };

    infoHeaders.forEach((h, i) => {
      const cell = ws1.getCell(2, i + 1);
      cell.value = h; cell.font = headerFont; cell.fill = headerFill;
      cell.alignment = headerAlign;
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
    });

    const dayNames = ['Su','Mo','Tu','We','Th','Fr','Sa'];
    let satCountHdr = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      if (dow === 6) satCountHdr++;
      const isWeekOff = dow === 0 || (dow === 6 && (satCountHdr === 2 || satCountHdr === 4));
      const cell = ws1.getCell(2, 5 + d);
      cell.value = `${d}\n${dayNames[dow]}`;
      cell.font = { bold: true, size: 9, color: { argb: isWeekOff ? 'FFFF1744' : 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isWeekOff ? 'FF880E4F' : 'FF2E7D32' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
    }

    [
      { h: 'Paid Leave',      bg: 'FF2E7D32' },
      { h: 'Unpaid Leave',    bg: 'FFC62828' },
      { h: 'Paid Half Day',   bg: 'FF6A1B9A' },
      { h: 'Unpaid Half Day', bg: 'FFE65100' },
      { h: 'Total Paid',      bg: 'FF1565C0' },
      { h: 'Total Unpaid',    bg: 'FF880E4F' },
      { h: 'Total Absent',    bg: 'FFD50000' },
      { h: 'Late',            bg: 'FFF57F17' },
      { h: 'Total Present',   bg: 'FF00695C' },
    ].forEach(({ h, bg }, i) => {
      const cell = ws1.getCell(2, 5 + daysInMonth + 1 + i);
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 8 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    ws1.getRow(2).height = 30;

    // Group employees: onsite → offsite → deactivated (already sorted by query)
    let lastGroup = null;
    let groupRowOffset = 0;

    employees.forEach((e, ri) => {
      const isDeactivated = e.is_active === false;
      const isOffsite     = !isDeactivated && e.saturday_policy === 'all_working';
      const group = isDeactivated ? 'deactivated' : isOffsite ? 'offsite' : 'onsite';

      // Insert group separator row when group changes
      if (group !== lastGroup) {
        const sepRow = ri + 3 + groupRowOffset;
        groupRowOffset++;
        const groupLabel = group === 'onsite' ? '🏢 ONSITE EMPLOYEES'
                         : group === 'offsite' ? '🌐 OFFSITE EMPLOYEES'
                         : '❌ DEACTIVATED EMPLOYEES';
        const groupBg = group === 'onsite' ? 'FF1B5E20'
                      : group === 'offsite' ? 'FF0D47A1'
                      : 'FF4A0000';
        try { ws1.mergeCells(sepRow, 1, sepRow, totalCols); } catch(_) {}
        const sepCell = ws1.getCell(sepRow, 1);
        sepCell.value = groupLabel;
        sepCell.font  = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
        sepCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: groupBg } };
        sepCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
        ws1.getRow(sepRow).height = 18;
        lastGroup = group;
      }

      const row   = ri + 3 + groupRowOffset;
      const isAlt = ri % 2 === 1;
      const rowBg = isDeactivated
        ? (isAlt ? 'FFFFF8F8' : 'FFFFFFEE')
        : isOffsite
          ? (isAlt ? 'FFE3F2FD' : 'FFFFFFFF')
          : (isAlt ? 'FFE8F5E9' : 'FFFFFFFF');

      // Build info values — append deactivation remark to category cell if deactivated
      const remarkStr = e.deactivation_remark ? ` | NOTE: ${e.deactivation_remark}` : '';
      const categoryVal = (e.employee_category || '') + (isDeactivated ? ` (INACTIVE${remarkStr})` : '');

      [e.employee_code, `${e.first_name} ${e.last_name||''}`.trim(),
       e.department||'', e.designation||'', categoryVal].forEach((v, ci) => {
        const cell = ws1.getCell(row, ci + 1);
        cell.value = v; cell.font = { size: 9, color: { argb: isDeactivated ? 'FF9E0000' : 'FF000000' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
        cell.alignment = { vertical: 'middle' };
        cell.border = { right: { style: 'hair' }, bottom: { style: 'hair' } };
      });

      let attPaidLeave = 0, attUnpaidLeave = 0, attPaidHalfDay = 0, attUnpaidHalfDay = 0;
      let attLate = 0, attAbsent = 0, attPresent = 0;
      let satCountRow = 0;
      const empIsOffsite = e.saturday_policy === 'all_working';
      const empReg = getEmployeeRegion(e.city || '', e.state || '');
      const empHolSet = empReg === 'north' ? holidaysByRegion.north : holidaysByRegion.south_west;

      // ── DEACTIVATED EMPLOYEE: show actual attendance cells, then merge remaining days ──
      if (isDeactivated) {
        // Find last day with any attendance record for this employee this month
        const empAttDays = Object.keys(attMap[e.id] || {})
          .map(ds => parseInt(ds.split('-')[2]))
          .filter(d => d >= 1 && d <= daysInMonth);
        const lastAttDay = empAttDays.length ? Math.max(...empAttDays) : 0;
        const mergeFromCol = 5 + lastAttDay + 1; // first col after last attendance day
        const mergeToCol   = 5 + daysInMonth;    // last day col

        // Render actual attendance for days they have records
        for (let d = 1; d <= daysInMonth; d++) {
          const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          const dow = new Date(y, m - 1, d).getDay();
          if (dow === 6) satCountRow++;
          const is2nd4thSat = !empIsOffsite && dow === 6 && (satCountRow === 2 || satCountRow === 4);
          const isWeekOff   = dow === 0 || is2nd4thSat;

          if (d <= lastAttDay) {
            // Show actual status cell
            let status;
            if (isWeekOff) status = 'weekend';
            else if (empHolSet.has(dateStr) && !((attMap[e.id] || {})[dateStr])) status = 'holiday';
            else status = (attMap[e.id] || {})[dateStr] || '';

            const style = STATUS_STYLE[status] || { label: '', bg: 'FFF5F5', fg: '9E0000' };
            const cell  = ws1.getCell(row, 5 + d);
            cell.value = style.label;
            cell.font  = { bold: true, size: 8, color: { argb: 'FF' + style.fg } };
            cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + style.bg } };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.border = { right: { style: 'hair' }, bottom: { style: 'hair' } };

            if (!isWeekOff) {
              if (['present','regularized','od','wfh','holiday'].includes(status)) attPresent++;
              else if (status === 'late')     { attPresent++; attLate++; }
              else if (status === 'on-leave') { attPaidLeave++; attPresent++; }
              else if (['half-day','h-el','h-cl','h-sl','h-wfh'].includes(status)) { attPaidHalfDay++; attPresent++; }
              else if (status === 'h-lwp')   attUnpaidHalfDay++;
              else if (status === 'lwp')     attUnpaidLeave++;
              else if (status === 'absent')  attAbsent++;
            }
          }
        }

        // Merge remaining days into one cell with remark
        if (mergeFromCol <= mergeToCol) {
          try { ws1.mergeCells(row, mergeFromCol, row, mergeToCol); } catch(e) {}
          const remarkCell = ws1.getCell(row, mergeFromCol);
          const remarkText = e.deactivation_remark
            ? `❌ TERMINATED — ${e.deactivation_remark}`
            : `❌ Account deactivated${e.separation_date ? ' on ' + e.separation_date : ''}`;
          remarkCell.value = remarkText;
          remarkCell.font  = { bold: true, size: 8, color: { argb: 'FFB71C1C' }, italic: true };
          remarkCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3F3' } };
          remarkCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: false };
          remarkCell.border = { right: { style: 'medium', color: { argb: 'FFEF9A9A' } }, bottom: { style: 'hair' } };
        }

      } else {
        // ── NORMAL (active) employee — render all days as before ─────────────
        for (let d = 1; d <= daysInMonth; d++) {
          const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          const dow = new Date(y, m - 1, d).getDay();
          if (dow === 6) satCountRow++;
          const is2nd4thSat = !empIsOffsite && dow === 6 && (satCountRow === 2 || satCountRow === 4);
          const isWeekOff   = dow === 0 || is2nd4thSat;

          let status;
          if (isWeekOff) {
            status = 'weekend';
          } else if (empHolSet.has(dateStr) && !((attMap[e.id] || {})[dateStr])) {
            status = 'holiday';
          } else {
            status = (attMap[e.id] || {})[dateStr] || '';
          }

          const style = STATUS_STYLE[status] || { label: '', bg: isAlt ? 'F1F8E9' : 'FFFFFF', fg: '000000' };
          const cell  = ws1.getCell(row, 5 + d);
          cell.value = style.label;
          cell.font  = { bold: true, size: 8, color: { argb: 'FF' + style.fg } };
          cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + style.bg } };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          cell.border = { right: { style: 'hair' }, bottom: { style: 'hair' } };

          if (!isWeekOff) {
            if (['present','regularized','od','wfh','holiday'].includes(status)) attPresent++;
            else if (status === 'late')     { attPresent++; attLate++; }
            else if (status === 'on-leave') { attPaidLeave++;  attPresent++; }
            else if (['half-day','h-el','h-cl','h-sl','h-wfh'].includes(status)) { attPaidHalfDay++;   attPresent++; }            else if (status === 'h-lwp')   attUnpaidHalfDay++;
            else if (status === 'lwp')     attUnpaidLeave++;
            else if (status === 'absent')  attAbsent++;
          }
        }
      }

      const attTotalPaid   = attPresent;
      const attTotalUnpaid = attUnpaidLeave + attUnpaidHalfDay;

      [
        [attPaidLeave,     'FF2E7D32'],
        [attUnpaidLeave,   'FFC62828'],
        [attPaidHalfDay,   'FF6A1B9A'],
        [attUnpaidHalfDay, 'FFE65100'],
        [attTotalPaid,     'FF1565C0'],
        [attTotalUnpaid,   'FF880E4F'],
        [attAbsent,        'FFD50000'],
        [attLate,          'FFF57F17'],
        [attPresent,       'FF00695C'],
      ].forEach(([v, color], i) => {
        const cell = ws1.getCell(row, 5 + daysInMonth + 1 + i);
        cell.value = v;
        cell.font  = { bold: true, size: 9, color: { argb: color } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: isAlt ? 'FFE3F2FD' : 'FFFFFFFF' } };
        cell.border = { right: { style: 'thin' }, bottom: { style: 'hair' } };
      });

      ws1.getRow(row).height = 18;
    });

    ws1.getColumn(1).width = 10; ws1.getColumn(2).width = 20;
    ws1.getColumn(3).width = 14; ws1.getColumn(4).width = 20; ws1.getColumn(5).width = 12;
    for (let d = 1; d <= daysInMonth; d++) ws1.getColumn(5 + d).width = 5;
    for (let i = 1; i <= 9; i++) ws1.getColumn(5 + daysInMonth + i).width = 10;

    const legendRow = employees.length + 4;
    try { ws1.mergeCells(legendRow, 1, legendRow, totalCols); } catch(_) {}
    const legendCell = ws1.getCell(legendRow, 1);
    legendCell.value = 'LEGEND:  P=Present  A=Absent  L=Late  EL=Paid Leave  LWP=Unpaid Leave  H=Half Day  H-EL=Half EL  H-CL=Half CL  H-SL=Half SL  H-LWP=Half LWP (Unpaid)  H-WFH=Half WFH  OD=On Duty  WFH=Work From Home  R=Regularized  WO=Week Off  HOL=Holiday';
    legendCell.font  = { italic: true, size: 8, color: { argb: 'FF37474F' } };
    legendCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECEFF1' } };
    legendCell.alignment = { horizontal: 'left', vertical: 'middle' };
    ws1.getRow(legendRow).height = 16;

    // ── Sheet 2 — Punch Register (daily punch in / punch out per employee) ──
    const attPunchResult = await db.query(`
      SELECT employee_id,
             EXTRACT(DAY FROM date)::int AS day,
             status,
             TO_CHAR(punch_in,  'HH12:MI AM') AS punch_in_fmt,
             TO_CHAR(punch_out, 'HH12:MI AM') AS punch_out_fmt,
             EXTRACT(HOUR   FROM punch_in)::int  AS punch_in_h,
             EXTRACT(MINUTE FROM punch_in)::int  AS punch_in_m,
             EXTRACT(HOUR   FROM punch_out)::int AS punch_out_h,
             EXTRACT(MINUTE FROM punch_out)::int AS punch_out_m,
             working_hours
      FROM attendance
      WHERE EXTRACT(MONTH FROM date) = $1 AND EXTRACT(YEAR FROM date) = $2`,
      [m, y]);
    const punchMap = {};
    for (const row of attPunchResult.rows) {
      if (!punchMap[row.employee_id]) punchMap[row.employee_id] = {};
      punchMap[row.employee_id][row.day] = {
        in:   row.punch_in_fmt  || '',
        out:  row.punch_out_fmt || '',
        inH:  row.punch_in_h  ?? -1,
        inM:  row.punch_in_m  ?? -1,
        outH: row.punch_out_h ?? -1,
        outM: row.punch_out_m ?? -1,
        status: row.status || '',
        hours: parseFloat(row.working_hours || 0),
      };
    }

    await buildPunchRegisterSheet(wb, employees, m, y, MONTH_NAMES, punchMap, holidaysByRegion, getEmployeeRegion);

    // ── Send ─────────────────────────────────────────────────────────────────
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Disposition', `attachment; filename="HRMS_Attendance_${MONTH_NAMES[m-1]}${y}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);

  } catch (err) {
    console.error('[exportAttendanceRegister]', err.message, err.stack);
    res.status(500).json({ success: false, message: err.message });
  }
};
