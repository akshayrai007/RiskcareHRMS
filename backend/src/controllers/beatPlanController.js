const CONFIG = require('../Main_file');
// src/controllers/beatPlanController.js
// ─────────────────────────────────────────────────────────────────────────────
// Feature #7 — Beat Plan / Journey Plan (PJP)
//
// A Beat Plan is a pre-assigned daily route for field/sales employees.
// HR/manager assigns stops (client locations) to an employee for a given date.
// The employee sees their planned route on the map.
// The movement map shows PLANNED vs ACTUAL side-by-side.
//
// DB Tables (created by migrate_all.js):
//   beat_plans          — one plan per employee per date
//   beat_plan_stops     — ordered list of stops within a plan
//
// Endpoints:
//   POST   /attendance/beat-plan              — create/update plan (HR/manager)
//   GET    /attendance/beat-plan              — list plans (scoped by role)
//   GET    /attendance/beat-plan/:id          — get one plan with stops
//   DELETE /attendance/beat-plan/:id          — delete plan
//   POST   /attendance/beat-plan/:id/stop     — add a stop
//   DELETE /attendance/beat-plan/stop/:stopId — remove a stop
//   GET    /attendance/beat-plan/compare      — planned vs actual GPS for a date
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../config/db');

function getISTDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

// ── Create / Update Beat Plan ─────────────────────────────────────────────────

exports.createPlan = async (req, res) => {
  try {
    const { employee_id, plan_date, title, notes, stops } = req.body;
    if (!employee_id || !plan_date)
      return res.status(400).json({ success: false, message: 'employee_id and plan_date required' });

    const createdBy = req.user.id;

    // Upsert plan
    const planRes = await db.query(`
      INSERT INTO beat_plans (employee_id, plan_date, title, notes, created_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (employee_id, plan_date)
      DO UPDATE SET
        title      = EXCLUDED.title,
        notes      = EXCLUDED.notes,
        updated_at = NOW()
      RETURNING id
    `, [employee_id, plan_date, title || 'Beat Plan', notes || null, createdBy]);

    const planId = planRes.rows[0].id;

    // If stops provided, replace all stops
    if (Array.isArray(stops) && stops.length) {
      await db.query(`DELETE FROM beat_plan_stops WHERE plan_id = $1`, [planId]);
      for (let i = 0; i < stops.length; i++) {
        const s = stops[i];
        await db.query(`
          INSERT INTO beat_plan_stops
            (plan_id, sequence, location_name, address, lat, lng, notes, expected_arrival)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          planId, i + 1,
          s.location_name || `Stop ${i + 1}`,
          s.address || null,
          s.lat || null,
          s.lng || null,
          s.notes || null,
          s.expected_arrival || null
        ]);
      }
    }

    // Notify the employee
    await db.query(`
      INSERT INTO notifications (employee_id, type, title, message)
      VALUES ($1, 'beat_plan', '📍 Beat Plan Assigned',
        $2)
    `, [
      employee_id,
      `Your beat plan for ${plan_date} has been ${planRes.rows[0].id ? 'updated' : 'created'} with ${(stops || []).length} stop(s).`
    ]);

    res.json({ success: true, message: 'Beat plan saved', plan_id: planId });
  } catch (err) {
    console.error('[createPlan]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── List Plans ────────────────────────────────────────────────────────────────

exports.listPlans = async (req, res) => {
  try {
    const { employee_id, from_date, to_date, date } = req.query;
    const caller = req.user;
    const seeAll = ['hr', 'super_admin', 'admin'].includes(caller.role);

    const fromD = from_date || date || getISTDate();
    const toD   = to_date   || date || getISTDate();

    const params = [fromD, toD];
    let scopeCond = '';
    let idx = 3;

    if (!seeAll) {
      // Employee sees own; manager sees direct reports
      if (caller.role === 'employee') {
        params.push(caller.id);
        scopeCond = `AND bp.employee_id = $${idx++}`;
      } else {
        params.push(caller.id);
        scopeCond = `AND (e.reporting_manager_id = $${idx++} OR bp.created_by = $${idx - 1})`;
      }
    }

    if (employee_id) {
      params.push(parseInt(employee_id));
      scopeCond += ` AND bp.employee_id = $${idx++}`;
    }

    const result = await db.query(`
      SELECT
        bp.id,
        bp.employee_id,
        CONCAT(e.first_name,' ',e.last_name) AS emp_name,
        e.employee_code,
        bp.plan_date,
        bp.title,
        bp.notes,
        bp.created_at,
        bp.updated_at,
        CONCAT(c.first_name,' ',c.last_name) AS created_by_name,
        COUNT(bps.id) AS stop_count,
        -- Check if employee has actual movement data for this date
        EXISTS(
          SELECT 1 FROM employee_movement_log ml
          WHERE ml.employee_id = bp.employee_id
            AND DATE(ml.logged_at AT TIME ZONE '${CONFIG.timezone}') = bp.plan_date
        ) AS has_actual_data
      FROM beat_plans bp
      JOIN employees e ON e.id = bp.employee_id
      LEFT JOIN employees c ON c.id = bp.created_by
      LEFT JOIN beat_plan_stops bps ON bps.plan_id = bp.id
      WHERE bp.plan_date BETWEEN $1 AND $2
        ${scopeCond}
      GROUP BY bp.id, e.first_name, e.last_name, e.employee_code,
               c.first_name, c.last_name
      ORDER BY bp.plan_date DESC, emp_name ASC
    `, params);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[listPlans]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get One Plan with Stops ───────────────────────────────────────────────────

exports.getPlan = async (req, res) => {
  try {
    const { id } = req.params;

    const planRes = await db.query(`
      SELECT bp.*, CONCAT(e.first_name,' ',e.last_name) AS emp_name, e.employee_code
      FROM beat_plans bp
      JOIN employees e ON e.id = bp.employee_id
      WHERE bp.id = $1
    `, [id]);

    if (!planRes.rows.length)
      return res.status(404).json({ success: false, message: 'Plan not found' });

    const plan = planRes.rows[0];

    const stopsRes = await db.query(`
      SELECT id, sequence, location_name, address,
             lat::float, lng::float, notes, expected_arrival, visit_status
      FROM beat_plan_stops
      WHERE plan_id = $1
      ORDER BY sequence ASC
    `, [id]);

    res.json({ success: true, data: { ...plan, stops: stopsRes.rows } });
  } catch (err) {
    console.error('[getPlan]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Delete Plan ───────────────────────────────────────────────────────────────

exports.deletePlan = async (req, res) => {
  try {
    const { id } = req.params;
    await db.query(`DELETE FROM beat_plan_stops WHERE plan_id = $1`, [id]);
    const result = await db.query(`DELETE FROM beat_plans WHERE id = $1 RETURNING id`, [id]);
    if (!result.rows.length)
      return res.status(404).json({ success: false, message: 'Plan not found' });
    res.json({ success: true, message: 'Plan deleted' });
  } catch (err) {
    console.error('[deletePlan]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Add Stop ──────────────────────────────────────────────────────────────────

exports.addStop = async (req, res) => {
  try {
    const { id: plan_id } = req.params;
    const { location_name, address, lat, lng, notes, expected_arrival } = req.body;
    if (!location_name)
      return res.status(400).json({ success: false, message: 'location_name required' });

    // Get next sequence number
    const seqRes = await db.query(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM beat_plan_stops WHERE plan_id = $1`,
      [plan_id]
    );
    const seq = seqRes.rows[0].next_seq;

    const result = await db.query(`
      INSERT INTO beat_plan_stops
        (plan_id, sequence, location_name, address, lat, lng, notes, expected_arrival)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [plan_id, seq, location_name, address || null, lat || null, lng || null, notes || null, expected_arrival || null]);

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[addStop]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Remove Stop ───────────────────────────────────────────────────────────────

exports.removeStop = async (req, res) => {
  try {
    const { stopId } = req.params;
    const result = await db.query(`DELETE FROM beat_plan_stops WHERE id=$1 RETURNING id`, [stopId]);
    if (!result.rows.length)
      return res.status(404).json({ success: false, message: 'Stop not found' });
    res.json({ success: true, message: 'Stop removed' });
  } catch (err) {
    console.error('[removeStop]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Compare Planned vs Actual ─────────────────────────────────────────────────
// Returns planned stops + actual GPS route for the same employee+date.
// The MovementFragment uses this to draw both on the same map.

exports.comparePlanVsActual = async (req, res) => {
  try {
    const { employee_id, date } = req.query;
    if (!employee_id || !date)
      return res.status(400).json({ success: false, message: 'employee_id and date required' });

    // Get the beat plan for this date
    const planRes = await db.query(`
      SELECT bp.id, bp.title, bp.notes
      FROM beat_plans bp
      WHERE bp.employee_id = $1 AND bp.plan_date = $2
      LIMIT 1
    `, [employee_id, date]);

    let plan = null;
    let stops = [];

    if (planRes.rows.length) {
      plan = planRes.rows[0];
      const stopsRes = await db.query(`
        SELECT id, sequence, location_name, address,
               lat::float, lng::float, notes, expected_arrival, visit_status
        FROM beat_plan_stops
        WHERE plan_id = $1
        ORDER BY sequence ASC
      `, [plan.id]);
      stops = stopsRes.rows;
    }

    // Get actual GPS route
    const actualRes = await db.query(`
      SELECT
        lat::float, lng::float, accuracy,
        TO_CHAR(logged_at AT TIME ZONE '${CONFIG.timezone}', 'HH12:MI AM') AS time_label,
        logged_at,
        battery,
        gps_status,
        internet_status
      FROM employee_movement_log
      WHERE employee_id = $1
        AND DATE(logged_at AT TIME ZONE '${CONFIG.timezone}') = $2
      ORDER BY logged_at ASC
    `, [employee_id, date]);

    // Compute coverage: for each planned stop, find nearest actual GPS point
    // and flag whether employee came within 500m (visited)
    const stopsWithCoverage = stops.map(stop => {
      if (!stop.lat || !stop.lng || !actualRes.rows.length) {
        return { ...stop, visited: false, nearest_dist_m: null };
      }
      let minDist = Infinity;
      let nearestTime = null;
      for (const pt of actualRes.rows) {
        const dist = haversineM(stop.lat, stop.lng, pt.lat, pt.lng);
        if (dist < minDist) {
          minDist = dist;
          nearestTime = pt.time_label;
        }
      }
      const visited = minDist <= 500;
      return {
        ...stop,
        visited,
        nearest_dist_m: Math.round(minDist),
        nearest_time: nearestTime,
        visit_status: visited ? 'visited' : 'missed'
      };
    });

    // Coverage summary
    const visitedCount = stopsWithCoverage.filter(s => s.visited).length;
    const coverage = stops.length > 0
      ? Math.round((visitedCount / stops.length) * 100)
      : null;

    res.json({
      success: true,
      data: {
        plan,
        stops: stopsWithCoverage,
        actual_points: actualRes.rows,
        summary: {
          planned_stops:  stops.length,
          visited_stops:  visitedCount,
          missed_stops:   stops.length - visitedCount,
          coverage_pct:   coverage,
          actual_points:  actualRes.rows.length
        }
      }
    });
  } catch (err) {
    console.error('[comparePlanVsActual]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Haversine distance in metres ──────────────────────────────────────────────
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

