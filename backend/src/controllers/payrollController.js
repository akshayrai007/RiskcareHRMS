const CONFIG = require('../Main_file');
// src/controllers/payrollController.js — COMPLETE FIX WITH DEBUGGING
// The issue: Frontend not sending file + month/year data correctly

const db       = require('../config/db');
const emailSvc = require('../config/emailService');
const itDecl   = require('./itDeclarationController');
const XLSX     = require('xlsx');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');

// ── Professional Tax — state-wise slabs ───────────────────────────────────────
// Add more states here as needed. Falls back to Maharashtra's existing flat
// ₹200 (gross >= 10,000) rule if the employee's state isn't listed, so nothing
// changes for existing employees without this data filled in.
function calcPT(gross, state) {
  const s = (state || '').trim().toLowerCase();

  if (s === 'west bengal') {
    if (gross <= 8500)  return 0;
    if (gross <= 10000) return 0;
    if (gross <= 15000) return 110;
    if (gross <= 25000) return 130;
    if (gross <= 40000) return 150;
    return 200; // above 40,000
  }

  // Maharashtra / default — existing behaviour, unchanged
  return gross >= 10000 ? 200 : 0;
}


const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls'].includes(ext)) cb(null, true);
    else cb(new Error('Only Excel files allowed'));
  }
});
exports.uploadMiddleware = upload.single('file');

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

// ── Present-day-based salary proration ───────────────────────────────────────
// Uses the ACTUAL number of days in the cycle (28/29/30/31) as the divisor —
// never a fixed 30. A fully-present employee always earns 100% of their
// monthly salary regardless of the month's length; missing days cost more
// (per-day) in shorter months than in longer ones.
//   Per-Day Rate  = Monthly Amount ÷ Total Days in Cycle
//   Earned Amount = MIN(Present Days, Total Days in Cycle) × Per-Day Rate
function proratedAmount(monthlyAmount, presentDays, totalDaysInMonth) {
  if (!totalDaysInMonth) return 0;
  const perDayRate   = monthlyAmount / totalDaysInMonth;
  const effectiveDays = Math.min(presentDays, totalDaysInMonth);
  return perDayRate * effectiveDays;
}

// ── Get Salary Structure ──────────────────────────────────────────────────────
exports.getSalaryStructure = async (req, res) => {
  try {
    const empId = req.params.employee_id || req.query.employee_id || req.user.id;
    const role  = req.user.role;

    // Only HR can view another employee's salary — everyone can view their own.
    if (role !== 'hr' && parseInt(empId) !== req.user.id)
      return res.status(403).json({ success: false, message: 'Access denied' });

    const result = await db.query(
      `SELECT ess.*, e.first_name, e.last_name, e.employee_code,
              d.name AS department_name, des.title AS designation_title
       FROM employee_salary_structure ess
       JOIN employees e ON ess.employee_id = e.id
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       WHERE ess.employee_id=$1`, [empId]
    );
    if (!result.rows.length)
      return res.status(404).json({ success: false, message: 'Salary structure not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Core salary-structure compute + upsert, shared by the HR-facing API
// (upsertSalaryStructure below) and the bulk employee importer, which needs
// to write this inside its own transaction (hence the `queryable` param —
// pass a pg Pool/`db` for standalone calls, or a transaction `client` when
// called from inside one).
// Records the FULL salary structure (every component, incl. auto-calculated
// PF/EPF/EPS/ESI/PT etc.) against the salary-history row for this revision.
// If a history row was just created by the employee save (same Save click),
// the snapshot is attached to it; otherwise (e.g. only PF/ESI applicability
// changed, so the 5 headline fields didn't move) a new revision row is added
// when the structure actually differs from the last snapshot.
async function recordStructureSnapshot(queryable, employeeId, updatedBy) {
  try {
    const st = (await queryable.query(`SELECT * FROM employee_salary_structure WHERE employee_id=$1`, [employeeId])).rows[0];
    if (!st) return;
    const snap = {};
    ['basic','hra','conveyance','special_allowance','gratuity','food_coupon','gross_salary',
     'pf_employee','pf_employer','pf_eps','pf_admin','esi_wages','esi_employee','esi_employer',
     'professional_tax','lwf','total_deductions','net_salary','ctc_monthly','ctc_annual',
     'pf_applicable','esi_applicable','eps_applicable','pf_wage_basis'].forEach(k => { snap[k] = st[k] ?? null; });
    const recent = (await queryable.query(
      `SELECT id FROM employee_salary_history WHERE employee_id=$1 AND changed_at > NOW() - INTERVAL '3 minutes'
       ORDER BY changed_at DESC LIMIT 1`, [employeeId])).rows[0];
    if (recent) {
      await queryable.query(`UPDATE employee_salary_history SET structure_snapshot=$2 WHERE id=$1`, [recent.id, JSON.stringify(snap)]);
      return;
    }
    const last = (await queryable.query(
      `SELECT structure_snapshot FROM employee_salary_history WHERE employee_id=$1 AND structure_snapshot IS NOT NULL
       ORDER BY changed_at DESC LIMIT 1`, [employeeId])).rows[0]?.structure_snapshot;
    if (last && JSON.stringify(last) === JSON.stringify(snap)) return;
    const des = (await queryable.query(
      `SELECT des.title FROM employees e LEFT JOIN designations des ON des.id=e.designation_id WHERE e.id=$1`, [employeeId])).rows[0]?.title || null;
    await queryable.query(
      `INSERT INTO employee_salary_history
         (employee_id, new_ctc, new_basic_salary, new_hra, new_special_allowance, new_travel_allowance,
          changed_by, effective_date, designation_title, structure_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,$8,$9)`,
      [employeeId, st.ctc_annual, st.basic, st.hra, st.special_allowance, st.conveyance, updatedBy || null, des, JSON.stringify(snap)]
    );
  } catch (e) { console.error('[recordStructureSnapshot]', e.message); }
}

let _taxRegimeColReady = false;
async function ensureTaxRegimeCol(q) {
  if (_taxRegimeColReady) return;
  await q.query(`ALTER TABLE employee_salary_structure ADD COLUMN IF NOT EXISTS tax_regime VARCHAR(3) DEFAULT 'new'`);
  _taxRegimeColReady = true;
}
exports.ensureTaxRegimeCol = ensureTaxRegimeCol;

async function computeAndSaveSalaryStructure(queryable, employeeId, fields, updatedBy) {
  const conveyance = 0; // Conveyance allowance is not used anywhere
  const {
    basic = 0, hra = 0, special_allowance = 0,
    gratuity = 0, food_coupon = 0, pf_applicable = true, esi_applicable = true,
    pt_applicable = true, lwf_applicable = true, tds_applicable = false, notes,
    pf_wage_basis = 'capped', // 'capped' = PF on min(basic,15000); 'actual' = PF on full basic
    eps_applicable = true     // EPS (A/c-10) doesn't apply to every PF member — see column comment
  } = fields;

  const empStateRes = await queryable.query(`SELECT state FROM employees WHERE id=$1`, [employeeId]);
  const empState = empStateRes.rows[0]?.state;

  const gross        = parseFloat(basic) + parseFloat(hra) + parseFloat(conveyance) + parseFloat(special_allowance) + parseFloat(gratuity) + parseFloat(food_coupon);
  const pfBase       = pf_wage_basis === 'actual' ? parseFloat(basic) : Math.min(parseFloat(basic), 15000);
  // Statutory PF/EPS/EDLI breakup (employer's 12% share splits into EPS +
  // EPF A/c-1 only when EPS applies to this employee; otherwise the whole
  // 12% stays in EPF A/c-1). pf_employer is kept as the COMBINED employer
  // PF cost (A/c-1 + A/c-10) so total_employer_cost/CTC math is unaffected
  // by the split — pf_eps is stored separately just for the A/c-10 figure.
  //   Employee EPF A/c-1        12.00%
  //   Employer EPF A/c-1         3.67%  (12% if EPS not applicable)
  //   EPS A/c-10                 8.33%  (0% if EPS not applicable)
  //   EPF Admin Charges A/c-2    0.50%
  //   EDLI A/c-21                0.50%
  //   EDLI Admin Charges A/c-22  0.00%
  const pf_employee  = pf_applicable  ? Math.round(pfBase * 0.12)  : 0;
  const pf_employer  = pf_applicable  ? Math.round(pfBase * 0.12)  : 0;
  const pf_eps       = pf_applicable && eps_applicable ? Math.round(pfBase * 0.0833) : 0;
  const pf_admin     = pf_applicable  ? Math.round(pfBase * 0.01)  : 0;  // A/c-2 (0.5%) + A/c-21 (0.5%) + A/c-22 (0%)
  const esi_employee = esi_applicable && gross <= 21000 ? Math.round(gross * 0.0075) : 0;
  const esi_employer = esi_applicable && gross <= 21000 ? Math.round(gross * 0.0325) : 0;
  const pt           = pt_applicable  ? calcPT(gross, empState) : 0;
  const lwf          = 0; // Labour Welfare Fund is not used
  const total_ded    = pf_employee + esi_employee + pt;
  const net          = gross - total_ded;
  const ctc          = gross + pf_employer + esi_employer + pf_admin;

  const ctc_monthly = ctc;
  const ctc_annual  = ctc * 12;
  const total_employer_cost = pf_employer + esi_employer + pf_admin;

  await queryable.query(
    `INSERT INTO employee_salary_structure
       (employee_id, basic, hra, conveyance, special_allowance, gratuity, food_coupon, gross_salary,
        pf_applicable, esi_applicable, pt_applicable, lwf_applicable, tds_applicable,
        pf_employee, pf_employer, pf_admin, esi_employee, esi_employer,
        professional_tax, lwf, total_employer_cost,
        total_deductions, net_salary, ctc_monthly, ctc_annual, notes, pf_wage_basis,
        eps_applicable, pf_eps, updated_by, updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,NOW())
     ON CONFLICT(employee_id) DO UPDATE SET
       basic=$2, hra=$3, conveyance=$4, special_allowance=$5, gratuity=$6, food_coupon=$7, gross_salary=$8,
       pf_applicable=$9, esi_applicable=$10, pt_applicable=$11, lwf_applicable=$12, tds_applicable=$13,
       pf_employee=$14, pf_employer=$15, pf_admin=$16, esi_employee=$17, esi_employer=$18,
       professional_tax=$19, lwf=$20, total_employer_cost=$21,
       total_deductions=$22, net_salary=$23, ctc_monthly=$24, ctc_annual=$25, notes=$26, pf_wage_basis=$27,
       eps_applicable=$28, pf_eps=$29,
       updated_by=$30, updated_at=NOW()`,
    [employeeId, basic, hra, conveyance, special_allowance, gratuity, food_coupon, gross,
     pf_applicable, esi_applicable, pt_applicable, lwf_applicable, tds_applicable,
     pf_employee, pf_employer, pf_admin, esi_employee, esi_employer,
     pt, lwf, total_employer_cost,
     total_ded, net, ctc_monthly, ctc_annual, notes || null, pf_wage_basis,
     eps_applicable, pf_eps, updatedBy]
  );
  // ESI Earning = the wage ESI is charged on (gross, only while it is within the ESI ceiling)
  await queryable.query(
    `UPDATE employee_salary_structure SET esi_wages=$2 WHERE employee_id=$1`,
    [employeeId, esi_applicable && gross <= 21000 ? gross : 0]
  );
  // Tax regime used for monthly TDS ('new' unless HR sets 'old' for this employee)
  await ensureTaxRegimeCol(queryable);   // self-heals if the DB migration hasn't run yet
  await queryable.query(
    `UPDATE employee_salary_structure SET tax_regime=$2 WHERE employee_id=$1`,
    [employeeId, fields.tax_regime === 'old' ? 'old' : 'new']
  );
  await recordStructureSnapshot(queryable, employeeId, updatedBy);

  return { gross, net, ctc: ctc_monthly };
}
exports.computeAndSaveSalaryStructure = computeAndSaveSalaryStructure;

// ── Upsert Salary Structure (HR/Admin) ───────────────────────────────────────
exports.upsertSalaryStructure = async (req, res) => {
  try {
    const { employee_id } = req.body;
    if (!employee_id)
      return res.status(400).json({ success: false, message: 'employee_id required' });

    const result = await computeAndSaveSalaryStructure(db, employee_id, req.body, req.user.id);
    res.json({ success: true, message: 'Salary structure saved', data: result });
  } catch (err) {
    console.error("[upsertSalaryStructure error]", err.message, err.detail || "");
    res.status(500).json({ success: false, message: err.message || "Server error" });
  }
};

// ── Upload Payroll Excel (Accounts/HR) ──────────────────────────────────────
exports.uploadPayroll = async (req, res) => {
  const client = await db.getClient();
  try {
    // ✅ DEBUG: Log what we received
    console.log('[uploadPayroll] Request received:');
    console.log('  File:', req.file ? `${req.file.originalname} (${req.file.size} bytes)` : 'NO FILE');
    console.log('  Body:', JSON.stringify(req.body));
    console.log('  User:', `${req.user.id} (${req.user.role})`);

    await client.query('BEGIN');

    // ✅ Validate file
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        message: 'Excel file required. Make sure file input is included in form.' 
      });
    }

    // ✅ Validate month/year
    const { month, year } = req.body;
    if (!month || !year) {
      return res.status(400).json({ 
        success: false, 
        message: 'month and year required in form data' 
      });
    }

    const monthNum = parseInt(month);
    const yearNum  = parseInt(year);
    const monthName = MONTH_NAMES[monthNum - 1];

    // Validate month/year ranges
    if (monthNum < 1 || monthNum > 12 || yearNum < 2020 || yearNum > 2100) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid month (1-12) or year (2020-2100)' 
      });
    }

    // Re-uploading an already-processed month OVERWRITES it (cleanup happens after the file is validated, below)

    // Parse Excel
    let wb, ws, rows;
    try {
      wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
      ws   = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      // Template has one sheet per division (Riskcare / RC Offrole) - read them all
      for (const name of wb.SheetNames.slice(1)) {
        const more = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
        const h = more.findIndex((r, i) => i < 10 && r && r.some(c => String(c || '').toLowerCase().includes('emp code')));
        if (h !== -1) rows = rows.concat(more.slice(h + 1));
      }
      console.log(`[uploadPayroll] Excel parsed: ${rows.length} rows across ${wb.SheetNames.length} sheet(s)`);
    } catch (parseErr) {
      return res.status(400).json({ 
        success: false, 
        message: `Failed to parse Excel: ${parseErr.message}` 
      });
    }

    // Find header row (contains 'Emp Code')
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      if (rows[i] && rows[i].some(c => String(c || '').toLowerCase().includes('emp code'))) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) {
      return res.status(400).json({ 
        success: false, 
        message: 'Could not find header row with "Emp Code" — check Excel format' 
      });
    }
    console.log(`[uploadPayroll] Header found at row ${headerIdx}`);

    // ✅ Clean headers: remove newlines and extra spaces
    const headers = rows[headerIdx].map(h => 
      String(h || '')
        .toLowerCase()
        .replace(/\n/g, ' ')  // Remove newlines
        .replace(/\s+/g, ' ') // Collapse multiple spaces
        .trim()
    );
    const col = (name) => headers.findIndex(h => h.includes(name));

    const iEmpCode    = col('emp code') !== -1 ? col('emp code') : col('full name') !== -1 ? col('full name') : col('name');
    const iWorkDays   = col('working');
    const iPresentDays= col('present');
    const iLOP        = col('lop');
    const iPaidDays   = col('paid');
    const iBasic      = col('basic');
    const iHRA        = col('hra');
    const iConveyance = col('conveyance') !== -1 ? col('conveyance') : col('travel');
    const iOtherAllow = col('defray') !== -1 ? col('defray') : col('other');
    const iGratuity   = col('gratuity');
    const iGross      = col('gross');
    const iPFEmp      = col('pf');
    const iTDS        = col('tds') !== -1 ? col('tds') : col('income tax') !== -1 ? col('income tax') : col('income_tax');
    const iESIEmp     = col('esi');
    const iPT         = col('prof');
    const iLWF        = col('lwf');
    const iTotalDed   = col('total');
    const iLoanEMI    = col('loan') !== -1 ? col('loan') : col('salary deduction') !== -1 ? col('salary deduction') : col('emi') !== -1 ? col('emi') : col('loan/emi');
    const iNetPay     = col('net');
    const iStatus     = col('payment');
    const iRemarks    = col('remarks');
    // One-time monthly adjustments (exact header match so they never collide
    // with the fuzzy column lookups above)
    const colEx = (name) => headers.findIndex(h => h.startsWith(name));
    const iLopRev   = colEx('lop reversal');
    const iFoodBase = colEx('food coupon (monthly');
    const iFoodAdj  = colEx('food coupon adj');
    const iExtraWk  = colEx('extra working');
    const iBonus    = colEx('bonus');
    const iIncent   = colEx('incentive');
    const iOtherEr  = colEx('other earning');
    const iPerfBon  = colEx('performance bonus');
    const iGTL      = colEx('gtl');
    const iLateMark = colEx('late mark');

    if (iEmpCode === -1 || iNetPay === -1) {
      console.warn('[uploadPayroll] Column mapping failed:');
      console.warn('  iEmpCode:', iEmpCode, '→', iEmpCode !== -1 ? `"${headers[iEmpCode]}"` : 'NOT FOUND');
      console.warn('  iNetPay:', iNetPay, '→', iNetPay !== -1 ? `"${headers[iNetPay]}"` : 'NOT FOUND');
      console.warn('  Available headers:', headers);
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid Excel format — missing required columns (Emp Code, Net Pay)' 
      });
    }

    // Overwrite: undo the previous upload's loan-EMI installments and drop its upload record;
    // payroll rows are upserted below (keeping their released/visible state).
    {
      const logs = await client.query(
        `SELECT advance_id FROM loan_recovery_log WHERE payroll_month=$1 AND payroll_year=$2`, [monthNum, yearNum]);
      for (const l of logs.rows)
        await client.query(
          `UPDATE advance_salary SET installments_paid=GREATEST(0, installments_paid-1),
                  status=CASE WHEN status='cleared' THEN 'disbursed' ELSE status END, updated_at=NOW() WHERE id=$1`, [l.advance_id]);
      if (logs.rows.length)
        await client.query(`DELETE FROM loan_recovery_log WHERE payroll_month=$1 AND payroll_year=$2`, [monthNum, yearNum]);
      // keep payroll rows: detach them from the old upload so deleting it doesn't cascade
      // every (re)upload starts hidden again - HR must click Release Payslips
      await client.query(`UPDATE payroll SET upload_id=NULL, released=FALSE, released_at=NULL WHERE month=$1 AND year=$2`, [monthNum, yearNum]);
      await client.query(`DELETE FROM payroll_uploads WHERE month=$1 AND year=$2`, [monthNum, yearNum]);
    }

    // Create upload record
    const uploadRec = await client.query(
      `INSERT INTO payroll_uploads(uploaded_by, filename, month, year, row_count, status)
       VALUES($1,$2,$3,$4,0,'pending') RETURNING id`,
      [req.user.id, req.file.originalname, monthNum, yearNum]
    );
    const uploadId = uploadRec.rows[0].id;
    console.log(`[uploadPayroll] Upload record created: id=${uploadId}`);

    let processed = 0, skipped = 0, errors = [];

    // Process data rows
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[iEmpCode]) continue;

      const empCodeOrName = String(row[iEmpCode] || '').trim();
      if (!empCodeOrName) continue;
      // Skip formula hint / instruction rows (start with emoji or non-letter/digit)
      if (!/^[a-zA-Z0-9]/i.test(empCodeOrName)) continue;

      // Find employee — try emp code first, then full name
      let emp;
      if (/^(KC|E|Cont|C-)\d+/i.test(empCodeOrName)) {
        emp = await client.query(
          `SELECT id, state FROM employees WHERE employee_code=$1 AND is_active=true`, 
          [empCodeOrName]
        );
      } else {
        // Name-based lookup
        const parts = empCodeOrName.split(/\s+/);
        const firstName = parts[0];
        const lastName  = parts.slice(1).join(' ');
        emp = await client.query(
          `SELECT id, state FROM employees
           WHERE is_active=true
             AND (LOWER(CONCAT(first_name,' ',last_name)) = LOWER($1)
               OR (LOWER(first_name)=LOWER($2) AND LOWER(last_name)=LOWER($3)))`,
          [empCodeOrName, firstName, lastName]
        );
      }

      if (!emp.rows.length) {
        skipped++;
        errors.push(`Row ${i}: "${empCodeOrName}" → employee not found`);
        console.warn(`[uploadPayroll] Employee not found: "${empCodeOrName}" at row ${i}`);
        continue;
      }

      const empId = emp.rows[0].id;
      const empState = emp.rows[0].state;

      const n = (v) => parseFloat(v) || 0;
      const workDays    = n(row[iWorkDays])   || 26;
      const presentDays = n(row[iPresentDays]);
      const lopDays     = n(row[iLOP]);
      const paidDays    = n(row[iPaidDays])   || presentDays;
      const basic       = n(row[iBasic]);
      const hra         = n(row[iHRA]);
      // Conveyance is no longer a column in the monthly sheet; if the salary
      // structure still carries an amount, keep paying it from there.
      const conveyance  = 0; // no Conveyance allowance anywhere
      const otherAllow  = n(row[iOtherAllow]);
      const gratuity    = n(row[iGratuity]);
      const tds         = iTDS >= 0 ? n(row[iTDS]) : 0;
      const loanEmi     = iLoanEMI >= 0 ? n(row[iLoanEMI]) : 0;
      const statusRaw   = String(row[iStatus] || 'paid').toLowerCase().trim();
      const status      = statusRaw === 'paid' ? 'paid' : 'pending';

      // ── Present-day-based proration ────────────────────────────────────
      // Basic/HRA/Conveyance/Other Allowance/Gratuity in the sheet are the
      // FULL monthly amounts (from salary structure). The system — not the
      // Excel's Gross/Net columns — computes the actual earned salary using
      // the real day-count of this month as the divisor.
      const totalDaysInMonth = new Date(yearNum, monthNum, 0).getDate();
      // LOP Reversal credits LOP days back as paid days (capped at the month).
      const lopReversal = iLopRev >= 0 ? Math.min(n(row[iLopRev]), lopDays) : 0;
      const effPresent  = Math.min(presentDays + lopReversal, totalDaysInMonth);
      const earnedBasic      = proratedAmount(basic,      effPresent, totalDaysInMonth);
      const earnedHRA        = proratedAmount(hra,         effPresent, totalDaysInMonth);
      const earnedConveyance = proratedAmount(conveyance,  effPresent, totalDaysInMonth);
      const earnedOtherAllow = proratedAmount(otherAllow,  effPresent, totalDaysInMonth);
      const earnedGratuity   = proratedAmount(gratuity,    effPresent, totalDaysInMonth);
      // One-time monthly payments / deductions from the sheet (not in salary structure)
      const rd = (i) => i >= 0 ? n(row[i]) : 0;
      const extraWorkSal = rd(iExtraWk), bonusAmt = rd(iBonus), incentive = rd(iIncent),
            otherEarning = rd(iOtherEr), perfBonus = rd(iPerfBon), foodAdj = rd(iFoodAdj);
      const gtlDed = rd(iGTL), lateMarkDed = rd(iLateMark);

      // Statutory deductions recomputed on the EARNED (prorated) figures —
      // PF/ESI scale with actual earned wage; PT/LWF are flat monthly slabs
      // (not prorated) as long as the earned gross still crosses the
      // applicable threshold, matching how the salary structure defines them.
      // Food Coupon is a fixed monthly meal-voucher benefit for select
      // employees — NOT prorated by attendance, added straight from the
      // salary structure (not the uploaded Excel).
      const structRes = await client.query(
        `SELECT pf_applicable, esi_applicable, pt_applicable, lwf_applicable, pf_wage_basis,
                COALESCE(food_coupon,0) AS food_coupon
         FROM employee_salary_structure WHERE employee_id=$1`, [empId]
      );
      const struct = structRes.rows[0] || { pf_applicable: true, esi_applicable: false, pt_applicable: true, lwf_applicable: false, pf_wage_basis: 'capped', food_coupon: 0 };
      // Food coupon base: read from the sheet's "Food Coupon (Monthly)" column when present
      // (this is the bug fix — HR edits it per employee in the sheet, same as Basic/HRA,
      // but the upload was only ever reading the salary-structure value and ignoring it).
      // Older template files without that column fall back to the structure value.
      const foodCouponBase = iFoodBase >= 0 ? n(row[iFoodBase]) : (parseFloat(struct.food_coupon) || 0);
      // Base food coupon + this month's one-time adjustment (can be negative)
      const foodCoupon = foodCouponBase + foodAdj;
      const oneTimeEarnings = extraWorkSal + bonusAmt + incentive + otherEarning + perfBonus;

      const gross = Math.round((earnedBasic + earnedHRA + earnedConveyance + earnedOtherAllow + earnedGratuity + foodCoupon + oneTimeEarnings) * 100) / 100;

      // PF ceiling (₹15,000) applies unless this employee opted for PF on
      // actual basic — either way, applied to the EARNED (prorated) basic
      // for this pay cycle, not the full monthly figure.
      const pfBase   = struct.pf_wage_basis === 'actual' ? earnedBasic : Math.min(earnedBasic, 15000);
      const pfEmp    = struct.pf_applicable  ? Math.round(pfBase * 0.12) : 0;
      const esiEmp   = struct.esi_applicable && gross <= 21000 ? Math.round(gross * 0.0075) : 0;
      const pt       = struct.pt_applicable  ? calcPT(gross, empState) : 0;
      const lwf      = 0; // Labour Welfare Fund is not used

      const totalDed = pfEmp + esiEmp + pt + lwf + tds + loanEmi + gtlDed + lateMarkDed;
      const netPay   = Math.round((gross - totalDed) * 100) / 100;

      // Upsert payroll record. Food Coupon is stored in the pre-existing
      // (previously unused) other_allowance column.
      await client.query(
        `INSERT INTO payroll
           (employee_id, month, year, working_days, present_days, lop_days, paid_days,
            basic, hra, conveyance, special_allowance, gratuity, other_allowance, gross_salary,
            pf_employee, esi_employee, professional_tax, lwf, loan_emi_recovery, tds,
            total_deductions, net_salary, status, payment_date, upload_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
         ON CONFLICT(employee_id, month, year) DO UPDATE SET
           working_days=$4, present_days=$5, lop_days=$6, paid_days=$7,
           basic=$8, hra=$9, conveyance=$10, special_allowance=$11, gratuity=$12, other_allowance=$13, gross_salary=$14,
           pf_employee=$15, esi_employee=$16, professional_tax=$17, lwf=$18, loan_emi_recovery=$19,
           tds=$20, total_deductions=$21, net_salary=$22, status=$23, payment_date=$24, upload_id=$25`,
        [empId, monthNum, yearNum, workDays, presentDays, lopDays, effPresent,
         earnedBasic, earnedHRA, earnedConveyance, earnedOtherAllow, earnedGratuity, foodCoupon, gross,
         pfEmp, esiEmp, pt, lwf, loanEmi, tds,
         totalDed, netPay, status,
         status === 'paid' ? `${yearNum}-${String(monthNum).padStart(2,'0')}-28` : null,
         uploadId]
      );
      await client.query(
        `UPDATE payroll SET bonus=$3, extra_working_salary=$4, incentive=$5, other_earning=$6,
                performance_bonus=$7, food_coupon_adjustment=$8, gtl_deduction=$9,
                late_mark_deduction=$10, lop_reversal=$11,
                lop_days=GREATEST(0, lop_days - $11)
         WHERE employee_id=$1 AND month=$2 AND year=$12`,
        [empId, monthNum, bonusAmt, extraWorkSal, incentive, otherEarning, perfBonus, foodAdj,
         gtlDed, lateMarkDed, lopReversal, yearNum]
      );
      // ESI Earning (wage) + employer contribution for this month's payroll
      const esiApplies = struct.esi_applicable && gross <= 21000;
      await client.query(
        `UPDATE payroll SET esi_wages=$3, esi_employer=$4 WHERE employee_id=$1 AND month=$2 AND year=$5`,
        [empId, monthNum, esiApplies ? gross : 0, esiApplies ? Math.round(gross * 0.0325) : 0, yearNum]
      );

      // Auto-deduct loan EMI if any
      if (loanEmi > 0) {
        await client.query(
          `UPDATE advance_salary
           SET installments_paid = installments_paid + 1,
               balance_remaining = GREATEST(0, balance_remaining - $1),
               updated_at = NOW()
           WHERE employee_id=$2 AND status='approved' AND balance_remaining > 0`,
          [loanEmi, empId]
        );
        await client.query(
          `UPDATE advance_salary SET status='cleared', updated_at=NOW()
           WHERE employee_id=$1 AND status='approved' AND balance_remaining <= 0`,
          [empId]
        );
      }

      // ── Auto-record salary in project_expenditures for assigned employees ──
      try {
        const projCtrl = require('./projectController');
        // Get the payroll row id we just upserted
        const payRow = await client.query(
          `SELECT id FROM payroll WHERE employee_id=$1 AND month=$2 AND year=$3`,
          [empId, monthNum, yearNum]
        );
        if (payRow.rows.length) {
          await projCtrl.hookPayrollExpenditure(empId, netPay, monthNum, yearNum, payRow.rows[0].id);
        }
      } catch(hookErr) { console.error('[payroll.hook]', hookErr.message); }

      // ── Auto-record EMI installment if employee has active loan ──────────
      try {
        const emiCheck = await client.query(
          `SELECT id, monthly_emi, installments_paid, total_installments
           FROM advance_salary
           WHERE employee_id=$1 AND status='disbursed'
             AND installments_paid < total_installments
           ORDER BY approved_at ASC LIMIT 1`,
          [empId]
        );
        if (emiCheck.rows.length) {
          const loan = emiCheck.rows[0];
          const newPaid   = parseInt(loan.installments_paid) + 1;
          const isCleared = newPaid >= parseInt(loan.total_installments);
          await client.query(
            `INSERT INTO loan_recovery_log
               (advance_id, employee_id, payroll_month, payroll_year, emi_amount, installment_no, notes)
             VALUES($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT(advance_id,payroll_month,payroll_year) DO NOTHING`,
            [loan.id, empId, monthNum, yearNum, loan.monthly_emi, newPaid,
             'Installment ' + newPaid + '/' + loan.total_installments]
          );
          await client.query(
            `UPDATE advance_salary
             SET installments_paid=$1,
                 status=CASE WHEN $2 THEN 'cleared' ELSE status END,
                 updated_at=NOW()
             WHERE id=$3`,
            [newPaid, isCleared, loan.id]
          );
          const notifMsg = isCleared
            ? '🎉 Your loan is fully repaid! Final installment (' + newPaid + '/' + loan.total_installments + ') deducted from ' + monthName + ' ' + yearNum + ' salary.'
            : '💳 EMI installment ' + newPaid + '/' + loan.total_installments + ' of ₹' + parseFloat(loan.monthly_emi).toLocaleString('' + (CONFIG.currencyLocale||'en-IN') + "'") + ' deducted from ' + monthName + ' ' + yearNum + ' salary.';
          await client.query(
            `INSERT INTO notifications(employee_id,type,title,message) VALUES($1,'advance',$2,$3)`,
            [empId, isCleared ? '✅ Loan Cleared!' : '💳 EMI Deducted', notifMsg]
          ).catch(()=>{});
        }
      } catch(emiErr) { console.error('[EMI auto-record]', emiErr.message); }

      processed++;
    }

    // Mark upload as processed
    await client.query(
      `UPDATE payroll_uploads
       SET status='processed', row_count=$1, processed_by=$2, processed_at=NOW()
       WHERE id=$3`,
      [processed, req.user.id, uploadId]
    );

    await client.query('COMMIT');
    console.log(`[uploadPayroll] Complete: processed=${processed}, skipped=${skipped}, upload_id=${uploadId}`);

    // Payslips are NOT visible / notified yet - HR/Accounts review, then click "Release Payslips".

    res.json({
      success: true,
      message: `${monthName} ${yearNum} payroll uploaded. ${processed} processed, ${skipped} skipped. Review it, then click Release Payslips.`,
      data: { upload_id: uploadId, processed, skipped, month: monthNum, year: yearNum, errors: errors.slice(0, 10) }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[uploadPayroll] Error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  } finally { 
    client.release(); 
  }
};

// ── Get Payroll List ──────────────────────────────────────────────────────────
exports.getPayroll = async (req, res) => {
  try {
    const { month, year, employee_id, status } = req.query;
    const userId   = req.user.id;
    const userRole = req.user.role;

    let conds = [], params = [], idx = 1;

    if (!['super_admin','accounts','hr'].includes(userRole)) {
      conds.push(`p.employee_id=$${idx++}`);
      params.push(userId);
    } else if (employee_id) {
      conds.push(`p.employee_id=$${idx++}`);
      params.push(employee_id);
    }

    if (month)  { conds.push(`p.month=$${idx++}`);  params.push(parseInt(month)); }
    if (year)   { conds.push(`p.year=$${idx++}`);   params.push(parseInt(year)); }
    if (status) { conds.push(`p.status=$${idx++}`); params.push(status); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const result = await db.query(
      `SELECT p.*,
              CONCAT(e.first_name,' ',e.last_name) AS employee_name,
              e.employee_code, d.name AS department_name,
              des.title AS designation_title
       FROM payroll p
       JOIN employees e ON p.employee_id = e.id
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       ${where}
       ORDER BY p.year DESC, p.month DESC, e.first_name`, params
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get Payslip (single employee, single month) ───────────────────────────────
exports.getPayslip = async (req, res) => {
  try {
    const { employee_id, month, year } = req.query;
    const userId   = req.user.id;
    const userRole = req.user.role;
    console.log(`[getPayslip] userId=${userId} role=${userRole} employee_id=${employee_id} month=${month} year=${year}`);

    const empId = employee_id || userId;
    const isPayrollStaff = ['super_admin','accounts','hr'].includes(userRole);
    if (!isPayrollStaff && parseInt(empId) !== userId)
      return res.status(403).json({ success: false, message: 'Access denied' });

    const result = await db.query(
      `SELECT p.*,
              e.first_name, e.last_name,
              CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
              e.employee_code, e.email,
              e.pan_number, e.uan_number, e.pf_number, e.esi_number,
              e.bank_name, e.bank_account,
              e.bank_ifsc, e.date_of_birth, e.joining_date,
              e.city, e.state, e.location, e.gender, e.aadhar_number, e.employment_type, e.division,
              d.name AS department_name, des.title AS designation_title,
              CONCAT(m.first_name,' ',m.last_name) AS manager_name,
              s.basic AS fixed_basic, s.hra AS fixed_hra, s.conveyance AS fixed_conveyance,
              s.special_allowance AS fixed_special_allowance, s.gratuity AS fixed_gratuity
       FROM payroll p
       JOIN employees e ON p.employee_id = e.id
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       LEFT JOIN employees m ON e.reporting_manager_id = m.id
       LEFT JOIN employee_salary_structure s ON s.employee_id = p.employee_id
       WHERE p.employee_id=$1 AND p.month=$2 AND p.year=$3
         AND ($4::boolean OR p.released IS TRUE)`,
      [empId, parseInt(month), parseInt(year), isPayrollStaff && parseInt(empId) !== userId]
    );

    if (!result.rows.length) {
      console.error(`[getPayslip] No row found for employee_id=${empId} month=${month} year=${year}`);
      return res.status(404).json({ success: false, message: 'Payslip not found' });
    }

    const ps = result.rows[0];
    ps.month_name = MONTH_NAMES[ps.month - 1];
    ps.lwf = 0; ps.conveyance = 0; ps.fixed_conveyance = 0; // Conveyance is not used anywhere

    // Derive pf_employer, pf_admin if not stored in DB (the monthly `payroll`
    // table only ever stores pf_employee -- see computePayroll above -- so
    // this fallback always fires for the payslip's employer-side display).
    // pf_admin = EPF Admin A/c-2 (0.5%) + EDLI A/c-21 (0.5%) + EDLI Admin
    // A/c-22 (0%) = 1% of PF wages; pfEmp is 12% of PF wages, so 1%/12% of it.
    const pfEmp = parseFloat(ps.pf_employee || 0);
    if (pfEmp > 0) {
      if (!parseFloat(ps.pf_employer)) ps.pf_employer = pfEmp;
      if (!parseFloat(ps.pf_admin))    ps.pf_admin    = Math.round(pfEmp * 0.01 / 0.12);
    }
    const gross = parseFloat(ps.gross_salary || 0);
    if (!parseFloat(ps.professional_tax)) ps.professional_tax = calcPT(gross, ps.state);
    if (gross > 21000) { ps.esi_employee = 0; ps.esi_employer = 0; }

    // Recompute totals for display
    const empDed =
      parseFloat(ps.pf_employee      || 0) +
      parseFloat(ps.esi_employee     || 0) +
      parseFloat(ps.professional_tax || 0) +
      parseFloat(ps.lwf              || 0) +
      parseFloat(ps.tds              || 0) +
      parseFloat(ps.loan_emi_recovery|| 0);
    const emprContrib =
      parseFloat(ps.pf_employer      || 0) +
      parseFloat(ps.pf_admin         || 0) +
      parseFloat(ps.esi_employer     || 0);
    ps.total_deductions_display = empDed + emprContrib;
    ps.net_salary_display = gross - empDed;

    const paidDays    = parseFloat(ps.paid_days    || 0);
    const presentDays = parseFloat(ps.present_days || 0);
    ps.paid_leave = Math.max(0, paidDays - presentDays);

    // Fetch leave balance
    const leaveCount = await db.query(
      `SELECT COALESCE(SUM(
         CASE WHEN status='approved' THEN
           (to_date - from_date + 1)
         ELSE 0 END
       ), 0) AS leave_days
       FROM leave_requests
       WHERE employee_id=$1
         AND EXTRACT(MONTH FROM from_date)=$2
         AND EXTRACT(YEAR FROM from_date)=$3
         AND status='approved'`,
      [empId, parseInt(month), parseInt(year)]
    );
    ps.paid_leave = parseFloat(leaveCount.rows[0]?.leave_days || ps.paid_leave);

    // Leave balances for the payslip leave table
    const leaveBalRes = await db.query(
      `SELECT lt.name, lt.code,
              lb.allocated, lb.used, lb.carry_forward,
              (lb.allocated + lb.carry_forward - lb.used - lb.pending) AS available
       FROM leave_balances lb
       JOIN leave_types lt ON lb.leave_type_id = lt.id
       WHERE lb.employee_id = $1 AND lb.year = $2
       ORDER BY lt.id`,
      [empId, parseInt(year)]
    );
    // Per-month figures for the payslip leave table: credit (monthly accrual log) and utilized (approved leave that month)
    const acc = (await db.query(
      `SELECT el_accrued, sl_accrued, cl_accrued FROM monthly_leave_accrual_log WHERE employee_id=$1 AND month=$2 AND year=$3`,
      [empId, parseInt(month), parseInt(year)]).catch(() => ({ rows: [] }))).rows[0] || {};
    const usedM = {};
    (await db.query(
      `SELECT lt.code, COALESCE(SUM(lr.days_requested),0) AS d
       FROM leave_requests lr JOIN leave_types lt ON lt.id=lr.leave_type_id
       WHERE lr.employee_id=$1 AND lr.status='approved'
         AND EXTRACT(MONTH FROM lr.from_date)=$2 AND EXTRACT(YEAR FROM lr.from_date)=$3
       GROUP BY lt.code`, [empId, parseInt(month), parseInt(year)])).rows.forEach(r => { usedM[r.code] = parseFloat(r.d) || 0; });
    const creditM = { EL: parseFloat(acc.el_accrued) || 0, SL: parseFloat(acc.sl_accrued) || 0, CL: parseFloat(acc.cl_accrued) || 0 };
    ps.leave_balances = leaveBalRes.rows.map(l => ({ ...l, credit_month: creditM[l.code] || 0, utilized_month: usedM[l.code] || 0 }));

    res.json({ success: true, data: ps });
  } catch (err) {
    console.error('[getPayslip]', err.message, err.stack);
    res.status(500).json({ success: false, message: 'Payslip error: ' + err.message });
  }
};

// ── Release payslips for a month: makes them visible + notifies employees ────
// POST /payroll/release { month, year }
exports.releasePayslips = async (req, res) => {
  try {
    const month = parseInt(req.body.month), year = parseInt(req.body.year);
    if (!month || !year) return res.status(400).json({ success: false, message: 'month and year required' });
    const r = await db.query(
      `UPDATE payroll SET released=TRUE, released_at=NOW()
       WHERE month=$1 AND year=$2 AND released IS NOT TRUE RETURNING employee_id`, [month, year]);
    const monthName = MONTH_NAMES[month - 1];
    for (const row of r.rows) {
      emailSvc.notifyPayslipReleased(row.employee_id, monthName, year).catch(console.error);
      const t = `💰 ${monthName} ${year} payslip is ready`;
      const msg = `Your payslip for ${monthName} ${year} has been released. Open Payslip to view it.`;
      db.query(`INSERT INTO notifications(employee_id,type,title,message) VALUES($1,'payslip',$2,$3)`, [row.employee_id, t, msg]).catch(console.error);
      try { require('../config/pushService').sendPush(row.employee_id, t, msg, { channel: 'riskcare_general' }); } catch (_) {}
    }
    res.json({ success: true, message: `${r.rows.length} payslip(s) released for ${monthName} ${year} - employees notified.`, data: { released: r.rows.length } });
  } catch (err) {
    console.error('[releasePayslips]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Delete an upload (wrong file) so the month can be re-uploaded ─────────────
// DELETE /payroll/uploads/:id - blocked once any payslip of that month is released.
exports.deleteUpload = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const up = (await client.query(`SELECT * FROM payroll_uploads WHERE id=$1`, [req.params.id])).rows[0];
    if (!up) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Upload not found' }); }
    const rel = await client.query(`SELECT 1 FROM payroll WHERE month=$1 AND year=$2 AND released=TRUE LIMIT 1`, [up.month, up.year]);
    if (rel.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Payslips for this month are already released - cannot delete.' });
    }

    // Undo the loan-EMI installments this month's upload recorded
    const logs = await client.query(
      `SELECT * FROM loan_recovery_log WHERE payroll_month=$1 AND payroll_year=$2`, [up.month, up.year]);
    for (const l of logs.rows) {
      await client.query(
        `UPDATE advance_salary SET installments_paid=GREATEST(0, installments_paid-1),
                status=CASE WHEN status='cleared' THEN 'disbursed' ELSE status END, updated_at=NOW()
         WHERE id=$1`, [l.advance_id]);
    }
    if (logs.rows.length)
      await client.query(`DELETE FROM loan_recovery_log WHERE payroll_month=$1 AND payroll_year=$2`, [up.month, up.year]);

    const del = await client.query(`DELETE FROM payroll WHERE month=$1 AND year=$2`, [up.month, up.year]);
    await client.query(`DELETE FROM payroll_uploads WHERE month=$1 AND year=$2`, [up.month, up.year]);
    await client.query('COMMIT');
    res.json({ success: true, message: `${MONTH_NAMES[up.month - 1]} ${up.year} upload deleted (${del.rowCount} payslip rows removed). You can upload it again.` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[deleteUpload]', err.message);
    res.status(500).json({ success: false, message: err.message });
  } finally { client.release(); }
};

// ── Get Upload History ────────────────────────────────────────────────────────
// GET /payroll/export?month=&year= — full-breakup Excel of processed payroll
exports.exportPayroll = async (req, res) => {
  try {
    const month = parseInt(req.query.month), year = parseInt(req.query.year);
    const r = await db.query(
      `SELECT p.*, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
              d.name AS department_name, des.title AS designation_title
       FROM payroll p JOIN employees e ON e.id=p.employee_id
       LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN designations des ON des.id=e.designation_id
       WHERE ($1::int IS NULL OR p.month=$1) AND ($2::int IS NULL OR p.year=$2)
       ORDER BY p.year DESC, p.month DESC, e.employee_code`, [month || null, year || null]);
    const cols = [
      ['Emp Code','employee_code'],['Name','employee_name'],['Department','department_name'],['Designation','designation_title'],
      ['Month','month'],['Year','year'],['Working Days','working_days'],['Present Days','present_days'],['LOP Days','lop_days'],
      ['LOP Reversal','lop_reversal'],['Paid Days','paid_days'],['Basic','basic'],['HRA','hra'],['Defray Allowance','special_allowance'],
      ['Gratuity','gratuity'],['Food Coupon (incl. adj)','other_allowance'],['Extra Working Salary','extra_working_salary'],
      ['Bonus','bonus'],['Incentive','incentive'],['Other Earning','other_earning'],['Performance Bonus','performance_bonus'],
      ['Gross Salary','gross_salary'],['PF (Employee)','pf_employee'],['ESI Earning','esi_wages'],['ESI (Employee)','esi_employee'],
      ['ESI (Employer)','esi_employer'],['Prof Tax','professional_tax'],['TDS','tds'],['GTL Deduction','gtl_deduction'],
      ['Late Mark Deduction','late_mark_deduction'],['Salary Advance Recovery','loan_emi_recovery'],['Total Deductions','total_deductions'],
      ['Net Pay','net_salary'],['Status','status']];
    const money = new Set(cols.map(c => c[1]).filter(k => !['employee_code','employee_name','department_name','designation_title','status','month','year'].includes(k)));
    const aoa = [cols.map(c => c[0]), ...r.rows.map(row => cols.map(([, k]) => {
      const v = row[k]; if (v === null || v === undefined) return '';
      return money.has(k) || k === 'month' || k === 'year' ? Number(v) : v; }))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = cols.map((c, i) => ({ wch: i < 4 ? 20 : 13 }));
    ws['!freeze'] = { xSplit: 2, ySplit: 1 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Payroll');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="Payroll_${month || 'All'}_${year || 'All'}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('[exportPayroll]', err.message);
    res.status(500).json({ success: false, message: 'Export failed: ' + err.message });
  }
};

exports.getUploads = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT pu.*,
              CONCAT(u.first_name,' ',u.last_name) AS uploaded_by_name,
              CONCAT(p.first_name,' ',p.last_name) AS processed_by_name,
              (SELECT COUNT(*) FROM payroll pr WHERE pr.month=pu.month AND pr.year=pu.year) AS payslip_count,
              (SELECT COUNT(*) FROM payroll pr WHERE pr.month=pu.month AND pr.year=pu.year AND pr.released) AS released_count
       FROM payroll_uploads pu
       JOIN employees u ON pu.uploaded_by = u.id
       LEFT JOIN employees p ON pu.processed_by = p.id
       ORDER BY pu.created_at DESC LIMIT 50`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get All Salary Structures (HR/Admin) ──────────────────────────────────────
exports.getAllSalaryStructures = async (req, res) => {
  try {
    const search      = req.query.search      || '';
    const employee_id = req.query.employee_id ? parseInt(req.query.employee_id) : null;
    let where  = 'WHERE e.is_active=true';
    let params = [];
    let pidx   = 1;
    if (employee_id) {
      where += ` AND e.id = $${pidx++}`;
      params.push(employee_id);
    } else if (search) {
      where += ` AND (LOWER(CONCAT(e.first_name,' ',e.last_name)) LIKE $${pidx} OR LOWER(e.employee_code) LIKE $${pidx})`;
      params.push(`%${search.toLowerCase()}%`);
      pidx++;
    }
    const result = await db.query(
      `SELECT
         e.id AS employee_id, e.employee_code,
         CONCAT(e.first_name,' ',e.last_name) AS employee_name,
         d.name AS department_name, des.title AS designation_title,
         COALESCE(ess.basic,0)              AS basic,
         COALESCE(ess.hra,0)               AS hra,
         COALESCE(ess.conveyance,0)        AS conveyance,
         COALESCE(ess.special_allowance,0) AS special_allowance,
         COALESCE(ess.gratuity,0)          AS gratuity,
         COALESCE(ess.food_coupon,0)       AS food_coupon,
         COALESCE(ess.gross_salary,0)      AS gross_salary,
         COALESCE(ess.pf_employee,0)       AS pf_employee,
         COALESCE(ess.pf_employer,0)       AS pf_employer,
         COALESCE(ess.esi_wages,0)         AS esi_wages,
         COALESCE(ess.esi_employee,0)      AS esi_employee,
         COALESCE(ess.esi_employer,0)      AS esi_employer,
         COALESCE(ess.professional_tax,0)  AS professional_tax,
         COALESCE(ess.lwf,0)              AS lwf,
         COALESCE(ess.total_deductions,0)  AS total_deductions,
         COALESCE(ess.net_salary,0)        AS net_salary,
         COALESCE(ess.ctc_monthly,0)       AS ctc_monthly,
         COALESCE(ess.ctc_annual,0)        AS ctc_annual,
         COALESCE(ess.pf_wage_basis,'capped') AS pf_wage_basis,
         COALESCE(ess.pf_applicable,true)   AS pf_applicable,
         COALESCE(ess.eps_applicable,true)  AS eps_applicable,
         COALESCE(ess.pf_eps,0)             AS pf_eps,
         COALESCE(ess.pf_admin,0)           AS pf_admin,
         COALESCE(ess.esi_applicable,true)  AS esi_applicable,
         COALESCE(ess.pt_applicable,true)   AS pt_applicable,
         COALESCE(ess.lwf_applicable,true)  AS lwf_applicable,
         COALESCE(ess.tds_applicable,false) AS tds_applicable,
         e.state AS employee_state,
         COALESCE(itd.monthly_tds, 0) AS it_monthly_tds,
         itd.regime AS it_regime
       FROM employees e
       LEFT JOIN employee_salary_structure ess ON ess.employee_id = e.id
       LEFT JOIN departments d   ON e.department_id = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       LEFT JOIN LATERAL (
         SELECT monthly_tds, regime FROM it_declarations
         WHERE employee_id = e.id
         ORDER BY financial_year DESC LIMIT 1
       ) itd ON true
       ${where}
       ORDER BY d.name, e.first_name`,
      params
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Form 16 — Generate Part A + Part B ───────────────────────────────────────
// Financial Year: April to March (e.g. FY 2024-25 = Apr 2024 to Mar 2025)
exports.getForm16 = async (req, res) => {
  try {
    const reqUser = req.user;
    const empId   = req.query.employee_id ? parseInt(req.query.employee_id) : reqUser.id;
    const fy      = req.query.fy; // e.g. "2024-25"

    // Only admin/hr/accounts can view others; employees can only view their own
    if (!['super_admin','admin','hr','accounts'].includes(reqUser.role) && empId !== reqUser.id)
      return res.status(403).json({ success: false, message: 'Access denied' });

    if (!fy || !/^\d{4}-\d{2}$/.test(fy))
      return res.status(400).json({ success: false, message: 'fy required (e.g. 2024-25)' });

    const startYear = parseInt(fy.split('-')[0]);
    const endYear   = startYear + 1;

    // Months: Apr(4)–Dec(12) of startYear, Jan(1)–Mar(3) of endYear
    const payrollRows = await db.query(
      `SELECT p.*,
              e.first_name, e.last_name, e.employee_code, e.pan_number, e.uan_number,
              e.pf_number, e.date_of_birth, e.joining_date, e.city, e.aadhar_number,
              d.name AS department_name, des.title AS designation_title
       FROM payroll p
       JOIN employees e ON p.employee_id = e.id
       LEFT JOIN departments d  ON e.department_id  = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       WHERE p.employee_id = $1
         AND p.status IN ('processed','paid','pending')
         AND (
           (p.year = $2 AND p.month >= 4) OR
           (p.year = $3 AND p.month <= 3)
         )
       ORDER BY p.year, p.month`,
      [empId, startYear, endYear]
    );

    if (!payrollRows.rows.length)
      return res.status(404).json({ success: false, message: `No payroll data found for FY ${fy}` });

    // Aggregate annual figures
    let grossTotal = 0, basicTotal = 0, hraTotal = 0, convTotal = 0,
        specialTotal = 0, pfEmpTotal = 0, pfEmprTotal = 0, esiEmpTotal = 0,
        ptTotal = 0, lwfTotal = 0, tdsTotal = 0, loanTotal = 0, netTotal = 0;

    const monthlyBreakdown = payrollRows.rows.map(p => {
      const gross   = parseFloat(p.gross_salary       || 0);
      const basic   = parseFloat(p.basic              || 0);
      const hra     = parseFloat(p.hra                || 0);
      const conv    = parseFloat(p.conveyance         || 0);
      const special = parseFloat(p.special_allowance  || 0);
      const pfEmp   = parseFloat(p.pf_employee        || 0);
      const pfEmpr  = parseFloat(p.pf_employer        || 0);
      const esiEmp  = parseFloat(p.esi_employee       || 0);
      const pt      = parseFloat(p.professional_tax   || 0);
      const lwf     = parseFloat(p.lwf                || 0);
      const tds     = parseFloat(p.tds                || 0);
      const loan    = parseFloat(p.loan_emi_recovery  || 0);
      const net     = parseFloat(p.net_salary         || 0);

      grossTotal   += gross;  basicTotal  += basic;   hraTotal    += hra;
      convTotal    += conv;   specialTotal+= special; pfEmpTotal  += pfEmp;
      pfEmprTotal  += pfEmpr; esiEmpTotal += esiEmp;  ptTotal     += pt;
      lwfTotal     += lwf;    tdsTotal    += tds;     loanTotal   += loan;
      netTotal     += net;

      return {
        month: MONTH_NAMES[p.month - 1], year: p.year,
        gross, basic, hra, conv, special,
        pf_employee: pfEmp, pf_employer: pfEmpr, esi_employee: esiEmp,
        professional_tax: pt, lwf, tds, loan_emi_recovery: loan, net_salary: net
      };
    });

    const emp = payrollRows.rows[0];

    // ── Part A — TDS details ───────────────────────────────────────────────
    const partA = {
      employer_name:    'Krishi Care And Management Services Pvt Ltd',
      employer_tan:     process.env.EMPLOYER_TAN || 'MUMK24593C',
      employer_address: process.env.EMPLOYER_ADDRESS || 'Office No. 617, 6th Floor, Hubtown Viva, Western Express Highway, Shankarwadi, Jogeshwari (East), Mumbai, Maharashtra — 400060',
      employee_name:    `${emp.first_name} ${emp.last_name}`,
      employee_pan:     emp.pan_number   || 'NOT PROVIDED',
      employee_code:    emp.employee_code,
      financial_year:   fy,
      assessment_year:  `${endYear}-${String(endYear + 1).slice(2)}`,
      total_tds_deducted:   Math.round(tdsTotal),
      total_tds_deposited:  Math.round(tdsTotal),
      quarter_summary: [
        { quarter: 'Q1 (Apr–Jun)', months: ['April','May','June'] },
        { quarter: 'Q2 (Jul–Sep)', months: ['July','August','September'] },
        { quarter: 'Q3 (Oct–Dec)', months: ['October','November','December'] },
        { quarter: 'Q4 (Jan–Mar)', months: ['January','February','March'] }
      ].map(q => {
        const qRows = monthlyBreakdown.filter(m => q.months.includes(m.month));
        return {
          quarter: q.quarter,
          tds_deducted:  Math.round(qRows.reduce((s, r) => s + r.tds, 0)),
          tds_deposited: Math.round(qRows.reduce((s, r) => s + r.tds, 0))
        };
      })
    };

    // ── Part B — Salary & deduction details ───────────────────────────────
    // Standard deduction u/s 16 = ₹50,000 (FY 2023-24 onwards)
    const stdDeduction    = 50000;
    const grossIncome     = Math.round(grossTotal);
    const taxableIncome   = Math.max(0, grossIncome - stdDeduction);

    // 80C: PF employee contribution (capped at ₹1.5L)
    const sec80C          = Math.min(Math.round(pfEmpTotal), 150000);
    const totalExemptions = sec80C;
    const netTaxableIncome= Math.max(0, taxableIncome - totalExemptions);

    const partB = {
      financial_year: fy,
      assessment_year: `${endYear}-${String(endYear + 1).slice(2)}`,
      // Gross salary breakdown
      basic:             Math.round(basicTotal),
      hra:               Math.round(hraTotal),
      conveyance:        0,
      special_allowance: Math.round(specialTotal),
      gross_salary:      grossIncome,
      // Deductions
      standard_deduction: stdDeduction,
      income_chargeable:  taxableIncome,
      // Chapter VI-A
      sec_80c_pf:         sec80C,
      total_deductions_vi_a: totalExemptions,
      net_taxable_income: netTaxableIncome,
      // Tax
      total_tds:          Math.round(tdsTotal),
      // Statutory deductions (not tax deductions, but shown for reference)
      pf_employee_total:  Math.round(pfEmpTotal),
      pf_employer_total:  Math.round(pfEmprTotal),
      esi_employee_total: Math.round(esiEmpTotal),
      professional_tax_total: Math.round(ptTotal),
      lwf_total:          Math.round(lwfTotal),
      net_salary_total:   Math.round(netTotal)
    };

    res.json({
      success: true,
      data: {
        employee: {
          name:        `${emp.first_name} ${emp.last_name}`,
          code:        emp.employee_code,
          pan:         emp.pan_number   || 'NOT PROVIDED',
          uan:         emp.uan_number   || '',
          pf_number:   emp.pf_number    || '',
          department:  emp.department_name   || '',
          designation: emp.designation_title || '',
          dob:         emp.date_of_birth     || ''
        },
        financial_year:     fy,
        assessment_year:    partA.assessment_year,
        part_a:             partA,
        part_b:             partB,
        monthly_breakdown:  monthlyBreakdown
      }
    });
  } catch (err) {
    console.error('[getForm16 Error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Form 16 — List available financial years for an employee ────────────────
exports.getForm16Years = async (req, res) => {
  try {
    const reqUser = req.user;
    const empId   = req.query.employee_id ? parseInt(req.query.employee_id) : reqUser.id;

    if (!['super_admin','admin','hr','accounts'].includes(reqUser.role) && empId !== reqUser.id)
      return res.status(403).json({ success: false, message: 'Access denied' });

    const rows = await db.query(
      `SELECT DISTINCT year, month FROM payroll
       WHERE employee_id=$1 AND status IN ('processed','paid','pending')
       ORDER BY year, month`,
      [empId]
    );

    // Build financial years
    const fySet = new Set();
    rows.rows.forEach(r => {
      const fy = r.month >= 4
        ? `${r.year}-${String(r.year + 1).slice(2)}`
        : `${r.year - 1}-${String(r.year).slice(2)}`;
      fySet.add(fy);
    });

    // Only include FYs where we have at least some payroll data
    const fys = Array.from(fySet).sort().reverse();
    res.json({ success: true, data: fys });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Download Payroll Template Excel ──────────────────────────────────────────
// GET /api/payroll/template?month=5&year=2026
// Pre-fills all active employees with their salary structure so accounts just
// fills in Working Days, Present Days, LOP and any adjustments
exports.downloadPayrollTemplate = async (req, res) => {
  try {
    // xlsx-js-style (already used elsewhere, e.g. itDeclarationController) so we
    // can color-code Earnings / Deductions / Totals sections in the template.
    const XLSX = require('xlsx-js-style');
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const monthName = MONTH_NAMES[m - 1];
    const daysInMonth = new Date(y, m, 0).getDate();

    // ── Fetch all active employees with salary structure ──────────────────
    const empResult = await db.query(`
      SELECT e.id, e.employee_code,
             CONCAT(e.first_name,' ',e.last_name) AS full_name,
             d.name AS department, des.title AS designation,
             e.employee_category, e.employment_type, e.division,
             COALESCE(s.basic,           e.basic_salary,       0) AS basic,
             COALESCE(s.hra,             e.hra,                0) AS hra,
             COALESCE(s.conveyance,      e.conveyance,         0) AS conveyance,
             COALESCE(s.special_allowance,e.special_allowance, 0) AS special_allowance,
             COALESCE(s.gratuity,                              0) AS gratuity,
             COALESCE(s.food_coupon,                           0) AS food_coupon,
             COALESCE(s.gross_salary,                          0) AS gross_salary,
             COALESCE(s.pf_employee,                           0) AS pf_employee,
             COALESCE(s.pf_employer,                           0) AS pf_employer,
             COALESCE(s.pf_eps,                                0) AS pf_eps,
             COALESCE(s.pf_admin,                              0) AS pf_admin,
             COALESCE(s.esi_wages,                             0) AS esi_wages,
             COALESCE(s.esi_employee,                          0) AS esi_employee,
             COALESCE(s.esi_employer,                          0) AS esi_employer,
             COALESCE(s.professional_tax,                      0) AS professional_tax,
             COALESCE(s.lwf,                                   0) AS lwf,
             COALESCE(s.tds,                                   0) AS tds,
             COALESCE(s.tds_applicable,                    false) AS tds_applicable,
             COALESCE(s.total_deductions,                      0) AS total_deductions,
             COALESCE(s.net_salary,                            0) AS net_salary
      FROM employees e
      LEFT JOIN departments  d   ON e.department_id  = d.id
      LEFT JOIN designations des ON e.designation_id = des.id
      LEFT JOIN employee_salary_structure s ON s.employee_id = e.id
      WHERE e.is_active = true
      ORDER BY d.name, e.first_name`);

    const employees = empResult.rows;

    // ── Pre-fill THIS month's attendance: paid days / LOP days per employee ──
    // Present Days here = paid days (present + weekly offs + holidays + paid
    // leave), because salary is prorated over calendar days on upload.
    const pad2 = (n) => String(n).padStart(2, '0');
    const mStart = `${y}-${pad2(m)}-01`, mEnd = `${y}-${pad2(m)}-${pad2(daysInMonth)}`;
    const [attR, lvR, holR, empMetaR] = await Promise.all([
      db.query(`SELECT employee_id, TO_CHAR(date,'YYYY-MM-DD') AS d, status FROM attendance WHERE date BETWEEN $1 AND $2`, [mStart, mEnd]),
      db.query(`SELECT lr.employee_id, TO_CHAR(lr.from_date,'YYYY-MM-DD') AS f, TO_CHAR(lr.to_date,'YYYY-MM-DD') AS t, lt.code
                FROM leave_requests lr JOIN leave_types lt ON lt.id=lr.leave_type_id
                WHERE lr.status='approved' AND lr.from_date <= $2 AND lr.to_date >= $1`, [mStart, mEnd]),
      db.query(`SELECT TO_CHAR(date,'YYYY-MM-DD') AS d FROM holidays WHERE date BETWEEN $1 AND $2`, [mStart, mEnd]),
      db.query(`SELECT id, saturday_policy, TO_CHAR(joining_date,'YYYY-MM-DD') AS jd FROM employees WHERE is_active=true`)
    ]);
    const attMap = {}; attR.rows.forEach(r => { (attMap[r.employee_id] = attMap[r.employee_id] || {})[r.d] = (r.status || '').toLowerCase(); });
    const lvMap = {}; lvR.rows.forEach(r => { (lvMap[r.employee_id] = lvMap[r.employee_id] || []).push(r); });
    const holSet = new Set(holR.rows.map(r => r.d));
    const metaMap = {}; empMetaR.rows.forEach(r => { metaMap[r.id] = r; });
    const todayStr = new Date().toISOString().slice(0, 10);
    const monthAttendance = (empId) => {
      const meta = metaMap[empId] || {};
      let paid = 0, lop = 0;
      // No attendance and no approved leave this month => nothing worked: all LOP
      // (weekly offs / holidays / future days are not free paid days for them).
      const workedAny = Object.values(attMap[empId] || {}).some(st => st && st !== 'absent' && st !== 'lwp');
      if (!workedAny && !(lvMap[empId] || []).length) return { paid: 0, lop: daysInMonth };
      for (let day = 1; day <= daysInMonth; day++) {
        const ds = `${y}-${pad2(m)}-${pad2(day)}`;
        const dow = new Date(y, m - 1, day).getDay();
        if (meta.jd && ds < meta.jd) { lop += 1; continue; }                   // before joining
        const satOff = dow === 6 && meta.saturday_policy !== 'all_working' && [2, 4].includes(Math.ceil(day / 7));
        const off = dow === 0 || satOff || holSet.has(ds);
        const st = (attMap[empId] || {})[ds];
        const lv = (lvMap[empId] || []).find(l => ds >= l.f && ds <= l.t);
        if (st === 'absent' || st === 'lwp') { lop += 1; continue; }
        if (st === 'h-lwp') { lop += 0.5; paid += 0.5; continue; }
        if (st === 'half-day') { paid += 0.5; lop += 0.5; continue; }
        if (st) { paid += 1; continue; }                                        // present/late/od/wfh/leave/h-*/etc.
        if (off) { paid += 1; continue; }
        if (ds > todayStr) { paid += 1; continue; }                             // future unmarked day
        if (lv && lv.code !== 'LWP') { paid += 1; continue; }                   // approved paid leave, no attendance row
        lop += 1;
      }
      return { paid, lop };
    };

    // ── Build Excel ───────────────────────────────────────────────────────
    const wb = XLSX.utils.book_new();

    // ── Sheet 1: Payroll Input Template ───────────────────────────────────
    // Grouped in proper payroll sequence: Identity/Attendance → Fixed Earnings
    // (Monthly = full structure amount, Actual = what's actually earned this
    // month after attendance is applied) → One-time Earnings → Gross →
    // Deductions → Totals/Net Pay → Status. Each group gets its own color
    // (see COL_GROUPS below) so Earning vs Deduction is obvious at a glance,
    // and the same sheet is what gets uploaded for payroll AND used for payslips.
    const HEADERS = [
      // ── A: Employee Identification ──────────────────────────────────────────
      'Emp Code', 'Full Name', 'Department', 'Division', 'Designation', 'Category',
      // ── B: Attendance ───────────────────────────────────────────────────────
      'Working Days', 'Present Days', 'LOP Days', 'LOP Reversal (Days)', 'Paid Days',
      // ── C: Fixed Earnings (Monthly structure + Actual after LOP) ────────────
      'Basic (Monthly)', 'Basic (Actual)',
      'HRA (Monthly)', 'HRA (Actual)',
      'Defray Allowance (Monthly)', 'Defray Allowance (Actual)',
      'Gratuity (Monthly)', 'Gratuity (Actual)',
      'Food Coupon (Monthly)', 'Food Coupon (Actual)',
      // ── D: Variable / One-time Earnings ─────────────────────────────────────
      'Food Coupon Adjustment', 'Extra Working Salary', 'Bonus', 'Incentive', 'Other Earning', 'Performance Bonus',
      // ── E: Gross ─────────────────────────────────────────────────────────────
      'Gross Salary',
      // ── F: Employee Deductions ───────────────────────────────────────────────
      'PF (Employee)', 'ESI (Employee)', 'Prof Tax', 'TDS',
      'GTL Deduction', 'Late Mark Deduction', 'Salary Advance Recovery (Loan/EMI)',
      'Total Deductions',
      // ── G: Net Pay ───────────────────────────────────────────────────────────
      'Net Pay',
      // ── H: Employer Contributions ────────────────────────────────────────────
      'EPF Employer (A/c-1)', 'EPS Employer (A/c-10)', 'PF Admin + EDLI (Employer)', 'ESI Earning (Wages)', 'ESI (Employer)',
      'Total Employer Contribution',
      // ── I: CTC Summary ───────────────────────────────────────────────────────
      'Total Cost to Company', 'Gross CTC (Monthly)', 'Actual CTC',
      // ── J: Status ────────────────────────────────────────────────────────────
      'Payment Status', 'Remarks'
    ];

    // Section color map — used for header fill + a light tint on data rows.
    const COL_GROUPS = [
      { from: 'Emp Code',                   to: 'Paid Days',                          headBg:'475569', headFg:'FFFFFF', dataBg:'F1F5F9' }, // A: identity/attendance - slate
      { from: 'Basic (Monthly)',            to: 'Food Coupon (Actual)',               headBg:'15803D', headFg:'FFFFFF', dataBg:'DCFCE7' }, // C: fixed earnings - green
      { from: 'Food Coupon Adjustment',     to: 'Performance Bonus',                 headBg:'0D9488', headFg:'FFFFFF', dataBg:'CCFBF1' }, // D: variable earnings - teal
      { from: 'Gross Salary',              to: 'Gross Salary',                       headBg:'B45309', headFg:'FFFFFF', dataBg:'FEF3C7' }, // E: gross - amber
      { from: 'PF (Employee)',             to: 'Salary Advance Recovery (Loan/EMI)', headBg:'B91C1C', headFg:'FFFFFF', dataBg:'FEE2E2' }, // F: employee deductions - red
      { from: 'Total Deductions',          to: 'Total Deductions',                   headBg:'991B1B', headFg:'FFFFFF', dataBg:'FECACA' }, // F: deductions total - darker red
      { from: 'Net Pay',                   to: 'Net Pay',                            headBg:'1D4ED8', headFg:'FFFFFF', dataBg:'DBEAFE' }, // G: net pay - blue
      { from: 'EPF Employer (A/c-1)',      to: 'ESI (Employer)',                     headBg:'7C3AED', headFg:'FFFFFF', dataBg:'EDE9FE' }, // H: employer contributions - purple
      { from: 'Total Employer Contribution',to: 'Total Employer Contribution',        headBg:'6D28D9', headFg:'FFFFFF', dataBg:'DDD6FE' }, // H: employer total - darker purple
      { from: 'Total Cost to Company',     to: 'Actual CTC',                         headBg:'0369A1', headFg:'FFFFFF', dataBg:'E0F2FE' }, // I: CTC summary - sky blue
      { from: 'Payment Status',            to: 'Remarks',                            headBg:'475569', headFg:'FFFFFF', dataBg:'F1F5F9' }, // J: status - slate
    ];
    const groupForCol = (idx) => {
      const label = HEADERS[idx];
      const gi = COL_GROUPS.findIndex(g => HEADERS.indexOf(g.from) <= idx && idx <= HEADERS.indexOf(g.to));
      return gi >= 0 ? COL_GROUPS[gi] : COL_GROUPS[0];
    };
    const thinBorder = { top:{style:'thin',color:{rgb:'CBD5E1'}}, bottom:{style:'thin',color:{rgb:'CBD5E1'}}, left:{style:'thin',color:{rgb:'CBD5E1'}}, right:{style:'thin',color:{rgb:'CBD5E1'}} };
    const headerCellStyle = (g) => ({ font:{name:'Calibri',sz:10,bold:true,color:{rgb:g.headFg}}, fill:{patternType:'solid',fgColor:{rgb:g.headBg}}, alignment:{horizontal:'center',vertical:'center',wrapText:true}, border:thinBorder });
    const dataCellStyle = (g, isNum) => ({ font:{name:'Calibri',sz:10,color:{rgb:'1F2937'}}, fill:{patternType:'solid',fgColor:{rgb:g.dataBg}}, alignment:{horizontal:isNum?'right':'left',vertical:'center'}, border:thinBorder, numFmt:isNum?'#,##0.00':undefined });

    const buildPayrollSheet = async (employeesList) => {
    const tdsFy = m >= 4 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
    const tdsParams = await itDecl.getTdsSheetParams(tdsFy).catch(() => null);
    // Turn a flattened slab array [{lo,step},...] into an Excel array-constant literal,
    // e.g. {0,400000,800000,...} / {0,0.05,0.10,...} for a SUMPRODUCT tiered-tax formula.
    const arrLit = (arr, key) => `{${arr.map(x => x[key]).join(',')}}`;
    // tdsFormulaMap[i] holds the live-formula parts for data row i (0-indexed from first data row).
    // Built inside the per-employee Promise.all callback and read in the formula loop below.
    const tdsFormulaMap = [];
    const dataRows = [];
    for (let idx = 0; idx < employeesList.length; idx++) { const e = employeesList[idx]; {
        const gross   = parseFloat(e.gross_salary)   || 0;
        // Fetch active EMI for this employee
        const emiRes  = await db.query(
          `SELECT monthly_emi, installments_paid, total_installments
           FROM advance_salary
           WHERE employee_id=$1 AND status='disbursed' AND installments_paid < total_installments
           ORDER BY approved_at ASC LIMIT 1`, [e.id]);
        const activeEMI = emiRes.rows[0] || null;
        const monthAtt = monthAttendance(e.id);
        const pf      = parseFloat(e.pf_employee)    || 0;
        const esi     = parseFloat(e.esi_employee)   || 0;
        const pt      = parseFloat(e.professional_tax) || 0;
        // TDS: if the structure has TDS enabled, pre-fill this month's amount from the
        // employee's IT Declaration (regime, deductions, prev-employer income, TDS paid YTD).
        let tds = parseFloat(e.tds) || 0;
        tdsFormulaMap[idx] = null;   // default: no live formula
        if (e.tds_applicable) {
          try {
            const fixedMonthly = (parseFloat(e.basic) || 0) + (parseFloat(e.hra) || 0) + (parseFloat(e.special_allowance) || 0) + (parseFloat(e.gratuity) || 0);
            const earned = fixedMonthly * (daysInMonth ? monthAtt.paid / daysInMonth : 0) + (parseFloat(e.food_coupon) || 0);
            const r = await itDecl.estimateMonthlyTds(e.id, m, y, earned);
            tds = r.tds || 0;
            if (tdsParams && r.months_left > 0) {
              tdsFormulaMap[idx] = {
                baseIncome: r.base_income || 0, deductions: r.deductions || 0, alreadyDeducted: r.already_deducted || 0,
                monthsLeft: r.months_left, regime: r.regime === 'old' ? 'old' : 'new',
              };
            }
          } catch (err) { console.error('TDS estimate failed for', e.employee_code, err.message); }
        } else { tds = 0; }
        const totalDed= parseFloat(e.total_deductions) || (pf + esi + pt + tds);
        const net     = parseFloat(e.net_salary)     || Math.max(0, gross - totalDed);
        const row = [
          // A: Employee Identification
          e.employee_code, e.full_name, e.department || '', e.division || '', e.designation || '', e.employee_category || '',
          // B: Attendance
          daysInMonth, monthAtt.paid, monthAtt.lop, 0, monthAtt.paid,
          // C: Fixed Earnings (Monthly + Actual pairs)
          parseFloat(e.basic)             || 0, 0,
          parseFloat(e.hra)               || 0, 0,
          parseFloat(e.special_allowance) || 0, 0,
          parseFloat(e.gratuity)          || 0, 0,
          parseFloat(e.food_coupon)       || 0, 0,
          // D: Variable / One-time Earnings
          0, 0, 0, 0, 0, 0,
          // E: Gross Salary
          gross,
          // F: Employee Deductions — PF(emp), ESI(emp), PT, TDS, GTL, Late Mark, Loan
          pf, esi, pt, tds, 0, 0,
          parseFloat(activeEMI ? activeEMI.monthly_emi : 0),
          totalDed,          // Total Deductions (formula below)
          // G: Net Pay
          net,               // Net Pay (formula below)
          // H: Employer Contributions
          Math.max(0, (parseFloat(e.pf_employer) || 0) - (parseFloat(e.pf_eps) || 0)),  // EPF Employer A/c-1
          parseFloat(e.pf_eps)      || 0,   // EPS A/c-10
          parseFloat(e.pf_admin)    || 0,   // PF Admin + EDLI
          parseFloat(e.esi_wages)   || 0,   // ESI Earning (Wages)
          parseFloat(e.esi_employer)|| 0,   // ESI (Employer)
          0,                 // Total Employer Contribution (formula below)
          // I: CTC Summary
          0,                 // Total Cost to Company (formula below)
          gross + (parseFloat(e.pf_employer) || 0) + (parseFloat(e.pf_admin) || 0) + (parseFloat(e.esi_employer) || 0), // Gross CTC (Monthly)
          0,                 // Actual CTC (formula below)
          // J: Status
          'Paid', '',
        ];
        dataRows.push(row);
      } }
    const rows = [
      // Row 0: Title
      [`HRMS — Payroll Input Template | ${monthName} ${y} | Total Working Days: ${daysInMonth}`],
      // Row 1: Instructions
      [`Present/LOP days are pre-filled from attendance. Bonus, deductions and EMI apply to this month only. TDS is pre-filled from IT Declaration (where TDS is enabled). Status: Paid / Hold / Pending`],
      // Row 2: Empty spacer
      [],
      // Row 3: Headers
      HEADERS,
      // Data rows
      ...dataRows,
    ];

    const ws1 = XLSX.utils.aoa_to_sheet(rows);

    // ── Live formulas: edit Present Days / LOP Reversal / any one-time item and
    // Paid Days, LOP, Gross, Total Deductions and Net Pay recalculate in Excel.
    // (Statutory PF/ESI/PT/LWF stay as values; the system recomputes them on upload.)
    const hx = (label) => HEADERS.indexOf(label);
    const LT = (label) => XLSX.utils.encode_col(hx(label));   // column letter by header
    for (let i = 4; i < rows.length; i++) {
      const R = i + 1, r = rows[i];
      const num = (label) => Number(r[hx(label)]) || 0;
      const wd = num('Working Days'), pr = num('Present Days'), lopRev = num('LOP Reversal (Days)');
      const lop = Math.max(0, wd - pr);
      const paid = Math.min(wd, pr + Math.min(lopRev, lop));
      const prorateFactor = wd ? paid / wd : 0;
      // Fixed components (Basic/HRA/Defray/Gratuity) prorate by attendance; Food
      // Coupon is a flat monthly meal-voucher benefit and is NEVER prorated.
      const earnedFixed = (num('Basic (Monthly)') + num('HRA (Monthly)') + num('Defray Allowance (Monthly)') + num('Gratuity (Monthly)')) * prorateFactor;
      const foodCouponMonthly = num('Food Coupon (Monthly)');
      const oneTime = ['Food Coupon Adjustment','Extra Working Salary','Bonus','Incentive','Other Earning','Performance Bonus'].reduce((a, l) => a + num(l), 0);
      const gross = Math.round((earnedFixed + foodCouponMonthly + oneTime) * 100) / 100;
      const ded = num('PF (Employee)') + num('ESI (Employee)') + num('Prof Tax') + num('TDS') +
                  num('GTL Deduction') + num('Late Mark Deduction') + num('Salary Advance Recovery (Loan/EMI)');
      const setF = (label, f, v) => { ws1[LT(label) + R] = { t: 'n', f, v, s: dataCellStyle(groupForCol(hx(label)), true) }; };
      // TDS: a real, editable tax formula, not a frozen number. Because it references
      // this row's own live Gross Salary cell, TDS recalculates in Excel the moment HR
      // edits Present Days, LOP, Bonus, etc. — a 30-day month and a 26-day month get
      // different TDS automatically, with no re-upload needed.
      const tdsFormulaParts = tdsFormulaMap[i - 4];  // i=4 is first data row, maps to idx=0
      if (tdsFormulaParts) {
        const p  = tdsFormulaParts;
        const lo = arrLit(p.regime === 'old' ? tdsParams.oldSlabs : tdsParams.newSlabs, 'lo');
        const st = arrLit(p.regime === 'old' ? tdsParams.oldSlabs : tdsParams.newSlabs, 'step');
        const rebateThresh = p.regime === 'old' ? tdsParams.rebateOld    : tdsParams.rebateNew;
        const rebateAmt    = p.regime === 'old' ? tdsParams.rebateOldAmt : tdsParams.rebateNewAmt;
        const taxable = `MAX(0,${p.baseIncome}-${p.deductions}+${LT('Gross Salary')}${R})`;
        const slabTax = `SUMPRODUCT((${taxable}>${lo})*(${taxable}-${lo})*${st})`;
        const afterRebate = p.regime === 'new'
          ? `IF(${taxable}<=${rebateThresh},MAX(0,${slabTax}-${rebateAmt}),MIN(${slabTax},${taxable}-${rebateThresh}))`
          : `IF(${taxable}<=${rebateThresh},MAX(0,${slabTax}-${rebateAmt}),${slabTax})`;
        const annualTax = `ROUND((${afterRebate})*(1+${tdsParams.cess}),0)`;
        setF('TDS', `MAX(0,ROUND((${annualTax}-${p.alreadyDeducted})/${p.monthsLeft},0))`, num('TDS'));
      }
      setF('LOP Days', `MAX(0,${LT('Working Days')}${R}-${LT('Present Days')}${R})`, lop);
      setF('Paid Days', `MIN(${LT('Working Days')}${R},${LT('Present Days')}${R}+MIN(${LT('LOP Reversal (Days)')}${R},${LT('LOP Days')}${R}))`, paid);
      // "Actual" columns = what's actually earned this month once attendance is
      // applied. Food Coupon (Actual) mirrors the monthly value since it's flat.
      setF('Basic (Actual)', `ROUND(${LT('Basic (Monthly)')}${R}*IF(${LT('Working Days')}${R}>0,${LT('Paid Days')}${R}/${LT('Working Days')}${R},0),2)`, Math.round(num('Basic (Monthly)') * prorateFactor * 100) / 100);
      setF('HRA (Actual)', `ROUND(${LT('HRA (Monthly)')}${R}*IF(${LT('Working Days')}${R}>0,${LT('Paid Days')}${R}/${LT('Working Days')}${R},0),2)`, Math.round(num('HRA (Monthly)') * prorateFactor * 100) / 100);
      setF('Defray Allowance (Actual)', `ROUND(${LT('Defray Allowance (Monthly)')}${R}*IF(${LT('Working Days')}${R}>0,${LT('Paid Days')}${R}/${LT('Working Days')}${R},0),2)`, Math.round(num('Defray Allowance (Monthly)') * prorateFactor * 100) / 100);
      setF('Gratuity (Actual)', `ROUND(${LT('Gratuity (Monthly)')}${R}*IF(${LT('Working Days')}${R}>0,${LT('Paid Days')}${R}/${LT('Working Days')}${R},0),2)`, Math.round(num('Gratuity (Monthly)') * prorateFactor * 100) / 100);
      setF('Food Coupon (Actual)', `${LT('Food Coupon (Monthly)')}${R}`, foodCouponMonthly);
      setF('Gross Salary', `ROUND((${LT('Basic (Monthly)')}${R}+${LT('HRA (Monthly)')}${R}+${LT('Defray Allowance (Monthly)')}${R}+${LT('Gratuity (Monthly)')}${R})*IF(${LT('Working Days')}${R}>0,${LT('Paid Days')}${R}/${LT('Working Days')}${R},0)+${LT('Food Coupon (Monthly)')}${R}+SUM(${LT('Food Coupon Adjustment')}${R}:${LT('Performance Bonus')}${R}),2)`, gross);
      setF('Total Deductions', `SUM(${LT('PF (Employee)')}${R}:${LT('Salary Advance Recovery (Loan/EMI)')}${R})`, ded);
      const empr = num('EPF Employer (A/c-1)') + num('EPS Employer (A/c-10)') + num('PF Admin + EDLI (Employer)') + num('ESI (Employer)');
      setF('Total Employer Contribution', `${LT('EPF Employer (A/c-1)')}${R}+${LT('EPS Employer (A/c-10)')}${R}+${LT('PF Admin + EDLI (Employer)')}${R}+${LT('ESI (Employer)')}${R}`, empr);
      setF('Total Cost to Company', `${LT('Gross Salary')}${R}+${LT('Total Employer Contribution')}${R}`, gross + empr);
      setF('Actual CTC', `${LT('Gross Salary')}${R}+${LT('Total Employer Contribution')}${R}`, gross + empr);
      setF('Net Pay', `MAX(0,${LT('Gross Salary')}${R}-${LT('Total Deductions')}${R})`, Math.max(0, gross - ded));

      // Style every remaining (non-formula) cell in this data row by its section color.
      for (let c = 0; c < HEADERS.length; c++) {
        const addr = XLSX.utils.encode_col(c) + R;
        if (!ws1[addr]) ws1[addr] = { t: 's', v: '' };
        if (!ws1[addr].s) {
          const isNum = typeof rows[i][c] === 'number';
          ws1[addr].s = dataCellStyle(groupForCol(c), isNum);
        }
      }
    }

    // Style the header row (row index 3 → Excel row 4) by section color.
    for (let c = 0; c < HEADERS.length; c++) {
      const addr = XLSX.utils.encode_col(c) + '4';
      if (ws1[addr]) ws1[addr].s = headerCellStyle(groupForCol(c));
    }

    // Column widths — sized by column purpose rather than a hand-counted list,
    // so adding/removing a column can never silently misalign the widths.
    ws1['!cols'] = HEADERS.map(h => {
      if (h === 'Full Name') return {wch:24};
      if (h === 'Designation') return {wch:22};
      if (h === 'Department') return {wch:16};
      if (h === 'Division') return {wch:14};
      if (h === 'Emp Code' || h === 'Category') return {wch:11};
      if (h.includes('Days')) return {wch:11};
      if (h === 'Remarks') return {wch:20};
      if (h === 'Payment Status') return {wch:14};
      if (['Gross Salary','Net Pay','Total Deductions','Total Employer Contribution','Total Cost to Company'].includes(h)) return {wch:16};
      return {wch:13};
    });

    // Freeze top 4 rows and first 2 cols
    ws1['!freeze'] = { xSplit: 2, ySplit: 4 };

    // Merge title row across all cols
    ws1['!merges'] = [
      { s:{r:0,c:0}, e:{r:0,c:HEADERS.length-1} },
      { s:{r:1,c:0}, e:{r:1,c:HEADERS.length-1} },
    ];

    return ws1;
    };

    // Two sheets: Risk Care division, and RC Offroll. Upload reads both.
    const isOffrole = (e) => /off\s*-?\s*rol/i.test(e.division || '');
    XLSX.utils.book_append_sheet(wb, await buildPayrollSheet(employees.filter(e => !isOffrole(e))), `Risk Care ${monthName} ${y}`);
    XLSX.utils.book_append_sheet(wb, await buildPayrollSheet(employees.filter(isOffrole)), `RC Offroll ${monthName} ${y}`);

    // ── Sheet 2: Instructions ─────────────────────────────────────────────
    const instrRows = [
      ['HRMS Payroll Template — How to Fill'],
      [''],
      ['COLUMNS TO FILL (highlighted in template):'],
      ['Column', 'What to Enter'],
      ['Working Days',      `Total working days in ${monthName} ${y} (pre-filled as ${daysInMonth})`],
      ['Present Days',      'Paid days for the month (present + weekly offs + holidays + paid leave) - PRE-FILLED from attendance, edit if needed'],
      ['LOP Days',          'Loss of Pay days - PRE-FILLED from attendance (absent / unpaid leave / before joining)'],
      ['LOP Reversal (Days)','Days of LOP to credit back this month (paid for those days; LOP Days reduces by the same)'],
      ['Food Coupon (Monthly)','Fixed monthly meal-voucher amount for this employee - pre-filled from salary structure. Leave 0 if not eligible. NOT prorated by attendance.'],
      ['Food Coupon Adjustment','One-time +/- adjustment ON TOP of Food Coupon (Monthly), for this month only (e.g. a correction)'],
      ['Extra Working Salary / Bonus / Incentive / Other Earning / Performance Bonus','One-time earnings for THIS month only - not prorated, not part of the salary structure'],
      ['GTL / Late Mark Deduction','One-time deductions for THIS month only'],
      ['Salary Advance Recovery','Monthly advance/loan EMI recovery (pre-filled from active advance; reduces the advance balance)'],
      ['Payment Status',    'Paid / Hold / Pending'],
      ['Remarks',           'Any note e.g. "Full & Final", "Bonus included", etc.'],
      [''],
      ['COLUMNS PRE-FILLED (do not change unless needed):'],
      ['Column', 'Source'],
      ['Basic/HRA/Defray/Gratuity/Food Coupon (Monthly)', 'Full monthly amount from employee salary structure in system'],
      ['Basic/HRA/Defray/Gratuity/Food Coupon (Actual)', 'What is actually earned THIS month after attendance/LOP is applied - live formulas, for review only, do not edit'],
      ['Gross Salary',      'Sum of all earnings'],
      ['PF, ESI, PT',  'From salary structure'],
      ['TDS',  'Auto-calculated from IT Declaration if TDS is enabled for the employee; edit if needed'],
      ['Total Deductions',  'Sum of all deductions'],
      ['Net Pay',           'Gross - Total Deductions (system recalculates on upload)'],
      [''],
      ['UPLOAD RULES:'],
      ['• Emp Code must match exactly (e.g. KC7708)'],
      ['• Do not add/remove columns'],
      ['• Do not change sheet name'],
      ['• Save as .xlsx before uploading'],
      ['• Upload via Payroll → Upload Payroll Excel tab'],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(instrRows);
    ws2['!cols'] = [{wch:28},{wch:60}];
    XLSX.utils.book_append_sheet(wb, ws2, 'Instructions');

    // ── Send ──────────────────────────────────────────────────────────────
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="HRMS_Payroll_Template_${monthName}_${y}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);

  } catch (err) {
    console.error('[downloadPayrollTemplate] FULL ERROR:', err.stack || err.message);
    res.status(500).json({ success: false, message: err.message, stack: err.stack });
  }
};

// ── Download Salary Structure Bulk Upload Template (HR/Admin) ──────────────
// One-time setup sheet — Basic/HRA/etc per employee, not tied to a month.
// Different from /payroll/template (which is the monthly attendance run).
exports.downloadSalaryStructureTemplate = async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const empResult = await db.query(`
      SELECT e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS full_name,
             d.name AS department, des.title AS designation,
             e.bank_name, e.bank_branch, e.bank_account, e.bank_ifsc,
             COALESCE(s.basic,0) AS basic, COALESCE(s.hra,0) AS hra,
             COALESCE(s.conveyance,0) AS conveyance,
             COALESCE(s.special_allowance,0) AS special_allowance,
             COALESCE(s.gratuity,0) AS gratuity,
             COALESCE(s.food_coupon,0) AS food_coupon,
             COALESCE(s.pf_applicable,true)  AS pf_applicable,
             COALESCE(s.esi_applicable,false) AS esi_applicable,
             COALESCE(s.pt_applicable,true)  AS pt_applicable,
             COALESCE(s.lwf_applicable,false) AS lwf_applicable,
             COALESCE(s.tds_applicable,false) AS tds_applicable,
             COALESCE(s.pf_wage_basis,'capped') AS pf_wage_basis,
             COALESCE(s.eps_applicable,true) AS eps_applicable
      FROM employees e
      LEFT JOIN departments  d   ON e.department_id  = d.id
      LEFT JOIN designations des ON e.designation_id = des.id
      LEFT JOIN employee_salary_structure s ON s.employee_id = e.id
      WHERE e.is_active = true
      ORDER BY d.name, e.first_name`);

    const HEADERS = [
      'Emp Code', 'Full Name', 'Department', 'Designation',
      'Bank', 'Branch', 'Account No.', 'IFSC',
      'Basic', 'HRA', 'Defray Allowance', 'Gratuity', 'Food Coupon',
      'PF Applicable (Y/N)', 'PF Basis (Capped/Actual)', 'EPS Applicable (Y/N)',
      'ESI Applicable (Y/N)', 'PT Applicable (Y/N)',
      'TDS Applicable (Y/N)'
    ];
    const yn = v => v ? 'Y' : 'N';

    const rows = [
      ['HRMS — Salary Structure Bulk Upload Template'],
      ['⚠️  Fill Basic, HRA, Defray Allowance, Gratuity (monthly ₹ amounts). PF/ESI/PT/TDS are auto-calculated by the system based on the Y/N applicability columns — just mark Y or N.'],
      [],
      HEADERS,
      ...empResult.rows.map(e => [
        e.employee_code, e.full_name, e.department || '', e.designation || '',
        e.bank_name || '', e.bank_branch || '', e.bank_account || '', e.bank_ifsc || '',
        parseFloat(e.basic) || 0, parseFloat(e.hra) || 0,
        parseFloat(e.special_allowance) || 0, parseFloat(e.gratuity) || 0, parseFloat(e.food_coupon) || 0,
        yn(e.pf_applicable), e.pf_wage_basis === 'actual' ? 'Actual' : 'Capped', yn(e.eps_applicable),
        yn(e.esi_applicable), yn(e.pt_applicable),
        yn(e.tds_applicable)
      ])
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = HEADERS.map((h,i) => ({ wch: i<4 ? 20 : (i>=4 && i<=7 ? 18 : 14) }));
    ws['!merges'] = [
      { s:{r:0,c:0}, e:{r:0,c:HEADERS.length-1} },
      { s:{r:1,c:0}, e:{r:1,c:HEADERS.length-1} },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Salary Structure');

    const instrRows = [
      ['HRMS Salary Structure — How to Fill'],
      [''],
      ['This is a ONE-TIME setup sheet — sets each employee\'s recurring monthly'],
      ['salary structure (Basic/HRA/etc). It is NOT the monthly attendance run —'],
      ['use Payroll → Upload Payroll Excel for that, every month.'],
      [''],
      ['Column', 'What to Enter'],
      ['Bank',             'Employee\'s bank name, e.g. HDFC, SBI (leave blank to keep existing value unchanged)'],
      ['Branch',           'Bank branch name (leave blank to keep existing value unchanged)'],
      ['Account No.',      'Employee\'s bank account number (leave blank to keep existing value unchanged)'],
      ['IFSC',             'Bank branch IFSC code (leave blank to keep existing value unchanged)'],
      ['Basic',            'Monthly basic salary in ₹'],
      ['HRA',              'Monthly House Rent Allowance in ₹'],
      ['Defray Allowance', 'Any other fixed monthly allowance in ₹'],
      ['Gratuity',         'Monthly gratuity component in ₹ (usually 0 unless applicable)'],
      ['Food Coupon',      'Monthly meal-voucher/food coupon benefit in ₹ — only applicable to select employees, leave 0 for everyone else'],
      ['PF Applicable',    'Y if Provident Fund applies to this employee, else N'],
      ['PF Basis',         'Capped = PF calculated on min(Basic, ₹15,000), the statutory PF wage ceiling (default). Actual = PF calculated on the FULL Basic, uncapped — for employees who opted out of the ceiling.'],
      ['EPS Applicable',   'Y if the employer\'s 12% PF share splits into EPS (A/c-10, 8.33%) + EPF (A/c-1, 3.67%), which is the default for most employees. N if EPS does not apply to this employee — their full 12% employer share stays in EPF A/c-1 instead.'],
      ['ESI Applicable',   'Y if ESI applies (only relevant when gross ≤ ₹21,000), else N'],
      ['PT Applicable',    'Y if Professional Tax applies, else N'],
      ['TDS Applicable',   'Y to deduct TDS (amount is auto-calculated from the IT Declaration in the payroll template)'],
      [''],
      ['UPLOAD RULES:'],
      ['• Emp Code must match exactly (e.g. E066)'],
      ['• Do not add/remove columns or rename the sheet'],
      ['• PF/ESI/PT amounts are auto-calculated — do not add columns for them'],
      ['• Save as .xlsx before uploading'],
      ['• Upload via Employees page → Upload Salary'],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(instrRows);
    ws2['!cols'] = [{wch:22},{wch:70}];
    XLSX.utils.book_append_sheet(wb, ws2, 'Instructions');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="HRMS_Salary_Structure_Template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('[downloadSalaryStructureTemplate]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Bulk Upload Salary Structure (HR/Admin) ─────────────────────────────────
exports.bulkUploadSalaryStructure = async (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false, message: 'Excel file required' });

  const XLSX = require('xlsx');
  let wb, rows;
  try {
    wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets['Salary Structure'] || wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    // Row 0 = title, row 1 = instructions, row 2 = spacer, row 3 = headers, row 4+ = data
    const headerIdx = raw.findIndex(r => String(r[0] || '').trim() === 'Emp Code');
    if (headerIdx === -1)
      return res.status(400).json({ success: false, message: 'Could not find header row ("Emp Code") — use the downloaded template' });
    const headers = raw[headerIdx];
    rows = raw.slice(headerIdx + 1)
      .filter(r => String(r[0] || '').trim())
      .map(r => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = r[i]; });
        return obj;
      });
  } catch (err) {
    return res.status(400).json({ success: false, message: 'Failed to parse Excel: ' + err.message });
  }

  const empRes = await db.query(`SELECT id, employee_code, state FROM employees WHERE is_active = true`);
  const empMap = {};
  const empStateMap = {};
  empRes.rows.forEach(r => {
    const code = (r.employee_code || '').trim().toUpperCase();
    empMap[code] = r.id;
    empStateMap[code] = r.state;
  });

  const isYes = v => /^y/i.test(String(v || '').trim());

  let updated = 0, skipped = 0;
  const errors = [];
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    for (const row of rows) {
      const empCode = String(row['Emp Code'] || '').trim().toUpperCase();
      if (!empCode) { skipped++; continue; }
      const empId = empMap[empCode];
      if (!empId) { skipped++; errors.push(`${empCode}: not found or inactive`); continue; }

      const basic             = parseFloat(row['Basic']) || 0;
      const hra               = parseFloat(row['HRA']) || 0;
      const conveyance         = 0;
      const special_allowance  = parseFloat(row['Defray Allowance'] ?? row['Other Allowance']) || 0;
      const gratuity           = parseFloat(row['Gratuity']) || 0;
      const food_coupon        = parseFloat(row['Food Coupon']) || 0;
      const pf_applicable      = isYes(row['PF Applicable (Y/N)']);
      // EPS (A/c-10) doesn't apply to every PF member -- if the column is
      // absent from an older template, default to applicable (previous
      // behaviour: full 12% employer share, just now correctly split).
      const eps_applicable     = row['EPS Applicable (Y/N)'] !== undefined ? isYes(row['EPS Applicable (Y/N)']) : true;
      const esi_applicable     = isYes(row['ESI Applicable (Y/N)']);
      const pt_applicable      = isYes(row['PT Applicable (Y/N)']);
      const lwf_applicable     = false;
      const tds_applicable     = isYes(row['TDS Applicable (Y/N)']);
      const pf_wage_basis      = /actual/i.test(String(row['PF Basis (Capped/Actual)'] || '')) ? 'actual' : 'capped';

      // Bank details are optional on this sheet — only overwrite the employee's
      // existing bank info if a value was actually entered for that cell,
      // so leaving a cell blank never wipes out data that's already saved.
      const bankUpdates = {};
      if (String(row['Bank']        || '').trim()) bankUpdates.bank_name    = String(row['Bank']).trim();
      if (String(row['Branch']      || '').trim()) bankUpdates.bank_branch  = String(row['Branch']).trim();
      if (String(row['Account No.'] || '').trim()) bankUpdates.bank_account = String(row['Account No.']).trim();
      if (String(row['IFSC']        || '').trim()) bankUpdates.bank_ifsc    = String(row['IFSC']).trim().toUpperCase();

      const gross        = basic + hra + conveyance + special_allowance + gratuity + food_coupon;
      const pfBase        = pf_wage_basis === 'actual' ? basic : Math.min(basic, 15000);
      // Same statutory breakup as computeAndSaveSalaryStructure() above:
      // employer 12% = EPS A/c-10 (8.33%) + EPF A/c-1 (3.67%) when EPS
      // applies, else the full 12% stays in EPF A/c-1. pf_admin = EPF Admin
      // A/c-2 (0.5%) + EDLI A/c-21 (0.5%) + EDLI Admin A/c-22 (0%).
      const pf_employee    = pf_applicable  ? Math.round(pfBase * 0.12) : 0;
      const pf_employer    = pf_applicable  ? Math.round(pfBase * 0.12) : 0;
      const pf_eps         = pf_applicable && eps_applicable ? Math.round(pfBase * 0.0833) : 0;
      const pf_admin       = pf_applicable  ? Math.round(pfBase * 0.01) : 0;
      const esi_employee   = esi_applicable && gross <= 21000 ? Math.round(gross * 0.0075) : 0;
      const esi_employer   = esi_applicable && gross <= 21000 ? Math.round(gross * 0.0325) : 0;
      const pt             = pt_applicable  ? calcPT(gross, empStateMap[empCode]) : 0;
      const lwf            = 0;
      const total_ded      = pf_employee + esi_employee + pt;
      const net            = gross - total_ded;
      const total_employer_cost = pf_employer + esi_employer + pf_admin;
      const ctc_monthly    = gross + total_employer_cost;
      const ctc_annual     = ctc_monthly * 12;

      const sp = `sp_${empCode.replace(/\W/g,'')}`;
      await client.query(`SAVEPOINT ${sp}`);
      try {
        await client.query(
          `INSERT INTO employee_salary_structure
             (employee_id, basic, hra, conveyance, special_allowance, gratuity, food_coupon, gross_salary,
              pf_applicable, esi_applicable, pt_applicable, lwf_applicable, tds_applicable,
              pf_employee, pf_employer, pf_admin, esi_employee, esi_employer,
              professional_tax, lwf, total_employer_cost,
              total_deductions, net_salary, ctc_monthly, ctc_annual, pf_wage_basis,
              eps_applicable, pf_eps, updated_by, updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,NOW())
           ON CONFLICT(employee_id) DO UPDATE SET
             basic=$2, hra=$3, conveyance=$4, special_allowance=$5, gratuity=$6, food_coupon=$7, gross_salary=$8,
             pf_applicable=$9, esi_applicable=$10, pt_applicable=$11, lwf_applicable=$12, tds_applicable=$13,
             pf_employee=$14, pf_employer=$15, pf_admin=$16, esi_employee=$17, esi_employer=$18,
             professional_tax=$19, lwf=$20, total_employer_cost=$21,
             total_deductions=$22, net_salary=$23, ctc_monthly=$24, ctc_annual=$25, pf_wage_basis=$26,
             eps_applicable=$27, pf_eps=$28,
             updated_by=$29, updated_at=NOW()`,
          [empId, basic, hra, conveyance, special_allowance, gratuity, food_coupon, gross,
           pf_applicable, esi_applicable, pt_applicable, lwf_applicable, tds_applicable,
           pf_employee, pf_employer, pf_admin, esi_employee, esi_employer,
           pt, lwf, total_employer_cost, total_ded, net, ctc_monthly, ctc_annual, pf_wage_basis,
           eps_applicable, pf_eps, req.user.id]
        );
        await client.query(
          `UPDATE employee_salary_structure SET esi_wages=$2 WHERE employee_id=$1`,
          [empId, esi_applicable && gross <= 21000 ? gross : 0]
        );
        await client.query(`RELEASE SAVEPOINT ${sp}`);

        if (Object.keys(bankUpdates).length) {
          const sets = [], params = [];
          let idx = 1;
          for (const [key, val] of Object.entries(bankUpdates)) {
            sets.push(`${key}=$${idx++}`);
            params.push(val);
          }
          params.push(empId);
          await client.query(`UPDATE employees SET ${sets.join(',')} WHERE id=$${idx}`, params);
        }

        updated++;
      } catch (rowErr) {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        errors.push(`${empCode}: ${rowErr.message}`);
        skipped++;
      }
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      message: `Salary structure imported: ${updated} updated, ${skipped} skipped, ${errors.length} errors`,
      errors: errors.slice(0, 30)
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[bulkUploadSalaryStructure]', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};
