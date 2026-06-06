// compoffController.js — Comp Off Credit & Usage Management
const db = require('../config/db');
const { getEmployeeRegion } = require('../config/regionHelper');

// ── Internal helper: check if a holiday date is valid for an employee's zone ──
// Returns { valid: true, holidayName } if the date is a zone-eligible holiday
// Returns { valid: false, reason } if the employee's zone doesn't get this holiday
async function validateHolidayForEmployee(client, empId, workedDate) {
  // Fetch employee city + state
  const empRes = await client.query(
    `SELECT city, state FROM employees WHERE id = $1`,
    [empId]
  );
  if (!empRes.rows.length) return { valid: false, reason: 'Employee not found' };

  const { city, state } = empRes.rows[0];
  const empRegion = getEmployeeRegion(city || '', state || '');

  // Check if the worked date is a holiday in the DB
  const holRes = await client.query(
    `SELECT name, region FROM holidays WHERE date = $1 LIMIT 1`,
    [workedDate]
  );

  // Not a holiday at all in DB → skip zone check (weekend compoff is fine)
  if (!holRes.rows.length) return { valid: true, holidayName: null, empRegion };

  const { name: holidayName, region: holRegion } = holRes.rows[0];

  // Holiday is for all zones → always valid
  if (holRegion === 'all') return { valid: true, holidayName, empRegion };

  // Zone-specific holiday → employee's region must match
  if (holRegion !== empRegion) {
    return {
      valid: false,
      reason: `"${holidayName}" is a ${holRegion} zone holiday. Employee is in ${empRegion} zone (${city || state || 'unknown location'}) and is not eligible.`
    };
  }

  return { valid: true, holidayName, empRegion };
}

// ── Grant comp off credit to an employee (HR/Admin only) ─────────────────────
exports.grantCredit = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { employee_id, worked_date, worked_type, holiday_name, days_credited, remarks, expiry_date } = req.body;

    if (!employee_id || !worked_date || !worked_type)
      return res.status(400).json({ success: false, message: 'employee_id, worked_date, worked_type required' });

    if (!['holiday', 'weekend'].includes(worked_type))
      return res.status(400).json({ success: false, message: 'worked_type must be holiday or weekend' });

    const days = parseFloat(days_credited) || 1;
    if (days <= 0 || days > 2)
      return res.status(400).json({ success: false, message: 'days_credited must be between 0.5 and 2' });

    // ── ZONE VALIDATION (only for holiday type) ───────────────────────────────
    if (worked_type === 'holiday') {
      const zoneCheck = await validateHolidayForEmployee(client, employee_id, worked_date);
      if (!zoneCheck.valid) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `Zone mismatch: ${zoneCheck.reason}` });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const exists = await client.query(
      `SELECT id FROM compoff_credits WHERE employee_id=$1 AND worked_date=$2`,
      [employee_id, worked_date]
    );
    if (exists.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Comp off already credited for this employee on this date' });
    }

    const result = await client.query(
      `INSERT INTO compoff_credits
         (employee_id, worked_date, worked_type, holiday_name, days_credited, granted_by, remarks, expiry_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [employee_id, worked_date, worked_type, holiday_name || null, days, req.user.id, remarks || null, expiry_date || null]
    );

    const compoffType = await client.query(`SELECT id FROM leave_types WHERE code='COMPOFF'`);
    if (compoffType.rows.length) {
      const ltId = compoffType.rows[0].id;
      const year = new Date(worked_date).getFullYear();
      await client.query(
        `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (employee_id, leave_type_id, year)
         DO UPDATE SET allocated = leave_balances.allocated + $4`,
        [employee_id, ltId, year, days]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: `Comp off of ${days} day(s) credited successfully`, data: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('grantCredit error:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};

// ── List comp off credits ─────────────────────────────────────────────────────
// PRIVACY RULE: Every user (including HR, admin, super_admin, accounts) can ONLY
// see their OWN comp-off records. No one can view another employee's records.
exports.listCredits = async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT cc.*,
              e.first_name, e.last_name, e.employee_code,
              g.first_name AS granted_by_name
       FROM compoff_credits cc
       JOIN employees e ON cc.employee_id = e.id
       LEFT JOIN employees g ON cc.granted_by = g.id
       WHERE cc.employee_id = $1
       ORDER BY cc.worked_date DESC
       LIMIT 200`,
      [req.user.id]
    );

    res.json({ success: true, data: rows.rows });
  } catch (err) {
    console.error('listCredits error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Get comp off balance ──────────────────────────────────────────────────────
// PRIVACY RULE: Every user (including HR, admin, super_admin, accounts) can ONLY
// see their OWN balance. Any employee_id query param is ignored.
exports.getBalance = async (req, res) => {
  try {
    const empId = req.user.id; // always self — query param ignored
    const year  = parseInt(req.query.year) || new Date().getFullYear();

    const balance = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status='available' THEN days_credited ELSE 0 END), 0) AS available,
         COALESCE(SUM(days_credited), 0) AS total_credited,
         COALESCE(SUM(CASE WHEN status='used' THEN days_credited ELSE 0 END), 0) AS used
       FROM compoff_credits
       WHERE employee_id=$1 AND EXTRACT(YEAR FROM worked_date)=$2`,
      [empId, year]
    );

    const credits = await db.query(
      `SELECT cc.*, g.first_name AS granted_by_name
       FROM compoff_credits cc
       LEFT JOIN employees g ON cc.granted_by = g.id
       WHERE cc.employee_id=$1 AND EXTRACT(YEAR FROM cc.worked_date)=$2
       ORDER BY cc.worked_date DESC`,
      [empId, year]
    );

    res.json({ success: true, data: { ...balance.rows[0], credits: credits.rows } });
  } catch (err) {
    console.error('getBalance error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Revoke a comp off credit (HR only, only if status=available) ─────────────
exports.revokeCredit = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;

    const credit = await client.query(`SELECT * FROM compoff_credits WHERE id=$1`, [id]);
    if (!credit.rows.length)
      return res.status(404).json({ success: false, message: 'Credit not found' });

    if (credit.rows[0].status !== 'available')
      return res.status(400).json({ success: false, message: 'Cannot revoke a used or expired credit' });

    const { employee_id, days_credited, worked_date } = credit.rows[0];

    await client.query(`DELETE FROM compoff_credits WHERE id=$1`, [id]);

    const compoffType = await client.query(`SELECT id FROM leave_types WHERE code='COMPOFF'`);
    if (compoffType.rows.length) {
      const ltId = compoffType.rows[0].id;
      const year = new Date(worked_date).getFullYear();
      await client.query(
        `UPDATE leave_balances
         SET allocated = GREATEST(0, allocated - $1)
         WHERE employee_id=$2 AND leave_type_id=$3 AND year=$4`,
        [days_credited, employee_id, ltId, year]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Comp off credit revoked' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('revokeCredit error:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};

// ── Bulk grant comp offs (HR/Admin only) ──────────────────────────────────────
exports.bulkGrant = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { employee_ids, worked_date, worked_type, holiday_name, days_credited, remarks, expiry_date } = req.body;

    if (!employee_ids?.length || !worked_date || !worked_type)
      return res.status(400).json({ success: false, message: 'employee_ids[], worked_date, worked_type required' });

    const days        = parseFloat(days_credited) || 1;
    const compoffType = await client.query(`SELECT id FROM leave_types WHERE code='COMPOFF'`);
    const ltId        = compoffType.rows[0]?.id;
    const year        = new Date(worked_date).getFullYear();

    let credited = 0, skipped = 0, zoneBlocked = 0;
    const zoneBlockedList = []; // track who was blocked and why

    for (const empId of employee_ids) {
      // ── ZONE VALIDATION (only for holiday type) ─────────────────────────────
      if (worked_type === 'holiday') {
        const zoneCheck = await validateHolidayForEmployee(client, empId, worked_date);
        if (!zoneCheck.valid) {
          console.log(`[COMPOFF BULK] emp ${empId} zone-blocked: ${zoneCheck.reason}`);
          zoneBlockedList.push({ employee_id: empId, reason: zoneCheck.reason });
          zoneBlocked++;
          continue; // skip this employee — wrong zone
        }
      }
      // ───────────────────────────────────────────────────────────────────────

      const exists = await client.query(
        `SELECT id FROM compoff_credits WHERE employee_id=$1 AND worked_date=$2`, [empId, worked_date]
      );
      if (exists.rows.length) { skipped++; continue; }

      await client.query(
        `INSERT INTO compoff_credits (employee_id, worked_date, worked_type, holiday_name, days_credited, granted_by, remarks, expiry_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [empId, worked_date, worked_type, holiday_name || null, days, req.user.id, remarks || null, expiry_date || null]
      );

      if (ltId) {
        await client.query(
          `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (employee_id, leave_type_id, year)
           DO UPDATE SET allocated = leave_balances.allocated + $4`,
          [empId, ltId, year, days]
        );
      }
      credited++;
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      message: `Credited ${credited} employee(s). Skipped ${skipped} (already credited). Zone-blocked ${zoneBlocked} (wrong zone for this holiday).`,
      zone_blocked: zoneBlockedList   // HR can see exactly who was blocked and why
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('bulkGrant error:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};

// ── Helper: is this Saturday the 2nd or 4th of the month? ────────────────────
function isOffSaturday(date) {
  const d = new Date(date);
  if (d.getDay() !== 6) return false;
  const weekNumber = Math.ceil(d.getDate() / 7);
  return weekNumber === 2 || weekNumber === 4;
}

// ── Auto-grant comp off for a given date (called by cron) ────────────────────
// Rules:
//   1. ONLY onsite employees (saturday_policy = '2nd_4th_off') get comp-off.
//      Offsite (saturday_policy = 'all_working') → NEVER, not even on Sunday.
//   2. Eligible days:
//      • All Sundays
//      • 2nd and 4th Saturday of the month
//      • Zone-specific public holiday (region = 'north' | 'south_west' | 'all')
//      1st/3rd/5th Saturdays and plain weekdays (non-holiday) → no comp-off.
//   3. Credit based on attendance status:
//      present / late / regularized / od → 1.0 day
//      half-day                          → 0.5 day
//      absent / other                    → 0 (no comp-off)
exports.autoGrantForDate = async (dateStr) => {
  const date           = new Date(dateStr);
  const day            = date.getDay(); // 0=Sun, 6=Sat
  const isSunday       = day === 0;
  const isSaturday     = day === 6;
  const isOff2nd4thSat = isSaturday && isOffSaturday(dateStr);

  // Fast-exit: 1st/3rd/5th Saturday
  if (isSaturday && !isOff2nd4thSat) {
    console.log(`[COMPOFF CRON] ${dateStr} is a working Saturday (1st/3rd/5th) — no grants`);
    return { granted: 0, skipped: 0 };
  }

  // Fast-exit: plain weekday with no holiday at all
  const isWeekday = !isSunday && !isSaturday;
  if (isWeekday) {
    const anyHoliday = await db.query(`SELECT 1 FROM holidays WHERE date=$1 LIMIT 1`, [dateStr]);
    if (!anyHoliday.rows.length) {
      console.log(`[COMPOFF CRON] ${dateStr} is a regular weekday — no grants`);
      return { granted: 0, skipped: 0 };
    }
  }

  // Fetch all ONSITE employees with an attendance record for this date
  const attendees = await db.query(
    `SELECT a.employee_id,
            COALESCE(a.status, 'absent') AS att_status,
            e.city, e.state
     FROM attendance a
     JOIN employees e ON a.employee_id = e.id
     WHERE a.date = $1
       AND e.is_active = true
       AND COALESCE(e.saturday_policy, '2nd_4th_off') = '2nd_4th_off'`,
    [dateStr]
  );

  if (!attendees.rows.length) {
    console.log(`[COMPOFF CRON] ${dateStr} — no eligible onsite attendees found`);
    return { granted: 0, skipped: 0 };
  }

  const compoffType = await db.query(`SELECT id FROM leave_types WHERE code='COMPOFF'`);
  const ltId        = compoffType.rows[0]?.id;
  const year        = date.getFullYear();
  const expiryDate  = new Date(date);
  expiryDate.setDate(expiryDate.getDate() + 30);

  let granted = 0, skipped = 0, ineligible = 0;

  for (const row of attendees.rows) {
    const empId     = row.employee_id;
    const attStatus = row.att_status;

    // Credit based on attendance status
    let daysToCredit = 0;
    let creditLabel  = '';
    if (['present', 'late', 'regularized', 'od'].includes(attStatus)) {
      daysToCredit = 1.00;
      creditLabel  = 'full day';
    } else if (attStatus === 'half-day') {
      daysToCredit = 0.50;
      creditLabel  = 'half day';
    } else {
      console.log(`[COMPOFF CRON] emp ${empId} status='${attStatus}' on ${dateStr} — no comp-off`);
      ineligible++;
      continue;
    }

    // Day eligibility per employee
    // Sunday / 2nd-4th Sat → eligible for all onsite
    // Weekday → must be a zone holiday for this specific employee
    let workedType  = 'weekend';
    let holidayName = null;

    if (!isSunday && !isOff2nd4thSat) {
      // ── Use regionHelper (single source of truth) instead of inline regex ──
      const empRegion = getEmployeeRegion(row.city || '', row.state || '');

      const holRes = await db.query(
        `SELECT name FROM holidays WHERE date=$1 AND (region='all' OR region=$2) LIMIT 1`,
        [dateStr, empRegion]
      );
      if (!holRes.rows.length) { ineligible++; continue; }
      workedType  = 'holiday';
      holidayName = holRes.rows[0].name;
    }

    // Idempotency guard
    const exists = await db.query(
      `SELECT id FROM compoff_credits WHERE employee_id=$1 AND worked_date=$2`,
      [empId, dateStr]
    );
    if (exists.rows.length) { skipped++; continue; }

    // Insert credit
    await db.query(
      `INSERT INTO compoff_credits
         (employee_id, worked_date, worked_type, holiday_name, days_credited, granted_by, expiry_date, remarks, status)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,'available')
       ON CONFLICT (employee_id, worked_date) DO NOTHING`,
      [
        empId, dateStr, workedType, holidayName, daysToCredit,
        expiryDate.toISOString().split('T')[0],
        `Auto-granted: ${attStatus} on ${workedType}${holidayName ? ' (' + holidayName + ')' : ''} = ${creditLabel}`
      ]
    );

    if (ltId) {
      await db.query(
        `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (employee_id, leave_type_id, year)
         DO UPDATE SET allocated = leave_balances.allocated + $4`,
        [empId, ltId, year, daysToCredit]
      );
    }

    granted++;
  }

  console.log(`[COMPOFF CRON] ${dateStr} — granted: ${granted}, skipped: ${skipped}, ineligible: ${ineligible}`);
  return { granted, skipped };
};

// ── Expire comp off credits past their expiry_date ────────────────────────────
exports.expireOldCredits = async () => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const expired = await db.query(
      `UPDATE compoff_credits
       SET status = 'expired'
       WHERE status = 'available'
         AND expiry_date IS NOT NULL
         AND expiry_date < $1
       RETURNING employee_id, days_credited, worked_date`,
      [today]
    );

    if (!expired.rows.length) {
      console.log('[COMPOFF CRON] No credits to expire today');
      return;
    }

    const compoffType = await db.query(`SELECT id FROM leave_types WHERE code='COMPOFF'`);
    const ltId = compoffType.rows[0]?.id;

    if (ltId) {
      for (const row of expired.rows) {
        const year = new Date(row.worked_date).getFullYear();
        await db.query(
          `UPDATE leave_balances
           SET allocated = GREATEST(0, allocated - $1)
           WHERE employee_id=$2 AND leave_type_id=$3 AND year=$4`,
          [row.days_credited, row.employee_id, ltId, year]
        );
      }
    }

    console.log(`[COMPOFF CRON] Expired ${expired.rows.length} credit(s)`);
  } catch (err) {
    console.error('[COMPOFF CRON] expireOldCredits error:', err.message);
  }
};
