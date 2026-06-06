const CONFIG = require('../Main_file');
// src/controllers/provisionController.js
// Handles the 6-month provision → permanent employee workflow
// Approval chain: Manager approves → HR approves → account auto-converts
// Prorated leave (EL/SL/CL) credited from the month of confirmation onward

const emailSvc = require('../config/emailService');
const db = require('../config/db');

// ── Helper: calculate prorated leave for a partial month ─────────────────────
// E.g. employee confirmed on 24 March → they worked (31-24)/31 fraction of March
// Permanent accrual: EL=1.5, SL=0.5, CL=0.5 per month
function proratedLeave(confirmDate, year, month) {
  const totalDays  = new Date(year, month, 0).getDate(); // days in that month
  const confirmDay = confirmDate.getDate();
  const daysWorkedAsPermanent = totalDays - confirmDay + 1;
  const fraction   = daysWorkedAsPermanent / totalDays;

  return {
    el: parseFloat((1.5 * fraction).toFixed(2)),
    sl: parseFloat((0.5 * fraction).toFixed(2)),
    cl: parseFloat((0.5 * fraction).toFixed(2)),
  };
}

// ── Helper: get leave type IDs ────────────────────────────────────────────────
async function getLeaveTypeIds(client) {
  const res = await client.query(`SELECT id, code FROM leave_types WHERE code IN ('EL','SL','CL','PL')`);
  const map = {};
  res.rows.forEach(r => { map[r.code] = r.id; });
  return map;
}

// ── GET /provision — list all provision employees + their confirmation status ─
exports.listProvisionEmployees = async (req, res) => {
  try {
    const role   = req.user.role;
    const userId = req.user.id;

    let whereExtra = '';
    const params = [];

    // Manager / TL only sees their direct reports
    if (role === 'manager' || role === 'tl') {
      whereExtra = `AND e.reporting_manager_id = $1`;
      params.push(userId);
    }

    const result = await db.query(
      `SELECT
         e.id, e.employee_code, e.first_name, e.last_name, e.email,
         e.joining_date, e.provision_end_date, e.confirmed_date,
         e.employee_category, e.department_id, e.designation_id,
         e.reporting_manager_id,
         d.name  AS department_name,
         des.title AS designation_title,
         CONCAT(m.first_name,' ',m.last_name) AS manager_name,
         -- Confirmation workflow status
         pc.id                    AS confirmation_id,
         pc.overall_status,
         pc.manager_status,
         pc.hr_status,
         pc.manager_approved_at,
         pc.hr_approved_at,
         pc.initiated_at,
         -- Days remaining / overdue
         e.provision_end_date - CURRENT_DATE AS days_remaining
       FROM employees e
       LEFT JOIN departments d    ON e.department_id  = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       LEFT JOIN employees m      ON e.reporting_manager_id = m.id
       LEFT JOIN provision_confirmations pc ON pc.employee_id = e.id
       WHERE e.is_active = TRUE
         AND e.employee_category = 'provision'
         ${whereExtra}
       ORDER BY e.provision_end_date ASC NULLS LAST`,
      params
    );

    res.json({ success: true, data: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('[listProvisionEmployees]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── POST /provision/:id/initiate — HR initiates confirmation workflow ─────────
// Creates a provision_confirmations record and notifies manager
exports.initiateConfirmation = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const empId  = parseInt(req.params.id);
    const initBy = req.user.id;
    const { notes } = req.body;

    // Get employee details
    const empRes = await client.query(
      `SELECT e.id, e.employee_code, e.first_name, e.last_name,
              e.employee_category, e.provision_end_date, e.reporting_manager_id,
              m.employee_code AS manager_code, m.first_name AS mgr_first, m.last_name AS mgr_last
       FROM employees e
       LEFT JOIN employees m ON e.reporting_manager_id = m.id
       WHERE e.id = $1 AND e.is_active = TRUE`,
      [empId]
    );

    if (!empRes.rows.length)
      return res.status(404).json({ success: false, message: 'Employee not found' });

    const emp = empRes.rows[0];

    if (emp.employee_category !== 'provision')
      return res.status(400).json({ success: false, message: 'Employee is not on provision period' });

    // Check if already initiated
    const existing = await client.query(
      `SELECT id, overall_status FROM provision_confirmations WHERE employee_id = $1`,
      [empId]
    );
    if (existing.rows.length)
      return res.status(400).json({
        success: false,
        message: `Confirmation already ${existing.rows[0].overall_status}. Cannot initiate again.`
      });

    // Create record
    const result = await client.query(
      `INSERT INTO provision_confirmations
         (employee_id, manager_id, overall_status, initiated_by, notes)
       VALUES ($1, $2, 'pending', $3, $4)
       RETURNING id`,
      [empId, emp.reporting_manager_id, initBy, notes || null]
    );

    // Create notification for manager
    await client.query(
      `INSERT INTO notifications (employee_id, type, title, message, is_read)
       VALUES ($1, 'provision_confirm', 'Provision Confirmation Request',
               $2, FALSE)`,
      [
        emp.reporting_manager_id,
        `Please review and approve the permanent confirmation for ${emp.first_name} ${emp.last_name} (${emp.employee_code}).`
      ]
    );

    await client.query('COMMIT');

    // ── Email 1: notify the EMPLOYEE that their confirmation has been initiated
    emailSvc.notifyProvisionInitiated(empId, emp.provision_end_date || null).catch(console.error);

    // ── Email 2: notify the MANAGER to review and approve
    emailSvc.notifyProvisionManagerApprovalNeeded(empId, emp).catch(console.error);

    res.status(201).json({
      success: true,
      message: `Confirmation workflow initiated for ${emp.first_name} ${emp.last_name}. Manager notified.`,
      data: { confirmation_id: result.rows[0].id }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[initiateConfirmation]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ── POST /provision/:id/approve — Manager or HR approves ─────────────────────
exports.approveConfirmation = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const empId  = parseInt(req.params.id);
    const actor  = req.user;
    const { action, remarks } = req.body; // action = 'approve' | 'reject'

    if (!['approve', 'reject'].includes(action))
      return res.status(400).json({ success: false, message: 'action must be approve or reject' });

    const pcRes = await client.query(
      `SELECT pc.*, e.first_name, e.last_name, e.employee_code,
              e.joining_date, e.provision_end_date, e.reporting_manager_id
       FROM provision_confirmations pc
       JOIN employees e ON pc.employee_id = e.id
       WHERE pc.employee_id = $1`,
      [empId]
    );

    if (!pcRes.rows.length)
      return res.status(404).json({ success: false, message: 'No confirmation workflow found. HR must initiate first.' });

    const pc = pcRes.rows[0];

    if (['confirmed', 'rejected'].includes(pc.overall_status))
      return res.status(400).json({ success: false, message: `Confirmation already ${pc.overall_status}` });

    // ── MANAGER approval (step 1) ─────────────────────────────────────────────
    // Handles: manager, tl, and admin/super_admin who is the actual reporting manager
    const isManagerRole = actor.role === 'manager' || actor.role === 'tl';
    const isAdminAsManager = (actor.role === 'admin' || actor.role === 'super_admin')
                              && actor.id === pc.reporting_manager_id
                              && pc.overall_status === 'pending';

    if (isManagerRole || isAdminAsManager) {
      if (actor.id !== pc.reporting_manager_id && actor.role !== 'admin' && actor.role !== 'super_admin')
        return res.status(403).json({ success: false, message: 'Only the reporting manager can approve at this step' });

      if (pc.manager_status !== 'pending')
        return res.status(400).json({ success: false, message: `Manager has already ${pc.manager_status} this request` });

      if (action === 'reject') {
        await client.query(
          `UPDATE provision_confirmations
           SET manager_id=$1, manager_status='rejected', manager_remarks=$2,
               manager_approved_at=NOW(), overall_status='rejected'
           WHERE employee_id=$3`,
          [actor.id, remarks || null, empId]
        );
        await client.query('COMMIT');
        return res.json({ success: true, message: 'Confirmation rejected by manager.' });
      }

      // Manager approved → update and notify HR
      await client.query(
        `UPDATE provision_confirmations
         SET manager_id=$1, manager_status='approved', manager_remarks=$2,
             manager_approved_at=NOW(), overall_status='manager_approved'
         WHERE employee_id=$3`,
        [actor.id, remarks || null, empId]
      );

      // Notify all HR employees
      const hrList = await client.query(
        `SELECT id FROM employees WHERE role='hr' AND is_active=TRUE`
      );
      for (const hr of hrList.rows) {
        await client.query(
          `INSERT INTO notifications (employee_id, type, title, message, is_read)
           VALUES ($1, 'provision_confirm', 'Manager Approved — Your HR Approval Needed',
                   $2, FALSE)`,
          [
            hr.id,
            `Manager has approved permanent confirmation for ${pc.first_name} ${pc.last_name} (${pc.employee_code}). Awaiting your approval.`
          ]
        );
      }

      await client.query('COMMIT');
      return res.json({ success: true, message: 'Manager approved. HR notified for final approval.' });
    }

    // ── HR approval (step 2) — ONLY hr role can approve this step ──────────────
    // admin/super_admin cannot bypass HR approval — they must go through HR.
    if (actor.role === 'hr') {
      if (pc.overall_status !== 'manager_approved')
        return res.status(400).json({
          success: false,
          message: pc.overall_status === 'pending'
            ? 'Manager approval is still pending'
            : `Workflow is ${pc.overall_status}`
        });

      if (action === 'reject') {
        await client.query(
          `UPDATE provision_confirmations
           SET hr_id=$1, hr_status='rejected', hr_remarks=$2,
               hr_approved_at=NOW(), overall_status='rejected'
           WHERE employee_id=$3`,
          [actor.id, remarks || null, empId]
        );
        await client.query('COMMIT');
        return res.json({ success: true, message: 'Confirmation rejected by HR.' });
      }

      // HR approved → AUTO-CONFIRM the employee!
      await client.query(
        `UPDATE provision_confirmations
         SET hr_id=$1, hr_status='approved', hr_remarks=$2,
             hr_approved_at=NOW(), overall_status='confirmed', confirmed_at=NOW()
         WHERE employee_id=$3`,
        [actor.id, remarks || null, empId]
      );

      // Convert employee: provision → permanent
      const confirmDate = new Date();
      await client.query(
        `UPDATE employees
         SET employee_category = 'permanent',
             confirmed_date    = $1,
             employment_type   = CASE WHEN employment_type ILIKE '%provision%' THEN 'Full-Time' ELSE employment_type END,
             updated_at        = NOW()
         WHERE id = $2`,
        [confirmDate.toISOString().split('T')[0], empId]
      );

      // ── STEP 1: Clear ALL old provision-era leave balances (PL + any EL/SL/CL accrued during provision) ──
      // We wipe the slate clean so the employee starts fresh as permanent
      await client.query(
        `DELETE FROM leave_balances WHERE employee_id = $1 AND year = $2`,
        [empId, confirmDate.getFullYear()]
      );

      // Also clear the accrual log so monthly-accrual doesn't skip this month
      await client.query(
        `DELETE FROM monthly_leave_accrual_log WHERE employee_id = $1 AND year = $2`,
        [empId, confirmDate.getFullYear()]
      );

      // ── STEP 2: Credit prorated EL/SL/CL for the month of confirmation ──────
      // Formula: (days remaining in month from confirm date) / (total days in month) × full monthly alloc
      // EL=1.5/month, SL=0.5/month, CL=0.5/month
      const ltIds   = await getLeaveTypeIds(client);
      const cy      = confirmDate.getFullYear();
      const cm      = confirmDate.getMonth() + 1;
      const prorata = proratedLeave(confirmDate, cy, cm);

      for (const [code, days] of [['EL', prorata.el], ['SL', prorata.sl], ['CL', prorata.cl]]) {
        if (!ltIds[code] || days <= 0) continue;
        await client.query(
          `INSERT INTO leave_balances(employee_id, leave_type_id, year, allocated, used, pending, carry_forward)
           VALUES($1,$2,$3,$4,0,0,0)
           ON CONFLICT(employee_id, leave_type_id, year)
           DO UPDATE SET allocated = leave_balances.allocated + EXCLUDED.allocated`,
          [empId, ltIds[code], cy, days]
        );
      }

      // Log the accrual
      await client.query(
        `INSERT INTO monthly_leave_accrual_log
           (employee_id, month, year, accrual_type, el_accrued, sl_accrued, cl_accrued, accrued_by, notes)
         VALUES ($1,$2,$3,'prorated',$4,$5,$6,$7,$8)
         ON CONFLICT(employee_id, month, year) DO UPDATE
           SET el_accrued = EXCLUDED.el_accrued,
               sl_accrued = EXCLUDED.sl_accrued,
               cl_accrued = EXCLUDED.cl_accrued,
               notes      = EXCLUDED.notes`,
        [empId, cm, cy, prorata.el, prorata.sl, prorata.cl, actor.id,
         `Prorated on confirmation day ${confirmDate.toISOString().split('T')[0]}`]
      );

      // Notify the employee
      await client.query(
        `INSERT INTO notifications (employee_id, type, title, message, is_read)
         VALUES ($1, 'provision_confirm', '🎉 Congratulations! You are now a Permanent Employee',
                 $2, FALSE)`,
        [
          empId,
          `Your provision period is complete. You have been confirmed as a permanent employee from ${confirmDate.toLocaleDateString(CONFIG.currencyLocale || 'en-IN')}. EL: ${prorata.el}, SL: ${prorata.sl}, CL: ${prorata.cl} credited for this month.`
        ]
      );

      await client.query('COMMIT');
      return res.json({
        success: true,
        message: `${pc.first_name} ${pc.last_name} has been confirmed as permanent employee. Prorated leaves credited: EL ${prorata.el}, SL ${prorata.sl}, CL ${prorata.cl}`,
        data: { confirmed_date: confirmDate, prorated_leaves: prorata }
      });
    }

    return res.status(403).json({ success: false, message: 'You are not authorized to approve confirmations' });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[approveConfirmation]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ── GET /provision/:id/status — get confirmation workflow status ──────────────
exports.getConfirmationStatus = async (req, res) => {
  try {
    const empId = parseInt(req.params.id);
    const result = await db.query(
      `SELECT
         pc.*,
         e.first_name, e.last_name, e.employee_code,
         e.joining_date, e.provision_end_date, e.confirmed_date, e.employee_category,
         CONCAT(m.first_name,' ',m.last_name) AS manager_name,
         CONCAT(hr.first_name,' ',hr.last_name) AS hr_name
       FROM provision_confirmations pc
       JOIN employees e ON pc.employee_id = e.id
       LEFT JOIN employees m  ON pc.manager_id = m.id
       LEFT JOIN employees hr ON pc.hr_id      = hr.id
       WHERE pc.employee_id = $1`,
      [empId]
    );
    if (!result.rows.length)
      return res.status(404).json({ success: false, message: 'No confirmation workflow found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[getConfirmationStatus]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── POST /provision/monthly-accrual — run monthly leave accrual ───────────────
// Run on 1st of every month (or manually by HR)
// Provision employees get 1 PL/month (up to 6 months)
// Permanent employees get EL 1.5 / SL 0.5 / CL 0.5 per month
exports.runMonthlyAccrual = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { month, year } = req.body;
    if (!month || !year)
      return res.status(400).json({ success: false, message: 'month and year required' });

    const mon = parseInt(month);
    const yr  = parseInt(year);

    const ltIds = await getLeaveTypeIds(client);
    let accrued = 0, skipped = 0;

    // Fetch all active employees
    const emps = await client.query(
      `SELECT id, employee_code, employee_category, joining_date, provision_end_date, confirmed_date
       FROM employees WHERE is_active = TRUE`
    );

    for (const emp of emps.rows) {
      // Skip if already accrued this month
      const already = await client.query(
        `SELECT id FROM monthly_leave_accrual_log WHERE employee_id=$1 AND month=$2 AND year=$3`,
        [emp.id, mon, yr]
      );
      if (already.rows.length) { skipped++; continue; }

      const category     = emp.employee_category || 'permanent';
      const joiningDate  = new Date(emp.joining_date);
      const monthStart   = new Date(yr, mon - 1, 1);
      const monthEnd     = new Date(yr, mon, 0);

      // Employee must have joined before or during this month
      if (joiningDate > monthEnd) { skipped++; continue; }

      let el = 0, sl = 0, cl = 0, pl = 0;
      let accrualType = 'standard';

      if (category === 'provision') {
        // Check if provision period is still active for this month
        const provEnd = emp.provision_end_date ? new Date(emp.provision_end_date) : null;
        if (!provEnd || monthStart > provEnd) {
          // Provision already ended — skip (they should already be permanent)
          skipped++;
          continue;
        }
        // Months completed since joining (1-based, max 6)
        const monthsElapsed =
          (yr - joiningDate.getFullYear()) * 12 + (mon - (joiningDate.getMonth() + 1));
        if (monthsElapsed >= 0 && monthsElapsed < 6) {
          pl = 1.0;
          accrualType = 'provision';
        }
      } else {
        // Permanent employee
        // Check if they were CONFIRMED mid-month (prorated already done at confirmation)
        if (emp.confirmed_date) {
          const confirmDate = new Date(emp.confirmed_date);
          const confirmMon  = confirmDate.getMonth() + 1;
          const confirmYr   = confirmDate.getFullYear();
          // If this is the confirmation month, prorated was already given — skip
          if (confirmYr === yr && confirmMon === mon) {
            skipped++;
            continue;
          }
        }
        el = 1.5;
        sl = 0.5;
        cl = 0.5;
      }

      // Credit leave balances
      for (const [code, days] of [['EL', el], ['SL', sl], ['CL', cl], ['PL', pl]]) {
        if (!ltIds[code] || days <= 0) continue;
        await client.query(
          `INSERT INTO leave_balances(employee_id, leave_type_id, year, allocated, used, pending, carry_forward)
           VALUES($1,$2,$3,$4,0,0,0)
           ON CONFLICT(employee_id, leave_type_id, year)
           DO UPDATE SET allocated = leave_balances.allocated + EXCLUDED.allocated`,
          [emp.id, ltIds[code], yr, days]
        );
      }

      // Log it
      await client.query(
        `INSERT INTO monthly_leave_accrual_log
           (employee_id, month, year, accrual_type, el_accrued, sl_accrued, cl_accrued, pl_accrued, accrued_by, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(employee_id, month, year) DO NOTHING`,
        [emp.id, mon, yr, accrualType, el, sl, cl, pl, req.user.id,
         `Monthly accrual run by ${req.user.employee_code}`]
      );

      accrued++;
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      message: `Monthly accrual complete for ${month}/${year}: ${accrued} employees accrued, ${skipped} skipped.`,
      data: { accrued, skipped }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[runMonthlyAccrual]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ── GET /provision/accrual-log — view accrual history ────────────────────────
exports.getAccrualLog = async (req, res) => {
  try {
    const { employee_id, month, year } = req.query;
    const params = [];
    const conditions = [];
    let idx = 1;

    if (employee_id) { conditions.push(`mal.employee_id=$${idx++}`); params.push(employee_id); }
    if (month)       { conditions.push(`mal.month=$${idx++}`); params.push(month); }
    if (year)        { conditions.push(`mal.year=$${idx++}`); params.push(year); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await db.query(
      `SELECT mal.*,
              CONCAT(e.first_name,' ',e.last_name) AS employee_name,
              e.employee_code,
              CONCAT(a.first_name,' ',a.last_name) AS accrued_by_name
       FROM monthly_leave_accrual_log mal
       JOIN employees e ON mal.employee_id  = e.id
       LEFT JOIN employees a ON mal.accrued_by = a.id
       ${where}
       ORDER BY mal.year DESC, mal.month DESC, e.first_name`,
      params
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[getAccrualLog]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
