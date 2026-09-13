// src/controllers/workTrackerController.js
// ── WORK TRACKER (daily work log) ────────────────────────────────────────────
// A simple "what did you work on today" log — matches KrishiHR's model exactly:
// ANY employee can submit their own daily log at any time, no gating. The
// "required" flag is informational only (HR/Accounts/Admin/Super Admin can
// mark someone required as a nudge) — it does NOT gate who can submit.
//
// Visibility / permission rules:
//   - Everyone can submit/view their own log — always, unconditionally.
//   - HR/Accounts/Admin/Super Admin manage the "required" flag for ANYONE
//     and view everyone's submitted logs (optionally filtered by department).
//   - A real manager (has actual reportees in the org chart — not a role
//     label) sees the same Manage panel, scoped to just their own team:
//     they can toggle "required" and view logs for their direct reportees
//     only, not the whole company.

const db = require('../config/db');
const XLSX = require('xlsx');

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
        id                SERIAL PRIMARY KEY,
        employee_id       INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        log_date          DATE NOT NULL,
        team              VARCHAR(60),
        summary           TEXT NOT NULL,
        percent_done      INT DEFAULT 0 CHECK (percent_done BETWEEN 0 AND 100),
        percent_remaining INT DEFAULT 100 CHECK (percent_remaining BETWEEN 0 AND 100),
        week_task         TEXT,
        est_finish_date   DATE,
        blockers          TEXT,
        remark            TEXT,
        created_at        TIMESTAMP DEFAULT NOW(),
        updated_at        TIMESTAMP DEFAULT NOW(),
        UNIQUE(employee_id, log_date)
      )
    `);
    // Same fields, added on top of the older simpler table for anyone who
    // already has one deployed.
    await db.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS team VARCHAR(60)`);
    await db.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS percent_done INT DEFAULT 0`);
    await db.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS percent_remaining INT DEFAULT 100`);
    await db.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS week_task TEXT`);
    await db.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS est_finish_date DATE`);
    await db.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS blockers TEXT`);
    await db.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS remark TEXT`);
    await db.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_work_logs_employee ON work_logs(employee_id)`);
  })().catch(err => { ready = null; throw err; });
  return ready;
}
exports.ensureTables = ensureTables;

// Is the caller allowed to toggle "required" for this specific employee?
// HR/Accounts/Admin/Super Admin: anyone. A real manager (has reportees,
// regardless of role label): only their own direct reportees.
async function canManage(user, employeeId) {
  if (isCompanyWideManager(user)) return true;
  if (employeeId == null) return false; // no specific employee to check against
  const r = await db.query(
    `SELECT 1 FROM employees WHERE id=$1 AND reporting_manager_id=$2 AND is_active=true`,
    [employeeId, user.id]
  );
  return r.rows.length > 0;
}

// ── Does the caller even get to see the Work Tracker page? ──────────────────
// Always true now (everyone can submit their own log) — kept as an endpoint
// so the client can still learn `required` (informational) and whether it
// gets the manage/view-others panel (admin-tier: everyone; real manager:
// their own team only).
exports.getMyStatus = async (req, res) => {
  try {
    await ensureTables();
    const r = await db.query(`SELECT work_tracker_required FROM employees WHERE id=$1`, [req.user.id]);
    const required = !!r.rows[0]?.work_tracker_required;
    const canManageOthers = isCompanyWideManager(req.user) || (await isManager(req.user));
    res.json({ success: true, data: { required, can_manage_others: canManageOthers } });
  } catch (err) {
    console.error('[workTracker.getMyStatus]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Set/unset "required to fill" for one employee (informational nudge) —
//    admin-tier can toggle anyone; a real manager only their own reportees ──
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

// ── List employees this caller can toggle "required" for — admin-tier sees
//    everyone (optionally by department); a real manager sees only their
//    own direct reportees ────────────────────────────────────────────────
exports.getRequiredList = async (req, res) => {
  try {
    await ensureTables();
    const params = [];
    let where = `WHERE e.is_active=true`;

    if (isCompanyWideManager(req.user)) {
      const { department_id } = req.query;
      if (department_id) { params.push(parseInt(department_id)); where += ` AND e.department_id=$${params.length}`; }
    } else if (await isManager(req.user)) {
      params.push(req.user.id);
      where += ` AND e.reporting_manager_id=$${params.length}`;
    } else {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const r = await db.query(
      `SELECT e.id, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name,
              d.name AS department_name, e.work_tracker_required
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id
       ${where}
       ORDER BY d.name, e.first_name`,
      params
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('[workTracker.getRequiredList]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Submit / update today's (or any date's) log ──────────────────────────────
// Any authenticated employee can submit their own log at any time — matches
// KrishiHR's unified progress-log form exactly: Team, % Done Today (%
// Remaining is derived), Today's Task, This Week's Task/Goal, Blockers,
// Remark. One entry per employee per day (upsert).
exports.submitLog = async (req, res) => {
  try {
    await ensureTables();
    const { log_date, team, today_task, percent_done, week_task, est_finish_date, blockers, remark } = req.body;
    if (!today_task || !String(today_task).trim())
      return res.status(400).json({ success: false, message: "Please describe today's task" });

    const date = log_date || new Date().toISOString().split('T')[0];
    let done = parseInt(percent_done);
    if (isNaN(done)) done = 0;
    done = Math.max(0, Math.min(100, done));
    const remaining = 100 - done;

    await db.query(
      `INSERT INTO work_logs (employee_id, log_date, team, summary, percent_done, percent_remaining, week_task, est_finish_date, blockers, remark)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (employee_id, log_date) DO UPDATE SET
         team=$3, summary=$4, percent_done=$5, percent_remaining=$6,
         week_task=$7, est_finish_date=$8, blockers=$9, remark=$10, updated_at=NOW()`,
      [req.user.id, date, (team || '').trim() || null, String(today_task).trim(), done, remaining,
       (week_task || '').trim() || null, est_finish_date || null, (blockers || '').trim() || null, (remark || '').trim() || null]
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
      `SELECT *, summary AS today_task FROM work_logs WHERE employee_id=$1 ORDER BY log_date DESC LIMIT 90`,
      [req.user.id]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('[workTracker.getMyLogs]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Today's own entry (so the form can pre-fill / edit-in-place) ────────────
exports.getMyToday = async (req, res) => {
  try {
    await ensureTables();
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const r = await db.query(
      `SELECT *, summary AS today_task FROM work_logs WHERE employee_id=$1 AND log_date=$2`,
      [req.user.id, date]
    );
    res.json({ success: true, data: r.rows[0] || null });
  } catch (err) {
    console.error('[workTracker.getMyToday]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Self may delete their own entry; admin-tier may delete anyone's.
exports.deleteLog = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const row = await db.query(`SELECT employee_id FROM work_logs WHERE id=$1`, [id]);
    if (!row.rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    if (!isCompanyWideManager(req.user) && row.rows[0].employee_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    await db.query(`DELETE FROM work_logs WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[workTracker.deleteLog]', err.message);
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
      `SELECT w.*, w.summary AS today_task, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS employee_name, d.name AS department_name
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

// ── Excel export — same scope rules as listLogs ──────────────────────────────
exports.exportLogs = async (req, res) => {
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
      params.push(req.user.id);
      conds.push(`w.employee_id=$${params.length}`);
    }
    if (employee_id) { params.push(parseInt(employee_id)); conds.push(`w.employee_id=$${params.length}`); }
    if (from_date)   { params.push(from_date); conds.push(`w.log_date >= $${params.length}`); }
    if (to_date)     { params.push(to_date);   conds.push(`w.log_date <= $${params.length}`); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await db.query(
      `SELECT w.log_date, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
              w.team, w.summary AS today_task, w.percent_done, w.percent_remaining,
              w.week_task, w.est_finish_date, w.blockers, w.remark
       FROM work_logs w
       JOIN employees e ON e.id = w.employee_id
       ${where}
       ORDER BY w.log_date DESC, e.first_name LIMIT 2000`,
      params
    );

    const rows = [['Date', 'Emp Code', 'Employee', 'Team', "Today's Task", '% Done', '% Remaining', 'This Week', 'Est. Finish', 'Blockers', 'Remark']];
    for (const x of r.rows) {
      rows.push([
        x.log_date, x.employee_code, x.employee_name, x.team || '', x.today_task,
        x.percent_done, x.percent_remaining, x.week_task || '', x.est_finish_date || '', x.blockers || '', x.remark || ''
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{wch:12},{wch:12},{wch:22},{wch:14},{wch:40},{wch:8},{wch:10},{wch:26},{wch:14},{wch:22},{wch:22}];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Work Tracker');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="Work_Tracker_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('[workTracker.exportLogs]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
