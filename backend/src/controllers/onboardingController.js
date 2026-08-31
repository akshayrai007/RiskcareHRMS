const CONFIG = require('../Main_file');
const db = require('../config/db');

const ONBOARDING_STEPS = [
  { key: 'offer_letter',       label: 'Offer Letter',       order: 1 },
  { key: 'joining_formalities',label: 'Joining Formalities', order: 2 },
  { key: 'document_upload',    label: 'Document Upload',     order: 3 },
  { key: 'email_id',           label: 'Email ID',            order: 4 },
  { key: 'welcome_mail',       label: 'Welcome Mail',        order: 5 },
  { key: 'login_accesses',     label: 'Login Accesses',      order: 6 },
  { key: 'assets',             label: 'Assets',              order: 7 },
  { key: 'add_to_gpa',         label: 'Add to GPA',          order: 8 },
  { key: 'add_to_gtl',         label: 'Add to GTL',          order: 9 },
  { key: 'appointment_letter', label: 'Appointment Letter',  order: 10 },
  { key: 'confirmation_mail',  label: 'Confirmation Mail',   order: 11 },
  { key: 'increment_letter',   label: 'Increment Letter',    order: 12 },
  { key: 'relieving_letter',   label: 'Relieving Letter',    order: 13 },
];

exports.ONBOARDING_STEPS = ONBOARDING_STEPS;

// ── DB Init ──────────────────────────────────────────────────────────────────
exports.initTables = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS onboarding_tracker (
        id             SERIAL PRIMARY KEY,
        employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        step_key       VARCHAR(50) NOT NULL,
        step_order     INTEGER NOT NULL,
        status         VARCHAR(20) DEFAULT 'pending',
        completed_at   TIMESTAMP,
        completed_by   INTEGER REFERENCES employees(id),
        remarks        TEXT,
        created_at     TIMESTAMP DEFAULT NOW(),
        updated_at     TIMESTAMP DEFAULT NOW(),
        UNIQUE(employee_id, step_key)
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_onboarding_emp ON onboarding_tracker(employee_id)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS onboarding_history (
        id             SERIAL PRIMARY KEY,
        employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        step_key       VARCHAR(50) NOT NULL,
        old_status     VARCHAR(20),
        new_status     VARCHAR(20) NOT NULL,
        changed_by     INTEGER REFERENCES employees(id),
        remarks        TEXT,
        changed_at     TIMESTAMP DEFAULT NOW()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_onboarding_hist_emp ON onboarding_history(employee_id)`);

    console.log('✅ Onboarding tracker + history tables ready');
  } catch (err) {
    console.error('❌ Onboarding tracker table init error:', err.message);
  }
};

// ── Auto-seed: insert all 13 steps as 'pending' for a new employee ───────────
// Called from employeeController.create and employeeImportController.importEmployees
// Accepts either a pg Client (inside a transaction) or falls back to pool
exports.seedForEmployee = async (employeeId, clientOrNull) => {
  const q = clientOrNull || db;
  for (const step of ONBOARDING_STEPS) {
    await q.query(`
      INSERT INTO onboarding_tracker (employee_id, step_key, step_order, status)
      VALUES ($1, $2, $3, 'pending')
      ON CONFLICT (employee_id, step_key) DO NOTHING
    `, [employeeId, step.key, step.order]);
  }
};

// ── Audit helper: log every status change ────────────────────────────────────
async function logHistory(empId, stepKey, oldStatus, newStatus, changedBy, remarks, clientOrNull) {
  const q = clientOrNull || db;
  await q.query(`
    INSERT INTO onboarding_history (employee_id, step_key, old_status, new_status, changed_by, remarks)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [empId, stepKey, oldStatus, newStatus, changedBy, remarks || null]);
}

// ── GET /onboarding/steps ────────────────────────────────────────────────────
exports.getSteps = (req, res) => {
  res.json({ success: true, data: ONBOARDING_STEPS });
};

// ── GET /onboarding ──────────────────────────────────────────────────────────
exports.getAll = async (req, res) => {
  try {
    const { status, search } = req.query;

    let whereClause = `WHERE e.is_active = true`;
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      whereClause += ` AND (
        e.employee_code ILIKE $${params.length}
        OR CONCAT(e.first_name,' ',e.last_name) ILIKE $${params.length}
        OR d.name ILIKE $${params.length}
      )`;
    }

    const result = await db.query(`
      SELECT
        e.id, e.employee_code,
        CONCAT(e.first_name,' ',e.last_name) AS full_name,
        e.joining_date,
        d.name AS department_name,
        des.title AS designation_title,
        e.employment_type,
        COALESCE(ot.total_steps, 0)     AS total_steps,
        COALESCE(ot.completed_steps, 0) AS completed_steps
      FROM employees e
      LEFT JOIN departments d ON e.department_id = d.id
      LEFT JOIN designations des ON e.designation_id = des.id
      LEFT JOIN (
        SELECT employee_id,
               COUNT(*) AS total_steps,
               COUNT(*) FILTER (WHERE status = 'done') AS completed_steps
        FROM onboarding_tracker
        GROUP BY employee_id
      ) ot ON ot.employee_id = e.id
      ${whereClause}
      ORDER BY e.joining_date DESC NULLS LAST, e.first_name
    `, params);

    let rows = result.rows;

    if (status === 'completed') {
      rows = rows.filter(r => r.total_steps > 0 && r.completed_steps >= 13);
    } else if (status === 'in_progress') {
      rows = rows.filter(r => r.total_steps > 0 && r.completed_steps > 0 && r.completed_steps < 13);
    } else if (status === 'not_started') {
      rows = rows.filter(r => r.total_steps === 0 || r.completed_steps === 0);
    }

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[onboarding.getAll]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /onboarding/:employee_id ─────────────────────────────────────────────
exports.getEmployee = async (req, res) => {
  try {
    const empId = parseInt(req.params.employee_id);

    const empRes = await db.query(`
      SELECT e.id, e.employee_code,
             CONCAT(e.first_name,' ',e.last_name) AS full_name,
             e.joining_date, e.email, e.phone,
             d.name AS department_name,
             des.title AS designation_title,
             e.employment_type
      FROM employees e
      LEFT JOIN departments d ON e.department_id = d.id
      LEFT JOIN designations des ON e.designation_id = des.id
      WHERE e.id = $1
    `, [empId]);

    if (!empRes.rows.length)
      return res.status(404).json({ success: false, message: 'Employee not found' });

    // Auto-seed if this employee has no rows yet (first time viewing)
    const countRes = await db.query(
      `SELECT COUNT(*) FROM onboarding_tracker WHERE employee_id = $1`, [empId]
    );
    if (parseInt(countRes.rows[0].count) === 0) {
      await exports.seedForEmployee(empId);
    }

    const stepsRes = await db.query(`
      SELECT ot.*, CONCAT(cb.first_name,' ',cb.last_name) AS completed_by_name
      FROM onboarding_tracker ot
      LEFT JOIN employees cb ON ot.completed_by = cb.id
      WHERE ot.employee_id = $1
      ORDER BY ot.step_order
    `, [empId]);

    const existingSteps = {};
    stepsRes.rows.forEach(s => { existingSteps[s.step_key] = s; });

    const steps = ONBOARDING_STEPS.map(s => {
      const existing = existingSteps[s.key];
      return {
        step_key:    s.key,
        step_order:  s.order,
        label:       s.label,
        status:      existing?.status || 'pending',
        completed_at:       existing?.completed_at || null,
        completed_by_name:  existing?.completed_by_name || null,
        remarks:            existing?.remarks || '',
      };
    });

    res.json({ success: true, employee: empRes.rows[0], steps });
  } catch (err) {
    console.error('[onboarding.getEmployee]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── POST /onboarding/:employee_id/step ───────────────────────────────────────
exports.updateStep = async (req, res) => {
  try {
    const empId   = parseInt(req.params.employee_id);
    const { step_key, status, remarks } = req.body;

    if (!step_key || !status)
      return res.status(400).json({ success: false, message: 'step_key and status required' });

    const stepDef = ONBOARDING_STEPS.find(s => s.key === step_key);
    if (!stepDef)
      return res.status(400).json({ success: false, message: 'Invalid step_key' });

    const validStatuses = ['pending', 'done', 'na'];
    if (!validStatuses.includes(status))
      return res.status(400).json({ success: false, message: 'Status must be pending, done, or na' });

    // Get old status for audit
    const oldRes = await db.query(
      `SELECT status FROM onboarding_tracker WHERE employee_id = $1 AND step_key = $2`,
      [empId, step_key]
    );
    const oldStatus = oldRes.rows[0]?.status || 'pending';

    const completedAt = status === 'done' ? new Date() : null;
    const completedBy = status === 'done' ? req.user.id : null;

    await db.query(`
      INSERT INTO onboarding_tracker (employee_id, step_key, step_order, status, completed_at, completed_by, remarks, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (employee_id, step_key)
      DO UPDATE SET status = $4, completed_at = $5, completed_by = $6,
                    remarks = COALESCE($7, onboarding_tracker.remarks),
                    updated_at = NOW()
    `, [empId, step_key, stepDef.order, status, completedAt, completedBy, remarks || null]);

    // Audit log
    if (oldStatus !== status) {
      await logHistory(empId, step_key, oldStatus, status, req.user.id, remarks);
    }

    res.json({ success: true, message: `Step "${stepDef.label}" updated to ${status}` });
  } catch (err) {
    console.error('[onboarding.updateStep]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── POST /onboarding/:employee_id/bulk ───────────────────────────────────────
exports.bulkUpdate = async (req, res) => {
  try {
    const empId = parseInt(req.params.employee_id);
    const { steps } = req.body;

    if (!Array.isArray(steps) || !steps.length)
      return res.status(400).json({ success: false, message: 'steps array required' });

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      for (const s of steps) {
        const stepDef = ONBOARDING_STEPS.find(d => d.key === s.step_key);
        if (!stepDef) continue;

        const oldRes = await client.query(
          `SELECT status FROM onboarding_tracker WHERE employee_id = $1 AND step_key = $2`,
          [empId, s.step_key]
        );
        const oldStatus = oldRes.rows[0]?.status || 'pending';

        const completedAt = s.status === 'done' ? new Date() : null;
        const completedBy = s.status === 'done' ? req.user.id : null;

        await client.query(`
          INSERT INTO onboarding_tracker (employee_id, step_key, step_order, status, completed_at, completed_by, remarks, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (employee_id, step_key)
          DO UPDATE SET status = $4, completed_at = $5, completed_by = $6,
                        remarks = COALESCE($7, onboarding_tracker.remarks),
                        updated_at = NOW()
        `, [empId, s.step_key, stepDef.order, s.status, completedAt, completedBy, s.remarks || null]);

        if (oldStatus !== s.status) {
          await logHistory(empId, s.step_key, oldStatus, s.status, req.user.id, s.remarks, client);
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ success: true, message: 'Steps updated' });
  } catch (err) {
    console.error('[onboarding.bulkUpdate]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── POST /onboarding/seed-all — backfill existing employees ──────────────────
exports.seedAll = async (req, res) => {
  try {
    const empRes = await db.query(`SELECT id FROM employees WHERE is_active = true`);
    let seeded = 0;
    for (const emp of empRes.rows) {
      const existing = await db.query(
        `SELECT COUNT(*) FROM onboarding_tracker WHERE employee_id = $1`, [emp.id]
      );
      if (parseInt(existing.rows[0].count) === 0) {
        await exports.seedForEmployee(emp.id);
        seeded++;
      }
    }
    res.json({ success: true, message: `Seeded onboarding steps for ${seeded} employee(s)`, seeded });
  } catch (err) {
    console.error('[onboarding.seedAll]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /onboarding/:employee_id/history — full audit trail ──────────────────
exports.getHistory = async (req, res) => {
  try {
    const empId = parseInt(req.params.employee_id);
    const result = await db.query(`
      SELECT oh.*,
             CONCAT(cb.first_name,' ',cb.last_name) AS changed_by_name
      FROM onboarding_history oh
      LEFT JOIN employees cb ON oh.changed_by = cb.id
      WHERE oh.employee_id = $1
      ORDER BY oh.changed_at DESC
      LIMIT 100
    `, [empId]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[onboarding.getHistory]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /onboarding/dashboard ────────────────────────────────────────────────
exports.getDashboard = async (req, res) => {
  try {
    const totalEmpRes = await db.query(`SELECT COUNT(*) FROM employees WHERE is_active = true`);
    const totalEmp = parseInt(totalEmpRes.rows[0].count);

    const statsRes = await db.query(`
      SELECT
        COUNT(DISTINCT CASE WHEN sub.completed_steps >= 13 THEN sub.employee_id END) AS fully_completed,
        COUNT(DISTINCT CASE WHEN sub.completed_steps > 0 AND sub.completed_steps < 13 THEN sub.employee_id END) AS in_progress,
        COUNT(DISTINCT CASE WHEN sub.completed_steps = 0 OR sub.completed_steps IS NULL THEN sub.employee_id END) AS not_started
      FROM (
        SELECT ot.employee_id,
               COUNT(*) FILTER (WHERE ot.status = 'done') AS completed_steps
        FROM onboarding_tracker ot
        JOIN employees e ON e.id = ot.employee_id AND e.is_active = true
        GROUP BY ot.employee_id
      ) sub
    `);

    const stats = statsRes.rows[0];
    const tracked = parseInt(stats.fully_completed) + parseInt(stats.in_progress);
    const notStarted = totalEmp - tracked;

    const stepStatsRes = await db.query(`
      SELECT step_key,
             COUNT(*) FILTER (WHERE status = 'done') AS done_count,
             COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
             COUNT(*) FILTER (WHERE status = 'na') AS na_count
      FROM onboarding_tracker
      JOIN employees e ON e.id = onboarding_tracker.employee_id AND e.is_active = true
      GROUP BY step_key
    `);

    const stepStats = {};
    stepStatsRes.rows.forEach(r => { stepStats[r.step_key] = r; });

    res.json({
      success: true,
      data: {
        total_employees:  totalEmp,
        fully_completed:  parseInt(stats.fully_completed),
        in_progress:      parseInt(stats.in_progress),
        not_started:      notStarted,
        step_stats:       stepStats,
      }
    });
  } catch (err) {
    console.error('[onboarding.getDashboard]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
