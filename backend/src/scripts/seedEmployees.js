// One-time/re-runnable seed: wipes all employee data (and everything that
// references employees — attendance, payroll, leave, notifications, etc. —
// via TRUNCATE ... CASCADE) and reseeds from a "Live Employees" Excel export.
//
// Usage: node src/scripts/seedEmployees.js <path-to-excel.xlsx>
require('dotenv').config();
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const db = require('../config/db');

const SHEET_NAME = 'Live Employees';

// Explicit super_admins per business rule; every other employee who appears
// in someone else's "Reporting Officer" column becomes an admin; everyone
// else defaults to plain "employee".
const SUPER_ADMIN_CODES = new Set(['E008', 'E053']);

function splitName(fullName) {
  const parts = String(fullName).trim().split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
}

// Deliberately avoids the JS Date object: SheetJS's cellDates mode plus a
// TZ env var (this repo sets TZ=Asia/Kolkata) round-trips a date-only cell
// through a local-midnight Date and toISOString(), which silently shifts
// the calendar date backward by a day for any positive UTC offset. Reading
// raw Excel serials and decoding them with SSF sidesteps timezones entirely.
function excelDateToISO(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${String(d.y).padStart(4, '0')}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function digits(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\D/g, '');
  return s || null;
}

function normName(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function getOrCreateDepartment(client, cache, name) {
  const n = String(name || '').trim();
  if (!n) return null;
  if (cache.has(n)) return cache.get(n);
  const existing = await client.query('SELECT id FROM departments WHERE name=$1', [n]);
  const id = existing.rows.length
    ? existing.rows[0].id
    : (await client.query('INSERT INTO departments (name) VALUES ($1) RETURNING id', [n])).rows[0].id;
  cache.set(n, id);
  return id;
}

async function getOrCreateDesignation(client, cache, title, departmentId) {
  const t = String(title || '').trim();
  if (!t) return null;
  const key = `${t}::${departmentId}`;
  if (cache.has(key)) return cache.get(key);
  const existing = await client.query(
    'SELECT id FROM designations WHERE title=$1 AND department_id IS NOT DISTINCT FROM $2',
    [t, departmentId]
  );
  const id = existing.rows.length
    ? existing.rows[0].id
    : (await client.query(
        'INSERT INTO designations (title, department_id) VALUES ($1,$2) RETURNING id',
        [t, departmentId]
      )).rows[0].id;
  cache.set(key, id);
  return id;
}

async function main() {
  const excelPath = process.argv[2];
  if (!excelPath) {
    console.error('Usage: node src/scripts/seedEmployees.js <path-to-excel.xlsx>');
    process.exit(1);
  }

  console.log(`Reading ${excelPath} ...`);
  const wb = XLSX.readFile(excelPath);
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) throw new Error(`Sheet "${SHEET_NAME}" not found. Sheets: ${wb.SheetNames.join(', ')}`);
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  console.log(`Found ${rows.length} rows.`);

  const reportingOfficerNames = new Set();
  for (const r of rows) {
    if (r['Reporting Officer']) reportingOfficerNames.add(normName(r['Reporting Officer']));
  }

  const client = await db.getClient();
  const deptCache = new Map();
  const desigCache = new Map();
  const codeToId = new Map();
  const unmatchedManagers = [];
  const roleCounts = { super_admin: 0, admin: 0, employee: 0 };

  try {
    await client.query('BEGIN');

    console.log('Wiping employees (and everything referencing employees) ...');
    await client.query('TRUNCATE TABLE employees RESTART IDENTITY CASCADE');

    for (const r of rows) {
      const empCode = String(r['Employee ID']).trim();
      const fullName = String(r['Employee Name']).trim();
      const { first, last } = splitName(fullName);
      const email = String(r['Official Email ID']).trim();
      const mobileDigits = digits(r['Official Mobile Number']);
      const dob = excelDateToISO(r['Date of Birth']);
      const joining = excelDateToISO(r['Date of Joining']);

      const deptId = await getOrCreateDepartment(client, deptCache, r['Department']);
      const desigId = await getOrCreateDesignation(client, desigCache, r['Designation'], deptId);

      let role = 'employee';
      if (SUPER_ADMIN_CODES.has(empCode)) role = 'super_admin';
      else if (reportingOfficerNames.has(normName(fullName))) role = 'admin';
      roleCounts[role]++;

      const passwordHash = await bcrypt.hash(mobileDigits || empCode, 10);
      const isActive = String(r['Status'] || '').trim().toLowerCase() === 'live';

      const inserted = await client.query(
        `INSERT INTO employees (
           employee_code, first_name, last_name, email, phone, alternate_phone,
           gender, date_of_birth, blood_group, marital_status,
           address_line1, permanent_address, city, state, pincode,
           department_id, designation_id,
           joining_date, role, password_hash, is_active,
           pan_number, aadhar_number, uan_number, pf_number
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25
         ) RETURNING id`,
        [
          empCode, first, last, email, mobileDigits, digits(r['Personal Mobile Number']),
          r['Gender'] || null, dob, r['Blood Group'] || null, r['Marital Status'] || null,
          r['Present Address'] || null, r['Permanent Address'] || null,
          r['Location'] || null, r['Present State'] || null, null,
          deptId, desigId,
          joining, role, passwordHash, isActive,
          r['PAN'] || null, r['Aadhaar Card Number'] || null,
          r['Universal Account Number'] ? String(r['Universal Account Number']) : null,
          r['PF Number'] ? String(r['PF Number']) : null
        ]
      );
      codeToId.set(empCode, inserted.rows[0].id);
    }

    console.log(`Inserted ${codeToId.size} employees. Linking reporting managers ...`);

    const nameToId = new Map();
    for (const r of rows) {
      nameToId.set(normName(r['Employee Name']), codeToId.get(String(r['Employee ID']).trim()));
    }

    let linked = 0;
    for (const r of rows) {
      const ro = r['Reporting Officer'];
      if (!ro) continue;
      const managerId = nameToId.get(normName(ro));
      const empId = codeToId.get(String(r['Employee ID']).trim());
      if (!managerId) {
        unmatchedManagers.push({ employee: r['Employee Name'], reporting_officer: ro });
        continue;
      }
      if (managerId === empId) continue;
      await client.query('UPDATE employees SET reporting_manager_id=$1 WHERE id=$2', [managerId, empId]);
      linked++;
    }

    await client.query('COMMIT');
    console.log(`\n✅ Seed complete.`);
    console.log(`   Employees inserted: ${codeToId.size}`);
    console.log(`   Roles:`, roleCounts);
    console.log(`   Reporting-manager links set: ${linked}`);
    if (unmatchedManagers.length) {
      console.log(`   ⚠ Unmatched reporting officers (left unlinked):`, unmatchedManagers);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed, rolled back:', err.message);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
