const CONFIG = require('../Main_file');
// src/controllers/geofenceController.js — COMPLETE
const db = require('../config/db');

// Haversine distance in meters
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// ── Get All Locations ─────────────────────────────────────────────────────────
exports.getLocations = async (req, res) => {
  try {
    const role   = req.user.role;
    const userId = req.user.id;

    let q, params = [];
    if (['admin','super_admin'].includes(role)) {
      q = `SELECT ol.*,
                  -- Count employees from employee_geofence (office/universal assignments)
                  -- PLUS employees from employee_buffer_rules whose district/state matches
                  -- the location name (district/state zone assignments).
                  (
                    COUNT(DISTINCT eg_emp.id)
                    +
                    -- District match: location is a district zone AND district name matches
                    (SELECT COUNT(DISTINCT ebr.employee_id)
                     FROM employee_buffer_rules ebr
                     JOIN employees emp ON emp.id = ebr.employee_id AND emp.is_active = TRUE
                     WHERE ebr.rule_type = 'district'
                       AND LOWER(ol.name) LIKE 'district%'
                       AND LOWER(ol.name) LIKE '%' || LOWER(COALESCE(ebr.district,'')) || '%'
                       AND NOT EXISTS (
                         SELECT 1 FROM employee_geofence eg2
                         WHERE eg2.employee_id = ebr.employee_id AND eg2.office_location_id = ol.id
                       )
                    )
                    +
                    -- State match: location is a state zone AND state name matches
                    (SELECT COUNT(DISTINCT ebr.employee_id)
                     FROM employee_buffer_rules ebr
                     JOIN employees emp ON emp.id = ebr.employee_id AND emp.is_active = TRUE
                     WHERE ebr.rule_type = 'state'
                       AND LOWER(ol.name) LIKE 'state%'
                       AND LOWER(ol.name) LIKE '%' || LOWER(COALESCE(ebr.state,'')) || '%'
                       AND NOT EXISTS (
                         SELECT 1 FROM employee_geofence eg2
                         WHERE eg2.employee_id = ebr.employee_id AND eg2.office_location_id = ol.id
                       )
                    )
                  ) AS assigned_count,
                  CONCAT(e.first_name,' ',e.last_name) AS created_by_name
           FROM office_locations ol
           LEFT JOIN employee_geofence eg ON ol.id = eg.office_location_id
           LEFT JOIN employees eg_emp ON eg_emp.id = eg.employee_id AND eg_emp.is_active = TRUE
           LEFT JOIN employees e ON ol.created_by = e.id
           GROUP BY ol.id, e.first_name, e.last_name
           ORDER BY ol.name`;
    } else {
      q = `SELECT DISTINCT ol.*,
                  CONCAT(e.first_name,' ',e.last_name) AS created_by_name
           FROM office_locations ol
           LEFT JOIN employee_geofence eg ON ol.id = eg.office_location_id
           LEFT JOIN employees e ON ol.created_by = e.id
           WHERE ol.is_active = true
             AND (eg.is_universal = true OR eg.employee_id IN (
               SELECT id FROM employees WHERE team_leader_id=$1 OR reporting_manager_id=$1
             ) OR ol.created_by=$1)
           ORDER BY ol.name`;
      params = [userId];
    }

    const r = await db.query(q, params);

    // True global distinct count — only employees actually visible under a location card.
    // Universal buffer-rule employees without a geofence row are NOT counted here
    // because they don't appear under any specific location card.
    const globalRes = await db.query(
      `SELECT COUNT(DISTINCT emp_id) AS cnt FROM (
         -- Employees assigned via employee_geofence (office locations + any universal assigned to a specific card)
         SELECT eg.employee_id AS emp_id
         FROM employee_geofence eg
         JOIN employees e ON e.id = eg.employee_id AND e.is_active = TRUE
         UNION
         -- District-rule employees counted under a matching district zone card
         SELECT ebr.employee_id AS emp_id
         FROM employee_buffer_rules ebr
         JOIN employees e ON e.id = ebr.employee_id AND e.is_active = TRUE
         WHERE ebr.rule_type = 'district'
           AND EXISTS (
             SELECT 1 FROM office_locations ol
             WHERE LOWER(ol.name) LIKE 'district%'
               AND LOWER(ol.name) LIKE '%' || LOWER(COALESCE(ebr.district,'')) || '%'
               AND ol.is_active = TRUE
           )
           AND NOT EXISTS (SELECT 1 FROM employee_geofence eg2 WHERE eg2.employee_id = ebr.employee_id)
         UNION
         -- State-rule employees counted under a matching state zone card
         SELECT ebr.employee_id AS emp_id
         FROM employee_buffer_rules ebr
         JOIN employees e ON e.id = ebr.employee_id AND e.is_active = TRUE
         WHERE ebr.rule_type = 'state'
           AND EXISTS (
             SELECT 1 FROM office_locations ol
             WHERE LOWER(ol.name) LIKE 'state%'
               AND LOWER(ol.name) LIKE '%' || LOWER(COALESCE(ebr.state,'')) || '%'
               AND ol.is_active = TRUE
           )
           AND NOT EXISTS (SELECT 1 FROM employee_geofence eg2 WHERE eg2.employee_id = ebr.employee_id)
       ) sub`
    );
    const globalAssignedCount = parseInt(globalRes.rows[0]?.cnt || 0);
    res.json({ success: true, data: r.rows, global_assigned_count: globalAssignedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Create Location ───────────────────────────────────────────────────────────
exports.createLocation = async (req, res) => {
  try {
    const { name, latitude, longitude, radius_meters = 100, address } = req.body;
    if (!name || !latitude || !longitude)
      return res.status(400).json({ success: false, message: 'name, latitude, longitude required' });

    const r = await db.query(
      `INSERT INTO office_locations(name, latitude, longitude, radius_meters, address, created_by)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, latitude, longitude, radius_meters, address, req.user.id]
    );
    res.status(201).json({ success: true, message: 'Location created', data: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Update Location ───────────────────────────────────────────────────────────
exports.updateLocation = async (req, res) => {
  try {
    const { name, latitude, longitude, radius_meters, address, is_active } = req.body;
    const sets = [], params = [];
    let idx = 1;
    if (name          !== undefined) { sets.push(`name=$${idx++}`);           params.push(name); }
    if (latitude      !== undefined) { sets.push(`latitude=$${idx++}`);       params.push(latitude); }
    if (longitude     !== undefined) { sets.push(`longitude=$${idx++}`);      params.push(longitude); }
    if (radius_meters !== undefined) { sets.push(`radius_meters=$${idx++}`);  params.push(radius_meters); }
    if (address       !== undefined) { sets.push(`address=$${idx++}`);        params.push(address); }
    if (is_active     !== undefined) { sets.push(`is_active=$${idx++}`);      params.push(is_active); }
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nothing to update' });
    sets.push(`updated_at=NOW()`);
    params.push(parseInt(req.params.id));
    await db.query(`UPDATE office_locations SET ${sets.join(',')} WHERE id=$${idx}`, params);
    res.json({ success: true, message: 'Updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Delete Location (Hard Delete) ─────────────────────────────────────────────
exports.deleteLocation = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const locId = parseInt(req.params.id);

    // 1. Check if any active employees are mapped to this location
    // FIX: Also check district/state employees tracked only in employee_buffer_rules
    const locRes = await client.query(
      `SELECT name FROM office_locations WHERE id = $1`, [locId]
    );
    const locName = locRes.rows[0]?.name || '';

    const mappedRes = await client.query(
      `-- Direct geofence assignments
       SELECT e.id, CONCAT(e.first_name,' ',e.last_name) AS name, e.employee_code
       FROM employee_geofence eg
       JOIN employees e ON e.id = eg.employee_id
       WHERE eg.office_location_id = $1 AND e.is_active = TRUE

       UNION

       -- District employees tracked via buffer_rules (no employee_geofence row)
       SELECT e.id, CONCAT(e.first_name,' ',e.last_name) AS name, e.employee_code
       FROM employee_buffer_rules ebr
       JOIN employees e ON e.id = ebr.employee_id
       WHERE ebr.rule_type = 'district'
         AND e.is_active = TRUE
         AND LOWER($2) LIKE 'district%'
         AND LOWER($2) LIKE '%' || LOWER(COALESCE(ebr.district,'')) || '%'

       UNION

       -- State employees tracked via buffer_rules (no employee_geofence row)
       SELECT e.id, CONCAT(e.first_name,' ',e.last_name) AS name, e.employee_code
       FROM employee_buffer_rules ebr
       JOIN employees e ON e.id = ebr.employee_id
       WHERE ebr.rule_type = 'state'
         AND e.is_active = TRUE
         AND LOWER($2) LIKE 'state%'
         AND LOWER($2) LIKE '%' || LOWER(COALESCE(ebr.state,'')) || '%'`,
      [locId, locName]
    );

    if (mappedRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        blocked: true,
        count: mappedRes.rows.length,
        employees: mappedRes.rows
      });
    }

    // 2. Nullify FK in attendance_geofence_logs (no ON DELETE rule)
    await client.query(
      `UPDATE attendance_geofence_logs SET office_location_id = NULL WHERE office_location_id = $1`,
      [locId]
    );

    // 3. Hard delete — employee_geofence cascades automatically
    await client.query(`DELETE FROM office_locations WHERE id = $1`, [locId]);

    await client.query('COMMIT');
    res.json({ success: true, message: 'Location permanently deleted' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
};

// ── Get employees assigned to a location ─────────────────────────────────────
exports.getLocationEmployees = async (req, res) => {
  try {
    const { id } = req.params;

    // Get location name so we can match district/state employees from buffer_rules
    const locRes = await db.query(
      `SELECT id, name FROM office_locations WHERE id = $1`, [id]
    );
    if (!locRes.rows.length)
      return res.status(404).json({ success: false, message: 'Location not found' });

    const locName = locRes.rows[0].name;

    const result = await db.query(
      `-- Employees directly assigned via employee_geofence (office/universal)
       SELECT e.id, e.employee_code, e.first_name, e.last_name,
              d.name AS department_name, eg.is_universal,
              ebr.rule_type, ebr.district, ebr.state
       FROM employee_geofence eg
       JOIN employees e ON e.id = eg.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN employee_buffer_rules ebr ON ebr.employee_id = e.id
       WHERE eg.office_location_id = $1 AND e.is_active = TRUE

       UNION

       -- District employees: buffer_rules has district that matches this location name
       SELECT e.id, e.employee_code, e.first_name, e.last_name,
              d.name AS department_name, FALSE AS is_universal,
              ebr.rule_type, ebr.district, ebr.state
       FROM employee_buffer_rules ebr
       JOIN employees e ON e.id = ebr.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE ebr.rule_type = 'district'
         AND e.is_active = TRUE
         AND LOWER($2) LIKE 'district%'
         AND LOWER($2) LIKE '%' || LOWER(COALESCE(ebr.district,'')) || '%'
         AND e.id NOT IN (
           SELECT employee_id FROM employee_geofence WHERE office_location_id = $1
         )

       UNION

       -- State employees: buffer_rules has state that matches this location name
       SELECT e.id, e.employee_code, e.first_name, e.last_name,
              d.name AS department_name, FALSE AS is_universal,
              ebr.rule_type, ebr.district, ebr.state
       FROM employee_buffer_rules ebr
       JOIN employees e ON e.id = ebr.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE ebr.rule_type = 'state'
         AND e.is_active = TRUE
         AND LOWER($2) LIKE 'state%'
         AND LOWER($2) LIKE '%' || LOWER(COALESCE(ebr.state,'')) || '%'
         AND e.id NOT IN (
           SELECT employee_id FROM employee_geofence WHERE office_location_id = $1
         )

       ORDER BY first_name`,
      [id, locName]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get employees NOT yet assigned to THIS location, filtered by city ─────────
// Logic:
//   1. Get the location name (e.g. "Corporate Office – Delhi" → keyword "Delhi")
//      Also check location address for city keyword.
//   2. Return ONLY employees whose city matches that keyword AND are not yet
//      assigned to this location.
//   3. Special case: State-wide locations (radius >= 500000) show employees
//      whose city matches the state name in the location name.
//   4. "Work From Home" location shows all unassigned employees regardless of city.
exports.getUnassignedEmployees = async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch the location details first
    const locRes = await db.query(
      `SELECT id, name, address, radius_meters FROM office_locations WHERE id = $1`,
      [id]
    );
    if (!locRes.rows.length)
      return res.status(404).json({ success: false, message: 'Location not found' });

    const loc = locRes.rows[0];
    const locNameLower = loc.name.toLowerCase();
    const locAddrLower = (loc.address || '').toLowerCase();

    // ── Special case: Work From Home — show ALL unassigned employees ──────────
    if (locNameLower.includes('work from home') || locNameLower.includes('wfh') || locNameLower.includes('remote')) {
      const result = await db.query(
        `SELECT e.id, e.employee_code, e.first_name, e.last_name,
                d.name AS department_name, e.city
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         WHERE e.is_active = TRUE
           AND e.id NOT IN (
             SELECT employee_id FROM employee_geofence
             WHERE office_location_id = $1
           )
         ORDER BY e.first_name`,
        [id]
      );
      return res.json({ success: true, data: result.rows });
    }

    // ── Extract city keyword from location name ────────────────────────────────
    // Location names follow patterns like:
    //   "Corporate Office – Delhi"
    //   "Krishi Care HQ – Mumbai"
    //   "State – Andhra Pradesh"
    //   "State – Maharashtra"
    // We extract the part after "–" or "-" as the city/state keyword.
    let cityKeyword = '';

    const dashMatch = loc.name.match(/[–\-—]\s*(.+)$/);
    if (dashMatch) {
      cityKeyword = dashMatch[1].trim().toLowerCase();
    } else {
      // Fallback: use full location name
      cityKeyword = locNameLower;
    }

    // Clean up common prefixes like "state – " 
    cityKeyword = cityKeyword.replace(/^state\s*[–\-—]\s*/i, '').trim();

    // ── City keyword aliases ───────────────────────────────────────────────────
    // Map location keywords → possible values in employee city field
    const cityAliases = {
      'delhi':             ['delhi', 'new delhi', 'delhi ncr'],
      'mumbai':            ['mumbai', 'bombay', 'navi mumbai', 'thane'],
      'andhra pradesh':    ['andhra pradesh', 'andra pradesh', 'andhra', 'andra', 'ap', 'hyderabad', 'vijayawada', 'visakhapatnam'],
      'karnataka':         ['karnataka', 'bengaluru', 'bangalore', 'mysuru', 'mysore'],
      'maharastra':        ['maharastra', 'maharashtra', 'pune', 'nagpur', 'nashik', 'aurangabad', 'solapur'],
      'maharashtra':       ['maharastra', 'maharashtra', 'pune', 'nagpur', 'nashik', 'aurangabad', 'solapur'],
      'odisha':            ['odisha', 'orissa', 'bhubaneswar', 'cuttack'],
      'tamil nadu':        ['tamil nadu', 'tamilnadu', 'tn', 'chennai', 'coimbatore', 'madurai'],
    };

    // Get all possible city values for this location
    let matchCities = [cityKeyword];
    for (const [key, aliases] of Object.entries(cityAliases)) {
      if (cityKeyword.includes(key) || key.includes(cityKeyword)) {
        matchCities = [...new Set([...matchCities, ...aliases])];
        break;
      }
    }

    // Build ILIKE conditions for city matching
    const cityConditions = matchCities.map((_, i) => `LOWER(COALESCE(e.city,'')) ILIKE $${i + 2}`).join(' OR ');
    const cityParams = matchCities.map(c => `%${c}%`);

    const result = await db.query(
      `SELECT e.id, e.employee_code, e.first_name, e.last_name,
              d.name AS department_name, e.city
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.is_active = TRUE
         AND e.id NOT IN (
           SELECT employee_id FROM employee_geofence
           WHERE office_location_id = $1
         )
         AND (${cityConditions})
       ORDER BY e.first_name`,
      [id, ...cityParams]
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Validate Punch (called before punch-in/out) ───────────────────────────────
exports.validatePunch = async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const empId = req.user.id;

    if (!latitude || !longitude)
      return res.json({ success: true, data: { valid: true, message: 'No GPS provided — punch allowed', distance: 0 } });

    // ── Step 1: Check employee_buffer_rules (global / state / district access) ─
    const bufferRule = await db.query(
      `SELECT rule_type, state, district FROM employee_buffer_rules WHERE employee_id = $1 LIMIT 1`,
      [empId]
    );

    if (bufferRule.rows.length) {
      const rule = bufferRule.rows[0];
      // Universal / global access — always allow from anywhere
      if (rule.rule_type === 'universal' || rule.rule_type === 'global') {
        await db.query(
          `INSERT INTO attendance_geofence_logs
             (employee_id, office_location_id, employee_lat, employee_lng, distance_meters, is_within_geofence, punch_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [empId, null, latitude, longitude, 0, true, req.body.punch_type || 'in']
        ).catch(() => {});
        return res.json({
          success: true,
          data: { valid: true, message: 'Global access — punch allowed from any location', distance: 0, location_name: 'Global Access' }
        });
      }
      // State or district level — also allow (they have broad zone access)
      if (rule.rule_type === 'state' || rule.rule_type === 'district') {
        await db.query(
          `INSERT INTO attendance_geofence_logs
             (employee_id, office_location_id, employee_lat, employee_lng, distance_meters, is_within_geofence, punch_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [empId, null, latitude, longitude, 0, true, req.body.punch_type || 'in']
        ).catch(() => {});
        const zone = rule.rule_type === 'district' ? rule.district : rule.state;
        return res.json({
          success: true,
          data: { valid: true, message: `${rule.rule_type} access (${zone}) — punch allowed`, distance: 0, location_name: zone || 'Zone Access' }
        });
      }
    }

    // ── Step 2: Check employee_geofence (office location assignments) ──────────
    const buffers = await db.query(
      `SELECT ol.*, eg.is_universal
       FROM employee_geofence eg
       JOIN office_locations ol ON eg.office_location_id = ol.id
       WHERE eg.employee_id = $1 AND ol.is_active = true`,
      [empId]
    );

    if (!buffers.rows.length)
      return res.json({ success: true, data: { valid: true, message: 'No buffer assigned — punch allowed from anywhere', distance: 0 } });

    // If employee has ANY universal assignment → always allow
    const hasUniversal = buffers.rows.some(b => b.is_universal);
    if (hasUniversal) {
      // ── Log the punch ────────────────────────────────────────────────────────
      await db.query(
        `INSERT INTO attendance_geofence_logs
           (employee_id, office_location_id, employee_lat, employee_lng, distance_meters, is_within_geofence, punch_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [empId, buffers.rows[0].office_location_id || null,
         latitude, longitude, 0, true, req.body.punch_type || 'in']
      ).catch(() => {}); // non-fatal if log fails
      return res.json({
        success: true,
        data: {
          valid: true,
          message: 'Universal access — punch allowed from any location',
          distance: 0
        }
      });
    }

    let minDist = Infinity, closestBuf = null;
    for (const buf of buffers.rows) {
      const dist = haversine(latitude, longitude, parseFloat(buf.latitude), parseFloat(buf.longitude));
      if (dist < minDist) { minDist = dist; closestBuf = buf; }
      if (dist <= buf.radius_meters) {
        // ── Log valid punch ───────────────────────────────────────────────────
        await db.query(
          `INSERT INTO attendance_geofence_logs
             (employee_id, office_location_id, employee_lat, employee_lng, distance_meters, is_within_geofence, punch_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [empId, buf.id, latitude, longitude, Math.round(dist), true, req.body.punch_type || 'in']
        ).catch(() => {});
        return res.json({
          success: true,
          data: {
            valid: true,
            message: `Within ${buf.name} buffer (${dist}m from center)`,
            distance: dist,
            location_id: buf.id,
            location_name: buf.name
          }
        });
      }
    }

    // ── Log invalid punch (outside all buffers) ───────────────────────────────
    await db.query(
      `INSERT INTO attendance_geofence_logs
         (employee_id, office_location_id, employee_lat, employee_lng, distance_meters, is_within_geofence, punch_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [empId, closestBuf?.id || null, latitude, longitude,
       Math.round(minDist), false, req.body.punch_type || 'in']
    ).catch(() => {});

    res.json({
      success: true,
      data: {
        valid: false,
        message: `Outside all buffers. Nearest: ${closestBuf?.name} (${minDist}m away, limit: ${closestBuf?.radius_meters}m)`,
        distance: minDist,
        location_id: closestBuf?.id,
        location_name: closestBuf?.name
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get Geofence Logs ─────────────────────────────────────────────────────────
exports.getLogs = async (req, res) => {
  try {
    const { employee_id, from_date, to_date, limit = 100 } = req.query;
    const userId = req.user.id, role = req.user.role;

    let conds = [], params = [], idx = 1;

    if (role === 'manager') {
      conds.push(`gl.employee_id IN (
        SELECT id FROM employees WHERE department_id=(SELECT department_id FROM employees WHERE id=$${idx++})
      )`);
      params.push(userId);
    } else if (role === 'tl') {
      conds.push(`gl.employee_id IN (SELECT id FROM employees WHERE team_leader_id=$${idx++})`);
      params.push(userId);
    }

    if (employee_id) { conds.push(`gl.employee_id=$${idx++}`); params.push(employee_id); }
    if (from_date)   { conds.push(`(gl.created_at AT TIME ZONE 'UTC' AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}')::date>=$${idx++}`); params.push(from_date); }
    if (to_date)     { conds.push(`(gl.created_at AT TIME ZONE 'UTC' AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}')::date<=$${idx++}`); params.push(to_date); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const r = await db.query(
      `SELECT gl.*,
              -- FIX: Convert UTC created_at to IST for display
              (gl.created_at AT TIME ZONE 'UTC' AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}') AS created_at_ist,
              TO_CHAR(gl.created_at AT TIME ZONE 'UTC' AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}', 'DD/MM/YYYY, HH12:MI:SS AM') AS punch_time_ist,
              CONCAT(e.first_name,' ',e.last_name) AS employee_name,
              e.employee_code, d.name AS department_name,
              ol.name AS location_name
       FROM attendance_geofence_logs gl
       JOIN employees e ON gl.employee_id = e.id
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN office_locations ol ON gl.office_location_id = ol.id
       ${where}
       ORDER BY gl.created_at DESC
       LIMIT $${idx}`,
      [...params, limit]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get Employee Geofence Assignments ─────────────────────────────────────────
exports.getEmployeeGeofence = async (req, res) => {
  try {
    const empId = parseInt(req.params.employee_id);
    const [assigned, universal] = await Promise.all([
      db.query(
        `SELECT eg.*, ol.name, ol.latitude, ol.longitude, ol.radius_meters, ol.address, ol.is_active
         FROM employee_geofence eg
         JOIN office_locations ol ON eg.office_location_id = ol.id
         WHERE eg.employee_id = $1 AND ol.is_active = true`,
        [empId]
      ),
      db.query(
        `SELECT ol.* FROM office_locations ol
         WHERE ol.is_active = true
           AND EXISTS (SELECT 1 FROM employee_geofence eg WHERE eg.office_location_id=ol.id AND eg.is_universal=true)`
      )
    ]);
    res.json({ success: true, data: assigned.rows, universal_buffers: universal.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Assign Buffer to Employee ─────────────────────────────────────────────────
exports.assignBuffer = async (req, res) => {
  const client = await db.getClient();
  try {
    const { employee_id, office_location_id, is_universal = false } = req.body;
    if (!employee_id || !office_location_id)
      return res.status(400).json({ success: false, message: 'employee_id and office_location_id required' });

    await client.query('BEGIN');

    // Insert/update the geofence row
    await client.query(
      `INSERT INTO employee_geofence(employee_id, office_location_id, is_universal, assigned_by)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(employee_id, office_location_id)
       DO UPDATE SET is_universal=$3, assigned_by=$4`,
      [employee_id, office_location_id, is_universal, req.user.id]
    );

    // FIX: Sync employee_buffer_rules so the employee is no longer treated as
    // district/state — otherwise the old rule_type lingers and breaks display queries.
    const ruleType = is_universal ? 'universal' : 'office';
    await client.query(
      `INSERT INTO employee_buffer_rules (employee_id, rule_type, state, district, assigned_by, updated_at)
       VALUES ($1, $2, NULL, NULL, $3, NOW())
       ON CONFLICT (employee_id)
       DO UPDATE SET rule_type = $2, state = NULL, district = NULL, assigned_by = $3, updated_at = NOW()`,
      [employee_id, ruleType, req.user.id]
    );

    // FIX: Also update employee_type to match
    await client.query(
      `UPDATE employees SET employee_type = $1 WHERE id = $2`,
      [is_universal ? 'offsite' : 'onsite', employee_id]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: `Buffer assigned${is_universal ? ' (universal)' : ''}` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
};

// ── Bulk Assign Buffer ────────────────────────────────────────────────────────
exports.bulkAssignBuffer = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { employee_ids, office_location_id, is_universal = false } = req.body;
    if (!employee_ids?.length || !office_location_id)
      return res.status(400).json({ success: false, message: 'employee_ids[] and office_location_id required' });

    const ruleType = is_universal ? 'universal' : 'office';
    const empType  = is_universal ? 'offsite'   : 'onsite';

    for (const eid of employee_ids) {
      // Delete ALL old geofence rows so employee moves cleanly to the new office
      await client.query(`DELETE FROM employee_geofence WHERE employee_id = $1`, [eid]);
      // Insert the new geofence row (ON CONFLICT safety net in case of race condition)
      await client.query(
        `INSERT INTO employee_geofence(employee_id, office_location_id, is_universal, assigned_by)
         VALUES($1,$2,$3,$4)
         ON CONFLICT (employee_id, office_location_id)
         DO UPDATE SET is_universal = $3, assigned_by = $4`,
        [eid, office_location_id, is_universal, req.user.id]
      );

      // FIX: Sync buffer rule — clears any stale district/state rule so employee
      // is no longer counted under the old district card
      await client.query(
        `INSERT INTO employee_buffer_rules (employee_id, rule_type, state, district, assigned_by, updated_at)
         VALUES ($1, $2, NULL, NULL, $3, NOW())
         ON CONFLICT (employee_id)
         DO UPDATE SET rule_type = $2, state = NULL, district = NULL, assigned_by = $3, updated_at = NOW()`,
        [eid, ruleType, req.user.id]
      );

      // FIX: Sync employee_type
      await client.query(
        `UPDATE employees SET employee_type = $1 WHERE id = $2`,
        [empType, eid]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, message: `Buffer assigned to ${employee_ids.length} employees` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ── Remove Buffer from Employee ───────────────────────────────────────────────
exports.removeBuffer = async (req, res) => {
  try {
    const { employee_id, location_id } = req.params;
    // Remove from employee_geofence
    await db.query(
      'DELETE FROM employee_geofence WHERE employee_id=$1 AND office_location_id=$2',
      [employee_id, location_id]
    );
    // Also remove from employee_buffer_rules (so punch validation doesn't grant access)
    await db.query(
      'DELETE FROM employee_buffer_rules WHERE employee_id=$1',
      [employee_id]
    );
    res.json({ success: true, message: 'Buffer assignment removed' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Toggle Universal/Specific for already-assigned employee ───────────────────
exports.toggleUniversal = async (req, res) => {
  try {
    const { employee_id, location_id } = req.params;
    const { is_universal } = req.body;
    if (is_universal === undefined)
      return res.status(400).json({ success: false, message: 'is_universal required' });

    // UPSERT — works even if employee had no employee_geofence row (e.g. was universal-rule only)
    await db.query(
      `INSERT INTO employee_geofence (employee_id, office_location_id, is_universal, assigned_by)
       VALUES ($3, $4, $1, $2)
       ON CONFLICT (employee_id, office_location_id)
       DO UPDATE SET is_universal = $1, assigned_by = $2`,
      [is_universal, req.user.id, employee_id, location_id]
    );

    // Also sync employee_buffer_rules to match
    const ruleType = is_universal ? 'universal' : 'office';
    await db.query(
      `INSERT INTO employee_buffer_rules (employee_id, rule_type, assigned_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (employee_id)
       DO UPDATE SET rule_type = $2, assigned_by = $3, updated_at = NOW()`,
      [employee_id, ruleType, req.user.id]
    );

    res.json({ success: true, message: `Access changed to ${is_universal ? 'Universal' : 'Specific'}` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get employees with NO geofence assignment (unassigned to any location) ────
exports.getUnassignedToAnyLocation = async (req, res) => {
  try {
    const r = await db.query(
      `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.city, e.state,
              d.name AS department_name, e.employee_type,
              ebr.rule_type
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN employee_buffer_rules ebr ON ebr.employee_id = e.id
       WHERE e.is_active = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM employee_geofence eg WHERE eg.employee_id = e.id
         )
       ORDER BY e.first_name`
    );
    res.json({ success: true, data: r.rows, count: r.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Fix: Reset wrongly-universal employees under office locations ─────────────
exports.fixOfficeUniversal = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const wrongRes = await client.query(
      `SELECT eg.employee_id, eg.office_location_id
       FROM employee_geofence eg
       JOIN office_locations ol ON ol.id = eg.office_location_id
       WHERE ol.radius_meters < 10000 AND eg.is_universal = TRUE`
    );
    let fixed = 0;
    for (const row of wrongRes.rows) {
      await client.query(`UPDATE employee_geofence SET is_universal = FALSE WHERE employee_id = $1 AND office_location_id = $2`, [row.employee_id, row.office_location_id]);
      await client.query(`INSERT INTO employee_buffer_rules (employee_id, rule_type, state, district, assigned_by, updated_at) VALUES ($1, 'office', NULL, NULL, $2, NOW()) ON CONFLICT (employee_id) DO UPDATE SET rule_type = 'office', state = NULL, district = NULL, assigned_by = $2, updated_at = NOW()`, [row.employee_id, req.user.id]);
      await client.query(`UPDATE employees SET employee_type = 'onsite' WHERE id = $1`, [row.employee_id]);
      fixed++;
    }
    await client.query("COMMIT");
    res.json({ success: true, message: `Fixed ${fixed} employee(s)`, fixed });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ success: false, message: "Server error" });
  } finally { client.release(); }
};

// ── Get Employees for Location (used by frontend assign panel) ────────────────
// Returns TWO groups:
//   assigned: employees already assigned to this location (with is_universal flag)
//   unassigned: employees of the SAME CITY not yet assigned here
exports.getEmployeesForLocation = async (req, res) => {
  try {
    const locationId = req.query.location_id;

    if (!locationId) {
      // No location selected — return empty
      return res.json({ success: true, data: [] });
    }

    // Get location details
    const locRes = await db.query(
      `SELECT id, name, address, radius_meters FROM office_locations WHERE id = $1`,
      [locationId]
    );
    if (!locRes.rows.length)
      return res.status(404).json({ success: false, message: 'Location not found' });

    const loc = locRes.rows[0];
    const locNameLower = loc.name.toLowerCase();

    // ── 1. Get ASSIGNED employees ─────────────────────────────────────────────
    // Also fetch employees with universal buffer rule who are NOT in employee_geofence
    // (they were assigned universal access via the buffer-rules page, not geofence-tab)
    const assignedRes = await db.query(
      `SELECT e.id, e.employee_code,
              CONCAT(e.first_name,' ',e.last_name) AS full_name,
              d.name AS department_name, e.role, e.city,
              eg.is_universal,
              TRUE AS is_assigned_here,
              $2::text AS assigned_location_name,
              CASE WHEN eg.is_universal THEN 'Universal' ELSE 'Specific' END AS buffer_type
       FROM employee_geofence eg
       JOIN employees e ON e.id = eg.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE eg.office_location_id = $1 AND e.is_active = TRUE
       UNION
       -- Employees with universal buffer rule (no specific location assignment)
       SELECT e.id, e.employee_code,
              CONCAT(e.first_name,' ',e.last_name) AS full_name,
              d.name AS department_name, e.role, e.city,
              TRUE AS is_universal,
              TRUE AS is_assigned_here,
              $2::text AS assigned_location_name,
              'Universal' AS buffer_type
       FROM employee_buffer_rules ebr
       JOIN employees e ON e.id = ebr.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE ebr.rule_type = 'universal'
         AND e.is_active = TRUE
         AND e.id NOT IN (SELECT employee_id FROM employee_geofence WHERE office_location_id = $1)
       UNION
       -- Employees assigned to this district via buffer_rules (district rule, district name matches location name)
       SELECT e.id, e.employee_code,
              CONCAT(e.first_name,' ',e.last_name) AS full_name,
              d.name AS department_name, e.role, e.city,
              FALSE AS is_universal,
              TRUE AS is_assigned_here,
              $2::text AS assigned_location_name,
              'District' AS buffer_type
       FROM employee_buffer_rules ebr
       JOIN employees e ON e.id = ebr.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE ebr.rule_type = 'district'
         AND e.is_active = TRUE
         AND LOWER($2) LIKE 'district%'
         AND LOWER($2) LIKE '%' || LOWER(COALESCE(ebr.district,'')) || '%'
         AND e.id NOT IN (SELECT employee_id FROM employee_geofence WHERE office_location_id = $1)
       UNION
       -- Employees assigned to this state zone via buffer_rules (state rule, state name matches location name)
       SELECT e.id, e.employee_code,
              CONCAT(e.first_name,' ',e.last_name) AS full_name,
              d.name AS department_name, e.role, e.city,
              FALSE AS is_universal,
              TRUE AS is_assigned_here,
              $2::text AS assigned_location_name,
              'State' AS buffer_type
       FROM employee_buffer_rules ebr
       JOIN employees e ON e.id = ebr.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE ebr.rule_type = 'state'
         AND e.is_active = TRUE
         AND LOWER($2) LIKE 'state%'
         AND LOWER($2) LIKE '%' || LOWER(COALESCE(ebr.state,'')) || '%'
         AND e.id NOT IN (SELECT employee_id FROM employee_geofence WHERE office_location_id = $1)
       ORDER BY full_name`,
      [locationId, loc.name]
    );

    // ── 2. Get UNASSIGNED employees of same city ──────────────────────────────
    // Work From Home: show all unassigned
    if (locNameLower.includes('work from home') || locNameLower.includes('wfh') || locNameLower.includes('remote')) {
      const unassignedRes = await db.query(
        `SELECT e.id, e.employee_code,
                CONCAT(e.first_name,' ',e.last_name) AS full_name,
                d.name AS department_name, e.role, e.city,
                FALSE AS is_universal,
                FALSE AS is_assigned_here,
                NULL AS assigned_location_name,
                'Not assigned' AS buffer_type
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         WHERE e.is_active = TRUE
           AND e.id NOT IN (SELECT employee_id FROM employee_geofence WHERE office_location_id = $1)
         ORDER BY e.first_name`,
        [locationId]
      );
      return res.json({
        success: true,
        data: [...assignedRes.rows, ...unassignedRes.rows]
      });
    }

    // Extract city keyword from location name (after – or -)
    let cityKeyword = '';
    const dashMatch = loc.name.match(/[–\-—]\s*(.+)$/);
    if (dashMatch) {
      cityKeyword = dashMatch[1].trim().toLowerCase();
    } else {
      cityKeyword = locNameLower;
    }
    cityKeyword = cityKeyword.replace(/^state\s*[–\-—]\s*/i, '').trim();

    // City aliases map
    const cityAliases = {
      'delhi':          ['delhi', 'new delhi', 'delhi ncr'],
      'mumbai':         ['mumbai', 'bombay', 'navi mumbai', 'thane'],
      'andhra pradesh': ['andhra pradesh', 'andra pradesh', 'andhra', 'andra'],
      'karnataka':      ['karnataka', 'bengaluru', 'bangalore'],
      'maharastra':     ['maharastra', 'maharashtra'],
      'maharashtra':    ['maharastra', 'maharashtra'],
      'odisha':         ['odisha', 'orissa'],
      'tamil nadu':     ['tamil nadu', 'tamilnadu'],
    };

    let matchCities = [cityKeyword];
    for (const [key, aliases] of Object.entries(cityAliases)) {
      if (cityKeyword.includes(key) || key.includes(cityKeyword)) {
        matchCities = [...new Set([...matchCities, ...aliases])];
        break;
      }
    }

    const cityConditions = matchCities.map((_, i) => `LOWER(COALESCE(e.city,'')) ILIKE $${i + 2}`).join(' OR ');
    const cityParams = matchCities.map(c => `%${c}%`);

    const unassignedRes = await db.query(
      `SELECT e.id, e.employee_code,
              CONCAT(e.first_name,' ',e.last_name) AS full_name,
              d.name AS department_name, e.role, e.city,
              FALSE AS is_universal,
              FALSE AS is_assigned_here,
              NULL AS assigned_location_name,
              'Not assigned' AS buffer_type
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.is_active = TRUE
         AND e.id NOT IN (SELECT employee_id FROM employee_geofence WHERE office_location_id = $1)
         AND (${cityConditions})
       ORDER BY e.first_name`,
      [locationId, ...cityParams]
    );

    res.json({
      success: true,
      data: [...assignedRes.rows, ...unassignedRes.rows]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get employee's own assigned geofence locations (for mobile map) ────────────
exports.getMyLocations = async (req, res) => {
  try {
    const empId = req.user.id;

    const result = await db.query(
      `SELECT ol.id, ol.name, ol.address,
              CAST(ol.latitude AS FLOAT)       AS latitude,
              CAST(ol.longitude AS FLOAT)      AS longitude,
              ol.radius_meters,
              eg.is_universal
       FROM employee_geofence eg
       JOIN office_locations ol ON ol.id = eg.office_location_id
       WHERE eg.employee_id = $1
         AND ol.is_active = true
       ORDER BY ol.name`,
      [empId]
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
//  EMPLOYEE BUFFER RULES — state / district / office / universal
// ══════════════════════════════════════════════════════════════════════════════
const DISTRICT_BOUNDARIES = require('../config/district_boundaries_geo_simplified.json');

/**
 * Ray-casting point-in-polygon for GeoJSON rings.
 * coords = [[lng,lat], ...] (GeoJSON order)
 */
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInGeometry(lng, lat, geometry) {
  if (geometry.type === 'Polygon') {
    return pointInRing(lng, lat, geometry.coordinates[0]);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some(poly => pointInRing(lng, lat, poly[0]));
  }
  return false;
}

/**
 * Resolve { state, district } from lat/lng using real polygon boundaries.
 * Returns { state, district } or null if outside all known districts.
 */
function resolveLocation(lat, lng) {
  for (const [stateName, districts] of Object.entries(DISTRICT_BOUNDARIES)) {
    for (const d of districts) {
      if (pointInGeometry(lng, lat, d.geometry)) {
        return { state: stateName, district: d.district };
      }
    }
  }
  return null;
}

/**
 * Core validation — rule_type ALWAYS takes priority over employee_type.
 * Returns { valid: Boolean, message: String, outside_boundary?: Boolean }
 */
async function validateEmployeeBuffer(empId, latitude, longitude) {
  // No GPS → allow
  if (!latitude || !longitude)
    return { valid: true, message: 'No GPS — punch allowed' };

  // Get buffer rule (rule_type drives everything)
  const ruleRes = await db.query(
    `SELECT ebr.*, e.employee_type
     FROM employee_buffer_rules ebr
     JOIN employees e ON e.id = ebr.employee_id
     WHERE ebr.employee_id = $1`,
    [empId]
  );

  // No rule assigned → allow (shouldn't happen after seeding)
  if (!ruleRes.rows.length)
    return { valid: true, message: 'No rule assigned — punch allowed' };

  const rule = ruleRes.rows[0];

  // ── UNIVERSAL → punch from anywhere ──────────────────────────────────────
  if (rule.rule_type === 'universal')
    return { valid: true, message: 'Universal access — punch allowed from anywhere' };

  // ── OFFICE → must be within office radius ─────────────────────────────────
  if (rule.rule_type === 'office') {
    const buffers = await db.query(
      `SELECT ol.* FROM employee_geofence eg
       JOIN office_locations ol ON eg.office_location_id = ol.id
       WHERE eg.employee_id = $1 AND ol.is_active = true`,
      [empId]
    );
    if (!buffers.rows.length)
      return { valid: true, message: 'No office assigned — punch allowed' };

    let minDist = Infinity, closestBuf = null;
    for (const buf of buffers.rows) {
      const dist = haversine(
        parseFloat(latitude), parseFloat(longitude),
        parseFloat(buf.latitude), parseFloat(buf.longitude)
      );
      if (dist < minDist) { minDist = dist; closestBuf = buf; }
      if (dist <= buf.radius_meters) {
        return {
          valid: true,
          message: `Within ${buf.name} (${Math.round(dist)}m)`,
          distance: Math.round(dist)
        };
      }
    }
    return {
      valid: false, outside_boundary: true,
      message: `You are ${Math.round(minDist)}m from ${closestBuf.name}. Must be within ${closestBuf.radius_meters}m.`
    };
  }

  // ── STATE or DISTRICT → resolve GPS to polygon boundary ──────────────────
  if (rule.rule_type === 'state' || rule.rule_type === 'district') {
    const resolved = resolveLocation(parseFloat(latitude), parseFloat(longitude));
    if (!resolved)
      return {
        valid: false, outside_boundary: true,
        message: 'Your location could not be matched to any region in India.'
      };

    if (rule.rule_type === 'state') {
      const match = resolved.state.toUpperCase() === (rule.state || '').toUpperCase();
      return match
        ? { valid: true,  message: `Verified in ${resolved.state}` }
        : { valid: false, outside_boundary: true,
            message: `You are in ${resolved.state}. Must be in ${rule.state} to punch.` };
    }

    if (rule.rule_type === 'district') {
      const stateOk    = resolved.state.toUpperCase()    === (rule.state    || '').toUpperCase();
      const districtOk = resolved.district.toLowerCase() === (rule.district || '').toLowerCase();
      if (stateOk && districtOk)
        return { valid: true, message: `Verified in ${rule.district}, ${rule.state}` };
      return {
        valid: false, outside_boundary: true,
        message: `You are in ${resolved.district}, ${resolved.state}. Must be in ${rule.district}, ${rule.state}.`
      };
    }
  }

  return { valid: true, message: 'Punch allowed' };
}
exports.validateEmployeeBuffer = validateEmployeeBuffer;

// ── GET buffer rule for one employee ─────────────────────────────────────────
exports.getBufferRule = async (req, res) => {
  try {
    const { employee_id } = req.params;
    const r = await db.query(
      `SELECT ebr.*, e.first_name, e.last_name, e.employee_code, e.employee_type
       FROM employee_buffer_rules ebr
       JOIN employees e ON e.id = ebr.employee_id
       WHERE ebr.employee_id = $1`,
      [employee_id]
    );
    res.json({ success: true, data: r.rows[0] || null });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── UPSERT (POST or PUT) buffer rule ─────────────────────────────────────────
exports.upsertBufferRule = async (req, res) => {
  try {
    const employee_id  = req.params.employee_id || req.body.employee_id;
    const { rule_type, state, district } = req.body;
    if (!employee_id || !rule_type)
      return res.status(400).json({ success: false, message: 'employee_id and rule_type required' });

    // ── Sync employee_type — but NEVER override with 'wfh' for universal ──────
    // universal rule_type means "punch from anywhere" — it does NOT mean the
    // employee is a WFH employee. Onsite seniors can be universal too.
    // Only office→onsite, state/district→offsite mappings are automatic.
    // For universal: keep whatever employee_type they already have.
    if (rule_type === 'office') {
      await db.query(`UPDATE employees SET employee_type = 'onsite' WHERE id = $1`, [employee_id]);
      // If a specific office_location_id is provided, move the employee there:
      // delete ALL old geofence rows then insert the new one so they leave Mumbai and appear under Delhi.
      const office_location_id = req.body.office_location_id;
      if (office_location_id) {
        await db.query(`DELETE FROM employee_geofence WHERE employee_id = $1`, [employee_id]);
        await db.query(
          `INSERT INTO employee_geofence (employee_id, office_location_id, is_universal, assigned_by)
           VALUES ($1, $2, FALSE, $3)`,
          [employee_id, office_location_id, req.user.id]
        );
      }
    } else if (rule_type === 'state' || rule_type === 'district') {
      await db.query(`UPDATE employees SET employee_type = 'offsite' WHERE id = $1`, [employee_id]);
      // Remove any stale office_location-based geofence row so the employee stops
      // appearing under the old office/district location card.
      // The new district assignment is tracked purely via employee_buffer_rules.
      await db.query(`DELETE FROM employee_geofence WHERE employee_id = $1`, [employee_id]);

      // ── Auto-create the location card if it doesn't exist yet ────────────────
      // e.g. "District – Fatehabad, Haryana" or "State – Karnataka"
      // This ensures the Geofence page always has a card to display the employee under.
      if (rule_type === 'district' && state && district) {
        const locName = `District – ${district}, ${state.charAt(0) + state.slice(1).toLowerCase()}`;
        const existingLoc = await db.query(
          `SELECT id FROM office_locations WHERE LOWER(name) = LOWER($1)`,
          [locName]
        );
        if (!existingLoc.rows.length) {
          // Get lat/lng from district boundaries JSON
          const stateKey = state.toUpperCase();
          const stateDistricts = DISTRICT_BOUNDARIES[stateKey] || [];
          const districtData = stateDistricts.find(
            d => d.district.toLowerCase() === district.toLowerCase()
          );
          const lat = districtData?.lat || 20.5937;
          const lng = districtData?.lng || 78.9629;
          const radius = districtData?.radius_m || 999999;
          await db.query(
            `INSERT INTO office_locations (name, latitude, longitude, radius_meters, address, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT DO NOTHING`,
            [
              locName, lat, lng, radius,
              `${district} District, ${state.charAt(0) + state.slice(1).toLowerCase()}, India`,
              req.user.id
            ]
          );
        }
      } else if (rule_type === 'state' && state) {
        const locName = `State – ${state.charAt(0) + state.slice(1).toLowerCase()}`;
        const existingLoc = await db.query(
          `SELECT id FROM office_locations WHERE LOWER(name) = LOWER($1)`,
          [locName]
        );
        if (!existingLoc.rows.length) {
          const stateKey = state.toUpperCase();
          const stateDistricts = DISTRICT_BOUNDARIES[stateKey] || [];
          // Use centroid of first district as approximate state center
          const lat = stateDistricts[0]?.lat || 20.5937;
          const lng = stateDistricts[0]?.lng || 78.9629;
          await db.query(
            `INSERT INTO office_locations (name, latitude, longitude, radius_meters, address, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT DO NOTHING`,
            [
              locName, lat, lng, 999999,
              `${state.charAt(0) + state.slice(1).toLowerCase()}, India`,
              req.user.id
            ]
          );
        }
      }
    }
    // universal → do NOT change employee_type (keep onsite/offsite/wfh as-is)

    const r = await db.query(
      `INSERT INTO employee_buffer_rules
         (employee_id, rule_type, state, district, assigned_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (employee_id) DO UPDATE
         SET rule_type   = EXCLUDED.rule_type,
             state       = EXCLUDED.state,
             district    = EXCLUDED.district,
             assigned_by = EXCLUDED.assigned_by,
             updated_at  = NOW()
       RETURNING *`,
      [employee_id, rule_type, state || null, district || null, req.user.id]
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE buffer rule ────────────────────────────────────────────────────────
exports.deleteBufferRule = async (req, res) => {
  try {
    const { employee_id } = req.params;
    await db.query(`DELETE FROM employee_buffer_rules WHERE employee_id=$1`, [employee_id]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET all rules (for admin list view) ──────────────────────────────────────
exports.getAllBufferRules = async (req, res) => {
  try {
    const r = await db.query(
      `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.employee_type,
              ebr.rule_type, ebr.state, ebr.district, ebr.assigned_at, ebr.updated_at,
              latest_eg.office_location_id,
              ol.name AS office_location_name
       FROM employees e
       LEFT JOIN employee_buffer_rules ebr ON ebr.employee_id = e.id
       LEFT JOIN LATERAL (
         SELECT eg.office_location_id
         FROM employee_geofence eg
         JOIN office_locations loc ON loc.id = eg.office_location_id AND loc.radius_meters < 10000
         WHERE eg.employee_id = e.id
         ORDER BY eg.office_location_id DESC
         LIMIT 1
       ) latest_eg ON TRUE
       LEFT JOIN office_locations ol ON ol.id = latest_eg.office_location_id
       WHERE e.is_active = TRUE
       ORDER BY e.first_name`
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Validate buffer (called from frontend map modal) ─────────────────────────
exports.validateBuffer = async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const empId = req.user.id;
    const result = await validateEmployeeBuffer(empId, latitude, longitude);
    res.json({ success: true, valid: result.valid, message: result.message, outside_boundary: result.outside_boundary || false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get boundary polygon for map display ─────────────────────────────────────
exports.getBoundary = async (req, res) => {
  try {
    const { state, district } = req.query;
    if (!state) return res.status(400).json({ success: false, message: 'state required' });

    const stateData = DISTRICT_BOUNDARIES[state.toUpperCase()];
    if (!stateData) return res.status(404).json({ success: false, message: 'State not found' });

    if (district) {
      // Return single district polygon
      const found = stateData.find(d => d.district.toLowerCase() === district.toLowerCase());
      if (!found) return res.status(404).json({ success: false, message: 'District not found' });
      return res.json({
        success: true,
        data: { district: found.district, coordinates: found.geometry.coordinates }
      });
    }

    // Return merged state outline — union of all district polygons' outer rings
    // For mobile rendering we return all districts as separate polygons
    const districts = stateData.map(d => ({
      district: d.district,
      coordinates: d.geometry.type === 'Polygon'
        ? d.geometry.coordinates
        : d.geometry.coordinates.map(poly => poly[0]) // MultiPolygon → flatten
    }));
    res.json({ success: true, data: districts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET all employees with no geofence assignment (global) ──────────────────
exports.getUnassignedEmployeesGlobal = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.city, e.department
       FROM employees e
       WHERE e.is_active = true
         AND NOT EXISTS (SELECT 1 FROM employee_geofence eg WHERE eg.employee_id = e.id)
       ORDER BY e.first_name, e.last_name`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
