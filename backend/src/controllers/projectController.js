const CONFIG = require('../Main_file');
// src/controllers/projectController.js
// Project Budget Tracking — COMPLETE CONTROLLER
// Tracks: salary, advance, reimbursement costs per project
// Features: project CRUD, employee assignment, payroll auto-cost, biweekly progress reports, Excel export

const db   = require('../config/db');
const XLSX = require('xlsx');

// ── Role Helpers ──────────────────────────────────────────────────────────────
const ADMIN_ROLES    = ['super_admin', 'admin', 'accounts'];
const MANAGER_ROLES  = ['super_admin', 'admin', 'accounts', 'manager', 'tl'];

// ══════════════════════════════════════════════════════════════════════════════
// MIGRATIONS — call on server startup to create tables if not exist
// ══════════════════════════════════════════════════════════════════════════════
exports.migrate = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Projects master table
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id               SERIAL PRIMARY KEY,
        name             VARCHAR(200) NOT NULL,
        code             VARCHAR(50)  UNIQUE,
        client_name      VARCHAR(200),
        description      TEXT,
        start_date       DATE,
        end_date         DATE,
        status           VARCHAR(30) DEFAULT 'active',
        total_budget     NUMERIC(14,2) DEFAULT 0,
        planned_cost     NUMERIC(14,2) DEFAULT 0,
        project_manager_id INT REFERENCES employees(id),
        created_by       INT REFERENCES employees(id),
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Employees assigned to a project
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_employees (
        id              SERIAL PRIMARY KEY,
        project_id      INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        employee_id     INT NOT NULL REFERENCES employees(id),
        role_in_project VARCHAR(100),
        salary_pct      NUMERIC(5,2) DEFAULT 0,
        assigned_at     TIMESTAMPTZ DEFAULT NOW(),
        assigned_by     INT REFERENCES employees(id),
        is_active       BOOLEAN DEFAULT true,
        UNIQUE(project_id, employee_id)
      )
    `);
    // Add salary_pct to existing tables created before this migration
    await client.query(`ALTER TABLE project_employees ADD COLUMN IF NOT EXISTS salary_pct NUMERIC(5,2) DEFAULT 0`).catch(()=>{});

    // All expenditure transactions linked to a project
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_expenditures (
        id              SERIAL PRIMARY KEY,
        project_id      INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        employee_id     INT REFERENCES employees(id),
        type            VARCHAR(30) NOT NULL,
        reference_id    INT,
        amount          NUMERIC(12,2) NOT NULL,
        description     TEXT,
        month           INT,
        year            INT,
        recorded_by     INT REFERENCES employees(id),
        recorded_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Biweekly progress reports
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_progress_reports (
        id              SERIAL PRIMARY KEY,
        project_id      INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        period_start    DATE NOT NULL,
        period_end      DATE NOT NULL,
        report_type     VARCHAR(20) DEFAULT 'biweekly',
        submitted_by    INT REFERENCES employees(id),
        submitted_at    TIMESTAMPTZ,
        work_done       TEXT,
        data_count      JSONB,
        achievements    TEXT,
        challenges      TEXT,
        plan_next       TEXT,
        target_data     JSONB,
        actual_achieved TEXT,
        achievement_pct NUMERIC(5,2),
        status          VARCHAR(20) DEFAULT 'pending',
        manager_remarks TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query('COMMIT');
    console.log('[projectController] Tables migrated ✓');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[projectController] Migration failed:', err.message);
  } finally {
    client.release();
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// PROJECTS CRUD
// ══════════════════════════════════════════════════════════════════════════════

// GET /projects  — list all (with budget totals)
exports.listProjects = async (req, res) => {
  try {
    const { status } = req.query;
    const role = req.user.role;

    let where = '';
    const params = [];
    if (status) { where = 'WHERE p.status=$1'; params.push(status); }

    const result = await db.query(`
      SELECT p.*,
             CONCAT(pm.first_name,' ',pm.last_name) AS project_manager_name,
             CONCAT(cb.first_name,' ',cb.last_name)  AS created_by_name,
             COALESCE(SUM(pe.amount),0)              AS actual_cost,
             COALESCE(SUM(CASE WHEN pe.type='salary'        THEN pe.amount ELSE 0 END),0) AS salary_cost,
             COALESCE(SUM(CASE WHEN pe.type='advance'       THEN pe.amount ELSE 0 END),0) AS advance_cost,
             COALESCE(SUM(CASE WHEN pe.type='reimbursement' THEN pe.amount ELSE 0 END),0) AS reimbursement_cost,
             COUNT(DISTINCT pem.employee_id) AS employee_count
      FROM projects p
      LEFT JOIN employees pm  ON p.project_manager_id = pm.id
      LEFT JOIN employees cb  ON p.created_by = cb.id
      LEFT JOIN project_expenditures pe ON pe.project_id = p.id
      LEFT JOIN project_employees pem ON pem.project_id = p.id AND pem.is_active = true
      ${where}
      GROUP BY p.id, pm.first_name, pm.last_name, cb.first_name, cb.last_name
      ORDER BY p.created_at DESC
    `, params);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /projects/:id — single project with full details
exports.getProject = async (req, res) => {
  try {
    const { id } = req.params;

    const proj = await db.query(`
      SELECT p.*,
             CONCAT(pm.first_name,' ',pm.last_name) AS project_manager_name,
             COALESCE(SUM(pe.amount),0)              AS actual_cost,
             COALESCE(SUM(CASE WHEN pe.type='salary'        THEN pe.amount ELSE 0 END),0) AS salary_cost,
             COALESCE(SUM(CASE WHEN pe.type='advance'       THEN pe.amount ELSE 0 END),0) AS advance_cost,
             COALESCE(SUM(CASE WHEN pe.type='reimbursement' THEN pe.amount ELSE 0 END),0) AS reimbursement_cost
      FROM projects p
      LEFT JOIN employees pm ON p.project_manager_id = pm.id
      LEFT JOIN project_expenditures pe ON pe.project_id = p.id
      WHERE p.id=$1
      GROUP BY p.id, pm.first_name, pm.last_name
    `, [id]);

    if (!proj.rows.length)
      return res.status(404).json({ success: false, message: 'Project not found' });

    // Assigned employees (include salary_pct for allocation UI)
    const emps = await db.query(`
      SELECT pem.*, e.first_name, e.last_name, e.employee_code, e.role,
             d.name AS department_name, des.title AS designation_title
      FROM project_employees pem
      JOIN employees e ON pem.employee_id = e.id
      LEFT JOIN departments d ON e.department_id = d.id
      LEFT JOIN designations des ON e.designation_id = des.id
      WHERE pem.project_id=$1 AND pem.is_active=true
      ORDER BY e.first_name
    `, [id]);

    // Expenditures (last 50)
    const expends = await db.query(`
      SELECT pe.*, e.first_name, e.last_name, e.employee_code
      FROM project_expenditures pe
      LEFT JOIN employees e ON pe.employee_id = e.id
      WHERE pe.project_id=$1
      ORDER BY pe.recorded_at DESC LIMIT 50
    `, [id]);

    // Progress reports
    const reports = await db.query(`
      SELECT pr.*, CONCAT(e.first_name,' ',e.last_name) AS submitted_by_name
      FROM project_progress_reports pr
      LEFT JOIN employees e ON pr.submitted_by = e.id
      WHERE pr.project_id=$1
      ORDER BY pr.period_start DESC
    `, [id]);

    res.json({
      success: true,
      data: {
        ...proj.rows[0],
        employees: emps.rows,
        expenditures: expends.rows,
        reports: reports.rows,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /projects — create project (accounts/super_admin)
exports.createProject = async (req, res) => {
  try {
    if (!ADMIN_ROLES.includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const {
      name, code, client_name, description,
      start_date, end_date, status = 'active',
      total_budget = 0, planned_cost = 0,
      project_manager_id
    } = req.body;

    if (!name?.trim())
      return res.status(400).json({ success: false, message: 'Project name is required' });

    const result = await db.query(`
      INSERT INTO projects
        (name, code, client_name, description, start_date, end_date, status,
         total_budget, planned_cost, project_manager_id, created_by, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      RETURNING *
    `, [name.trim(), code?.trim()||null, client_name?.trim()||null, description?.trim()||null,
        start_date||null, end_date||null, status,
        parseFloat(total_budget)||0, parseFloat(planned_cost)||0,
        project_manager_id||null, req.user.id]);

    res.json({ success: true, data: result.rows[0], message: 'Project created successfully' });
  } catch (err) {
    if (err.code === '23505')
      return res.status(400).json({ success: false, message: 'Project code already exists' });
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PUT /projects/:id — update project
exports.updateProject = async (req, res) => {
  try {
    if (!ADMIN_ROLES.includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const { id } = req.params;
    const {
      name, code, client_name, description,
      start_date, end_date, status,
      total_budget, planned_cost, project_manager_id
    } = req.body;

    const result = await db.query(`
      UPDATE projects SET
        name=$1, code=$2, client_name=$3, description=$4,
        start_date=$5, end_date=$6, status=$7,
        total_budget=$8, planned_cost=$9, project_manager_id=$10,
        updated_at=NOW()
      WHERE id=$11 RETURNING *
    `, [name, code||null, client_name||null, description||null,
        start_date||null, end_date||null, status,
        parseFloat(total_budget)||0, parseFloat(planned_cost)||0,
        project_manager_id||null, id]);

    if (!result.rows.length)
      return res.status(404).json({ success: false, message: 'Project not found' });

    res.json({ success: true, data: result.rows[0], message: 'Project updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// DELETE /projects/:id — delete project (accounts/super_admin only)
exports.deleteProject = async (req, res) => {
  try {
    if (!ADMIN_ROLES.includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const { id } = req.params;

    // Check project exists
    const proj = await db.query('SELECT id, name FROM projects WHERE id=$1', [id]);
    if (!proj.rows.length)
      return res.status(404).json({ success: false, message: 'Project not found' });

    // Nullify project_id on any advance_salary / reimbursements rows that reference this project.
    // These tables may have an FK without ON DELETE CASCADE, so we must clear them first.
    await db.query(`UPDATE advance_salary    SET project_id = NULL WHERE project_id = $1`, [id]).catch(() => {});
    await db.query(`UPDATE reimbursements    SET project_id = NULL WHERE project_id = $1`, [id]).catch(() => {});

    // Delete project — CASCADE will remove project_employees, project_expenditures, project_progress_reports
    await db.query('DELETE FROM projects WHERE id=$1', [id]);

    res.json({ success: true, message: `Project "${proj.rows[0].name}" deleted successfully` });
  } catch (err) {
    console.error('[deleteProject]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// EMPLOYEE ASSIGNMENT
// ══════════════════════════════════════════════════════════════════════════════

// POST /projects/:id/assign — assign employee to project
exports.assignEmployee = async (req, res) => {
  try {
    if (!ADMIN_ROLES.includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const projectId    = parseInt(req.params.id);
    const employeeId   = parseInt(req.body.employee_id);
    const { role_in_project } = req.body;

    if (!projectId  || isNaN(projectId))  return res.status(400).json({ success: false, message: 'Invalid project id' });
    if (!employeeId || isNaN(employeeId)) return res.status(400).json({ success: false, message: 'Invalid employee_id — must be a number' });

    // Auto-run migration if table doesn't exist yet
    await db.query(`
      CREATE TABLE IF NOT EXISTS project_employees (
        id              SERIAL PRIMARY KEY,
        project_id      INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        employee_id     INT NOT NULL REFERENCES employees(id),
        role_in_project VARCHAR(100),
        assigned_at     TIMESTAMPTZ DEFAULT NOW(),
        assigned_by     INT REFERENCES employees(id),
        is_active       BOOLEAN DEFAULT true,
        UNIQUE(project_id, employee_id)
      )
    `);

    // Check project exists
    const proj = await db.query('SELECT id FROM projects WHERE id=$1', [projectId]);
    if (!proj.rows.length)
      return res.status(404).json({ success: false, message: 'Project not found' });

    // Check employee exists
    const emp = await db.query('SELECT id FROM employees WHERE id=$1 AND is_active=true', [employeeId]);
    if (!emp.rows.length)
      return res.status(404).json({ success: false, message: 'Employee not found' });

    // Upsert (re-activate if previously removed)
    await db.query(`
      INSERT INTO project_employees (project_id, employee_id, role_in_project, assigned_by, is_active)
      VALUES ($1,$2,$3,$4,true)
      ON CONFLICT(project_id, employee_id) DO UPDATE SET
        is_active=true, role_in_project=$3, assigned_by=$4, assigned_at=NOW()
    `, [projectId, employeeId, role_in_project||null, req.user.id]);

    res.json({ success: true, message: 'Employee assigned to project' });
  } catch (err) {
    console.error('[assignEmployee]', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
};

// DELETE /projects/:id/employees/:empId — remove employee from project
exports.removeEmployee = async (req, res) => {
  try {
    if (!ADMIN_ROLES.includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const { id, empId } = req.params;
    await db.query(
      'UPDATE project_employees SET is_active=false WHERE project_id=$1 AND employee_id=$2',
      [id, empId]
    );
    res.json({ success: true, message: 'Employee removed from project' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// SALARY ALLOCATION — Accounts sets % split per employee across projects
// ══════════════════════════════════════════════════════════════════════════════

// GET /projects/employees/:empId/allocation — get all project allocations for an employee
exports.getEmployeeAllocation = async (req, res) => {
  try {
    if (!ADMIN_ROLES.includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const { empId } = req.params;
    const result = await db.query(`
      SELECT pe.project_id, pe.salary_pct, pe.role_in_project,
             p.name AS project_name, p.code AS project_code, p.status AS project_status
      FROM project_employees pe
      JOIN projects p ON pe.project_id = p.id
      WHERE pe.employee_id=$1 AND pe.is_active=true
      ORDER BY p.name
    `, [empId]);

    const total = result.rows.reduce((s, r) => s + parseFloat(r.salary_pct || 0), 0);
    res.json({ success: true, data: result.rows, total_pct: parseFloat(total.toFixed(2)) });
  } catch (err) {
    console.error('[getEmployeeAllocation]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PUT /projects/employees/:empId/allocation — save % allocations for an employee across all projects
// Body: { allocations: [{ project_id, salary_pct }, ...] }
exports.setSalaryAllocation = async (req, res) => {
  try {
    if (!ADMIN_ROLES.includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const { empId } = req.params;
    const { allocations } = req.body; // [{ project_id, salary_pct }]

    if (!Array.isArray(allocations) || allocations.length === 0)
      return res.status(400).json({ success: false, message: 'allocations array required' });

    // Validate total = 100
    const total = allocations.reduce((s, a) => s + parseFloat(a.salary_pct || 0), 0);
    if (Math.abs(total - 100) > 0.01)
      return res.status(400).json({
        success: false,
        message: `Total allocation must equal 100%. Currently: ${total.toFixed(2)}%`
      });

    // Validate all values are non-negative
    for (const a of allocations) {
      if (parseFloat(a.salary_pct) < 0)
        return res.status(400).json({ success: false, message: 'Allocation % cannot be negative' });
    }

    // Save each
    for (const a of allocations) {
      await db.query(
        `UPDATE project_employees SET salary_pct=$1 WHERE employee_id=$2 AND project_id=$3 AND is_active=true`,
        [parseFloat(a.salary_pct), empId, a.project_id]
      );
    }

    res.json({ success: true, message: 'Salary allocation saved successfully' });
  } catch (err) {
    console.error('[setSalaryAllocation]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// EXPENDITURE — Manual add + auto-hooks from payroll/advance/reimbursement
// ══════════════════════════════════════════════════════════════════════════════

// POST /projects/:id/expenditure — manually add expenditure
exports.addExpenditure = async (req, res) => {
  try {
    if (!ADMIN_ROLES.includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const { id } = req.params;
    const { employee_id, type, amount, description, month, year, reference_id } = req.body;

    if (!type || !amount || amount <= 0)
      return res.status(400).json({ success: false, message: 'type and positive amount required' });

    const result = await db.query(`
      INSERT INTO project_expenditures
        (project_id, employee_id, type, reference_id, amount, description, month, year, recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [id, employee_id||null, type, reference_id||null,
        parseFloat(amount), description||null,
        month||null, year||null, req.user.id]);

    res.json({ success: true, data: result.rows[0], message: 'Expenditure recorded' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Called internally when payroll is processed — splits salary by salary_pct across projects
exports.hookPayrollExpenditure = async (employeeId, amount, month, year, payrollId) => {
  try {
    // Find active project assignments with their salary %
    const projects = await db.query(
      `SELECT project_id, salary_pct FROM project_employees WHERE employee_id=$1 AND is_active=true`,
      [employeeId]
    );

    if (!projects.rows.length) return; // Not assigned to any project

    // Check if any allocation is defined (at least one > 0)
    const totalPct = projects.rows.reduce((s, r) => s + parseFloat(r.salary_pct || 0), 0);
    if (totalPct === 0) {
      console.warn(`[hookPayroll] Employee ${employeeId} has no salary allocation set — skipping project split`);
      return;
    }

    for (const row of projects.rows) {
      const pct = parseFloat(row.salary_pct || 0);
      if (pct <= 0) continue; // Skip projects with 0% allocation

      const splitAmount = parseFloat(((amount * pct) / 100).toFixed(2));

      // Dedup: skip if already recorded for this payroll in this project
      const exists = await db.query(
        `SELECT id FROM project_expenditures WHERE project_id=$1 AND employee_id=$2 AND type='salary' AND month=$3 AND year=$4 AND reference_id=$5`,
        [row.project_id, employeeId, month, year, payrollId]
      );
      if (!exists.rows.length) {
        await db.query(`
          INSERT INTO project_expenditures
            (project_id, employee_id, type, reference_id, amount, description, month, year, recorded_by)
          VALUES ($1,$2,'salary',$3,$4,$5,$6,$7,$8)
        `, [row.project_id, employeeId, payrollId, splitAmount,
            `Salary ${month}/${year} (${pct}% allocation)`, month, year, employeeId]);
      }
    }
  } catch (err) {
    console.error('[projectController.hookPayroll]', err.message);
  }
};

// Called internally when advance/reimbursement approved & paid
exports.hookFinanceExpenditure = async (employeeId, amount, type, referenceId, projectId, description) => {
  try {
    if (!projectId) return;
    const exists = await db.query(
      `SELECT id FROM project_expenditures WHERE reference_id=$1 AND type=$2`,
      [referenceId, type]
    );
    if (!exists.rows.length) {
      await db.query(`
        INSERT INTO project_expenditures
          (project_id, employee_id, type, reference_id, amount, description, recorded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [projectId, employeeId, type, referenceId, parseFloat(amount), description||null, employeeId]);
    }
  } catch (err) {
    console.error('[projectController.hookFinance]', err.message);
  }
};

// GET /projects/:id/expenditures — paginated expenditure list
exports.getExpenditures = async (req, res) => {
  try {
    const { id } = req.params;
    const { type, month, year, page = 1, limit = 50 } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [id];
    let where = 'WHERE pe.project_id=$1';

    if (type)  { params.push(type);         where += ` AND pe.type=$${params.length}`; }
    if (month) { params.push(parseInt(month)); where += ` AND pe.month=$${params.length}`; }
    if (year)  { params.push(parseInt(year));  where += ` AND pe.year=$${params.length}`; }

    params.push(parseInt(limit)); params.push(offset);

    const result = await db.query(`
      SELECT pe.*, e.first_name, e.last_name, e.employee_code,
             rb.first_name AS recorded_by_fname, rb.last_name AS recorded_by_lname
      FROM project_expenditures pe
      LEFT JOIN employees e  ON pe.employee_id = e.id
      LEFT JOIN employees rb ON pe.recorded_by = rb.id
      ${where}
      ORDER BY pe.recorded_at DESC
      LIMIT $${params.length-1} OFFSET $${params.length}
    `, params);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// PROGRESS REPORTS (Biweekly)
// ══════════════════════════════════════════════════════════════════════════════

// GET /projects/:id/reports — list reports
exports.listReports = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`
      SELECT pr.*, CONCAT(e.first_name,' ',e.last_name) AS submitted_by_name,
             e.employee_code AS submitted_by_code
      FROM project_progress_reports pr
      LEFT JOIN employees e ON pr.submitted_by = e.id
      WHERE pr.project_id=$1
      ORDER BY pr.period_start DESC
    `, [id]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /projects/:id/reports — submit progress report
exports.submitReport = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      period_start, period_end,
      work_done, data_count, achievements, challenges,
      plan_next, target_data,
      actual_achieved, achievement_pct,  // filled after 15 days
      report_type = 'biweekly'
    } = req.body;

    // Only project manager or admin can submit
    const proj = await db.query('SELECT project_manager_id FROM projects WHERE id=$1', [id]);
    if (!proj.rows.length)
      return res.status(404).json({ success: false, message: 'Project not found' });

    const isPM    = proj.rows[0].project_manager_id === req.user.id;
    const isAdmin = ADMIN_ROLES.includes(req.user.role);
    if (!isPM && !isAdmin)
      return res.status(403).json({ success: false, message: 'Only project manager or admin can submit reports' });

    const result = await db.query(`
      INSERT INTO project_progress_reports
        (project_id, period_start, period_end, report_type,
         submitted_by, submitted_at,
         work_done, data_count, achievements, challenges,
         plan_next, target_data, actual_achieved, achievement_pct, status)
      VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,$10,$11,$12,$13,'submitted')
      RETURNING *
    `, [id, period_start, period_end, report_type,
        req.user.id,
        work_done||null,
        data_count ? JSON.stringify(data_count) : null,
        achievements||null, challenges||null,
        plan_next||null,
        target_data ? JSON.stringify(target_data) : null,
        actual_achieved||null,
        achievement_pct ? parseFloat(achievement_pct) : null]);

    res.json({ success: true, data: result.rows[0], message: 'Progress report submitted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PATCH /projects/reports/:reportId — update/review report
exports.updateReport = async (req, res) => {
  try {
    const { reportId } = req.params;
    const {
      work_done, data_count, achievements, challenges,
      plan_next, target_data, actual_achieved, achievement_pct,
      manager_remarks, status
    } = req.body;

    const result = await db.query(`
      UPDATE project_progress_reports SET
        work_done=$1, data_count=$2, achievements=$3, challenges=$4,
        plan_next=$5, target_data=$6, actual_achieved=$7, achievement_pct=$8,
        manager_remarks=$9, status=COALESCE($10,status)
      WHERE id=$11 RETURNING *
    `, [work_done||null,
        data_count ? JSON.stringify(data_count) : null,
        achievements||null, challenges||null,
        plan_next||null,
        target_data ? JSON.stringify(target_data) : null,
        actual_achieved||null,
        achievement_pct ? parseFloat(achievement_pct) : null,
        manager_remarks||null, status||null,
        reportId]);

    if (!result.rows.length)
      return res.status(404).json({ success: false, message: 'Report not found' });

    res.json({ success: true, data: result.rows[0], message: 'Report updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /projects/pending-reports — reports due for current period (for notifications)
exports.pendingReports = async (req, res) => {
  try {
    // Projects where user is PM and no report submitted in last 15 days
    const today = new Date();
    const cutoff = new Date(today - 15 * 24 * 60 * 60 * 1000);

    const result = await db.query(`
      SELECT p.id, p.name, p.code,
             MAX(pr.submitted_at) AS last_report_at
      FROM projects p
      LEFT JOIN project_progress_reports pr ON pr.project_id = p.id
      WHERE p.project_manager_id=$1 AND p.status='active'
      GROUP BY p.id, p.name, p.code
      HAVING MAX(pr.submitted_at) IS NULL OR MAX(pr.submitted_at) < $2
    `, [req.user.id, cutoff]);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// CONSOLIDATED REPORT + EXCEL EXPORT
// ══════════════════════════════════════════════════════════════════════════════

// GET /projects/:id/export — Excel export for accounts
exports.exportProjectExcel = async (req, res) => {
  try {
    if (req.user.role !== 'accounts' && req.user.role !== 'super_admin')
      return res.status(403).json({ success: false, message: 'Only Accounts can download Excel reports' });

    const { id } = req.params;

    // Fetch project
    const proj = await db.query(`
      SELECT p.*, CONCAT(pm.first_name,' ',pm.last_name) AS project_manager_name
      FROM projects p
      LEFT JOIN employees pm ON p.project_manager_id = pm.id
      WHERE p.id=$1
    `, [id]);
    if (!proj.rows.length) return res.status(404).json({ success: false, message: 'Project not found' });
    const p = proj.rows[0];

    // Fetch expenditures
    const expends = await db.query(`
      SELECT pe.*, e.first_name||' '||e.last_name AS employee_name, e.employee_code
      FROM project_expenditures pe
      LEFT JOIN employees e ON pe.employee_id = e.id
      WHERE pe.project_id=$1 ORDER BY pe.recorded_at DESC
    `, [id]);

    // Fetch employees
    const emps = await db.query(`
      SELECT pem.*, e.first_name||' '||e.last_name AS name, e.employee_code,
             d.name AS dept, des.title AS designation,
             COALESCE(SUM(pe.amount),0) AS total_cost
      FROM project_employees pem
      JOIN employees e ON pem.employee_id=e.id
      LEFT JOIN departments d ON e.department_id=d.id
      LEFT JOIN designations des ON e.designation_id=des.id
      LEFT JOIN project_expenditures pe ON pe.project_id=pem.project_id AND pe.employee_id=pem.employee_id
      WHERE pem.project_id=$1
      GROUP BY pem.id, e.first_name, e.last_name, e.employee_code, d.name, des.title
    `, [id]);

    // Fetch progress reports
    const reports = await db.query(`
      SELECT pr.*, CONCAT(e.first_name,' ',e.last_name) AS submitted_by
      FROM project_progress_reports pr
      LEFT JOIN employees e ON pr.submitted_by=e.id
      WHERE pr.project_id=$1 ORDER BY pr.period_start DESC
    `, [id]);

    const wb = XLSX.utils.book_new();

    // ── Sheet 1: Summary ──
    const totalActual = expends.rows.reduce((s, r) => s + parseFloat(r.amount), 0);
    const salaryCost  = expends.rows.filter(r=>r.type==='salary').reduce((s,r)=>s+parseFloat(r.amount),0);
    const advCost     = expends.rows.filter(r=>r.type==='advance').reduce((s,r)=>s+parseFloat(r.amount),0);
    const reimbCost   = expends.rows.filter(r=>r.type==='reimbursement').reduce((s,r)=>s+parseFloat(r.amount),0);

    const summaryData = [
      ['PROJECT BUDGET REPORT', ''],
      ['Generated On', new Date().toLocaleString('' + (CONFIG.currencyLocale||'en-IN') + "'")],
      [''],
      ['Project Name',    p.name],
      ['Project Code',    p.code || '—'],
      ['Client',          p.client_name || '—'],
      ['Status',          p.status],
      ['Project Manager', p.project_manager_name || '—'],
      ['Start Date',      p.start_date ? new Date(p.start_date).toLocaleDateString('' + (CONFIG.currencyLocale||'en-IN') + "'") : '—'],
      ['End Date',        p.end_date   ? new Date(p.end_date).toLocaleDateString('' + (CONFIG.currencyLocale||'en-IN') + "'")   : '—'],
      [''],
      ['BUDGET SUMMARY', ''],
      ['Client Budget (Total)',  `₹${parseFloat(p.total_budget||0).toLocaleString('' + (CONFIG.currencyLocale||'en-IN') + "'")}`],
      ['Planned Cost (Org)',     `₹${parseFloat(p.planned_cost||0).toLocaleString('' + (CONFIG.currencyLocale||'en-IN') + "'")}`],
      ['Actual Cost (Spent)',    `₹${totalActual.toLocaleString('' + (CONFIG.currencyLocale||'en-IN') + "'")}`],
      ['  → Salary',            `₹${salaryCost.toLocaleString('' + (CONFIG.currencyLocale||'en-IN') + "'")}`],
      ['  → Advance',           `₹${advCost.toLocaleString('' + (CONFIG.currencyLocale||'en-IN') + "'")}`],
      ['  → Reimbursement',     `₹${reimbCost.toLocaleString('' + (CONFIG.currencyLocale||'en-IN') + "'")}`],
      ['Budget Utilisation',    `${p.total_budget > 0 ? ((totalActual/p.total_budget)*100).toFixed(1) : '—'}%`],
      ['Variance (Budget-Actual)', `₹${(parseFloat(p.total_budget||0) - totalActual).toLocaleString('' + (CONFIG.currencyLocale||'en-IN') + "'")}`],
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(summaryData);
    ws1['!cols'] = [{wch:30},{wch:25}];
    XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

    // ── Sheet 2: Expenditure Details ──
    const expRows = [
      ['Date','Employee Code','Employee Name','Type','Description','Month','Year','Amount (₹)','Recorded By']
    ];
    for (const e of expends.rows) {
      expRows.push([
        new Date(e.recorded_at).toLocaleDateString('' + (CONFIG.currencyLocale||'en-IN') + "'"),
        e.employee_code || '—',
        e.employee_name || '—',
        e.type,
        e.description || '—',
        e.month || '—',
        e.year  || '—',
        parseFloat(e.amount),
        e.recorded_by_name || '—',
      ]);
    }
    const ws2 = XLSX.utils.aoa_to_sheet(expRows);
    ws2['!cols'] = [{wch:14},{wch:14},{wch:22},{wch:14},{wch:30},{wch:8},{wch:8},{wch:14},{wch:18}];
    XLSX.utils.book_append_sheet(wb, ws2, 'Expenditure Details');

    // ── Sheet 3: Assigned Employees ──
    const empRows = [
      ['Employee Code','Name','Department','Designation','Role In Project','Total Cost (₹)','Assigned On']
    ];
    for (const e of emps.rows) {
      empRows.push([
        e.employee_code, e.name, e.dept||'—', e.designation||'—',
        e.role_in_project||'—', parseFloat(e.total_cost),
        new Date(e.assigned_at).toLocaleDateString('' + (CONFIG.currencyLocale||'en-IN') + "'"),
      ]);
    }
    const ws3 = XLSX.utils.aoa_to_sheet(empRows);
    ws3['!cols'] = [{wch:14},{wch:22},{wch:18},{wch:20},{wch:18},{wch:16},{wch:14}];
    XLSX.utils.book_append_sheet(wb, ws3, 'Team Members');

    // ── Sheet 4: Progress Reports ──
    const rptRows = [
      ['Period Start','Period End','Work Done','Achievements','Challenges','Plan Next Period','Target %','Actual Achieved','Achievement %','Submitted By','Submitted At','Manager Remarks']
    ];
    for (const r of reports.rows) {
      rptRows.push([
        r.period_start ? new Date(r.period_start).toLocaleDateString('' + (CONFIG.currencyLocale||'en-IN') + "'") : '—',
        r.period_end   ? new Date(r.period_end).toLocaleDateString('' + (CONFIG.currencyLocale||'en-IN') + "'")   : '—',
        r.work_done        || '—',
        r.achievements     || '—',
        r.challenges       || '—',
        r.plan_next        || '—',
        r.target_data ? JSON.stringify(r.target_data) : '—',
        r.actual_achieved  || '—',
        r.achievement_pct  != null ? `${r.achievement_pct}%` : '—',
        r.submitted_by     || '—',
        r.submitted_at ? new Date(r.submitted_at).toLocaleDateString('' + (CONFIG.currencyLocale||'en-IN') + "'") : '—',
        r.manager_remarks  || '—',
      ]);
    }
    const ws4 = XLSX.utils.aoa_to_sheet(rptRows);
    ws4['!cols'] = Array(12).fill({wch:22});
    XLSX.utils.book_append_sheet(wb, ws4, 'Progress Reports');

    // Send
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `Project_${p.code || p.id}_Budget_Report_${new Date().toISOString().slice(0,10)}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error generating Excel' });
  }
};

// GET /projects/summary — overall summary across all projects (accounts dashboard)
exports.getSummary = async (req, res) => {
  try {
    if (!ADMIN_ROLES.includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const result = await db.query(`
      SELECT
        COUNT(DISTINCT p.id)                   AS total_projects,
        COUNT(DISTINCT CASE WHEN p.status='active' THEN p.id END) AS active_projects,
        COALESCE(SUM(p.total_budget),0)        AS total_budget,
        COALESCE(SUM(p.planned_cost),0)        AS total_planned,
        COALESCE((SELECT SUM(amount) FROM project_expenditures),0) AS total_actual,
        COALESCE((SELECT SUM(amount) FROM project_expenditures WHERE type='salary'),0) AS total_salary,
        COALESCE((SELECT SUM(amount) FROM project_expenditures WHERE type='advance'),0) AS total_advance,
        COALESCE((SELECT SUM(amount) FROM project_expenditures WHERE type='reimbursement'),0) AS total_reimbursement
      FROM projects p
    `);

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
