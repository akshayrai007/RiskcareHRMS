// src/controllers/accessControlController.js
// ── ACCESS CONTROL MODULE ────────────────────────────────────────────────────
// A single source of truth for "who can see what", replacing the scattered
// Role.is()/NAV_GROUPS checks that had drifted out of sync with each other
// (see the access audit — dashboard.html's own guard contradicted its
// NAV_GROUPS entry, offer-letter.html showed buttons the backend rejected,
// etc). This module defines:
//   1. PAGE_CATALOG — every real page in the app, with its known tabs/sections
//   2. ROLE_DEFAULTS — the default access level + data scope per role per
//      page, taken directly from the HR-reviewed access matrix
//   3. A per-employee OVERRIDE table (employee_page_access) that HR/Admin/
//      Super Admin can set from the Access Control screen to grant one
//      specific employee more (or less) access than their role default —
//      without changing their role.
//
// Access level: 'full' (everything on the page) | 'partial' (only listed
// tabs, and/or only "reportees"/"own" data) | 'none' (page hidden entirely).
// Data scope (meaningful mainly for partial): 'all' | 'reportees' | 'own'.

const db = require('../config/db');

const ROLES = ['super_admin', 'hr', 'accounts', 'admin', 'manager', 'tl', 'employee'];

// ── Page catalog ──────────────────────────────────────────────────────────
const PAGE_CATALOG = [
  { key: 'dashboard.html',        label: 'Dashboard' },
  { key: 'announcements.html',    label: 'Home' },
  { key: 'attendance.html',       label: 'Attendance',
    tabs: [ { key:'team', label:'Team tab' }, { key:'import', label:'Import' }, { key:'download', label:'Download/Absent' }, { key:'force_reg', label:'Force Regularize' }, { key:'mark', label:'Mark Attendance (admin)' } ] },
  { key: 'leaves.html',           label: 'Leaves',
    tabs: [ { key:'approvals', label:'Approvals' }, { key:'summary', label:'Summary' }, { key:'transactions', label:'Transactions' }, { key:'import', label:'Import Balances' }, { key:'leave_types', label:'Leave Types config' } ] },
  { key: 'performance.html',      label: 'Performance' },
  { key: 'projects.html',         label: 'Projects' },
  { key: 'chat.html',             label: 'Chat & Meetings' },
  { key: 'board.html',            label: 'Task Board' },
  { key: 'tasks.html',            label: 'All Tasks' },
  { key: 'my-work.html',          label: 'My Work' },
  { key: 'work-tracker.html',     label: 'Work Tracker' },
  { key: 'documents.html',        label: 'My Documents',
    tabs: [ { key:'hr_search', label:'HR employee search' } ] },
  { key: 'send-documents.html',   label: 'Send Documents',
    tabs: [ { key:'send', label:'Send panel' }, { key:'sent', label:'Sent tab' } ] },
  { key: 'form16.html',           label: 'Form 16' },
  { key: 'it-declaration.html',   label: 'IT Declaration',
    tabs: [ { key:'hr', label:'HR review tab' }, { key:'config', label:'Config tab' } ] },
  { key: 'payroll.html',          label: 'Payroll',
    tabs: [ { key:'upload', label:'Upload' }, { key:'process', label:'Process' }, { key:'list', label:'Payroll List' }, { key:'struct', label:'Salary Structures' } ] },
  { key: 'payslip.html',          label: 'My Payslip' },
  { key: 'advance.html',          label: 'Advance Salary' },
  { key: 'reimbursement.html',    label: 'Reimbursement',
    tabs: [ { key:'all', label:'All (everyone\'s claims)' }, { key:'my', label:'My claims' } ] },
  { key: 'provision.html',        label: 'Provision',
    tabs: [ { key:'approvals', label:'Approvals' } ] },
  { key: 'employee-history.html',label: 'Salary & Promotions' },
  { key: 'onboarding.html',       label: 'Onboarding Tracker' },
  { key: 'offer-letter.html',     label: 'Offer Letters' },
  { key: 'relieving-letter.html',label: 'Relieving Letters' },
  { key: 'separation.html',       label: 'Separation' },
  { key: 'employees.html',        label: 'Employees',
    tabs: [ { key:'import', label:'Import tab' }, { key:'geofence', label:'Geofence tab' }, { key:'logs', label:'Logs tab' }, { key:'reshuffle', label:'Reshuffle tab' }, { key:'compensation', label:'Compensation panel' }, { key:'manage', label:'Edit/Reset/WFH actions' }, { key:'danger', label:'Deactivate/Delete actions' } ] },
  { key: 'org-chart.html',        label: 'Org Chart' },
  { key: 'geofence.html',         label: 'Geofence' },
  { key: 'ai-voice.html',         label: 'Voice Assistant' },
  { key: 'movement.html',         label: 'Movement (hidden — no web equivalent)' },
  { key: 'import_employees.html',label: 'Import Employees (legacy — superseded)' },
];

// ── Role defaults, from the HR-reviewed access matrix ────────────────────
// { [pageKey]: { [role]: { level, scope } } }
const F = { level: 'full', scope: 'all' };
const N = { level: 'none' };
const R = { level: 'partial', scope: 'reportees' };  // manager/tl/admin-style: own reportees' data
const O = { level: 'partial', scope: 'own' };         // employee-style: own record only
const E = { level: 'full', scope: 'all' };            // "Everyone" on a shared/self-scoped page

function rowFor(sa, hr, acc, adm, mgr, tl, emp) {
  return { super_admin: sa, hr, accounts: acc, admin: adm, manager: mgr, tl, employee: emp };
}

const ROLE_DEFAULTS = {
  'dashboard.html':        rowFor(F, F, F, N, N, N, N),   // manager/tl excluded — matches guardDashboard() actual behavior
  'announcements.html':    rowFor(N, N, N, N, N, N, F),
  'attendance.html':       rowFor(F, F, F, F, F, F, F),
  'leaves.html':           rowFor(F, F, F, F, F, F, F),
  'performance.html':      rowFor(N, N, N, N, N, N, N),   // hidden from everyone
  'projects.html':         rowFor(N, N, N, N, N, N, N),   // hidden from everyone
  'chat.html':             rowFor(F, F, F, F, F, F, F),
  'board.html':            rowFor(F, R, R, R, R, R, O),
  'tasks.html':             rowFor(F, R, R, R, R, R, O),
  'my-work.html':           rowFor(F, R, R, R, R, R, O),
  'work-tracker.html':      rowFor(F, R, R, R, R, R, O),
  'documents.html':        rowFor(N, F, F, F, F, F, F),   // super_admin excluded
  'send-documents.html':   rowFor(F, F, F, F, F, F, F),
  'form16.html':           rowFor(F, F, F, F, F, F, F),
  'it-declaration.html':   rowFor(F, F, F, F, F, F, F),
  'payroll.html':          rowFor(F, F, F, N, N, N, N),
  'payslip.html':          rowFor(F, F, F, F, F, F, F),
  'advance.html':          rowFor(F, F, F, F, F, F, F),
  'reimbursement.html':    rowFor(F, F, F, F, F, F, F),
  'provision.html':        rowFor(F, F, F, R, R, R, N),
  'employee-history.html': rowFor(F, F, F, R, N, N, N),
  'onboarding.html':       rowFor(F, F, N, N, N, N, N),
  'offer-letter.html':     rowFor(F, F, N, F, N, N, N),
  'relieving-letter.html': rowFor(F, F, N, F, N, N, N),
  'separation.html':       rowFor(F, F, F, F, F, F, F),
  'employees.html':        rowFor(F, F, F, R, R, R, N),
  'org-chart.html':        rowFor(F, F, F, F, F, F, F),
  'geofence.html':         rowFor(F, N, N, F, N, N, N),
  'ai-voice.html':         rowFor(F, F, F, F, F, F, F),
  'movement.html':         rowFor(N, N, N, N, N, N, N),   // hidden — no web equivalent
  'import_employees.html': rowFor(N, N, N, N, N, N, N),   // legacy, superseded by Employees > Import
};

function roleDefault(pageKey, role) {
  const row = ROLE_DEFAULTS[pageKey];
  if (!row) return { level: 'none' };
  return row[role] || { level: 'none' };
}

let ready = null;
async function ensureTables() {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS employee_page_access (
        id            SERIAL PRIMARY KEY,
        employee_id   INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        page_key      VARCHAR(60) NOT NULL,
        access_level  VARCHAR(10) NOT NULL CHECK (access_level IN ('full','partial','none')),
        allowed_tabs  JSONB DEFAULT '[]',
        data_scope    VARCHAR(20) CHECK (data_scope IN ('all','reportees','own') OR data_scope IS NULL),
        set_by        INT REFERENCES employees(id) ON DELETE SET NULL,
        updated_at    TIMESTAMP DEFAULT NOW(),
        UNIQUE(employee_id, page_key)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_epa_employee ON employee_page_access(employee_id)`);
  })().catch(err => { ready = null; throw err; });
  return ready;
}

// Merge role default + any per-employee override into one "effective" result.
async function computeEffective(employeeId, role) {
  await ensureTables();
  const overridesRes = await db.query(
    `SELECT page_key, access_level, allowed_tabs, data_scope FROM employee_page_access WHERE employee_id=$1`,
    [employeeId]
  );
  const overrideMap = {};
  overridesRes.rows.forEach(o => { overrideMap[o.page_key] = o; });

  return PAGE_CATALOG.map(page => {
    const def = roleDefault(page.key, role);
    const ov = overrideMap[page.key];
    if (ov) {
      return {
        page_key: page.key,
        label: page.label,
        tabs: page.tabs || null,
        source: 'override',
        access_level: ov.access_level,
        data_scope: ov.data_scope,
        allowed_tabs: ov.allowed_tabs || [],
        default_level: def.level,
        default_scope: def.scope || null,
      };
    }
    return {
      page_key: page.key,
      label: page.label,
      tabs: page.tabs || null,
      source: 'default',
      access_level: def.level,
      data_scope: def.scope || null,
      allowed_tabs: page.tabs ? page.tabs.map(t => t.key) : [],
      default_level: def.level,
      default_scope: def.scope || null,
    };
  });
}

exports.getCatalog = async (req, res) => {
  res.json({ success: true, data: PAGE_CATALOG, roles: ROLES });
};

exports.getEffectiveAccess = async (req, res) => {
  try {
    const employeeId = parseInt(req.params.employeeId || req.query.employee_id);
    if (!employeeId) return res.status(400).json({ success: false, message: 'employee_id required' });
    const empRes = await db.query(`SELECT id, role, first_name, last_name, employee_code FROM employees WHERE id=$1`, [employeeId]);
    if (empRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Employee not found' });
    const emp = empRes.rows[0];
    const data = await computeEffective(employeeId, emp.role);
    res.json({ success: true, data, employee: emp });
  } catch (err) {
    console.error('[accessControl.getEffectiveAccess]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Used by other controllers/pages to enforce access server-side, not just
// display it. Returns { level, scope, tabs } for one page/employee.
async function getEffectiveForPage(employeeId, role, pageKey) {
  await ensureTables();
  const ov = await db.query(
    `SELECT access_level, allowed_tabs, data_scope FROM employee_page_access WHERE employee_id=$1 AND page_key=$2`,
    [employeeId, pageKey]
  );
  if (ov.rows.length) {
    const o = ov.rows[0];
    return { level: o.access_level, scope: o.data_scope, tabs: o.allowed_tabs || [] };
  }
  const def = roleDefault(pageKey, role);
  return { level: def.level, scope: def.scope || null, tabs: null };
}
exports.getEffectiveForPage = getEffectiveForPage;

exports.setOverride = async (req, res) => {
  try {
    await ensureTables();
    const { employee_id, page_key, access_level, allowed_tabs, data_scope } = req.body;
    if (!employee_id || !page_key || !access_level) {
      return res.status(400).json({ success: false, message: 'employee_id, page_key and access_level are required' });
    }
    if (!['full', 'partial', 'none'].includes(access_level)) {
      return res.status(400).json({ success: false, message: 'Invalid access_level' });
    }
    if (!PAGE_CATALOG.some(p => p.key === page_key)) {
      return res.status(400).json({ success: false, message: 'Unknown page_key' });
    }
    await db.query(
      `INSERT INTO employee_page_access (employee_id, page_key, access_level, allowed_tabs, data_scope, set_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (employee_id, page_key) DO UPDATE SET
         access_level=$3, allowed_tabs=$4, data_scope=$5, set_by=$6, updated_at=NOW()`,
      [employee_id, page_key, access_level, JSON.stringify(allowed_tabs || []), data_scope || null, req.user.id]
    );
    res.json({ success: true, message: 'Access override saved' });
  } catch (err) {
    console.error('[accessControl.setOverride]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Revert a single page back to the role default (removes the override row).
exports.clearOverride = async (req, res) => {
  try {
    await ensureTables();
    const employeeId = parseInt(req.params.employeeId);
    const pageKey = req.params.pageKey;
    await db.query(`DELETE FROM employee_page_access WHERE employee_id=$1 AND page_key=$2`, [employeeId, pageKey]);
    res.json({ success: true, message: 'Reverted to role default' });
  } catch (err) {
    console.error('[accessControl.clearOverride]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.listEmployeesForPicker = async (req, res) => {
  try {
    const r = await db.query(
      `SELECT e.id, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name, e.role, d.name AS department_name
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.is_active=true ORDER BY e.first_name`
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('[accessControl.listEmployeesForPicker]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
