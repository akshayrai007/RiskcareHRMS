// src/controllers/historyController.js
// Powers the "Salary & Promotions" admin view (list + per-employee popup)
// and the company Org Chart.
const db = require('../config/db');

// GET /api/history/employees
// List every active employee with a quick summary so HR/Accounts/Admin can
// see at a glance who has had a recent salary change or promotion, then
// click through for the full timeline.
exports.listEmployees = async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const params = [];
    let where = 'WHERE 1=1';
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where += ` AND (LOWER(e.first_name||' '||e.last_name) LIKE $${params.length} OR LOWER(e.employee_code) LIKE $${params.length} OR LOWER(e.email) LIKE $${params.length})`;
    }

    const result = await db.query(
      `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.email,
              e.profile_photo, e.role, e.level, e.is_active,
              d.name AS department_name, des.title AS designation_title,
              (SELECT COUNT(*) FROM employee_salary_history sh WHERE sh.employee_id = e.id) AS salary_change_count,
              (SELECT COUNT(*) FROM employee_designation_history dh WHERE dh.employee_id = e.id) AS promotion_count,
              (SELECT MAX(sh.effective_date) FROM employee_salary_history sh WHERE sh.employee_id = e.id) AS last_salary_change,
              (SELECT MAX(dh.effective_date) FROM employee_designation_history dh WHERE dh.employee_id = e.id) AS last_promotion
       FROM employees e
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       ${where}
       ORDER BY GREATEST(
         COALESCE((SELECT MAX(sh.changed_at) FROM employee_salary_history sh WHERE sh.employee_id = e.id), '1970-01-01'),
         COALESCE((SELECT MAX(dh.changed_at) FROM employee_designation_history dh WHERE dh.employee_id = e.id), '1970-01-01')
       ) DESC, e.first_name ASC`,
      params
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[historyController.listEmployees]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/history/employees/:id
// Full salary + promotion timeline for one employee, merged and sorted —
// this is what renders inside the popup when HR clicks a row.
exports.getEmployeeHistory = async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    const empRes = await db.query(
      `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.email, e.profile_photo,
              e.role, e.level, e.joining_date, e.ctc, e.basic_salary, e.hra,
              e.special_allowance, e.travel_allowance,
              d.name AS department_name, des.title AS designation_title
       FROM employees e
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       WHERE e.id = $1`,
      [id]
    );
    if (!empRes.rows.length)
      return res.status(404).json({ success: false, message: 'Employee not found' });

    const salaryRes = await db.query(
      `SELECT sh.*, CONCAT(cb.first_name,' ',cb.last_name) AS changed_by_name
       FROM employee_salary_history sh
       LEFT JOIN employees cb ON cb.id = sh.changed_by
       WHERE sh.employee_id = $1
       ORDER BY sh.effective_date DESC, sh.changed_at DESC`,
      [id]
    );

    const promoRes = await db.query(
      `SELECT dh.id, dh.effective_date, dh.changed_at, dh.old_level, dh.new_level, dh.remarks,
              old_d.title AS old_designation, new_d.title AS new_designation,
              CONCAT(cb.first_name,' ',cb.last_name) AS changed_by_name
       FROM employee_designation_history dh
       LEFT JOIN designations old_d ON old_d.id = dh.old_designation_id
       LEFT JOIN designations new_d ON new_d.id = dh.new_designation_id
       LEFT JOIN employees cb ON cb.id = dh.changed_by
       WHERE dh.employee_id = $1
       ORDER BY dh.effective_date DESC, dh.changed_at DESC`,
      [id]
    );

    // Merge into one chronological timeline for a unified view, while also
    // returning the two lists separately in case the UI wants tabs.
    const timeline = [
      ...salaryRes.rows.map(r => ({ type: 'salary', ...r })),
      ...promoRes.rows.map(r => ({ type: 'promotion', ...r })),
    ].sort((a, b) => new Date(b.effective_date || b.changed_at) - new Date(a.effective_date || a.changed_at));

    res.json({
      success: true,
      data: {
        employee: empRes.rows[0],
        salary_history: salaryRes.rows,
        promotion_history: promoRes.rows,
        timeline,
      }
    });
  } catch (err) {
    console.error('[historyController.getEmployeeHistory]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/org-chart
// Flat list of active employees with just enough info to build the
// reporting-line tree on the client (id + reporting_manager_id).
exports.getOrgChart = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT e.id, e.first_name, e.last_name, e.employee_code, e.role, e.level,
              e.profile_photo, e.reporting_manager_id,
              e.date_of_birth, e.email, e.phone, e.blood_group, e.city,
              d.name AS department_name, des.title AS designation_title
       FROM employees e
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       WHERE e.is_active = true
       ORDER BY e.first_name ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[historyController.getOrgChart]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
