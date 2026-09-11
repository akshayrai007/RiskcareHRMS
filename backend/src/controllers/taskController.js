// src/controllers/taskController.js
// ── TASK ASSIGNMENT MODULE ───────────────────────────────────────────────────
// Simple work-assignment tracker (not a full Jira-style board). A manager
// assigns tasks to their own direct reportees; Super Admin can assign/see
// tasks for anyone, filterable by department.
//
// Visibility rules:
//   - manager: sees/creates/updates tasks only for employees whose
//     reporting_manager_id = manager's own id ("their reportees").
//   - super_admin: sees ALL tasks across the company, filterable by department.
//   - everyone else: sees only tasks assigned TO them, and may update the
//     status of their own tasks (e.g. mark complete) but not edit/reassign.

const db  = require('../config/db');

const STATUSES = ['pending', 'in_progress', 'completed'];
const PRIORITIES = ['low', 'medium', 'high'];

function isSuperAdmin(user) {
  return String(user.role || '').toLowerCase() === 'super_admin';
}

// "Manager" here means anyone who actually has reportees in the org chart —
// NOT anyone whose role field literally says 'manager'. Reportees exist
// under people with all sorts of role labels (accounts, admin, etc.), so a
// role-string check misses real managers and wrongly excludes them from
// managing their own team's tasks/work-tracker.
async function isManager(user) {
  if (isSuperAdmin(user)) return false; // handled separately, broader scope
  const r = await db.query(
    `SELECT 1 FROM employees WHERE reporting_manager_id=$1 AND is_active=true LIMIT 1`,
    [user.id]
  );
  return r.rows.length > 0;
}

// ── Schema (idempotent) ──────────────────────────────────────────────────────
let ready = null;
async function ensureTables() {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id             SERIAL PRIMARY KEY,
        title          VARCHAR(255) NOT NULL,
        description    TEXT,
        assigned_to    INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        assigned_by    INT REFERENCES employees(id) ON DELETE SET NULL,
        priority       VARCHAR(10) DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
        status         VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed')),
        is_compulsory  BOOLEAN DEFAULT FALSE,
        due_date       DATE,
        completed_at   TIMESTAMP,
        created_at     TIMESTAMP DEFAULT NOW(),
        updated_at     TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_by ON tasks(assigned_by)`);
  })().catch(err => { ready = null; throw err; });
  return ready;
}
exports.ensureTables = ensureTables;

const TASK_SELECT = `
  t.id, t.title, t.description, t.priority, t.status, t.is_compulsory,
  t.due_date, t.completed_at, t.created_at, t.updated_at,
  t.assigned_to, CONCAT(a.first_name,' ',a.last_name) AS assignee_name, a.employee_code AS assignee_code,
  d.name AS department_name,
  t.assigned_by, CONCAT(b.first_name,' ',b.last_name) AS assigner_name`;
const TASK_JOINS = `
  FROM tasks t
  JOIN employees a ON a.id = t.assigned_to
  LEFT JOIN departments d ON d.id = a.department_id
  LEFT JOIN employees b ON b.id = t.assigned_by`;

// ── Create / Assign ───────────────────────────────────────────────────────────
exports.createTask = async (req, res) => {
  try {
    await ensureTables();
    const { title, description, assigned_to, priority, is_compulsory, due_date } = req.body;
    if (!title || !String(title).trim())
      return res.status(400).json({ success: false, message: 'Title is required' });
    const assigneeId = parseInt(assigned_to);
    if (!assigneeId)
      return res.status(400).json({ success: false, message: 'assigned_to is required' });
    if (priority && !PRIORITIES.includes(priority))
      return res.status(400).json({ success: false, message: 'Invalid priority' });

    // Managers (anyone with actual reportees) may only assign to their own
    // direct reportees. Super Admin can assign to anyone.
    if (!isSuperAdmin(req.user)) {
      const rep = await db.query(
        `SELECT id FROM employees WHERE id=$1 AND reporting_manager_id=$2 AND is_active=true`,
        [assigneeId, req.user.id]
      );
      if (!rep.rows.length)
        return res.status(403).json({ success: false, message: 'You can only assign tasks to your own reportees' });
    } else {
      const exists = await db.query(`SELECT id FROM employees WHERE id=$1 AND is_active=true`, [assigneeId]);
      if (!exists.rows.length)
        return res.status(400).json({ success: false, message: 'Employee not found' });
    }

    const ins = await db.query(
      `INSERT INTO tasks (title, description, assigned_to, assigned_by, priority, is_compulsory, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [String(title).trim(), description || null, assigneeId, req.user.id,
       priority || 'medium', !!is_compulsory, due_date || null]
    );
    const taskId = ins.rows[0].id;

    const who = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Someone';
    const taskNotifTitle = is_compulsory ? '🔴 Compulsory Task Assigned' : '📋 New Task Assigned';
    const taskNotifMsg = `${who} assigned you a${is_compulsory ? ' COMPULSORY' : ''} task: "${String(title).trim()}"${due_date ? ' — Due: ' + due_date : ''}`;
    await db.query(
      `INSERT INTO notifications(employee_id, type, title, message, is_read, expires_at)
       VALUES ($1,'task',$2,$3,FALSE,NOW() + INTERVAL '14 days')`,
      [assigneeId, taskNotifTitle, taskNotifMsg]
    );
    require('../config/pushService').sendPush(assigneeId, taskNotifTitle, taskNotifMsg, { channel: 'riskcare_general', screen: 'my_work' });

    res.json({ success: true, id: taskId });
  } catch (err) {
    console.error('[tasks.createTask]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── List ──────────────────────────────────────────────────────────────────────
exports.listTasks = async (req, res) => {
  try {
    await ensureTables();
    const { status, priority, department_id, search } = req.query;
    const params = [];
    const conds = [];

    // ?mine=1 forces the involved-only scope even for managers/super_admin —
    // used by the "My Work" page so managers can see their OWN assigned
    // tasks too, not just what they've handed out to their reportees.
    const mineOnly = req.query.mine === '1' || req.query.mine === 'true';

    if (mineOnly) {
      params.push(req.user.id);
      conds.push(`t.assigned_to = $${params.length}`);
    } else if (isSuperAdmin(req.user)) {
      // Sees everyone — optionally scoped to one department.
      if (department_id) { params.push(parseInt(department_id)); conds.push(`a.department_id = $${params.length}`); }
    } else if (await isManager(req.user)) {
      // Sees only tasks for their own direct reportees.
      params.push(req.user.id);
      conds.push(`a.reporting_manager_id = $${params.length}`);
    } else {
      // Everyone else sees only tasks assigned to them.
      params.push(req.user.id);
      conds.push(`t.assigned_to = $${params.length}`);
    }

    if (status && STATUSES.includes(status)) { params.push(status); conds.push(`t.status = $${params.length}`); }
    if (priority && PRIORITIES.includes(priority)) { params.push(priority); conds.push(`t.priority = $${params.length}`); }
    if (search) { params.push(`%${search}%`); conds.push(`(t.title ILIKE $${params.length} OR t.description ILIKE $${params.length})`); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await db.query(
      `SELECT ${TASK_SELECT} ${TASK_JOINS} ${where} ORDER BY
         CASE t.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
         t.is_compulsory DESC, t.due_date NULLS LAST, t.created_at DESC`,
      params
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('[tasks.listTasks]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Board — same visibility rules as listTasks, grouped by status column ────
exports.board = async (req, res) => {
  try {
    await ensureTables();
    const { department_id } = req.query;
    const params = [];
    const conds = [];

    if (isSuperAdmin(req.user)) {
      if (department_id) { params.push(parseInt(department_id)); conds.push(`a.department_id = $${params.length}`); }
    } else if (await isManager(req.user)) {
      params.push(req.user.id);
      conds.push(`a.reporting_manager_id = $${params.length}`);
    } else {
      params.push(req.user.id);
      conds.push(`t.assigned_to = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await db.query(
      `SELECT ${TASK_SELECT} ${TASK_JOINS} ${where}
       ORDER BY t.is_compulsory DESC, t.due_date NULLS LAST, t.created_at DESC`,
      params
    );
    const columns = { pending: [], in_progress: [], completed: [] };
    r.rows.forEach(row => { (columns[row.status] || columns.pending).push(row); });
    res.json({ success: true, data: { columns, order: STATUSES } });
  } catch (err) {
    console.error('[tasks.board]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Update status (assignee marks in-progress/complete; manager/admin can also) ─
exports.updateStatus = async (req, res) => {
  try {
    await ensureTables();
    const id = parseInt(req.params.id);
    const status = req.body.status;
    if (!STATUSES.includes(status))
      return res.status(400).json({ success: false, message: 'Invalid status' });

    const cur = await db.query(
      `SELECT t.*, a.reporting_manager_id FROM tasks t JOIN employees a ON a.id = t.assigned_to WHERE t.id=$1`,
      [id]
    );
    if (!cur.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    const t = cur.rows[0];

    // t.reporting_manager_id === req.user.id already proves req.user is this
    // employee's actual manager — no need to also check the role label.
    const canUpdate = t.assigned_to === req.user.id
      || isSuperAdmin(req.user)
      || t.reporting_manager_id === req.user.id;
    if (!canUpdate) return res.status(403).json({ success: false, message: 'Access denied' });

    await db.query(
      `UPDATE tasks SET status=$1, completed_at=${status === 'completed' ? 'NOW()' : 'NULL'}, updated_at=NOW() WHERE id=$2`,
      [status, id]
    );

    if (status === 'completed' && t.assigned_by && t.assigned_by !== req.user.id) {
      const who = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Someone';
      await db.query(
        `INSERT INTO notifications(employee_id, type, title, message, is_read, expires_at)
         VALUES ($1,'task','✅ Task Completed',$2,FALSE,NOW() + INTERVAL '7 days')`,
        [t.assigned_by, `${who} marked "${t.title}" as completed.`]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[tasks.updateStatus]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Update (title/description/priority/compulsory/due date) — assigner or Super Admin only ─
exports.updateTask = async (req, res) => {
  try {
    await ensureTables();
    const id = parseInt(req.params.id);
    const cur = await db.query(
      `SELECT t.*, a.reporting_manager_id FROM tasks t JOIN employees a ON a.id = t.assigned_to WHERE t.id=$1`,
      [id]
    );
    if (!cur.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    const t = cur.rows[0];

    const canEdit = isSuperAdmin(req.user) || t.reporting_manager_id === req.user.id;
    if (!canEdit) return res.status(403).json({ success: false, message: 'Only the assigning manager or Super Admin can edit this task' });

    const sets = [], params = [];
    const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (req.body.title !== undefined && String(req.body.title).trim()) set('title', String(req.body.title).trim());
    if (req.body.description !== undefined) set('description', req.body.description || null);
    if (req.body.priority !== undefined) {
      if (!PRIORITIES.includes(req.body.priority)) return res.status(400).json({ success: false, message: 'Invalid priority' });
      set('priority', req.body.priority);
    }
    if (req.body.is_compulsory !== undefined) set('is_compulsory', !!req.body.is_compulsory);
    if (req.body.due_date !== undefined) set('due_date', req.body.due_date || null);
    if (!sets.length) return res.json({ success: true });

    params.push(id);
    await db.query(`UPDATE tasks SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${params.length}`, params);
    res.json({ success: true });
  } catch (err) {
    console.error('[tasks.updateTask]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Delete — assigning manager or Super Admin only ───────────────────────────
exports.deleteTask = async (req, res) => {
  try {
    await ensureTables();
    const id = parseInt(req.params.id);
    const cur = await db.query(
      `SELECT t.*, a.reporting_manager_id FROM tasks t JOIN employees a ON a.id = t.assigned_to WHERE t.id=$1`,
      [id]
    );
    if (!cur.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    const t = cur.rows[0];
    const canDelete = isSuperAdmin(req.user) || t.reporting_manager_id === req.user.id;
    if (!canDelete) return res.status(403).json({ success: false, message: 'Access denied' });

    await db.query(`DELETE FROM tasks WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[tasks.deleteTask]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Assignable employees for the "Assign Task" picker ────────────────────────
// Manager -> their own direct reportees only. Super Admin -> everyone
// (optionally filtered by department).
exports.getAssignableEmployees = async (req, res) => {
  try {
    if (isSuperAdmin(req.user)) {
      const { department_id } = req.query;
      let q = `SELECT e.id, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name, d.name AS department_name
                FROM employees e LEFT JOIN departments d ON d.id = e.department_id
                WHERE e.is_active=true`;
      const params = [];
      if (department_id) { params.push(parseInt(department_id)); q += ` AND e.department_id=$${params.length}`; }
      q += ` ORDER BY d.name, e.first_name`;
      const r = await db.query(q, params);
      return res.json({ success: true, data: r.rows });
    }
    if (await isManager(req.user)) {
      const r = await db.query(
        `SELECT e.id, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name, d.name AS department_name
         FROM employees e LEFT JOIN departments d ON d.id = e.department_id
         WHERE e.reporting_manager_id=$1 AND e.is_active=true ORDER BY e.first_name`,
        [req.user.id]
      );
      return res.json({ success: true, data: r.rows });
    }
    res.status(403).json({ success: false, message: 'Only a Manager or Super Admin can assign tasks' });
  } catch (err) {
    console.error('[tasks.getAssignableEmployees]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Stats (small dashboard widget) ───────────────────────────────────────────
exports.stats = async (req, res) => {
  try {
    await ensureTables();
    const params = [];
    let where = '';
    if (isSuperAdmin(req.user)) {
      if (req.query.department_id) { params.push(parseInt(req.query.department_id)); where = `WHERE a.department_id=$${params.length}`; }
    } else if (await isManager(req.user)) {
      params.push(req.user.id); where = `WHERE a.reporting_manager_id=$${params.length}`;
    } else {
      params.push(req.user.id); where = `WHERE t.assigned_to=$${params.length}`;
    }
    const r = await db.query(
      `SELECT t.status, COUNT(*)::int AS n FROM tasks t JOIN employees a ON a.id = t.assigned_to ${where} GROUP BY t.status`,
      params
    );
    const counts = { pending: 0, in_progress: 0, completed: 0 };
    r.rows.forEach(row => { counts[row.status] = row.n; });
    res.json({ success: true, data: counts });
  } catch (err) {
    console.error('[tasks.stats]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Am I a manager (have real reportees) or Super Admin? ─────────────────────
// Used by the frontend to decide whether to show Task Board / All Tasks /
// the Assign Task button — since "manager" is based on actual reportees in
// the org chart, not the role label, the frontend can't determine this from
// the logged-in user object alone.
exports.amIManager = async (req, res) => {
  try {
    const superAdmin = isSuperAdmin(req.user);
    const manager = superAdmin ? false : await isManager(req.user);
    res.json({ success: true, data: { is_manager: manager, is_super_admin: superAdmin } });
  } catch (err) {
    console.error('[tasks.amIManager]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
