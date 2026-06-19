const CONFIG = require('../Main_file');
// src/controllers/employeeImportController.js
// Bulk import new employees from the Excel template
const db     = require('../config/db');
const bcrypt = require('bcryptjs');
const XLSX   = require('xlsx');
const multer = require('multer');

exports.uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(xlsx|xls)$/.test(file.originalname.toLowerCase())) cb(null, true);
    else cb(new Error('Only Excel files allowed'));
  }
}).single('file');

// Column mapping from our Excel template (0-indexed)
// NOTE: must stay in sync with the headers in row 3 of the Employee Import
// template (columns A..AE, 31 columns total). There are NO salary columns
// (basic_salary/hra/special_allowance/travel_allowance/ctc) in this template.
const COL = {
  employee_code: 0, password: 1, first_name: 2, last_name: 3,
  email: 4, phone: 5, alternate_phone: 6, gender: 7, date_of_birth: 8,
  blood_group: 9, marital_status: 10, joining_date: 11, employment_type: 12,
  role: 13, department_id: 14, designation_id: 15,
  reporting_manager_id: 16, team_leader_id: 17,
  pan_number: 18, aadhar_number: 19, uan_number: 20,
  bank_name: 21, bank_account: 22, bank_ifsc: 23, bank_branch: 24,
  address_line1: 25, city: 26, state: 27, pincode: 28,
  probation_end_date: 29, notes: 30
};

function clean(val) {
  return val !== null && val !== undefined && val !== '' ? String(val).trim() : null;
}

function toDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Handle Excel serial date numbers
  if (!isNaN(val)) {
    const d = new Date(Math.round((parseInt(val) - 25569) * 86400 * 1000));
    return d.toISOString().split('T')[0];
  }
  // Try parsing other formats
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return null;
}

function toNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

exports.importEmployees = async (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false, message: 'Excel file required' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    console.log(`[Import] Sheet names in uploaded file: ${wb.SheetNames.join(', ')}`);
    const ws = wb.Sheets['Employee Import'] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    console.log(`[Import] Total rows read from sheet: ${rows.length}`);
    console.log(`[Import] Row 3 (header, 0-indexed):`, rows[2]);
    console.log(`[Import] Row 4 (first data row, 0-indexed):`, rows[4]);

    // Skip title row (1) + header row (2) + hint row (3) = start at index 3
    const dataRows = rows.slice(3).filter(r => {
      const code = clean(r[COL.employee_code]);
      return code && !code.toLowerCase().startsWith('emp code') && !code.toLowerCase().startsWith('kcms00');
    });
    console.log(`[Import] Data rows after filter: ${dataRows.length}`);

    if (!dataRows.length)
      return res.status(400).json({ success: false, message: 'No data rows found (delete sample rows first)' });

    const results = { imported: [], skipped: [], errors: [] };

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowNum = i + 4; // Excel row number for reporting

      const employee_code = clean(row[COL.employee_code])?.toUpperCase();
      const first_name    = clean(row[COL.first_name]);
      const email         = clean(row[COL.email])?.toLowerCase();
      const pan_for_pwd   = clean(row[COL.pan_number]);
      const password      = clean(row[COL.password]) || pan_for_pwd || `${CONFIG.defaultImportPassword}`;

      // Required field validation
      if (!employee_code) { results.errors.push(`Row ${rowNum}: employee_code is required`); continue; }
      if (!first_name)    { results.errors.push(`Row ${rowNum}: first_name is required`); continue; }
      if (!email)         { results.errors.push(`Row ${rowNum}: email is required`); continue; }
      if (password.length < 8) { results.errors.push(`Row ${rowNum}: password must be at least 8 characters`); continue; }

      // Check duplicates
      const dupCheck = await client.query(
        `SELECT id FROM employees WHERE UPPER(employee_code)=$1 OR LOWER(email)=$2`,
        [employee_code, email]
      );
      if (dupCheck.rows.length) {
        results.skipped.push(`Row ${rowNum}: ${employee_code} / ${email} already exists`);
        continue;
      }

      const hash = await bcrypt.hash(password, 10);
      const role_val = clean(row[COL.role]) || 'employee';
      const valid_roles = ['employee','tl','manager','hr','accounts','admin'];
      const role = valid_roles.includes(role_val) ? role_val : 'employee';

      try {
        // Savepoint per row: if a single row's INSERT fails (bad data, FK
        // violation, etc.) we roll back just that row instead of poisoning
        // the whole transaction and aborting every subsequent row.
        await client.query('SAVEPOINT row_import');

        const result = await client.query(
          `INSERT INTO employees (
             employee_code, first_name, last_name, email, phone, alternate_phone,
             gender, date_of_birth, blood_group, marital_status, joining_date,
             employment_type, role, password_hash,
             department_id, designation_id, reporting_manager_id, team_leader_id,
             basic_salary, hra, special_allowance, travel_allowance, ctc,
             pan_number, aadhar_number, uan_number,
             bank_name, bank_account, bank_ifsc, bank_branch,
             address_line1, city, state, pincode,
             probation_end_date, is_active
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,true
           ) RETURNING id, employee_code, first_name, last_name, email`,
          [
            employee_code,
            first_name,
            clean(row[COL.last_name]) || '',
            email,
            clean(row[COL.phone]),
            clean(row[COL.alternate_phone]),
            clean(row[COL.gender]),
            toDate(row[COL.date_of_birth]),
            clean(row[COL.blood_group]),
            clean(row[COL.marital_status]),
            toDate(row[COL.joining_date]) || new Date().toISOString().split('T')[0],
            clean(row[COL.employment_type]) || 'Full-Time',
            role,
            hash,
            parseInt(row[COL.department_id]) || null,
            parseInt(row[COL.designation_id]) || null,
            parseInt(row[COL.reporting_manager_id]) || null,
            parseInt(row[COL.team_leader_id]) || null,
            // Salary fields are not collected by the Employee Import
            // template — they're set via the payroll module after import.
            0, 0, 0, 0, 0,
            clean(row[COL.pan_number])?.toUpperCase(),
            clean(row[COL.aadhar_number]),
            clean(row[COL.uan_number]),
            clean(row[COL.bank_name]),
            clean(row[COL.bank_account]),
            clean(row[COL.bank_ifsc])?.toUpperCase(),
            clean(row[COL.bank_branch]),
            clean(row[COL.address_line1]),
            clean(row[COL.city]),
            clean(row[COL.state]),
            clean(row[COL.pincode]),
            toDate(row[COL.probation_end_date]),
          ]
        );

        const newEmp = result.rows[0];
        results.imported.push({
          employee_code: newEmp.employee_code,
          name: `${newEmp.first_name} ${newEmp.last_name}`,
          email: newEmp.email
        });

        // Auto-seed leave balances based on joining date
        // Rule: < 6 months from today → PL=6 only
        //       >= 6 months → EL=18, CL=6, SL=6
        {
          const currentYear = new Date().getFullYear();
          const today = new Date();
          const empJoiningDate = new Date(toDate(row[COL.joining_date]) || new Date());
          const sixMonthMark = new Date(empJoiningDate);
          sixMonthMark.setMonth(sixMonthMark.getMonth() + 6);
          const isUnderSixMonths = today < sixMonthMark;

          const ltRes = await client.query(
            `SELECT id, code FROM leave_types WHERE is_active=true AND code IN ('EL','CL','SL','PL')`
          );
          const ltMap = {};
          for (const lt of ltRes.rows) ltMap[lt.code] = lt.id;

          if (isUnderSixMonths) {
            // Under 6 months: PL = 6 upfront
            if (ltMap['PL']) {
              await client.query(
                `INSERT INTO leave_balances(employee_id,leave_type_id,year,allocated,used,pending,carry_forward)
                 VALUES($1,$2,$3,6,0,0,0) ON CONFLICT DO NOTHING`,
                [newEmp.id, ltMap['PL'], currentYear]
              );
            }
          } else {
            // 6+ months: full EL/CL/SL — EL=18, CL=6, SL=6
            const allocations = { EL: 18, CL: 6, SL: 6 };
            for (const [code, alloc] of Object.entries(allocations)) {
              if (ltMap[code]) {
                await client.query(
                  `INSERT INTO leave_balances(employee_id,leave_type_id,year,allocated,used,pending,carry_forward)
                   VALUES($1,$2,$3,$4,0,0,0) ON CONFLICT DO NOTHING`,
                  [newEmp.id, ltMap[code], currentYear, alloc]
                );
              }
            }
          }
        }

        await client.query('RELEASE SAVEPOINT row_import');

      } catch (rowErr) {
        await client.query('ROLLBACK TO SAVEPOINT row_import');
        results.errors.push(`Row ${rowNum} (${employee_code}): ${rowErr.message}`);
      }
    }

    await client.query('COMMIT');
    console.log(`[Import] Done: ${results.imported.length} imported, ${results.skipped.length} skipped, ${results.errors.length} errors`);
    if (results.errors.length) console.log('[Import] Errors:', results.errors);
    if (results.skipped.length) console.log('[Import] Skipped:', results.skipped);
    res.json({
      success: true,
      message: `Import complete: ${results.imported.length} imported, ${results.skipped.length} skipped, ${results.errors.length} errors`,
      data: {
        imported: results.imported,
        skipped:  results.skipped,
        errors:   results.errors.slice(0, 50),
        summary: {
          total_rows: dataRows.length,
          imported: results.imported.length,
          skipped:  results.skipped.length,
          errors:   results.errors.length
        }
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally { client.release(); }
};
