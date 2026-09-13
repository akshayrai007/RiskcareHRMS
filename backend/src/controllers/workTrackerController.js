// src/controllers/workTrackerController.js
// ── WORK TRACKER (daily work log) ────────────────────────────────────────────
// A simple "what did you work on today" log. Unlike Tasks (assigned work with
// a status), this is a self-reported daily entry. Only visible to an employee
// once someone (their manager or Super Admin) has explicitly flagged them as
// "required to fill" it — most employees never see this page at all.
//
// Visibility / permission rules:
//   - Manager can mark/unmark REQUIRED status only for their own direct
//     reportees, and can view only those reportees' submitted logs.
//   - Super Admin can mark/unmark anyone and view everyone's logs
//     (optionally filtered by department).
//   - An employee who has been marked required can see the page, submit their
//     own daily log, and view their own history — nothing else.

const db = require('../config/db');

function isSuperAdmin(user) { return String(user.role || '').toLowerCase() === 'super_admin'; }
// HR can assign/manage Work Tracker for anyone company-wide, same as Super Admin —
// not just their own reportees.
function isHR(user) { return String(user.role || '').toLowerCase() === 'hr'; }
function isCompanyWideManager(user) { return isSuperAdmin(user) || isHR(user); }

// "Manager" = anyone with actual reportees in the org chart, regardless of
// their role label (accounts/admin/etc. can all have reportees) — EXCEPT a
// literal 'employee' role, which never gets manager-level Work Tracker
// access even if the org chart happens to route reportees to them.
async function isManager(user) {
  if (isCompanyWideManager(user)) return false;
  if (String(user.role || '').toLowerCase() === 'employee') return false;
  const r = await db.query(
    `SELECT 1 FROM employees WHERE reporting_manager_id=$1 AND is_active=true LIMIT 1`,
    [user.id]
  );
  return r.rows.length > 0;
}

let ready = null;
async function ensureTables() {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_tracker_required BOOLEAN DEFAULT FALSE`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS work_logs (
        id           SERIAL PRIMARY KEY,
        employee_id  INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        log_date     DATE NOT NULL,
        summary      TEXT NOT NULL,
        hours_spent  NUMERIC(4,1),
        created_at   TIMESTAMP DEFAULT NOW(),
        UNIQUE(employee_id, log_date)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_work_logs_employee ON work_logs(employee_id)`);
  })().catch(err => { ready = null; throw err; });
  return ready;
}
exports.ensureTables = ensureTables;

// Is the caller allowed to manage (mark required / view logs of) this employee?
async function canManage(user, employeeId) {
  if (isCompanyWideManager(user)) return true;
  if (String(user.role || '').toLowerCase() === 'employee') return false;
  const r = await db.query(`SELECT 1 FROM employees WHERE id=$1 AND reporting_manager_id=$2`, [employeeId, user.id]);
  return r.rows.length > 0;
}

// ── Does the caller even get to see the Work Tracker page? ──────────────────
exports.getMyStatus = async (req, res) => {
  try {
    await ensureTables();
    const r = await db.query(`SELECT work_tracker_required FROM employees WHERE id=$1`, [req.user.id]);
    const required = !!r.rows[0]?.work_tracker_required;
    const canManageOthers = (await isManager(req.user)) || isCompanyWideManager(req.user);
    res.json({ success: true, data: { required, can_manage_others: canManageOthers } });
  } catch (err) {
    console.error('[workTracker.getMyStatus]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Set/unset "required to fill" for one employee ────────────────────────────
exports.setRequired = async (req, res) => {
  try {
    await ensureTables();
    const employeeId = parseInt(req.body.employee_id);
    const required = !!req.body.required;
    if (!employeeId) return res.status(400).json({ success: false, message: 'employee_id required' });
    if (!(await canManage(req.user, employeeId)))
      return res.status(403).json({ success: false, message: 'You can only manage this for your own reportees' });

    await db.query(`UPDATE employees SET work_tracker_required=$1 WHERE id=$2`, [required, employeeId]);

    if (required) {
      const who = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Your manager';
      await db.query(
        `INSERT INTO notifications(employee_id, type, title, message, is_read, expires_at)
         VALUES ($1,'work_tracker','📝 Daily Work Log Required',$2,FALSE,NOW() + INTERVAL '14 days')`,
        [employeeId, `${who} has asked you to start submitting a daily Work Tracker log.`]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[workTracker.setRequired]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── List employees this caller can toggle "required" for (manager -> their
//    reportees, super_admin -> everyone, optionally by department) ──────────
exports.getRequiredList = async (req, res) => {
  try {
    await ensureTables();
    if (isCompanyWideManager(req.user)) {
      const { department_id } = req.query;
      const params = [];
      let q = `SELECT e.id, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name,
                      d.name AS department_name, e.work_tracker_required
               FROM employees e LEFT JOIN departments d ON d.id = e.department_id
               WHERE e.is_active=true`;
      if (department_id) { params.push(parseInt(department_id)); q += ` AND e.department_id=$${params.length}`; }
      q += ` ORDER BY d.name, e.first_name`;
      const r = await db.query(q, params);
      return res.json({ success: true, data: r.rows });
    }
    if (await isManager(req.user)) {
      const r = await db.query(
        `SELECT e.id, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name,
                d.name AS department_name, e.work_tracker_required
         FROM employees e LEFT JOIN departments d ON d.id = e.department_id
         WHERE e.reporting_manager_id=$1 AND e.is_active=true ORDER BY e.first_name`,
        [req.user.id]
      );
      return res.json({ success: true, data: r.rows });
    }
    res.status(403).json({ success: false, message: 'Access denied' });
  } catch (err) {
    console.error('[workTracker.getRequiredList]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Submit / update today's (or any date's) log ──────────────────────────────
exports.submitLog = async (req, res) => {
  try {
    await ensureTables();
    const check = await db.query(`SELECT work_tracker_required FROM employees WHERE id=$1`, [req.user.id]);
    if (!check.rows[0]?.work_tracker_required)
      return res.status(403).json({ success: false, message: 'You have not been asked to fill a Work Tracker log' });

    const { log_date, summary, hours_spent } = req.body;
    if (!summary || !String(summary).trim())
      return res.status(400).json({ success: false, message: 'Summary is required' });
    const date = log_date || new Date().toISOString().split('T')[0];

    await db.query(
      `INSERT INTO work_logs (employee_id, log_date, summary, hours_spent)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (employee_id, log_date) DO UPDATE SET summary=$3, hours_spent=$4`,
      [req.user.id, date, String(summary).trim(), parseFloat(hours_spent) || null]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[workTracker.submitLog]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── My own log history ────────────────────────────────────────────────────────
exports.getMyLogs = async (req, res) => {
  try {
    await ensureTables();
    const r = await db.query(
      `SELECT * FROM work_logs WHERE employee_id=$1 ORDER BY log_date DESC LIMIT 90`,
      [req.user.id]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('[workTracker.getMyLogs]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Manager/Super Admin: view submitted logs for people they manage ─────────
exports.listLogs = async (req, res) => {
  try {
    await ensureTables();
    const { employee_id, from_date, to_date, department_id } = req.query;
    const params = [];
    const conds = [];

    if (isCompanyWideManager(req.user)) {
      if (department_id) { params.push(parseInt(department_id)); conds.push(`e.department_id=$${params.length}`); }
    } else if (await isManager(req.user)) {
      params.push(req.user.id);
      conds.push(`e.reporting_manager_id=$${params.length}`);
    } else {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    if (employee_id) { params.push(parseInt(employee_id)); conds.push(`w.employee_id=$${params.length}`); }
    if (from_date)   { params.push(from_date); conds.push(`w.log_date >= $${params.length}`); }
    if (to_date)     { params.push(to_date);   conds.push(`w.log_date <= $${params.length}`); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await db.query(
      `SELECT w.*, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS employee_name, d.name AS department_name
       FROM work_logs w
       JOIN employees e ON e.id = w.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       ${where}
       ORDER BY w.log_date DESC, e.first_name LIMIT 500`,
      params
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('[workTracker.listLogs]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
