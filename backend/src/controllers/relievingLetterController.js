const CONFIG = require('../Main_file');
// src/controllers/relievingLetterController.js
// Relieving Letter Controller — RiskCare HRMS

const db            = require('../config/db');
const { htmlToPdf } = require('./offerLetterController');

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
  // dd/mm/yyyy and "24th January, 2026" styles used by the approved format
  const dmy = (d) => { if (!d) return '__/__/____'; const x = new Date(d); return isNaN(x) ? '__/__/____' : String(x.getDate()).padStart(2,'0') + '/' + String(x.getMonth()+1).padStart(2,'0') + '/' + x.getFullYear(); };
  const longDate = (d) => { const x = d ? new Date(d) : null; if (!x || isNaN(x)) return ''; const day = x.getDate(); const sup = [, 'st', 'nd', 'rd'][day % 10 > 3 || (day >= 11 && day <= 13) ? 0 : day % 10] || 'th'; return day + '<sup>' + sup + '</sup> ' + ['January','February','March','April','May','June','July','August','September','October','November','December'][x.getMonth()] + ', ' + x.getFullYear(); };
  const surname       = (emp.last_name || '').trim() || (emp.first_name || '').trim();
  const permAddress   = [emp.permanent_address, emp.permanent_state].filter(Boolean).join(', ') || [emp.address_line1, emp.city, emp.state, emp.pincode].filter(Boolean).join(', ') || '';
  const branchName    = emp.branch || emp.city || emp.location || CONFIG.companyCity;
  const joiningDateNum     = dmy(emp.joining_date);
  const relievingDateNum   = dmy(emp.separation_date || emp.last_working_date);
  const resignationDateNum = dmy(emp.resignation_date || emp.notice_date);
  const relievingDateLong  = longDate(emp.separation_date || emp.last_working_date);
  const todayDateLong      = longDate(new Date());

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="appt-letter">
<style>
  @page { size: A4; margin: 28mm 15mm 18mm 15mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Calibri','Carlito','Arial',sans-serif; color: #000; line-height: 1.5; margin: 0; }
  .date-row { font-size: 13px; margin-bottom: 12px; }
  p { margin: 8px 0; text-align: justify; font-size: 13px; line-height: 1.7; }
  .sig-block { margin-top: 60px; font-size: 14px; }
  .dual-signature { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 30px; }
  .sig-left { text-align: left; }
  .sig-right { text-align: right; }
</style>
</head>
<body data-appt-letter="1">

  <div class="date-row">Date: ${todayDateLong}</div>

  <p style="margin:14px 0 0 0;">To,</p>
  <p style="margin:0;text-align:left;">${mrOrMs} ${fullName}</p>
  <p style="margin:0;text-align:left;">Emp Code: ${emp.employee_code || 'N/A'}</p>
  <p style="margin:0 0 0 0;text-align:left;">${permAddress}</p>

  <p style="text-align:right;font-weight:bold;margin:6px 0;">Without Prejudice</p>

  <p style="text-align:left;margin:14px 0;"><strong>Subject: Relieving Letter</strong></p>

  <p style="text-align:left;">Dear ${mrOrMs} ${surname},</p>

  <p>This letter is to certify that you were employed with M/S <strong>${CONFIG.companyFullName}</strong> as <strong>${designation}</strong> &ndash; <strong>${department}</strong> at our <strong>${branchName}</strong> branch from <strong>${joiningDateNum}</strong> till <strong>${relievingDateNum}</strong>.</p>

  <p>We received your ${(st || 'resignation').toLowerCase()} on <strong>${resignationDateNum}</strong> and you were subsequently relieved from the services of the company with effect from <strong>${relievingDateLong}</strong>.</p>

  <p>Kindly note that there are no pending dues from the company towards you.</p>

  <p>We appreciate your contributions during your tenure with the company and wish you all the very best in your future endeavours.</p>

  <div class="sig-block">
    <p>Yours Sincerely,</p>
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
             s.last_working_date, s.notice_date AS resignation_date
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
             s.last_working_date, s.notice_date AS resignation_date
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
    if (personalEmail.toLowerCase().includes(CONFIG.supportEmail.split('@')[1])) {
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
        <div style="background:${CONFIG.primaryColor};padding:16px 24px;border-radius:8px 8px 0 0;">
          <span style="color:#fff;font-size:16px;font-weight:700;">${CONFIG.clientName}</span>
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
      sender: { name: process.env.EMAIL_FROM_NAME || CONFIG.senderName, email: process.env.EMAIL_FROM || CONFIG.supportEmail },
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
             s.last_working_date, s.notice_date AS resignation_date
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
        if (personalEmail.toLowerCase().includes(CONFIG.supportEmail.split('@')[1])) {
          results.push({ id: emp.id, name: fullName, email: personalEmail, status: 'failed', reason: 'Company email — need personal email' });
          failed++;
          continue;
        }

        try {
          const html      = buildRelievingLetterHTML(emp, sig1, sig2);
          const pdfBuffer = await htmlToPdf(html, browser);

          const coverHtml = `
            <div style="font-family:Arial,sans-serif;font-size:13px;color:#222;line-height:1.7;max-width:600px;">
              <div style="background:${CONFIG.primaryColor};padding:16px 24px;border-radius:8px 8px 0 0;">
                <span style="color:#fff;font-size:16px;font-weight:700;">${CONFIG.clientName}</span>
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
            sender: { name: process.env.EMAIL_FROM_NAME || CONFIG.senderName, email: process.env.EMAIL_FROM || CONFIG.supportEmail },
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
            SELECT e.*, d.name AS department_name, des.title AS designation_title, s.last_working_date, s.notice_date AS resignation_date
            FROM employees e
            LEFT JOIN departments d ON e.department_id = d.id
            LEFT JOIN designations des ON e.designation_id = des.id
            LEFT JOIN separations s ON s.employee_id = e.id AND s.status = 'completed'
            WHERE e.employee_code = $1 AND e.is_active = false
          `, [empCode]);
        } else {
          empResult = await db.query(`
            SELECT e.*, d.name AS department_name, des.title AS designation_title, s.last_working_date, s.notice_date AS resignation_date
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
        if (targetEmail.toLowerCase().includes(CONFIG.supportEmail.split('@')[1])) {
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
              <div style="background:${CONFIG.primaryColor};padding:16px 24px;border-radius:8px 8px 0 0;">
                <span style="color:#fff;font-size:16px;font-weight:700;">${CONFIG.clientName}</span>
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
            sender: { name: process.env.EMAIL_FROM_NAME || CONFIG.senderName, email: process.env.EMAIL_FROM || CONFIG.supportEmail },
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
