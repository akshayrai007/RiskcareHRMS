const CONFIG = require('../Main_file');
// src/controllers/attendanceController.js
const db = require('../config/db');
const { getEmployeeRegion } = require('../config/regionHelper');
const emailSvc = require('../config/emailService');
const { validateEmployeeBuffer } = require('./geofenceController');

// ── IST Helpers (UTC+5:30) ────────────────────────────────────────────────────
// Always use IST regardless of server timezone (Render runs UTC)
function getISTDate() {
  const now = new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone || 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now); // returns "YYYY-MM-DD"
}

function getISTTimeParts() {
  const now = new Date();
  const parts = {};
  new Intl.DateTimeFormat('en-IN', {
    timeZone: CONFIG.timezone || 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(now).forEach(({ type, value }) => { parts[type] = value; });
  return {
    hour:    parseInt(parts.hour),
    minute:  parseInt(parts.minute),
    timeStr: `${parts.hour}:${parts.minute}:${parts.second}` // "HH:MM:SS"
  };
}

function toLocalDateString(date) {
  // Keep for backward compat — but use IST
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone || 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(date));
}

// ── Punch In ──────────────────────────────────────────────────────────────────
exports.punchIn = async (req, res) => {
  try {
    const empId  = req.user.id;
    const today  = req.body.punch_date || getISTDate(); // FIX: use IST date
    const now    = new Date();
    const { location_lat, location_lng, punch_in_location } = req.body;

    // Check already punched in today
    const existing = await db.query(
      `SELECT * FROM attendance WHERE employee_id=$1 AND date=$2`,
      [empId, today]
    );
    if (existing.rows.length && existing.rows[0].punch_in)
      return res.status(400).json({ success: false, message: 'Already punched in today' });

    // ── Geo-boundary validation ───────────────────────────────────────────────
    const geoCheck = await validateEmployeeBuffer(empId, location_lat, location_lng);
    if (!geoCheck.valid) {
      return res.status(403).json({
        success: false,
        outside_boundary: true,
        message: geoCheck.message
      });
    }

    // ── FIX: Use IST time — Render server runs on UTC ─────────────────────────
    const ist = getISTTimeParts();
    const isLate = ist.hour > 10 || (ist.hour === 10 && ist.minute > 30);
    const status = isLate ? 'late' : 'present';

    const locStr = punch_in_location ||
      (location_lat && location_lng ? `GPS: ${parseFloat(location_lat).toFixed(4)},${parseFloat(location_lng).toFixed(4)}` : 'Manual');

    // Use punch_time from frontend if provided, otherwise use server IST time
    const punchInTime = req.body.punch_time || ist.timeStr; // "HH:MM:SS"

    if (existing.rows.length) {
      await db.query(
        `UPDATE attendance SET punch_in=$1, punch_in_location=$2, status=$3, location_lat=$4, location_lng=$5
         WHERE employee_id=$6 AND date=$7`,
        [punchInTime, locStr, status, location_lat||null, location_lng||null, empId, today]
      );
    } else {
      await db.query(
        `INSERT INTO attendance(employee_id, date, punch_in, punch_in_location, status, location_lat, location_lng)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [empId, today, punchInTime, locStr, status, location_lat||null, location_lng||null]
      );
    }

    res.json({ success: true, message: `Punched in at ${punchInTime.slice(0,5)}${isLate?' (Late)':''}` });
  } catch (err) {
    console.error('[PunchIn Error]', err.message, err.code);
    // Return specific DB errors to help debug
    const msg = err.code === 'ECONNREFUSED' ? 'Database connection failed - please retry'
              : err.code === '23505'        ? 'Already punched in today'
              : err.code === '23503'        ? 'Employee not found'
              : 'Server error: ' + (err.message || 'Unknown');
    res.status(500).json({ success: false, message: msg });
  }
};

// ── Punch Out ─────────────────────────────────────────────────────────────────
exports.punchOut = async (req, res) => {
  try {
    const empId = req.user.id;
    const today = req.body.punch_date || getISTDate(); // FIX: use IST date
    const { location_lat, location_lng, punch_out_location } = req.body;

    const existing = await db.query(
      `SELECT * FROM attendance WHERE employee_id=$1 AND date=$2`,
      [empId, today]
    );
    if (!existing.rows.length || !existing.rows[0].punch_in)
      return res.status(400).json({ success: false, message: 'No punch-in found for today' });
    if (existing.rows[0].punch_out)
      return res.status(400).json({ success: false, message: 'Already punched out today' });

    // ── Geo-boundary validation ───────────────────────────────────────────────
    const geoCheck = await validateEmployeeBuffer(empId, location_lat, location_lng);
    if (!geoCheck.valid) {
      return res.status(403).json({
        success: false,
        outside_boundary: true,
        message: geoCheck.message
      });
    }

    // ── FIX: Validate punch_time from frontend — reject stale/UTC times ────────
    // When Render sleeps and wakes, frontend queued requests may fire with old UTC time.
    // We trust frontend punch_time ONLY if it is >= punch_in time AND <= current IST time + 5min buffer.
    // Otherwise we use server IST time.
    const serverISTTime = getISTTimeParts().timeStr;
    let punchOutTime = serverISTTime; // default: always use server IST

    if (req.body.punch_time) {
      const proposed = req.body.punch_time; // e.g. "14:08:00" from frontend
      const [pH, pM] = proposed.slice(0, 5).split(':').map(Number);
      const punchInStr = existing.rows[0].punch_in;
      const [iH, iM] = punchInStr.slice(0, 5).split(':').map(Number);
      const serverIST = getISTTimeParts();
      const proposedMins = pH * 60 + pM;
      const punchInMins  = iH * 60 + iM;
      const serverMins   = serverIST.hour * 60 + serverIST.minute;

      // Accept frontend time only if: after punch-in AND not more than 5 min in the future
      const isAfterPunchIn = proposedMins > punchInMins;
      const isNotFuture    = proposedMins <= serverMins + 5;
      if (isAfterPunchIn && isNotFuture) {
        punchOutTime = proposed;
      } else {
        console.warn(`[PunchOut] Rejected stale frontend time ${proposed} (server IST: ${serverISTTime}, punch-in: ${punchInStr}) — using server time`);
      }
    }
    const punchInStr = existing.rows[0].punch_in; // e.g. "09:40:00" or "09:40"

    const [inH,  inM]  = punchInStr.slice(0, 5).split(':').map(Number);
    const [outH, outM] = punchOutTime.slice(0, 5).split(':').map(Number);
    const inMins  = inH  * 60 + inM;
    const outMins = outH * 60 + outM;
    const hoursWorked = Math.max(0, (outMins - inMins) / 60);

    // Determine final status based on hours worked
    // Present  = 7h+   (or punched in ≤10:30 AND punched out ≥18:30)
    // Half-day = >3h31m and <7h
    // Absent   = ≤3h30m
    const [outHH, outMM] = punchOutTime.slice(0, 5).split(':').map(Number);
    const punchOutTotalMins = outHH * 60 + outMM;
    const onTimeIn  = inMins  <= (10 * 60 + 30);  // punch-in at or before 10:30
    const onTimeOut = punchOutTotalMins >= (18 * 60 + 30); // punch-out at or after 18:30

    let status = existing.rows[0].status;
    if (onTimeIn && onTimeOut) {
      // Punched in ≤10:30 and out ≥18:30 → always Present (not half-day)
      status = 'present';
    } else if (hoursWorked >= 7) {
      status = status === 'late' ? 'late' : 'present';
    } else if (hoursWorked > 3.5) {
      status = 'half-day';
    } else {
      status = 'absent';
    }

    const locStr = punch_out_location ||
      (location_lat && location_lng ? `GPS: ${parseFloat(location_lat).toFixed(4)},${parseFloat(location_lng).toFixed(4)}` : 'Manual');

    // FIX: Use IST time (already computed above as punchOutTime)

    // Update attendance record
    await db.query(
      `UPDATE attendance SET punch_out=$1, punch_out_location=$2, working_hours=$3, status=$4,
       location_lat_out=$5, location_lng_out=$6
       WHERE employee_id=$7 AND date=$8`,
      [punchOutTime, locStr, hoursWorked.toFixed(2), status,
       location_lat||null, location_lng||null, empId, today]
    );

    // ── Leave Revert Logic ────────────────────────────────────────────────────
    // If today has an approved leave request AND employee completed required hours → credit 1 day back
    // NOTE: We check the leave_requests table directly (not prevStatus) because punchIn sets
    // status = 'present'/'late' immediately — prevStatus will never be 'on-leave' at punch-out time.
    const isNowPresent = ['present', 'late'].includes(status);

    if (isNowPresent) {
      try {
        const leaveRes = await db.query(
          `SELECT lr.id, lr.leave_type_id, lr.days_requested, lt.code AS lt_code
           FROM leave_requests lr
           JOIN leave_types lt ON lr.leave_type_id = lt.id
           WHERE lr.employee_id = $1
             AND lr.status = 'approved'
             AND $2::date BETWEEN lr.from_date AND lr.to_date
           LIMIT 1`,
          [empId, today]
        );

        if (leaveRes.rows.length) {
          const leave = leaveRes.rows[0];
          if (!['LWP', 'OD'].includes(leave.lt_code)) {
            const leaveYear = new Date(today).getFullYear();
            const newDays = Math.max(0, parseFloat(leave.days_requested) - 1);

            // Credit 1 day back to leave balance
            await db.query(
              `UPDATE leave_balances SET used = GREATEST(0, used - 1)
               WHERE employee_id=$1 AND leave_type_id=$2 AND year=$3`,
              [empId, leave.leave_type_id, leaveYear]
            );

            // Update leave request days
            await db.query(
              `UPDATE leave_requests SET days_requested=$1,
               status = CASE WHEN $1 = 0 THEN 'cancelled' ELSE status END,
               remarks = COALESCE(remarks,'') || $2
               WHERE id=$3`,
              [newDays,
               newDays === 0 ? ' [Auto-cancelled: employee worked all days]' : ` [1 day auto-reverted: worked on ${today}]`,
               leave.id]
            );

            // Notify employee (no expires_at column in this table)
            await db.query(
              `INSERT INTO notifications(employee_id, type, title, message)
               VALUES($1,'leave',$2,$3)`,
              [empId,
               '✅ Leave Day Reverted',
               `1 ${leave.lt_code} day credited back — you worked on ${today}. Remaining: ${newDays} day(s).`]
            );
          }
        }
      } catch (leaveErr) {
        // Leave revert failed — don't block punch-out, just log
        console.error('[LeaveRevert Error]', leaveErr.message);
      }
    }

    // ── Auto Comp Off Grant ──────────────────────────────────────────────────
    // Rules:
    //  1. ONLY onsite employees (saturday_policy = '2nd_4th_off') get comp-off.
    //     Offsite (saturday_policy = 'all_working') → NEVER, not even on Sunday.
    //  2. Eligible days: All Sundays | 2nd & 4th Saturday | zone-specific holiday.
    //     1st/3rd/5th Saturdays and plain weekdays → NOT eligible.
    //  3. Credit based on attendance status:
    //     present / late → 1.0 day  |  half-day → 0.5 day  |  absent → 0
    try {
      const empTypeRes = await db.query(
        `SELECT saturday_policy, city, state FROM employees WHERE id=$1`, [empId]
      );
      const empRec           = empTypeRes.rows[0];
      const isOffsiteEmployee = (empRec?.saturday_policy || '2nd_4th_off') === 'all_working';

      if (!isOffsiteEmployee) {
        const todayDate  = new Date(today);
        const dayOfWeek  = todayDate.getDay(); // 0=Sun, 6=Sat
        const isSunday   = dayOfWeek === 0;
        const isSaturday = dayOfWeek === 6;
        const isOff2nd4thSat = isSaturday && (() => {
          const weekNumber = Math.ceil(todayDate.getDate() / 7);
          return weekNumber === 2 || weekNumber === 4;
        })();

        // Skip 1st/3rd/5th Saturdays
        if (isSaturday && !isOff2nd4thSat) {
          // not eligible — do nothing
        } else {
          // Zone-specific holiday check (only needed for non-Sunday, non-2nd/4th-Sat days)
          let isHoliday   = false;
          let holidayName = null;

          if (!isSunday && !isOff2nd4thSat) {
            const empCity   = (empRec?.city  || '').toLowerCase();
            const empState  = (empRec?.state || '').toLowerCase();
            const northPat  = /delhi|up |uttar pradesh|uttarakhand|haryana|punjab|rajasthan|bihar|madhya pradesh|\bmp\b|himachal|jammu|kashmir|jharkhand|chhattisgarh|west bengal|bengal|assam|odisha|chandigarh/;
            const empRegion = northPat.test(`${empCity} ${empState}`) ? 'north' : 'south_west';

            const holRes = await db.query(
              `SELECT name FROM holidays WHERE date=$1 AND (region='all' OR region=$2) LIMIT 1`,
              [today, empRegion]
            );
            isHoliday   = holRes.rows.length > 0;
            holidayName = holRes.rows[0]?.name || null;
          }

          // Eligible: Sunday always | 2nd/4th Sat always | weekday only if zone holiday
          const isEligibleDay = isSunday || isOff2nd4thSat || isHoliday;

          if (isEligibleDay) {
            // Credit based on attendance status
            let daysToGrant = 0;
            let creditLabel = '';
            if (['present', 'late', 'regularized', 'od'].includes(status)) {
              daysToGrant = 1.00;
              creditLabel = '1 full day';
            } else if (status === 'half-day') {
              daysToGrant = 0.50;
              creditLabel = '0.5 day (half day)';
            }
            // absent → daysToGrant stays 0

            if (daysToGrant > 0) {
              const workedType = isHoliday ? 'holiday' : 'weekend';

              const alreadyCredited = await db.query(
                `SELECT id FROM compoff_credits WHERE employee_id=$1 AND worked_date=$2`,
                [empId, today]
              );

              if (!alreadyCredited.rows.length) {
                const compoffType = await db.query(
                  `SELECT id FROM leave_types WHERE code='COMPOFF' LIMIT 1`
                );

                if (compoffType.rows.length) {
                  const ltId = compoffType.rows[0].id;
                  const year = todayDate.getFullYear();

                  await db.query(
                    `INSERT INTO compoff_credits
                       (employee_id, worked_date, worked_type, holiday_name, days_credited, granted_by, remarks, status)
                     VALUES ($1,$2,$3,$4,$5,NULL,$6,'available')
                     ON CONFLICT (employee_id, worked_date) DO NOTHING`,
                    [empId, today, workedType, holidayName, daysToGrant,
                     `Auto-granted: ${status} on ${workedType}${holidayName ? ' (' + holidayName + ')' : ''} = ${creditLabel}`]
                  );

                  await db.query(
                    `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated)
                     VALUES ($1,$2,$3,$4)
                     ON CONFLICT (employee_id, leave_type_id, year)
                     DO UPDATE SET allocated = leave_balances.allocated + $4`,
                    [empId, ltId, year, daysToGrant]
                  );

                  const occasion = isSunday
                    ? `Sunday (${today})`
                    : isHoliday
                      ? `${holidayName} (${today})`
                      : `2nd/4th Saturday (${today})`;

                  await db.query(
                    `INSERT INTO notifications(employee_id, type, title, message)
                     VALUES($1,'leave',$2,$3)`,
                    [empId,
                     '🔄 Comp Off Credited!',
                     `${creditLabel} Comp Off auto-credited for working on ${occasion}. Apply it as leave anytime.`]
                  );
                }
              }
            }
          }
        }
      }
    } catch (compoffErr) {
      // Non-blocking — punch-out succeeds regardless
      console.error('[AutoCompOff Error]', compoffErr.message);
    }

    res.json({ success: true, message: `Punched out at ${punchOutTime.slice(0,5)} · ${hoursWorked.toFixed(1)}h worked` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get Attendance (calendar view) ───────────────────────────────────────────
exports.get = async (req, res) => {
  try {
    const empId = req.user.id;
    const role  = req.user.role;
    const { month, year, employee_id } = req.query;

    const mon = parseInt(month) || new Date().getMonth() + 1;
    const yr  = parseInt(year)  || new Date().getFullYear();

    // HR/Admin/Manager can query other employees
    let targetId = empId;
    if (employee_id && ['admin','super_admin','hr','accounts','manager','tl'].includes(role))
      targetId = parseInt(employee_id);

    const result = await db.query(
      `SELECT a.*,
              TO_CHAR(a.date,'YYYY-MM-DD') AS date_str,
              TO_CHAR(a.punch_in,'HH12:MI AM') AS punch_in_time,
              TO_CHAR(a.punch_out,'HH12:MI AM') AS punch_out_time
       FROM attendance a
       WHERE a.employee_id=$1
         AND EXTRACT(MONTH FROM a.date)=$2
         AND EXTRACT(YEAR  FROM a.date)=$3
       ORDER BY a.date`,
      [targetId, mon, yr]
    );

    // Also get holidays for the month — filtered by employee region
    // WFH employees fall back to their manager's region
    const empLoc = await db.query(
      `SELECT e.city, e.state, m.city AS mgr_city, m.state AS mgr_state
       FROM employees e LEFT JOIN employees m ON e.reporting_manager_id=m.id
       WHERE e.id=$1`, [targetId]
    );
    const el = empLoc.rows[0];
    const isWFH2 = (el?.city||'').toLowerCase().includes('work from home') ||
                   (!(el?.city||'').trim() && !(el?.state||'').trim());
    const region2 = isWFH2
      ? getEmployeeRegion(el?.mgr_city||'', el?.mgr_state||'')
      : getEmployeeRegion(el?.city, el?.state);
    const holidays = await db.query(
      `SELECT TO_CHAR(date,'YYYY-MM-DD') AS date, name, type, region
       FROM holidays
       WHERE EXTRACT(MONTH FROM date)=$1 AND EXTRACT(YEAR FROM date)=$2
         AND (region='all' OR region=$3)`,
      [mon, yr, region2]
    );

    res.json({
      success: true,
      data: result.rows,
      holidays: holidays.rows,
      month: mon, year: yr
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get Summary (monthly stats) ───────────────────────────────────────────────
exports.getSummary = async (req, res) => {
  try {
    const empId = req.user.id;
    const { month, year, employee_id } = req.query;
    const role = req.user.role;

    const mon = parseInt(month) || new Date().getMonth() + 1;
    const yr  = parseInt(year)  || new Date().getFullYear();

    let targetId = empId;
    if (employee_id && ['admin','super_admin','hr','accounts','manager','tl'].includes(role))
      targetId = parseInt(employee_id);

    // Get holidays for the month — filtered by employee region
    // WFH employees fall back to their manager's region
    const empLocInfo = await db.query(
      `SELECT e.city, e.state, m.city AS mgr_city, m.state AS mgr_state
       FROM employees e LEFT JOIN employees m ON e.reporting_manager_id=m.id
       WHERE e.id=$1`, [targetId]
    );
    const eli = empLocInfo.rows[0];
    const isWFHemp = (eli?.city||'').toLowerCase().includes('work from home') ||
                     (!(eli?.city||'').trim() && !(eli?.state||'').trim());
    const empReg = isWFHemp
      ? getEmployeeRegion(eli?.mgr_city||'', eli?.mgr_state||'')
      : getEmployeeRegion(eli?.city, eli?.state);

    const holResult = await db.query(
      `SELECT TO_CHAR(date,'YYYY-MM-DD') AS date FROM holidays
       WHERE EXTRACT(MONTH FROM date)=$1 AND EXTRACT(YEAR FROM date)=$2
         AND (region='all' OR region=$3)`,
      [mon, yr, empReg]
    );
    const holidayDates = holResult.rows.map(h => h.date);
    const holidayCount = holidayDates.length;

    // Count off-Saturdays based on employee's saturday_policy
    // 'all_working'  → no Saturdays are holidays
    // '2nd_4th_off'  → 2nd and 4th Saturdays are holidays
    const satPolicy = eli?.saturday_policy || '2nd_4th_off';
    let satHolidays = 0;
    const daysInMonth = new Date(yr, mon, 0).getDate();
    let satCount = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(yr, mon - 1, d).getDay();
      if (dow === 6) {
        satCount++;
        if (satPolicy === '2nd_4th_off' && (satCount === 2 || satCount === 4)) {
          const ds = `${yr}-${String(mon).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          if (!holidayDates.includes(ds)) satHolidays++;
        }
        // 'all_working': satHolidays stays 0 — every Saturday is a working day
      }
    }
    const totalHolidays = holidayCount + satHolidays;

    const result = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('present','late'))        AS present,
         COUNT(*) FILTER (WHERE status IN ('absent','missing_punch_out')
           AND date NOT IN (
             SELECT date FROM holidays
             WHERE EXTRACT(MONTH FROM date)=$2 AND EXTRACT(YEAR FROM date)=$3
               AND (region='all' OR region=$4)
           ))                                                        AS absent,
         COUNT(*) FILTER (WHERE status = 'half-day')                 AS half_day,
         COUNT(*) FILTER (WHERE status = 'late')                     AS late,
         COUNT(*) FILTER (WHERE status = 'on-leave')                 AS on_leave,
         COUNT(*) FILTER (WHERE status = 'lwp')                      AS lwp,
         COUNT(*) FILTER (WHERE punch_in_location ILIKE '%Work from Home%') AS wfh,
         COALESCE(SUM(working_hours), 0)                             AS total_hours,
         -- Average only days where employee actually worked (present/late/wfh/od) with hours recorded
         -- Leaves, holidays, absents excluded from average
         COALESCE(AVG(working_hours) FILTER (
           WHERE working_hours > 0
             AND status IN ('present','late','regularized','od')
         ), 0)                                                        AS avg_hours,
         COUNT(*) FILTER (
           WHERE working_hours > 0
             AND status IN ('present','late','regularized','od')
         )                                                            AS worked_days_with_hours
       FROM attendance
       WHERE employee_id=$1
         AND EXTRACT(MONTH FROM date)=$2
         AND EXTRACT(YEAR  FROM date)=$3`,
      [targetId, mon, yr, empReg]
    );

    res.json({
      success: true,
      data: { ...result.rows[0], holidays: totalHolidays },
      month: mon, year: yr
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get Team Today ────────────────────────────────────────────────────────────
exports.getTeamToday = async (req, res) => {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    // Use date from query param if provided, otherwise use today IST
    const today  = req.query.date || toLocalDateString(new Date());

    let empCond = '';
    let params  = [today];

    if (role === 'super_admin') {
      // MD sees everyone except themselves
      empCond = `AND e.id != $2`;
      params.push(userId);

    } else if (role === 'hr' || role === 'accounts') {
      // HR/Accounts see all employees except super_admin and themselves
      empCond = `AND e.role != 'super_admin' AND e.id != $2`;
      params.push(userId);

    } else if (role === 'admin') {
      // Check if this admin reports directly to a super_admin (i.e. is COO level)
      // If yes → see all employees (like Gurudutt/COO)
      // If no  → see only direct reports (like Akshay, Raj, Dushyant)
      const mgrCheck = await db.query(
        `SELECT m.role FROM employees e
         LEFT JOIN employees m ON e.reporting_manager_id = m.id
         WHERE e.id = $1`, [userId]
      );
      const managerRole = mgrCheck.rows[0]?.role;
      if (managerRole === 'super_admin') {
        // COO-level admin — sees everyone except super_admin and self
        empCond = `AND e.role != 'super_admin' AND e.id != $2`;
        params.push(userId);
      } else {
        // AVP/Manager-level admin — sees only direct reports, exclude self
        empCond = `AND e.reporting_manager_id = $2 AND e.id != $2`;
        params.push(userId);
      }

    } else if (role === 'manager' || role === 'tl') {
      // Direct reports only, exclude self
      empCond = `AND e.reporting_manager_id = $2 AND e.id != $2`;
      params.push(userId);

    } else {
      // Employee sees only themselves
      empCond = `AND e.id = $2`;
      params.push(userId);
    }

    const result = await db.query(
      `SELECT e.id AS employee_id, e.employee_code,
              CONCAT(e.first_name,' ',e.last_name) AS employee_name,
              d.name AS department_name,
              des.title AS designation_title,
              -- Determine employee's region for holiday check
              CASE
                WHEN LOWER(COALESCE(e.city,'')) LIKE '%work from home%'
                  OR LOWER(COALESCE(e.city,'')) LIKE '%wfh%'
                  THEN COALESCE(
                    (SELECT CASE
                      WHEN LOWER(COALESCE(m.city,'') || ' ' || COALESCE(m.state,'')) ~
                           '(delhi|up |uttar pradesh|uttarakhand|haryana|punjab|rajasthan|bihar|madhya pradesh|\\bmp\\b|himachal|jammu|kashmir|jharkhand|chhattisgarh|west bengal|bengal|assam|odisha|chandigarh)'
                      THEN 'north' ELSE 'south_west' END
                     FROM employees m WHERE m.id = e.reporting_manager_id), 'south_west')
                WHEN LOWER(COALESCE(e.city,'') || ' ' || COALESCE(e.state,'')) ~
                     '(delhi|up |uttar pradesh|uttarakhand|haryana|punjab|rajasthan|bihar|madhya pradesh|\\bmp\\b|himachal|jammu|kashmir|jharkhand|chhattisgarh|west bengal|bengal|assam|odisha|chandigarh)'
                THEN 'north'
                ELSE 'south_west'
              END AS emp_region,
              -- Holiday name for this date for this employee's region
              (SELECT h.name FROM holidays h
               WHERE h.date = $1::date
                 AND (h.region = 'all' OR h.region = CASE
                   WHEN LOWER(COALESCE(e.city,'') || ' ' || COALESCE(e.state,'')) ~
                        '(delhi|up |uttar pradesh|uttarakhand|haryana|punjab|rajasthan|bihar|madhya pradesh|\\bmp\\b|himachal|jammu|kashmir|jharkhand|chhattisgarh|west bengal|bengal|assam|odisha|chandigarh)'
                   THEN 'north' ELSE 'south_west' END)
               LIMIT 1) AS holiday_name,
              -- Final status: attendance → approved WFH → holiday → absent
              CASE
                WHEN a.status IN ('present','late')
                      AND a.punch_in IS NOT NULL
                      AND a.punch_out IS NULL
                      AND a.date = (CURRENT_TIMESTAMP AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}')::date
                      AND EXTRACT(HOUR FROM CURRENT_TIMESTAMP AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}') >= 21
                 THEN 'missing_punch_out'
                WHEN a.status IS NOT NULL THEN a.status
                WHEN EXISTS (
                  SELECT 1 FROM wfh_requests w
                  WHERE w.employee_id = e.id
                    AND w.status = 'approved'
                    AND $1::date BETWEEN w.from_date AND COALESCE(w.to_date, w.from_date)
                ) THEN 'wfh'
                WHEN EXISTS (
                  SELECT 1 FROM holidays h
                  WHERE h.date = $1::date
                    AND (h.region = 'all' OR h.region = CASE
                      WHEN LOWER(COALESCE(e.city,'') || ' ' || COALESCE(e.state,'')) ~
                           '(delhi|up |uttar pradesh|uttarakhand|haryana|punjab|rajasthan|bihar|madhya pradesh|\\bmp\\b|himachal|jammu|kashmir|jharkhand|chhattisgarh|west bengal|bengal|assam|odisha|chandigarh)'
                      THEN 'north' ELSE 'south_west' END)
                ) THEN 'holiday'
                ELSE 'absent'
              END AS status,
              a.punch_in, a.punch_out, a.working_hours,
              a.punch_in_location
       FROM employees e
       LEFT JOIN attendance a ON a.employee_id=e.id AND a.date=$1
       LEFT JOIN designations des ON e.designation_id=des.id
       LEFT JOIN departments d ON e.department_id=d.id
       WHERE e.is_active=true ${empCond}
       ORDER BY
         CASE
           WHEN a.status IS NOT NULL THEN
             CASE a.status
               WHEN 'present'           THEN 1
               WHEN 'late'              THEN 2
               WHEN 'half-day'          THEN 3
               WHEN 'on-leave'          THEN 4
               WHEN 'od'                THEN 5
               WHEN 'wfh'               THEN 6
               WHEN 'missing_punch_out' THEN 7
               ELSE 8
             END
           WHEN EXISTS (
             SELECT 1 FROM holidays h WHERE h.date=$1::date
               AND (h.region='all' OR h.region=CASE
                 WHEN LOWER(COALESCE(e.city,'')||' '||COALESCE(e.state,''))~
                      '(delhi|up |uttar pradesh|uttarakhand|haryana|punjab|rajasthan|bihar|madhya pradesh|\\bmp\\b|himachal|jammu|kashmir|jharkhand|chhattisgarh|west bengal|bengal|assam|odisha|chandigarh)'
                 THEN 'north' ELSE 'south_west' END)
           ) THEN 9
           ELSE 8
         END,
         a.punch_in ASC NULLS LAST,
         e.first_name ASC`,
      params
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get Punch Locations ───────────────────────────────────────────────────────
exports.getPunchLocations = async (req, res) => {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    const date   = req.query.date || toLocalDateString(new Date());

    // ── Scope: mirror getTeamToday role logic exactly ─────────────────────
    let empCond = '';
    const params = [date];

    if (role === 'super_admin') {
      empCond = `AND e.id != $2`;
      params.push(userId);

    } else if (role === 'hr' || role === 'accounts') {
      empCond = `AND e.role != 'super_admin' AND e.id != $2`;
      params.push(userId);

    } else if (role === 'admin') {
      // COO-level admin (reports to super_admin) sees everyone; AVP/manager-level sees only direct reports
      const mgrCheck = await db.query(
        `SELECT m.role FROM employees e
         LEFT JOIN employees m ON e.reporting_manager_id = m.id
         WHERE e.id = $1`, [userId]
      );
      const managerRole = mgrCheck.rows[0]?.role;
      if (managerRole === 'super_admin') {
        empCond = `AND e.role != 'super_admin' AND e.id != $2`;
      } else {
        empCond = `AND e.reporting_manager_id = $2 AND e.id != $2`;
      }
      params.push(userId);

    } else if (role === 'manager' || role === 'tl') {
      empCond = `AND e.reporting_manager_id = $2 AND e.id != $2`;
      params.push(userId);

    } else {
      // Regular employee — show only themselves
      empCond = `AND e.id = $2`;
      params.push(userId);
    }

    const result = await db.query(
      `SELECT e.id AS employee_id,
              e.employee_code,
              CONCAT(e.first_name,' ',e.last_name) AS employee_name,
              d.name  AS department_name,
              des.title AS designation_title,
              CASE
                WHEN a.status IN ('present','late')
                      AND a.punch_in IS NOT NULL
                      AND a.punch_out IS NULL
                      AND a.date = (CURRENT_TIMESTAMP AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}')::date
                      AND EXTRACT(HOUR FROM CURRENT_TIMESTAMP AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}') >= 21
                 THEN 'missing_punch_out'
                WHEN a.status IS NOT NULL THEN a.status
                WHEN EXISTS (
                  SELECT 1 FROM wfh_requests w
                  WHERE w.employee_id = e.id
                    AND w.status = 'approved'
                    AND $1::date BETWEEN w.from_date AND COALESCE(w.to_date, w.from_date)
                ) THEN 'wfh'
                ELSE 'absent'
              END AS status,
              a.punch_in,
              a.punch_out,
              a.working_hours,
              a.punch_in_location,
              a.punch_out_location,
              a.location_lat,
              a.location_lng
       FROM employees e
       LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = $1
       LEFT JOIN departments  d   ON d.id  = e.department_id
       LEFT JOIN designations des ON des.id = e.designation_id
       WHERE e.is_active = true ${empCond}
       ORDER BY e.first_name ASC`,
      params
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[getPunchLocations Error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
// ── Request Regularization (employee) ────────────────────────────────────────
exports.requestRegularization = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const empId = req.user.id;
    const { date, reason, punch_in, punch_out } = req.body;

    if (!date || !reason)
      return res.status(400).json({ success: false, message: 'Date and reason are required' });

    // Must not be a future date
    if (new Date(date) > new Date())
      return res.status(400).json({ success: false, message: 'Cannot regularize a future date' });

    // Check for an existing pending request for same date
    const existing = await client.query(
      `SELECT id, status, punch_in, punch_out FROM attendance
       WHERE employee_id=$1 AND date=$2`,
      [empId, date]
    );
    if (existing.rows.length && existing.rows[0].regularization_status === 'pending')
      return res.status(400).json({ success: false, message: 'A regularization request is already pending for this date' });

    // Allow regularization for: absent, late punch-in, early punch-out, half-day, missing punch
    const attRow = existing.rows[0];
    const allowedStatuses = ['absent', 'late', 'half-day', null, undefined];
    const hasMissingPunch = attRow && (attRow.punch_in && !attRow.punch_out); // punched in but no punch out
    if (attRow && !allowedStatuses.includes(attRow.status) && !hasMissingPunch && attRow.status !== 'present') {
      // Allow for present too if they want to correct punch times
    }

    // Determine regularization type for the record
    const regType = req.body.reg_type || 'absent'; // absent | late_punch_in | early_punch_out | missing_punch_out

    // If reg_type is missing_punch_out, punch_out is required
    if (regType === 'missing_punch_out' && !punch_out)
      return res.status(400).json({ success: false, message: 'punch_out time is required for missing punch-out regularization' });

    // Upsert the attendance row (may not exist for missed punch days)
    await client.query(
      `INSERT INTO attendance(employee_id, date, status, regularization_status, regularization_reason,
                              regularization_punch_in, regularization_punch_out, regularization_requested_at)
       VALUES($1,$2,COALESCE((SELECT status FROM attendance WHERE employee_id=$1 AND date=$2),'absent'),'pending',$3,$4,$5,NOW())
       ON CONFLICT(employee_id, date) DO UPDATE
         SET regularization_status      = 'pending',
             regularization_reason      = EXCLUDED.regularization_reason,
             regularization_punch_in    = EXCLUDED.regularization_punch_in,
             regularization_punch_out   = EXCLUDED.regularization_punch_out,
             regularization_requested_at= NOW()`,
      [empId, date, reason, punch_in || null, punch_out || null]
    );

    // Notify reporting manager
    const manager = await client.query(
      `SELECT m.id, CONCAT(m.first_name,' ',m.last_name) AS name
       FROM employees e
       JOIN employees m ON e.reporting_manager_id = m.id
       WHERE e.id=$1`, [empId]
    );
    const notifyIds = new Set();
    if (req.user.employee_code === CONFIG.cooEmployeeCode) {
      // KC718 (COO) → notify super_admin (KC01/MD) only
      const mdRows = await client.query(`SELECT id FROM employees WHERE role = 'super_admin' AND is_active=true`);
      mdRows.rows.forEach(r => notifyIds.add(r.id));
    } else {
      // Only notify the reporting manager
      // HR gets notified ONLY if HR is the reporting manager of this employee
      if (manager.rows.length) notifyIds.add(manager.rows[0].id);
    }

    const notifMsg = `${req.user.first_name} ${req.user.last_name} has requested attendance regularization for ${date}. Reason: ${reason}`;
    for (const recipientId of notifyIds) {
      await client.query(
        `INSERT INTO notifications(employee_id, title, message, type, reference_id, reference_type)
         VALUES($1,'📋 Regularization Request',$2,'regularization',
           (SELECT id FROM attendance WHERE employee_id=$3 AND date=$4),
           'attendance_regularization')`,
        [recipientId, notifMsg, empId, date]
      );
    }

    await client.query('COMMIT');
    emailSvc.notifyRegularizationApplied(empId, date, reason, punch_in, punch_out).catch(console.error);
    res.json({ success: true, message: 'Regularization request submitted successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ── List Regularizations (manager / HR view) ─────────────────────────────────
exports.getRegularizations = async (req, res) => {
  try {
    const userId = req.user.id;
    const role   = req.user.role;
    const { status = 'pending' } = req.query;

    let scopeCond = '';
    let params    = [status];

    if (role === 'super_admin') {
      // MD only sees KC718 (COO) regularizations
      scopeCond = `AND e.employee_code = CONFIG.cooEmployeeCode`;
    } else if (role === 'hr') {
      scopeCond = ''; // HR sees all
    } else if (['admin', 'manager'].includes(role)) {
      // Admin/manager see direct reports (reporting_manager) + team_leader assignments
      scopeCond = `AND (e.reporting_manager_id=$2 OR e.team_leader_id=$2)`;
      params.push(userId);
    } else if (role === 'tl') {
      // TL sees employees where they are reporting_manager OR team_leader, but NOT their own requests
      scopeCond = `AND (e.reporting_manager_id=$2 OR e.team_leader_id=$2) AND e.id != $2`;
      params.push(userId);
    } else {
      // Regular employee / accounts: show their own requests only
      scopeCond = `AND e.id=$2`;
      params.push(userId);
    }

    const result = await db.query(
      `SELECT a.id,
              TO_CHAR(a.date,'YYYY-MM-DD')                            AS date,
              CONCAT(e.first_name,' ',e.last_name)                    AS emp_name,
              e.employee_code,
              d.name                                                   AS dept,
              a.regularization_status                                  AS status,
              a.regularization_reason                                  AS reason,
              TO_CHAR(a.regularization_punch_in,'HH24:MI')            AS punch_in,
              TO_CHAR(a.regularization_punch_out,'HH24:MI')           AS punch_out,
              a.regularization_requested_at,
              a.regularization_remarks,
              a.status                                                 AS attendance_status
       FROM attendance a
       JOIN employees   e ON e.id = a.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE a.regularization_status = $1 ${scopeCond}
       ORDER BY a.regularization_requested_at DESC`,
      params
    );

    // Alias fields to match what the frontend expects
    const data = result.rows.map(r => ({
      ...r,
      regularization_reason: r.reason,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Action Regularization (approve / reject) ──────────────────────────────────
exports.actionRegularization = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { action, remarks } = req.body;
    const attendance_id = req.body.attendance_id || req.body.id; // accept both keys for compatibility
    const reviewerId = req.user.id;

    if (!attendance_id || !['approve', 'reject'].includes(action))
      return res.status(400).json({ success: false, message: 'attendance_id and action (approve/reject) are required' });

    const rec = await client.query(
      `SELECT a.*, e.reporting_manager_id,
              CONCAT(e.first_name,' ',e.last_name) AS emp_name
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       WHERE a.id=$1 FOR UPDATE`,
      [attendance_id]
    );
    if (!rec.rows.length)
      return res.status(404).json({ success: false, message: 'Attendance record not found' });

    const att = rec.rows[0];
    if (att.regularization_status !== 'pending')
      return res.status(400).json({ success: false, message: 'This request has already been actioned' });

    // ── SELF-APPROVAL GUARD ──────────────────────────────────────────────────
    if (req.user.id === att.employee_id) {
      return res.status(403).json({
        success: false,
        message: 'You cannot approve or reject your own regularization request.'
      });
    }

    // KC01 (MD / super_admin) may only action regularizations belonging to KC718 (COO)
    if (req.user.role === 'super_admin') {
      const empCheck = await client.query(
        `SELECT employee_code FROM employees WHERE id = $1`,
        [att.employee_id]
      );
      if (empCheck.rows[0]?.employee_code !== CONFIG.cooEmployeeCode) {
        return res.status(403).json({
          success: false,
          message: 'MD can only approve regularizations for the COO (KC718).'
        });
      }
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    if (action === 'approve') {
      // Apply the requested punch times and recalculate status/hours
      const punchIn  = att.regularization_punch_in  || att.punch_in;
      const punchOut = att.regularization_punch_out || att.punch_out;

      let hoursWorked = 0;
      let newAttStatus = att.status;

      if (punchIn && punchOut) {
        const [inH, inM]   = punchIn.toString().slice(0, 5).split(':').map(Number);
        let   [outH, outM] = punchOut.toString().slice(0, 5).split(':').map(Number);

        // If punch_out appears before punch_in, it was likely entered in 12hr format
        // e.g. 06:55 meaning 6:55 PM = 18:55 — add 12hrs to correct it
        let inMins  = inH * 60 + inM;
        let outMins = outH * 60 + outM;
        if (outMins <= inMins && outH < 12) {
          outMins += 12 * 60; // treat as PM
        }
        hoursWorked = (outMins - inMins) / 60;

        const isLate = inH > 10 || (inH === 10 && inM > 30);
        const regOnTimeIn  = inMins <= (10 * 60 + 30);
        const regOnTimeOut = outMins >= (18 * 60 + 30);
        if (regOnTimeIn && regOnTimeOut) {
          newAttStatus = 'present';
        } else if (hoursWorked >= 7) {
          newAttStatus = isLate ? 'late' : 'present';
        } else if (hoursWorked > 3.5) {
          newAttStatus = 'half-day';
        } else {
          newAttStatus = 'absent';
        }
      }

      await client.query(
        `UPDATE attendance
         SET punch_in                  = COALESCE(regularization_punch_in,  punch_in),
             punch_out                 = COALESCE(regularization_punch_out, punch_out),
             working_hours             = $1,
             status                    = $2,
             regularization_status     = 'approved',
             regularization_actioned_by= $3,
             regularization_actioned_at= NOW(),
             regularization_remarks    = $4
         WHERE id=$5`,
        [hoursWorked > 0 ? hoursWorked.toFixed(2) : att.working_hours,
         newAttStatus, reviewerId, remarks || null, attendance_id]
      );
    } else {
      // Reject — just update the regularization fields, leave attendance unchanged
      await client.query(
        `UPDATE attendance
         SET regularization_status     = 'rejected',
             regularization_actioned_by= $1,
             regularization_actioned_at= NOW(),
             regularization_remarks    = $2
         WHERE id=$3`,
        [reviewerId, remarks || null, attendance_id]
      );
    }

    // Notify the employee
    await client.query(
      `INSERT INTO notifications(employee_id, title, message, type, reference_id, reference_type)
       VALUES($1,$2,$3,'regularization',$4,'attendance_regularization')`,
      [
        att.employee_id,
        action === 'approve' ? '✅ Regularization Approved' : '❌ Regularization Rejected',
        `Your attendance regularization request for ${att.date} has been ${newStatus}${remarks ? '. Remarks: ' + remarks : ''}.`,
        attendance_id
      ]
    );

    await client.query('COMMIT');
    emailSvc.notifyRegularizationActioned(att.employee_id, att.date, action, remarks, reviewerId).catch(console.error);
    res.json({ success: true, message: `Regularization ${newStatus} successfully` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ── One-time fix: correct timezone-shifted on-leave records ──────────────────
// Runs on server start. Finds any approved leave where attendance was saved
// on the wrong date (1 day earlier due to UTC shift) and moves it to the
// correct date automatically. Safe to run repeatedly — idempotent.
exports.fixTimezoneShiftedLeaves = async () => {
  // ✅ REWRITTEN: replaced N×2 per-row query loop with a single set-based SQL query.
  // Old version fetched all leaves then looped day-by-day firing 2 queries per day —
  // O(leaves × days × 2) queries, growing unboundedly. Now it's 3 queries total regardless of data size.
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Build the full set of (employee_id, correct_date, wrong_date) pairs in SQL:
    // - Expand each approved leave into individual days using generate_series
    // - Skip Sundays (DOW=0) and 2nd/4th Saturdays
    // - wrong_date = correct_date - 1 day (timezone-shift artifact)
    // Then find rows where wrong_date has status='on-leave' but correct_date has no row at all
    const shifted = await client.query(`
      WITH leave_days AS (
        SELECT
          lr.employee_id,
          d::date AS correct_date,
          (d - INTERVAL '1 day')::date AS wrong_date
        FROM leave_requests lr,
             generate_series(lr.from_date::timestamp, lr.to_date::timestamp, '1 day') AS d
        WHERE lr.status = 'approved'
          AND EXTRACT(DOW FROM d) != 0   -- skip Sundays
          -- skip 2nd and 4th Saturdays
          AND NOT (
            EXTRACT(DOW FROM d) = 6
            AND CEIL(EXTRACT(DAY FROM d) / 7.0) IN (2, 4)
          )
      )
      SELECT ld.employee_id, ld.correct_date, ld.wrong_date
      FROM leave_days ld
      -- wrong date exists as on-leave (the shifted record)
      JOIN attendance wrong_att
        ON wrong_att.employee_id = ld.employee_id
       AND wrong_att.date        = ld.wrong_date
       AND wrong_att.status      = 'on-leave'
      -- correct date does NOT exist yet
      WHERE NOT EXISTS (
        SELECT 1 FROM attendance
        WHERE employee_id = ld.employee_id AND date = ld.correct_date
      )
    `);

    if (!shifted.rows.length) {
      await client.query('COMMIT');
      console.log('[fixTimezoneShift] No shifted records found. All good!');
      return;
    }

    // Insert correct records
    for (const row of shifted.rows) {
      await client.query(
        `INSERT INTO attendance(employee_id, date, status)
         VALUES($1, $2, 'on-leave')
         ON CONFLICT (employee_id, date) DO NOTHING`,
        [row.employee_id, row.correct_date]
      );
    }

    // Fix wrong records back to absent in one UPDATE
    const wrongDates = shifted.rows.map(r => r.wrong_date);
    const empIds     = shifted.rows.map(r => r.employee_id);
    await client.query(
      `UPDATE attendance
       SET status = 'absent'
       WHERE status = 'on-leave'
         AND (employee_id, date) IN (
           SELECT UNNEST($1::int[]), UNNEST($2::date[])
         )`,
      [empIds, wrongDates]
    );

    await client.query('COMMIT');
    console.log(`[fixTimezoneShift] Fixed ${shifted.rows.length} shifted attendance record(s).`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[fixTimezoneShift] Error:', err);
  } finally {
    client.release();
  }
};

// ── Apply OD (Outdoor Duty) ───────────────────────────────────────────────────
exports.applyOD = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const empId = req.user.id;
    // Support both single date AND date range (from_date/to_date)
    const { date, from_date, to_date, reason, location } = req.body;
    const startDate = from_date || date;
    const endDate   = to_date   || date;
    if (!startDate || !reason)
      return res.status(400).json({ success: false, message: 'Date and reason are required' });

    // Generate all working dates in range (saturday_policy aware)
    const empSatQ = await client.query(
      `SELECT saturday_policy FROM employees WHERE id=$1`, [empId]
    );
    const odSatPolicy = empSatQ.rows[0]?.saturday_policy || '2nd_4th_off';
    const dates = [];
    let cur = new Date(startDate);
    const end = new Date(endDate);
    let odSatCount = 0; let odLastMonth = -1;
    while (cur <= end) {
      const day = cur.getDay();
      const mo  = cur.getMonth();
      if (mo !== odLastMonth) { odSatCount = 0; odLastMonth = mo; }
      if (day === 6) odSatCount++;
      if (day === 0) { cur.setDate(cur.getDate() + 1); continue; }
      if (day === 6 && odSatPolicy === '2nd_4th_off' && (odSatCount === 2 || odSatCount === 4)) {
        cur.setDate(cur.getDate() + 1); continue;
      }
      dates.push(cur.toISOString().split('T')[0]);
      cur.setDate(cur.getDate() + 1);
    }
    if (!dates.length)
      return res.status(400).json({ success: false, message: 'No working days in selected range' });

    // Insert one row per date (od_requests has single-date schema)
    let inserted = 0;
    for (const d of dates) {
      const existing = await client.query(
        `SELECT id, status FROM od_requests WHERE employee_id=$1 AND date=$2`, [empId, d]
      );
      if (existing.rows.length) {
        const st = existing.rows[0].status;
        if (st === 'pending' || st === 'approved') continue; // skip, already exists
      }
      await client.query(
        `INSERT INTO od_requests(employee_id, date, reason, location, status, applied_at)
         VALUES($1,$2,$3,$4,'pending',NOW())
         ON CONFLICT(employee_id, date) DO UPDATE
           SET reason=EXCLUDED.reason, location=EXCLUDED.location, status='pending', applied_at=NOW()`,
        [empId, d, reason, location || 'Outdoor Duty']
      );
      inserted++;
    }

    const fullName = `${req.user.first_name} ${req.user.last_name}`;
    const rangeLabel = startDate === endDate ? startDate : `${startDate} to ${endDate}`;
    const notifMsg = `${fullName} requested OD for ${rangeLabel} (${dates.length} day(s)). Reason: ${reason}`;
    // KC718 (COO): notify super_admin (MD/KC01) only
    // Everyone else: notify their reporting manager + HR only (KC01 must NOT be notified)
    const isKC718od = req.user.employee_code === CONFIG.cooEmployeeCode;
    const notifyRows = isKC718od
      ? await client.query(`SELECT id FROM employees WHERE role = 'super_admin' AND is_active=true`)
      : await client.query(
          // Only notify reporting manager (HR notified only if HR is the reporting manager)
          `SELECT DISTINCT m.id FROM employees e
           LEFT JOIN employees m ON e.reporting_manager_id = m.id
           WHERE e.id=$1 AND m.id IS NOT NULL`, [empId]
        );
    for (const r of notifyRows.rows) {
      await client.query(`INSERT INTO notifications(employee_id,title,message,type) VALUES($1,'🚗 OD Request',$2,'od')`,
        [r.id, notifMsg]);
    }
    await client.query('COMMIT');
    emailSvc.notifyODApplied(empId, rangeLabel, reason, location).catch(console.error);
    res.json({ success: true, message: `OD request submitted for ${rangeLabel} (${inserted} day(s)). Awaiting approval.` });
  } catch (err) {
    await client.query('ROLLBACK'); console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

exports.getODRequests = async (req, res) => {
  try {
    const empId = req.user.id; const role = req.user.role;
    const { status } = req.query;
    let scopeCond = '', params = [], idx = 1;
    // Only the direct reporting manager sees their team's OD requests
    // Employees see only their own
    if (role === 'super_admin') {
      // ✅ FIX: super_admin sees OD requests from their direct reports (reporting_manager_id)
      // Previously only showed KC718 requests — but super_admin can be anyone's reporting manager
      const isOwn = req.query.own === 'true';
      if (isOwn) {
        scopeCond = `AND e.id=$${idx++}`;
        params.push(empId);
      } else {
        scopeCond = `AND (e.reporting_manager_id=$${idx++} OR e.team_leader_id=$${idx++}) AND e.id != $${idx++}`;
        params.push(empId); params.push(empId); params.push(empId);
      }
    } else if (['hr','admin','manager','tl'].includes(role)) {
      const isOwn = req.query.own === 'true';
      if (isOwn) {
        scopeCond = `AND e.id=$${idx++}`;
        params.push(empId);
      } else {
        scopeCond = `AND (e.reporting_manager_id=$${idx++} OR e.team_leader_id=$${idx++}) AND e.id != $${idx++}`;
        params.push(empId); params.push(empId); params.push(empId);
      }
    } else {
      scopeCond = `AND e.id=$${idx++}`; params.push(empId);
    }
    const effectiveStatus = status === '' ? null : (status || 'pending');
    const statusCond = effectiveStatus ? `AND o.status=$${idx++}` : `AND o.status IS NOT NULL`;
    if (effectiveStatus) params.push(effectiveStatus);
    const result = await db.query(`
      SELECT o.id, TO_CHAR(o.date,'YYYY-MM-DD') AS date,
             CONCAT(e.first_name,' ',e.last_name) AS emp_name,
             e.employee_code, d.name AS dept, o.reason, o.location, o.status, o.remarks, o.applied_at
      FROM od_requests o JOIN employees e ON e.id=o.employee_id
      LEFT JOIN departments d ON d.id=e.department_id
      WHERE 1=1 ${scopeCond} ${statusCond} ORDER BY o.applied_at DESC`, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
};

exports.actionOD = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params; const { action, remarks } = req.body;
    if (!['approve','reject'].includes(action))
      return res.status(400).json({ success: false, message: 'Action must be approve or reject' });
    if (!['hr','super_admin','admin','manager','tl'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Not authorized' });
    const od = await client.query(
      `SELECT o.*, CONCAT(e.first_name,' ',e.last_name) AS emp_name
       FROM od_requests o JOIN employees e ON e.id=o.employee_id WHERE o.id=$1`, [id]);
    if (!od.rows.length) return res.status(404).json({ success: false, message: 'OD request not found' });
    const rec = od.rows[0];
    if (rec.status !== 'pending') return res.status(400).json({ success: false, message: 'Already actioned' });

    // ── SELF-APPROVAL GUARD ──────────────────────────────────────────────────
    // An employee must NOT be able to approve / reject their own OD request.
    // This applies regardless of role (manager, TL, HR, etc.).
    if (req.user.id === rec.employee_id) {
      return res.status(403).json({
        success: false,
        message: 'You cannot approve or reject your own OD request.'
      });
    }

    // KC01 (MD / super_admin) may only action OD requests belonging to KC718 (COO)
    if (req.user.role === 'super_admin') {
      const empCheck = await client.query(
        `SELECT employee_code FROM employees WHERE id = $1`, [rec.employee_id]
      );
      if (empCheck.rows[0]?.employee_code !== CONFIG.cooEmployeeCode) {
        return res.status(403).json({
          success: false,
          message: 'MD can only approve OD requests for the COO (KC718).'
        });
      }
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await client.query(`UPDATE od_requests SET status=$1,actioned_by=$2,action_at=NOW(),remarks=$3 WHERE id=$4`,
      [newStatus, req.user.id, remarks||null, id]);
    if (action === 'approve') {
      await client.query(
        `INSERT INTO attendance(employee_id,date,status,remarks,punch_in_location)
         VALUES($1,$2,'od',$3,$4) ON CONFLICT(employee_id,date)
         DO UPDATE SET status='od',remarks=EXCLUDED.remarks,punch_in_location=EXCLUDED.punch_in_location`,
        [rec.employee_id, rec.date, rec.reason, rec.location||'Outdoor Duty']);
    }
    const actor = `${req.user.first_name} ${req.user.last_name}`;
    const emoji = action === 'approve' ? '✅' : '❌';
    await client.query(`INSERT INTO notifications(employee_id,title,message,type) VALUES($1,$2,$3,'od')`,
      [rec.employee_id, `${emoji} OD ${newStatus}`,
       `Your OD request for ${rec.date} has been ${newStatus} by ${actor}.${remarks?' Remarks: '+remarks:''}`]);
    await client.query('COMMIT');
    emailSvc.notifyODActioned(rec.employee_id, rec.date, action, remarks, req.user.id).catch(console.error);
    res.json({ success: true, message: `OD request ${newStatus}` });
  } catch (err) {
    await client.query('ROLLBACK'); console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

exports.bulkActionOD = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { ids, action, remarks } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, message: 'ids array required' });
    if (!['approve','reject'].includes(action))
      return res.status(400).json({ success: false, message: 'Invalid action' });
    if (!['hr','super_admin','admin','manager','tl'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Not authorized' });

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const actor = `${req.user.first_name} ${req.user.last_name}`;
    let actioned = 0;

    for (const id of ids) {
      const od = await client.query(
        `SELECT o.*, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS emp_name
         FROM od_requests o JOIN employees e ON e.id=o.employee_id WHERE o.id=$1`, [id]
      );
      if (!od.rows.length) continue;
      const rec = od.rows[0];
      if (rec.status !== 'pending') continue;
      if (req.user.id === rec.employee_id) continue;

      await client.query(
        `UPDATE od_requests SET status=$1,actioned_by=$2,action_at=NOW(),remarks=$3 WHERE id=$4`,
        [newStatus, req.user.id, remarks||null, id]
      );
      if (action === 'approve') {
        await client.query(
          `INSERT INTO attendance(employee_id,date,status,remarks,punch_in_location)
           VALUES($1,$2,'od',$3,$4) ON CONFLICT(employee_id,date)
           DO UPDATE SET status='od',remarks=EXCLUDED.remarks,punch_in_location=EXCLUDED.punch_in_location`,
          [rec.employee_id, rec.date, rec.reason, rec.location||'Outdoor Duty']
        );
      }
      await client.query(
        `INSERT INTO notifications(employee_id,title,message,type) VALUES($1,$2,$3,'od')`,
        [rec.employee_id, `${action==='approve'?'✅':'❌'} OD ${newStatus}`,
         `Your OD for ${rec.date} has been ${newStatus} by ${actor}.${remarks?' Remarks: '+remarks:''}`]
      );
      actioned++;
    }
    await client.query('COMMIT');
    res.json({ success: true, message: `OD ${newStatus} for ${actioned} day(s)` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

exports.applyWFH = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const empId = req.user.id;
    // Support both single date AND date range
    const { date, from_date, to_date, reason } = req.body;
    const startDate = from_date || date;
    const endDate   = to_date   || date;
    if (!startDate || !reason)
      return res.status(400).json({ success: false, message: 'Date and reason are required' });

    // Check for existing pending/approved in this range
    const existing = await client.query(
      `SELECT id, status FROM wfh_requests WHERE employee_id=$1 AND from_date=$2`, [empId, startDate]);
    if (existing.rows.length) {
      const st = existing.rows[0].status;
      if (st === 'pending')  return res.status(400).json({ success: false, message: 'WFH request already pending for this date range' });
      if (st === 'approved') return res.status(400).json({ success: false, message: 'WFH already approved for this date range' });
    }

    // Count working days
    const dates = [];
    let cur = new Date(startDate);
    const end = new Date(endDate);
    while (cur <= end) {
      const day = cur.getDay();
      if (day !== 0 && day !== 6) dates.push(cur.toISOString().split('T')[0]);
      cur.setDate(cur.getDate() + 1);
    }
    if (!dates.length)
      return res.status(400).json({ success: false, message: 'No working days in selected range' });

    await client.query(
      `INSERT INTO wfh_requests(employee_id,from_date,to_date,reason,status,applied_at)
       VALUES($1,$2,$3,$4,'pending',NOW())`, [empId, startDate, endDate, reason]);

    const fullName = `${req.user.first_name} ${req.user.last_name}`;
    const rangeLabel = startDate === endDate ? startDate : `${startDate} to ${endDate}`;
    const notifMsg = `${fullName} requested WFH for ${rangeLabel} (${dates.length} day(s)). Reason: ${reason}`;

    // KC718 (Gurugutt) WFH approval goes to super_admin only (MD/KC01), not their reporting manager
    const isKC718 = req.user.employee_code === CONFIG.cooEmployeeCode;
    const notifyRows = isKC718
      ? await client.query(`SELECT id FROM employees WHERE role='super_admin' AND is_active=true`)
      : await client.query(
          // Only notify reporting manager (HR notified only if HR is the reporting manager)
          `SELECT DISTINCT m.id FROM employees e
           LEFT JOIN employees m ON e.reporting_manager_id=m.id
           WHERE e.id=$1 AND m.id IS NOT NULL`, [empId]);
    for (const r of notifyRows.rows) {
      await client.query(`INSERT INTO notifications(employee_id,title,message,type) VALUES($1,'🏠 WFH Request',$2,'wfh')`,
        [r.id, notifMsg]);
    }
    await client.query('COMMIT');
    emailSvc.notifyWFHApplied(empId, rangeLabel, reason).catch(console.error);
    res.json({ success: true, message: `WFH request submitted for ${rangeLabel} (${dates.length} day(s)). Awaiting approval.` });
  } catch (err) {
    await client.query('ROLLBACK'); console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

exports.getWFHRequests = async (req, res) => {
  try {
    const empId = req.user.id; const role = req.user.role;
    const { status } = req.query;
    let scopeCond = '', params = [], idx = 1;
    // Only the direct reporting manager sees their team's WFH requests
    if (role === 'super_admin') {
      // MD only sees KC718 (COO) WFH requests
      scopeCond = `AND e.employee_code = CONFIG.cooEmployeeCode`;
    } else if (['hr','admin','manager','tl'].includes(role)) {
      // Managers see team + own; status param controls whether it's "pending for me" or "all mine"
      const isOwn = req.query.own === 'true';
      if (isOwn) {
        scopeCond = `AND e.id=$${idx++}`;
        params.push(empId);
      } else {
        // Pending approvals queue: only show subordinates' requests, NOT own requests.
        // Own requests are visible under own === 'true' (personal history view).
        scopeCond = `AND (e.reporting_manager_id=$${idx++} OR e.team_leader_id=$${idx++}) AND e.id != $${idx++}`;
        params.push(empId); params.push(empId); params.push(empId);
      }
    } else {
      scopeCond = `AND e.id=$${idx++}`; params.push(empId);
    }
    const effectiveStatus = status === '' ? null : (status || 'pending');
    const statusCond = effectiveStatus ? `AND w.status=$${idx++}` : `AND w.status IS NOT NULL`;
    if (effectiveStatus) params.push(effectiveStatus);
    const result = await db.query(`
      SELECT w.id, TO_CHAR(w.from_date,'YYYY-MM-DD') AS from_date,
             TO_CHAR(w.to_date,'YYYY-MM-DD') AS to_date,
             TO_CHAR(w.from_date,'YYYY-MM-DD') AS date,
             CONCAT(e.first_name,' ',e.last_name) AS emp_name,
             e.employee_code, d.name AS dept, w.reason, w.status, w.remarks, w.applied_at
      FROM wfh_requests w JOIN employees e ON e.id=w.employee_id
      LEFT JOIN departments d ON d.id=e.department_id
      WHERE 1=1 ${scopeCond} ${statusCond} ORDER BY w.applied_at DESC`, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Server error' }); }
};

exports.actionWFH = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params; const { action, remarks } = req.body;
    if (!['approve','reject'].includes(action))
      return res.status(400).json({ success: false, message: 'Action must be approve or reject' });
    if (!['hr','super_admin','admin','manager','tl'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Not authorized' });
    const wfh = await client.query(
      `SELECT w.*, CONCAT(e.first_name,' ',e.last_name) AS emp_name
       FROM wfh_requests w JOIN employees e ON e.id=w.employee_id WHERE w.id=$1`, [id]);
    if (!wfh.rows.length) return res.status(404).json({ success: false, message: 'WFH request not found' });
    const rec = wfh.rows[0];
    if (rec.status !== 'pending') return res.status(400).json({ success: false, message: 'Already actioned' });

    // ── SELF-APPROVAL GUARD ──────────────────────────────────────────────────
    if (req.user.id === rec.employee_id) {
      return res.status(403).json({
        success: false,
        message: 'You cannot approve or reject your own WFH request.'
      });
    }

    // KC01 (MD / super_admin) may only action WFH requests belonging to KC718 (COO)
    if (req.user.role === 'super_admin') {
      const empCheck = await client.query(
        `SELECT employee_code FROM employees WHERE id = $1`, [rec.employee_id]
      );
      if (empCheck.rows[0]?.employee_code !== CONFIG.cooEmployeeCode) {
        return res.status(403).json({
          success: false,
          message: 'MD can only approve WFH requests for the COO (KC718).'
        });
      }
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await client.query(`UPDATE wfh_requests SET status=$1,actioned_by=$2,action_at=NOW(),remarks=$3 WHERE id=$4`,
      [newStatus, req.user.id, remarks||null, id]);
    if (action === 'approve') {
      // Insert attendance as 'wfh' for EVERY date in the approved range
      const fromDate = new Date(rec.from_date);
      const toDate   = new Date(rec.to_date || rec.from_date);
      // Fetch saturday_policy for the WFH requester
      const wfhSatQ = await client.query(
        `SELECT saturday_policy FROM employees WHERE id=$1`, [rec.employee_id]
      );
      const wfhSatPolicy = wfhSatQ.rows[0]?.saturday_policy || '2nd_4th_off';
      let wfhSatCount = 0; let wfhLastMonth = -1;
      const cur = new Date(fromDate);
      while (cur <= toDate) {
        const day = cur.getDay();
        const wfhMo = cur.getMonth();
        if (wfhMo !== wfhLastMonth) { wfhSatCount = 0; wfhLastMonth = wfhMo; }
        if (day === 6) wfhSatCount++;
        // Respect saturday_policy for WFH approval
        if (day === 0) { cur.setDate(cur.getDate() + 1); continue; }
        if (day === 6 && (wfhSatPolicy === '2nd_4th_off') && (wfhSatCount === 2 || wfhSatCount === 4)) {
          cur.setDate(cur.getDate() + 1); continue;
        }
        const dateStr = cur.toISOString().split('T')[0];
        await client.query(
          `INSERT INTO attendance(employee_id,date,status,remarks,punch_in_location,wfh_approved)
           VALUES($1,$2,'wfh',$3,'Work from Home',true)
           ON CONFLICT(employee_id,date) DO UPDATE
             SET status='wfh',
                 remarks=EXCLUDED.remarks,
                 punch_in_location='Work from Home',
                 wfh_approved=true`,
          [rec.employee_id, dateStr, rec.reason]
        );
        cur.setDate(cur.getDate() + 1);
      }
    }
    const actor = `${req.user.first_name} ${req.user.last_name}`;
    const emoji = action === 'approve' ? '✅' : '❌';
    await client.query(`INSERT INTO notifications(employee_id,title,message,type) VALUES($1,$2,$3,'wfh')`,
      [rec.employee_id, `${emoji} WFH ${newStatus}`,
       `Your WFH request for ${rec.from_date} has been ${newStatus} by ${actor}.${remarks?' Remarks: '+remarks:''}`]);
    await client.query('COMMIT');
    emailSvc.notifyWFHActioned(rec.employee_id, rec.from_date, action, remarks, req.user.id).catch(console.error);
    res.json({ success: true, message: `WFH request ${newStatus}` });
  } catch (err) {
    await client.query('ROLLBACK'); console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ── Startup repair: fix wrongly-marked absent records ─────────────────────────
exports.fixWrongAbsents = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Fix absent records AND missing_punch_out records that somehow have both punch times
    const result = await client.query(`
      UPDATE attendance
      SET
        working_hours = ROUND(
          EXTRACT(EPOCH FROM (punch_out::time - punch_in::time)) / 3600.0, 2
        ),
        status = CASE
          WHEN EXTRACT(EPOCH FROM (punch_out::time - punch_in::time)) / 3600.0 >= 8.5
               THEN CASE WHEN punch_in::time > '10:30:00'::time THEN 'late' ELSE 'present' END
          WHEN EXTRACT(EPOCH FROM (punch_out::time - punch_in::time)) / 3600.0 >= 4
               THEN 'half-day'
          ELSE 'absent'
        END
      WHERE punch_in  IS NOT NULL
        AND punch_out IS NOT NULL
        AND status    IN ('absent', 'missing_punch_out')
        AND regularization_status IS DISTINCT FROM 'approved'
      RETURNING id, date, employee_id
    `);
    await client.query('COMMIT');
    if (result.rows.length > 0) {
      console.log(`[fixWrongAbsents] ✅ Fixed ${result.rows.length} wrongly-marked absent/missing_punch_out record(s).`);
    } else {
      console.log('[fixWrongAbsents] ✅ No wrong absents found. All good!');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[fixWrongAbsents] ❌ Error:', err.message);
  } finally { client.release(); }
};

// ── Nightly job: mark missing punch-outs after 9 PM ──────────────────────────
// Run this once per day after 21:00 IST.
// Any attendance row with punch_in but no punch_out from a PAST date (or today after 9 PM)
// gets flipped to missing_punch_out so it shows as MPO in reports.
exports.fixMissingPunchOuts = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const ist = getISTTimeParts();
    const todayIST = getISTDate();
    // Only flag today's records if it is already past 21:00 IST
    const cutoffDate = (ist.hour >= 21) ? todayIST : (() => {
      const d = new Date(todayIST + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      return d.toISOString().slice(0, 10);
    })();

    const result = await client.query(`
      UPDATE attendance
      SET status = 'missing_punch_out'
      WHERE punch_in  IS NOT NULL
        AND punch_out IS NULL
        AND date      <= $1
        AND status    IN ('present', 'late')
        AND regularization_status IS DISTINCT FROM 'approved'
      RETURNING id, date, employee_id
    `, [cutoffDate]);
    await client.query('COMMIT');
    if (result.rows.length > 0) {
      console.log(`[fixMissingPunchOuts] ✅ Marked ${result.rows.length} record(s) as missing_punch_out.`);
    } else {
      console.log('[fixMissingPunchOuts] ✅ No missing punch-outs to fix.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[fixMissingPunchOuts] ❌ Error:', err.message);
  } finally { client.release(); }
};

// ── Working-day generator (saturday_policy aware) ────────────────────────────
// satPolicy: 'all_working' → every Saturday is a workday
//            '2nd_4th_off' → 2nd and 4th Saturday are off
function getWorkingDays(from_date, endDate, holidayDates, satPolicy) {
  const dates = [];
  let cur = new Date(from_date + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  let satCount = 0;
  let lastMonth = -1;

  while (cur <= end) {
    const dow = cur.getDay();
    const yr  = cur.getFullYear();
    const mo  = cur.getMonth();
    const d   = cur.getDate();

    // Reset Saturday counter each calendar month
    if (mo !== lastMonth) { satCount = 0; lastMonth = mo; }
    if (dow === 6) satCount++;

    const dateStr = `${yr}-${String(mo+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

    // Skip Sundays always
    if (dow === 0) { cur.setDate(cur.getDate() + 1); continue; }

    // Skip off-Saturdays based on policy
    if (dow === 6 && satPolicy === '2nd_4th_off' && (satCount === 2 || satCount === 4)) {
      cur.setDate(cur.getDate() + 1); continue;
    }

    // Skip public holidays
    if (holidayDates.has(dateStr)) { cur.setDate(cur.getDate() + 1); continue; }

    dates.push(dateStr);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ── Mark Attendance Range (KC718 / super_admin only) ─────────────────────────
// Allows KC718 and super_admin to mark attendance for a date range.
// Automatically skips Sundays, public holidays, and off-Saturdays based on
// each employee's saturday_policy ('all_working' or '2nd_4th_off').
exports.markRange = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const empId   = req.user.id;
    const role    = req.user.role;
    const empCode = req.user.employee_code;

    // Only KC718 and super_admin can use this endpoint
    if (role !== 'super_admin' && empCode !== CONFIG.cooEmployeeCode)
      return res.status(403).json({ success: false, message: 'Not authorized' });

    const { from_date, to_date, status, remarks } = req.body;
    if (!from_date || !status)
      return res.status(400).json({ success: false, message: 'from_date and status are required' });

    const validStatuses = ['present', 'od', 'on-leave', 'absent', 'half-day', 'wfh'];
    if (!validStatuses.includes(status))
      return res.status(400).json({ success: false, message: 'Invalid status. Use: ' + validStatuses.join(', ') });

    const endDate = to_date || from_date;

    // Fetch employee's saturday_policy from DB
    const empResult = await client.query(
      `SELECT saturday_policy FROM employees WHERE id=$1`, [empId]
    );
    const satPolicy = empResult.rows[0]?.saturday_policy || '2nd_4th_off';

    // Get holidays in range to skip them
    const holResult = await client.query(
      `SELECT TO_CHAR(date,'YYYY-MM-DD') AS date FROM holidays
       WHERE date BETWEEN $1 AND $2 AND (region='all' OR region='south_west' OR region='north')`,
      [from_date, endDate]
    );
    const holidayDates = new Set(holResult.rows.map(h => h.date));

    // Generate working days respecting employee's saturday_policy
    const dates = getWorkingDays(from_date, endDate, holidayDates, satPolicy);

    if (!dates.length)
      return res.status(400).json({ success: false, message: 'No working days found in selected range (all days are weekends/holidays)' });

    // Insert or update attendance for each working day
    let inserted = 0;
    for (const dateStr of dates) {
      await client.query(
        `INSERT INTO attendance(employee_id, date, status, remarks, punch_in_location)
         VALUES($1, $2, $3, $4, $5)
         ON CONFLICT(employee_id, date) DO UPDATE
           SET status=$3, remarks=$4, punch_in_location=$5`,
        [empId, dateStr, status, remarks || null,
         status === 'od' ? 'Outdoor Duty' :
         status === 'wfh' ? 'Work from Home' :
         status === 'on-leave' ? 'On Leave' : 'Manual Entry']
      );
      inserted++;
    }

    await client.query('COMMIT');
    const rangeLabel = from_date === endDate ? from_date : `${from_date} to ${endDate}`;
    res.json({
      success: true,
      message: `Attendance marked as "${status}" for ${inserted} working day(s) (${rangeLabel})`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[markRange Error]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ═══════════════════════════════════════════════════════════════════════════
// MOVEMENT TRACKING
// ═══════════════════════════════════════════════════════════════════════════

// ── Log a GPS point (called every 5 min from the mobile/browser app) ─────
// ── Haversine distance in km between two lat/lng points ────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2)
          + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
          * Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Log a GPS point (called every 30 seconds from the mobile/browser app) ────
exports.logMovement = async (req, res) => {
  try {
    const empId = req.user.id;
    const { lat, lng, accuracy, gps_status, internet_status, battery } = req.body;
    console.log(`[PING] emp=${empId} lat=${lat} lng=${lng} acc=${accuracy} gps=${gps_status} net=${internet_status} batt=${battery}`);

    if (!lat || !lng) {
      console.log(`[PING] SKIP emp=${empId} reason=no_lat_lng`);
      return res.status(400).json({ success: false, message: 'lat and lng are required' });
    }

    const gpsOn  = gps_status      !== false;
    const netOn  = internet_status !== false;
    const batt   = battery != null ? parseInt(battery) : null;

    // is_punch_in=true bypasses ALL time/distance/accuracy gates.
    // The app sends this for the anchor point logged at punch-in — must always save.
    const isPunchIn = req.body.is_punch_in === true || req.body.is_punch_in === 'true';

    // accuracy=0 means "unknown" (punch-in point) — allow it; only reject clearly bad readings
    const acc = parseFloat(accuracy) || 0;
    if (!isPunchIn && acc > 0 && acc > 500) {
      console.log(`[PING] SKIP emp=${empId} reason=poor_accuracy acc=${acc}`);
      return res.json({ success: true, skipped: true, reason: 'poor_accuracy' });
    }

    const today = getISTDate();
    const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: CONFIG.timezone || 'Asia/Kolkata' }));
    const currentHHMM = istNow.getHours() * 100 + istNow.getMinutes();

    const stateQ = await db.query(
      `SELECT
         (SELECT COUNT(1) FROM od_requests
          WHERE employee_id=$1 AND date=$2 AND status='approved') AS has_od,
         (SELECT punch_in  FROM attendance WHERE employee_id=$1 AND date=$2) AS punch_in,
         (SELECT punch_out FROM attendance WHERE employee_id=$1 AND date=$2) AS punch_out`,
      [empId, today]
    );
    const { has_od, punch_in, punch_out } = stateQ.rows[0];
    const hasOD     = parseInt(has_od) > 0;
    const punchedIn  = !!punch_in;
    const punchedOut = !!punch_out;
    console.log(`[PING] emp=${empId} today=${today} hhmm=${currentHHMM} hasOD=${hasOD} punchedIn=${punchedIn} punchedOut=${punchedOut}`);

    if (hasOD) {
      if (currentHHMM < 930 || currentHHMM > 1830) {
        console.log(`[PING] SKIP emp=${empId} reason=od_outside_window hhmm=${currentHHMM}`);
        return res.json({ success: true, skipped: true, reason: 'od_outside_window' });
      }
    } else {
      if (!punchedIn) {
        console.log(`[PING] SKIP emp=${empId} reason=not_punched_in today=${today}`);
        return res.status(400).json({ success: false, message: 'Not punched in today' });
      }
      if (punchedOut) {
        console.log(`[PING] SKIP emp=${empId} reason=punched_out`);
        return res.json({ success: true, skipped: true, reason: 'punched_out' });
      }
    }

    const lastPt = await db.query(
      `SELECT lat::float AS lat, lng::float AS lng, logged_at
       FROM employee_movement_log
       WHERE employee_id=$1 ORDER BY logged_at DESC LIMIT 1`,
      [empId]
    );
    if (lastPt.rows.length && !isPunchIn) {
      const prev = lastPt.rows[0];
      const timeDiffMs = Date.now() - new Date(prev.logged_at).getTime();
      console.log(`[PING] emp=${empId} timeSinceLast=${Math.round(timeDiffMs/1000)}s`);
      if (timeDiffMs < 20000) {
        // 20s gate — allows 30s pings even if slightly early
        console.log(`[PING] SKIP emp=${empId} reason=too_soon timeDiffMs=${timeDiffMs}`);
        return res.json({ success: true, skipped: true, reason: 'too_soon' });
      }
      const distKm = haversineKm(parseFloat(prev.lat), parseFloat(prev.lng), parseFloat(lat), parseFloat(lng));
      const timeDiffHrs = timeDiffMs / 3600000;
      const speedKmh = timeDiffHrs > 0 ? distKm / timeDiffHrs : 0;
      const isJitter = (distKm * 1000) < 50;
      console.log(`[PING] emp=${empId} distM=${Math.round(distKm*1000)} speedKmh=${Math.round(speedKmh)} isJitter=${isJitter}`);
      // Only skip GPS teleport jumps (>150 km/h) — NOT stationary points
      // Stationary employees must be tracked every 30s regardless of movement
      if (!isJitter && speedKmh > 150) {
        console.log(`[PING] SKIP emp=${empId} reason=gps_jump speedKmh=${Math.round(speedKmh)}`);
        return res.json({ success: true, skipped: true, reason: 'gps_jump' });
      }
    } else if (!lastPt.rows.length) {
      console.log(`[PING] emp=${empId} ${isPunchIn ? 'punch-in anchor point (bypass)' : 'first point of the day'}`);
    } else {
      console.log(`[PING] emp=${empId} punch-in anchor — bypassing time/distance gates`);
    }

    await db.query(
      `INSERT INTO employee_movement_log(employee_id, lat, lng, accuracy, gps_status, internet_status, battery, logged_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,NOW())`,
      [empId, lat, lng, acc, gpsOn, netOn, batt]
    );
    console.log(`[PING] SAVED emp=${empId} lat=${lat} lng=${lng} acc=${acc}`);

    if (Math.random() < 0.02) {
      db.query(`DELETE FROM employee_movement_log WHERE logged_at < NOW() - INTERVAL '3 days'`)
        .catch(err => console.warn('[logMovement] cleanup error:', err.message));
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[logMovement Error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get movement history for HR/admin (employee + date filter) ────────────

// ── Batch log GPS points buffered offline (SW sends these on reconnect) ───────
exports.logMovementBatch = async (req, res) => {
  try {
    const empId = req.user.id;
    const { points } = req.body;
    if (!Array.isArray(points) || !points.length)
      return res.status(400).json({ success: false, message: 'points array required' });

    const today = getISTDate();
    const stateQ = await db.query(
      `SELECT
         (SELECT COUNT(1) FROM od_requests WHERE employee_id=$1 AND date=$2 AND status='approved') AS has_od,
         (SELECT punch_in  FROM attendance WHERE employee_id=$1 AND date=$2) AS punch_in,
         (SELECT punch_out FROM attendance WHERE employee_id=$1 AND date=$2) AS punch_out`,
      [empId, today]
    );
    const { has_od, punch_in, punch_out } = stateQ.rows[0];
    if (!parseInt(has_od) && (!punch_in || punch_out))
      return res.json({ success: true, skipped: true, reason: 'not_active' });

    const lastPtQ = await db.query(
      `SELECT lat::float AS lat, lng::float AS lng, logged_at
       FROM employee_movement_log WHERE employee_id=$1 ORDER BY logged_at DESC LIMIT 1`,
      [empId]
    );
    let lastLat = lastPtQ.rows[0]?.lat ?? null;
    let lastLng = lastPtQ.rows[0]?.lng ?? null;
    let lastTs  = lastPtQ.rows[0]?.logged_at ? new Date(lastPtQ.rows[0].logged_at).getTime() : 0;

    let inserted = 0, skipped = 0;
    const sorted = [...points].sort((a, b) => (a.ts || 0) - (b.ts || 0));

    for (const pt of sorted) {
      const { lat, lng, acc = 0, ts } = pt;
      if (!lat || !lng) { skipped++; continue; }
      const accuracy = parseFloat(acc) || 0;
      if (accuracy > 50) { skipped++; continue; }
      if (lastLat !== null) {
        const distKm = haversineKm(lastLat, lastLng, parseFloat(lat), parseFloat(lng));
        // Distance gate removed — save every point regardless of movement
        const timeDiffHrs = ts ? (ts - lastTs) / 3600000 : 30 / 3600;
        if (timeDiffHrs > 0 && distKm / timeDiffHrs > 80) { skipped++; continue; }
      }
      const loggedAt = ts ? new Date(ts).toISOString() : new Date().toISOString();
      await db.query(
        `INSERT INTO employee_movement_log(employee_id, lat, lng, accuracy, logged_at)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [empId, lat, lng, accuracy, loggedAt]
      );
      lastLat = parseFloat(lat); lastLng = parseFloat(lng); lastTs = ts || Date.now();
      inserted++;
    }
    res.json({ success: true, inserted, skipped });
  } catch (err) {
    console.error('[logMovementBatch Error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};


// ── Segmented movement: builds S1→E1 (blue) + E1→S2 (orange gap) segments ──
exports.getMovementSegmented = async (req, res) => {
  try {
    const { employee_id, date } = req.query;
    if (!employee_id || !date)
      return res.status(400).json({ success: false, message: 'employee_id and date required' });

    // Check if employee is currently punched in (to label last segment correctly)
    const attState = await db.query(
      `SELECT punch_in, punch_out FROM attendance WHERE employee_id=$1 AND date=$2`,
      [employee_id, date]
    );
    const punchedIn  = !!attState.rows[0]?.punch_in;
    const punchedOut = !!attState.rows[0]?.punch_out;

    // Fetch all points for the day ordered by time
    const result = await db.query(
      `SELECT
         lat::float, lng::float, accuracy,
         gps_status, internet_status, battery,
         logged_at,
         TO_CHAR(logged_at AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}', 'HH12:MI:SS AM') AS time_label,
         EXTRACT(EPOCH FROM logged_at)*1000 AS ts
       FROM employee_movement_log
       WHERE employee_id = $1
         AND DATE(logged_at AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}') = $2
       ORDER BY logged_at ASC`,
      [employee_id, date]
    );
    const pts = result.rows;

    if (!pts.length)
      return res.json({ success: true, data: { segments: [], events: [], analytics: null, alerts: [] } });

    // ── Constants ────────────────────────────────────────────────────────────
    const GAP_THRESHOLD_MS  = 90 * 1000;      // 90s gap → new segment (handles delayed 30s pings)
    const RESUME_WAIT_MS    = 0;               // 0 — always show ALL points regardless of session length
    const MAX_SPEED_KMH     = 150;  // raised from 120 — bikes/cars rarely exceed this; lower = false alerts
    const GPS_FLAG_MINS     = 15;
    const NET_FLAG_MINS     = 30;
    const MAX_INTERRUPTIONS = 5;

    // ── Haversine ────────────────────────────────────────────────────────────
    function havKm(p1, p2) {
      const R = 6371, toRad = d => d * Math.PI / 180;
      const dLat = toRad(p2.lat - p1.lat), dLng = toRad(p2.lng - p1.lng);
      const a = Math.sin(dLat/2)**2 + Math.cos(toRad(p1.lat))*Math.cos(toRad(p2.lat))*Math.sin(dLng/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    // ── Step 1: Remove GPS teleport jumps ───────────────────────────────────
    const clean = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const prev = clean[clean.length - 1];
      const cur  = pts[i];
      const diffMs  = cur.ts - prev.ts;
      const distKm  = havKm(prev, cur);
      const isJitter = (distKm * 1000) < 50; // < 50m = GPS noise, not real movement
      const speed   = (!isJitter && diffMs > 0) ? distKm / (diffMs / 3600000) : 0;
      if (speed > MAX_SPEED_KMH && diffMs < GAP_THRESHOLD_MS) continue; // teleport — skip
      clean.push(cur);
    }

    // ── Step 2: Split into raw segments by time gap ──────────────────────────
    const rawSegs = []; // [{pts:[...]}]
    let cur = [clean[0]];
    for (let i = 1; i < clean.length; i++) {
      const diffMs = clean[i].ts - clean[i-1].ts;
      if (diffMs >= GAP_THRESHOLD_MS) {
        rawSegs.push(cur);
        cur = [clean[i]];
      } else {
        cur.push(clean[i]);
      }
    }
    rawSegs.push(cur);

    // ── Step 3: Apply 5-min resume confirmation window ───────────────────────
    // A segment is only confirmed (gets S{n} label) if its duration >= RESUME_WAIT_MS
    // Short spurious pings within 5 min of gap are merged into the gap.
    const confirmedSegs = [];
    for (let i = 0; i < rawSegs.length; i++) {
      const seg = rawSegs[i];
      const durMs = seg[seg.length-1].ts - seg[0].ts;
      if (i === 0 || durMs >= RESUME_WAIT_MS) {
        confirmedSegs.push(seg);
      } else {
        // Short segment — treat as noise, merge its first point into previous gap
        // (just don't add a new confirmed segment)
        console.log(`[Segmented] Skipping short segment ${durMs/1000}s < ${RESUME_WAIT_MS/1000}s (resume confirmation)`);
      }
    }
    if (!confirmedSegs.length) confirmedSegs.push(rawSegs[0]);

    // ── Step 4: Build output segments + events + analytics ───────────────────
    const segments  = [];
    const events    = [];
    let   segIdx    = 0;
    let   verifiedKm = 0, estimatedKm = 0, downtimeMs = 0, longestGapMs = 0;
    let   interruptions = 0;
    let   gpsOffMs = 0, netOffMs = 0;

    for (let i = 0; i < confirmedSegs.length; i++) {
      segIdx++;
      const seg    = confirmedSegs[i];
      const startP = seg[0];
      const endP   = seg[seg.length - 1];

      // Calc verified km for this segment
      let segKm = 0;
      for (let j = 1; j < seg.length; j++) segKm += havKm(seg[j-1], seg[j]);
      verifiedKm += segKm;

      // Tracked segment (BLUE)
      // If this is the last segment and employee is still active (no punch-out),
      // label end as "NOW" not E{n} — avoids showing E1 for a single live point
      const isLastSeg   = i === confirmedSegs.length - 1;
      const isLiveSeg   = isLastSeg && !!punchedIn && !punchedOut;
      const endLabel    = isLiveSeg ? 'NOW' : `E${segIdx}`;
      const endType     = isLiveSeg ? 'current' : 'loss';

      segments.push({
        type:        'verified',
        index:       segIdx,
        startLabel:  `S${segIdx}`,
        endLabel,
        is_live:     isLiveSeg,
        points:      seg.map(p => ({ lat: p.lat, lng: p.lng, time_label: p.time_label, ts: p.ts, accuracy: p.accuracy, battery: p.battery })),
        km:          Math.round(segKm * 100) / 100,
        start_time:  startP.time_label,
        end_time:    endP.time_label
      });

      // S{n} event
      events.push({ type: 'start', label: `S${segIdx}`, point: { lat: startP.lat, lng: startP.lng, time_label: startP.time_label, ts: startP.ts } });
      // E{n} / NOW event
      events.push({ type: endType, label: endLabel, point: { lat: endP.lat, lng: endP.lng, time_label: endP.time_label, ts: endP.ts } });

      // Check gps/internet off within segment
      seg.forEach(p => {
        if (!p.gps_status)      gpsOffMs += 60000;
        if (!p.internet_status) netOffMs += 60000;
      });

      // GAP segment between this E{n} and next S{n+1} (ORANGE)
      if (i < confirmedSegs.length - 1) {
        const nextSeg   = confirmedSegs[i + 1];
        const gapFromPt = endP;
        const gapToPt   = nextSeg[0];
        const gapMs     = gapToPt.ts - gapFromPt.ts;
        const gapKm     = havKm(gapFromPt, gapToPt);

        downtimeMs   += gapMs;
        longestGapMs  = Math.max(longestGapMs, gapMs);
        estimatedKm  += gapKm;
        interruptions++;

        const gapMins = Math.round(gapMs / 60000);
        const durLabel = gapMs < 3600000
          ? `${gapMins}m`
          : `${Math.floor(gapMins/60)}h ${gapMins%60}m`;

        segments.push({
          type:       'gap',
          from_index: segIdx,
          to_index:   segIdx + 1,
          startLabel: `E${segIdx}`,
          endLabel:   `S${segIdx + 1}`,
          from:       { lat: gapFromPt.lat, lng: gapFromPt.lng, time_label: gapFromPt.time_label, ts: gapFromPt.ts },
          to:         { lat: gapToPt.lat,   lng: gapToPt.lng,   time_label: gapToPt.time_label,   ts: gapToPt.ts   },
          gap_ms:     gapMs,
          gap_mins:   gapMins,
          dur_label:  durLabel,
          straight_km: Math.round(gapKm * 100) / 100
        });

        events.push({
          type:     'resume',
          label:    `S${segIdx + 1}`,
          gap_min:  gapMins,
          point:    { lat: gapToPt.lat, lng: gapToPt.lng, time_label: gapToPt.time_label, ts: gapToPt.ts }
        });
      }
    }

    // ── Analytics ────────────────────────────────────────────────────────────
    const totalMs       = clean[clean.length-1].ts - clean[0].ts;
    const trackingPct   = totalMs > 0 ? Math.round(((totalMs - downtimeMs) / totalMs) * 100) : 100;
    const firstPoint    = clean[0].time_label;
    const lastPoint     = clean[clean.length-1].time_label;

    const analytics = {
      verified_km:    Math.round(verifiedKm  * 100) / 100,
      estimated_km:   Math.round(estimatedKm * 100) / 100,
      total_km:       Math.round((verifiedKm + estimatedKm) * 100) / 100,
      tracking_pct:   trackingPct,
      downtime_min:   Math.round(downtimeMs / 60000),
      interruptions,
      longest_gap_min: Math.round(longestGapMs / 60000),
      gps_off_min:    Math.round(gpsOffMs / 60000),
      net_off_min:    Math.round(netOffMs / 60000),
      first_point:    firstPoint,
      last_point:     lastPoint,
      total_points:   clean.length
    };

    // ── Security alerts ───────────────────────────────────────────────────────
    const alerts = [];
    if (analytics.gps_off_min > GPS_FLAG_MINS)
      alerts.push({ type: 'gps_off',       value: analytics.gps_off_min,    msg: `GPS off for ${analytics.gps_off_min}min (>${GPS_FLAG_MINS}min threshold)` });
    if (analytics.net_off_min > NET_FLAG_MINS)
      alerts.push({ type: 'net_off',       value: analytics.net_off_min,    msg: `Internet off for ${analytics.net_off_min}min (>${NET_FLAG_MINS}min threshold)` });
    if (interruptions > MAX_INTERRUPTIONS)
      alerts.push({ type: 'interruptions', value: interruptions,            msg: `${interruptions} tracking interruptions today (>${MAX_INTERRUPTIONS} threshold)` });

    // Check for unrealistic speed across any two consecutive clean points
    // Only flag if distance > 50m — smaller gaps are GPS jitter, speed calc is meaningless
    for (let i = 1; i < clean.length; i++) {
      const diffMs = clean[i].ts - clean[i-1].ts;
      const distKm = havKm(clean[i-1], clean[i]);
      const isJitter = (distKm * 1000) < 50;
      const speed  = (!isJitter && diffMs > 0) ? distKm / (diffMs / 3600000) : 0;
      if (speed > MAX_SPEED_KMH) {
        alerts.push({ type: 'speed', value: Math.round(speed), time: clean[i].time_label, msg: `Unrealistic speed ${Math.round(speed)} km/h at ${clean[i].time_label}` });
        break; // only flag once
      }
    }

    res.json({ success: true, data: { segments, events, analytics, alerts } });
  } catch (err) {
    console.error('[getMovementSegmented Error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getMovementHistory = async (req, res) => {
  try {
    const { employee_id, date } = req.query;
    if (!employee_id || !date)
      return res.status(400).json({ success: false, message: 'employee_id and date are required' });

    // Scope check:
    //  - super_admin / hr / KC718 → see all
    //  - employee → can only see their OWN movement history (self-query for multi-live map)
    //  - manager/tl/admin → direct reports only
    const caller = req.user;
    const seeAll = caller.role === 'super_admin' || caller.role === 'hr' || caller.employee_code === CONFIG.cooEmployeeCode;
    if (!seeAll) {
      const isSelf = parseInt(employee_id) === caller.id;
      if (isSelf) {
        // Employee viewing own history — allowed (used by multi-live map for self-dot)
      } else {
        // Manager/admin viewing a report — must be direct report
        const check = await db.query(
          `SELECT id FROM employees WHERE id=$1 AND reporting_manager_id=$2`,
          [employee_id, caller.id]
        );
        if (!check.rows.length) {
          return res.status(403).json({ success: false, message: 'Access denied: not your direct report' });
        }
      }
    }

    const pts = await db.query(
      `SELECT id,
              lat::float  AS lat,
              lng::float  AS lng,
              accuracy,
              TO_CHAR(logged_at AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}', 'HH12:MI:SS AM') AS time_label,
              logged_at
       FROM employee_movement_log
       WHERE employee_id=$1 AND TO_CHAR(logged_at AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}','YYYY-MM-DD')=$2
       ORDER BY logged_at ASC`,
      [employee_id, date]
    );
    res.json({ success: true, data: pts.rows });
  } catch (err) {
    console.error('[getMovementHistory Error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Daily movement summary — employee-wise KM per date ───────────────────
exports.getMovementSummary = async (req, res) => {
  try {
    const { from_date, to_date, employee_id } = req.query;
    const fromD = from_date || getISTDate();
    const toD   = to_date   || getISTDate();

    const caller = req.user;
    const isKC718 = caller.employee_code === CONFIG.cooEmployeeCode;
    const isSuperAdmin = caller.role === 'super_admin';
    // HR can also see all employees
    const isHR = caller.role === 'hr';
    const seeAll = isKC718 || isSuperAdmin || isHR;

    let whereClauses = `TO_CHAR(m.logged_at AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}','YYYY-MM-DD') BETWEEN $1 AND $2`;
    const params = [fromD, toD];

    if (employee_id) {
      // Specific employee requested — apply scope check for non-admins
      if (!seeAll) {
        // Verify this employee is a direct report of the caller
        const check = await db.query(
          `SELECT id FROM employees WHERE id=$1 AND reporting_manager_id=$2`,
          [employee_id, caller.id]
        );
        if (!check.rows.length) {
          return res.status(403).json({ success: false, message: 'Access denied: not your direct report' });
        }
      }
      params.push(employee_id);
      whereClauses += ` AND m.employee_id = $${params.length}`;
    } else if (!seeAll) {
      // Scoped view: only direct reports of this manager/admin/tl
      params.push(caller.id);
      whereClauses += ` AND e.reporting_manager_id = $${params.length}`;
    }

    // Fetch all points ordered by employee + date + time
    const pts = await db.query(
      `SELECT m.employee_id,
              CONCAT(e.first_name,' ',e.last_name)  AS emp_name,
              e.employee_code,
              TO_CHAR(m.logged_at AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}', 'YYYY-MM-DD') AS date,
              m.lat::float AS lat,
              m.lng::float AS lng,
              m.logged_at
       FROM employee_movement_log m
       JOIN employees e ON e.id = m.employee_id
       WHERE ${whereClauses}
       ORDER BY m.employee_id, m.logged_at ASC`,
      params
    );

    // Also fetch all employees who are punched in OR on approved OD on dates in range
    // but have NO movement points — so HR/admin can see who isn't being tracked (0-point rows).
    // FIX: previously only checked attendance punch_in, so OD employees (who don't punch in)
    // were completely invisible in the movement summary table.
    const zeroParams = [fromD, toD];
    let scopeFilter = '';
    if (employee_id) {
      zeroParams.push(employee_id);
      scopeFilter = `AND e.id = $${zeroParams.length}`;
    } else if (!seeAll) {
      zeroParams.push(caller.id);
      scopeFilter = `AND e.reporting_manager_id = $${zeroParams.length}`;
    }

    const zeroPts = await db.query(
      `SELECT DISTINCT e.id AS employee_id,
              CONCAT(e.first_name,' ',e.last_name) AS emp_name,
              e.employee_code,
              day_date AS date
       FROM (
         -- Punched-in employees with no movement points
         SELECT e.id, TO_CHAR(a.date::date, 'YYYY-MM-DD') AS day_date
         FROM attendance a
         JOIN employees e ON e.id = a.employee_id
         WHERE TO_CHAR(a.date::date, 'YYYY-MM-DD') BETWEEN $1 AND $2
           AND a.punch_in IS NOT NULL
           AND e.is_active = true
           ${scopeFilter}

         UNION

         -- OD-approved employees with no movement points (they don't punch in)
         SELECT e.id, od.date::text AS day_date
         FROM od_requests od
         JOIN employees e ON e.id = od.employee_id
         WHERE od.date::text BETWEEN $1 AND $2
           AND od.status = 'approved'
           AND e.is_active = true
           ${scopeFilter}
       ) AS candidates(id, day_date)
       JOIN employees e ON e.id = candidates.id
       WHERE NOT EXISTS (
         SELECT 1 FROM employee_movement_log m2
         WHERE m2.employee_id = candidates.id
           AND TO_CHAR(m2.logged_at AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}','YYYY-MM-DD') = candidates.day_date
       )
       ORDER BY date, emp_name`,
      zeroParams
    );

    // Haversine distance in km
    function haversine(lat1, lon1, lat2, lon2) {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 +
                Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    // Group points by employee+date and compute KM
    const map = {};
    for (const row of pts.rows) {
      const key = `${row.employee_id}_${row.date}`;
      if (!map[key]) {
        map[key] = {
          employee_id : row.employee_id,
          employee_code: row.employee_code,
          emp_name    : row.emp_name,
          date        : row.date,
          points      : [],
          total_km    : 0
        };
      }
      map[key].points.push({ lat: row.lat, lng: row.lng, time: row.logged_at });
    }

    for (const key of Object.keys(map)) {
      const { points } = map[key];
      let km = 0;
      for (let i = 1; i < points.length; i++) {
        km += haversine(points[i-1].lat, points[i-1].lng, points[i].lat, points[i].lng);
      }
      map[key].total_km     = Math.round(km * 100) / 100;
      map[key].point_count  = points.length;
      map[key].first_point  = points[0]  || null;
      map[key].last_point   = points[points.length-1] || null;
      delete map[key].points; // don't send raw points in summary
    }

    // Add zero-point employees (punched in but not tracked)
    for (const row of zeroPts.rows) {
      const key = `${row.employee_id}_${row.date}`;
      if (!map[key]) {
        map[key] = {
          employee_id   : row.employee_id,
          employee_code : row.employee_code,
          emp_name      : row.emp_name,
          date          : row.date,
          total_km      : 0,
          point_count   : 0,
          first_point   : null,
          last_point    : null
        };
      }
    }

    const summary = Object.values(map).sort((a,b) => {
      if (a.date < b.date) return -1;
      if (a.date > b.date) return  1;
      return a.emp_name.localeCompare(b.emp_name);
    });

    res.json({ success: true, data: summary });
  } catch (err) {
    console.error('[getMovementSummary Error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};


// ── HR: Force Regularization for an employee (bypasses employee request) ─────
// Request is created by HR and immediately sent to the employee's reporting manager
exports.forceRegularization = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const actorRole = req.user.role;
    if (!['hr','super_admin'].includes(actorRole))
      return res.status(403).json({ success: false, message: 'Only HR or Super Admin can force regularization' });

    const { employee_id, date, reason, punch_in, punch_out, reg_type } = req.body;
    if (!employee_id || !date || !reason)
      return res.status(400).json({ success: false, message: 'employee_id, date, and reason are required' });

    if (new Date(date) > new Date())
      return res.status(400).json({ success: false, message: 'Cannot regularize a future date' });

    // Get employee details
    const empRes = await client.query(
      `SELECT e.id, e.first_name, e.last_name, e.employee_code,
              e.reporting_manager_id,
              CONCAT(m.first_name,' ',m.last_name) AS manager_name,
              m.id AS manager_id
       FROM employees e
       LEFT JOIN employees m ON e.reporting_manager_id = m.id
       WHERE e.id = $1 AND e.is_active = true`, [employee_id]
    );
    if (!empRes.rows.length)
      return res.status(404).json({ success: false, message: 'Employee not found' });

    const emp = empRes.rows[0];

    // Upsert attendance record with pending regularization
    await client.query(
      `INSERT INTO attendance(employee_id, date, status, regularization_status, regularization_reason,
                              regularization_punch_in, regularization_punch_out, regularization_requested_at)
       VALUES($1,$2,COALESCE((SELECT status FROM attendance WHERE employee_id=$1 AND date=$2),'absent'),'pending',$3,$4,$5,NOW())
       ON CONFLICT(employee_id, date) DO UPDATE
         SET regularization_status      = 'pending',
             regularization_reason      = EXCLUDED.regularization_reason,
             regularization_punch_in    = EXCLUDED.regularization_punch_in,
             regularization_punch_out   = EXCLUDED.regularization_punch_out,
             regularization_requested_at= NOW()`,
      [employee_id, date, `[HR Force] ${reason}`, punch_in || null, punch_out || null]
    );

    // Notify the reporting manager of the employee
    if (emp.manager_id) {
      const notifMsg = `HR has forced an attendance regularization for ${emp.first_name} ${emp.last_name} (${emp.employee_code}) on ${date}. Reason: ${reason}. Please review and approve/reject.`;
      await client.query(
        `INSERT INTO notifications(employee_id, title, message, type)
         VALUES($1,'📋 HR Forced Regularization',$2,'regularization')`,
        [emp.manager_id, notifMsg]
      );
    }

    // Also notify the employee
    await client.query(
      `INSERT INTO notifications(employee_id, title, message, type)
       VALUES($1,'📋 Attendance Regularization Submitted','HR has submitted an attendance regularization request for your record on ${date}. It is pending approval from your reporting manager.','regularization')`,
      [employee_id]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      message: `Regularization forced for ${emp.first_name} ${emp.last_name} on ${date}. Request sent to manager: ${emp.manager_name || 'Not assigned'}.`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ── Attendance Report: Absent Days per Employee ───────────────────────────────
exports.getAbsentReport = async (req, res) => {
  try {
    const role = req.user.role;
    if (!['hr','super_admin','admin','accounts'].includes(role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const mon  = parseInt(req.query.month) || new Date().getMonth() + 1;
    const yr   = parseInt(req.query.year)  || new Date().getFullYear();
    const search = req.query.search || '';
    const department_id = req.query.department_id ? parseInt(req.query.department_id) : null;

    const numDays = new Date(yr, mon, 0).getDate();

    // Build weekly off days (2nd & 4th Saturday + Sunday)
    const weeklyOff = new Set();
    for (let d = 1; d <= numDays; d++) {
      const dt  = new Date(yr, mon - 1, d);
      const dow = dt.getDay();
      if (dow === 0) { weeklyOff.add(d); continue; }
      if (dow === 6) {
        let satCount = 0;
        for (let dd = 1; dd <= d; dd++)
          if (new Date(yr, mon - 1, dd).getDay() === 6) satCount++;
        if (satCount === 2 || satCount === 4) weeklyOff.add(d);
      }
    }

    const holidays = await db.query(
      `SELECT TO_CHAR(date,'YYYY-MM-DD') AS ds FROM holidays
       WHERE EXTRACT(MONTH FROM date)=$1 AND EXTRACT(YEAR FROM date)=$2`, [mon, yr]
    );
    const holSet = new Set(holidays.rows.map(h => h.ds));

    // Fetch employees
    let empWhere = 'WHERE e.is_active = true';
    let empParams = [];
    let pidx = 1;
    if (department_id) { empWhere += ` AND e.department_id = $${pidx++}`; empParams.push(department_id); }
    if (search) {
      empWhere += ` AND (LOWER(CONCAT(e.first_name,' ',e.last_name)) LIKE $${pidx} OR LOWER(e.employee_code) LIKE $${pidx})`;
      empParams.push(`%${search.toLowerCase()}%`);
      pidx++;
    }
    const employees = await db.query(
      `SELECT e.id, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name,
              d.name AS department, des.title AS designation
       FROM employees e
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       ${empWhere} ORDER BY d.name, e.first_name`, empParams
    );

    // Fetch attendance
    let attQ = `SELECT employee_id, EXTRACT(DAY FROM date)::int AS day, status, TO_CHAR(date,'YYYY-MM-DD') AS ds
                FROM attendance
                WHERE EXTRACT(MONTH FROM date)=$1 AND EXTRACT(YEAR FROM date)=$2`;
    let attP = [mon, yr];
    if (department_id) { attQ += ` AND employee_id IN (SELECT id FROM employees WHERE department_id=$3)`; attP.push(department_id); }
    const attendance = await db.query(attQ, attP);

    const attIndex = {};
    for (const rec of attendance.rows) {
      if (!attIndex[rec.employee_id]) attIndex[rec.employee_id] = {};
      attIndex[rec.employee_id][rec.day] = rec;
    }

    const workingDays = numDays - weeklyOff.size - holSet.size;

    const report = employees.rows.map(emp => {
      const empAtt = attIndex[emp.id] || {};
      const absentDates = [];
      let absentCount = 0;

      for (let d = 1; d <= numDays; d++) {
        const ds = `${yr}-${String(mon).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        if (holSet.has(ds) || weeklyOff.has(d)) continue;
        const rec = empAtt[d];
        if (!rec || rec.status === 'absent') {
          absentDates.push(ds);
          absentCount++;
        }
      }

      return {
        employee_code: emp.employee_code,
        name: emp.name,
        department: emp.department || '—',
        designation: emp.designation || '—',
        working_days: workingDays,
        absent_count: absentCount,
        absent_dates: absentDates
      };
    });

    res.json({ success: true, month: mon, year: yr, working_days: workingDays, count: report.length, data: report });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get Employee Absent/Late Dates for a Month (for bulk force-regularize UI) ──
exports.getEmpAbsentDates = async (req, res) => {
  try {
    const role = req.user.role;
    if (!['hr','super_admin'].includes(role))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const empId = parseInt(req.query.employee_id);
    const mon   = parseInt(req.query.month)  || new Date().getMonth() + 1;
    const yr    = parseInt(req.query.year)   || new Date().getFullYear();

    if (!empId) return res.status(400).json({ success: false, message: 'employee_id required' });

    const numDays = new Date(yr, mon, 0).getDate();
    const today   = new Date(); today.setHours(0,0,0,0);

    // Holidays
    const holidays = await db.query(
      `SELECT TO_CHAR(date,'YYYY-MM-DD') AS ds FROM holidays
       WHERE EXTRACT(MONTH FROM date)=$1 AND EXTRACT(YEAR FROM date)=$2`, [mon, yr]
    );
    const holSet = new Set(holidays.rows.map(h => h.ds));

    // Weekly offs (Sunday + 2nd & 4th Saturday)
    const weeklyOff = new Set();
    for (let d = 1; d <= numDays; d++) {
      const dt = new Date(yr, mon - 1, d);
      const dow = dt.getDay();
      if (dow === 0) { weeklyOff.add(d); continue; }
      if (dow === 6) {
        let satCount = 0;
        for (let dd = 1; dd <= d; dd++)
          if (new Date(yr, mon - 1, dd).getDay() === 6) satCount++;
        if (satCount === 2 || satCount === 4) weeklyOff.add(d);
      }
    }

    // Attendance records
    const att = await db.query(
      `SELECT TO_CHAR(date,'YYYY-MM-DD') AS ds, status, punch_in, punch_out,
              regularization_status
       FROM attendance
       WHERE employee_id=$1
         AND EXTRACT(MONTH FROM date)=$2
         AND EXTRACT(YEAR FROM date)=$3`,
      [empId, mon, yr]
    );
    const attMap = {};
    for (const r of att.rows) attMap[r.ds] = r;

    // Approved leaves
    const leaves = await db.query(
      `SELECT generate_series(start_date, end_date, '1 day'::interval)::date AS d
       FROM leave_requests
       WHERE employee_id=$1 AND status='approved'
         AND EXTRACT(MONTH FROM start_date)=$2 AND EXTRACT(YEAR FROM start_date)=$3
         OR (employee_id=$1 AND status='approved'
             AND EXTRACT(MONTH FROM end_date)=$2 AND EXTRACT(YEAR FROM end_date)=$3)`,
      [empId, mon, yr]
    ).catch(() => ({ rows: [] }));
    const leaveSet = new Set(leaves.rows.map(r => {
      const d = new Date(r.d);
      return `${yr}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }));

    const days = [];
    for (let d = 1; d <= numDays; d++) {
      const ds  = `${yr}-${String(mon).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dt  = new Date(yr, mon - 1, d);
      if (dt > today) continue;                         // skip future
      if (holSet.has(ds) || weeklyOff.has(d)) continue; // skip holiday/off
      if (leaveSet.has(ds)) continue;                   // skip approved leave

      const rec = attMap[ds];
      const status = rec?.status || 'absent';
      const regStatus = rec?.regularization_status || null;

      // Only include absent / late / half-day / missing_punch_out
      if (!['absent','late','half-day','missing_punch_out'].includes(status)) continue;
      // Skip already pending/approved regularizations
      if (regStatus === 'pending' || regStatus === 'approved') continue;

      days.push({
        date:      ds,
        status,
        punch_in:  rec?.punch_in  || null,
        punch_out: rec?.punch_out || null,
        reg_status: regStatus
      });
    }

    res.json({ success: true, data: days });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Bulk Force Regularization ──────────────────────────────────────────────────
exports.bulkForceRegularization = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const actorRole = req.user.role;
    if (!['hr','super_admin'].includes(actorRole))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const { employee_id, dates, reason, punch_in, punch_out } = req.body;
    // dates: array of { date, punch_in?, punch_out? }
    if (!employee_id || !Array.isArray(dates) || !dates.length || !reason)
      return res.status(400).json({ success: false, message: 'employee_id, dates[], and reason are required' });

    // Get employee
    const empRes = await client.query(
      `SELECT e.id, e.first_name, e.last_name, e.employee_code,
              e.reporting_manager_id,
              CONCAT(m.first_name,' ',m.last_name) AS manager_name,
              m.id AS manager_id
       FROM employees e
       LEFT JOIN employees m ON e.reporting_manager_id = m.id
       WHERE e.id=$1 AND e.is_active=true`, [employee_id]
    );
    if (!empRes.rows.length)
      return res.status(404).json({ success: false, message: 'Employee not found' });
    const emp = empRes.rows[0];

    let successCount = 0;
    const errors = [];

    for (const entry of dates) {
      const { date, punch_in: pi, punch_out: po } = entry;
      if (!date) continue;
      if (new Date(date) > new Date()) { errors.push(`${date}: future date`); continue; }

      const usePunchIn  = pi  || punch_in  || null;
      const usePunchOut = po  || punch_out || null;

      try {
        await client.query(
          `INSERT INTO attendance(employee_id, date, status, regularization_status, regularization_reason,
                                  regularization_punch_in, regularization_punch_out, regularization_requested_at)
           VALUES($1,$2,
             COALESCE((SELECT status FROM attendance WHERE employee_id=$1 AND date=$2),'absent'),
             'pending',$3,$4,$5,NOW())
           ON CONFLICT(employee_id, date) DO UPDATE
             SET regularization_status       = 'pending',
                 regularization_reason       = EXCLUDED.regularization_reason,
                 regularization_punch_in     = EXCLUDED.regularization_punch_in,
                 regularization_punch_out    = EXCLUDED.regularization_punch_out,
                 regularization_requested_at = NOW()`,
          [employee_id, date, `[HR Force] ${reason}`, usePunchIn, usePunchOut]
        );
        successCount++;
      } catch (e) {
        errors.push(`${date}: ${e.message}`);
      }
    }

    // Notify manager
    if (emp.manager_id && successCount > 0) {
      const dateList = dates.map(d => d.date).join(', ');
      await client.query(
        `INSERT INTO notifications(employee_id, title, message, type)
         VALUES($1,'📋 HR Forced Regularization',$2,'regularization')`,
        [emp.manager_id,
         `HR has forced attendance regularization for ${emp.first_name} ${emp.last_name} (${emp.employee_code}) on ${successCount} date(s): ${dateList}. Reason: ${reason}. Please review.`]
      );
    }
    // Notify employee
    if (successCount > 0) {
      await client.query(
        `INSERT INTO notifications(employee_id, title, message, type)
         VALUES($1,'📋 Bulk Attendance Regularization Submitted',$2,'regularization')`,
        [employee_id,
         `HR has submitted attendance regularization for ${successCount} date(s). Pending approval from your reporting manager.`]
      );
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      submitted: successCount,
      errors,
      message: `${successCount} regularization(s) submitted for ${emp.first_name} ${emp.last_name}. Sent to manager: ${emp.manager_name || 'Not assigned'}.`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};
