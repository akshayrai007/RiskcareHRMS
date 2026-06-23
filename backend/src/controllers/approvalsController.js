const db = require('../config/db');

exports.getPendingApprovals = async (req, res) => {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    const isHR   = ['hr','admin','super_admin'].includes(role);
    const isMgr  = ['manager','tl','hr','admin','super_admin'].includes(role);
    if (!isMgr) return res.status(403).json({ success: false, message: 'Access denied' });

    const scope = isHR ? '' : `AND e.reporting_manager_id = ${userId}`;
    const all = [];

    // 1. Leave
    try {
      const r = await db.query(`
        SELECT lr.id, 'leave' AS request_type,
               CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.employee_code,
               d.name AS department, lt.name AS leave_type, lt.code AS leave_code,
               lr.from_date, lr.to_date, lr.days_requested AS days,
               lr.reason, lr.status, lr.created_at AS applied_at
        FROM leave_requests lr
        JOIN employees e ON e.id = lr.employee_id
        JOIN leave_types lt ON lt.id = lr.leave_type_id
        LEFT JOIN departments d ON d.id = e.department_id
        WHERE lr.status = 'pending' ${scope}
        ORDER BY lr.created_at DESC LIMIT 200`);
      all.push(...r.rows);
    } catch(e) { console.error('leave query:', e.message); }

    // 2. Regularization
    try {
      const r = await db.query(`
        SELECT a.id, 'regularization' AS request_type,
               CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.employee_code,
               d.name AS department,
               a.date AS from_date, a.date AS to_date, 1 AS days,
               a.regularization_reason AS reason, a.regularization_status AS status,
               a.updated_at AS applied_at
        FROM attendance a
        JOIN employees e ON e.id = a.employee_id
        LEFT JOIN departments d ON d.id = e.department_id
        WHERE a.regularization_status = 'pending' ${scope}
        ORDER BY a.updated_at DESC LIMIT 200`);
      all.push(...r.rows);
    } catch(e) { console.error('reg query:', e.message); }

    // 3. OD
    try {
      const r = await db.query(`
        SELECT o.id, 'od' AS request_type,
               CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.employee_code,
               d.name AS department,
               o.date AS from_date, o.date AS to_date, 1 AS days,
               o.reason, o.status, o.applied_at
        FROM od_requests o
        JOIN employees e ON e.id = o.employee_id
        LEFT JOIN departments d ON d.id = e.department_id
        WHERE o.status = 'pending' ${scope}
        ORDER BY o.applied_at DESC LIMIT 200`);
      all.push(...r.rows);
    } catch(e) { console.error('od query:', e.message); }

    // 4. WFH
    try {
      const r = await db.query(`
        SELECT w.id, 'wfh' AS request_type,
               CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.employee_code,
               d.name AS department,
               w.from_date, COALESCE(w.to_date, w.from_date) AS to_date, 1 AS days,
               w.reason, w.status, w.created_at AS applied_at
        FROM wfh_requests w
        JOIN employees e ON e.id = w.employee_id
        LEFT JOIN departments d ON d.id = e.department_id
        WHERE w.status = 'pending' ${scope}
        ORDER BY w.created_at DESC LIMIT 200`);
      all.push(...r.rows);
    } catch(e) { console.error('wfh query:', e.message); }

    // 5. Advance
    try {
      const r = await db.query(`
        SELECT a.id, 'advance' AS request_type,
               CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.employee_code,
               d.name AS department,
               a.created_at AS from_date, a.created_at AS to_date,
               a.amount AS days,
               CONCAT('₹', a.amount, ' | ', a.emi_count, ' EMIs') AS reason,
               a.status, a.created_at AS applied_at
        FROM advance_salary a
        JOIN employees e ON e.id = a.employee_id
        LEFT JOIN departments d ON d.id = e.department_id
        WHERE a.status = 'pending' ${scope}
        ORDER BY a.created_at DESC LIMIT 200`);
      all.push(...r.rows);
    } catch(e) { console.error('advance query:', e.message); }

    // 6. Reimbursement
    try {
      const r = await db.query(`
        SELECT r.id, 'reimbursement' AS request_type,
               CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.employee_code,
               d.name AS department,
               r.expense_date AS from_date, r.expense_date AS to_date,
               r.amount AS days,
               CONCAT(r.category, ': ', r.description) AS reason,
               r.status, r.created_at AS applied_at
        FROM reimbursements r
        JOIN employees e ON e.id = r.employee_id
        LEFT JOIN departments d ON d.id = e.department_id
        WHERE r.status = 'pending' ${scope}
        ORDER BY r.created_at DESC LIMIT 200`);
      all.push(...r.rows);
    } catch(e) { console.error('reimb query:', e.message); }

    all.sort((a, b) => new Date(b.applied_at) - new Date(a.applied_at));

    const counts = {
      leave:          all.filter(x=>x.request_type==='leave').length,
      regularization: all.filter(x=>x.request_type==='regularization').length,
      od:             all.filter(x=>x.request_type==='od').length,
      wfh:            all.filter(x=>x.request_type==='wfh').length,
      advance:        all.filter(x=>x.request_type==='advance').length,
      reimbursement:  all.filter(x=>x.request_type==='reimbursement').length,
      total:          all.length
    };

    res.json({ success: true, counts, data: all });
  } catch (err) {
    console.error('[getPendingApprovals]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.bulkAction = async (req, res) => {
  try {
    const { action, remarks = '', items = [] } = req.body;
    if (!['approve','reject'].includes(action))
      return res.status(400).json({ success: false, message: 'action must be approve or reject' });
    if (!items.length)
      return res.status(400).json({ success: false, message: 'No items selected' });

    const userId = req.user.id;
    const status = action === 'approve' ? 'approved' : 'rejected';
    let succeeded = 0, failed = 0;

    for (const item of items) {
      try {
        if (item.type === 'leave') {
          await db.query(
            `UPDATE leave_requests SET status=$1, actioned_by=$2, actioned_at=NOW(), actioned_remarks=$3 WHERE id=$4 AND status='pending'`,
            [status, userId, remarks, item.id]);
          if (action === 'approve') {
            const lr = await db.query(`SELECT * FROM leave_requests WHERE id=$1`, [item.id]);
            if (lr.rows[0]) {
              const r = lr.rows[0];
              await db.query(
                `UPDATE leave_balances SET used=used+$1, pending=GREATEST(0,pending-$1)
                 WHERE employee_id=$2 AND leave_type_id=$3 AND year=EXTRACT(YEAR FROM $4::date)`,
                [r.days_requested, r.employee_id, r.leave_type_id, r.from_date]).catch(()=>{});
            }
          } else {
            await db.query(
              `UPDATE leave_balances SET pending=GREATEST(0,pending-(SELECT days_requested FROM leave_requests WHERE id=$1))
               WHERE employee_id=(SELECT employee_id FROM leave_requests WHERE id=$1)
                 AND leave_type_id=(SELECT leave_type_id FROM leave_requests WHERE id=$1)`,
              [item.id]).catch(()=>{});
          }
        } else if (item.type === 'regularization') {
          await db.query(
            `UPDATE attendance SET regularization_status=$1, regularization_actioned_by=$2,
             regularization_actioned_at=NOW(), regularization_remarks=$3,
             status=CASE WHEN $1='approved' THEN 'regularized' ELSE status END
             WHERE id=$4 AND regularization_status='pending'`,
            [status, userId, remarks, item.id]);
        } else if (item.type === 'od') {
          await db.query(
            `UPDATE od_requests SET status=$1, actioned_by=$2, action_at=NOW(), remarks=$3 WHERE id=$4 AND status='pending'`,
            [status, userId, remarks, item.id]);
        } else if (item.type === 'wfh') {
          await db.query(
            `UPDATE wfh_requests SET status=$1, actioned_by=$2, action_at=NOW(), remarks=$3 WHERE id=$4 AND status='pending'`,
            [status, userId, remarks, item.id]);
        } else if (item.type === 'advance') {
          await db.query(
            `UPDATE advance_salary SET status=$1 WHERE id=$2 AND status='pending'`,
            [status, item.id]);
        } else if (item.type === 'reimbursement') {
          await db.query(
            `UPDATE reimbursements SET status=$1 WHERE id=$2 AND status='pending'`,
            [status, item.id]);
        }
        succeeded++;
      } catch(e) {
        console.error(`bulkAction ${item.type}#${item.id}:`, e.message);
        failed++;
      }
    }

    res.json({ success: true, message: `${succeeded} ${action}d${failed ? `, ${failed} failed` : ''}`, succeeded, failed });
  } catch (err) {
    console.error('[bulkAction]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};
