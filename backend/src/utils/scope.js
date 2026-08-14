// src/utils/scope.js
// ─────────────────────────────────────────────────────────────────────────────
// Central access-scoping rules for the whole app.
//
// Business rule (see reporting-manager scoping requirement):
//   • FULL visibility  → super_admin, hr, accounts   (see every employee)
//   • SCOPED visibility → everyone else, INCLUDING the `admin` role.
//         A scoped user (manager / tl / admin / employee) may only see & act on
//         their OWN record plus their DIRECT reports — i.e. employees whose
//         reporting_manager_id OR team_leader_id is the scoped user's id.
//         (Direct reports only — one level, not the full recursive downline.)
//
// Keeping this in one place means every controller applies identical rules.
// ─────────────────────────────────────────────────────────────────────────────

// Roles that can see/act on ALL employees.
const FULL_ACCESS_ROLES = ['super_admin', 'hr', 'accounts'];

// Roles that are scoped to their own direct reports (self + direct reportees).
// NB: `admin` is intentionally here — admins no longer see everyone.
const SCOPED_MANAGER_ROLES = ['manager', 'tl', 'admin'];

function normalizeRole(role) {
  return (role || '').toLowerCase().trim();
}

// Does this user see every employee?
function hasFullAccess(role) {
  return FULL_ACCESS_ROLES.includes(normalizeRole(role));
}

// Is this user a scoped manager (direct-reports-only visibility)?
function isScopedManager(role) {
  return SCOPED_MANAGER_ROLES.includes(normalizeRole(role));
}

// Build a SQL condition + params that restrict `<alias>` rows (an employees row,
// or a table joined to employees via `<empIdCol>`) to what `req.user` may see.
//
//   const { clause, params } = buildEmployeeScope(req.user, 'e', startIdx);
//   if (clause) conditions.push(clause), params.forEach(p => allParams.push(p));
//
// • Full-access roles      → clause = null (no restriction).
// • Scoped managers        → self OR direct report (reporting_manager_id / team_leader_id).
// • Everyone else (employee/accounts-less) → own record only.
//
// `alias` is the employees-table alias in the caller's query (e.g. 'e').
// `startIdx` is the next positional-parameter index ($N) to use.
function buildEmployeeScope(user, alias, startIdx) {
  const role = normalizeRole(user.role);
  const uid = user.id;

  if (hasFullAccess(role)) {
    return { clause: null, params: [], nextIdx: startIdx };
  }

  if (isScopedManager(role)) {
    const p = startIdx;
    return {
      clause: `(${alias}.id = $${p} OR ${alias}.reporting_manager_id = $${p} OR ${alias}.team_leader_id = $${p})`,
      params: [uid],
      nextIdx: startIdx + 1,
    };
  }

  // Plain employee (and any other role): own record only.
  return {
    clause: `${alias}.id = $${startIdx}`,
    params: [uid],
    nextIdx: startIdx + 1,
  };
}

// Async check: may `user` view/act on the employee `targetId`?
// • full-access roles      → always yes
// • self                   → always yes
// • scoped managers        → yes only if target is a DIRECT report
// • everyone else          → only self
// `db` is the config/db module (needs .query).
async function canAccessEmployee(user, targetId, db) {
  targetId = parseInt(targetId);
  if (!targetId) return false;
  if (hasFullAccess(user.role)) return true;
  if (targetId === user.id) return true;
  if (isScopedManager(user.role)) {
    const r = await db.query(
      `SELECT 1 FROM employees WHERE id=$1 AND (reporting_manager_id=$2 OR team_leader_id=$2)`,
      [targetId, user.id]
    );
    return r.rows.length > 0;
  }
  return false;
}

module.exports = {
  canAccessEmployee,
  FULL_ACCESS_ROLES,
  SCOPED_MANAGER_ROLES,
  normalizeRole,
  hasFullAccess,
  isScopedManager,
  buildEmployeeScope,
};
