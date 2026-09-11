// src/controllers/assetController.js
// ── ASSET ALLOCATION MODULE ──────────────────────────────────────────────────
// Tracks company assets (laptop, SIM, ID card, etc.) issued to employees.
// Deliberately denormalized to match the Android client's contract: there is
// no separate asset catalog table — each row in asset_allocations IS one
// issued item, and the "asset item" picklist is just the distinct item names
// already in use, same as KrishiHR's reference implementation.

const db = require('../config/db');

let ready = null;
async function ensureTables() {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS asset_allocations (
        id            SERIAL PRIMARY KEY,
        employee_id   INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        item_name     VARCHAR(150) NOT NULL,
        quantity      INT DEFAULT 1,
        serial_no     VARCHAR(100),
        remark        TEXT,
        status        VARCHAR(20) DEFAULT 'allocated' CHECK (status IN ('allocated','returned')),
        allocated_by  INT REFERENCES employees(id) ON DELETE SET NULL,
        allocated_at  TIMESTAMP DEFAULT NOW(),
        returned_at   TIMESTAMP
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_assets_employee ON asset_allocations(employee_id)`);
  })().catch(err => { ready = null; throw err; });
  return ready;
}

const ASSET_SELECT = `
  SELECT a.id, a.item_name, a.quantity, a.serial_no, a.remark, a.status, a.allocated_at,
         e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS emp_name
  FROM asset_allocations a JOIN employees e ON e.id = a.employee_id
`;

exports.getMyAssets = async (req, res) => {
  try {
    await ensureTables();
    const r = await db.query(`${ASSET_SELECT} WHERE a.employee_id=$1 ORDER BY a.allocated_at DESC`, [req.user.id]);
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('[assets.getMyAssets]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getAssetItems = async (req, res) => {
  try {
    await ensureTables();
    const r = await db.query(`SELECT DISTINCT item_name FROM asset_allocations ORDER BY item_name`);
    res.json({ success: true, data: r.rows.map(row => row.item_name) });
  } catch (err) {
    console.error('[assets.getAssetItems]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getAssetEmployees = async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, employee_code, first_name, last_name FROM employees
       WHERE is_active=true ORDER BY first_name`
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('[assets.getAssetEmployees]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getEmployeeAssets = async (req, res) => {
  try {
    await ensureTables();
    const employeeId = parseInt(req.query.employee_id);
    if (!employeeId) return res.status(400).json({ success: false, message: 'employee_id is required' });
    const r = await db.query(`${ASSET_SELECT} WHERE a.employee_id=$1 ORDER BY a.allocated_at DESC`, [employeeId]);
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('[assets.getEmployeeAssets]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.allocateAssets = async (req, res) => {
  const client = await db.getClient();
  try {
    await ensureTables();
    const { employee_id, items } = req.body;
    if (!employee_id) return res.status(400).json({ success: false, message: 'employee_id is required' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ success: false, message: 'At least one item is required' });

    await client.query('BEGIN');
    const inserted = [];
    for (const it of items) {
      if (!it.item_name || !String(it.item_name).trim()) continue;
      const r = await client.query(
        `INSERT INTO asset_allocations (employee_id, item_name, quantity, serial_no, remark, allocated_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [employee_id, it.item_name, it.quantity || 1, it.serial_no || null, it.remark || null, req.user.id]
      );
      inserted.push(r.rows[0].id);
    }
    await client.query('COMMIT');
    const r2 = await db.query(`${ASSET_SELECT} WHERE a.id = ANY($1)`, [inserted]);
    res.json({ success: true, message: `Allocated ${inserted.length} item(s)`, data: r2.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[assets.allocateAssets]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
};

exports.updateAsset = async (req, res) => {
  try {
    await ensureTables();
    const id = parseInt(req.params.id);
    const { status, remark, serial_no } = req.body;
    const sets = []; const params = [];
    if (status !== undefined) {
      if (!['allocated', 'returned'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });
      params.push(status); sets.push(`status=$${params.length}`);
      sets.push(status === 'returned' ? 'returned_at=NOW()' : 'returned_at=NULL');
    }
    if (remark !== undefined)    { params.push(remark);    sets.push(`remark=$${params.length}`); }
    if (serial_no !== undefined) { params.push(serial_no); sets.push(`serial_no=$${params.length}`); }
    if (sets.length === 0) return res.status(400).json({ success: false, message: 'Nothing to update' });
    params.push(id);
    await db.query(`UPDATE asset_allocations SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
    const r = await db.query(`${ASSET_SELECT} WHERE a.id=$1`, [id]);
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error('[assets.updateAsset]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.deleteAsset = async (req, res) => {
  try {
    await db.query(`DELETE FROM asset_allocations WHERE id=$1`, [parseInt(req.params.id)]);
    res.json({ success: true, message: 'Asset record deleted' });
  } catch (err) {
    console.error('[assets.deleteAsset]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
