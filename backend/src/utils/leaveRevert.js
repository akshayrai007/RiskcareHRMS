// Refunds 1 leave day when the employee actually worked a day covered by an
// approved FULL-day leave. Idempotent: leave_day_reverts (unique per request+date)
// plus the legacy "worked on YYYY-MM-DD" remarks marker.
const db = require('../config/db');

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db.query(`CREATE TABLE IF NOT EXISTS leave_day_reverts (
    id SERIAL PRIMARY KEY,
    leave_request_id INT NOT NULL,
    employee_id INT NOT NULL,
    work_date DATE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(leave_request_id, work_date)
  )`);
  tableReady = true;
}

const ds = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));

async function revertWorkedLeaveDay(empId, date) {
  await ensureTable();
  const dateStr = ds(date);
  const d = new Date(dateStr + 'T00:00:00');
  if (d.getDay() === 0) return false;                                           // Sunday
  if (d.getDay() === 6 && [2, 4].includes(Math.ceil(d.getDate() / 7))) return false; // 2nd/4th Saturday
  if ((await db.query(`SELECT 1 FROM holidays WHERE date=$1 LIMIT 1`, [dateStr])).rows.length) return false;

  const att = (await db.query(
    `SELECT status, punch_out FROM attendance WHERE employee_id=$1 AND date=$2`, [empId, dateStr])).rows[0];
  // Worked = present/late WITH a punch-out, or regularized / wfh / missing_punch_out
  const worked = att && ((['present', 'late'].includes(att.status) && att.punch_out) ||
                         ['regularized', 'wfh', 'missing_punch_out'].includes(att.status));
  if (!worked) return false;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const lr = (await client.query(
      `SELECT lr.id, lr.leave_type_id, lr.days_requested, lr.remarks, lt.code AS lt_code
       FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
       WHERE lr.employee_id=$1 AND lr.status='approved' AND COALESCE(lr.is_half_day,false)=false
         AND $2::date BETWEEN lr.from_date AND lr.to_date
       LIMIT 1 FOR UPDATE OF lr`, [empId, dateStr])).rows[0];
    if (!lr || ['LWP', 'OD'].includes(lr.lt_code) || (lr.remarks || '').includes(`worked on ${dateStr}`) ||
        parseFloat(lr.days_requested) < 1) { await client.query('ROLLBACK'); return false; }

    const ins = await client.query(
      `INSERT INTO leave_day_reverts(leave_request_id, employee_id, work_date) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING id`, [lr.id, empId, dateStr]);
    if (!ins.rowCount) { await client.query('ROLLBACK'); return false; }

    const newDays = Math.max(0, parseFloat(lr.days_requested) - 1);
    await client.query(
      `UPDATE leave_balances SET used = GREATEST(0, used - 1)
       WHERE employee_id=$1 AND leave_type_id=$2 AND year=EXTRACT(YEAR FROM $3::date)`,
      [empId, lr.leave_type_id, dateStr]);
    await client.query(
      `UPDATE leave_requests SET days_requested=$1,
         status = CASE WHEN $1 = 0 THEN 'cancelled' ELSE status END,
         remarks = COALESCE(remarks,'') || $2 WHERE id=$3`,
      [newDays, newDays === 0 ? ` [Auto-cancelled: employee worked all days]` : ` [1 day auto-reverted: worked on ${dateStr}]`, lr.id]);
    await client.query(
      `INSERT INTO notifications(employee_id, type, title, message) VALUES ($1,'leave',$2,$3)`,
      [empId, '✅ Leave Day Reverted', `1 ${lr.lt_code} day credited back — you worked on ${dateStr}. Remaining: ${newDays} day(s).`]);
    await client.query('COMMIT');
    require('../config/pushService').sendPush(empId, '✅ Leave Day Reverted',
      `1 ${lr.lt_code} day credited back — you worked on ${dateStr}.`, { channel: 'riskcare_general' });
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

// Nightly re-check of the last N days for every employee with a matching worked day.
async function revertRecent(days = 10) {
  const rows = (await db.query(
    `SELECT DISTINCT a.employee_id, a.date FROM attendance a
     WHERE a.date >= CURRENT_DATE - $1::int
       AND ((a.status IN ('present','late') AND a.punch_out IS NOT NULL) OR a.status IN ('regularized','wfh','missing_punch_out'))
       AND EXISTS (SELECT 1 FROM leave_requests lr WHERE lr.employee_id=a.employee_id AND lr.status='approved'
                   AND COALESCE(lr.is_half_day,false)=false AND a.date BETWEEN lr.from_date AND lr.to_date)`, [days])).rows;
  let n = 0;
  for (const r of rows) { try { if (await revertWorkedLeaveDay(r.employee_id, r.date)) n++; } catch (e) { console.error('[revertRecent]', e.message); } }
  return n;
}

module.exports = { revertWorkedLeaveDay, revertRecent };
