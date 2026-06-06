const CONFIG = require('../Main_file');
// src/controllers/movementAlertsController.js
// ─────────────────────────────────────────────────────────────────────────────
// Feature #10 — Low Battery / No GPS / Tracking Silence Alerts
//
// What it does:
//   1. checkTrackingSilence() — scans all punched-in field employees and flags
//      anyone whose last movement ping was more than SILENCE_THRESHOLD_MINS ago.
//      Called by cron every 30 minutes during work hours.
//
//   2. getActiveAlerts() — HR/admin endpoint to see current unresolved alerts.
//
//   3. resolveAlert() — mark an alert as resolved (HR dismisses it).
//
//   4. getEmployeeAlertHistory() — per-employee alert log.
//
// Alert types:
//   - 'silence'      : no GPS ping for >30 min while punched in
//   - 'low_battery'  : battery < 15% reported in last ping
//   - 'gps_off'      : gps_status = false in last ping
//   - 'net_off'      : internet_status = false in last ping
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../config/db');

const SILENCE_THRESHOLD_MINS = 30;  // flag if no ping for 30+ min
const LOW_BATTERY_PCT        = 15;  // flag if battery <= 15%

// ── Helpers ───────────────────────────────────────────────────────────────────

function getISTDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.timezone || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function getISTHour() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: CONFIG.timezone || 'Asia/Kolkata' })).getHours();
}

// ── Core scanner — called by cron ─────────────────────────────────────────────

exports.checkTrackingSilence = async () => {
  const today = getISTDate();
  const hour  = getISTHour();

  // Only check during work hours 9:00–21:00 IST
  if (hour < 9 || hour >= 21) return { checked: 0, alerts: 0 };

  try {
    // Get all employees who are punched in today and not yet punched out
    // AND have approved tracking (employment_type = field/offsite OR have OD today)
    const activeEmps = await db.query(`
      SELECT DISTINCT
        e.id          AS employee_id,
        CONCAT(e.first_name,' ',e.last_name) AS emp_name,
        e.employee_code,
        e.employment_type,
        e.reporting_manager_id,
        a.punch_in
      FROM attendance a
      JOIN employees e ON e.id = a.employee_id
      WHERE a.date = $1
        AND a.punch_in IS NOT NULL
        AND a.punch_out IS NULL
        AND e.is_active = true
        AND (
          e.employment_type NOT IN ('office','onsite','on_site','wfh','work_from_home','hybrid')
          OR EXISTS (
            SELECT 1 FROM od_requests od
            WHERE od.employee_id = e.id AND od.date = $1 AND od.status = 'approved'
          )
        )
    `, [today]);

    if (!activeEmps.rows.length) return { checked: 0, alerts: 0 };

    let alertsCreated = 0;

    for (const emp of activeEmps.rows) {
      // Get their last movement ping
      const lastPing = await db.query(`
        SELECT
          lat::float, lng::float,
          accuracy,
          gps_status,
          internet_status,
          battery,
          logged_at,
          EXTRACT(EPOCH FROM (NOW() - logged_at)) / 60 AS mins_ago
        FROM employee_movement_log
        WHERE employee_id = $1
        ORDER BY logged_at DESC LIMIT 1
      `, [emp.employee_id]);

      const ping = lastPing.rows[0];
      const minsAgo = ping ? Math.round(parseFloat(ping.mins_ago)) : null;

      // ── Check silence ──────────────────────────────────────────────────────
      const isSilent = !ping || minsAgo >= SILENCE_THRESHOLD_MINS;
      if (isSilent) {
        await upsertAlert(emp, 'silence', {
          message: ping
            ? `No GPS ping for ${minsAgo} minutes (threshold: ${SILENCE_THRESHOLD_MINS} min)`
            : `No movement data recorded today despite being punched in`,
          last_seen: ping?.logged_at || null,
          mins_ago: minsAgo
        });
        alertsCreated++;
      } else {
        // Resolve any existing silence alert if employee is back online
        await resolveAutoAlert(emp.employee_id, 'silence');
      }

      if (!ping) continue;

      // ── Check low battery ──────────────────────────────────────────────────
      if (ping.battery !== null && ping.battery !== undefined && ping.battery <= LOW_BATTERY_PCT) {
        await upsertAlert(emp, 'low_battery', {
          message: `Battery at ${ping.battery}% — tracking may stop soon`,
          battery: ping.battery,
          last_seen: ping.logged_at
        });
        alertsCreated++;
      } else {
        await resolveAutoAlert(emp.employee_id, 'low_battery');
      }

      // ── Check GPS off ──────────────────────────────────────────────────────
      if (ping.gps_status === false) {
        await upsertAlert(emp, 'gps_off', {
          message: `GPS turned off — location tracking stopped`,
          last_seen: ping.logged_at
        });
        alertsCreated++;
      } else {
        await resolveAutoAlert(emp.employee_id, 'gps_off');
      }

      // ── Check internet off ─────────────────────────────────────────────────
      if (ping.internet_status === false) {
        await upsertAlert(emp, 'net_off', {
          message: `Internet turned off — GPS points queued locally, not synced`,
          last_seen: ping.logged_at
        });
        alertsCreated++;
      } else {
        await resolveAutoAlert(emp.employee_id, 'net_off');
      }
    }

    console.log(`[TrackingAlerts] Checked ${activeEmps.rows.length} employees, created/updated ${alertsCreated} alerts`);
    return { checked: activeEmps.rows.length, alerts: alertsCreated };

  } catch (err) {
    console.error('[TrackingAlerts] checkTrackingSilence error:', err.message);
    return { checked: 0, alerts: 0 };
  }
};

// Insert or update an alert (upsert by employee_id + type + date)
async function upsertAlert(emp, type, details) {
  const today = getISTDate();
  try {
    await db.query(`
      INSERT INTO movement_alerts
        (employee_id, alert_date, alert_type, message, details, status, notified_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, 'open', NOW())
      ON CONFLICT (employee_id, alert_date, alert_type)
      DO UPDATE SET
        message    = EXCLUDED.message,
        details    = EXCLUDED.details,
        status     = CASE WHEN movement_alerts.status = 'resolved' THEN 'open' ELSE movement_alerts.status END,
        updated_at = NOW()
    `, [
      emp.employee_id, today, type,
      details.message,
      JSON.stringify({ ...details, emp_name: emp.emp_name, emp_code: emp.employee_code })
    ]);

    // Push in-app notification to reporting manager (once per alert per day)
    if (emp.reporting_manager_id) {
      const alreadyNotified = await db.query(`
        SELECT id FROM movement_alerts
        WHERE employee_id = $1 AND alert_date = $2 AND alert_type = $3
          AND manager_notified = true
      `, [emp.employee_id, today, type]);

      if (!alreadyNotified.rows.length) {
        const emoji = { silence: '📵', low_battery: '🔋', gps_off: '📍', net_off: '📶' }[type] || '⚠️';
        await db.query(`
          INSERT INTO notifications (employee_id, type, title, message)
          VALUES ($1, 'tracking_alert', $2, $3)
        `, [
          emp.reporting_manager_id,
          `${emoji} Tracking Alert — ${emp.emp_name}`,
          details.message
        ]);

        await db.query(`
          UPDATE movement_alerts SET manager_notified = true
          WHERE employee_id = $1 AND alert_date = $2 AND alert_type = $3
        `, [emp.employee_id, today, type]);
      }
    }
  } catch (err) {
    console.error(`[TrackingAlerts] upsertAlert error (${type}):`, err.message);
  }
}

// Auto-resolve an alert when the condition clears
async function resolveAutoAlert(employeeId, type) {
  const today = getISTDate();
  try {
    await db.query(`
      UPDATE movement_alerts
      SET status = 'auto_resolved', resolved_at = NOW()
      WHERE employee_id = $1 AND alert_date = $2 AND alert_type = $3 AND status = 'open'
    `, [employeeId, today, type]);
  } catch (err) {
    // Non-fatal
  }
}

// ── API: Get active alerts (HR/admin) ─────────────────────────────────────────

exports.getActiveAlerts = async (req, res) => {
  try {
    const { date, employee_id, type, status = 'open' } = req.query;
    const today = date || getISTDate();
    const caller = req.user;

    let scopeCond = '';
    const params = [today];
    let idx = 2;

    // Scope: HR/super_admin see all; manager sees direct reports
    const seeAll = ['hr', 'super_admin', 'admin'].includes(caller.role);
    if (!seeAll) {
      params.push(caller.id);
      scopeCond += ` AND e.reporting_manager_id = $${idx++}`;
    }
    if (employee_id) {
      params.push(parseInt(employee_id));
      scopeCond += ` AND ma.employee_id = $${idx++}`;
    }
    if (type) {
      params.push(type);
      scopeCond += ` AND ma.alert_type = $${idx++}`;
    }
    if (status !== 'all') {
      params.push(status);
      scopeCond += ` AND ma.status = $${idx++}`;
    }

    const result = await db.query(`
      SELECT
        ma.id,
        ma.employee_id,
        CONCAT(e.first_name,' ',e.last_name) AS emp_name,
        e.employee_code,
        d.name AS department,
        ma.alert_date,
        ma.alert_type,
        ma.message,
        ma.details,
        ma.status,
        ma.notified_at,
        ma.resolved_at,
        ma.resolved_by,
        ma.resolution_note,
        ma.updated_at,
        -- Last ping info
        (SELECT TO_CHAR(logged_at AT TIME ZONE CONFIG.timezone || 'Asia/Kolkata','HH12:MI AM')
         FROM employee_movement_log
         WHERE employee_id = ma.employee_id
         ORDER BY logged_at DESC LIMIT 1) AS last_ping_time,
        -- Mins since last ping
        (SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - logged_at)) / 60)
         FROM employee_movement_log
         WHERE employee_id = ma.employee_id
         ORDER BY logged_at DESC LIMIT 1) AS mins_since_last_ping
      FROM movement_alerts ma
      JOIN employees e ON e.id = ma.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE ma.alert_date = $1 ${scopeCond}
      ORDER BY
        CASE ma.alert_type
          WHEN 'silence'      THEN 1
          WHEN 'low_battery'  THEN 2
          WHEN 'gps_off'      THEN 3
          WHEN 'net_off'      THEN 4
          ELSE 5
        END,
        ma.notified_at DESC
    `, params);

    // Summary counts
    const summary = {
      total:    result.rows.length,
      silence:  result.rows.filter(r => r.alert_type === 'silence').length,
      low_battery: result.rows.filter(r => r.alert_type === 'low_battery').length,
      gps_off:  result.rows.filter(r => r.alert_type === 'gps_off').length,
      net_off:  result.rows.filter(r => r.alert_type === 'net_off').length,
    };

    res.json({ success: true, data: result.rows, summary });
  } catch (err) {
    console.error('[getActiveAlerts]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── API: Resolve an alert ─────────────────────────────────────────────────────

exports.resolveAlert = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    const result = await db.query(`
      UPDATE movement_alerts
      SET status = 'resolved', resolved_at = NOW(), resolved_by = $1, resolution_note = $2
      WHERE id = $3
      RETURNING id
    `, [req.user.id, note || null, id]);

    if (!result.rows.length)
      return res.status(404).json({ success: false, message: 'Alert not found' });

    res.json({ success: true, message: 'Alert resolved' });
  } catch (err) {
    console.error('[resolveAlert]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── API: Alert history for one employee ───────────────────────────────────────

exports.getEmployeeAlertHistory = async (req, res) => {
  try {
    const { employee_id } = req.params;
    const { days = 7 } = req.query;

    const result = await db.query(`
      SELECT
        ma.id, ma.alert_date, ma.alert_type, ma.message,
        ma.status, ma.notified_at, ma.resolved_at, ma.resolution_note,
        ma.details
      FROM movement_alerts ma
      WHERE ma.employee_id = $1
        AND ma.alert_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
      ORDER BY ma.alert_date DESC, ma.notified_at DESC
    `, [employee_id, parseInt(days)]);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[getEmployeeAlertHistory]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
