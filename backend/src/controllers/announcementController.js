// src/controllers/announcementController.js — UPDATED
// Fix 1: Like & Comment on announcements
// Fix 2: Images stored as base64 in DB (no disk — works on Render after restarts)
const db     = require('../config/db');
const { getEmployeeRegion } = require('../config/regionHelper');
const multer = require('multer');

// ── Multer: memory storage (we convert to base64, no disk write) ──────────────
exports.uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|png|gif|webp)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
}).single('image');

// ── Create Announcement (HR/Admin) ────────────────────────────────────────────
exports.create = async (req, res) => {
  try {
    const { title, content, type = 'general', target_role = 'all',
            department_id, expires_at, link_url, link_label } = req.body;
    if (!title || !content)
      return res.status(400).json({ success: false, message: 'title and content required' });

    // Fix 2: Convert uploaded file to base64 data URI — stored directly in DB
    let image_url = req.body.image_url || null;
    if (req.file) {
      const mime   = req.file.mimetype;
      const b64    = req.file.buffer.toString('base64');
      image_url    = `data:${mime};base64,${b64}`;
    }

    const r = await db.query(
      `INSERT INTO announcements
         (title, content, type, target_role, department_id, posted_by,
          expires_at, image_url, link_url, link_label, is_active)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) RETURNING *`,
      [title, content, type, target_role,
       department_id || null, req.user.id,
       expires_at || null, image_url,
       link_url || null, link_label || null]
    );
    res.status(201).json({ success: true, message: 'Announcement created', data: r.rows[0] });
    // Send email to all relevant employees (async)
    const emailSvc = require('../config/emailService');
    emailSvc.notifyAnnouncement(r.rows[0].id).catch(console.error);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get Announcements (paginated) — includes like_count, i_liked, comment_count
exports.getAll = async (req, res) => {
  try {
    const { type, page = 1, limit = 20 } = req.query;
    const role     = req.user.role;
    const deptId   = req.user.department_id;
    const empId    = req.user.id;
    const offset   = (parseInt(page) - 1) * parseInt(limit);

    let conds = [`(a.expires_at IS NULL OR a.expires_at >= NOW())`, `a.is_active=true`,
                 `(a.target_role='all' OR a.target_role=$1 OR $1 IN ('hr','admin','super_admin'))`,
                 `(a.department_id IS NULL OR a.department_id=$2)`];
    let params = [role, deptId || 0];
    let idx = 3;

    if (type) { conds.push(`a.type=$${idx++}`); params.push(type); }

    const total = await db.query(`SELECT COUNT(*) FROM announcements a WHERE ${conds.join(' AND ')}`, params);
    params.push(parseInt(limit), offset);

    const r = await db.query(
      `SELECT a.*,
              CONCAT(e.first_name,' ',e.last_name) AS posted_by_name,
              e.role                               AS posted_by_role,
              e.designation_id                     AS posted_by_designation_id,
              dsg.title                            AS designation_title,
              dept.name                            AS department_name,
              COALESCE((SELECT COUNT(*) FROM announcement_likes al WHERE al.announcement_id=a.id),0) AS like_count,
              COALESCE(EXISTS(SELECT 1 FROM announcement_likes al WHERE al.announcement_id=a.id AND al.employee_id=${empId}),false) AS i_liked,
              COALESCE((SELECT COUNT(*) FROM announcement_comments ac WHERE ac.announcement_id=a.id),0) AS comment_count
       FROM announcements a
       LEFT JOIN employees e      ON a.posted_by = e.id
       LEFT JOIN designations dsg ON e.designation_id = dsg.id
       LEFT JOIN departments dept ON a.department_id = dept.id
       WHERE ${conds.join(' AND ')}
       ORDER BY a.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      params
    );
    res.json({ success: true, data: r.rows, total: parseInt(total.rows[0].count), page: parseInt(page) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Update Announcement ───────────────────────────────────────────────────────
exports.update = async (req, res) => {
  try {
    const { title, content, type, target_role, department_id,
            expires_at, link_url, link_label, is_active } = req.body;

    let image_url;
    if (req.file) {
      const mime = req.file.mimetype;
      const b64  = req.file.buffer.toString('base64');
      image_url  = `data:${mime};base64,${b64}`;
    }

    const sets = [], params = []; let idx = 1;
    if (title        !== undefined) { sets.push(`title=$${idx++}`);        params.push(title); }
    if (content      !== undefined) { sets.push(`content=$${idx++}`);      params.push(content); }
    if (type         !== undefined) { sets.push(`type=$${idx++}`);         params.push(type); }
    if (target_role  !== undefined) { sets.push(`target_role=$${idx++}`);  params.push(target_role); }
    if (department_id!== undefined) { sets.push(`department_id=$${idx++}`);params.push(department_id || null); }
    if (expires_at   !== undefined) { sets.push(`expires_at=$${idx++}`);   params.push(expires_at || null); }
    if (link_url     !== undefined) { sets.push(`link_url=$${idx++}`);     params.push(link_url || null); }
    if (link_label   !== undefined) { sets.push(`link_label=$${idx++}`);   params.push(link_label || null); }
    if (image_url    !== undefined) { sets.push(`image_url=$${idx++}`);    params.push(image_url); }
    if (is_active    !== undefined) { sets.push(`is_active=$${idx++}`);    params.push(is_active); }
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nothing to update' });

    params.push(parseInt(req.params.id));
    await db.query(`UPDATE announcements SET ${sets.join(',')} WHERE id=$${idx}`, params);
    res.json({ success: true, message: 'Updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Delete Announcement ───────────────────────────────────────────────────────
exports.delete = async (req, res) => {
  try {
    await db.query(`UPDATE announcements SET is_active=false WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Toggle Like on Announcement ───────────────────────────────────────────────
// Fix: replaced check-then-insert with atomic CTE to prevent race condition
// that caused "duplicate key value violates unique constraint" on rapid clicks.
exports.toggleLike = async (req, res) => {
  try {
    const annId = parseInt(req.params.id);
    const empId = req.user.id;

    // Atomic toggle: try delete first; if nothing deleted, insert.
    // This avoids the race condition between SELECT → INSERT.
    const del = await db.query(
      `DELETE FROM announcement_likes WHERE announcement_id=$1 AND employee_id=$2 RETURNING id`,
      [annId, empId]
    );

    let liked;
    if (del.rows.length > 0) {
      // Was liked → now unliked
      liked = false;
    } else {
      // Not liked → insert (ON CONFLICT DO NOTHING handles any remaining edge case)
      await db.query(
        `INSERT INTO announcement_likes(announcement_id, employee_id)
         VALUES($1, $2)
         ON CONFLICT (announcement_id, employee_id) DO NOTHING`,
        [annId, empId]
      );
      liked = true;
    }

    const count = await db.query(
      `SELECT COUNT(*) FROM announcement_likes WHERE announcement_id=$1`, [annId]
    );
    res.json({ success: true, liked, like_count: parseInt(count.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get Comments for an Announcement ─────────────────────────────────────────
exports.getComments = async (req, res) => {
  try {
    const annId = parseInt(req.params.id);
    const r = await db.query(
      `SELECT ac.id, ac.comment, ac.created_at,
              ac.employee_id,
              CONCAT(e.first_name,' ',e.last_name) AS employee_name,
              e.employee_code, dsg.title AS designation
       FROM announcement_comments ac
       JOIN employees e      ON ac.employee_id = e.id
       LEFT JOIN designations dsg ON e.designation_id = dsg.id
       WHERE ac.announcement_id=$1
       ORDER BY ac.created_at ASC`,
      [annId]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Post a Comment ────────────────────────────────────────────────────────────
exports.addComment = async (req, res) => {
  try {
    const annId   = parseInt(req.params.id);
    const empId   = req.user.id;
    const { comment } = req.body;
    if (!comment || !comment.trim())
      return res.status(400).json({ success: false, message: 'Comment text required' });

    const r = await db.query(
      `INSERT INTO announcement_comments(announcement_id, employee_id, comment)
       VALUES($1,$2,$3) RETURNING id, comment, created_at`,
      [annId, empId, comment.trim()]
    );

    const emp = await db.query(
      `SELECT CONCAT(first_name,' ',last_name) AS employee_name, employee_code,
              dsg.title AS designation
       FROM employees e
       LEFT JOIN designations dsg ON e.designation_id=dsg.id
       WHERE e.id=$1`, [empId]
    );

    const result = { ...r.rows[0], employee_id: empId, ...emp.rows[0] };
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Delete a Comment (own comment, or HR/Admin) ───────────────────────────────
exports.deleteComment = async (req, res) => {
  try {
    const commentId = parseInt(req.params.commentId);
    const empId     = req.user.id;
    const role      = req.user.role;

    const c = await db.query(`SELECT employee_id FROM announcement_comments WHERE id=$1`, [commentId]);
    if (!c.rows.length) return res.status(404).json({ success: false, message: 'Comment not found' });

    const isOwner  = c.rows[0].employee_id === empId;
    const isAdmin  = ['hr','admin','super_admin','accounts'].includes(role);
    if (!isOwner && !isAdmin)
      return res.status(403).json({ success: false, message: 'Not allowed' });

    await db.query(`DELETE FROM announcement_comments WHERE id=$1`, [commentId]);
    res.json({ success: true, message: 'Comment deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Dashboard Feed ─────────────────────────────────────────────────────────────
exports.getFeed = async (req, res) => {
  try {
    const today    = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const empId    = req.user.id;

    const empRes = await db.query(`SELECT department_id FROM employees WHERE id=$1`, [req.user.id]);
    const deptId = empRes.rows[0]?.department_id || null;

    // Announcements (latest 10) with like/comment counts
    const annResult = await db.query(
      `SELECT a.*,
              CONCAT(e.first_name,' ',e.last_name) AS posted_by_name,
              e.role                               AS posted_by_role,
              e.designation_id                     AS posted_by_designation_id,
              dsg.title                            AS designation_title,
              COALESCE((SELECT COUNT(*) FROM announcement_likes al WHERE al.announcement_id=a.id),0) AS like_count,
              COALESCE(EXISTS(SELECT 1 FROM announcement_likes al WHERE al.announcement_id=a.id AND al.employee_id=$1),false) AS i_liked,
              COALESCE((SELECT COUNT(*) FROM announcement_comments ac WHERE ac.announcement_id=a.id),0) AS comment_count
       FROM announcements a
       LEFT JOIN employees e      ON a.posted_by = e.id
       LEFT JOIN designations dsg ON e.designation_id = dsg.id
       WHERE a.is_active=true
         AND (a.expires_at IS NULL OR a.expires_at >= NOW())
         AND a.type NOT IN ('thought','gk')
       ORDER BY a.created_at DESC LIMIT 10`,
      [empId]
    );

    // Birthdays — upcoming 7 days (handles month boundary correctly)
    // Generate series of next 7 dates and match birthdays by MM-DD
    const bdResult = await db.query(
      `SELECT id, first_name, last_name, employee_code, date_of_birth,
              department_id, birth_day
       FROM (
         SELECT DISTINCT ON (e.id)
                e.id, e.first_name, e.last_name, e.employee_code, e.date_of_birth,
                e.department_id,
                TO_CHAR(e.date_of_birth,'DD-Mon') AS birth_day,
                (TO_CHAR(e.date_of_birth,'MM-DD') = TO_CHAR(CURRENT_DATE,'MM-DD')) AS is_today,
                MIN(gs.offset_days) AS offset_days
         FROM employees e
         JOIN generate_series(0, 7) AS gs(offset_days)
           ON TO_CHAR(e.date_of_birth, 'MM-DD') = TO_CHAR(CURRENT_DATE + (gs.offset_days || ' days')::interval, 'MM-DD')
         WHERE e.is_active=true
           AND e.date_of_birth IS NOT NULL
         GROUP BY e.id, e.first_name, e.last_name, e.employee_code, e.date_of_birth, e.department_id
       ) sub
       ORDER BY is_today DESC, offset_days ASC`
    );

    // Upcoming holidays (next 30 days) — filtered by employee's region
    // Use city/state if available, otherwise fall back to showing all/national holidays
    const empLocQ = await db.query(
      `SELECT e.city, e.state, e.address_line1,
              d.name AS dept_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.id=$1`, [req.user.id]
    );
    const empLoc = empLocQ.rows[0] || {};
    // Try city/state first, then address, then dept name for region detection
    const locationHint = [empLoc.city, empLoc.state, empLoc.address_line1, empLoc.dept_name]
      .filter(Boolean).join(' ');
    // Default to 'north' — most employees are in North India (UP/Delhi zone)
    // If city/state/address is filled, use that for accurate region detection
    const empRegion = locationHint ? getEmployeeRegion(locationHint, '') : 'north';
    const holResult = await db.query(
      `SELECT name, TO_CHAR(date,'YYYY-MM-DD') AS date, type,
              date - CURRENT_DATE AS days_away
       FROM holidays
       WHERE date >= CURRENT_DATE AND date <= CURRENT_DATE + INTERVAL '30 days'
         AND (region = 'all' OR region = $1)
       ORDER BY date ASC LIMIT 5`,
      [empRegion]
    );

    // Thought of the day
    const thoughtResult = await db.query(
      `SELECT * FROM announcements
       WHERE type='thought' AND is_active=true
         AND (expires_at IS NULL OR expires_at >= $1)
       ORDER BY ABS(EXTRACT(DOY FROM CURRENT_DATE) - COALESCE(thought_day_number, 0)) ASC,
                created_at DESC LIMIT 1`,
      [todayStr]
    ).catch(() => ({ rows: [] }));

    let thought = thoughtResult.rows[0] || null;
    if (!thought) {
      const doy = Math.ceil((today - new Date(today.getFullYear(), 0, 0)) / 86400000);
      const tr = await db.query(
        `SELECT * FROM thought_of_day_schedules WHERE day_number=$1 AND year=$2`,
        [doy, today.getFullYear()]
      ).catch(() => ({ rows: [] }));
      thought = tr.rows[0] || { title: 'Thought of the Day', content: 'Believe in yourself and keep moving forward.' };
    }

    // Monthly GK question
    const currentMonth = today.getMonth() + 1;
    const currentYear  = today.getFullYear();
    const gkResult = await db.query(
      `SELECT gk.*,
              ur.answer AS my_answer,
              ur.is_correct AS my_is_correct
       FROM gk_questions gk
       LEFT JOIN gk_responses ur ON gk.id=ur.question_id AND ur.employee_id=$1
       WHERE gk.month=$2 AND gk.year=$3 AND gk.is_active=true
       LIMIT 1`,
      [req.user.id, currentMonth, currentYear]
    ).catch(() => ({ rows: [] }));

    res.json({
      success: true,
      data: {
        announcements:    annResult.rows,
        birthdays:        bdResult.rows,
        upcoming_holidays: holResult.rows,
        thought_of_day:   thought,
        gk_question:      gkResult.rows[0] || null,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Submit GK Answer ──────────────────────────────────────────────────────────
exports.submitGKAnswer = async (req, res) => {
  try {
    const { question_id, answer } = req.body;
    if (!question_id || !answer)
      return res.status(400).json({ success: false, message: 'question_id and answer required' });

    const empId = req.user.id;

    const existing = await db.query(
      `SELECT id FROM gk_responses WHERE question_id=$1 AND employee_id=$2`,
      [question_id, empId]
    );
    if (existing.rows.length)
      return res.status(400).json({ success: false, message: 'You have already answered this question' });

    const q = await db.query(`SELECT correct_answer FROM gk_questions WHERE id=$1`, [question_id]);
    if (!q.rows.length)
      return res.status(404).json({ success: false, message: 'Question not found' });

    const is_correct = q.rows[0].correct_answer.toUpperCase() === answer.toUpperCase();

    await db.query(
      `INSERT INTO gk_responses(question_id, employee_id, answer, is_correct, answered_at)
       VALUES($1,$2,$3,$4,NOW())`,
      [question_id, empId, answer.toUpperCase(), is_correct]
    );

    res.json({
      success: true,
      message: is_correct ? '🎉 Correct answer!' : '❌ Wrong answer. Better luck next time!',
      data: { is_correct, correct_answer: is_correct ? answer : null }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Get GK Leaderboard ────────────────────────────────────────────────────────
exports.getGKLeaderboard = async (req, res) => {
  try {
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year  = parseInt(req.query.year)  || new Date().getFullYear();

    const r = await db.query(
      `SELECT e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name,
              d.name AS department, gr.answer, gr.is_correct,
              gr.answered_at,
              ROW_NUMBER() OVER (ORDER BY gr.answered_at ASC) AS response_rank
       FROM gk_responses gr
       JOIN gk_questions gq ON gr.question_id=gq.id
       JOIN employees e ON gr.employee_id=e.id
       LEFT JOIN departments d ON e.department_id=d.id
       WHERE gq.month=$1 AND gq.year=$2 AND gr.is_correct=true
       ORDER BY gr.answered_at ASC`,
      [month, year]
    );
    res.json({ success: true, data: r.rows, month, year });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Bulk import thoughts/GK from Excel ───────────────────────────────────────
exports.importThoughtsGK = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    if (!req.file)
      return res.status(400).json({ success: false, message: 'Excel file required' });

    const XLSX = require('xlsx');
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });

    let thoughtsImported = 0, gkImported = 0;

    const thoughtsSheet = wb.Sheets['365 Thoughts'];
    if (thoughtsSheet) {
      const rows = XLSX.utils.sheet_to_json(thoughtsSheet, { header: 1, defval: '' });
      for (let i = 2; i < rows.length; i++) {
        const [num, dateStr, , , thought, author] = rows[i];
        if (!thought || !dateStr) continue;
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) continue;
        const doy = Math.ceil((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
        await client.query(
          `INSERT INTO thought_of_day_schedules(day_number, year, thought, author, display_date)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(day_number, year) DO UPDATE SET thought=$3, author=$4`,
          [doy, d.getFullYear(), thought, author || '', d.toISOString().split('T')[0]]
        );
        thoughtsImported++;
      }
    }

    const gkSheet = wb.Sheets['Monthly GK Questions'];
    if (gkSheet) {
      const rows = XLSX.utils.sheet_to_json(gkSheet, { header: 1, defval: '' });
      const months = ['january','february','march','april','may','june',
                      'july','august','september','october','november','december'];
      for (let i = 2; i < rows.length; i++) {
        const [month_name, question, opt_a, opt_b, opt_c, opt_d, correct, about] = rows[i];
        if (!month_name || !question) continue;
        const monthNum = months.indexOf(month_name.toLowerCase()) + 1;
        if (!monthNum) continue;
        await client.query(
          `INSERT INTO gk_questions(month, year, question, option_a, option_b, option_c, option_d, correct_answer, about, is_active)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
           ON CONFLICT(month, year) DO UPDATE SET
             question=$3, option_a=$4, option_b=$5, option_c=$6, option_d=$7,
             correct_answer=$8, about=$9`,
          [monthNum, new Date().getFullYear(), question, opt_a, opt_b, opt_c, opt_d, correct, about || '']
        );
        gkImported++;
      }
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      message: `Imported ${thoughtsImported} thoughts and ${gkImported} GK questions`,
      data: { thoughts: thoughtsImported, gk: gkImported }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};
