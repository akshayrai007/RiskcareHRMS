// src/controllers/performanceController.js
// Performance Review Module — Hierarchical KRA/KPI appraisal
const db     = require('../config/db');
const CONFIG = require('../Main_file');

const ADMIN_ROLES    = CONFIG.performanceAdminRoles    || ['hr','admin','super_admin'];    // ['hr','admin','super_admin']
const REVIEWER_ROLES = CONFIG.performanceReviewerRoles || ['hr','admin','super_admin','manager','tl']; // ['hr','admin','super_admin','manager','tl']
const DEFAULT_WEIGHT = CONFIG.performanceDefaultWeight || 20;

// ── Auto-create tables on first use ───────────────────────────────────────────
let tablesReady = false;
async function ensureTables() {
  if (tablesReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS performance_cycles (
      id              SERIAL PRIMARY KEY,
      title           VARCHAR(200) NOT NULL,
      start_date      DATE NOT NULL,
      end_date        DATE NOT NULL,
      review_due_date DATE,
      description     TEXT,
      status          VARCHAR(20) DEFAULT 'draft',
      created_by      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS performance_reviews (
      id                      SERIAL PRIMARY KEY,
      cycle_id                INTEGER NOT NULL REFERENCES performance_cycles(id) ON DELETE CASCADE,
      employee_id             INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      reviewer_id             INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      status                  VARCHAR(20) DEFAULT 'pending',
      self_overall_comment    TEXT,
      manager_overall_comment TEXT,
      final_rating            VARCHAR(100),
      calculated_score        NUMERIC(5,2),
      submitted_at            TIMESTAMPTZ,
      completed_at            TIMESTAMPTZ,
      created_at              TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(cycle_id, employee_id)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS performance_goals (
      id               SERIAL PRIMARY KEY,
      review_id        INTEGER NOT NULL REFERENCES performance_reviews(id) ON DELETE CASCADE,
      title            VARCHAR(300) NOT NULL,
      description      TEXT,
      weightage        NUMERIC(5,2) DEFAULT 20,
      target           TEXT,
      unit             VARCHAR(50),
      achievement      TEXT,
      self_rating      NUMERIC(3,1),
      self_comment     TEXT,
      manager_rating   NUMERIC(3,1),
      manager_comment  TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  tablesReady = true;
}

// ── Helper: get immediate reviewer for an employee from hierarchy ─────────────
// Priority: team_leader_id → reporting_manager_id → null
async function getReviewerForEmployee(empId) {
  const r = await db.query(
    `SELECT reporting_manager_id, team_leader_id FROM employees WHERE id = $1`,
    [empId]
  );
  if (!r.rows.length) return null;
  const { team_leader_id, reporting_manager_id } = r.rows[0];
  return team_leader_id || reporting_manager_id || null;
}

// ══════════════════════════════════════════════════
//  GET /performance/cycles
//  - Admin/HR: see all cycles with full counts
//  - Employee/Manager: see cycles they are part of + their own progress
// ══════════════════════════════════════════════════
exports.getCycles = async (req, res) => {
  try {
    await ensureTables();
    const user = req.user;
    const isAdmin = ADMIN_ROLES.includes(user.role);

    if (isAdmin) {
      // Full view for HR/Admin
      const r = await db.query(
        `SELECT pc.*,
                COUNT(DISTINCT pr.id) AS total_reviews,
                COUNT(DISTINCT pr.id) FILTER (WHERE pr.status = 'completed') AS completed_reviews
         FROM performance_cycles pc
         LEFT JOIN performance_reviews pr ON pr.cycle_id = pc.id
         GROUP BY pc.id
         ORDER BY pc.start_date DESC`
      );
      return res.json({ success: true, data: r.rows });
    }

    // For non-admin: only return cycles where they have a review
    const r = await db.query(
      `SELECT pc.*,
              pr.status AS my_status,
              pr.calculated_score AS my_score,
              pr.id AS my_review_id
       FROM performance_cycles pc
       JOIN performance_reviews pr ON pr.cycle_id = pc.id AND pr.employee_id = $1
       ORDER BY pc.start_date DESC`,
      [user.id]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════
//  POST /performance/cycles  (Admin/HR only)
// ══════════════════════════════════════════════════
exports.createCycle = async (req, res) => {
  try {
    await ensureTables();
    const { title, start_date, end_date, review_due_date, description } = req.body;
    if (!title || !start_date || !end_date)
      return res.status(400).json({ success: false, message: 'title, start_date, end_date are required' });
    const r = await db.query(
      `INSERT INTO performance_cycles (title, start_date, end_date, review_due_date, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [title, start_date, end_date, review_due_date||null, description||null, req.user.id]
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════
//  GET /performance/cycles/:id
//  - Admin/HR: full cycle with all reviews
//  - Manager/TL: cycle + reviews of their direct reports only
//  - Employee: 404 (they use /reviews/my)
// ══════════════════════════════════════════════════
exports.getCycle = async (req, res) => {
  try {
    await ensureTables();
    const user = req.user;
    const isAdmin = ADMIN_ROLES.includes(user.role);
    const isReviewer = REVIEWER_ROLES.includes(user.role);

    const cycle = await db.query(`SELECT * FROM performance_cycles WHERE id = $1`, [req.params.id]);
    if (!cycle.rows.length) return res.status(404).json({ success: false, message: 'Cycle not found' });

    let reviewsQuery, reviewsParams;

    if (isAdmin) {
      // HR/Admin see all reviews in this cycle
      reviewsQuery = `
        SELECT pr.*,
               e.first_name, e.last_name, e.employee_code,
               des.title AS designation, d.name AS department,
               r.first_name AS reviewer_first, r.last_name AS reviewer_last
        FROM performance_reviews pr
        JOIN employees e ON e.id = pr.employee_id
        LEFT JOIN designations des ON des.id = e.designation_id
        LEFT JOIN departments  d   ON d.id   = e.department_id
        LEFT JOIN employees r ON r.id = pr.reviewer_id
        WHERE pr.cycle_id = $1
        ORDER BY e.first_name`;
      reviewsParams = [req.params.id];
    } else if (isReviewer) {
      // Manager/TL: see only direct reports (where reviewer_id = me)
      reviewsQuery = `
        SELECT pr.*,
               e.first_name, e.last_name, e.employee_code,
               des.title AS designation, d.name AS department,
               r.first_name AS reviewer_first, r.last_name AS reviewer_last
        FROM performance_reviews pr
        JOIN employees e ON e.id = pr.employee_id
        LEFT JOIN designations des ON des.id = e.designation_id
        LEFT JOIN departments  d   ON d.id   = e.department_id
        LEFT JOIN employees r ON r.id = pr.reviewer_id
        WHERE pr.cycle_id = $1 AND pr.reviewer_id = $2
        ORDER BY e.first_name`;
      reviewsParams = [req.params.id, user.id];
    } else {
      // Regular employee: can view cycle metadata only if they have a review in this cycle
      const empCheck = await db.query(
        `SELECT id FROM performance_reviews WHERE cycle_id = $1 AND employee_id = $2`,
        [req.params.id, user.id]
      );
      if (!empCheck.rows.length)
        return res.status(403).json({ success: false, message: 'Access denied' });

      // Return cycle info with empty reviews array (employee should not see peers)
      return res.json({ success: true, data: { cycle: cycle.rows[0], reviews: [] } });
    }

    const reviews = await db.query(reviewsQuery, reviewsParams);
    res.json({ success: true, data: { cycle: cycle.rows[0], reviews: reviews.rows } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════
//  POST /performance/cycles/:id/initiate  (Admin/HR only)
//  Creates one review per active employee, sets reviewer_id
//  from hierarchy: team_leader_id → reporting_manager_id
// ══════════════════════════════════════════════════
exports.initiateCycle = async (req, res) => {
  try {
    await ensureTables();
    const cycleId = req.params.id;
    const cycle = await db.query(`SELECT * FROM performance_cycles WHERE id = $1`, [cycleId]);
    if (!cycle.rows.length) return res.status(404).json({ success: false, message: 'Cycle not found' });

    // Get all active employees with their hierarchy
    const emps = await db.query(
      `SELECT id, reporting_manager_id, team_leader_id
       FROM employees
       WHERE is_active = true OR is_active IS NULL`
    );

    let created = 0;
    for (const emp of emps.rows) {
      const exists = await db.query(
        `SELECT id FROM performance_reviews WHERE cycle_id=$1 AND employee_id=$2`,
        [cycleId, emp.id]
      );
      if (!exists.rows.length) {
        // Immediate reviewer = TL first, then reporting manager
        const reviewerId = emp.team_leader_id || emp.reporting_manager_id || null;
        await db.query(
          `INSERT INTO performance_reviews (cycle_id, employee_id, reviewer_id, status)
           VALUES ($1, $2, $3, 'pending')`,
          [cycleId, emp.id, reviewerId]
        );
        created++;
      }
    }
    await db.query(`UPDATE performance_cycles SET status='active' WHERE id=$1`, [cycleId]);
    res.json({ success: true, message: `Cycle initiated. ${created} review(s) created.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════
//  GET /performance/reviews/my
//  Returns the current user's OWN reviews only
// ══════════════════════════════════════════════════
exports.getMyReviews = async (req, res) => {
  try {
    await ensureTables();
    const r = await db.query(
      `SELECT pr.*, pc.title AS cycle_title, pc.start_date, pc.end_date, pc.review_due_date,
              rv.first_name AS reviewer_first, rv.last_name AS reviewer_last
       FROM performance_reviews pr
       JOIN performance_cycles pc ON pc.id = pr.cycle_id
       LEFT JOIN employees rv ON rv.id = pr.reviewer_id
       WHERE pr.employee_id = $1
       ORDER BY pc.start_date DESC`,
      [req.user.id]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════
//  GET /performance/reviews/team
//  Manager/TL: see reviews of their direct reports
// ══════════════════════════════════════════════════
exports.getTeamReviews = async (req, res) => {
  try {
    await ensureTables();
    const user = req.user;
    if (!REVIEWER_ROLES.includes(user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const { cycle_id } = req.query;
    const cycleFilter = cycle_id ? `AND pr.cycle_id = ${parseInt(cycle_id)}` : '';

    const r = await db.query(
      `SELECT pr.*,
              pc.title AS cycle_title,
              e.first_name, e.last_name, e.employee_code,
              des.title AS designation, d.name AS department
       FROM performance_reviews pr
       JOIN performance_cycles pc ON pc.id = pr.cycle_id
       JOIN employees e ON e.id = pr.employee_id
       LEFT JOIN designations des ON des.id = e.designation_id
       LEFT JOIN departments  d   ON d.id   = e.department_id
       WHERE pr.reviewer_id = $1 ${cycleFilter}
       ORDER BY pc.start_date DESC, e.first_name`,
      [user.id]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════
//  GET /performance/reviews/:id
//  Access: own review OR reviewer of that review OR admin/HR
// ══════════════════════════════════════════════════
exports.getReview = async (req, res) => {
  try {
    await ensureTables();
    const review = await db.query(
      `SELECT pr.*,
              pc.title AS cycle_title, pc.start_date, pc.end_date, pc.review_due_date,
              e.first_name, e.last_name, e.employee_code,
              des.title AS designation, d.name AS department,
              rv.first_name AS reviewer_first, rv.last_name AS reviewer_last
       FROM performance_reviews pr
       JOIN performance_cycles pc ON pc.id = pr.cycle_id
       JOIN employees e ON e.id = pr.employee_id
       LEFT JOIN designations des ON des.id = e.designation_id
       LEFT JOIN departments  d   ON d.id   = e.department_id
       LEFT JOIN employees rv ON rv.id = pr.reviewer_id
       WHERE pr.id = $1`,
      [req.params.id]
    );
    if (!review.rows.length) return res.status(404).json({ success: false, message: 'Review not found' });

    const rev = review.rows[0];
    const user = req.user;

    // Access: own review | direct reviewer | admin/HR
    const canAccess = ADMIN_ROLES.includes(user.role)
      || Number(rev.employee_id) === Number(user.id)
      || Number(rev.reviewer_id) === Number(user.id);

    if (!canAccess) return res.status(403).json({ success: false, message: 'Access denied' });

    const goals = await db.query(
      `SELECT * FROM performance_goals WHERE review_id = $1 ORDER BY id`,
      [req.params.id]
    );
    res.json({ success: true, data: { ...rev, goals: goals.rows } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════
//  POST /performance/reviews/:id/goals
//  Only the employee themselves can add goals
// ══════════════════════════════════════════════════
exports.addGoal = async (req, res) => {
  try {
    await ensureTables();
    const { title, description, weightage, target, unit } = req.body;
    if (!title) return res.status(400).json({ success: false, message: 'title is required' });

    const rev = await db.query(`SELECT * FROM performance_reviews WHERE id = $1`, [req.params.id]);
    if (!rev.rows.length) return res.status(404).json({ success: false, message: 'Review not found' });

    // Only the employee or admin can add goals
    if (!ADMIN_ROLES.includes(req.user.role) && Number(rev.rows[0].employee_id) !== Number(req.user.id))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const r = await db.query(
      `INSERT INTO performance_goals (review_id, title, description, weightage, target, unit)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, title, description||null, weightage||DEFAULT_WEIGHT, target||null, unit||null]
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════
//  PUT /performance/goals/:id
//  Employee: edit self_rating/self_comment/achievement
//  Reviewer (direct manager/TL): edit manager_rating/manager_comment
//  Admin: edit everything
// ══════════════════════════════════════════════════
exports.updateGoal = async (req, res) => {
  try {
    await ensureTables();
    const { title, description, weightage, target, unit,
            self_rating, self_comment, manager_rating, manager_comment, achievement } = req.body;
    const user = req.user;

    const goal = await db.query(
      `SELECT pg.*, pr.employee_id, pr.reviewer_id, pr.status
       FROM performance_goals pg
       JOIN performance_reviews pr ON pr.id = pg.review_id
       WHERE pg.id = $1`,
      [req.params.id]
    );
    if (!goal.rows.length) return res.status(404).json({ success: false, message: 'Goal not found' });
    const g = goal.rows[0];

    let fields = [], vals = [], i = 1;

    if (ADMIN_ROLES.includes(user.role)) {
      if (title !== undefined)           { fields.push(`title=$${i++}`);           vals.push(title); }
      if (description !== undefined)     { fields.push(`description=$${i++}`);     vals.push(description); }
      if (weightage !== undefined)       { fields.push(`weightage=$${i++}`);       vals.push(weightage); }
      if (target !== undefined)          { fields.push(`target=$${i++}`);          vals.push(target); }
      if (unit !== undefined)            { fields.push(`unit=$${i++}`);            vals.push(unit); }
      if (self_rating !== undefined)     { fields.push(`self_rating=$${i++}`);     vals.push(self_rating); }
      if (self_comment !== undefined)    { fields.push(`self_comment=$${i++}`);    vals.push(self_comment); }
      if (manager_rating !== undefined)  { fields.push(`manager_rating=$${i++}`);  vals.push(manager_rating); }
      if (manager_comment !== undefined) { fields.push(`manager_comment=$${i++}`); vals.push(manager_comment); }
      if (achievement !== undefined)     { fields.push(`achievement=$${i++}`);     vals.push(achievement); }
    } else if (Number(user.id) === Number(g.employee_id)) {
      // Employee: only self-assessment fields
      if (self_rating !== undefined)  { fields.push(`self_rating=$${i++}`);  vals.push(self_rating); }
      if (self_comment !== undefined) { fields.push(`self_comment=$${i++}`); vals.push(self_comment); }
      if (achievement !== undefined)  { fields.push(`achievement=$${i++}`);  vals.push(achievement); }
    } else if (Number(user.id) === Number(g.reviewer_id)) {
      // Direct reviewer only: manager rating fields
      if (manager_rating !== undefined)  { fields.push(`manager_rating=$${i++}`);  vals.push(manager_rating); }
      if (manager_comment !== undefined) { fields.push(`manager_comment=$${i++}`); vals.push(manager_comment); }
    } else {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    if (!fields.length) return res.status(400).json({ success: false, message: 'Nothing to update' });
    vals.push(req.params.id);
    const r = await db.query(
      `UPDATE performance_goals SET ${fields.join(',')} WHERE id=$${i} RETURNING *`, vals
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════
//  PUT /performance/reviews/:id/submit
//  Employee submits their self-review → status becomes 'submitted'
//  Reviewer (manager/TL) is auto-notified via reviewer_id already set
// ══════════════════════════════════════════════════
exports.submitReview = async (req, res) => {
  try {
    await ensureTables();
    const { self_overall_comment } = req.body;
    const rev = await db.query(`SELECT * FROM performance_reviews WHERE id=$1`, [req.params.id]);
    if (!rev.rows.length) return res.status(404).json({ success: false, message: 'Review not found' });
    if (Number(rev.rows[0].employee_id) !== Number(req.user.id))
      return res.status(403).json({ success: false, message: 'Only the employee can submit their own review' });

    await db.query(
      `UPDATE performance_reviews
       SET status='submitted', self_overall_comment=$1, submitted_at=NOW()
       WHERE id=$2`,
      [self_overall_comment||null, req.params.id]
    );
    res.json({ success: true, message: 'Self review submitted. Your manager will now review it.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════
//  PUT /performance/reviews/:id/complete
//  Direct reviewer completes the review with manager ratings
//  Access: reviewer_id of this review OR admin/HR
// ══════════════════════════════════════════════════
exports.completeReview = async (req, res) => {
  try {
    await ensureTables();
    const { manager_overall_comment, final_rating } = req.body;
    const user = req.user;

    const rev = await db.query(`SELECT * FROM performance_reviews WHERE id=$1`, [req.params.id]);
    if (!rev.rows.length) return res.status(404).json({ success: false, message: 'Review not found' });

    // Only direct reviewer or admin can complete
    const canComplete = ADMIN_ROLES.includes(user.role) || Number(rev.rows[0].reviewer_id) === Number(user.id);
    if (!canComplete) return res.status(403).json({ success: false, message: 'Access denied' });

    const goals = await db.query(
      `SELECT weightage, manager_rating FROM performance_goals WHERE review_id=$1`, [req.params.id]
    );
    let totalWeight = 0, weightedScore = 0;
    for (const g of goals.rows) {
      if (g.manager_rating) {
        totalWeight   += parseFloat(g.weightage || 0);
        weightedScore += parseFloat(g.manager_rating) * parseFloat(g.weightage || 0);
      }
    }
    const calculated_score = totalWeight > 0 ? (weightedScore / totalWeight).toFixed(2) : null;

    await db.query(
      `UPDATE performance_reviews
       SET status='completed', manager_overall_comment=$1, final_rating=$2,
           calculated_score=$3, reviewer_id=$4, completed_at=NOW()
       WHERE id=$5`,
      [manager_overall_comment||null, final_rating||null, calculated_score, user.id, req.params.id]
    );
    res.json({ success: true, message: 'Review completed', calculated_score });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════
//  GET /performance/summary  (Admin/HR only)
// ══════════════════════════════════════════════════
exports.getSummary = async (req, res) => {
  try {
    await ensureTables();
    const { cycle_id } = req.query;
    const cycleFilter = cycle_id ? `AND pr.cycle_id = ${parseInt(cycle_id)}` : '';

    const r = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE pr.status='pending')   AS pending,
         COUNT(*) FILTER (WHERE pr.status='submitted') AS submitted,
         COUNT(*) FILTER (WHERE pr.status='completed') AS completed,
         AVG(pr.calculated_score) FILTER (WHERE pr.calculated_score IS NOT NULL) AS avg_score,
         COUNT(*) AS total
       FROM performance_reviews pr
       WHERE 1=1 ${cycleFilter}`
    );

    const byDept = await db.query(
      `SELECT d.name AS department,
              COUNT(*) AS total,
              ROUND(AVG(pr.calculated_score) FILTER (WHERE pr.calculated_score IS NOT NULL), 2) AS avg_score,
              COUNT(*) FILTER (WHERE pr.status='completed') AS completed
       FROM performance_reviews pr
       JOIN employees e ON e.id = pr.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE 1=1 ${cycleFilter}
       GROUP BY d.name
       ORDER BY avg_score DESC NULLS LAST`
    );

    const topPerformers = await db.query(
      `SELECT e.first_name, e.last_name,
              des.title AS designation, d.name AS department,
              pr.calculated_score, pr.final_rating
       FROM performance_reviews pr
       JOIN employees e ON e.id = pr.employee_id
       LEFT JOIN designations des ON des.id = e.designation_id
       LEFT JOIN departments  d   ON d.id   = e.department_id
       WHERE pr.calculated_score IS NOT NULL ${cycleFilter}
       ORDER BY pr.calculated_score DESC
       LIMIT 5`
    );

    res.json({
      success: true,
      data: { stats: r.rows[0], byDepartment: byDept.rows, topPerformers: topPerformers.rows }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════
//  DELETE /performance/goals/:id
//  Only employee (own review) or admin
// ══════════════════════════════════════════════════
exports.deleteGoal = async (req, res) => {
  try {
    await ensureTables();
    const goal = await db.query(
      `SELECT pg.*, pr.employee_id FROM performance_goals pg
       JOIN performance_reviews pr ON pr.id = pg.review_id
       WHERE pg.id = $1`, [req.params.id]
    );
    if (!goal.rows.length) return res.status(404).json({ success: false, message: 'Goal not found' });
    if (!ADMIN_ROLES.includes(req.user.role) && Number(goal.rows[0].employee_id) !== Number(req.user.id))
      return res.status(403).json({ success: false, message: 'Access denied' });

    await db.query(`DELETE FROM performance_goals WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'Goal deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════
//  POST /performance/reviews/:id/assign-reviewer  (Admin/HR only)
// ══════════════════════════════════════════════════
exports.assignReviewer = async (req, res) => {
  try {
    await ensureTables();
    const { reviewer_id } = req.body;
    await db.query(`UPDATE performance_reviews SET reviewer_id=$1 WHERE id=$2`, [reviewer_id, req.params.id]);
    res.json({ success: true, message: 'Reviewer assigned' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Get all reviews (HR/admin view) ──────────────────────────────────────────
exports.getAllReviews = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT pc.id, pc.title, pc.status, pc.start_date, pc.end_date,
              COUNT(pr.id) AS review_count
       FROM performance_cycles pc
       LEFT JOIN performance_reviews pr ON pr.cycle_id = pc.id
       GROUP BY pc.id
       ORDER BY pc.created_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('getAllReviews error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};
