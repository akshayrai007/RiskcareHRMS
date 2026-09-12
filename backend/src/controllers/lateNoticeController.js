// src/controllers/lateNoticeController.js
// ── COMING LATE NOTICES ──────────────────────────────────────────────────────
// Any employee can inform they'll be late: expected arrival time + a reason.
// Visible to their own reporting manager (reporting_manager_id, not the role
// field) and to HR/admin/super_admin. A plain employee cannot see anyone
// else's notice, only confirm their own was submitted.

const db = require('../config/db');
const emailSvc = require('../config/emailService');
const { sendPush } = require('../config/pushService');

const SUPPORT_ROLES = ['admin', 'hr', 'super_admin'];
function isSupportRole(user) {
  return SUPPORT_ROLES.includes(String(user.role || '').toLowerCase());
}

let ready = null;
async function ensureTable() {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS late_notices (
        id           SERIAL PRIMARY KEY,
        employee_id  INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        notice_date  DATE NOT NULL DEFAULT CURRENT_DATE,
        expected_time VARCHAR(5) NOT NULL,
        reason       TEXT NOT NULL,
        status       VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        approved_by  INT REFERENCES employees(id) ON DELETE SET NULL,
        approved_at  TIMESTAMP,
        created_at   TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`ALTER TABLE late_notices ADD COLUMN IF NOT EXISTS status VARCHAR(10) NOT NULL DEFAULT 'pending'`);
    await db.query(`ALTER TABLE late_notices ADD COLUMN IF NOT EXISTS approved_by INT REFERENCES employees(id) ON DELETE SET NULL`);
    await db.query(`ALTER TABLE late_notices ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_late_notices_employee ON late_notices(employee_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_late_notices_date ON late_notices(notice_date)`);
  })().catch(err => { ready = null; throw err; });
  return ready;
}

// Can this actor act on this employee's notice? HR/admin/super_admin: anyone.
// Otherwise: only that employee's own reporting manager.
async function canActOn(user, employeeId) {
  if (isSupportRole(user)) return true;
  const r = await db.query(
    `SELECT 1 FROM employees WHERE id=$1 AND reporting_manager_id=$2 AND is_active=true LIMIT 1`,
    [employeeId, user.id]
  );
  return r.rows.length > 0;
}

exports.createLateNotice = async (req, res) => {
  try {
    await ensureTable();
    const { expected_time, reason } = req.body;
    if (!expected_time || !/^\d{2}:\d{2}$/.test(expected_time)) {
      return res.status(400).json({ success: false, message: 'Valid expected_time (HH:MM) is required' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, message: 'Reason is required' });
    }
    await db.query(
      `INSERT INTO late_notices (employee_id, expected_time, reason) VALUES ($1,$2,$3)`,
      [req.user.id, expected_time, reason.trim()]
    );

    // Notify the employee's own manager + all HR — in-app, push, and email —
    // exactly the same recipient set the "who can see this" query uses.
    (async () => {
      try {
        const emp = await db.query(
          `SELECT CONCAT(first_name,' ',last_name) AS name, reporting_manager_id FROM employees WHERE id=$1`,
          [req.user.id]
        );
        const name = emp.rows[0]?.name || 'An employee';
        const mgrId = emp.rows[0]?.reporting_manager_id;
        const hrRows = await db.query(`SELECT id FROM employees WHERE role='hr' AND is_active=true`);
        const recipientIds = new Set(hrRows.rows.map(r => r.id));
        if (mgrId) recipientIds.add(mgrId);

        const title = '🕒 Coming Late Today';
        const message = `${name} will arrive late today at ${expected_time} — ${reason.trim()}`;
        for (const id of recipientIds) {
          await db.query(
            `INSERT INTO notifications(employee_id,title,message,type) VALUES($1,$2,$3,'late_notice')`,
            [id, title, message]
          ).catch(() => {});
          sendPush(id, title, message, { channel: 'riskcare_alerts', screen: 'late_notices' });
        }
      } catch (e) { console.error('[lateNotices.notify]', e.message); }
    })();
    emailSvc.notifyLateNotice(req.user.id, expected_time, reason.trim()).catch(() => {});

    res.json({ success: true, message: 'Your manager and HR have been informed' });
  } catch (err) {
    console.error('[lateNotices.create]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Who can see today's notices:
//   - HR/admin/super_admin: everyone's
//   - a real manager (has reportees): their own team's only
//   - everyone else: none (empty list, not an error — lets the Android/web
//     screen render the same "no one is late" state either way)
exports.listLateNotices = async (req, res) => {
  try {
    await ensureTable();
    const { date } = req.query;
    const noticeDate = date || new Date().toISOString().slice(0, 10);

    let where = 't.notice_date = $1';
    const params = [noticeDate];

    if (!isSupportRole(req.user)) {
      const mgr = await db.query(
        `SELECT 1 FROM employees WHERE reporting_manager_id=$1 AND is_active=true LIMIT 1`,
        [req.user.id]
      );
      if (mgr.rows.length === 0) return res.json({ success: true, data: [] });
      params.push(req.user.id);
      where += ` AND e.reporting_manager_id = $${params.length}`;
    }

    const r = await db.query(
      `SELECT t.id, t.employee_id, t.notice_date, t.expected_time, t.reason, t.status, t.created_at,
              CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.employee_code,
              CONCAT(a.first_name,' ',a.last_name) AS approved_by_name
       FROM late_notices t
       JOIN employees e ON e.id = t.employee_id
       LEFT JOIN employees a ON a.id = t.approved_by
       WHERE ${where}
       ORDER BY t.created_at DESC`,
      params
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('[lateNotices.list]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Approving marks that day's attendance punch-in at 10:00 AM (present, not
// late) — the whole point of pre-informing is to not get penalized for it.
// Rejecting just records the decision; attendance is left untouched (the
// employee's actual late punch-in, if any, still applies as normal).
exports.decideLateNotice = async (req, res) => {
  try {
    await ensureTable();
    const id = parseInt(req.params.id);
    const { decision } = req.body; // 'approved' | 'rejected'
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'Invalid decision' });
    }
    const r = await db.query(`SELECT * FROM late_notices WHERE id=$1`, [id]);
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Notice not found' });
    const notice = r.rows[0];
    if (notice.status !== 'pending') return res.status(400).json({ success: false, message: 'Already decided' });
    if (!(await canActOn(req.user, notice.employee_id))) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    await db.query(
      `UPDATE late_notices SET status=$1, approved_by=$2, approved_at=NOW() WHERE id=$3`,
      [decision, req.user.id, id]
    );

    if (decision === 'approved') {
      await db.query(
        `INSERT INTO attendance (employee_id, date, punch_in, status, remarks, punch_in_location)
         VALUES ($1, $2, '10:00:00', 'present', $3, 'Late arrival approved')
         ON CONFLICT (employee_id, date)
         DO UPDATE SET punch_in = '10:00:00', status = 'present',
                       remarks = $3, punch_in_location = 'Late arrival approved'`,
        [notice.employee_id, notice.notice_date, `Approved late arrival — ${notice.reason}`]
      );
    }

    res.json({ success: true, message: decision === 'approved' ? 'Approved — attendance marked at 10:00 AM' : 'Rejected' });
  } catch (err) {
    console.error('[lateNotices.decide]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
