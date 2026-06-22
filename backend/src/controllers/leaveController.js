const CONFIG = require('../Main_file');
// src/controllers/leaveController.js — COMPLETE with approval chain
const db      = require('../config/db');
const { getEmployeeRegion } = require('../config/regionHelper');
const emailSvc = require('../config/emailService');

// ── Timezone-safe date helper ─────────────────────────────────────────────────
// Avoids UTC shift bug (toISOString rolls back 1 day for IST +5:30)
function toLocalDateString(d) {
  const year  = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day   = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ── Approval chain helper ─────────────────────────────────────────────────────
// Leave: Employee → Reporting Manager (single-level approval).
// The reporting_manager_id is the single source of truth for who approves.
// Anyone with subordinates (manager, TL) is set as reporting_manager_id for
// their team — so their approval queue fills automatically.
// Returns ordered array of approver employee_codes.
async function getLeaveApprovalChain(employeeId) {
  const emp = await db.query(
    `SELECT e.employee_code, e.reporting_manager_id,
            m.employee_code AS manager_code, m.role AS manager_role
     FROM employees e
     LEFT JOIN employees m ON e.reporting_manager_id = m.id
     WHERE e.id=$1`, [employeeId]
  );
  if (!emp.rows.length) return [];
  const { employee_code, manager_code, manager_role } = emp.rows[0];

  const MD_CODE = CONFIG.mdEmployeeCode;

  // MD / super_admin applies → no approver needed (auto-approved)
  if (employee_code === MD_CODE) return [];

  // KC718 (COO) → MD (KC01) is their approver
  if (manager_role === 'super_admin') return [manager_code];

  // Everyone else → their direct reporting manager
  if (manager_code) return [manager_code];

  return [];
}

// ── Apply for Leave ───────────────────────────────────────────────────────────
exports.apply = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const empId = req.user.id;
    const { leave_type_id, from_date, to_date, reason, is_half_day } = req.body;

    if (!leave_type_id || !from_date || !to_date)
      return res.status(400).json({ success: false, message: 'leave_type_id, from_date, to_date required' });

    // Block leave application if employee has submitted/active separation
    const sepCheck = await client.query(
      `SELECT id FROM separations WHERE employee_id=$1 AND status NOT IN ('rejected','withdrawn')`,
      [empId]
    );
    if (sepCheck.rows.length)
      return res.status(403).json({ success: false, message: 'You have an active resignation. Leave requests are not allowed.' });

    // Calculate days — skip Sundays, 2nd & 4th Saturdays, and regional holidays
    const from = new Date(from_date);
    const to   = new Date(to_date);
    if (from > to) return res.status(400).json({ success: false, message: 'from_date must be before to_date' });

    // Helper: is this date a 2nd or 4th Saturday of its month?
    function is2ndOr4thSaturday(d) {
      if (d.getDay() !== 6) return false; // not Saturday
      const satCount = Math.ceil(d.getDate() / 7);
      return satCount === 2 || satCount === 4;
    }

    // Get employee's region based on city/state
    const empInfo = await client.query(
      `SELECT city, state FROM employees WHERE id=$1`, [empId]
    );
    const empRegion = getEmployeeRegion(empInfo.rows[0]?.city, empInfo.rows[0]?.state);

    let days = 0;
    const holidays = await client.query(
      `SELECT date FROM holidays WHERE date BETWEEN $1 AND $2 AND (region='all' OR region=$3)`,
      [from_date, to_date, empRegion]
    );
    const holidayDates = new Set(holidays.rows.map(h => toLocalDateString(new Date(h.date))));
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const dow = d.getDay();
      const ds  = toLocalDateString(d);
      if (dow === 0) continue;                    // Sunday off
      if (is2ndOr4thSaturday(d)) continue;        // 2nd & 4th Saturday off
      if (holidayDates.has(ds)) continue;          // public holiday
      days++;
    }
    if (is_half_day) days = 0.5;
    if (days <= 0) return res.status(400).json({ success: false, message: 'No working days in selected range' });

    // Check leave balance (skip for OD/LWP)
    const lt = await client.query('SELECT code FROM leave_types WHERE id=$1', [leave_type_id]);
    if (!lt.rows.length) return res.status(400).json({ success: false, message: 'Invalid leave type' });
    const ltCode = lt.rows[0].code;

    // Block contractual employees under 6 months from applying EL/CL/SL
    // They are on provision and can only use PL
    const empCatRes = await client.query(
      `SELECT employee_category, joining_date FROM employees WHERE id=$1`, [empId]
    );
    const empCat = empCatRes.rows[0];
    if (empCat?.employee_category === 'contractual') {
      const joiningDate = new Date(empCat.joining_date);
      const sixMonthMark = new Date(joiningDate);
      sixMonthMark.setMonth(sixMonthMark.getMonth() + 6);
      const now = new Date();
      if (now < sixMonthMark && ['EL', 'CL', 'SL'].includes(ltCode)) {
        return res.status(400).json({
          success: false,
          message: `Contractual employees on provisional period (under 6 months) can only apply for PL. EL/CL/SL will be available after ${sixMonthMark.toDateString()}.`
        });
      }
    }

    if (!['OD','LWP'].includes(ltCode)) {
      const year = from.getFullYear();
      const bal = await client.query(
        `SELECT GREATEST(0, allocated + carry_forward - used - pending) AS available
         FROM leave_balances WHERE employee_id=$1 AND leave_type_id=$2 AND year=$3`,
        [empId, leave_type_id, year]
      );
      if (!bal.rows.length || parseFloat(bal.rows[0].available) < days - 0.001)
        return res.status(400).json({ success: false, message: `Insufficient ${ltCode} balance. Available: ${bal.rows[0]?.available || 0}` });

      // Reserve pending
      await client.query(
        `UPDATE leave_balances SET pending = pending + $1
         WHERE employee_id=$2 AND leave_type_id=$3 AND year=$4`,
        [days, empId, leave_type_id, year]
      );
    }

    // Build approval chain
    const chain = await getLeaveApprovalChain(empId);

    const result = await client.query(
      `INSERT INTO leave_requests
         (employee_id, leave_type_id, from_date, to_date, days_requested,
          reason, is_half_day, approval_chain, current_approver_code, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
       RETURNING id`,
      [empId, leave_type_id, from_date, to_date, days, reason || null,
       is_half_day || false, JSON.stringify(chain), chain[0] || null]
    );

    await client.query('COMMIT');
    const leaveId = result.rows[0].id;

    // Send email notification (async)
    emailSvc.notifyLeaveApplied(leaveId).catch(console.error);

    // ── In-app notification to first approver in chain ────────────────────
    if (chain.length > 0) {
      try {
        const fmtD = d => new Date(d).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'});
        const empInfo = await db.query(
          `SELECT CONCAT(first_name,' ',last_name) AS full_name FROM employees WHERE id=$1`, [empId]
        );
        const fullName = empInfo.rows[0]?.full_name || 'An employee';
        const rangeLabel = from_date === to_date ? fmtD(from_date) : `${fmtD(from_date)} → ${fmtD(to_date)}`;
        const notifMsg = `${fullName} requested ${days} day(s) leave (${rangeLabel}). Reason: ${reason || 'N/A'}`;
        // Notify all approvers in chain
        for (const approverCode of chain) {
          const approverRow = await db.query(
            `SELECT id FROM employees WHERE employee_code=$1 AND is_active=true`, [approverCode]
          );
          for (const r of approverRow.rows) {
            await db.query(
              `INSERT INTO notifications(employee_id, title, message, type) VALUES($1,'📋 Leave Request',$2,'leave')`,
              [r.id, notifMsg]
            );
          }
        }
        // HR is NOT notified when leave is applied — only reporting manager is notified
        // HR will be notified only after leave is approved (FYI notification)
      } catch (notifErr) {
        console.error('Leave notification error:', notifErr.message);
      }
    }

    const fmtDate = d => new Date(d).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'});
    res.status(201).json({
      success: true,
      message: `Leave applied successfully for ${days} day(s) (${fmtDate(from_date)} → ${fmtDate(to_date)}). Pending approval from ${chain[0]}.`,
      data: { id: leaveId, days_requested: days, approval_chain: chain }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ── Approve / Reject Leave ────────────────────────────────────────────────────
exports.action = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { action, remarks } = req.body; // action = 'approve' | 'reject'
    const actorCode = req.user.employee_code;
    const actorRole = req.user.role;

    if (!['approve','reject'].includes(action))
      return res.status(400).json({ success: false, message: 'action must be approve or reject' });

    const lr = await client.query(
      `SELECT lr.*, lt.code AS lt_code
       FROM leave_requests lr
       JOIN leave_types lt ON lr.leave_type_id = lt.id
       WHERE lr.id=$1 FOR UPDATE`, [id]
    );
    if (!lr.rows.length)
      return res.status(404).json({ success: false, message: 'Leave request not found' });

    const leave = lr.rows[0];
    if (leave.status !== 'pending')
      return res.status(400).json({ success: false, message: `Leave is already ${leave.status}` });

    const rawChain = leave.approval_chain || [];
    let chain;
    if (Array.isArray(rawChain)) {
      chain = rawChain;
    } else if (typeof rawChain === 'string') {
      try { chain = JSON.parse(rawChain); } catch (_) { chain = rawChain.split(',').map(s => s.trim()).filter(Boolean); }
    } else { chain = []; }
    const currentCode  = leave.current_approver_code;

    // Verify actor is allowed to act
    const isSuperAdmin      = actorRole === 'super_admin';
    const isAdmin           = actorRole === 'admin';
    const isCurrentApprover = actorCode === currentCode;

    // super_admin (KC01/MD) may only action leave for KC718 (COO)
    if (isSuperAdmin) {
      const empCheck = await client.query(
        `SELECT employee_code FROM employees WHERE id = $1`, [leave.employee_id]
      );
      if (empCheck.rows[0]?.employee_code !== CONFIG.cooEmployeeCode) {
        return res.status(403).json({
          success: false,
          message: 'MD can only approve or reject leave for the COO (KC718). All other leave is managed by the reporting manager.'
        });
      }
    }

    // Block self-approval — NO role can approve their own leave, not even admin
    if (leave.employee_id === req.user.id)
      return res.status(403).json({ success: false, message: 'You cannot approve your own leave request' });

    // Check if actor is the employee's reporting manager or team leader
    // (covers org changes after leave was applied, and HR who doubles as reporting manager)
    let isTeamManager = false;
    if (!isAdmin && !isCurrentApprover) {
      const teamCheck = await client.query(
        `SELECT 1 FROM employees
         WHERE id=$1 AND (reporting_manager_id=$2 OR team_leader_id=$2)`,
        [leave.employee_id, req.user.id]
      );
      isTeamManager = teamCheck.rows.length > 0;
    }

    // HR is allowed ONLY if they are the current approver or the employee's reporting manager.
    // Otherwise HR is notified only and cannot approve/reject.
    if (actorRole === 'hr' && !isCurrentApprover && !isTeamManager)
      return res.status(403).json({
        success: false,
        message: 'HR can approve leave only if they are the reporting manager for this employee.'
      });

    if (!isAdmin && !isCurrentApprover && !isTeamManager)
      return res.status(403).json({ success: false, message: 'You are not the current approver for this leave' });

    // ── REJECT ────────────────────────────────────────────────
    if (action === 'reject') {
      await client.query(
        `UPDATE leave_requests SET status='rejected', remarks=$1, actioned_by=$2, actioned_at=NOW()
         WHERE id=$3`, [remarks, req.user.id, id]
      );
      // Release pending balance
      if (!['OD','LWP'].includes(leave.lt_code)) {
        const year = new Date(leave.from_date).getFullYear();
        await client.query(
          `UPDATE leave_balances SET pending = GREATEST(0, pending - $1)
           WHERE employee_id=$2 AND leave_type_id=$3 AND year=$4`,
          [leave.days_requested, leave.employee_id, leave.leave_type_id, year]
        );
      }
      // ── In-app notification to employee ──────────────────────────────────
      const rejectorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim();
      const leaveFrom = new Date(leave.from_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      const leaveTo   = new Date(leave.to_date).toLocaleDateString('en-IN',   { day: '2-digit', month: 'short', year: 'numeric' });
      await client.query(
        `INSERT INTO notifications(employee_id, type, title, message, is_read, expires_at)
         VALUES($1,'leave','❌ Leave Request Rejected',$2,FALSE,NOW() + INTERVAL '48 hours')`,
        [
          leave.employee_id,
          `Your ${leave.lt_code || 'leave'} request from ${leaveFrom} to ${leaveTo} has been rejected by ${rejectorName}.${remarks ? ' Reason: ' + remarks : ''}`
        ]
      );

      await client.query('COMMIT');
      emailSvc.notifyLeaveRejected(id, req.user.id, remarks).catch(console.error);
      return res.json({ success: true, message: 'Leave rejected' });
    }

    // ── APPROVE ───────────────────────────────────────────────
    const currentIdx  = chain.indexOf(currentCode);
    const nextCode    = chain[currentIdx + 1] || null;

    if (nextCode) {
      // More approvers — advance to next
      await client.query(
        `UPDATE leave_requests SET current_approver_code=$1 WHERE id=$2`,
        [nextCode, id]
      );
      await client.query('COMMIT');
      emailSvc.notifyLeaveApprovedByManager(id).catch(console.error);
      return res.json({ success: true, message: `Approved. Forwarded to next approver.` });
    }

    // Final approver — fully approve
    await client.query(
      `UPDATE leave_requests
       SET status='approved', remarks=$1, actioned_by=$2, actioned_at=NOW(), current_approver_code=NULL
       WHERE id=$3`, [remarks, req.user.id, id]
    );

    // Deduct from balance
    const year = new Date(leave.from_date).getFullYear();
    if (!['OD','LWP'].includes(leave.lt_code)) {
      await client.query(
        `UPDATE leave_balances
         SET used = used + $1, pending = GREATEST(0, pending - $1)
         WHERE employee_id=$2 AND leave_type_id=$3 AND year=$4`,
        [leave.days_requested, leave.employee_id, leave.leave_type_id, year]
      );
    }

    // Mark attendance for each working day of the approved leave
    // Half-day leaves get their specific status (h-el, h-cl, h-sl, h-lwp)
    // so salary calculation correctly counts them as 0.5 present (or 0.5 LOP for h-lwp)
    // Full-day leaves (including LWP) get 'on-leave' or 'lwp'
    const from = new Date(leave.from_date);
    const to   = new Date(leave.to_date);

    // Determine the correct attendance status to write
    let attendanceStatus;
    if (leave.is_half_day) {
      // Map leave type code → half-day attendance status
      const halfDayStatusMap = {
        'EL':  'h-el',
        'CL':  'h-cl',
        'SL':  'h-sl',
        'PL':  'h-el',   // Privilege Leave treated like EL for attendance
        'LWP': 'h-lwp',
        'OD':  'h-wfh',  // OD half-day treated as h-wfh
      };
      attendanceStatus = halfDayStatusMap[leave.lt_code] || 'half-day';
    } else {
      attendanceStatus = leave.lt_code === 'LWP' ? 'lwp' : 'on-leave';
    }

    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const dow = d.getDay();
      if (dow === 0) continue; // Sunday off
      // 2nd & 4th Saturday off
      if (dow === 6 && [2,4].includes(Math.ceil(d.getDate() / 7))) continue;
      const ds = toLocalDateString(d);
      await client.query(
        `INSERT INTO attendance(employee_id, date, status)
         VALUES($1, $2, $3)
         ON CONFLICT(employee_id, date) DO UPDATE SET status=$3`,
        [leave.employee_id, ds, attendanceStatus]
      );
    }

    await client.query('COMMIT');
    emailSvc.notifyLeaveFullyApproved(id).catch(console.error);

    // Notify HR as FYI ONLY after leave is approved — HR cannot approve leaves
    // HR only gets this if they are NOT the reporting manager (to avoid duplicate notification)
    const hrList = await db.query(
      `SELECT id FROM employees WHERE role='hr' AND is_active=TRUE AND id != $1`,
      [req.user.id]
    );
    const empName = await db.query(
      `SELECT first_name, last_name, employee_code FROM employees WHERE id=$1`,
      [leave.employee_id]
    );
    const emp = empName.rows[0];
    for (const hr of hrList.rows) {
      await db.query(
        `INSERT INTO notifications(employee_id, type, title, message, is_read, expires_at)
         VALUES($1,'leave_approved','✅ Leave Approved — FYI',$2,FALSE,NOW() + INTERVAL '48 hours')`,
        [hr.id,
         `${emp.first_name} ${emp.last_name} (${emp.employee_code})'s leave has been approved by manager for ${leave.days_requested} day(s) from ${leave.from_date} to ${leave.to_date}.`
        ]
      );
    }

    // ── In-app notification to employee (approved) ─────────────────────────
    const approverName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim();
    const appFrom = new Date(leave.from_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const appTo   = new Date(leave.to_date).toLocaleDateString('en-IN',   { day: '2-digit', month: 'short', year: 'numeric' });
    await db.query(
      `INSERT INTO notifications(employee_id, type, title, message, is_read, expires_at)
       VALUES($1,'leave','✅ Leave Request Approved',$2,FALSE,NOW() + INTERVAL '48 hours')`,
      [
        leave.employee_id,
        `Your ${leave.lt_code || 'leave'} request from ${appFrom} to ${appTo} has been approved by ${approverName}.`
      ]
    );

    res.json({ success: true, message: 'Leave approved successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ── Get Leave Requests ────────────────────────────────────────────────────────
exports.getRequests = async (req, res) => {
  try {
    const { status, employee_id, from_date, to_date } = req.query;
    const userId   = req.user.id;
    const userRole = req.user.role;
    const userCode = req.user.employee_code;

    let conds = [], params = [], idx = 1;

    if (userRole === 'super_admin') {
      // super_admin sees everything
    } else if (userRole === 'hr') {
      // HR sees all requests for non-pending views (history, reports).
      // For the pending queue, scope to requests where HR is the current
      // approver OR the employee's reporting manager — leaves they can act on.
      if (status === 'pending') {
        conds.push(
          `(lr.current_approver_code=$${idx++}
            OR EXISTS (
              SELECT 1 FROM employees sub
              WHERE sub.id = lr.employee_id
                AND (sub.reporting_manager_id=$${idx++} OR sub.team_leader_id=$${idx++})
            ))`
        );
        params.push(userCode, userId, userId);
        conds.push(`lr.employee_id != $${idx++}`);
        params.push(userId);
      }
    } else if (userRole === 'admin') {
      // Admin sees: pending (current approver) + history (actioned by them) + own requests
      conds.push(`(lr.current_approver_code=$${idx++} OR lr.actioned_by=$${idx++} OR lr.employee_id=$${idx++})`);
      params.push(userCode, userId, userId);
    } else if (['manager','tl'].includes(userRole)) {
      // Manager/TL sees: pending where current approver, history they actioned, own requests,
      // AND any request from an employee who reports to them (reporting_manager_id OR team_leader_id).
      // The team_leader_id check ensures TLs see requests from employees who have a different
      // reporting_manager but the same team_leader (e.g. employees id=44,45 in the org chart).
      // NOTE: When filtering by status=pending, own requests are excluded so the approval queue
      // only shows subordinates' requests (a manager cannot approve their own leave).
      conds.push(
        `(lr.current_approver_code=$${idx++}
          OR lr.actioned_by=$${idx++}
          OR lr.employee_id=$${idx++}
          OR EXISTS (
            SELECT 1 FROM employees sub
            WHERE sub.id = lr.employee_id
              AND (sub.reporting_manager_id=$${idx++} OR sub.team_leader_id=$${idx++})
          ))`
      );
      params.push(userCode, userId, userId, userId, userId);
      // Exclude own requests from the pending approval queue
      if (status === 'pending') {
        conds.push(`lr.employee_id != $${idx++}`);
        params.push(userId);
      }
    } else {
      // Employee/accounts sees only own requests
      conds.push(`lr.employee_id=$${idx++}`);
      params.push(userId);
    }

    if (employee_id) { conds.push(`lr.employee_id=$${idx++}`); params.push(employee_id); }
    if (status)      { conds.push(`lr.status=$${idx++}`);      params.push(status); }
    if (from_date)   { conds.push(`lr.from_date>=$${idx++}`);  params.push(from_date); }
    if (to_date)     { conds.push(`lr.to_date<=$${idx++}`);    params.push(to_date); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const result = await db.query(
      `SELECT lr.*,
              lt.name AS leave_type_name, lt.code AS leave_type_code,
              CONCAT(e.first_name,' ',e.last_name) AS employee_name,
              e.employee_code, d.name AS department_name,
              e.id AS employee_id
       FROM leave_requests lr
       JOIN employees e  ON lr.employee_id = e.id
       JOIN leave_types lt ON lr.leave_type_id = lt.id
       LEFT JOIN departments d ON e.department_id = d.id
       ${where}
       ORDER BY lr.created_at DESC`, params
    );

    // Expand approval_chain into l1/l2/l3 fields for the frontend
    const rows = result.rows;
    if (rows.length) {
      // Gather all approver codes needed
      const allCodes = new Set();
      rows.forEach(r => {
        let chain = r.approval_chain || [];
        if (!Array.isArray(chain)) {
          try { chain = JSON.parse(chain); } catch (_) { chain = []; }
        }
        chain.forEach(c => c && allCodes.add(c));
      });

      // Fetch approver details in one query
      const approverMap = {};
      if (allCodes.size) {
        const approvers = await db.query(
          `SELECT id, employee_code, CONCAT(first_name,' ',last_name) AS full_name
           FROM employees WHERE employee_code = ANY($1)`,
          [Array.from(allCodes)]
        );
        approvers.rows.forEach(a => { approverMap[a.employee_code] = a; });
      }

      rows.forEach(r => {
        let chain = r.approval_chain || [];
        if (!Array.isArray(chain)) {
          try { chain = JSON.parse(chain); } catch (_) { chain = []; }
        }
        r.approval_chain = chain;

        // Determine per-level status based on current_approver_code & overall status
        // Levels before current approver = approved, current = pending, after = pending (waiting)
        const currentIdx = r.current_approver_code ? chain.indexOf(r.current_approver_code) : -1;

        chain.forEach((code, i) => {
          const approver = approverMap[code];
          const levelKey = `l${i+1}`;
          r[`${levelKey}_approver_id`]   = approver?.id || null;
          r[`${levelKey}_approver_code`] = code;
          r[`${levelKey}_name`]          = approver?.full_name || code;
          // Status logic:
          // - overall approved/rejected → last actor approved/rejected, others before = approved
          // - overall pending → levels before currentIdx = approved, currentIdx+ = pending
          if (r.status === 'rejected') {
            // all levels up to and including the rejector = rejected, rest = pending
            r[`${levelKey}_status`] = i <= currentIdx || currentIdx === -1
              ? (i === chain.length - 1 || currentIdx === -1 ? 'rejected' : 'approved')
              : 'pending';
          } else if (r.status === 'approved') {
            r[`${levelKey}_status`] = 'approved';
          } else {
            // pending — levels before current = approved, current and after = pending
            r[`${levelKey}_status`] = (currentIdx === -1 || i < currentIdx) ? 'approved' : 'pending';
          }
        });

        // Alias for frontend compatibility
        r.applied_at = r.created_at;
        r.leave_category = r.is_half_day ? 'Half Day' : 'Full Day';
      });
    }

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get Leave Balance ─────────────────────────────────────────────────────────
exports.getBalance = async (req, res) => {
  try {
    const empId = req.query.employee_id ? parseInt(req.query.employee_id) : req.user.id;
    const year  = req.query.year || new Date().getFullYear();

    // Determine employee type to filter correct leave codes
    const empRes = await db.query(
      `SELECT employee_category, provision_end_date, joining_date FROM employees WHERE id=$1`, [empId]
    );
    const emp = empRes.rows[0];
    const now = new Date();
    const provisionEndDate = emp?.provision_end_date ? new Date(emp.provision_end_date) : null;

    // Contractual employees under 6 months from joining are also provisional (PL only)
    const joiningDate = emp?.joining_date ? new Date(emp.joining_date) : null;
    const contractualSixMonthMark = joiningDate ? new Date(joiningDate) : null;
    if (contractualSixMonthMark) contractualSixMonthMark.setMonth(contractualSixMonthMark.getMonth() + 6);
    const isContractualProvisional = emp?.employee_category === 'contractual' &&
                                     contractualSixMonthMark && now < contractualSixMonthMark;

    const isStillProvisional = isContractualProvisional ||
                               (emp?.employee_category === 'provision' &&
                                provisionEndDate && provisionEndDate > now);

    // TYPE 2 (still provisional): show only PL
    // Contractual confirmed (>6 months): show EL, CL, SL same as permanent
    // TYPE 1 & 3 (permanent / confirmed): show EL, CL, SL, OD, LWP — never PL
    const codeFilter = isStillProvisional
      ? `AND lt.code = 'PL'`
      : `AND lt.code IN ('EL','CL','SL','OD','LWP')`;

    const result = await db.query(
      `SELECT
         lt.id AS leave_type_id,
         lt.name, lt.code, lt.days_allowed,
         COALESCE(lb.allocated,     0) AS allocated,
         COALESCE(lb.used,          0) AS used,
         COALESCE(lb.pending,       0) AS pending,
         COALESCE(lb.carry_forward, 0) AS carry_forward,
         GREATEST(0,
           COALESCE(lb.allocated,0) + COALESCE(lb.carry_forward,0)
           - COALESCE(lb.used,0) - COALESCE(lb.pending,0)
         ) AS available
       FROM leave_types lt
       LEFT JOIN leave_balances lb
         ON lb.leave_type_id = lt.id
        AND lb.employee_id = $1
        AND lb.year = $2
       WHERE lt.is_active = true
         ${codeFilter}
       ORDER BY lt.code`, [empId, year]
    );

    const extra = isStillProvisional ? {
      is_provisional: true,
      provision_ends: isContractualProvisional
        ? contractualSixMonthMark.toISOString().split('T')[0]
        : provisionEndDate.toISOString().split('T')[0]
    } : { is_provisional: false };

    res.json({ success: true, data: result.rows, ...extra });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── HR: Update Leave Balance ──────────────────────────────────────────────────
exports.updateBalance = async (req, res) => {
  try {
    const { employee_id, leave_type_id, year, allocated, used, pending, carry_forward } = req.body;
    if (!employee_id || !leave_type_id || !year)
      return res.status(400).json({ success: false, message: 'employee_id, leave_type_id, year required' });

    await db.query(
      `INSERT INTO leave_balances(employee_id, leave_type_id, year, allocated, used, pending, carry_forward)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(employee_id, leave_type_id, year) DO UPDATE
       SET allocated=$4, used=$5, pending=$6, carry_forward=$7`,
      [employee_id, leave_type_id, year,
       allocated ?? 0, used ?? 0, pending ?? 0, carry_forward ?? 0]
    );
    res.json({ success: true, message: 'Leave balance updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};


// ── Leave Balance Recalculation — Core Logic ─────────────────────────────────
//
// RULES (run once per year OR any time HR triggers it):
//
//  CONTRACTUAL EMPLOYEE — under 6 months from joining:
//    → Treated as provisional regardless of employee_category label
//    → Gets PL only (6 days upfront), no EL/CL/SL
//    → After 6 months: switches to LWP + OD only (no PL/EL/CL/SL)
//
//  PROVISIONAL EMPLOYEE (joined < 6 months ago):
//    → Gets PL (Provision Leave) = 1 per month worked, max 6 days
//    → No EL/SL/CL yet
//
//  NEWLY CONFIRMED this year (was provisional, now confirmed mid-year):
//    → PL already given for provisional months stays as-is (don't touch used/pending)
//    → ADDITIONALLY gets prorated permanent leaves for remaining months:
//        EL = 18 × (remainingMonths / 12)
//        SL =  6 × (remainingMonths / 12)
//        CL =  6 × (remainingMonths / 12)
//    → e.g. confirmed in April (month 4) = 8 months remaining
//        EL = round(18 × 8/12) = 12,  SL = round(6 × 8/12) = 4,  CL = 4
//
//  PERMANENT EMPLOYEE (joined > 6 months ago OR joined before this year):
//    → Full year if joined Jan or before
//    → Prorated by remaining months if joined mid-year THIS year
//        e.g. joined July = 6 months remaining → EL=9, SL=3, CL=3
//
//  IDEMPOTENT — safe to run multiple times. Uses GREATEST so never reduces
//  an already-higher balance. Existing used/pending are never touched.
//
// ── Core per-employee recalculate ────────────────────────────────────────────
//
// 3 EMPLOYEE TYPES:
//
//  TYPE 1 — PERMANENT before Jan 1 of this year (joined before this year AND confirmed):
//    → Full 30 leaves: EL=18, CL=6, SL=6
//
//  TYPE 2 — STILL ON PROVISION (provision_end_date is in the future):
//    → They only see their provisional leave balance (managed separately as PL)
//    → EL/CL/SL = 0, do NOT touch their PL balance
//    → Once provision ends → system auto-switches to TYPE 3
//
//  TYPE 3 — CONFIRMED THIS YEAR (provision_end_date fell in year X):
//    → Months = number of full months from confirmation month to December (inclusive)
//    → e.g. confirmed April (month 4) → months = 9 (Apr–Dec) → 9 × 2.5 = 22.5 leaves
//    → Split: EL = months × 1.5,  CL = months × 0.5,  SL = months × 0.5
//    → The provisional PL balance is wiped (allocated=0) on confirmation — only new EL/CL/SL applies
//    → used/pending EL already consumed during provisional period are preserved
//
//  CONFIRMATION MONTH LOGIC:
//    provision_end_date drives the month count, not confirmed_date from provision_confirmations.
//    This ensures Moumita (ends Apr 24) = 9 months (Apr–Dec) = 22.5 leaves.
//    month count = 13 - confirmationMonth  where confirmationMonth is 1-indexed (Jan=1, Apr=4)
//
async function recalculateForEmployee(db, empId, year) {
  const now = new Date();

  const empRes = await db.query(
    `SELECT e.id, e.joining_date, e.employee_category,
            e.provision_end_date, e.confirmed_date
     FROM employees e
     WHERE e.id = $1`,
    [empId]
  );
  if (!empRes.rows.length) return { skipped: true, reason: 'employee not found' };
  const emp = empRes.rows[0];

  const joiningDate = new Date(emp.joining_date);
  const joinYear    = joiningDate.getFullYear();
  if (joinYear > year) return { skipped: true, reason: 'future joiner' };

  // Get EL/SL/CL/PL leave type ids
  const ltRes = await db.query(
    `SELECT id, code FROM leave_types WHERE is_active=true AND code IN ('EL','SL','CL','PL')`
  );
  const ltMap = {};
  for (const lt of ltRes.rows) ltMap[lt.code] = lt;

  // Helper: upsert a leave balance (sets allocated, never touches used/pending)
  const upsert = async (code, alloc) => {
    const lt = ltMap[code];
    if (!lt) return;
    await db.query(
      `INSERT INTO leave_balances(employee_id, leave_type_id, year, allocated)
       VALUES($1, $2, $3, $4)
       ON CONFLICT(employee_id, leave_type_id, year)
       DO UPDATE SET allocated = EXCLUDED.allocated`,
      [empId, lt.id, year, alloc]
    );
  };

  // Helper: zero out a leave type (only if no usage yet — safety guard)
  const zeroOut = async (code) => {
    const lt = ltMap[code];
    if (!lt) return;
    await db.query(
      `UPDATE leave_balances SET allocated = 0
       WHERE employee_id=$1 AND leave_type_id=$2 AND year=$3`,
      [empId, lt.id, year]
    );
  };

  // ── CONTRACTUAL ───────────────────────────────────────────────────────────
  // Under 6 months from joining → PL only (6 days upfront)
  // Over 6 months from joining  → EL=18, CL=6, SL=6 (same as permanent)
  //   Unused EL carries forward (max 6 days), CL/SL/PL lapse at year end
  if (emp.employee_category === 'contractual') {
    const sixMonthMark = new Date(joiningDate);
    sixMonthMark.setMonth(sixMonthMark.getMonth() + 6);

    if (now < sixMonthMark) {
      // Under 6 months: PL only (6 upfront)
      for (const code of ['EL', 'CL', 'SL']) {
        const lt = ltMap[code];
        if (lt) await db.query(
          `DELETE FROM leave_balances
           WHERE employee_id=$1 AND leave_type_id=$2 AND year=$3
             AND used=0 AND pending=0`,
          [empId, lt.id, year]
        );
      }
      await upsert('PL', 6);
      return {
        type: 'contractual_provisional',
        provisionalUntil: sixMonthMark.toISOString().split('T')[0],
        plAllocated: 6
      };
    } else {
      // Over 6 months: EL/CL/SL like permanent. Lapse PL.
      await zeroOut('PL');
      // Carry forward unused EL from prev year (max 6), lapse CL/SL
      const prevYear = year - 1;
      const prevElRes = await db.query(
        `SELECT GREATEST(0, lb.allocated + lb.carry_forward - lb.used - lb.pending) AS balance
         FROM leave_balances lb
         JOIN leave_types lt ON lt.id = lb.leave_type_id
         WHERE lb.employee_id=$1 AND lb.year=$2 AND lt.code='EL'`,
        [empId, prevYear]
      );
      const elCarry = prevElRes.rows.length ? Math.min(parseFloat(prevElRes.rows[0].balance || 0), 6) : 0;
      const elLt = ltMap['EL'];
      if (elLt) {
        await db.query(
          `INSERT INTO leave_balances(employee_id,leave_type_id,year,allocated,carry_forward,used,pending)
           VALUES($1,$2,$3,18,$4,0,0)
           ON CONFLICT(employee_id,leave_type_id,year)
           DO UPDATE SET allocated=18, carry_forward=$4`,
          [empId, elLt.id, year, elCarry]
        );
      }
      await upsert('CL', 6);
      await upsert('SL', 6);
      return { type: 'contractual_confirmed', elAllocated: 18, clAllocated: 6, slAllocated: 6, elCarryForward: elCarry };
    }
  }

  // ── TYPE 2: Still on provision ───────────────────────────────────────────
  // employee_category = 'provision' AND provision_end_date is in the future
  const provisionEndDate = emp.provision_end_date ? new Date(emp.provision_end_date) : null;
  const isStillProvisional = emp.employee_category === 'provision' &&
                             provisionEndDate && provisionEndDate > now;

  if (isStillProvisional) {
    // Remove any stale EL/CL/SL that may have been set — provisional employees get PL only
    for (const code of ['EL','CL','SL']) {
      const lt = ltMap[code];
      if (lt) await db.query(
        `DELETE FROM leave_balances
         WHERE employee_id=$1 AND leave_type_id=$2 AND year=$3
           AND used=0 AND pending=0`,
        [empId, lt.id, year]
      );
    }

    // ✅ PL = 6 granted upfront on joining (full provisional entitlement from day 1)
    // Previously: 1 per month worked (accrual). Changed to: full 6 immediately so
    // new joiners (e.g. Feb joiners) can see and use their complete PL balance right away.
    const plAlloc = 6;
    await upsert('PL', plAlloc);

    return {
      type: 'provisional',
      provisionalUntil: provisionEndDate.toISOString().split('T')[0],
      plAllocated: plAlloc
    };
  }

  // ── TYPE 3: Provision ended THIS year ────────────────────────────────────
  // provision_end_date exists and falls within this year
  if (provisionEndDate && provisionEndDate.getFullYear() === year) {
    const confirmationMonth = provisionEndDate.getMonth() + 1; // 1-indexed (Jan=1, Apr=4)
    // months = from confirmation month to December, inclusive
    // e.g. Apr (4) → Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec = 9 months = 13 - 4
    const months = 13 - confirmationMonth;

    const elAlloc = parseFloat((months * 1.5).toFixed(2));
    const clAlloc = parseFloat((months * 0.5).toFixed(2));
    const slAlloc = parseFloat((months * 0.5).toFixed(2));

    // Wipe old PL balance (provision is over)
    await zeroOut('PL');

    // Set confirmed leave allocations
    await upsert('EL', elAlloc);
    await upsert('CL', clAlloc);
    await upsert('SL', slAlloc);

    return {
      type: 'confirmed_this_year',
      confirmationMonth,
      months,
      elAllocated: elAlloc,
      clAllocated: clAlloc,
      slAllocated: slAlloc,
      total: elAlloc + clAlloc + slAlloc
    };
  }

  // ── TYPE 1: Permanent (joined before this year, fully confirmed) ──────────
  // EL=18 + carry forward unused EL from prev year (max 6). CL/SL lapse (no carry).
  {
    const prevYear = year - 1;
    const prevElRes = await db.query(
      `SELECT GREATEST(0, lb.allocated + lb.carry_forward - lb.used - lb.pending) AS balance
       FROM leave_balances lb
       JOIN leave_types lt ON lt.id = lb.leave_type_id
       WHERE lb.employee_id=$1 AND lb.year=$2 AND lt.code='EL'`,
      [empId, prevYear]
    );
    const elCarry = prevElRes.rows.length ? Math.min(parseFloat(prevElRes.rows[0].balance || 0), 6) : 0;
    const elLt = ltMap['EL'];
    if (elLt) {
      await db.query(
        `INSERT INTO leave_balances(employee_id,leave_type_id,year,allocated,carry_forward,used,pending)
         VALUES($1,$2,$3,18,$4,0,0)
         ON CONFLICT(employee_id,leave_type_id,year)
         DO UPDATE SET allocated=18, carry_forward=$4`,
        [empId, elLt.id, year, elCarry]
      );
    }
    await upsert('CL', 6);  // CL lapses — no carry forward
    await upsert('SL', 6);  // SL lapses — no carry forward
    return { type: 'permanent', elAllocated: 18, clAllocated: 6, slAllocated: 6, elCarryForward: elCarry, total: 30 + elCarry };
  }
}

// ── Recalculate single employee's leave (HR can call this any time) ───────────
exports.recalculateEmployee = async (req, res) => {
  try {
    const year   = parseInt(req.query.year) || new Date().getFullYear();
    const empId  = parseInt(req.params.id || req.query.employee_id);
    if (!empId) return res.status(400).json({ success: false, message: 'employee_id required' });

    const result = await recalculateForEmployee(db, empId, year);
    res.json({ success: true, year, employee_id: empId, result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Bulk Recalculate — run for all employees (replaces old monthlyAccrual) ────
// IDEMPOTENT — safe to run on Jan 1 AND any time mid-year (e.g. when someone confirms)
exports.monthlyAccrual = async (req, res) => {
  try {
    const now  = new Date();
    const year = parseInt(req.query.year) || now.getFullYear();

    const employees = await db.query(
      `SELECT id FROM employees WHERE is_active=true ORDER BY id`
    );

    const results = { permanent: 0, provisional: 0, confirmed_this_year: 0, skipped: 0, errors: 0 };
    const details = [];

    for (const emp of employees.rows) {
      try {
        const r = await recalculateForEmployee(db, emp.id, year);
        if (r.skipped) { results.skipped++; }
        else {
          results[r.type] = (results[r.type] || 0) + 1;
          details.push({ employee_id: emp.id, ...r });
        }
      } catch (e) {
        console.error(`recalculate error for emp ${emp.id}:`, e.message);
        results.errors++;
      }
    }

    res.json({
      success: true,
      message: `Leave recalculated for ${employees.rows.length} employees`,
      year,
      summary: results,
      details
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Leave Report — per employee: dates taken + totals from Jan of this year ──
// GET /api/leaves/report?year=2026&employee_id=5
// GET /api/leaves/report?year=2026          (all employees — HR only)
exports.getLeaveReport = async (req, res) => {
  try {
    const year    = parseInt(req.query.year) || new Date().getFullYear();
    const userId  = req.user.id;
    const role    = req.user.role;
    const isHrAdmin = ['hr','admin','super_admin','accounts'].includes(role);

    // Who are we reporting on?
    let employeeIds = [];
    if (req.query.employee_id) {
      const eid = parseInt(req.query.employee_id);
      // Employees can only view their own
      if (!isHrAdmin && eid !== userId)
        return res.status(403).json({ success: false, message: 'Access denied' });
      employeeIds = [eid];
    } else if (isHrAdmin) {
      const res2 = await db.query(`SELECT id FROM employees WHERE is_active=true ORDER BY id`);
      employeeIds = res2.rows.map(r => r.id);
    } else {
      employeeIds = [userId];
    }

    // Get all leave requests for these employees in this year
    const leavesRes = await db.query(
      `SELECT
         lr.employee_id,
         CONCAT(e.first_name,' ',e.last_name) AS employee_name,
         e.employee_code,
         lt.code AS leave_type,
         lt.name AS leave_type_name,
         lr.from_date,
         lr.to_date,
         lr.days_requested,
         lr.status,
         lr.reason,
         lr.created_at
       FROM leave_requests lr
       JOIN employees e  ON lr.employee_id = e.id
       JOIN leave_types lt ON lr.leave_type_id = lt.id
       WHERE lr.employee_id = ANY($1)
         AND EXTRACT(YEAR FROM lr.from_date) = $2
         AND lr.status IN ('approved','pending')
       ORDER BY lr.employee_id, lr.from_date`,
      [employeeIds, year]
    );

    // Get balances
    const balRes = await db.query(
      `SELECT
         lb.employee_id,
         lt.code AS leave_type,
         lt.name AS leave_type_name,
         lb.allocated,
         lb.used,
         lb.pending,
         lb.carry_forward,
         GREATEST(0, lb.allocated + lb.carry_forward - lb.used - lb.pending) AS available
       FROM leave_balances lb
       JOIN leave_types lt ON lb.leave_type_id = lt.id
       WHERE lb.employee_id = ANY($1) AND lb.year = $2
       ORDER BY lb.employee_id, lt.code`,
      [employeeIds, year]
    );

    // Group by employee
    const report = {};
    for (const eid of employeeIds) {
      report[eid] = {
        employee_id: eid,
        employee_name: null,
        employee_code: null,
        balances: {},
        leaves: [],
        totals: { approved: 0, pending: 0, total: 0 }
      };
    }

    // Fill leaves
    for (const row of leavesRes.rows) {
      const rec = report[row.employee_id];
      if (!rec) continue;
      rec.employee_name = row.employee_name;
      rec.employee_code = row.employee_code;
      rec.leaves.push({
        leave_type:      row.leave_type,
        leave_type_name: row.leave_type_name,
        from_date:       row.from_date,
        to_date:         row.to_date,
        days:            parseFloat(row.days_requested),
        status:          row.status,
        reason:          row.reason,
        applied_at:      row.created_at
      });
      if (row.status === 'approved') rec.totals.approved += parseFloat(row.days_requested);
      if (row.status === 'pending')  rec.totals.pending  += parseFloat(row.days_requested);
      rec.totals.total = rec.totals.approved + rec.totals.pending;
    }

    // Fill balances
    for (const row of balRes.rows) {
      const rec = report[row.employee_id];
      if (!rec) continue;
      rec.balances[row.leave_type] = {
        name:          row.leave_type_name,
        allocated:     parseFloat(row.allocated),
        used:          parseFloat(row.used),
        pending:       parseFloat(row.pending),
        carry_forward: parseFloat(row.carry_forward),
        available:     parseFloat(row.available)
      };
    }

    // Fill names for employees with no leaves this year
    const empNames = await db.query(
      `SELECT id, CONCAT(first_name,' ',last_name) AS name, employee_code
       FROM employees WHERE id = ANY($1)`,
      [employeeIds]
    );
    for (const row of empNames.rows) {
      if (report[row.id]) {
        report[row.id].employee_name  = report[row.id].employee_name  || row.name;
        report[row.id].employee_code  = report[row.id].employee_code  || row.employee_code;
      }
    }

    const reportArray = Object.values(report).filter(r => r.employee_name);

    res.json({ success: true, year, count: reportArray.length, data: reportArray });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Cancel Leave (employee can cancel pending) ────────────────────────────────
exports.cancel = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const lr = await client.query(
      `SELECT lr.*, lt.code AS lt_code FROM leave_requests lr
       JOIN leave_types lt ON lr.leave_type_id = lt.id
       WHERE lr.id=$1`, [id]
    );
    if (!lr.rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    const leave = lr.rows[0];

    // Only employee or hr/admin can cancel
    if (leave.employee_id !== req.user.id && !['hr','admin','super_admin'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    if (!['pending'].includes(leave.status))
      return res.status(400).json({ success: false, message: `Cannot cancel a ${leave.status} leave. To revoke an approved leave use the Revoke option.` });

    await client.query(`UPDATE leave_requests SET status='cancelled' WHERE id=$1`, [id]);

    // Release pending balance
    if (!['OD','LWP'].includes(leave.lt_code)) {
      const year = new Date(leave.from_date).getFullYear();
      await client.query(
        `UPDATE leave_balances SET pending = GREATEST(0, pending - $1)
         WHERE employee_id=$2 AND leave_type_id=$3 AND year=$4`,
        [leave.days_requested, leave.employee_id, leave.leave_type_id, year]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, message: 'Leave cancelled' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ── Revoke Approved Leave (employee can revoke BEFORE leave start date) ───────
exports.revoke = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { reason } = req.body;

    const lr = await client.query(
      `SELECT lr.*, lt.code AS lt_code FROM leave_requests lr
       JOIN leave_types lt ON lr.leave_type_id = lt.id
       WHERE lr.id=$1`, [id]
    );
    if (!lr.rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    const leave = lr.rows[0];

    // Only the employee themselves can revoke their own approved leave
    if (leave.employee_id !== req.user.id && !['hr','admin','super_admin'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    // Can only revoke approved leaves
    if (leave.status !== 'approved')
      return res.status(400).json({ success: false, message: `Can only revoke approved leaves. Current status: ${leave.status}` });

    // Can only revoke BEFORE the leave start date
    const today    = new Date().toISOString().split('T')[0];
    const fromDate = leave.from_date.toString().split('T')[0];
    if (today >= fromDate)
      return res.status(400).json({
        success: false,
        message: `Cannot revoke — leave has already started (${fromDate}). Please contact HR.`
      });

    // Revoke: set status back to cancelled, restore used balance
    await client.query(
      `UPDATE leave_requests
       SET status='cancelled', remarks=COALESCE($1, remarks), updated_at=NOW()
       WHERE id=$2`,
      [reason ? `Revoked by employee: ${reason}` : 'Revoked by employee', id]
    );

    // Restore used balance — deduct what was used back
    if (!['OD','LWP'].includes(leave.lt_code)) {
      const year = new Date(leave.from_date).getFullYear();
      await client.query(
        `UPDATE leave_balances
         SET used = GREATEST(0, used - $1)
         WHERE employee_id=$2 AND leave_type_id=$3 AND year=$4`,
        [leave.days_requested, leave.employee_id, leave.leave_type_id, year]
      );
    }

    // Also revert attendance records back from on-leave to absent for future dates
    await client.query(
      `DELETE FROM attendance
       WHERE employee_id=$1
         AND date BETWEEN $2 AND $3
         AND status = 'on-leave'
         AND date >= CURRENT_DATE`,
      [leave.employee_id, leave.from_date, leave.to_date]
    );

    // Notify manager
    const empInfo = await client.query(
      `SELECT e.first_name, e.last_name, e.employee_code, m.id AS mgr_id
       FROM employees e
       LEFT JOIN employees m ON e.reporting_manager_id = m.id
       WHERE e.id=$1`, [leave.employee_id]
    );
    const emp = empInfo.rows[0];
    if (emp?.mgr_id) {
      await client.query(
        `INSERT INTO notifications(employee_id, type, title, message, expires_at)
         VALUES($1,'leave','↩️ Leave Revoked',$2,NOW() + INTERVAL '48 hours')`,
        [emp.mgr_id,
         `${emp.first_name} ${emp.last_name} (${emp.employee_code}) has revoked their approved leave from ${fromDate} to ${leave.to_date.toString().split('T')[0]}. ${reason ? 'Reason: ' + reason : ''}`]
      );
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      message: `Leave revoked successfully. Your ${leave.days_requested} day(s) have been restored to your balance.`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ── HR: Get Leave Summary per Employee (EL, SL balance counts) ───────────────
exports.getLeaveSummary = async (req, res) => {
  try {
    const role = req.user.role;
    if (!['hr','super_admin','admin','accounts'].includes(role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const year = parseInt(req.query.year) || new Date().getFullYear();
    const search = req.query.search || ''; // name or employee_code

    let empWhere = `WHERE e.is_active = true`;
    let empParams = [year];
    let idx = 2;
    if (search) {
      empWhere += ` AND (LOWER(CONCAT(e.first_name,' ',e.last_name)) LIKE $${idx} OR LOWER(e.employee_code) LIKE $${idx})`;
      empParams.push(`%${search.toLowerCase()}%`);
      idx++;
    }

    const result = await db.query(
      `SELECT e.id, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
              e.employee_code, d.name AS department,
              des.title AS designation,
              SUM(CASE WHEN lt.code='EL' THEN lb.allocated + lb.carry_forward ELSE 0 END) AS el_allocated,
              SUM(CASE WHEN lt.code='EL' THEN lb.used ELSE 0 END) AS el_used,
              SUM(CASE WHEN lt.code='EL' THEN lb.pending ELSE 0 END) AS el_pending,
              SUM(CASE WHEN lt.code='EL' THEN GREATEST(0, lb.allocated + lb.carry_forward - lb.used - lb.pending) ELSE 0 END) AS el_available,
              SUM(CASE WHEN lt.code='SL' THEN lb.allocated + lb.carry_forward ELSE 0 END) AS sl_allocated,
              SUM(CASE WHEN lt.code='SL' THEN lb.used ELSE 0 END) AS sl_used,
              SUM(CASE WHEN lt.code='SL' THEN lb.pending ELSE 0 END) AS sl_pending,
              SUM(CASE WHEN lt.code='SL' THEN GREATEST(0, lb.allocated + lb.carry_forward - lb.used - lb.pending) ELSE 0 END) AS sl_available,
              SUM(CASE WHEN lt.code='CL' THEN lb.allocated + lb.carry_forward ELSE 0 END) AS cl_allocated,
              SUM(CASE WHEN lt.code='CL' THEN lb.used ELSE 0 END) AS cl_used,
              SUM(CASE WHEN lt.code='CL' THEN lb.pending ELSE 0 END) AS cl_pending,
              SUM(CASE WHEN lt.code='CL' THEN GREATEST(0, lb.allocated + lb.carry_forward - lb.used - lb.pending) ELSE 0 END) AS cl_available
       FROM employees e
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       LEFT JOIN leave_balances lb ON lb.employee_id = e.id AND lb.year = $1
       LEFT JOIN leave_types lt ON lt.id = lb.leave_type_id
       ${empWhere}
       GROUP BY e.id, e.first_name, e.last_name, e.employee_code, d.name, des.title
       ORDER BY d.name, e.first_name`,
      empParams
    );

    res.json({ success: true, year, count: result.rows.length, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── HR: Leave Transaction — individual search by name or ID ─────────────────
exports.getLeaveTransactions = async (req, res) => {
  try {
    const role = req.user.role;
    if (!['hr','super_admin','admin','accounts'].includes(role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const year = parseInt(req.query.year) || new Date().getFullYear();
    const search = req.query.search || '';
    const employee_id = req.query.employee_id ? parseInt(req.query.employee_id) : null;
    const leave_type = req.query.leave_type || '';
    const status = req.query.status || '';

    let conds = [`EXTRACT(YEAR FROM lr.from_date) = $1`];
    let params = [year];
    let idx = 2;

    if (employee_id) {
      conds.push(`lr.employee_id = $${idx++}`);
      params.push(employee_id);
    } else if (search) {
      conds.push(`(LOWER(CONCAT(e.first_name,' ',e.last_name)) LIKE $${idx} OR LOWER(e.employee_code) LIKE $${idx})`);
      params.push(`%${search.toLowerCase()}%`);
      idx++;
    }
    if (leave_type) { conds.push(`lt.code = $${idx++}`); params.push(leave_type); }
    if (status)     { conds.push(`lr.status = $${idx++}`); params.push(status); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const result = await db.query(
      `SELECT lr.id, lr.employee_id,
              CONCAT(e.first_name,' ',e.last_name) AS employee_name,
              e.employee_code, d.name AS department,
              lt.name AS leave_type_name, lt.code AS leave_type_code,
              lr.from_date, lr.to_date, lr.days_requested,
              lr.reason, lr.status, lr.is_half_day,
              lr.created_at AS applied_at,
              lr.remarks AS action_remarks
       FROM leave_requests lr
       JOIN employees e ON lr.employee_id = e.id
       JOIN leave_types lt ON lr.leave_type_id = lt.id
       LEFT JOIN departments d ON e.department_id = d.id
       ${where}
       ORDER BY lr.created_at DESC
       LIMIT 500`,
      params
    );

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
