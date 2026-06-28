const CONFIG = require('../Main_file');
// src/controllers/relievingLetterController.js
// Relieving Letter Controller — RiskCare HRMS

const db            = require('../config/db');
const path          = require('path');
const fs            = require('fs');
const puppeteerCore = require('puppeteer-core');
const chromium      = require('@sparticuz/chromium').default;

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

// ── Date formatter ─────────────────────────────────────────────────────────────
function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return '';
  const day = dt.getDate();
  const sup = [, 'st', 'nd', 'rd'][day] || 'th';
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return day + '<sup>' + sup + '</sup> ' + months[dt.getMonth()] + ' ' + dt.getFullYear();
}

// ── Build Relieving Letter HTML ────────────────────────────────────────────────
function buildRelievingLetterHTML(emp, sig1Image, sig2Image) {
  // ── Logo: direct PNG from frontend folder ──────────────────────────────────
  const LOGO_PATH = path.join(__dirname, '../../../frontend/Logo.png');
  let LOGO_B64 = '';
  try {
    LOGO_B64 = 'data:image/png;base64,' + fs.readFileSync(LOGO_PATH).toString('base64');
  } catch (e) {
    console.error('Logo not found:', e.message);
  }

  const fullName      = ((emp.first_name || '') + ' ' + (emp.last_name || '')).trim();
  const designation   = emp.designation_title || emp.designation || 'Employee';
  const department    = emp.department_name || emp.department || 'Operations';
  const joiningDate   = formatDate(emp.joining_date);
  const relievingDate = formatDate(emp.separation_date || emp.last_working_date);
  const todayDate     = formatDate(new Date());
  const gender        = (emp.gender || '').toLowerCase();
  const heOrShe       = gender === 'female' ? 'She' : 'He';
  const hisOrHer      = gender === 'female' ? 'her' : 'his';
  const mrOrMs        = gender === 'female' ? 'Ms.' : 'Mr.';
  const st            = emp.separation_type || emp.sep_type || 'resignation';

  // ── RiskCare Letterhead Header ─────────────────────────────────────────────
  const hdr = `
    <table class="header-table">
      <tr>
        <td style="width:120px;vertical-align:middle;">
          <img src="${LOGO_B64}" style="width:110px;height:auto;display:block;">
        </td>
        <td style="text-align:center;vertical-align:middle;">
          <div style="font-family:Arial,sans-serif;font-size:20px;font-weight:bold;color:#000;margin-bottom:4px;">${CONFIG.companyFullName}</div>
          <div style="font-family:Arial,sans-serif;font-size:11px;color:#444;"><strong>Registered Office:</strong> ${CONFIG.companyOfficeAddr}</div>
          <div style="font-family:Arial,sans-serif;font-size:11px;color:#444;margin-top:2px;">Phone: +91 22 61473232 &nbsp;|&nbsp; Email: support@riskcare.co.in &nbsp;|&nbsp; Website: www.riskcareinsure.com</div>
        </td>
      </tr>
    </table>`;

  // ── RiskCare Footer ────────────────────────────────────────────────────────
  const ftr = `
    <div class="footer">
      CIN: ${CONFIG.companyCIN}
    </div>`;

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
    padding: 5mm 15mm 25mm 15mm;
    overflow: hidden;
  }
  .header-table {
    width: 100%; border-bottom: 2px solid #000;
    padding-bottom: 22px; margin-bottom: 65px;
    border-collapse: collapse;
  }
  .footer {
    position: absolute; bottom: 10mm; left: 15mm; right: 15mm;
    text-align: center; font-size: 10px; color: #000;
    border-top: 1px solid #000; padding-top: 5px;
    font-family: 'Arial',sans-serif; font-weight: bold;
  }
  .date-row { text-align: right; font-weight: bold; font-size: 13.5px; margin-bottom: 15px; }
  p { margin: 8px 0; text-align: justify; font-size: 13px; line-height: 1.7; }
  .sig-block { margin-top: 60px; font-size: 14px; }
  .dual-signature { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 30px; }
  .sig-left { text-align: left; }
  .sig-right { text-align: right; }
  @media print {
    @page { size: A4; margin: 0 !important; }
    html, body { background-color: #fff; padding: 0 !important; margin: 0 !important; }
    .page { box-shadow: none !important; margin: 0 !important; }
    .page:last-of-type { page-break-after: avoid !important; }
  }
</style>
</head>
<body>

<div class="page">
  ${hdr}

  <div class="date-row">${todayDate}</div>

  <p style="text-align:center;font-weight:bold;font-size:14px;margin:20px 0;text-decoration:underline;">To Whomsoever It May Concern,</p>

  <p style="text-align:center;font-weight:bold;font-size:13px;margin-bottom:16px;">Sub: Relieving Letter &ndash; ${mrOrMs} ${fullName} (${emp.employee_code || 'N/A'})</p>

  <p>This is to certify that <strong>${mrOrMs} ${fullName}</strong> (Employee Code: <strong>${emp.employee_code || 'N/A'}</strong>) was employed with <strong>${CONFIG.companyFullName}</strong> from <strong>${joiningDate}</strong> to <strong>${relievingDate}</strong>. ${heOrShe} was designated as <strong>&ldquo;${designation}&rdquo;</strong> in the <strong>${department}</strong> department, based at our <strong>${emp.city || emp.location || CONFIG.companyCity}</strong> office.</p>

  <p>${heOrShe} has been relieved from ${hisOrHer} duties and responsibilities with effect from <strong>${relievingDate}</strong>, consequent upon ${hisOrHer} ${(st || 'resignation').toLowerCase()} from the services of the company.</p>

  <p>During ${hisOrHer} tenure with the organization, ${mrOrMs} ${fullName} has discharged ${hisOrHer} duties with sincerity, integrity and dedication. ${heOrShe} has demonstrated a high standard of professional conduct and has been a valued member of the team.</p>

  <p>${heOrShe} has completed all necessary formalities including handing over of company assets, documents, and any other materials entrusted to ${hisOrHer} during the course of employment. ${heOrShe} has no outstanding dues, liabilities or obligations towards the company as on the date of relieving.</p>

  <p>The full and final settlement of ${hisOrHer} account shall be processed as per the company&rsquo;s policies and applicable statutory requirements.</p>

  <p>We appreciate ${hisOrHer} contributions during ${hisOrHer} association with the company and wish ${mrOrMs} ${fullName} all the very best in ${hisOrHer} future professional endeavours.</p>

  <p>This certificate is being issued at ${hisOrHer} request and for any legitimate purpose it may serve. It does not constitute a recommendation.</p>

  <div class="sig-block">
    <p>Yours truly,</p>
    <p>For <strong>${CONFIG.companyFullName},</strong></p>
    <div class="dual-signature">
      <div class="sig-left">
        ${sig1Image ? '<img src="' + sig1Image + '" style="height:44px;display:block;margin-bottom:4px;">' : '<div style="height:44px;"></div>'}
        <p>Authorized Signatory</p>
      </div>
      <div class="sig-right">
        ${sig2Image ? '<img src="' + sig2Image + '" style="height:44px;display:block;margin-left:auto;margin-bottom:4px;">' : '<div style="height:44px;"></div>'}
        <p>(Authorized Signatory)<br><br>Human Resource</p>
      </div>
    </div>
  </div>

  ${ftr}
</div>

</body>
</html>`;
}

// ── GET /api/relieving-letters/eligible ───────────────────────────────────────
exports.getEligible = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT e.id, e.employee_code, e.first_name, e.last_name, e.email,
             e.alternate_email, e.phone, e.gender, e.joining_date,
             e.separation_date, e.separation_type, e.separation_reason,
             d.name AS department_name, des.title AS designation_title,
             s.last_working_date, s.type AS sep_type, s.status AS sep_status,
             s.relieving_letter_sent_at
      FROM employees e
      LEFT JOIN departments d ON e.department_id = d.id
      LEFT JOIN designations des ON e.designation_id = des.id
      LEFT JOIN separations s ON s.employee_id = e.id AND s.status = 'completed'
      WHERE e.is_active = false
      ORDER BY COALESCE(e.separation_date, s.last_working_date) DESC NULLS LAST
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[relievingLetter.getEligible]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── GET /api/relieving-letters/preview/:id ────────────────────────────────────
exports.preview = async (req, res) => {
  try {
    const empId = parseInt(req.params.id);
    const result = await db.query(`
      SELECT e.*, d.name AS department_name, des.title AS designation_title,
             s.last_working_date
      FROM employees e
      LEFT JOIN departments d ON e.department_id = d.id
      LEFT JOIN designations des ON e.designation_id = des.id
      LEFT JOIN separations s ON s.employee_id = e.id AND s.status = 'completed'
      WHERE e.id = $1 AND e.is_active = false
    `, [empId]);

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Employee not found or still active' });
    }

    const emp    = result.rows[0];
    const sigRow = await db.query(`SELECT sig1_image, sig2_image FROM offer_letters WHERE sig1_image IS NOT NULL LIMIT 1`);
    const sig1   = sigRow.rows[0]?.sig1_image || null;
    const sig2   = sigRow.rows[0]?.sig2_image || null;

    const html      = buildRelievingLetterHTML(emp, sig1, sig2);
    const pdfBuffer = await htmlToPdf(html);

    const fullName = ((emp.first_name || '') + ' ' + (emp.last_name || '')).trim();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Relieving_Letter_${fullName.replace(/\s+/g, '_')}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[relievingLetter.preview]', err.message);
    res.status(500).json({ success: false, message: `Server error: ${err.message}` });
  }
};

// ── PUT /api/relieving-letters/update-email/:id ───────────────────────────────
exports.updateEmail = async (req, res) => {
  try {
    const empId = parseInt(req.params.id);
    const { alternate_email } = req.body;
    if (!alternate_email || !alternate_email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email required' });
    }
    await db.query('UPDATE employees SET alternate_email = $1 WHERE id = $2', [alternate_email.trim(), empId]);
    res.json({ success: true, message: 'Email updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/relieving-letters/update-dates/:id ───────────────────────────────
exports.updateDates = async (req, res) => {
  try {
    const empId = parseInt(req.params.id);
    const { joining_date, separation_date } = req.body;
    const sets = [], vals = [];
    let idx = 1;

    if (joining_date)    { sets.push(`joining_date = $${idx++}`);    vals.push(joining_date); }
    if (separation_date) { sets.push(`separation_date = $${idx++}`); vals.push(separation_date); }

    if (!sets.length) return res.json({ success: true, message: 'Nothing to update' });

    vals.push(empId);
    await db.query(`UPDATE employees SET ${sets.join(', ')} WHERE id = $${idx}`, vals);

    if (separation_date) {
      await db.query(`UPDATE separations SET last_working_date = $1 WHERE employee_id = $2`, [separation_date, empId]);
    }

    res.json({ success: true, message: 'Dates updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/relieving-letters/send/:id ──────────────────────────────────────
exports.sendRelievingLetter = async (req, res) => {
  try {
    const empId = parseInt(req.params.id);
    const result = await db.query(`
      SELECT e.*, d.name AS department_name, des.title AS designation_title,
             s.last_working_date
      FROM employees e
      LEFT JOIN departments d ON e.department_id = d.id
      LEFT JOIN designations des ON e.designation_id = des.id
      LEFT JOIN separations s ON s.employee_id = e.id AND s.status = 'completed'
      WHERE e.id = $1 AND e.is_active = false
    `, [empId]);

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Employee not found or still active' });
    }

    const emp           = result.rows[0];
    const { cc = [], bcc = [] } = req.body;
    const personalEmail = emp.alternate_email;

    if (!personalEmail || !personalEmail.includes('@')) {
      return res.status(400).json({ success: false, message: `No personal email (alternate_email) found for ${emp.first_name} ${emp.last_name}. Please update their profile first.` });
    }
    if (personalEmail.toLowerCase().includes('@riskcare.co.in') || personalEmail.toLowerCase().includes('@riskcareinsure.com')) {
      return res.status(400).json({ success: false, message: `Personal email must not be a company email. Please set a personal email (Gmail, Yahoo, etc.) in the alternate email field.` });
    }

    const sigRow = await db.query(`SELECT sig1_image, sig2_image FROM offer_letters WHERE sig1_image IS NOT NULL LIMIT 1`);
    const sig1   = sigRow.rows[0]?.sig1_image || null;
    const sig2   = sigRow.rows[0]?.sig2_image || null;

    const html      = buildRelievingLetterHTML(emp, sig1, sig2);
    const pdfBuffer = await htmlToPdf(html);
    const fullName  = ((emp.first_name || '') + ' ' + (emp.last_name || '')).trim();

    const coverHtml = `
      <div style="font-family:Arial,sans-serif;font-size:13px;color:#222;line-height:1.7;max-width:600px;">
        <div style="background:#C0272D;padding:16px 24px;border-radius:8px 8px 0 0;">
          <span style="color:#fff;font-size:16px;font-weight:700;">RiskCare HR</span>
          <span style="color:#f5b5b5;font-size:12px;margin-left:8px;">${CONFIG.companyShortName}</span>
        </div>
        <div style="border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
          <p>Dear ${emp.first_name},</p>
          <p>Please find attached your <strong>Relieving Letter</strong> from ${CONFIG.companyFullName}.</p>
          <p>We thank you for your contributions during your tenure and wish you all the very best in your future endeavours.</p>
          <p>For any queries, feel free to reach out to us.</p>
          <p>Warm regards,<br>Human Resource Team<br>${CONFIG.companyFullName}</p>
        </div>
      </div>`;

    const payload = {
      sender: { name: process.env.EMAIL_FROM_NAME || 'RiskCareHR', email: process.env.EMAIL_FROM || 'hr@riskcare.co.in' },
      to: [{ email: personalEmail, name: fullName }],
      subject: `Relieving Letter — ${fullName} | ${CONFIG.companyShortName}`,
      htmlContent: coverHtml,
      attachment: [{ name: `Relieving_Letter_${fullName.replace(/\s+/g, '_')}.pdf`, content: pdfBuffer.toString('base64') }],
    };

    const ccList  = (Array.isArray(cc)  ? cc  : []).map(e => typeof e === 'string' ? { email: e.trim() } : e).filter(e => e.email);
    const bccList = (Array.isArray(bcc) ? bcc : []).map(e => typeof e === 'string' ? { email: e.trim() } : e).filter(e => e.email);
    if (ccList.length)  payload.cc  = ccList;
    if (bccList.length) payload.bcc = bccList;

    const BREVO_KEY = process.env.BREVO_API_KEY;
    if (!BREVO_KEY || process.env.EMAIL_ENABLED !== 'true') {
      await db.query(`UPDATE separations SET relieving_letter_sent_at = NOW() WHERE employee_id = $1`, [empId]);
      return res.json({ success: true, message: `[Simulated] Relieving letter sent to ${personalEmail}` });
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

    await db.query(`UPDATE separations SET relieving_letter_sent_at = NOW() WHERE employee_id = $1`, [empId]);
    res.json({ success: true, message: `Relieving letter sent to ${personalEmail}` });
  } catch (err) {
    console.error('[relievingLetter.send]', err.message);
    res.status(500).json({ success: false, message: `Server error: ${err.message}` });
  }
};

// ── POST /api/relieving-letters/bulk-send ─────────────────────────────────────
exports.bulkSend = async (req, res) => {
  try {
    const { employee_ids } = req.body;
    if (!Array.isArray(employee_ids) || !employee_ids.length) {
      return res.status(400).json({ success: false, message: 'No employees selected' });
    }

    const result = await db.query(`
      SELECT e.*, d.name AS department_name, des.title AS designation_title,
             s.last_working_date
      FROM employees e
      LEFT JOIN departments d ON e.department_id = d.id
      LEFT JOIN designations des ON e.designation_id = des.id
      LEFT JOIN separations s ON s.employee_id = e.id AND s.status = 'completed'
      WHERE e.id = ANY($1) AND e.is_active = false
    `, [employee_ids]);

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'No eligible employees found' });
    }

    const BREVO_KEY    = process.env.BREVO_API_KEY;
    const emailEnabled = process.env.EMAIL_ENABLED === 'true';

    const sigRow = await db.query(`SELECT sig1_image, sig2_image FROM offer_letters WHERE sig1_image IS NOT NULL LIMIT 1`);
    const sig1   = sigRow.rows[0]?.sig1_image || null;
    const sig2   = sigRow.rows[0]?.sig2_image || null;

    const browser = await launchBrowser();
    const results = [];
    let sent = 0, failed = 0;

    try {
      for (const emp of result.rows) {
        const fullName      = ((emp.first_name || '') + ' ' + (emp.last_name || '')).trim();
        const personalEmail = emp.alternate_email;

        if (!personalEmail || !personalEmail.includes('@')) {
          results.push({ id: emp.id, name: fullName, email: '', status: 'failed', reason: 'No personal email set' });
          failed++;
          continue;
        }
        if (personalEmail.toLowerCase().includes('@riskcare.co.in') || personalEmail.toLowerCase().includes('@riskcareinsure.com')) {
          results.push({ id: emp.id, name: fullName, email: personalEmail, status: 'failed', reason: 'Company email — need personal email' });
          failed++;
          continue;
        }

        try {
          const html      = buildRelievingLetterHTML(emp, sig1, sig2);
          const pdfBuffer = await htmlToPdf(html, browser);

          const coverHtml = `
            <div style="font-family:Arial,sans-serif;font-size:13px;color:#222;line-height:1.7;max-width:600px;">
              <div style="background:#C0272D;padding:16px 24px;border-radius:8px 8px 0 0;">
                <span style="color:#fff;font-size:16px;font-weight:700;">RiskCare HR</span>
                <span style="color:#f5b5b5;font-size:12px;margin-left:8px;">${CONFIG.companyShortName}</span>
              </div>
              <div style="border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
                <p>Dear ${emp.first_name},</p>
                <p>Please find attached your <strong>Relieving Letter</strong> from ${CONFIG.companyFullName}.</p>
                <p>We wish you all the very best in your future endeavours.</p>
                <p>Warm regards,<br>Human Resource Team<br>${CONFIG.companyFullName}</p>
              </div>
            </div>`;

          const payload = {
            sender: { name: process.env.EMAIL_FROM_NAME || 'RiskCareHR', email: process.env.EMAIL_FROM || 'hr@riskcare.co.in' },
            to: [{ email: personalEmail, name: fullName }],
            subject: `Relieving Letter — ${fullName} | ${CONFIG.companyShortName}`,
            htmlContent: coverHtml,
            attachment: [{ name: `Relieving_Letter_${fullName.replace(/\s+/g, '_')}.pdf`, content: pdfBuffer.toString('base64') }],
          };

          if (!BREVO_KEY || !emailEnabled) {
            await db.query(`UPDATE separations SET relieving_letter_sent_at = NOW() WHERE employee_id = $1`, [emp.id]);
            results.push({ id: emp.id, name: fullName, email: personalEmail, status: 'sent', reason: '[Simulated]' });
            sent++;
          } else {
            const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
              body: JSON.stringify(payload)
            });
            if (resp.ok) {
              await db.query(`UPDATE separations SET relieving_letter_sent_at = NOW() WHERE employee_id = $1`, [emp.id]);
              results.push({ id: emp.id, name: fullName, email: personalEmail, status: 'sent', reason: '' });
              sent++;
            } else {
              const errText = await resp.text();
              results.push({ id: emp.id, name: fullName, email: personalEmail, status: 'failed', reason: `Email API: ${errText.substring(0, 120)}` });
              failed++;
            }
          }
          await new Promise(r => setTimeout(r, 300));
        } catch (innerErr) {
          results.push({ id: emp.id, name: fullName, email: personalEmail || '', status: 'failed', reason: innerErr.message });
          failed++;
        }
      }
    } finally {
      await browser.close();
    }

    res.json({ success: true, total: result.rows.length, sent, failed, results });
  } catch (err) {
    console.error('[relievingLetter.bulkSend]', err.message);
    res.status(500).json({ success: false, message: `Server error: ${err.message}` });
  }
};

// ── POST /api/relieving-letters/bulk-send-excel ───────────────────────────────
exports.bulkSendExcel = async (req, res) => {
  try {
    const XLSX = require('xlsx');
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) return res.status(400).json({ success: false, message: 'Excel is empty' });

    const ccRaw  = String(rows[0]['CC']  || rows[0]['cc']  || '').split(',').map(e => e.trim()).filter(e => e.includes('@'));
    const bccRaw = String(rows[0]['BCC'] || rows[0]['bcc'] || '').split(',').map(e => e.trim()).filter(e => e.includes('@'));

    const sigRow = await db.query(`SELECT sig1_image, sig2_image FROM offer_letters WHERE sig1_image IS NOT NULL LIMIT 1`);
    const sig1   = sigRow.rows[0]?.sig1_image || null;
    const sig2   = sigRow.rows[0]?.sig2_image || null;

    const BREVO_KEY    = process.env.BREVO_API_KEY;
    const emailEnabled = process.env.EMAIL_ENABLED === 'true';

    const browser = await launchBrowser();
    const results = [];
    let sent = 0, failed = 0;

    try {
      for (let i = 0; i < rows.length; i++) {
        const row    = rows[i];
        const rowNum = i + 2;
        const empCode  = String(row['Employee Code']   || row['employee_code']   || '').trim();
        const empEmail = String(row['Personal Email']  || row['Email']           || row['alternate_email'] || '').trim();

        if (!empCode && !empEmail) {
          results.push({ row: rowNum, name: '', email: '', status: 'failed', reason: 'No employee code or email' });
          failed++;
          continue;
        }

        let empResult;
        if (empCode) {
          empResult = await db.query(`
            SELECT e.*, d.name AS department_name, des.title AS designation_title, s.last_working_date
            FROM employees e
            LEFT JOIN departments d ON e.department_id = d.id
            LEFT JOIN designations des ON e.designation_id = des.id
            LEFT JOIN separations s ON s.employee_id = e.id AND s.status = 'completed'
            WHERE e.employee_code = $1 AND e.is_active = false
          `, [empCode]);
        } else {
          empResult = await db.query(`
            SELECT e.*, d.name AS department_name, des.title AS designation_title, s.last_working_date
            FROM employees e
            LEFT JOIN departments d ON e.department_id = d.id
            LEFT JOIN designations des ON e.designation_id = des.id
            LEFT JOIN separations s ON s.employee_id = e.id AND s.status = 'completed'
            WHERE e.alternate_email = $1 AND e.is_active = false
          `, [empEmail]);
        }

        if (!empResult.rows.length) {
          results.push({ row: rowNum, name: empCode, email: empEmail, status: 'failed', reason: 'Employee not found or still active' });
          failed++;
          continue;
        }

        const emp         = empResult.rows[0];
        const fullName    = ((emp.first_name || '') + ' ' + (emp.last_name || '')).trim();
        const targetEmail = empEmail || emp.alternate_email;

        if (!targetEmail || !targetEmail.includes('@')) {
          results.push({ row: rowNum, name: fullName, email: '', status: 'failed', reason: 'No personal email' });
          failed++;
          continue;
        }
        if (targetEmail.toLowerCase().includes('@riskcare.co.in') || targetEmail.toLowerCase().includes('@riskcareinsure.com')) {
          results.push({ row: rowNum, name: fullName, email: targetEmail, status: 'failed', reason: 'Company email — need personal' });
          failed++;
          continue;
        }

        if (empEmail && empEmail !== emp.alternate_email) {
          await db.query('UPDATE employees SET alternate_email = $1 WHERE id = $2', [empEmail, emp.id]);
        }

        try {
          const html      = buildRelievingLetterHTML(emp, sig1, sig2);
          const pdfBuffer = await htmlToPdf(html, browser);

          const coverHtml = `
            <div style="font-family:Arial,sans-serif;font-size:13px;color:#222;line-height:1.7;max-width:600px;">
              <div style="background:#C0272D;padding:16px 24px;border-radius:8px 8px 0 0;">
                <span style="color:#fff;font-size:16px;font-weight:700;">RiskCare HR</span>
                <span style="color:#f5b5b5;font-size:12px;margin-left:8px;">${CONFIG.companyShortName}</span>
              </div>
              <div style="border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
                <p>Dear ${emp.first_name},</p>
                <p>Please find attached your <strong>Relieving Letter</strong>.</p>
                <p>We wish you all the very best in your future endeavours.</p>
                <p>Warm regards,<br>Human Resource Team<br>${CONFIG.companyFullName}</p>
              </div>
            </div>`;

          const payload = {
            sender: { name: process.env.EMAIL_FROM_NAME || 'RiskCareHR', email: process.env.EMAIL_FROM || 'hr@riskcare.co.in' },
            to: [{ email: targetEmail, name: fullName }],
            subject: `Relieving Letter — ${fullName} | ${CONFIG.companyShortName}`,
            htmlContent: coverHtml,
            attachment: [{ name: `Relieving_Letter_${fullName.replace(/\s+/g, '_')}.pdf`, content: pdfBuffer.toString('base64') }],
          };
          if (ccRaw.length)  payload.cc  = ccRaw.map(e => ({ email: e }));
          if (bccRaw.length) payload.bcc = bccRaw.map(e => ({ email: e }));

          if (!BREVO_KEY || !emailEnabled) {
            await db.query(`UPDATE separations SET relieving_letter_sent_at = NOW() WHERE employee_id = $1`, [emp.id]);
            results.push({ row: rowNum, name: fullName, email: targetEmail, status: 'sent', reason: '[Simulated]' });
            sent++;
          } else {
            const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
              body: JSON.stringify(payload)
            });
            if (resp.ok) {
              await db.query(`UPDATE separations SET relieving_letter_sent_at = NOW() WHERE employee_id = $1`, [emp.id]);
              results.push({ row: rowNum, name: fullName, email: targetEmail, status: 'sent', reason: '' });
              sent++;
            } else {
              const errText = await resp.text();
              results.push({ row: rowNum, name: fullName, email: targetEmail, status: 'failed', reason: errText.substring(0, 120) });
              failed++;
            }
          }
          await new Promise(r => setTimeout(r, 300));
        } catch (innerErr) {
          results.push({ row: rowNum, name: fullName, email: targetEmail, status: 'failed', reason: innerErr.message });
          failed++;
        }
      }
    } finally {
      await browser.close();
    }

    res.json({ success: true, total: rows.length, sent, failed, results });
  } catch (err) {
    console.error('[relievingLetter.bulkSendExcel]', err.message);
    res.status(500).json({ success: false, message: `Server error: ${err.message}` });
  }
};
