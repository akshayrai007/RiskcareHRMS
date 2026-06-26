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
  const execPath = await chromium.executablePath();
  return puppeteerCore.launch({
    args: chromium.args,
    executablePath: execPath,
    headless: true,
  });
}

async function htmlToPdf(htmlString, browser) {
  const ownBrowser = !browser;
  if (ownBrowser) browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(htmlString, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
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

// ── Build Offer Letter HTML ────────────────────────────────────────────────────
function buildOfferLetterHTML(ol) {
  const basic    = parseFloat(ol.basic_monthly || 0);
  const hra      = parseFloat(ol.hra_monthly || 0);
  const conv     = parseFloat(ol.conveyance_monthly || 0);
  const other    = parseFloat(ol.other_allowance_monthly || 0);
  const gratuity = parseFloat(ol.gratuity_monthly || 0);
  const pfEmp    = parseFloat(ol.pf_employee_monthly || 0);
  const pfEmpr   = parseFloat(ol.pf_employer_monthly || 0);
  const pfAdmin  = parseFloat(ol.pf_admin_monthly || 0);
  const pt       = parseFloat(ol.professional_tax_monthly || 0);

  const gross      = basic + hra + conv + other + gratuity;
  const totalDed   = pfEmp + pt;
  const netSalary  = gross - totalDed;
  const ctcMonthly = gross + pfEmpr + pfAdmin;
  const ctcAnnual  = parseFloat(ol.ctc_annual || (ctcMonthly * 12));

  const fmtV = v => Number(Math.round(v)).toLocaleString('en-IN');

  const probWords   = { 3: 'three', 6: 'six', 12: 'twelve' };
  const noticeWords = { 1: 'one', 2: 'two', 3: 'three', 6: 'six' };
  const probStr     = probWords[ol.probation_months] || `${ol.probation_months || 6}`;
  const noticeStr   = noticeWords[ol.notice_period_months] || `${ol.notice_period_months || 3}`;

  const empType = (ol.employment_type || 'permanent').toLowerCase();
  const contractMonths = parseInt(ol.contract_months) || 0;
  let empTypeLabel = '';
  if (empType === 'contract' && contractMonths > 0) {
    empTypeLabel = ' on a <strong>Contract basis for ' + contractMonths + ' months</strong>';
  } else if (empType === 'contract') {
    empTypeLabel = ' on a <strong>Contract basis</strong>';
  } else if (empType === 'provision') {
    empTypeLabel = ' on a <strong>Provisional basis</strong>';
  } else {
    empTypeLabel = '';
  }

  function joiningDateHTML(d) {
    if (!d) return '';
    const dt = new Date(d);
    const day = dt.getDate();
    const sup = [, 'st', 'nd', 'rd'][day] || 'th';
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    return day + '<sup>' + sup + '</sup> ' + months[dt.getMonth()] + ' ' + dt.getFullYear();
  }

  // ── Logo: direct PNG from frontend folder ──────────────────────────────────
  const LOGO_PATH = path.join(__dirname, '../../../frontend/Logo.png');
  let LOGO_B64 = '';
  try {
    const logoBuf = fs.readFileSync(LOGO_PATH);
    LOGO_B64 = 'data:image/png;base64,' + logoBuf.toString('base64');
  } catch (e) {
    console.error('Logo file not found at', LOGO_PATH, e.message);
  }

  // ── Signature images ───────────────────────────────────────────────────────
  const sig1HTML = ol.sig1_image
    ? '<img src="' + ol.sig1_image + '" style="height:44px;display:block;margin-bottom:4px;" alt="">'
    : '<div style="height:44px;"></div>';
  const sig2HTML = ol.sig2_image
    ? '<img src="' + ol.sig2_image + '" style="height:44px;display:block;margin-left:auto;margin-bottom:4px;" alt="">'
    : '<div style="height:44px;"></div>';

  // ── RiskCare Letterhead Header ─────────────────────────────────────────────
  const hdr = `
    <table class="header-table">
      <tr>
        <td style="width:120px;vertical-align:middle;">
          <img src="${LOGO_B64}" style="width:110px;height:auto;display:block;">
        </td>
        <td style="text-align:center;vertical-align:middle;">
          <div style="font-family:Arial,sans-serif;font-size:20px;font-weight:bold;color:#000;margin-bottom:4px;">Risk Care Insurance Broking Services Private Limited</div>
          <div style="font-family:Arial,sans-serif;font-size:11px;color:#444;"><strong>Registered Office:</strong> #708, 7th Floor, Hubtown Viva, Western Express Highway,<br>Shankarwadi, Jogeshwari (East), Mumbai 400060, Maharashtra</div>
          <div style="font-family:Arial,sans-serif;font-size:11px;color:#444;margin-top:2px;">Phone: +91 22 61473232 &nbsp;|&nbsp; Email: support@riskcare.co.in &nbsp;|&nbsp; Website: www.riskcareinsure.com</div>
        </td>
      </tr>
    </table>`;

  // ── RiskCare Footer ────────────────────────────────────────────────────────
  const ftr = `
    <div class="footer">
      CIN: U51109MH2005PTC199431 &nbsp;|&nbsp; Registration No: 401 &nbsp;|&nbsp; Validity: 29/04/2025 to 28/04/2028 &nbsp;|&nbsp; Category: Composite Broker
    </div>`;

  const convRow = conv > 0 ? `<tr>
    <td class="col-sr">2a</td>
    <td class="col-part">Conveyance Allowances</td>
    <td class="col-num">${fmtV(conv)}</td>
    <td class="col-num">${fmtV(conv * 12)}</td>
  </tr>` : '';

  const additionalTerms = ol.custom_clauses ? `
    <p><u><strong>ADDITIONAL TERMS:</strong></u><br>${ol.custom_clauses}</p>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: 'Georgia','Times New Roman',Times,serif;
    color: #000; line-height: 1.4; margin: 0;
    background-color: #525659; padding: 20px 0;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .page {
    width: 210mm; height: 297mm; position: relative;
    margin: 0 auto 20px auto; background: #fff;
    box-shadow: 0 0 10px rgba(0,0,0,.5);
    padding: 15mm 15mm 30mm 15mm;
    page-break-after: always; overflow: hidden;
  }
  .header-table {
    width: 100%; border-bottom: 2px solid #000;
    padding-bottom: 10px; margin-bottom: 20px;
    border-collapse: collapse;
  }
  .footer {
    position: absolute; bottom: 10mm; left: 15mm; right: 15mm;
    text-align: center; font-size: 10px; color: #000;
    border-top: 1px solid #000; padding-top: 5px;
    font-family: 'Arial',sans-serif; font-weight: bold;
  }
  .date-row { text-align: right; font-weight: bold; font-size: 13.5px; margin-top: 58px; margin-bottom: 15px; }
  .candidate-info { margin-bottom: 15px; font-size: 14px; line-height: 1.3; }
  .subject-line { text-align: center; font-weight: bold; text-decoration: underline; margin: 15px 0; font-size: 14.5px; }
  p { margin: 8px 0; text-align: justify; font-size: 13px; }
  ul { margin-top: 0; padding-left: 25px; }
  li { margin-bottom: 5px; text-align: justify; font-size: 13px; }
  .data-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-family: 'Arial',sans-serif; border: 1px solid #000; }
  .data-table th, .data-table td { border: 1px solid #000; padding: 8px 8px; font-size: 12px; }
  .data-table th { background-color: #C0272D; color: #fff; font-weight: bold; text-transform: uppercase; }
  .col-sr { width: 8%; text-align: center; }
  .col-part { width: 48%; text-align: left; }
  .col-num { width: 22%; text-align: right; }
  .data-table tr.highlight td { font-weight: bold; background-color: #f2f2f2; }
  .main-signature-block { margin-top: 20px; font-size: 14px; }
  .dual-signature { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 30px; }
  .sig-left { text-align: left; }
  .sig-right { text-align: right; }
  @media print {
    body { background-color: #fff; padding: 0; margin: 0; }
    .page { box-shadow: none; margin: 0; border: none; width: 210mm; height: 296mm; page-break-inside: avoid; }
    .page:last-child { page-break-after: auto; }
    @page { size: A4; margin: 0; }
  }
</style>
</head>
<body>

<!-- PAGE 1 -->
<div class="page">
  ${hdr}
  <div class="date-row">${joiningDateHTML(ol.offer_date || new Date())}</div>
  <div class="candidate-info">
    <strong>${ol.candidate_name || ''}</strong><br>
    ${ol.candidate_address || ''}<br><br>
    <strong>Mob &ndash; ${ol.candidate_mobile || ''}</strong><br>
    <strong>Email &ndash; ${ol.candidate_email || ''}</strong>
  </div>
  <p>Dear ${(ol.candidate_name || '').split(' ')[0]},</p>
  <div class="subject-line">Sub: Letter of offer/Appointment for the position of &ldquo;${ol.designation || ''}&rdquo;</div>
  <p>In reference to our discussions, we are pleased to offer you the position of <strong>&ldquo;${ol.designation || ''}&rdquo;</strong> in Risk Care Insurance Broking Services Private Limited${empTypeLabel}, to be based at our <strong>${ol.location || 'Mumbai'} Office${ol.joining_date ? ' as from <strong>' + joiningDateHTML(ol.joining_date) + '</strong>' : ''}.</strong></p>
  <p>The offer letter is valid for <strong>${ol.offer_valid_days || 7} days</strong> by which time we must be informed of your decision; the said offer letter shall stand cancelled after the above-mentioned date.</p>
  <p>We are pleased to issue this letter of offer on the following terms &amp; conditions:</p>
  <p><u><strong>EMOLUMENTS:</strong></u><br>
  Your compensation on a cost to company basis will be <strong>Rs. ${Number(ctcAnnual).toLocaleString('en-IN')}/- PA (Rupees ${numberToWords(Math.round(ctcAnnual))} Only)</strong>. The remuneration has taken into consideration the status and responsibility of the appointment, and it is inclusive of all taxable and non-taxable emoluments, allowances and statutory contributions.</p>
  <p><u><strong>RESPONSIBILITIES:</strong></u><br>
  You will work as &ldquo;${ol.designation || ''}&rdquo; of the Company and will be responsible for carrying out the operations of the Company as directed to you by the management. A detailed responsibility statement will be provided to you upon your joining.</p>
  ${empType !== 'contract' ? '<p><u><strong>PROBATION PERIOD:</strong></u><br>You will be on a probationary period of <strong>' + probStr + ' months</strong> during which the services can be terminated from employer without giving any reason and any time for notice of termination of services. The company may regularize your services subject to satisfactory completion of probationary period.</p>' : ''}
  <p><u><strong>SEPERATION OF SERVICES:</strong></u><br>
  Severance of relationship can be done by giving <strong>${noticeStr} month</strong> written notice. If you are unable to complete this notice period you will be liable to compensate the company <strong>${noticeStr} month${parseInt(ol.notice_period_months || 3) > 1 ? 's' : ''}</strong> of salary or for the period not served.</p>
  <p><u><strong>OTHER RULES AND REGULATION:</strong></u></p>
  <ul>
    <li>The company will expect you to work in the Section / Department in which you are placed with a high standard of initiative, morality and economy.</li>
    <li>You will, in all respects, be governed by the company&rsquo;s rules and regulations.</li>
    <li>You will devote full time to the work of the Company and will not undertake any direct/ indirect outside business or work, honorary or remunerative except with the prior written consent of the Management.</li>
    <li>You will abide by Leave Rules of company.</li>
  </ul>
  ${ftr}
</div>

<!-- PAGE 2 -->
<div class="page">
  ${hdr}
  <ul style="margin-top:40px;">
    <li>You have been engaged on the presumption that the particulars furnished by you in your application are correct. In case the said particular are found to be incorrect or that you have concealed or withheld information or the relevant facts, the services can be terminated from the company without giving any reason and any time for notice of termination of services. The company may regularize your services subject to satisfactory completion of period.</li>
    <li>You will not, either during the period of your services of thereafter, disclose divulge or communicate to any other person or group or company any strategic information of the organization or its clients.</li>
    <li>All correspondence addressed to you by the company including press and other copies of such correspondence and all vouchers, books, records, including all note books containing notes or records of business or prices or other market data, samples and/or other papers belonging to the company, circulars and all other relevant papers and documents of any nature whatsoever relating to the company&rsquo;s business, which shall come into your possession in the course of your employment shall be the absolute property of the company and you shall, at any time during your employment or upon termination there for any reason whatsoever, deliver the same to the company and without claiming any lien thereon.</li>
    <li>You will be responsible for the safe keeping and for returning in good condition and order, all on your own the company&rsquo;s property which may be in your use, custody, care or charge. The company shall have the right to deduct the monetary value of all such things from any amounts payable to you and to take such actions as may be deemed proper in the event of your failure to account for such property to the satisfaction of the management.</li>
    <li>You will keep us informed of your residential (mailing &amp; permanent) address. Any change in the same should be notified in writing within one week. Failure to do so will be treated as willful withholding of information and appropriate action as deemed fit by management would be taken against you.</li>
  </ul>
  ${additionalTerms}
  <p><strong>If you are willing to accept this offer for the said position, we request you to submit 3 copies of your latest coloured Passport Size photograph, Self-attested Copy of your academic qualification, Self-attested copy of your PAN Card, Self-attested copy of your Aadhar Card, Self-attested Copy of Address Proof, and last 3 month Pay Slip / Form 16 from your previous employer. In addition, upon joining, you will have to submit a copy of your relieving letter from your previous employer.</strong></p>
  <p>As a token of your acceptance and in confirmation of the terms and conditions of this offer, please sign the duplicate copy of this letter and return to us at the earliest duly intimating when you are going to join.</p>
  <div class="main-signature-block">
    <p>Yours truly,<br>From <strong>Risk Care Insurance Broking Services Private Limited,</strong></p>
    <div class="dual-signature">
      <div class="sig-left">${sig1HTML}Authorized Signatory</div>
      <div class="sig-right">${sig2HTML}(Authorized Signatory)<br><br>Human Resource</div>
    </div>
  </div>
  ${ftr}
</div>

<!-- PAGE 3: ANNEXURE -->
<div class="page">
  ${hdr}
  <h3 style="text-align:center;text-decoration:underline;margin-top:35px;font-size:16px;">Annexure I (Annual Cost to Company and Other Benefits)</h3>
  <p style="margin-top:10px;font-size:13px;">
    <strong>Name:</strong> ${ol.candidate_name || ''}<br>
    <strong>Designation:</strong> ${ol.designation || ''}<br>
    <strong>Location:</strong> ${ol.location || 'Mumbai'}<br>
    <strong>Annual Cost to Company:</strong> Rs.${Number(ctcAnnual).toLocaleString('en-IN')} (Rupees ${numberToWords(Math.round(ctcAnnual))} Only)
  </p>
  <table class="data-table">
    <thead>
      <tr>
        <th class="col-sr">SR. NO.</th>
        <th class="col-part">PARTICULARS</th>
        <th class="col-num">MONTHLY</th>
        <th class="col-num">YEARLY</th>
      </tr>
    </thead>
    <tbody>
      <tr><td class="col-sr">1</td><td class="col-part">Fixed Basic</td><td class="col-num">${fmtV(basic)}</td><td class="col-num">${fmtV(basic * 12)}</td></tr>
      <tr><td class="col-sr">2</td><td class="col-part">HRA</td><td class="col-num">${fmtV(hra)}</td><td class="col-num">${fmtV(hra * 12)}</td></tr>
      ${convRow}
      <tr><td class="col-sr">3</td><td class="col-part">Other Allowances</td><td class="col-num">${fmtV(other)}</td><td class="col-num">${fmtV(other * 12)}</td></tr>
      <tr><td class="col-sr">4</td><td class="col-part">Gratuity</td><td class="col-num">${fmtV(gratuity)}</td><td class="col-num">${fmtV(gratuity * 12)}</td></tr>
      <tr class="highlight"><td class="col-sr">5</td><td class="col-part">Gross Pay</td><td class="col-num">${fmtV(gross)}</td><td class="col-num">${fmtV(gross * 12)}</td></tr>
      <tr><td class="col-sr">6</td><td class="col-part">Provident Fund</td><td class="col-num">${pfEmp > 0 ? fmtV(pfEmp) : ''}</td><td class="col-num">${pfEmp > 0 ? fmtV(pfEmp * 12) : ''}</td></tr>
      <tr><td class="col-sr">7</td><td class="col-part">Professional Tax</td><td class="col-num">${pt > 0 ? fmtV(pt) : ''}</td><td class="col-num">${pt > 0 ? fmtV(pt * 12) : ''}</td></tr>
      <tr class="highlight"><td class="col-sr">8</td><td class="col-part">Total Deduction</td><td class="col-num">${totalDed > 0 ? fmtV(totalDed) : ''}</td><td class="col-num">${totalDed > 0 ? fmtV(totalDed * 12) : ''}</td></tr>
      <tr class="highlight"><td class="col-sr">9</td><td class="col-part">Net Salary (Gross - Total Deduction)</td><td class="col-num">${fmtV(netSalary)}</td><td class="col-num">${fmtV(netSalary * 12)}</td></tr>
      <tr><td class="col-sr">10</td><td class="col-part">Employer PF contribution</td><td class="col-num">${pfEmpr > 0 ? fmtV(pfEmpr) : ''}</td><td class="col-num">${pfEmpr > 0 ? fmtV(pfEmpr * 12) : ''}</td></tr>
      <tr><td class="col-sr">11</td><td class="col-part">Employer PF contribution Admin charges</td><td class="col-num">${pfAdmin > 0 ? fmtV(pfAdmin) : ''}</td><td class="col-num">${pfAdmin > 0 ? fmtV(pfAdmin * 12) : ''}</td></tr>
      <tr class="highlight"><td class="col-sr">12</td><td class="col-part">Total Compensation Package</td><td class="col-num">${fmtV(ctcMonthly)}</td><td class="col-num">${fmtV(ctcAnnual)}</td></tr>
    </tbody>
  </table>
  <div style="margin-top:15px;">
    <h4 style="margin-bottom:5px;font-size:14px;text-decoration:underline;">Acknowledgement &amp; Acceptance</h4>
    <p style="margin-top:0;font-size:13px;">I have read understood, agree to the above terms and conditions, and hereby sign my acceptance of the same.</p>
    <div style="margin-top:15px;font-size:14px;line-height:2.0;font-weight:bold;">
      Signature: _____________________________________________________<br>
      Name: &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;_____________________________________________________<br>
      Date: &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;_____________________________________________________<br>
      Location: &nbsp;&nbsp;&nbsp;&nbsp;_____________________________________________________
    </div>
  </div>
  ${ftr}
</div>

</body>
</html>`;
}

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
      designation, location = 'Mumbai', joining_date, offer_date, offer_valid_days = 7,
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
      'employment_type', 'contract_months'];
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

    const defaultMsg = `Dear ${ol.candidate_name.split(' ')[0] || ol.candidate_name},\n\nPlease find attached your offer letter for the position of "${ol.designation}" at Risk Care Insurance Broking Services Private Limited.\n\nKindly review the letter and revert back with your acceptance within ${ol.offer_valid_days || 7} days.\n\nFor any queries, feel free to reach out to us.\n\nWarm regards,\nHuman Resource Team\nRisk Care Insurance Broking Services Pvt. Ltd.`;

    const coverText = (email_message || defaultMsg).replace(/\n/g, '<br>');
    const coverHtml = `
      <div style="font-family:Arial,sans-serif;font-size:13px;color:#222;line-height:1.7;max-width:600px;">
        <div style="background:#C0272D;padding:16px 24px;border-radius:8px 8px 0 0;">
          <span style="color:#fff;font-size:16px;font-weight:700;">RiskCare HR</span>
          <span style="color:#f5b5b5;font-size:12px;margin-left:8px;">Risk Care Insurance Broking Services</span>
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
      sender: { name: process.env.EMAIL_FROM_NAME || 'RiskCareHR', email: process.env.EMAIL_FROM || 'hr@riskcare.co.in' },
      to: [{ email: ol.candidate_email, name: ol.candidate_name }],
      subject: `Offer Letter — ${ol.designation} | Risk Care Insurance Broking Services`,
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
        const otherAllow = parseFloat(String(row['Other Allowance']    || row['other_allowance_monthly'] || 0).replace(/,/g, '')) || 0;
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
            <div style="background:#C0272D;padding:16px 24px;border-radius:8px 8px 0 0;">
              <span style="color:#fff;font-size:16px;font-weight:700;">RiskCare HR</span>
              <span style="color:#f5b5b5;font-size:12px;margin-left:8px;">Risk Care Insurance Broking Services</span>
            </div>
            <div style="border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
              <p>Dear ${firstName},</p>
              <p>Please find attached your offer letter for the position of <strong>"${designation}"</strong> at Risk Care Insurance Broking Services Private Limited.</p>
              <p>Kindly review the letter and revert back with your acceptance within <strong>${offerValidDays} days</strong>.</p>
              <p>For any queries, feel free to reach out to us.</p>
              <p>Warm regards,<br>Human Resource Team<br>Risk Care Insurance Broking Services Pvt. Ltd.</p>
            </div>
          </div>`;

        const attachments = [{ name: `Offer_Letter_${candidateName.replace(/\s+/g, '_')}.pdf`, content: offerPdfBuffer.toString('base64') }];
        const payload = {
          sender: { name: process.env.EMAIL_FROM_NAME || 'RiskCareHR', email: process.env.EMAIL_FROM || 'hr@riskcare.co.in' },
          to: [{ email: candidateEmail, name: candidateName }],
          subject: `Offer Letter — ${designation} | Risk Care Insurance Broking Services`,
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
