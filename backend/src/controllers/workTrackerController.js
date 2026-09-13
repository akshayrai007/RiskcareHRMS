// src/controllers/workTrackerController.js
// ── WORK TRACKER (daily work log) ────────────────────────────────────────────
// A simple "what did you work on today" log — matches KrishiHR's model exactly:
// ANY employee can submit their own daily log at any time, no gating. The
// "required" flag is informational only (HR/Accounts/Admin/Super Admin can
// mark someone required as a nudge) — it does NOT gate who can submit.
//
// Visibility / permission rules (mirrors KrishiHR's buildScope + COMP_ADMIN_ROLES):
//   - Everyone can submit/view their own log — always, unconditionally.
//   - HR/Accounts/Admin/Super Admin manage the "required" flag for anyone and
//     view everyone's submitted logs.
//   - A direct reporting manager (real org-chart reportees, not a role label)
//     can VIEW their reportees' logs, but cannot toggle the "required" flag —
//     that stays admin-tier only, same as KrishiHR's compulsory-list management.

const db = require('../config/db');

const ADMIN_TIER_ROLES = ['hr', 'accounts', 'admin', 'super_admin'];
function isCompanyWideManager(user) { return ADMIN_TIER_ROLES.includes(String(user.role || '').toLowerCase()); }

// "Manager" here is VIEW-ONLY scope (see reportees' logs), matching KrishiHR's
// buildScope — anyone with actual reportees in the org chart, regardless of
// role label, except the admin-tier roles (handled separately) and a literal
// 'employee' role (never manager-level, even with stray reportee data).
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

// Is the caller allowed to toggle "required" for this employee? Admin-tier
// only (hr/accounts/admin/super_admin) — matches KrishiHR's COMP_ADMIN_ROLES,
// which never lets a plain reportee-manager toggle the compulsory flag.
function canManage(user) {
  return isCompanyWideManager(user);
}

// ── Does the caller even get to see the Work Tracker page? ──────────────────
// Always true now (everyone can submit their own log) — kept as an endpoint
// so the client can still learn `required` (informational) and whether it
// gets the admin-tier manage/view-others panel.
exports.getMyStatus = async (req, res) => {
  try {
    await ensureTables();
    const r = await db.query(`SELECT work_tracker_required FROM employees WHERE id=$1`, [req.user.id]);
    const required = !!r.rows[0]?.work_tracker_required;
    const canManageOthers = isCompanyWideManager(req.user);
    res.json({ success: true, data: { required, can_manage_others: canManageOthers } });
  } catch (err) {
    console.error('[workTracker.getMyStatus]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Set/unset "required to fill" for one employee (informational nudge only —
//    admin-tier only, matches KrishiHR's COMP_ADMIN_ROLES) ───────────────────
exports.setRequired = async (req, res) => {
  try {
    await ensureTables();
    const employeeId = parseInt(req.body.employee_id);
    const required = !!req.body.required;
    if (!employeeId) return res.status(400).json({ success: false, message: 'employee_id required' });
    if (!canManage(req.user))
      return res.status(403).json({ success: false, message: 'Only HR, Accounts, Admin, or Super Admin can manage this' });

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

// ── List employees this caller can toggle "required" for — admin-tier only
//    (hr/accounts/admin/super_admin see everyone, optionally by department) ──
exports.getRequiredList = async (req, res) => {
  try {
    await ensureTables();
    if (!canManage(req.user)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const { department_id } = req.query;
    const params = [];
    let q = `SELECT e.id, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name,
                    d.name AS department_name, e.work_tracker_required
             FROM employees e LEFT JOIN departments d ON d.id = e.department_id
             WHERE e.is_active=true`;
    if (department_id) { params.push(parseInt(department_id)); q += ` AND e.department_id=$${params.length}`; }
    q += ` ORDER BY d.name, e.first_name`;
    const r = await db.query(q, params);
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('[workTracker.getRequiredList]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Submit / update today's (or any date's) log ──────────────────────────────
// Any authenticated employee can submit their own log at any time — matches
// KrishiHR exactly, no "required" gate.
exports.submitLog = async (req, res) => {
  try {
    await ensureTables();
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
