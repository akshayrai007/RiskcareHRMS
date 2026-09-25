const CONFIG = require('../Main_file');
// src/controllers/offerLetterController.js
// Generate, preview, and email offer letters — RiskCare HRMS

const db           = require('../config/db');
const emailSvc     = require('../config/emailService');
const { execFile } = require('child_process');
const puppeteerCore = require('puppeteer-core');
const chromium     = require('@sparticuz/chromium').default;
const fs           = require('fs');
const path         = require('path');
const os           = require('os');

// ── DB Init ────────────────────────────────────────────────────────────────────
exports.initTables = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS offer_letters (
        id                SERIAL PRIMARY KEY,
        employee_id       INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        candidate_name    VARCHAR(200) NOT NULL,
        candidate_email   VARCHAR(200),
        candidate_address TEXT,
        candidate_mobile  VARCHAR(20),
        designation       VARCHAR(200) NOT NULL,
        location          VARCHAR(200) DEFAULT 'Mumbai',
        joining_date      DATE,
        offer_date        DATE DEFAULT CURRENT_DATE,
        offer_valid_days  INT DEFAULT 7,
        ctc_annual        NUMERIC(14,2) DEFAULT 0,
        basic_monthly     NUMERIC(12,2) DEFAULT 0,
        hra_monthly       NUMERIC(12,2) DEFAULT 0,
        conveyance_monthly NUMERIC(12,2) DEFAULT 0,
        other_allowance_monthly NUMERIC(12,2) DEFAULT 0,
        gratuity_monthly  NUMERIC(12,2) DEFAULT 0,
        pf_employee_monthly NUMERIC(12,2) DEFAULT 0,
        pf_employer_monthly NUMERIC(12,2) DEFAULT 0,
        pf_admin_monthly  NUMERIC(12,2) DEFAULT 0,
        probation_months  INT DEFAULT 6,
        notice_period_months INT DEFAULT 3,
        custom_clauses    TEXT,
        status            VARCHAR(20) DEFAULT 'draft',
        sig1_image        TEXT,
        sig2_image        TEXT,
        sent_at           TIMESTAMP,
        created_by        INTEGER REFERENCES employees(id),
        created_at        TIMESTAMP DEFAULT NOW(),
        updated_at        TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Offer letter table ready');

    await db.query(`ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS sig1_image TEXT`);
    await db.query(`ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS sig2_image TEXT`);
    await db.query(`ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS professional_tax_monthly NUMERIC(12,2) DEFAULT 0`);
    await db.query(`ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS employment_type VARCHAR(20) DEFAULT 'permanent'`);
    await db.query(`ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS contract_months INT DEFAULT 0`);
    await db.query(`ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS employee_code VARCHAR(50)`);
    await db.query(`ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS department VARCHAR(200)`);
    await db.query(`ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS reporting_authority VARCHAR(200)`);
    await db.query(`ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS variable_pay_monthly NUMERIC(12,2) DEFAULT 0`);
    console.log('✅ Offer letter signature columns ready');
  } catch (err) {
    console.error('❌ Offer letter table init error:', err.message);
  }
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function numberToWords(num) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  if (num === 0) return 'Zero';
  if (num < 0) return 'Minus ' + numberToWords(-num);

  let words = '';
  if (Math.floor(num / 10000000) > 0) { words += numberToWords(Math.floor(num / 10000000)) + ' Crore '; num %= 10000000; }
  if (Math.floor(num / 100000) > 0)   { words += numberToWords(Math.floor(num / 100000)) + ' Lakh '; num %= 100000; }
  if (Math.floor(num / 1000) > 0)     { words += numberToWords(Math.floor(num / 1000)) + ' Thousand '; num %= 1000; }
  if (Math.floor(num / 100) > 0)      { words += numberToWords(Math.floor(num / 100)) + ' Hundred '; num %= 100; }
  if (num > 0) {
    if (num < 20) { words += ones[num] + ' '; }
    else { words += tens[Math.floor(num / 10)] + ' ' + ones[num % 10] + ' '; }
  }
  return words.trim();
}

// ── Browser helpers ────────────────────────────────────────────────────────────
async function launchBrowser() {
  // Retry up to 3 times — first call after deploy can hit ETXTBSY while
  // @sparticuz/chromium extracts its binary to /tmp.
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const execPath = await chromium.executablePath();
      return await puppeteerCore.launch({
        args: chromium.args,
        executablePath: execPath,
        headless: true,
      });
    } catch (err) {
      lastErr = err;
      if (i < 2) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function htmlToPdf(htmlString, browser) {
  const ownBrowser = !browser;
  if (ownBrowser) browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(htmlString, { waitUntil: 'networkidle0' });
    const isAppt = htmlString.includes('data-appt-letter');
    const pdfBuffer = await page.pdf(isAppt ? {
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      ...apptHeaderFooter()
    } : {
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });
    await page.close();
    return Buffer.from(pdfBuffer);
  } finally {
    if (ownBrowser) await browser.close();
  }
}

// ── Build Appointment Letter HTML (approved "Appointment Letter" format) ────────
// Body clauses live in ../data/appointmentClauses.json (extracted verbatim from
// the approved Word document, with its numbering). Header/footer are drawn per
// page by Puppeteer (see htmlToPdf: data-appt-letter marker + apptHeaderFooter).
const APPT_CLAUSES = require('../data/appointmentClauses.json');

function apptLogoB64() {
  try { return 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../../../frontend/Logo.png')).toString('base64'); }
  catch (e) { console.error('Logo not found:', e.message); return ''; }
}

function apptHeaderFooter() {
  const logo = apptLogoB64();
  const headerTemplate = `
    <div style="width:100%;padding:0 15mm;font-family:Arial,sans-serif;">
      <table style="width:100%;border-bottom:1.5px solid #000;border-collapse:collapse;padding-bottom:4px;">
        <tr>
          <td style="width:75px;vertical-align:middle;"><img src="${logo}" style="width:66px;height:auto;"></td>
          <td style="text-align:center;vertical-align:middle;">
            <div style="font-size:14px;font-weight:bold;color:#000;">${CONFIG.companyFullName}</div>
            <div style="font-size:8px;color:#444;"><b>Registered Office:</b> ${CONFIG.companyOfficeAddr}</div>
            <div style="font-size:8px;color:#444;">Phone: ${CONFIG.companyTel} &nbsp;|&nbsp; Email: ${CONFIG.supportEmail} &nbsp;|&nbsp; Website: ${CONFIG.websiteUrl}</div>
          </td>
        </tr>
      </table>
    </div>`;
  const footerTemplate = `
    <div style="width:100%;padding:0 15mm;font-family:Arial,sans-serif;font-size:9px;font-weight:bold;text-align:center;">
      <div style="border-top:1px solid #000;padding-top:3px;">Page <span class="pageNumber"></span> of <span class="totalPages"></span> &nbsp;|&nbsp; CIN: ${CONFIG.companyCIN}</div>
    </div>`;
  return { headerTemplate, footerTemplate };
}

function buildOfferLetterHTML(ol) {
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const num = (v) => parseFloat(v || 0) || 0;
  const basic = num(ol.basic_monthly), hra = num(ol.hra_monthly), conv = 0,
        other = num(ol.other_allowance_monthly), gratuity = num(ol.gratuity_monthly),
        pfEmpr = num(ol.pf_employer_monthly), pfAdmin = num(ol.pf_admin_monthly),
        variable = num(ol.variable_pay_monthly);

  // Annexure A structure: A = fixed pay, B = provident fund (employer), C = company
  // contribution to PF (admin/EDLI charges), D = variable pay.
  const fixedA   = basic + hra + conv + other + gratuity;
  const retirals = pfEmpr + pfAdmin;
  const fixedPay = fixedA + retirals;
  const totalMonthly = fixedPay + variable;
  const ctcAnnual = num(ol.ctc_annual) || totalMonthly * 12;
  const fmtV = (v) => Number(Math.round(v)).toLocaleString('en-IN');
  const dash = (v) => (v > 0 ? fmtV(v) : '&ndash;');

  const probWords = { 1: 'one', 2: 'two', 3: 'three', 6: 'six', 12: 'twelve' };
  const probStr = probWords[ol.probation_months] || String(ol.probation_months || 3);

  const ordDate = (d) => {
    const dt = d ? new Date(d) : new Date();
    const day = dt.getDate();
    const sup = (day >= 11 && day <= 13) ? 'th' : ([, 'st', 'nd', 'rd'][day % 10] || 'th');
    return day + '<sup>' + sup + '</sup> ' + ['January','February','March','April','May','June','July','August','September','October','November','December'][dt.getMonth()] + ', ' + dt.getFullYear();
  };
  const fyOf = (d) => { const dt = d ? new Date(d) : new Date(); const y = dt.getMonth() >= 3 ? dt.getFullYear() : dt.getFullYear() - 1; return y + '-' + String((y + 1) % 100).padStart(2, '0'); };

  const designation = esc(ol.designation || '');
  const department  = esc(ol.department || '');
  const posLabel    = department ? designation + ' - ' + department : designation;
  const location    = esc(ol.location || CONFIG.companyCity);
  const surname     = ((ol.candidate_name || '').replace(/^(mr|ms|mrs|miss)\.?\s+/i, '').trim().split(/\s+/).slice(-1)[0]) || '';
  const empType = (ol.employment_type || 'permanent').toLowerCase();
  const contractMonths = parseInt(ol.contract_months) || 0;
  const typeSentence = empType === 'contract'
    ? `<p>This appointment is on a <strong>Contract basis${contractMonths > 0 ? ' for ' + contractMonths + ' months' : ''}</strong>${ol.joining_date ? ', commencing <strong>' + ordDate(ol.joining_date) + '</strong>' : ''}.</p>`
    : empType === 'provision'
      ? `<p>This appointment is on a <strong>Provisional basis</strong>${ol.joining_date ? ', commencing <strong>' + ordDate(ol.joining_date) + '</strong>' : ''}.</p>`
      : (ol.joining_date ? `<p>Your date of joining will be <strong>${ordDate(ol.joining_date)}</strong>.</p>` : '');

  // ── Body clauses with the original numbering ─────────────────────────────
  const counters = {};
  const label = (kind, n, paren) => {
    let s;
    if (kind === '1') s = String(n);
    else if (kind === 'a') s = String.fromCharCode(96 + n);
    else if (kind === 'A') s = String.fromCharCode(64 + n);
    else s = '&bull;';
    if (kind === '•') return s;
    return paren ? '(' + s + ')' : s + '.';
  };
  const subst = (t) => {
    let x = esc(t);
    x = x.replace(/[“"]?Designation - Department[”"]?/i, '<strong>&ldquo;' + posLabel + '&rdquo;</strong>');
    x = x.replace(/[“"]?_{3,}[”"]?/, '<strong>&ldquo;' + location + '&rdquo;</strong>');
    if (/probation/i.test(x)) x = x.replace(/three months/gi, probStr + ' months');
    return x;
  };
  const bodyHtml = APPT_CLAUSES.slice(1).map((c) => {
    if (c.kind) { counters[c.num] = (counters[c.num] || 0) + 1; }
    const text = subst(c.t);
    if (c.heading) return `<p class="clause-h"><span class="lab">${label(c.kind, counters[c.num])}</span><strong>${text}</strong></p>`;
    if (c.kind) return `<p class="clause ${c.num === '2' ? 'top' : ''}"><span class="lab">${label(c.kind, counters[c.num], c.paren)}</span><span class="txt">${text}</span></p>`;
    return `<p class="plain">${text}</p>`;
  }).join('\n');

  const sig1HTML = ol.sig1_image ? '<img src="' + ol.sig1_image + '" style="height:44px;display:block;margin-bottom:4px;" alt="">' : '<div style="height:44px;"></div>';
  const sig2HTML = ol.sig2_image ? '<img src="' + ol.sig2_image + '" style="height:44px;display:block;margin-bottom:4px;" alt="">' : '';
  const additionalTerms = ol.custom_clauses ? `<p class="plain"><strong><u>ADDITIONAL TERMS:</u></strong><br>${esc(ol.custom_clauses).replace(/\n/g, '<br>')}</p>` : '';

  const rows = [];
  let sr = 0;
  const row = (name, m, cls) => { sr += 1; rows.push(`<tr class="${cls || ''}"><td class="c">${sr}</td><td>${name}</td><td class="n">${dash(m)}</td><td class="n">${dash(m * 12)}</td></tr>`); };
  row('Fixed Basic', basic);
  row('HRA', hra);
  row('Defray Allowances', other);
  row('Gratuity', gratuity);
  row('Total Fixed Pay (A)', fixedA, 'hl');
  row('Provident Fund (B)', pfEmpr);
  row('Company Contribution to Provident Fund (C)', pfAdmin);
  row('Total Retirals (B+C)', retirals, 'hl');
  row('FIXED PAY (A+B+C)', fixedPay, 'hl');
  row('Variable Pay (D)', variable);
  rows.push(`<tr class="hl"><td class="c">${sr + 1}</td><td>Total Compensation Package (A+B+C+D)</td><td class="n">${fmtV(totalMonthly)}</td><td class="n">${fmtV(ctcAnnual)}</td></tr>`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="appt-letter" content="1">
<style>
  @page { size: A4; margin: 36mm 15mm 18mm 15mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Calibri','Carlito','Arial',sans-serif; color:#000; margin:0; font-size:11.5px; line-height:1.45; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  p { margin: 6px 0; text-align: justify; }
  .head-line { font-weight:bold; margin:2px 0; }
  .clause-h { margin: 12px 0 4px; display:flex; text-align:left; page-break-after: avoid; }
  .clause { display:flex; gap:0; margin: 5px 0; }
  .clause .lab, .clause-h .lab { width: 26px; flex-shrink:0; }
  .clause .txt { text-align: justify; flex:1; }
  .clause:not(.top) { margin-left: 26px; }
  .plain { margin-left: 26px; }
  h3.annex { text-align:center; text-decoration:underline; font-size:14px; margin: 0 0 8px; }
  table.data { width:100%; border-collapse:collapse; margin-top:8px; }
  table.data th, table.data td { border:1px solid #000; padding:5px 8px; font-size:11px; }
  table.data th { background:#1e293b; color:#fff; text-transform:uppercase; }
  table.data td.c { width:8%; text-align:center; } table.data td.n { text-align:right; width:22%; }
  table.data tr.hl td { font-weight:bold; background:#f2f2f2; }
  .sigrow { display:flex; justify-content:space-between; align-items:flex-end; margin-top:20px; }
  .avoid { page-break-inside: avoid; }
  .kv { margin: 2px 0; }
</style>
</head>
<body data-appt-letter="1">

<p class="head-line" style="text-align:left;">Date: ${ordDate(ol.offer_date)}</p>
<p class="head-line" style="text-align:left;margin-top:10px;">${esc(ol.candidate_name || '')}</p>
<p style="text-align:left;margin:0;">Add: ${esc(ol.candidate_address || '')}</p>
${ol.candidate_mobile ? `<p style="text-align:left;margin:0;">Mob: ${esc(ol.candidate_mobile)}</p>` : ''}
${ol.candidate_email ? `<p style="text-align:left;margin:0;">Email: ${esc(ol.candidate_email)}</p>` : ''}
<p style="text-align:left;margin-top:12px;">Dear ${/^(mr|ms|mrs|miss)/i.test(ol.candidate_name || '') ? '' : 'Mr./Ms. '}${esc(surname)},</p>

<p>${subst(APPT_CLAUSES[0].t)}</p>
${typeSentence}

${bodyHtml}

${additionalTerms}

<div class="avoid">
  <p><strong>Please sign and return a copy of this communication in acknowledgement of receipt and acceptance</strong></p>
  <p>We take this opportunity to welcome you to the organization and look forward to having you on board soon as a part of the team.</p>
  <p style="margin-top:14px;"><strong>For ${String(CONFIG.companyFullName).toUpperCase()}</strong></p>
  <div class="sigrow"><div>${sig1HTML}<strong>Authorized Signatory</strong></div><div>${sig2HTML}</div></div>
</div>

<div class="avoid" style="margin-top:18px;">
  <p><strong>Acknowledgement and Acceptance</strong></p>
  <p>I have gone through all the terms and conditions mentioned in this offer letter/appointment letter.  I hereby declare that I have fully understood these terms and agree that they shall remain binding.  As a token of acceptance I have hereby signed the duplicate of this letter.</p>
  <p style="line-height:2.2;"><strong>Signature:</strong> ______________________________<br><strong>Name:</strong> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;_______________________________<br><strong>Date:</strong> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;_______________________________</p>
</div>

<!-- ANNEXURE A -->
<div style="page-break-before: always;">
  <h3 class="annex">Annexure A (Annual Cost to Company &amp; Other Benefits)</h3>
  <p class="kv"><strong>Name:</strong> ${esc(ol.candidate_name || '')}</p>
  <p class="kv"><strong>Designation:</strong> ${designation}</p>
  <p class="kv"><strong>Department:</strong> ${department}</p>
  <p class="kv"><strong>Office of Posting:</strong> ${location}</p>
  <p class="kv"><strong>Reporting Authority:</strong> ${esc(ol.reporting_authority || '')}</p>
  <p class="kv"><strong>Annual Compensation Package &ndash; Rs. ${Number(Math.round(ctcAnnual)).toLocaleString('en-IN')}/- ; Rupees: ${numberToWords(Math.round(ctcAnnual))} per annum only.</strong></p>
  <table class="data">
    <thead><tr><th>Sr. No.</th><th style="text-align:left">Particulars</th><th>Monthly</th><th>Yearly</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>
  <p><strong>A.&nbsp; Personal Pay Package:</strong> Each team member is free to exercise his choice of apportionment of personal benefit package subject to total limit given above and individual limits as mentioned against each. The above selection of the team member shall be taxable / non-taxable as provided for under the income tax act and the rules made thereunder and amended from time to time.</p>
  <p><strong>B.&nbsp; Fixed Pay:</strong> Your Fixed Pay is effective from date of joining, and the amount includes components like Basic Pay, House Rent Allowance, Other Allowances &amp; Provident Fund.</p>
  <p><strong>C.&nbsp; Your Benefits Coverage:</strong></p>
  <p style="text-align:center;"><strong>Your Benefits Coverage &ndash; ${fyOf(ol.joining_date || ol.offer_date)}</strong></p>
  <table class="data avoid">
    <thead><tr><th style="text-align:left">Leave Benefit (Paid Time Off)</th><th>Days</th><th style="text-align:left">Health &amp; Welfare/Other Benefits</th><th>Sum Assured p.a.</th></tr></thead>
    <tbody>
      <tr><td>Earned Leave</td><td class="c">18</td><td>Group Medical Insurance - Family Floater</td><td>Under Review</td></tr>
      <tr><td>Sick/Casual Leave</td><td class="c">12</td><td>Group Personal Accidental Insurance</td><td>INR 10 Lakhs and above</td></tr>
      <tr><td>Holidays</td><td class="c">15</td><td>Group Term Life - Self Minimum</td><td>INR 5 Lakhs and above</td></tr>
      <tr class="hl"><td>Total paid Time Off :</td><td class="c">45</td><td colspan="2"></td></tr>
    </tbody>
  </table>
  <p><strong>Benefits cannot be claimed as reimbursement/cash/perquisites. For Benefits, details please refer to the HR Policy.</strong></p>
  <p><strong>D.&nbsp; Reimbursements:</strong> Reimbursement of travel, telephone and petrol expenses incurred for official work visits as per HR rules of the company.</p>
  <p><strong>E.&nbsp; The next salary revision will happen as per company norms.</strong></p>
  <p><strong>All future ex-gratia variable pay/performance pay would include prospective / retrospectively increased or additional statutory payments liable to be paid by the company because of the changes in the statues. In addition, the company reserves the right to adjust/ recover such increased/ additional statutory payments from the total compensation package. Further, the company will not be liable to pay any amount over and above the total compensation package, which includes all statutory payments applicable. Company reserves the right to change your salary structure at any time by treating this as required notice, if any, under any law &amp; without any separate / further notice/intimation. This is basis the fact that the total compensation package is inclusive of all liability/ compensation obligations of the company (whether towards statutory payment as well as towards basic pay and other components of pay) as mentioned in this annexure.</strong></p>
  <div class="avoid">
    <div class="sigrow"><div>${sig1HTML}<strong>Authorized Signatory</strong></div><div></div></div>
    <p style="margin-top:14px;"><strong>Acknowledgement &amp; Acceptance</strong></p>
    <p>I have read and understood and agree to the above terms and conditions and hereby give my acceptance of the same.</p>
    <p style="line-height:2.2;"><strong>Signature:</strong> ____________________ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; <strong>Date:</strong> ____________________<br><strong>Name:</strong> ______________________ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; <strong>Location:</strong> ________________</p>
  </div>
</div>

</body>
</html>`;
}

// Export htmlToPdf so other controllers (relievingLetter, etc.) can share the same
// Puppeteer instance and letterhead logic without duplicating browser helpers.
exports.htmlToPdf = htmlToPdf;

// ── Short Offer Letter (2-page pre-joining format) ────────────────────────────
function buildShortOfferLetterHTML(ol) {
  const esc  = (v) => String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const num  = (v) => parseFloat(v || 0) || 0;
  const fmtV = (v) => Number(Math.round(v)).toLocaleString('en-IN');
  const basic = num(ol.basic_monthly), hra = num(ol.hra_monthly),
        other = num(ol.other_allowance_monthly), gratuity = num(ol.gratuity_monthly),
        pfEmp = num(ol.pf_employee_monthly || 0), pfEmpr = num(ol.pf_employer_monthly);
  const fixedA   = basic + hra + other + gratuity;
  const retirals = pfEmpr;
  const fixedPay = fixedA + retirals;
  const variable = num(ol.variable_pay_monthly);
  const ctcAnnual = num(ol.ctc_annual) || (fixedPay + variable) * 12;
  const dash = (v) => v > 0 ? fmtV(v) : '&ndash;';
  let sr = 0;
  const row = (name, m, bold) => { sr++; return `<tr${bold?' style="font-weight:700;background:#f2f2f2"':''}><td style="text-align:center;border:1px solid #000;padding:4px 8px">${sr}</td><td style="border:1px solid #000;padding:4px 8px">${name}</td><td style="text-align:right;border:1px solid #000;padding:4px 8px">${dash(m)}</td><td style="text-align:right;border:1px solid #000;padding:4px 8px">${dash(m*12)}</td></tr>`; };
  const rows = [
    row('Fixed Basic', basic), row('HRA', hra), row('Other Allowances', other),
    row('Gratuity', gratuity), row('Total Fixed Pay (A)', fixedA, true),
    row('Provident Fund (B)', pfEmp), row('Company Contribution to Provident Fund (C)', pfEmpr),
    row('Total Retirals (B+C)', pfEmp + pfEmpr, true),
    row('FIXED PAY (A+B+C)', fixedPay + pfEmp, true),
    row('Variable Pay (D)', variable),
  ];
  sr++;
  rows.push(`<tr style="font-weight:700;background:#1e293b;color:#fff"><td style="text-align:center;border:1px solid #000;padding:4px 8px">${sr}</td><td style="border:1px solid #000;padding:4px 8px">Total Compensation Package (A+B+C+D)</td><td style="text-align:right;border:1px solid #000;padding:4px 8px">${fmtV((fixedPay+pfEmp+variable))}</td><td style="text-align:right;border:1px solid #000;padding:4px 8px">${fmtV(ctcAnnual)}</td></tr>`);
  const ordDate = (d) => { const dt = d?new Date(d):new Date(); const day=dt.getDate(); const sup=(day>=11&&day<=13)?'th':([,'st','nd','rd'][day%10]||'th'); return day+'<sup>'+sup+'</sup> '+['January','February','March','April','May','June','July','August','September','October','November','December'][dt.getMonth()]+', '+dt.getFullYear(); };
  const surname = ((ol.candidate_name||'').replace(/^(mr|ms|mrs|miss)\.?\s+/i,'').trim().split(/\s+/).slice(-1)[0])||'';
  const designation = esc(ol.designation||''), department = esc(ol.department||'');
  const posLabel = department ? designation+' - '+department : designation;
  const location = esc(ol.location||CONFIG.companyCity||'Mumbai');
  const salute = /^(mr|ms|mrs|miss)/i.test(ol.candidate_name||'') ? '' : 'Mr./Ms. ';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="appt-letter">
<style>
  @page { size:A4; margin:28mm 15mm 18mm 15mm; }
  * { box-sizing:border-box; }
  body { font-family:'Calibri','Carlito','Arial',sans-serif; font-size:12px; line-height:1.5; color:#000; margin:0; }
  p { margin:6px 0; text-align:justify; }
  table.ctc { width:100%; border-collapse:collapse; margin:10px 0; font-size:11.5px; }
  table.ctc th { background:#1e293b; color:#fff; padding:5px 8px; border:1px solid #000; font-size:11px; }
  .sig { margin-top:30px; }
  .sig-line { border-top:1px solid #000; width:200px; display:inline-block; }
  .avoid { page-break-inside:avoid; }
</style></head><body data-appt-letter="1">
<p>Date: ${ordDate(ol.offer_date)}</p>
<p>To,<br><strong>${esc(ol.candidate_name||'')}</strong><br>${esc(ol.candidate_address||'')}<br>Contact No.: ${esc(ol.candidate_mobile||'')}</p>
<p style="margin-top:12px">Dear ${salute}${esc(surname)},</p>
<p><strong>Sub: Offer for position of ${esc(ol.designation||'')} with ${esc(CONFIG.companyFullName)}</strong></p>
<p>In reference to our discussions, we are pleased to offer you the position of <strong>${esc(posLabel)}</strong> in ${esc(CONFIG.companyFullName)}.</p>
<p>We are pleased to issue this offer letter on the following terms and conditions:</p>
<p>You will be appointed as <strong>${esc(posLabel)}</strong>, located in <strong>${location}</strong>.</p>
<p>You will assist in promoting and developing business of ${esc(CONFIG.companyShortName||CONFIG.companyFullName)} by effectively communicating with various corporates / industrial sector clients for their insurance requirements and about various products &amp; services offered by the company viz &ndash; Risk Analysis, Risk Assessment, Underwriting, Placement, Claim Settlement etc.</p>
<p>This appointment will be effective from the date of your joining.</p>
<p>The total fixed remuneration payable to you on a CTC basis will be <strong>Rs.${fmtV(ctcAnnual)}/- per annum</strong>.</p>
<p>The incentive and reward structure will be specified in your appointment letter.</p>
<p>Severance of relationship can be done by giving one month written notice from Company and three months&apos; notice from your side.</p>
<p>All correspondence addressed to you by the company and other copies of such correspondence, including printed matters and all books, records, or records of business or prices or other market data, samples and/or other papers belonging to the company, circulars and all other relevant papers and documents of any nature whatsoever relating to the company&apos;s business, shall be treated as strictly confidential.</p>
<p>Detailed appointment letter will be issued to you on the date of joining.</p>
<p>Please find the CTC Annexure - A details on next page.</p>
<div class="avoid">
  <div class="sig"><strong>As a token of your acceptance and in confirmation of the terms and conditions of this offer. Please sign the duplicate copy of this letter and return to us.</strong>
  <p style="margin-top:14px"><strong>Yours truly,<br>For ${esc(CONFIG.companyFullName)}</strong></p>
  <p style="margin-top:40px"><span class="sig-line"></span><br><strong>Authorized Signatory</strong></p>
  </div>
</div>
<!-- ANNEXURE A -->
<div style="page-break-before:always;">
<p style="text-align:center;font-size:14px;font-weight:bold;text-decoration:underline">Annexure -A (Annual Cost to Company)</p>
<p><strong>Name:</strong> ${esc(ol.candidate_name||'')} &nbsp;&nbsp;&nbsp; <strong>Designation:</strong> ${designation} &nbsp;&nbsp;&nbsp; <strong>Office of Posting:</strong> ${location}</p>
<p><strong>Annual Compensation Package &ndash; Rs.${fmtV(ctcAnnual)}/- ; Rupees: ${numberToWords(Math.round(ctcAnnual))} per annum only.</strong></p>
<table class="ctc"><thead><tr><th>Sr. No.</th><th style="text-align:left">Particulars</th><th>Monthly</th><th>Yearly</th></tr></thead><tbody>${rows.join('')}</tbody></table>
<div class="avoid" style="margin-top:14px">
  <p><strong>As a token of your acceptance and in confirmation of the terms and conditions of this offer. Please sign the duplicate copy of this letter and return to us.</strong></p>
  <p style="margin-top:40px"><span class="sig-line"></span><br><strong>Authorized Signatory<br>For ${esc(CONFIG.companyFullName)}</strong></p>
</div>
</div>
</body></html>`;
}

exports.shortPreview = async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM offer_letters WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    const ol = result.rows[0];
    const pdfBuffer = await htmlToPdf(buildShortOfferLetterHTML(ol));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Offer_Letter_${(ol.candidate_name||'preview').replace(/\s+/g,'_')}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[shortPreview]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /offer-letters/:id/preview — generate PDF and stream inline ───────────
exports.preview = async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM offer_letters WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Not found' });

    const ol = result.rows[0];
    const html = buildOfferLetterHTML(ol);
    const pdfBuffer = await htmlToPdf(html);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Offer_Letter_${(ol.candidate_name || 'preview').replace(/\s+/g, '_')}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[offerLetter.preview]', err.message);
    res.status(500).json({ success: false, message: `Server error: ${err.message}` });
  }
};

// ── CRUD ───────────────────────────────────────────────────────────────────────
exports.getAll = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT ol.*, CONCAT(e.first_name,' ',e.last_name) AS created_by_name
      FROM offer_letters ol
      LEFT JOIN employees e ON ol.created_by = e.id
      ORDER BY ol.created_at DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[offerLetter.getAll]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getOne = async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM offer_letters WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.create = async (req, res) => {
  try {
    const {
      candidate_name, candidate_email, candidate_address, candidate_mobile,
      designation, location = CONFIG.companyCity, joining_date, offer_date, offer_valid_days = 7,
      ctc_annual, basic_monthly, hra_monthly, conveyance_monthly = 0,
      other_allowance_monthly, gratuity_monthly = 0,
      pf_employee_monthly = 0, pf_employer_monthly = 0, pf_admin_monthly = 0,
      professional_tax_monthly = 0,
      probation_months = 6, notice_period_months = 3, custom_clauses, employee_id,
      employment_type = 'permanent', contract_months = 0, employee_code,
      sig1_image, sig2_image
    } = req.body;

    if (!candidate_name || !designation)
      return res.status(400).json({ success: false, message: 'candidate_name and designation required' });

    const result = await db.query(`
      INSERT INTO offer_letters (
        employee_id, candidate_name, candidate_email, candidate_address, candidate_mobile,
        designation, location, joining_date, offer_date, offer_valid_days,
        ctc_annual, basic_monthly, hra_monthly, conveyance_monthly, other_allowance_monthly,
        gratuity_monthly, pf_employee_monthly, pf_employer_monthly, pf_admin_monthly,
        professional_tax_monthly, employee_code,
        probation_months, notice_period_months, custom_clauses, sig1_image, sig2_image,
        employment_type, contract_months, created_by, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,NOW())
      RETURNING *`,
      [employee_id || null, candidate_name, candidate_email || null, candidate_address || null, candidate_mobile || null,
       designation, location, joining_date || null, offer_date || null, offer_valid_days,
       ctc_annual || 0, basic_monthly || 0, hra_monthly || 0, conveyance_monthly, other_allowance_monthly || 0,
       gratuity_monthly, pf_employee_monthly, pf_employer_monthly, pf_admin_monthly,
       professional_tax_monthly || 0, employee_code || null,
       probation_months, notice_period_months, custom_clauses || null, sig1_image || null, sig2_image || null,
       employment_type || 'permanent', contract_months || 0, req.user.id]
    );
    if (req.body.department || req.body.reporting_authority || req.body.variable_pay_monthly) {
      await db.query(`UPDATE offer_letters SET department=$2, reporting_authority=$3, variable_pay_monthly=$4 WHERE id=$1`,
        [result.rows[0].id, req.body.department || null, req.body.reporting_authority || null, req.body.variable_pay_monthly || 0]);
      Object.assign(result.rows[0], { department: req.body.department || null, reporting_authority: req.body.reporting_authority || null });
    }
    res.json({ success: true, data: result.rows[0], message: 'Offer letter created!' });
  } catch (err) {
    console.error('[offerLetter.create]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.update = async (req, res) => {
  try {
    const fields = ['candidate_name', 'candidate_email', 'candidate_address', 'candidate_mobile',
      'designation', 'location', 'joining_date', 'offer_date', 'offer_valid_days',
      'ctc_annual', 'basic_monthly', 'hra_monthly', 'conveyance_monthly', 'other_allowance_monthly',
      'gratuity_monthly', 'pf_employee_monthly', 'pf_employer_monthly', 'pf_admin_monthly',
      'professional_tax_monthly', 'employee_code',
      'probation_months', 'notice_period_months', 'custom_clauses', 'sig1_image', 'sig2_image',
      'employment_type', 'contract_months', 'department', 'reporting_authority', 'variable_pay_monthly'];
    const sets = [], params = [];
    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        sets.push(`${f}=$${params.length + 1}`);
        params.push(req.body[f]);
      }
    });
    if (!sets.length) return res.json({ success: true, message: 'Nothing to update' });
    sets.push(`updated_at=NOW()`);
    params.push(req.params.id);
    await db.query(`UPDATE offer_letters SET ${sets.join(',')} WHERE id=$${params.length}`, params);
    res.json({ success: true, message: 'Updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.remove = async (req, res) => {
  try {
    await db.query('DELETE FROM offer_letters WHERE id=$1', [req.params.id]);
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Send Email ─────────────────────────────────────────────────────────────────
exports.sendEmail = async (req, res) => {
  try {
    const { cc = [], bcc = [], email_message = '' } = req.body;
    const result = await db.query('SELECT * FROM offer_letters WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Not found' });

    const ol = result.rows[0];
    if (!ol.candidate_email) return res.status(400).json({ success: false, message: 'No email on this offer letter' });

    const offerHTML = buildOfferLetterHTML(ol);
    let offerPdfBuffer = null;
    try {
      offerPdfBuffer = await htmlToPdf(offerHTML);
    } catch (pdfErr) {
      console.error('[offerLetter.sendEmail] PDF generation failed:', pdfErr.message);
    }

    const defaultMsg = `Dear ${ol.candidate_name.split(' ')[0] || ol.candidate_name},\n\nPlease find attached your offer letter for the position of "${ol.designation}" at ${CONFIG.companyFullName}.\n\nKindly review the letter and revert back with your acceptance within ${ol.offer_valid_days || 7} days.\n\nFor any queries, feel free to reach out to us.\n\nWarm regards,\nHuman Resource Team\n${CONFIG.companyFullName}`;

    const coverText = (email_message || defaultMsg).replace(/\n/g, '<br>');
    const coverHtml = `
      <div style="font-family:Arial,sans-serif;font-size:13px;color:#222;line-height:1.7;max-width:600px;">
        <div style="background:${CONFIG.primaryColor};padding:16px 24px;border-radius:8px 8px 0 0;">
          <span style="color:#fff;font-size:16px;font-weight:700;">${CONFIG.clientName}</span>
          <span style="color:#f5b5b5;font-size:12px;margin-left:8px;">${CONFIG.companyShortName}</span>
        </div>
        <div style="border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
          <p>${coverText}</p>
        </div>
      </div>`;

    const attachments = [];
    if (offerPdfBuffer) {
      attachments.push({
        name: `Offer_Letter_${ol.candidate_name.replace(/\s+/g, '_')}.pdf`,
        content: offerPdfBuffer.toString('base64'),
      });
    } else {
      return res.status(500).json({ success: false, message: 'PDF generation failed. Please try again.' });
    }

    const payload = {
      sender: { name: process.env.EMAIL_FROM_NAME || CONFIG.senderName, email: process.env.EMAIL_FROM || CONFIG.supportEmail },
      to: [{ email: ol.candidate_email, name: ol.candidate_name }],
      subject: `Offer Letter — ${ol.designation} | ${CONFIG.companyShortName}`,
      htmlContent: coverHtml,
      attachment: attachments,
    };

    const cleanCc  = (Array.isArray(cc)  ? cc  : []).map(e => (e || '').trim()).filter(e => e && e.includes('@'));
    const cleanBcc = (Array.isArray(bcc) ? bcc : []).map(e => (e || '').trim()).filter(e => e && e.includes('@'));
    if (cleanCc.length)  payload.cc  = cleanCc.map(e => ({ email: e }));
    if (cleanBcc.length) payload.bcc = cleanBcc.map(e => ({ email: e }));

    const BREVO_KEY = process.env.BREVO_API_KEY;
    if (!BREVO_KEY || process.env.EMAIL_ENABLED !== 'true') {
      await db.query(`UPDATE offer_letters SET status='sent', sent_at=NOW() WHERE id=$1`, [ol.id]);
      return res.json({ success: true, message: `[Simulated] Offer letter sent to ${ol.candidate_email}` });
    }

    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(500).json({ success: false, message: `Email failed: ${err}` });
    }

    await db.query(`UPDATE offer_letters SET status='sent', sent_at=NOW() WHERE id=$1`, [ol.id]);
    res.json({ success: true, message: `Offer letter sent to ${ol.candidate_email}` });
  } catch (err) {
    console.error('[offerLetter.sendEmail]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Bulk Send via Excel ────────────────────────────────────────────────────────
exports.bulkSend = async (req, res) => {
  const XLSX = require('xlsx');
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No Excel file uploaded' });

    const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) return res.status(400).json({ success: false, message: 'Excel is empty' });

    const ccRaw  = String(rows[0]['CC']  || rows[0]['cc']  || '').split(',').map(e => e.trim()).filter(e => e.includes('@'));
    const bccRaw = String(rows[0]['BCC'] || rows[0]['bcc'] || '').split(',').map(e => e.trim()).filter(e => e.includes('@'));

    const results = [];
    let sent = 0, failed = 0;

    const sigRow = await db.query(`SELECT sig1_image, sig2_image FROM offer_letters WHERE sig1_image IS NOT NULL LIMIT 1`);
    const sig1   = sigRow.rows[0]?.sig1_image || null;
    const sig2   = sigRow.rows[0]?.sig2_image || null;

    const BREVO_KEY    = process.env.BREVO_API_KEY;
    const emailEnabled = process.env.EMAIL_ENABLED === 'true';

    const browser = await launchBrowser();
    try {
      for (let i = 0; i < rows.length; i++) {
        const row    = rows[i];
        const rowNum = i + 2;

        const candidateName   = String(row['Candidate Name']  || row['candidate_name']  || '').trim();
        const candidateEmail  = String(row['Email']           || row['email']           || row['candidate_email'] || '').trim();
        const designation     = String(row['Designation']     || row['designation']     || '').trim();
        const location        = String(row['Location']        || row['location']        || 'Mumbai').trim();
        const joiningDateRaw  = row['Joining Date']           || row['joining_date']    || '';
        const offerValidDays  = parseInt(row['Offer Valid Days'] || row['offer_valid_days'] || 7) || 7;
        const probation       = parseInt(row['Probation Months'] || row['probation_months'] || 6) || 6;
        const noticePeriod    = parseInt(row['Notice Period Months'] || row['notice_period_months'] || 3) || 3;
        const employeeCode    = String(row['Employee Code']   || row['employee_code']   || '').trim();
        const candidateMobile = String(row['Mobile']          || row['mobile']          || row['candidate_mobile'] || '').trim();
        const candidateAddr   = String(row['Address']         || row['address']         || '').trim();
        const customClauses   = String(row['Custom Clauses']  || row['custom_clauses']  || '').trim();
        const employmentType  = String(row['Employment Type'] || row['employment_type'] || 'permanent').trim().toLowerCase();
        const contractMon     = parseInt(row['Contract Months'] || row['contract_months'] || 0) || 0;

        const ctcAnnual  = parseFloat(String(row['CTC Annual']         || row['ctc_annual']         || 0).replace(/,/g, '')) || 0;
        const basic      = parseFloat(String(row['Basic Monthly']      || row['basic_monthly']      || 0).replace(/,/g, '')) || 0;
        const hra        = parseFloat(String(row['HRA Monthly']        || row['hra_monthly']        || 0).replace(/,/g, '')) || 0;
        const conveyance = parseFloat(String(row['Conveyance Monthly'] || row['conveyance_monthly'] || 0).replace(/,/g, '')) || 0;
        const otherAllow = parseFloat(String(row['Defray Allowance']   || row['Other Allowance'] || row['other_allowance_monthly'] || 0).replace(/,/g, '')) || 0;
        const gratuity   = parseFloat(String(row['Gratuity Monthly']   || row['gratuity_monthly']   || 0).replace(/,/g, '')) || 0;
        const pfEmployee = parseFloat(String(row['PF Employee']        || row['pf_employee_monthly'] || 0).replace(/,/g, '')) || 0;
        const pfEmployer = parseFloat(String(row['PF Employer']        || row['pf_employer_monthly'] || 0).replace(/,/g, '')) || 0;
        const pfAdmin    = parseFloat(String(row['PF Admin']           || row['pf_admin_monthly']   || 0).replace(/,/g, '')) || 0;
        const profTax    = parseFloat(String(row['Professional Tax']   || row['professional_tax_monthly'] || 0).replace(/,/g, '')) || 0;

        if (!candidateName || !candidateEmail || !designation) {
          results.push({ row: rowNum, name: candidateName || '(empty)', email: candidateEmail || '(empty)', status: 'failed', reason: 'Missing required: Candidate Name, Email, or Designation' });
          failed++;
          continue;
        }
        if (!candidateEmail.includes('@')) {
          results.push({ row: rowNum, name: candidateName, email: candidateEmail, status: 'failed', reason: 'Invalid email address' });
          failed++;
          continue;
        }

        let joiningDate = null;
        if (joiningDateRaw) {
          const d = joiningDateRaw instanceof Date ? joiningDateRaw : new Date(joiningDateRaw);
          if (!isNaN(d)) joiningDate = d.toISOString().split('T')[0];
        }

        const ol = {
          candidate_name: candidateName, candidate_email: candidateEmail,
          candidate_address: candidateAddr, candidate_mobile: candidateMobile,
          designation, location, joining_date: joiningDate, offer_date: new Date(),
          offer_valid_days: offerValidDays, probation_months: probation,
          notice_period_months: noticePeriod, employee_code: employeeCode,
          ctc_annual: ctcAnnual, basic_monthly: basic, hra_monthly: hra,
          conveyance_monthly: conveyance, other_allowance_monthly: otherAllow,
          gratuity_monthly: gratuity, pf_employee_monthly: pfEmployee,
          pf_employer_monthly: pfEmployer, pf_admin_monthly: pfAdmin,
          professional_tax_monthly: profTax, custom_clauses: customClauses || null,
          employment_type: employmentType, contract_months: contractMon,
          sig1_image: sig1, sig2_image: sig2, status: 'draft',
        };

        let offerPdfBuffer = null;
        try {
          offerPdfBuffer = await htmlToPdf(buildOfferLetterHTML(ol), browser);
        } catch (pdfErr) {
          results.push({ row: rowNum, name: candidateName, email: candidateEmail, status: 'failed', reason: `PDF generation failed: ${pdfErr.message}` });
          failed++;
          continue;
        }

        const firstName = candidateName.split(' ').filter(w => !['Mr.', 'Ms.', 'Mrs.', 'Dr.'].includes(w))[0] || candidateName;
        const coverHtml = `
          <div style="font-family:Arial,sans-serif;font-size:13px;color:#222;line-height:1.7;max-width:600px;">
            <div style="background:${CONFIG.primaryColor};padding:16px 24px;border-radius:8px 8px 0 0;">
              <span style="color:#fff;font-size:16px;font-weight:700;">${CONFIG.clientName}</span>
              <span style="color:#f5b5b5;font-size:12px;margin-left:8px;">${CONFIG.companyShortName}</span>
            </div>
            <div style="border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
              <p>Dear ${firstName},</p>
              <p>Please find attached your offer letter for the position of <strong>"${designation}"</strong> at ${CONFIG.companyFullName}.</p>
              <p>Kindly review the letter and revert back with your acceptance within <strong>${offerValidDays} days</strong>.</p>
              <p>For any queries, feel free to reach out to us.</p>
              <p>Warm regards,<br>Human Resource Team<br>${CONFIG.companyFullName}</p>
            </div>
          </div>`;

        const attachments = [{ name: `Offer_Letter_${candidateName.replace(/\s+/g, '_')}.pdf`, content: offerPdfBuffer.toString('base64') }];
        const payload = {
          sender: { name: process.env.EMAIL_FROM_NAME || CONFIG.senderName, email: process.env.EMAIL_FROM || CONFIG.supportEmail },
          to: [{ email: candidateEmail, name: candidateName }],
          subject: `Offer Letter — ${designation} | ${CONFIG.companyShortName}`,
          htmlContent: coverHtml,
          attachment: attachments,
        };
        if (ccRaw.length)  payload.cc  = ccRaw.map(e => ({ email: e }));
        if (bccRaw.length) payload.bcc = bccRaw.map(e => ({ email: e }));

        if (!BREVO_KEY || !emailEnabled) {
          results.push({ row: rowNum, name: candidateName, email: candidateEmail, status: 'sent (simulated)', reason: '' });
          sent++;
          continue;
        }

        try {
          const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
            body: JSON.stringify(payload),
          });
          if (!resp.ok) {
            const errText = await resp.text();
            results.push({ row: rowNum, name: candidateName, email: candidateEmail, status: 'failed', reason: `Email API error: ${errText.substring(0, 120)}` });
            failed++;
          } else {
            results.push({ row: rowNum, name: candidateName, email: candidateEmail, status: 'sent', reason: '' });
            sent++;
          }
        } catch (emailErr) {
          results.push({ row: rowNum, name: candidateName, email: candidateEmail, status: 'failed', reason: emailErr.message });
          failed++;
        }
        await new Promise(r => setTimeout(r, 300));
      }
    } finally {
      await browser.close();
    }

    res.json({ success: true, total: rows.length, sent, failed, results });
  } catch (err) {
    console.error('[offerLetter.bulkSend]', err.message);
    res.status(500).json({ success: false, message: `Server error: ${err.message}` });
  }
};

exports.htmlToPdf = htmlToPdf;
