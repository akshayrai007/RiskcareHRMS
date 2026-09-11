// src/controllers/ticketController.js
// ── WORK TICKETS MODULE ──────────────────────────────────────────────────────
// A lightweight support/request ticket tracker, separate from Task Assignment:
//   - Tasks = a manager assigns to-dos to their own reportees.
//   - Tickets = ANY employee can raise an issue/request, which gets routed to
//     admin/HR/super_admin (the "support" roles) to triage and resolve.
// Raising a ticket to multiple assignees creates one ticket row per assignee
// (each tracked independently), matching the Android client's contract.

const db = require('../config/db');

const STATUSES  = ['open', 'in_progress', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high'];
const SUPPORT_ROLES = ['admin', 'hr', 'super_admin'];

function isSuperAdmin(user) {
  return String(user.role || '').toLowerCase() === 'super_admin';
}
function isSupportRole(user) {
  return SUPPORT_ROLES.includes(String(user.role || '').toLowerCase());
}

let ready = null;
async function ensureTables() {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS work_tickets (
        id           SERIAL PRIMARY KEY,
        title        VARCHAR(255) NOT NULL,
        description  TEXT,
        priority     VARCHAR(10) DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
        status       VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
        due_date     DATE,
        raised_by    INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        assigned_to  INT REFERENCES employees(id) ON DELETE SET NULL,
        created_at   TIMESTAMP DEFAULT NOW(),
        updated_at   TIMESTAMP DEFAULT NOW(),
        resolved_at  TIMESTAMP
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS work_ticket_events (
        id          SERIAL PRIMARY KEY,
        ticket_id   INT NOT NULL REFERENCES work_tickets(id) ON DELETE CASCADE,
        actor_id    INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        action      VARCHAR(30) NOT NULL,
        from_status VARCHAR(20),
        to_status   VARCHAR(20),
        note        TEXT,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_raised_by   ON work_tickets(raised_by)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON work_tickets(assigned_to)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON work_ticket_events(ticket_id)`);
  })().catch(err => { ready = null; throw err; });
  return ready;
}

const TICKET_SELECT = `
  SELECT t.*,
         CONCAT(a.first_name,' ',a.last_name) AS assigned_to_name, a.employee_code AS assigned_to_code,
         CONCAT(r.first_name,' ',r.last_name) AS raised_by_name,   r.employee_code AS raised_by_code
  FROM work_tickets t
  LEFT JOIN employees a ON a.id = t.assigned_to
  LEFT JOIN employees r ON r.id = t.raised_by
`;

// Who a ticket can be routed to — support-role staff only.
exports.getAssignableEmployees = async (req, res) => {
  try {
    const r = await db.query(
      `SELECT e.id, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name, d.name AS department_name
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.is_active=true AND LOWER(e.role) = ANY($1)
       ORDER BY e.first_name`,
      [SUPPORT_ROLES]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('[tickets.getAssignableEmployees]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.listTickets = async (req, res) => {
  try {
    await ensureTables();
    const { status, mine, assigned_to_me } = req.query;
    const params = [];
    let where;
    if (isSuperAdmin(req.user)) {
      where = '1=1';
    } else if (mine === '1') {
      params.push(req.user.id); where = `t.raised_by=$${params.length}`;
    } else if (assigned_to_me === '1' || isSupportRole(req.user)) {
      params.push(req.user.id); where = `t.assigned_to=$${params.length}`;
    } else {
      params.push(req.user.id); where = `t.raised_by=$${params.length}`;
    }
    if (status) { params.push(status); where += ` AND t.status=$${params.length}`; }
    const r = await db.query(`${TICKET_SELECT} WHERE ${where} ORDER BY t.created_at DESC`, params);
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('[tickets.listTickets]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.createTicket = async (req, res) => {
  const client = await db.getClient();
  try {
    await ensureTables();
    const { title, description, priority, due_date, assigned_to } = req.body;
    if (!title || !String(title).trim()) return res.status(400).json({ success: false, message: 'Title is required' });
    const ids = Array.isArray(assigned_to) ? assigned_to.filter(Boolean) : (assigned_to ? [assigned_to] : []);
    if (ids.length === 0) return res.status(400).json({ success: false, message: 'Select at least one assignee' });
    const pr = PRIORITIES.includes(priority) ? priority : 'medium';

    await client.query('BEGIN');
    const created = [];
    for (const empId of ids) {
      const ins = await client.query(
        `INSERT INTO work_tickets (title, description, priority, due_date, raised_by, assigned_to)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [title, description || null, pr, due_date || null, req.user.id, empId]
      );
      const ticketId = ins.rows[0].id;
      await client.query(
        `INSERT INTO work_ticket_events (ticket_id, actor_id, action, to_status) VALUES ($1,$2,'created','open')`,
        [ticketId, req.user.id]
      );
      created.push(ticketId);
    }
    await client.query('COMMIT');
    res.json({ success: true, message: `Raised ${created.length} ticket(s)`, data: { ids: created } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[tickets.createTicket]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
};

function canAct(user, ticket) {
  return isSuperAdmin(user) || ticket.raised_by === user.id || ticket.assigned_to === user.id;
}

exports.getTicket = async (req, res) => {
  try {
    await ensureTables();
    const id = parseInt(req.params.id);
    const r = await db.query(`${TICKET_SELECT} WHERE t.id=$1`, [id]);
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Ticket not found' });
    const ticket = r.rows[0];
    if (!canAct(req.user, ticket)) return res.status(403).json({ success: false, message: 'Not authorized' });
    const ev = await db.query(
      `SELECT e.id, e.actor_id, CONCAT(emp.first_name,' ',emp.last_name) AS actor_name,
              e.action, e.from_status, e.to_status, e.note, e.created_at
       FROM work_ticket_events e LEFT JOIN employees emp ON emp.id = e.actor_id
       WHERE e.ticket_id=$1 ORDER BY e.created_at ASC`,
      [id]
    );
    ticket.events = ev.rows;
    res.json({ success: true, data: ticket });
  } catch (err) {
    console.error('[tickets.getTicket]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.updateStatus = async (req, res) => {
  try {
    await ensureTables();
    const id = parseInt(req.params.id);
    const { status, note } = req.body;
    if (!STATUSES.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });
    const r = await db.query(`SELECT * FROM work_tickets WHERE id=$1`, [id]);
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Ticket not found' });
    const ticket = r.rows[0];
    if (!canAct(req.user, ticket)) return res.status(403).json({ success: false, message: 'Not authorized' });

    const resolvedAt = (status === 'resolved' || status === 'closed') ? 'NOW()' : 'NULL';
    await db.query(
      `UPDATE work_tickets SET status=$1, updated_at=NOW(), resolved_at=${resolvedAt} WHERE id=$2`,
      [status, id]
    );
    await db.query(
      `INSERT INTO work_ticket_events (ticket_id, actor_id, action, from_status, to_status, note)
       VALUES ($1,$2,'status_changed',$3,$4,$5)`,
      [id, req.user.id, ticket.status, status, note || null]
    );
    res.json({ success: true, message: 'Status updated' });
  } catch (err) {
    console.error('[tickets.updateStatus]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.addComment = async (req, res) => {
  try {
    await ensureTables();
    const id = parseInt(req.params.id);
    const { note } = req.body;
    if (!note || !String(note).trim()) return res.status(400).json({ success: false, message: 'Comment cannot be empty' });
    const r = await db.query(`SELECT * FROM work_tickets WHERE id=$1`, [id]);
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (!canAct(req.user, r.rows[0])) return res.status(403).json({ success: false, message: 'Not authorized' });
    await db.query(
      `INSERT INTO work_ticket_events (ticket_id, actor_id, action, note) VALUES ($1,$2,'comment',$3)`,
      [id, req.user.id, note]
    );
    res.json({ success: true, message: 'Comment added' });
  } catch (err) {
    console.error('[tickets.addComment]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
