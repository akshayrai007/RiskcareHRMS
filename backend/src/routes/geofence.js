// routes/geofence.js  — add to your Express router
const express = require('express');
const router  = express.Router();
const db      = require('../config/db');

// ── GET assignments for a location ────────────────────────────────────────
// GET /api/geofence/assignments/:locationId
router.get('/assignments/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const { rows } = await db.query(
      `SELECT eg.employee_id, eg.is_universal,
              e.first_name, e.last_name, e.employee_code
       FROM employee_geofence eg
       JOIN employees e ON e.id = eg.employee_id
       WHERE eg.office_location_id = $1`,
      [locationId]
    );
    res.json({ assignments: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// ── SAVE / SYNC assignments for a location ────────────────────────────────
// POST /api/geofence/assign
// Body: { office_location_id, assignments: [{ employee_id, is_universal }] }
router.post('/assign', async (req, res) => {
  const client = await db.getClient();
  try {
    const { office_location_id, assignments } = req.body;
    const assignedBy = req.user?.id || null; // from your auth middleware

    if (!office_location_id) {
      return res.status(400).json({ message: 'office_location_id is required' });
    }

    await client.query('BEGIN');

    // Delete existing assignments for this location
    await client.query(
      `DELETE FROM employee_geofence WHERE office_location_id = $1`,
      [office_location_id]
    );

    // Re-insert all new assignments
    for (const a of (assignments || [])) {
      await client.query(
        `INSERT INTO employee_geofence (employee_id, office_location_id, is_universal, assigned_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (employee_id, office_location_id) DO UPDATE
           SET is_universal = EXCLUDED.is_universal,
               assigned_by  = EXCLUDED.assigned_by`,
        [a.employee_id, office_location_id, !!a.is_universal, assignedBy]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, count: assignments?.length || 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
});

// ── GET all locations an employee is assigned to ──────────────────────────
// GET /api/geofence/employee/:employeeId
router.get('/employee/:employeeId', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT eg.*, ol.name AS location_name, ol.latitude, ol.longitude, ol.radius_meters
       FROM employee_geofence eg
       JOIN office_locations ol ON ol.id = eg.office_location_id
       WHERE eg.employee_id = $1`,
      [req.params.employeeId]
    );
    res.json({ locations: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
