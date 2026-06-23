const db = require('../config/db');

/**
 * GET /approvals/pending
 * Returns all pending requests for the logged-in manager/HR across all types:
 * Leave, Regularization, OD, WFH, Advance, Reimbursement
 */
exports.getPendingApprovals = async (req, res) => {
  try {
    const user   = req.user;
    const userId = user.id;
    const role   = user.role;
    const isHR   = ['hr','admin','super_admin'].includes(role);
    const isMgr  = ['manager','tl','hr','admin','super_admin'].includes(role);

    // ── 1. Leave requests ──────────────────────────────────────────────────
    let leaveRows = [];
    if (isMgr) {
      const q = isHR
        ? `SELECT lr.id, lr.employee_id, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
                  e.employee_code, d.name AS department,
                  lt.name AS leave_type, lt.code AS leave_code,
                  lr.from_date, lr.to_date, lr.days_requested AS days,
                  lr.reason, lr.status, lr.is_half_day, lr.created_at AS applied_at,
                  'leave' AS request_type
           FROM leave_requests lr
           JOIN employees e ON e.id = lr.employee_id
           JOIN leave_types lt ON lt.id = lr.leave_type_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE lr.status = 'pending'
           ORDER BY lr.created_at DESC LIMIT 200`
        : `SELECT lr.id, lr.employee_id, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
                  e.employee_code, d.name AS department,
                  lt.name AS leave_type, lt.code AS leave_code,
                  lr.from_date, lr.to_date, lr.days_requested AS days,
                  lr.reason, lr.status, lr.is_half_day, lr.created_at AS applied_at,
                  'leave' AS request_type
           FROM leave_requests lr
           JOIN employees e ON e.id = lr.employee_id
           JOIN leave_types lt ON lt.id = lr.leave_type_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE lr.status = 'pending'
             AND e.reporting_manager_id = $1
           ORDER BY lr.created_at DESC LIMIT 200`;
      const r = await db.query(q, isHR ? [] : [userId]);
      leaveRows = r.rows;
    }

    // ── 2. Regularizations ─────────────────────────────────────────────────
    let regRows = [];
    if (isMgr) {
      const q = isHR
        ? `SELECT a.id, a.employee_id, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
                  e.employee_code, d.name AS department,
                  a.date AS from_date, a.date AS to_date, 1 AS days,
                  a.regularization_reason AS reason,
                  a.regularization_status AS status,
                  a.updated_at AS applied_at,
                  'regularization' AS request_type
           FROM attendance a
           JOIN employees e ON e.id = a.employee_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE a.regularization_status = 'pending'
           ORDER BY a.updated_at DESC LIMIT 200`
        : `SELECT a.id, a.employee_id, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
                  e.employee_code, d.name AS department,
                  a.date AS from_date, a.date AS to_date, 1 AS days,
                  a.regularization_reason AS reason,
                  a.regularization_status AS status,
                  a.updated_at AS applied_at,
                  'regularization' AS request_type
           FROM attendance a
           JOIN employees e ON e.id = a.employee_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE a.regularization_status = 'pending'
             AND e.reporting_manager_id = $1
           ORDER BY a.updated_at DESC LIMIT 200`;
      const r = await db.query(q, isHR ? [] : [userId]);
      regRows = r.rows;
    }

    // ── 3. OD Requests ────────────────────────────────────────────────────
    let odRows = [];
    if (isMgr) {
      const q = isHR
        ? `SELECT o.id, o.employee_id, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
                  e.employee_code, d.name AS department,
                  o.from_date, o.to_date,
                  EXTRACT(EPOCH FROM (o.to_date::timestamp - o.from_date::timestamp))/3600 AS days,
                  o.reason, o.status, o.created_at AS applied_at,
                  'od' AS request_type
           FROM od_requests o
           JOIN employees e ON e.id = o.employee_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE o.status = 'pending'
           ORDER BY o.created_at DESC LIMIT 200`
        : `SELECT o.id, o.employee_id, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
                  e.employee_code, d.name AS department,
                  o.from_date, o.to_date,
                  EXTRACT(EPOCH FROM (o.to_date::timestamp - o.from_date::timestamp))/3600 AS days,
                  o.reason, o.status, o.created_at AS applied_at,
                  'od' AS request_type
           FROM od_requests o
           JOIN employees e ON e.id = o.employee_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE o.status = 'pending'
             AND e.reporting_manager_id = $1
           ORDER BY o.created_at DESC LIMIT 200`;
      const r = await db.query(q, isHR ? [] : [userId]).catch(() => ({ rows: [] }));
      odRows = r.rows;
    }

    // ── 4. WFH Requests ───────────────────────────────────────────────────
    let wfhRows = [];
    if (isMgr) {
      const q = isHR
        ? `SELECT w.id, w.employee_id, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
                  e.employee_code, d.name AS department,
                  w.date AS from_date, w.date AS to_date, 1 AS days,
                  w.reason, w.status, w.created_at AS applied_at,
                  'wfh' AS request_type
           FROM wfh_requests w
           JOIN employees e ON e.id = w.employee_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE w.status = 'pending'
           ORDER BY w.created_at DESC LIMIT 200`
        : `SELECT w.id, w.employee_id, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
                  e.employee_code, d.name AS department,
                  w.date AS from_date, w.date AS to_date, 1 AS days,
                  w.reason, w.status, w.created_at AS applied_at,
                  'wfh' AS request_type
           FROM wfh_requests w
           JOIN employees e ON e.id = w.employee_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE w.status = 'pending'
             AND e.reporting_manager_id = $1
           ORDER BY w.created_at DESC LIMIT 200`;
      const r = await db.query(q, isHR ? [] : [userId]).catch(() => ({ rows: [] }));
      wfhRows = r.rows;
    }

    // ── 5. Advance Salary ─────────────────────────────────────────────────
    let advRows = [];
    if (isMgr) {
      const q = isHR
        ? `SELECT a.id, a.employee_id, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
                  e.employee_code, d.name AS department,
                  a.created_at AS from_date, a.created_at AS to_date,
                  a.amount AS days,
                  CONCAT('Advance: ₹', a.amount, ' | EMIs: ', a.emi_count) AS reason,
                  a.status, a.created_at AS applied_at,
                  'advance' AS request_type
           FROM advance_salary a
           JOIN employees e ON e.id = a.employee_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE a.status = 'pending'
           ORDER BY a.created_at DESC LIMIT 200`
        : `SELECT a.id, a.employee_id, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
                  e.employee_code, d.name AS department,
                  a.created_at AS from_date, a.created_at AS to_date,
                  a.amount AS days,
                  CONCAT('Advance: ₹', a.amount, ' | EMIs: ', a.emi_count) AS reason,
                  a.status, a.created_at AS applied_at,
                  'advance' AS request_type
           FROM advance_salary a
           JOIN employees e ON e.id = a.employee_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE a.status = 'pending'
             AND e.reporting_manager_id = $1
           ORDER BY a.created_at DESC LIMIT 200`;
      const r = await db.query(q, isHR ? [] : [userId]).catch(() => ({ rows: [] }));
      advRows = r.rows;
    }

    // ── 6. Reimbursement ─────────────────────────────────────────────────
    let reimbRows = [];
    if (isMgr) {
      const q = isHR
        ? `SELECT r.id, r.employee_id, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
                  e.employee_code, d.name AS department,
                  r.expense_date AS from_date, r.expense_date AS to_date,
                  r.amount AS days,
                  CONCAT(r.category, ': ', r.description) AS reason,
                  r.status, r.created_at AS applied_at,
                  'reimbursement' AS request_type
           FROM reimbursements r
           JOIN employees e ON e.id = r.employee_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE r.status = 'pending'
           ORDER BY r.created_at DESC LIMIT 200`
        : `SELECT r.id, r.employee_id, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
                  e.employee_code, d.name AS department,
                  r.expense_date AS from_date, r.expense_date AS to_date,
                  r.amount AS days,
                  CONCAT(r.category, ': ', r.description) AS reason,
                  r.status, r.created_at AS applied_at,
                  'reimbursement' AS request_type
           FROM reimbursements r
           JOIN employees e ON e.id = r.employee_id
           LEFT JOIN departments d ON d.id = e.department_id
           WHERE r.status = 'pending'
             AND e.reporting_manager_id = $1
           ORDER BY r.created_at DESC LIMIT 200`;
      const r = await db.query(q, isHR ? [] : [userId]).catch(() => ({ rows: [] }));
      reimbRows = r.rows;
    }

    // Merge and sort by applied_at desc
    const all = [
      ...leaveRows, ...regRows, ...odRows,
      ...wfhRows,  ...advRows, ...reimbRows
    ].sort((a, b) => new Date(b.applied_at) - new Date(a.applied_at));

    const counts = {
      leave:          leaveRows.length,
      regularization: regRows.length,
      od:             odRows.length,
      wfh:            wfhRows.length,
      advance:        advRows.length,
      reimbursement:  reimbRows.length,
      total:          all.length
    };

    res.json({ success: true, counts, data: all });
  } catch (err) {
    console.error('[getPendingApprovals]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /approvals/bulk-action
 * Bulk approve or reject multiple requests of mixed types
 * Body: { action: 'approve'|'reject', remarks: '...', items: [{id, type}] }
 */
exports.bulkAction = async (req, res) => {
  try {
    const { action, remarks = '', items = [] } = req.body;
    if (!['approve','reject'].includes(action))
      return res.status(400).json({ success: false, message: 'action must be approve or reject' });
    if (!items.length)
      return res.status(400).json({ success: false, message: 'No items selected' });

    const userId = req.user.id;
    let succeeded = 0, failed = 0, errors = [];

    for (const item of items) {
      try {
        switch (item.type) {
          case 'leave':
            await db.query(
              `UPDATE leave_requests
               SET status=$1, actioned_by=$2, actioned_at=NOW(), actioned_remarks=$3
               WHERE id=$4 AND status='pending'`,
              [action === 'approve' ? 'approved' : 'rejected', userId, remarks, item.id]
            );
            // Update leave balance if approved
            if (action === 'approve') {
              const lr = await db.query(`SELECT * FROM leave_requests WHERE id=$1`, [item.id]);
              if (lr.rows[0]) {
                const r = lr.rows[0];
                await db.query(
                  `UPDATE leave_balances SET used=used+$1, pending=GREATEST(0,pending-$1)
                   WHERE employee_id=$2 AND leave_type_id=$3
                     AND year=EXTRACT(YEAR FROM $4::date)`,
                  [r.days_requested, r.employee_id, r.leave_type_id, r.from_date]
                ).catch(() => {});
              }
            } else {
              await db.query(
                `UPDATE leave_balances SET pending=GREATEST(0,pending-(SELECT days_requested FROM leave_requests WHERE id=$1))
                 WHERE employee_id=(SELECT employee_id FROM leave_requests WHERE id=$1)
                   AND leave_type_id=(SELECT leave_type_id FROM leave_requests WHERE id=$1)`,
                [item.id]
              ).catch(() => {});
            }
            break;

          case 'regularization':
            await db.query(
              `UPDATE attendance
               SET regularization_status=$1, regularization_actioned_by=$2,
                   regularization_actioned_at=NOW(), regularization_remarks=$3,
                   status=CASE WHEN $1='approved' THEN 'regularized' ELSE status END
               WHERE id=$4 AND regularization_status='pending'`,
              [action === 'approve' ? 'approved' : 'rejected', userId, remarks, item.id]
            );
            break;

          case 'od':
            await db.query(
              `UPDATE od_requests SET status=$1, actioned_by=$2, actioned_at=NOW(), remarks=$3
               WHERE id=$4 AND status='pending'`,
              [action === 'approve' ? 'approved' : 'rejected', userId, remarks, item.id]
            );
            break;

          case 'wfh':
            await db.query(
              `UPDATE wfh_requests SET status=$1, actioned_by=$2, actioned_at=NOW(), remarks=$3
               WHERE id=$4 AND status='pending'`,
              [action === 'approve' ? 'approved' : 'rejected', userId, remarks, item.id]
            );
            break;

          case 'advance':
            await db.query(
              `UPDATE advance_salary SET status=$1, actioned_by=$2, actioned_at=NOW(), remarks=$3
               WHERE id=$4 AND status='pending'`,
              [action === 'approve' ? 'approved' : 'rejected', userId, remarks, item.id]
            );
            break;

          case 'reimbursement':
            await db.query(
              `UPDATE reimbursements SET status=$1, actioned_by=$2, actioned_at=NOW(), remarks=$3
               WHERE id=$4 AND status='pending'`,
              [action === 'approve' ? 'approved' : 'rejected', userId, remarks, item.id]
            );
            break;

          default:
            failed++;
            errors.push(`Unknown type: ${item.type}`);
            continue;
        }
        succeeded++;
      } catch (e) {
        failed++;
        errors.push(`${item.type}#${item.id}: ${e.message}`);
      }
    }

    res.json({
      success: true,
      message: `${succeeded} ${action}d${failed ? `, ${failed} failed` : ''}`,
      succeeded, failed, errors
    });
  } catch (err) {
    console.error('[bulkAction]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};
