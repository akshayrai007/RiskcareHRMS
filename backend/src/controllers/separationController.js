const CONFIG = require('../Main_file');
// separationController.js — 4-level approval flow
// Flow: Employee submits → L1 Manager → L2 HR → L3 Accounts → L4 Admin → completed
// Notice periods: employee=30d, tl/manager=45d, admin/hr/accounts/super_admin=90d

const emailSvc = require('../config/emailService');
const db = require('../config/db');

// ── Helpers ──────────────────────────────────────────────────────────────────
function getNoticePeriod(role) {
  if (['super_admin','admin','hr','accounts'].includes(role)) return 90;
  if (['manager'].includes(role)) return 45;
  if (['tl'].includes(role)) return 30;   // TL = 30 days same as employee
  return 30;
}

function calcLWD(resignDate, noticeDays) {
  const d = new Date(resignDate);
  d.setDate(d.getDate() + noticeDays);
  return d.toISOString().split('T')[0];
}

async function notifyByRole(client, role, title, message) {
  try {
    const list = await client.query(
      `SELECT id FROM employees WHERE role=$1 AND is_active=TRUE`, [role]
    );
    for (const row of list.rows) {
      await client.query(
        `INSERT INTO notifications(employee_id, type, title, message, expires_at)
         VALUES($1,'separation',$2,$3,NOW() + INTERVAL '48 hours')`,
        [row.id, title, message]
      );
    }
  } catch (notifErr) {
    // Notification failure must never crash the approval transaction
    console.error('[notifyByRole] Failed to notify role:', role, notifErr.message);
  }
}

async function notifyEmployee(client, empId, title, message) {
  try {
    await client.query(
      `INSERT INTO notifications(employee_id, type, title, message, expires_at)
       VALUES($1,'separation',$2,$3,NOW() + INTERVAL '48 hours')`,
      [empId, title, message]
    );
  } catch (notifErr) {
    console.error('[notifyEmployee] Failed to notify emp:', empId, notifErr.message);
  }
}
// ── Email helpers — send to next approver in chain ───────────────────────────
async function emailRoleApprovers(role, subject, bodyHtml) {
  try {
    const list = await db.query(
      `SELECT email, first_name FROM employees WHERE role=$1 AND is_active=TRUE AND email IS NOT NULL`, [role]
    );
    for (const row of list.rows) {
      emailSvc.send({ to: row.email, toName: row.first_name, subject, html: bodyHtml }).catch(e =>
        console.error('[emailRoleApprovers] email failed for', row.email, e.message)
      );
    }
  } catch (e) {
    console.error('[emailRoleApprovers] query failed:', e.message);
  }
}

async function emailEmployee(empId, subject, bodyHtml) {
  try {
    const r = await db.query(`SELECT email, first_name FROM employees WHERE id=$1`, [empId]);
    const emp = r.rows[0];
    if (emp?.email) {
      emailSvc.send({ to: emp.email, toName: emp.first_name, subject, html: bodyHtml }).catch(e =>
        console.error('[emailEmployee] email failed for empId', empId, e.message)
      );
    }
  } catch (e) {
    console.error('[emailEmployee] query failed:', e.message);
  }
}



// Shared SELECT for all separation queries
const SEP_SELECT = `
  SELECT s.*,
    CONCAT(e.first_name,' ',e.last_name)   AS employee_name,
    e.employee_code, e.role AS employee_role,
    e.joining_date, e.phone, e.is_active,
    e.separation_date, e.separation_type, e.separation_reason AS separation_remark,
    d.name  AS department_name,
    des.title AS designation_title,
    CONCAT(i.first_name,' ',i.last_name)   AS initiated_by_name,
    CONCAT(ma.first_name,' ',ma.last_name)  AS manager_actioned_by_name,
    CONCAT(ha.first_name,' ',ha.last_name)  AS hr_actioned_by_name,
    CONCAT(aa.first_name,' ',aa.last_name)  AS accounts_actioned_by_name,
    CONCAT(ad.first_name,' ',ad.last_name)  AS admin_actioned_by_name
  FROM separations s
  JOIN employees e        ON s.employee_id = e.id  -- includes inactive (resigned) employees
  LEFT JOIN departments d    ON e.department_id = d.id
  LEFT JOIN designations des ON e.designation_id = des.id
  LEFT JOIN employees i   ON s.initiated_by         = i.id
  LEFT JOIN employees ma  ON s.manager_actioned_by  = ma.id
  LEFT JOIN employees ha  ON s.hr_actioned_by       = ha.id
  LEFT JOIN employees aa  ON s.accounts_actioned_by = aa.id
  LEFT JOIN employees ad  ON s.admin_actioned_by    = ad.id
`;

// ── 1. Employee submits own resignation ──────────────────────────────────────
exports.submitResignation = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const empId   = req.user.id;
    const empRole = req.user.role;
    const { reason, notice_date, suggested_lwd } = req.body;

    if (!reason || !reason.trim())
      return res.status(400).json({ success: false, message: 'Reason is required' });

    const existing = await client.query(
      `SELECT id, status FROM separations
       WHERE employee_id=$1 AND status NOT IN ('rejected','withdrawn','completed')`,
      [empId]
    );
    if (existing.rows.length)
      return res.status(400).json({
        success: false,
        message: `You already have an active separation request (status: ${existing.rows[0].status}). Withdraw it first.`
      });

    const resignDate = notice_date || new Date().toISOString().split('T')[0];
    const noticeDays = getNoticePeriod(empRole);
    const autoLwd    = calcLWD(resignDate, noticeDays);
    // Employee may suggest an earlier LWD — only accept if it's >= auto-calculated LWD
    let lwd = autoLwd;
    if (suggested_lwd && new Date(suggested_lwd) >= new Date(autoLwd)) {
      lwd = suggested_lwd;
    }

    const empInfo = await client.query(
      `SELECT e.first_name, e.last_name, e.employee_code, e.reporting_manager_id
       FROM employees e WHERE e.id=$1`, [empId]
    );
    const emp = empInfo.rows[0];
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const result = await client.query(
      `INSERT INTO separations
         (employee_id, type, reason, notice_date, last_working_date,
          notice_period_days, status, initiated_by, initiated_by_role,
          manager_id, original_lwd)
       VALUES($1,'resignation',$2,$3,$4,$5,'pending',$1,$6,$7,$4)
       RETURNING *`,
      [empId, reason.trim(), resignDate, lwd, noticeDays, empRole,
       emp.reporting_manager_id || null]
    );

    if (emp.reporting_manager_id) {
      await notifyEmployee(client, emp.reporting_manager_id,
        '🔔 Resignation Received — Action Required',
        `${emp.first_name} ${emp.last_name} (${emp.employee_code}) has submitted a resignation. LWD: ${lwd}. Please review and approve.`
      );
    }

    // ── Auto-cancel all pending/approved future leave requests immediately on resignation ──
    const cancelledLeaves = await client.query(
      `UPDATE leave_requests
       SET status = 'cancelled', remarks = 'Auto-cancelled: resignation submitted'
       WHERE employee_id = $1
         AND status IN ('pending', 'approved')
         AND from_date >= CURRENT_DATE
       RETURNING id, days_requested, leave_type_id, from_date`,
      [empId]
    );
    // Restore leave balances for any pending/approved leaves that were cancelled
    for (const lr of cancelledLeaves.rows) {
      const yr = new Date(lr.from_date).getFullYear();
      // Restore pending bucket (all cancelled leaves were pending or approved)
      await client.query(
        `UPDATE leave_balances
         SET pending = GREATEST(0, pending - $1),
             used    = GREATEST(0, used - $2)
         WHERE employee_id=$3 AND leave_type_id=$4 AND year=$5`,
        [lr.days_requested, lr.days_requested, empId, lr.leave_type_id, yr]
      );
    }
    if (cancelledLeaves.rows.length) {
      await notifyEmployee(client, empId,
        '📋 Leaves Lapsed',
        `${cancelledLeaves.rows.length} pending/approved leave request(s) have been cancelled due to your resignation.`
      );
    }

    await client.query('COMMIT');
    // Email the reporting manager
    if (emp.reporting_manager_id) {
      emailEmployee(emp.reporting_manager_id,
        '🔔 Resignation Received — Action Required',
        `<p>Hi,</p><p><b>${emp.first_name} ${emp.last_name} (${emp.employee_code})</b> has submitted a resignation.</p><p>Last Working Day: <b>${lwd}</b></p><p>Please login to HRMS to review and approve.</p>`
      );
    }
    res.status(201).json({
      success: true,
      message: `Resignation submitted. Your notice period is ${noticeDays} days. Last Working Day: ${lwd}`,
      data: { ...result.rows[0], notice_period_days: noticeDays, last_working_date: lwd }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally { client.release(); }
};

// ── 2. Employee withdraws resignation ────────────────────────────────────────
exports.withdraw = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id }  = req.params;
    const empId   = req.user.id;
    const empRole = req.user.role;

    const sep = await client.query(
      `SELECT s.*, e.first_name, e.last_name, e.employee_code
       FROM separations s JOIN employees e ON e.id=s.employee_id
       WHERE s.id=$1 FOR UPDATE`, [id]
    );
    if (!sep.rows.length)
      return res.status(404).json({ success: false, message: 'Separation not found' });

    const s = sep.rows[0];
    const isOwn     = s.employee_id === empId;
    const isHRAdmin = ['hr','admin','super_admin'].includes(empRole);
    if (!isOwn && !isHRAdmin)
      return res.status(403).json({ success: false, message: 'Not authorized' });

    if (!['pending','manager_approved'].includes(s.status))
      return res.status(400).json({
        success: false,
        message: `Cannot withdraw — status is ${s.status}. Contact HR.`
      });

    await client.query(
      `UPDATE separations
       SET status='withdrawn', withdrawn_by=$1, withdrawn_at=NOW(),
           withdrawal_reason=$2, updated_at=NOW()
       WHERE id=$3`,
      [empId, req.body.reason || 'Withdrawn by employee', id]
    );

    if (s.manager_id) {
      await notifyEmployee(client, s.manager_id,
        '↩️ Resignation Withdrawn',
        `${s.first_name} ${s.last_name} (${s.employee_code}) has withdrawn their resignation.`
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Resignation withdrawn successfully.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally { client.release(); }
};

// ── 3. L1: Manager approves/rejects ─────────────────────────────────────────
exports.managerAction = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { action, remarks, reduced_lwd } = req.body;

    if (!['approve','reject'].includes(action))
      return res.status(400).json({ success: false, message: 'action must be approve or reject' });

    const sep = await client.query(
      `SELECT s.*, e.first_name, e.last_name, e.employee_code
       FROM separations s JOIN employees e ON e.id=s.employee_id
       WHERE s.id=$1 FOR UPDATE`, [id]
    );
    if (!sep.rows.length)
      return res.status(404).json({ success: false, message: 'Separation not found' });

    const s = sep.rows[0];
    if (s.status !== 'pending')
      return res.status(400).json({ success: false, message: `Cannot action — status is "${s.status}". Expected: pending` });

    const isManager = s.manager_id === req.user.id;
    if (!isManager)
      return res.status(403).json({ success: false, message: 'Only the reporting manager can action this step' });

    if (action === 'reject') {
      if (!remarks) return res.status(400).json({ success: false, message: 'Remarks required when rejecting' });
      await client.query(
        `UPDATE separations SET status='rejected', manager_action='rejected',
             manager_actioned_by=$1, manager_actioned_at=NOW(), manager_remarks=$2, updated_at=NOW()
         WHERE id=$3`,
        [req.user.id, remarks, id]
      );
      await notifyEmployee(client, s.employee_id, '❌ Resignation Rejected by Manager',
        `Your resignation was rejected by your manager. Reason: ${remarks}`);
      await client.query('COMMIT');
      return res.json({ success: true, message: 'Resignation rejected by Manager.' });
    }

    let finalLWD = s.last_working_date;
    if (reduced_lwd) {
      const orig = new Date(s.original_lwd || s.last_working_date);
      const nw   = new Date(reduced_lwd);
      if (nw < orig && nw > new Date()) finalLWD = reduced_lwd;
    }

    await client.query(
      `UPDATE separations SET status='manager_approved', manager_action='approved',
           manager_actioned_by=$1, manager_actioned_at=NOW(), manager_remarks=$2,
           last_working_date=$3, updated_at=NOW()
       WHERE id=$4`,
      [req.user.id, remarks || null, finalLWD, id]
    );

    await notifyEmployee(client, s.employee_id, '✅ L1 Approved — Awaiting HR',
      `Your resignation approved by manager. LWD: ${finalLWD}. Now awaiting HR review.`);
    await notifyByRole(client, 'hr', '🔔 Resignation Needs HR Review — Action Required',
      `${s.first_name} ${s.last_name} (${s.employee_code}): resignation approved by manager. LWD: ${finalLWD}.`);

    await client.query('COMMIT');
    // Email all HR to take action
    emailRoleApprovers('hr',
      '🔔 Resignation Needs HR Review — Action Required',
      `<p>Hi,</p><p><b>${s.first_name} ${s.last_name} (${s.employee_code})</b> — resignation approved by Manager.</p><p>Last Working Day: <b>${finalLWD}</b></p><p>Please login to HRMS to review and approve (L2 HR step).</p>`
    );
    res.json({ success: true, message: `Approved by Manager. Forwarded to HR. LWD: ${finalLWD}` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally { client.release(); }
};

// ── 4. L2: HR approves/rejects ───────────────────────────────────────────────
exports.hrAction = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { action, remarks, final_lwd } = req.body;

    if (!['approve','reject'].includes(action))
      return res.status(400).json({ success: false, message: 'action must be approve or reject' });
    if (!['hr'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Only HR can action this step' });

    const sep = await client.query(
      `SELECT s.*, e.first_name, e.last_name, e.employee_code
       FROM separations s JOIN employees e ON e.id=s.employee_id
       WHERE s.id=$1 FOR UPDATE`, [id]
    );
    if (!sep.rows.length)
      return res.status(404).json({ success: false, message: 'Separation not found' });

    const s = sep.rows[0];
    if (s.status !== 'manager_approved')
      return res.status(400).json({ success: false, message: `Cannot action — status is "${s.status}". Expected: manager_approved` });

    if (action === 'reject') {
      if (!remarks) return res.status(400).json({ success: false, message: 'Remarks required when rejecting' });
      await client.query(
        `UPDATE separations SET status='rejected', hr_action='rejected',
             hr_actioned_by=$1, hr_actioned_at=NOW(), hr_remarks=$2, updated_at=NOW()
         WHERE id=$3`,
        [req.user.id, remarks, id]
      );
      await notifyEmployee(client, s.employee_id, '❌ Resignation Rejected by HR',
        `Your resignation was rejected by HR. Reason: ${remarks}`);
      await client.query('COMMIT');
      return res.json({ success: true, message: 'Resignation rejected by HR.' });
    }

    const approvedLWD = final_lwd || s.last_working_date;
    await client.query(
      `UPDATE separations SET status='hr_approved', hr_action='approved',
           hr_actioned_by=$1, hr_actioned_at=NOW(), hr_remarks=$2,
           last_working_date=$3, updated_at=NOW()
       WHERE id=$4`,
      [req.user.id, remarks || null, approvedLWD, id]
    );

    await notifyEmployee(client, s.employee_id, '✅ L2 Approved — Awaiting Accounts',
      `Your resignation approved by HR. LWD: ${approvedLWD}. Now awaiting Accounts review.`);
    await notifyByRole(client, 'accounts', '🔔 Resignation Needs Accounts Review — Action Required',
      `${s.first_name} ${s.last_name} (${s.employee_code}): resignation approved by HR. LWD: ${approvedLWD}.`);

    await client.query('COMMIT');
    // Email all Accounts to take action
    emailRoleApprovers('accounts',
      '🔔 Resignation Needs Accounts Review — Action Required',
      `<p>Hi,</p><p><b>${s.first_name} ${s.last_name} (${s.employee_code})</b> — resignation approved by HR.</p><p>Last Working Day: <b>${approvedLWD}</b></p><p>Please login to HRMS to review and approve (L3 Accounts step).</p>`
    );
    res.json({ success: true, message: `Approved by HR. Forwarded to Accounts. LWD: ${approvedLWD}` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally { client.release(); }
};

// ── 5. L3: Accounts approves/rejects ─────────────────────────────────────────
exports.accountsAction = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { action, remarks, final_lwd } = req.body;

    if (!['approve','reject'].includes(action))
      return res.status(400).json({ success: false, message: 'action must be approve or reject' });
    if (!['accounts'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Only Accounts can action this step' });

    const sep = await client.query(
      `SELECT s.*, e.first_name, e.last_name, e.employee_code
       FROM separations s JOIN employees e ON e.id=s.employee_id
       WHERE s.id=$1 FOR UPDATE`, [id]
    );
    if (!sep.rows.length)
      return res.status(404).json({ success: false, message: 'Separation not found' });

    const s = sep.rows[0];
    if (s.status !== 'hr_approved')
      return res.status(400).json({ success: false, message: `Cannot action — status is "${s.status}". Expected: hr_approved` });

    if (action === 'reject') {
      if (!remarks) return res.status(400).json({ success: false, message: 'Remarks required when rejecting' });
      await client.query(
        `UPDATE separations SET status='rejected', accounts_action='rejected',
             accounts_actioned_by=$1, accounts_actioned_at=NOW(), accounts_remarks=$2, updated_at=NOW()
         WHERE id=$3`,
        [req.user.id, remarks, id]
      );
      await notifyEmployee(client, s.employee_id, '❌ Resignation Rejected by Accounts',
        `Your resignation was rejected by Accounts. Reason: ${remarks}`);
      await client.query('COMMIT');
      return res.json({ success: true, message: 'Resignation rejected by Accounts.' });
    }

    const approvedLWD = final_lwd || s.last_working_date;
    await client.query(
      `UPDATE separations SET status='accounts_approved', accounts_action='approved',
           accounts_actioned_by=$1, accounts_actioned_at=NOW(), accounts_remarks=$2,
           last_working_date=$3, updated_at=NOW()
       WHERE id=$4`,
      [req.user.id, remarks || null, approvedLWD, id]
    );

    await notifyEmployee(client, s.employee_id, '✅ L3 Approved — Awaiting Admin',
      `Your resignation approved by Accounts. LWD: ${approvedLWD}. Now awaiting final Admin approval.`);
    await notifyByRole(client, 'admin', '🔔 Resignation Needs Final Admin Approval — Action Required',
      `${s.first_name} ${s.last_name} (${s.employee_code}): resignation approved by Accounts. LWD: ${approvedLWD}. Please give final approval.`);

    await client.query('COMMIT');
    // Email all Admins to take final action
    emailRoleApprovers('admin',
      '🔔 Resignation Needs Final Admin Approval — Action Required',
      `<p>Hi,</p><p><b>${s.first_name} ${s.last_name} (${s.employee_code})</b> — resignation approved by Accounts.</p><p>Last Working Day: <b>${approvedLWD}</b></p><p>Please login to HRMS to give final approval (L4 Admin step).</p>`
    );
    res.json({ success: true, message: `Approved by Accounts. Forwarded to Admin for final approval. LWD: ${approvedLWD}` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally { client.release(); }
};

// ── 6. L4: Admin final approval ──────────────────────────────────────────────
exports.adminAction = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { action, remarks, final_lwd } = req.body;

    if (!['approve','reject'].includes(action))
      return res.status(400).json({ success: false, message: 'action must be approve or reject' });
    if (!['admin','super_admin'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Only Admin can give final approval' });

    const sep = await client.query(
      `SELECT s.*, e.first_name, e.last_name, e.employee_code, e.role AS emp_role
       FROM separations s JOIN employees e ON e.id=s.employee_id
       WHERE s.id=$1 FOR UPDATE`, [id]
    );
    if (!sep.rows.length)
      return res.status(404).json({ success: false, message: 'Separation not found' });

    const s = sep.rows[0];
    if (s.status !== 'accounts_approved')
      return res.status(400).json({ success: false, message: `Cannot action — status is "${s.status}". Expected: accounts_approved` });

    if (action === 'reject') {
      if (!remarks) return res.status(400).json({ success: false, message: 'Remarks required when rejecting' });
      await client.query(
        `UPDATE separations SET status='rejected', admin_action='rejected',
             admin_actioned_by=$1, admin_actioned_at=NOW(), admin_remarks=$2, updated_at=NOW()
         WHERE id=$3`,
        [req.user.id, remarks, id]
      );
      await notifyEmployee(client, s.employee_id, '❌ Resignation Rejected by Admin',
        `Your resignation was rejected by Admin. Reason: ${remarks}`);
      await client.query('COMMIT');
      return res.json({ success: true, message: 'Resignation rejected by Admin.' });
    }

    const approvedLWD = final_lwd || s.last_working_date;
    await client.query(
      `UPDATE separations SET status='completed', admin_action='approved',
           admin_actioned_by=$1, admin_actioned_at=NOW(), admin_remarks=$2,
           last_working_date=$3, updated_at=NOW()
       WHERE id=$4`,
      [req.user.id, remarks || null, approvedLWD, id]
    );

    const today = new Date(); today.setHours(0,0,0,0);
    if (new Date(approvedLWD) <= today) {
      await client.query(
        `UPDATE employees SET is_active=false, separation_date=$1,
             separation_type=$2, separation_reason=$3,
             password_hash='DEACTIVATED_' || gen_random_uuid(), updated_at=NOW()
         WHERE id=$4`,
        [approvedLWD, s.type, s.reason, s.employee_id]
      );
      await notifyEmployee(client, s.employee_id, '🔒 Separation Complete — Account Deactivated',
        `Your separation is fully approved. Account deactivated as of ${approvedLWD}.`);
    } else {
      await notifyEmployee(client, s.employee_id, '✅ Resignation Fully Approved',
        `All 4 levels approved. Last Working Day: ${approvedLWD}. Account will deactivate after this date.`);
    }

    await client.query('COMMIT');
    // Email employee — fully approved
    emailEmployee(s.employee_id,
      '✅ Your Resignation Has Been Fully Approved',
      `<p>Dear ${s.first_name},</p><p>Your resignation has been approved by all 4 levels.</p><p>Your Last Working Day is: <b>${approvedLWD}</b></p><p>Please ensure all handover activities are completed before your last day. HR will reach out with further details.</p><p>We wish you all the best!</p>`
    );
    // Email all admins confirmation
    emailRoleApprovers('admin',
      '✅ Separation Fully Approved — ${s.first_name} ${s.last_name}',
      `<p>The resignation of <b>${s.first_name} ${s.last_name} (${s.employee_code})</b> has been fully approved.</p><p>Last Working Day: <b>${approvedLWD}</b></p>`
    );
    res.json({
      success: true,
      message: new Date(approvedLWD) <= today
        ? `Final approval given. Employee deactivated immediately.`
        : `Final approval given. Employee account will deactivate on ${approvedLWD}.`,
      data: { last_working_date: approvedLWD }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally { client.release(); }
};

// ── 7. HR/Admin initiates separation for an employee ─────────────────────────
exports.initiate = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { employee_id, type, reason, notice_date, last_working_date } = req.body;
    if (!employee_id || !type)
      return res.status(400).json({ success: false, message: 'employee_id and type are required' });

    const validTypes = ['resignation','termination','retirement','absconding','end_of_contract'];
    if (!validTypes.includes(type))
      return res.status(400).json({ success: false, message: `type must be one of: ${validTypes.join(', ')}` });

    const emp = await client.query(
      `SELECT id, first_name, last_name, employee_code, role, is_active, reporting_manager_id
       FROM employees WHERE id=$1`, [employee_id]
    );
    if (!emp.rows.length) return res.status(404).json({ success: false, message: 'Employee not found' });
    if (!emp.rows[0].is_active) return res.status(400).json({ success: false, message: 'Employee is already inactive' });

    const existing = await client.query(
      `SELECT id FROM separations WHERE employee_id=$1 AND status NOT IN ('rejected','withdrawn','completed')`,
      [employee_id]
    );
    if (existing.rows.length)
      return res.status(400).json({ success: false, message: 'An active separation already exists for this employee' });

    const e          = emp.rows[0];
    const resignDate = notice_date || new Date().toISOString().split('T')[0];
    const noticeDays = getNoticePeriod(e.role);
    const autoLWD    = last_working_date || calcLWD(resignDate, noticeDays);

    const result = await client.query(
      `INSERT INTO separations
         (employee_id, type, reason, notice_date, last_working_date,
          notice_period_days, status, initiated_by, initiated_by_role, manager_id, original_lwd)
       VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$5)
       RETURNING *`,
      [employee_id, type, reason||null, resignDate, autoLWD,
       noticeDays, req.user.id, req.user.role, e.reporting_manager_id||null]
    );

    await notifyEmployee(client, employee_id, '📋 Separation Initiated',
      `A ${type} has been initiated for you by HR/Admin. LWD: ${autoLWD}. Notice period: ${noticeDays} days.`);

    await client.query('COMMIT');
    res.status(201).json({
      success: true, message: 'Separation initiated',
      data: { ...result.rows[0], notice_period_days: noticeDays, last_working_date: autoLWD }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally { client.release(); }
};

// ── 8. Employee views own separations ────────────────────────────────────────
exports.getMySeparations = async (req, res) => {
  try {
    const result = await db.query(SEP_SELECT + ` WHERE s.employee_id=$1 ORDER BY s.created_at DESC`, [req.user.id]);
    res.json({ success: true, data: result.rows, total: result.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
};

// ── 9. Get single separation by ID ───────────────────────────────────────────
exports.getOne = async (req, res) => {
  try {
    const result = await db.query(SEP_SELECT + ` WHERE s.id=$1`, [req.params.id]);
    if (!result.rows.length)
      return res.status(404).json({ success: false, message: 'Separation not found' });

    const sep  = result.rows[0];
    const isOwn     = sep.employee_id === req.user.id;
    const isManager = sep.manager_id  === req.user.id;
    const isHRAdmin = ['hr','admin','super_admin','accounts'].includes(req.user.role);
    if (!isOwn && !isManager && !isHRAdmin)
      return res.status(403).json({ success: false, message: 'Not authorized' });

    res.json({ success: true, data: sep });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
};

// ── 10. Get all separations (HR/Admin only) ───────────────────────────────────
exports.getAll = async (req, res) => {
  try {
    const { status, employee_id, include_inactive, search } = req.query;
    let conds = [], params = [], idx = 1;
    if (status)      { conds.push(`s.status=$${idx++}`);      params.push(status); }
    if (employee_id) { conds.push(`s.employee_id=$${idx++}`); params.push(employee_id); }
    // Search by name or employee code
    if (search) {
      conds.push(`(LOWER(CONCAT(e.first_name,' ',e.last_name)) LIKE $${idx} OR LOWER(e.employee_code) LIKE $${idx})`);
      params.push(`%${search.toLowerCase()}%`);
      idx++;
    }
    // By default only active; HR/admin can pass include_inactive=true to see resigned employees
    if (!include_inactive || include_inactive === 'false') {
      conds.push(`e.is_active = true`);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const result = await db.query(
      SEP_SELECT + ` ${where} ORDER BY s.created_at DESC`,
      params
    );
    // Attach deactivation info for inactive employees
    const data = result.rows.map(r => ({
      ...r,
      is_active:           r.is_active ?? true,
      separation_date:     r.separation_date     || null,
      separation_type:     r.separation_type     || null,
      separation_reason:   r.separation_reason   || null,
      hr_remarks:          r.hr_remarks          || null,
      manager_remarks:     r.manager_remarks     || null,
      accounts_remarks:    r.accounts_remarks    || null,
      admin_remarks:       r.admin_remarks       || null,
    }));
    res.json({ success: true, data, total: data.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
};

// ── 11. Get notice period ─────────────────────────────────────────────────────
exports.getNoticePeriod = async (req, res) => {
  const days  = getNoticePeriod(req.user.role);
  const today = new Date().toISOString().split('T')[0];
  res.json({
    success: true,
    data: { role: req.user.role, notice_period_days: days,
            if_resigned_today: { notice_date: today, last_working_date: calcLWD(today, days) } }
  });
};

// ── 12. Cron — auto-deactivate on LWD ────────────────────────────────────────
exports.processLWD = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const due = await db.query(
      `SELECT s.id, s.employee_id, s.type, s.reason, s.last_working_date,
              e.first_name, e.last_name, e.employee_code
       FROM separations s JOIN employees e ON e.id=s.employee_id
       WHERE s.status='completed' AND s.last_working_date <= $1 AND e.is_active=true`, [today]
    );
    let deactivated = [];
    for (const row of due.rows) {
      await db.query(
        `UPDATE employees SET is_active=false, separation_date=$1,
             separation_type=$2, separation_reason=$3,
             password_hash='DEACTIVATED_' || gen_random_uuid(), updated_at=NOW() WHERE id=$4`,
        [row.last_working_date, row.type, row.reason, row.employee_id]
      );
      await db.query(
        `INSERT INTO notifications(employee_id, type, title, message, expires_at)
         VALUES($1,'separation','🔒 Account Deactivated',$2,NOW() + INTERVAL '48 hours')`,
        [row.employee_id, `Your last working day (${row.last_working_date}) has passed. Account has been deactivated.`]
      );
      deactivated.push(`${row.employee_code} — ${row.first_name} ${row.last_name}`);
    }
    const msg = deactivated.length
      ? `Deactivated ${deactivated.length} employee(s): ${deactivated.join(', ')}`
      : 'No employees due for deactivation today';
    if (res) res.json({ success: true, message: msg, count: deactivated.length });
    else console.log('[LWD Cron]', msg);
  } catch (err) {
    console.error('[LWD Cron] Error:', err);
    if (res) res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
};
