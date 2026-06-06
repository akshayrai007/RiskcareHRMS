const CONFIG = require('../Main_file');
// src/controllers/gkController.js
// Daily GK Questions + Thought of the Day
// Scoring: +1 correct, -0.33 wrong, 0 skipped
const db     = require('../config/db');
const XLSX   = require('xlsx');
const multer = require('multer');

exports.uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(xlsx|xls)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only Excel files allowed'));
  }
}).single('file');

// ══════════════════════════════════════════════════
//  TODAY'S QUESTION   GET /gk/question?date=YYYY-MM-DD
// ══════════════════════════════════════════════════
exports.getQuestion = async (req, res) => {
  try {
    const empId = req.user.id;
    // Use IST date
    const istDate = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone || 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    const date = req.query.date || istDate;

    // ── STEP 1: Check if employee already has an assigned question for today ──
    const assigned = await db.query(
      `SELECT q.*,
              gr.answer      AS my_answer,
              gr.is_correct  AS my_is_correct,
              gr.answered_at,
              gr.id          AS response_id
       FROM gk_employee_assignments ea
       JOIN gk_daily_questions q  ON q.id = ea.question_id
       LEFT JOIN gk_daily_responses gr ON gr.question_id = q.id AND gr.employee_id = $1
       WHERE ea.employee_id = $1 AND ea.assigned_date = $2 AND q.is_active = true
       LIMIT 1`,
      [empId, date]
    );

    if (assigned.rows.length) {
      const q = { ...assigned.rows[0] };
      if (!q.my_answer) delete q.correct_answer;
      return res.json({ success: true, data: q });
    }

    // ── STEP 2: Assign a new RANDOM question not yet answered by this employee ──
    const randomQ = await db.query(
      `SELECT q.* FROM gk_daily_questions q
       WHERE q.is_active = true
         AND q.id NOT IN (
           SELECT question_id FROM gk_daily_responses WHERE employee_id = $1
         )
         AND q.id NOT IN (
           SELECT question_id FROM gk_employee_assignments WHERE employee_id = $1
         )
       ORDER BY RANDOM()
       LIMIT 1`,
      [empId]
    );

    if (!randomQ.rows.length) {
      // All questions answered — fall back to random unanswered today
      return res.json({ success: true, data: null, message: 'All questions completed!' });
    }

    // ── STEP 3: Save assignment so same question is served all day ────────────
    await db.query(
      `INSERT INTO gk_employee_assignments (employee_id, question_id, assigned_date)
       VALUES ($1, $2, $3)
       ON CONFLICT (employee_id, assigned_date) DO NOTHING`,
      [empId, randomQ.rows[0].id, date]
    );

    const q = { ...randomQ.rows[0] };
    delete q.correct_answer; // hide until answered
    res.json({ success: true, data: q });
  } catch (err) {
    console.error(err);
    // Fallback: try old method if new table doesn't exist yet
    try {
      const istDate = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone || 'Asia/Kolkata',
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
      const date = req.query.date || istDate;
      const r = await db.query(
        `SELECT q.*,
                gr.answer AS my_answer, gr.is_correct AS my_is_correct, gr.answered_at
         FROM gk_daily_questions q
         LEFT JOIN gk_daily_responses gr ON gr.question_id = q.id AND gr.employee_id = $1
         WHERE q.question_date = $2 AND q.is_active = true
         LIMIT 1`,
        [req.user.id, date]
      );
      if (!r.rows.length) return res.json({ success: true, data: null });
      const q = { ...r.rows[0] };
      if (!q.my_answer) delete q.correct_answer;
      res.json({ success: true, data: q });
    } catch(e2) {
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
};

// ══════════════════════════════════════════════════
//  SUBMIT ANSWER   POST /gk/answer
// ══════════════════════════════════════════════════
exports.submitAnswer = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const empId = req.user.id;
    const { question_id, answer, skip_reason } = req.body;

    if (!question_id)
      return res.status(400).json({ success: false, message: 'question_id required' });

    const exists = await client.query(
      `SELECT id FROM gk_daily_responses WHERE question_id=$1 AND employee_id=$2`,
      [question_id, empId]
    );
    if (exists.rows.length)
      return res.status(400).json({ success: false, message: 'Already answered today' });

    const q = await client.query(
      `SELECT correct_answer, about FROM gk_daily_questions WHERE id=$1 AND is_active=true`,
      [question_id]
    );
    if (!q.rows.length)
      return res.status(404).json({ success: false, message: 'Question not found' });

    // Normalize answer: treat any skip variant (skip, skip_timeout, skip_hidden, empty) as 'skip'
    const isSkip       = !answer || answer === 'skip' || answer.startsWith('skip');
    const finalAnswer  = isSkip ? 'skip' : answer.toUpperCase();
    const is_correct   = !isSkip && q.rows[0].correct_answer.toUpperCase() === finalAnswer;
    const score_change = isSkip ? 0 : is_correct ? 1 : -0.33;

    // Log skip reason for analytics (timeout = timer ran out, background = app minimised)
    if (isSkip && skip_reason) {
      console.log(`[GK] Employee ${empId} skipped Q${question_id} — reason: ${skip_reason}`);
    }

    await client.query(
      `INSERT INTO gk_daily_responses
         (question_id, employee_id, answer, is_correct, score_change, answered_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [question_id, empId, finalAnswer, is_correct, score_change]
    );

    await client.query('COMMIT');

    // ── Streak is calculated but no streak announcements posted ──────────────
    // Only monthly Top 5 winners are announced (at month end for 24 hours)
    res.json({
      success: true,
      data: {
        is_correct,
        correct_answer: q.rows[0].correct_answer,
        score_change,
        about: q.rows[0].about || null
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally { client.release(); }
};

// ══════════════════════════════════════════════════
//  MY STATS   GET /gk/my-stats
// ══════════════════════════════════════════════════
exports.getMyStats = async (req, res) => {
  try {
    const empId = req.user.id;
    const year  = parseInt(req.query.year) || new Date().getFullYear();

    const r = await db.query(
      `SELECT
         COALESCE(SUM(gr.score_change), 0)                                      AS total_score,
         COUNT(*) FILTER (WHERE gr.is_correct = true)                           AS correct,
         COUNT(*) FILTER (WHERE gr.is_correct = false AND gr.answer != 'skip')  AS wrong,
         COUNT(*) FILTER (WHERE gr.answer = 'skip')                             AS skipped,
         COUNT(*)                                                                AS attempted
       FROM gk_daily_responses gr
       JOIN gk_daily_questions gq ON gr.question_id = gq.id
       WHERE gr.employee_id = $1
         AND EXTRACT(YEAR FROM gq.question_date) = $2`,
      [empId, year]
    );

    // Streak: consecutive correct answers by question order (not calendar date)
    const streakR = await db.query(
      `WITH ranked AS (
         SELECT
           is_correct,
           ROW_NUMBER() OVER (ORDER BY answered_at DESC) AS rn
         FROM gk_daily_responses
         WHERE employee_id = $1 AND answer != 'skip'
       ),
       first_wrong AS (
         SELECT MIN(rn) AS wrong_rn FROM ranked WHERE is_correct = false
       )
       SELECT COUNT(*) AS streak
       FROM ranked, first_wrong
       WHERE ranked.is_correct = true
         AND ranked.rn < COALESCE(first_wrong.wrong_rn, 999999)`,
      [empId]
    );

    res.json({
      success: true,
      data: {
        ...r.rows[0],
        streak: parseInt(streakR.rows[0]?.streak) || 0
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ══════════════════════════════════════════════════
//  THOUGHT OF THE DAY   GET /gk/thought?date=YYYY-MM-DD
// ══════════════════════════════════════════════════
exports.getThought = async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const r = await db.query(
      `SELECT * FROM gk_daily_thoughts WHERE thought_date = $1 LIMIT 1`,
      [date]
    );
    res.json({ success: true, data: r.rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ══════════════════════════════════════════════════
//  LEADERBOARD   GET /gk/leaderboard?period=year|month|week&limit=100
// ══════════════════════════════════════════════════
exports.getLeaderboard = async (req, res) => {
  try {
    const empId  = req.user.id;
    const period = req.query.period || 'year';
    const limit  = Math.min(parseInt(req.query.limit) || 50, 500);
    const year   = parseInt(req.query.year) || new Date().getFullYear();

    let dateFilter = '';
    if (period === 'week') {
      dateFilter = `AND gr.answered_at AT TIME ZONE CONFIG.timezone || 'Asia/Kolkata' >= DATE_TRUNC('week', NOW() AT TIME ZONE CONFIG.timezone || 'Asia/Kolkata')`;
    } else if (period === 'month') {
      dateFilter = `AND gr.answered_at AT TIME ZONE CONFIG.timezone || 'Asia/Kolkata' >= DATE_TRUNC('month', NOW() AT TIME ZONE CONFIG.timezone || 'Asia/Kolkata')`;
    } else if (period === 'all') {
      dateFilter = '';
    } else {
      dateFilter = `AND EXTRACT(YEAR FROM gr.answered_at AT TIME ZONE CONFIG.timezone || 'Asia/Kolkata') = ${year}`;
    }

    // ── Step 1: Compute streak for ALL employees in one query ──
    // Streak = number of consecutive correct answers from the most recent,
    // stopping the moment we hit a wrong answer. Dates don't matter —
    // only question order matters (gaps occur when no question was assigned).
    const streakRes = await db.query(
      `WITH ranked AS (
         SELECT
           employee_id,
           is_correct,
           ROW_NUMBER() OVER (PARTITION BY employee_id ORDER BY answered_at DESC) AS rn
         FROM gk_daily_responses
         WHERE answer != 'skip'
       ),
       first_wrong AS (
         SELECT employee_id, MIN(rn) AS wrong_rn
         FROM ranked
         WHERE is_correct = false
         GROUP BY employee_id
       )
       SELECT
         r.employee_id,
         COUNT(*) AS streak
       FROM ranked r
       LEFT JOIN first_wrong fw ON fw.employee_id = r.employee_id
       WHERE r.is_correct = true
         AND r.rn < COALESCE(fw.wrong_rn, 999999)
       GROUP BY r.employee_id`
    );

    // Build a map: employee_id -> streak
    const streakMap = {};
    for (const row of streakRes.rows) {
      streakMap[row.employee_id] = parseInt(row.streak) || 0;
    }

    // ── Step 2: Main leaderboard query (scores, counts) ──
    const r = await db.query(
      `SELECT
         e.id, e.first_name, e.last_name, e.employee_code,
         d.name AS department_name,
         COALESCE(SUM(gr.score_change), 0)                                         AS total_score,
         COUNT(gr.id) FILTER (WHERE gr.is_correct = true)                          AS correct,
         COUNT(gr.id) FILTER (WHERE gr.is_correct = false AND gr.answer != 'skip') AS wrong,
         COUNT(gr.id) FILTER (WHERE gr.answer = 'skip')                            AS skipped,
         COUNT(gr.id)                                                               AS attempted,
         (e.id = $1)                                                                AS is_me
       FROM employees e
       JOIN gk_daily_responses gr ON gr.employee_id = e.id
       LEFT JOIN departments d ON e.department_id = d.id
       WHERE e.is_active = true ${dateFilter}
       GROUP BY e.id, e.first_name, e.last_name, e.employee_code, d.name
       HAVING COUNT(gr.id) > 0
       ORDER BY total_score DESC, correct DESC
       LIMIT $2`,
      [empId, limit]
    );

    // ── Step 3: Attach streak from map ──
    const data = r.rows.map(row => ({
      ...row,
      streak: streakMap[row.id] || 0
    }));

    res.json({ success: true, data, period });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ══════════════════════════════════════════════════
//  ADMIN: LIST QUESTIONS   GET /gk/questions
// ══════════════════════════════════════════════════
exports.getQuestions = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 400, 1000);
    const year  = parseInt(req.query.year) || new Date().getFullYear();
    const r = await db.query(
      `SELECT q.*,
              (SELECT COUNT(*) FROM gk_daily_responses WHERE question_id=q.id) AS response_count
       FROM gk_daily_questions q
       WHERE EXTRACT(YEAR FROM q.question_date) = $1
       ORDER BY q.question_date ASC LIMIT $2`,
      [year, limit]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ADMIN: ADD QUESTION   POST /gk/questions
exports.createQuestion = async (req, res) => {
  try {
    const { question_date, question, option_a, option_b, option_c, option_d, correct_answer, about } = req.body;
    if (!question_date || !question || !option_a || !option_b || !option_c || !option_d || !correct_answer)
      return res.status(400).json({ success: false, message: 'All fields except about are required' });
    if (!['A','B','C','D'].includes(correct_answer.toUpperCase()))
      return res.status(400).json({ success: false, message: 'correct_answer must be A, B, C or D' });

    const r = await db.query(
      `INSERT INTO gk_daily_questions
         (question_date, question, option_a, option_b, option_c, option_d, correct_answer, about, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9) RETURNING *`,
      [question_date, question.trim(), option_a.trim(), option_b.trim(),
       option_c.trim(), option_d.trim(), correct_answer.toUpperCase(),
       about?.trim()||null, req.user.id]
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505')
      return res.status(400).json({ success: false, message: 'A question already exists for this date' });
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ADMIN: UPDATE QUESTION   PUT /gk/questions/:id
exports.updateQuestion = async (req, res) => {
  try {
    const fields = ['question_date','question','option_a','option_b','option_c','option_d','correct_answer','about','is_active'];
    const sets = [], params = []; let idx = 1;
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        sets.push(`${f}=$${idx++}`);
        params.push(f === 'correct_answer' ? req.body[f].toUpperCase() : req.body[f]);
      }
    }
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nothing to update' });
    params.push(parseInt(req.params.id));
    await db.query(`UPDATE gk_daily_questions SET ${sets.join(',')} WHERE id=$${idx}`, params);
    res.json({ success: true, message: 'Updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ADMIN: DELETE QUESTION   DELETE /gk/questions/:id
exports.deleteQuestion = async (req, res) => {
  try {
    await db.query(`DELETE FROM gk_daily_questions WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ══════════════════════════════════════════════════
//  ADMIN: LIST THOUGHTS   GET /gk/thoughts
// ══════════════════════════════════════════════════
exports.getThoughts = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 400, 1000);
    const year  = parseInt(req.query.year) || new Date().getFullYear();
    const r = await db.query(
      `SELECT * FROM gk_daily_thoughts
       WHERE EXTRACT(YEAR FROM thought_date) = $1
       ORDER BY thought_date ASC LIMIT $2`,
      [year, limit]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ADMIN: ADD THOUGHT   POST /gk/thoughts
exports.createThought = async (req, res) => {
  try {
    const { thought_date, thought, author } = req.body;
    if (!thought_date || !thought)
      return res.status(400).json({ success: false, message: 'thought_date and thought required' });
    const r = await db.query(
      `INSERT INTO gk_daily_thoughts (thought_date, thought, author, created_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (thought_date) DO UPDATE SET thought=$2, author=$3
       RETURNING *`,
      [thought_date, thought.trim(), author?.trim()||null, req.user.id]
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ADMIN: DELETE THOUGHT   DELETE /gk/thoughts/:id
exports.deleteThought = async (req, res) => {
  try {
    await db.query(`DELETE FROM gk_daily_thoughts WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ══════════════════════════════════════════════════
//  ADMIN: RESPONSES   GET /gk/responses
// ══════════════════════════════════════════════════
exports.getResponses = async (req, res) => {
  try {
    const { from_date, to_date, employee_id } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 1000, 5000);
    let conds = [], params = [], idx = 1;
    if (from_date)   { conds.push(`gq.question_date >= $${idx++}`); params.push(from_date); }
    if (to_date)     { conds.push(`gq.question_date <= $${idx++}`); params.push(to_date); }
    if (employee_id) { conds.push(`gr.employee_id = $${idx++}`);    params.push(employee_id); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await db.query(
      `SELECT gr.*, gq.question, gq.question_date, gq.correct_answer,
              CONCAT(e.first_name,' ',e.last_name) AS employee_name,
              e.employee_code, d.name AS department_name
       FROM gk_daily_responses gr
       JOIN gk_daily_questions gq ON gr.question_id = gq.id
       JOIN employees e ON gr.employee_id = e.id
       LEFT JOIN departments d ON e.department_id = d.id
       ${where}
       ORDER BY gq.question_date DESC, e.first_name
       LIMIT $${idx}`,
      [...params, limit]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ══════════════════════════════════════════════════
//  IMPORT QUESTIONS FROM EXCEL   POST /gk/questions/import
//  Sheet: "Daily GK Questions"
//  Columns: Date(A) · Day(B) · Question(C) · Option A(D) · Option B(E) · Option C(F) · Option D(G) · Correct Answer(H)
// ══════════════════════════════════════════════════
exports.importQuestions = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    if (!req.file) return res.status(400).json({ success: false, message: 'Excel file required' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });

    // Look for GK sheet by name, fall back to first sheet
    let ws = null;
    for (const name of wb.SheetNames) {
      if (/gk|question|daily/i.test(name)) { ws = wb.Sheets[name]; break; }
    }
    if (!ws) ws = wb.Sheets[wb.SheetNames[0]];

    const { imported, skipped, errors } = await _parseAndInsertGK(ws, client, req.user.id);

    await client.query('COMMIT');
    res.json({ success: true, message: `${imported} questions imported, ${skipped} skipped`,
      data: { imported, skipped, errors: errors.slice(0, 20) } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally { client.release(); }
};

// ══════════════════════════════════════════════════
//  IMPORT THOUGHTS FROM EXCEL   POST /gk/thoughts/import
//  Sheet: "365 Thoughts"
//  Columns: Date(A) · Day(B) · Thought of the Day(C) · Author/Source(D)
// ══════════════════════════════════════════════════
exports.importThoughts = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    if (!req.file) return res.status(400).json({ success: false, message: 'Excel file required' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });

    // Look for "365 Thoughts" sheet, fall back to first sheet
    let ws = null;
    for (const name of wb.SheetNames) {
      if (/thought|365/i.test(name)) { ws = wb.Sheets[name]; break; }
    }
    if (!ws) ws = wb.Sheets[wb.SheetNames[0]];

    const { imported, skipped } = await _parseAndInsertThoughts(ws, client, req.user.id);

    await client.query('COMMIT');
    res.json({ success: true, message: `${imported} thoughts imported, ${skipped} skipped`,
      data: { imported, skipped } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally { client.release(); }
};

// ══════════════════════════════════════════════════
//  IMPORT BOTH (thoughts + GK) FROM ONE FILE   POST /gk/import
//  Expects the standard 2-sheet Excel:
//    Sheet 1 "365 Thoughts"       → Date(A) Day(B) Thought(C) Author(D)
//    Sheet 2 "Daily GK Questions" → Date(A) Day(B) Question(C) OptA(D) OptB(E) OptC(F) OptD(G) Correct(H)
// ══════════════════════════════════════════════════
exports.importBoth = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    if (!req.file) return res.status(400).json({ success: false, message: 'Excel file required' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });

    // ── Find Thoughts sheet ────────────────────────────────────────────────
    let thoughtsWs = null;
    for (const name of wb.SheetNames) {
      if (/thought|365/i.test(name)) { thoughtsWs = wb.Sheets[name]; break; }
    }

    // ── Find GK Questions sheet ────────────────────────────────────────────
    let gkWs = null;
    for (const name of wb.SheetNames) {
      if (/gk|question|daily/i.test(name)) { gkWs = wb.Sheets[name]; break; }
    }

    // If only one sheet exists, try to detect which type it is by its header
    if (!thoughtsWs && !gkWs && wb.SheetNames.length > 0) {
      const fallback = wb.Sheets[wb.SheetNames[0]];
      const firstRow = XLSX.utils.sheet_to_json(fallback, { header: 1, defval: '', raw: false })[0] || [];
      const headers  = firstRow.map(c => String(c).toLowerCase());
      if (headers.some(h => h.includes('question') || h.includes('option'))) gkWs = fallback;
      else thoughtsWs = fallback;
    }

    let thoughts = { imported: 0, skipped: 0 };
    let gk       = { imported: 0, skipped: 0, errors: [] };

    if (thoughtsWs) {
      thoughts = await _parseAndInsertThoughts(thoughtsWs, client, req.user.id);
    }
    if (gkWs) {
      gk = await _parseAndInsertGK(gkWs, client, req.user.id);
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      message: `Imported ${thoughts.imported} thoughts and ${gk.imported} GK questions`,
      data: {
        thoughts: { imported: thoughts.imported, skipped: thoughts.skipped },
        questions: { imported: gk.imported, skipped: gk.skipped, errors: (gk.errors || []).slice(0, 20) },
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally { client.release(); }
};

// ──────────────────────────────────────────────────
//  INTERNAL HELPER: Parse & insert GK questions sheet
//  Columns: Date(A=0) Day(B=1) Question(C=2) OptA(D=3) OptB(E=4) OptC(F=5) OptD(G=6) Correct(H=7)
// ──────────────────────────────────────────────────
async function _parseAndInsertGK(ws, client, userId) {
  // raw:true preserves Excel serial dates as numbers
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  let imported = 0, skipped = 0, errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row      = rows[i];
    const rawDate  = row[0];
    const question = String(row[2] || '').trim();
    const opt_a    = String(row[3] || '').trim();
    const opt_b    = String(row[4] || '').trim();
    const opt_c    = String(row[5] || '').trim();
    const opt_d    = String(row[6] || '').trim();
    const correct  = String(row[7] || '').trim().toUpperCase();

    // Skip blank rows and header rows
    if (!rawDate && !question) continue;
    if (!question) continue;
    // Skip header row (col A is text like "Date")
    if (typeof rawDate === 'string' && /^(date|day|#)/i.test(rawDate.trim())) continue;

    if (!rawDate) { errors.push(`Row ${i+1}: missing date`); skipped++; continue; }
    if (!['A','B','C','D'].includes(correct)) {
      errors.push(`Row ${i+1}: invalid correct_answer "${correct}"`); skipped++; continue;
    }
    if (!opt_a || !opt_b || !opt_c || !opt_d) {
      errors.push(`Row ${i+1}: missing options`); skipped++; continue;
    }

    const dateStr = parseExcelDate(rawDate);
    if (!dateStr) { errors.push(`Row ${i+1}: invalid date "${rawDate}"`); skipped++; continue; }

    try {
      await client.query(
        `INSERT INTO gk_daily_questions
           (question_date, question, option_a, option_b, option_c, option_d, correct_answer, is_active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)
         ON CONFLICT (question_date) DO UPDATE
           SET question=$2, option_a=$3, option_b=$4, option_c=$5, option_d=$6, correct_answer=$7`,
        [dateStr, question, opt_a, opt_b, opt_c, opt_d, correct, userId]
      );
      imported++;
    } catch (e) { errors.push(`Row ${i+1}: ${e.message}`); skipped++; }
  }
  return { imported, skipped, errors };
}

// ──────────────────────────────────────────────────
//  INTERNAL HELPER: Parse & insert Thoughts sheet
//  Actual Excel columns: Date(A=0) Day(B=1) Thought of the Day(C=2) Author/Source(D=3)
// ──────────────────────────────────────────────────
async function _parseAndInsertThoughts(ws, client, userId) {
  // raw:true preserves Excel serial dates as numbers
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  let imported = 0, skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row     = rows[i];
    const rawDate = row[0];  // col A = Date
    const thought = String(row[2] || '').trim();  // col C = Thought of the Day
    const author  = String(row[3] || '').trim() || null;  // col D = Author/Source

    // Skip blank rows
    if (!rawDate && !thought) continue;
    if (!thought) continue;
    // Skip header row (col A is text like "Date")
    if (typeof rawDate === 'string' && /^(date|day|#)/i.test(rawDate.trim())) continue;

    if (!rawDate) { skipped++; continue; }

    const dateStr = parseExcelDate(rawDate);
    if (!dateStr) { skipped++; continue; }

    try {
      await client.query(
        `INSERT INTO gk_daily_thoughts (thought_date, thought, author, created_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (thought_date) DO UPDATE SET thought=$2, author=$3`,
        [dateStr, thought, author, userId]
      );
      imported++;
    } catch (e) { skipped++; }
  }
  return { imported, skipped };
}

// ══════════════════════════════════════════════════
//  EXPORT: SCORE SHEET   GET /gk/export/scores
// ══════════════════════════════════════════════════
exports.exportScores = async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const r = await db.query(
      `SELECT e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name,
              d.name AS department, des.title AS designation,
              COALESCE(SUM(gr.score_change), 0)                                     AS total_score,
              COUNT(*) FILTER (WHERE gr.is_correct = true)                          AS correct,
              COUNT(*) FILTER (WHERE gr.is_correct = false AND gr.answer != 'skip') AS wrong,
              COUNT(*) FILTER (WHERE gr.answer = 'skip')                            AS skipped,
              COUNT(*)                                                               AS attempted
       FROM employees e
       LEFT JOIN gk_daily_responses gr ON gr.employee_id = e.id
       LEFT JOIN gk_daily_questions gq ON gr.question_id = gq.id
                                      AND EXTRACT(YEAR FROM gq.question_date) = $1
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       WHERE e.is_active = true
       GROUP BY e.id, e.employee_code, e.first_name, e.last_name, d.name, des.title
       ORDER BY total_score DESC, correct DESC`,
      [year]
    );

    const wb = XLSX.utils.book_new();
    const wsData = [
      [`HRMS — GK Score Sheet ${year}`], [],
      ['#','Emp Code','Name','Department','Designation','Total Score','Correct','Wrong','Skipped','Attempted'],
      ...r.rows.map((row,i)=>[
        i+1, row.employee_code, row.name, row.department||'—', row.designation||'—',
        parseFloat(row.total_score).toFixed(2), row.correct, row.wrong, row.skipped, row.attempted
      ])
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [4,12,24,18,18,12,10,10,10,12].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, `GK Scores ${year}`);
    const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename=HRMS_GK_Scores_${year}.xlsx`);
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ══════════════════════════════════════════════════
//  EXPORT: YEARLY LEADERBOARD   GET /gk/export/yearly
// ══════════════════════════════════════════════════
exports.exportYearly = async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const r = await db.query(
      `SELECT ROW_NUMBER() OVER (ORDER BY SUM(gr.score_change) DESC, COUNT(*) FILTER(WHERE gr.is_correct) DESC) AS rank,
              e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name, d.name AS department,
              COALESCE(SUM(gr.score_change), 0)                                     AS total_score,
              COUNT(*) FILTER (WHERE gr.is_correct = true)                          AS correct,
              COUNT(*) FILTER (WHERE gr.is_correct = false AND gr.answer != 'skip') AS wrong,
              COUNT(*) FILTER (WHERE gr.answer = 'skip')                            AS skipped,
              COUNT(*)                                                               AS attempted
       FROM employees e
       LEFT JOIN gk_daily_responses gr ON gr.employee_id = e.id
       LEFT JOIN gk_daily_questions gq ON gr.question_id = gq.id
                                      AND EXTRACT(YEAR FROM gq.question_date) = $1
       LEFT JOIN departments d ON e.department_id = d.id
       WHERE e.is_active = true
       GROUP BY e.id, e.employee_code, e.first_name, e.last_name, d.name
       HAVING COUNT(gr.id) > 0
       ORDER BY total_score DESC, correct DESC`,
      [year]
    );

    const wb = XLSX.utils.book_new();
    const wsData = [
      [`🏆 HRMS GK CHAMPION LEADERBOARD ${year}`],
      [`Generated: ${new Date().toLocaleDateString('' + (CONFIG.currencyLocale||'en-IN') + "'")}`], [],
      ['Rank','Emp Code','Name','Department','Total Score','Correct','Wrong','Skipped','Attempted'],
      ...r.rows.map(row=>[
        parseInt(row.rank), row.employee_code, row.name, row.department||'—',
        parseFloat(row.total_score).toFixed(2), row.correct, row.wrong, row.skipped, row.attempted
      ])
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [6,12,24,18,12,10,10,10,12].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, `Champion ${year}`);
    const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename=HRMS_GK_Champion_${year}.xlsx`);
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ══════════════════════════════════════════════════
//  EXPORT: FULL RESPONSE REPORT   GET /gk/export/responses
// ══════════════════════════════════════════════════
exports.exportResponses = async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const r = await db.query(
      `SELECT gq.question_date, gq.question, gq.correct_answer,
              e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name,
              d.name AS department, gr.answer, gr.is_correct, gr.score_change,
              TO_CHAR(gr.answered_at,'DD-Mon-YYYY HH24:MI') AS answered_at
       FROM gk_daily_responses gr
       JOIN gk_daily_questions gq ON gr.question_id = gq.id
       JOIN employees e ON gr.employee_id = e.id
       LEFT JOIN departments d ON e.department_id = d.id
       WHERE EXTRACT(YEAR FROM gq.question_date) = $1
       ORDER BY gq.question_date DESC, e.first_name`,
      [year]
    );

    const wb = XLSX.utils.book_new();
    const wsData = [
      [`HRMS — GK Full Response Report ${year}`], [],
      ['Date','Question','Correct Ans','Emp Code','Name','Department','Their Answer','Result','Score Δ','Answered At'],
      ...r.rows.map(row=>[
        new Date(row.question_date).toLocaleDateString('' + (CONFIG.currencyLocale||'en-IN') + "'"),
        row.question, row.correct_answer, row.employee_code, row.name, row.department||'—',
        row.answer, row.answer==='skip'?'Skipped':row.is_correct?'Correct':'Wrong',
        parseFloat(row.score_change).toFixed(2), row.answered_at
      ])
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [12,40,10,12,22,16,10,10,8,18].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, `Responses ${year}`);
    const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename=HRMS_GK_Responses_${year}.xlsx`);
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ──────────────────────────────────────────────────
//  HELPER: Parse Excel date (serial number or string)
// ──────────────────────────────────────────────────
function parseExcelDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;

  // Raw Excel serial number (number type from raw:true)
  if (typeof raw === 'number') {
    // Excel epoch: Jan 1 1900 = 1, but has leap year bug so offset is 25569 for Unix epoch
    const d = new Date(Math.round((raw - 25569) * 86400 * 1000));
    if (!isNaN(d.getTime())) {
      // Return UTC date string to avoid timezone shift
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    return null;
  }

  const s = String(raw).trim();
  if (!s) return null;

  // Already ISO: 2026-03-11
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // "01-Jan-2026" or "11-Mar-2026"
  const dmyMatch = s.match(/^(\d{1,2})[-\/](\w{3,9})[-\/](\d{4})$/);
  if (dmyMatch) {
    const months = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
    const mon = months[dmyMatch[2].toLowerCase().slice(0,3)];
    if (mon) return `${dmyMatch[3]}-${String(mon).padStart(2,'0')}-${dmyMatch[1].padStart(2,'0')}`;
  }

  // "11/03/2026" DD/MM/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [dd, mm, yyyy] = s.split('/');
    return `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
  }

  // Numeric string (serial as string)
  if (/^\d{4,5}$/.test(s)) {
    const d = new Date(Math.round((parseInt(s) - 25569) * 86400 * 1000));
    if (!isNaN(d.getTime())) {
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    }
  }

  // Generic fallback
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

// ══════════════════════════════════════════════════
//  POST TOP 5 LEADERBOARD ANNOUNCEMENT
//  Called by a cron job at end of month / end of year
//  POST /gk/announce-top5   body: { period: 'month' | 'year', posted_by_id }
// ══════════════════════════════════════════════════
exports.announceTop5 = async (req, res) => {
  try {
    const period   = req.body.period || 'month';   // 'month' or 'year'
    const postedBy = req.user.id;

    // Use IST date — server runs UTC, cron fires at 23:59 IST = next UTC day possibly
    const nowIST  = new Date(new Date().toLocaleString('en-US', { timeZone: CONFIG.timezone || 'Asia/Kolkata' }));
    const month   = nowIST.getMonth() + 1;
    const year    = nowIST.getFullYear();

    // Determine date filter
    let dateFilter = '';
    let periodLabel = '';
    const monthNames = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];

    if (period === 'month') {
      dateFilter = `AND EXTRACT(MONTH FROM gr.answered_at AT TIME ZONE CONFIG.timezone || 'Asia/Kolkata') = ${month}
                    AND EXTRACT(YEAR  FROM gr.answered_at AT TIME ZONE CONFIG.timezone || 'Asia/Kolkata') = ${year}`;
      periodLabel = `${monthNames[month - 1]} ${year}`;
    } else {
      dateFilter = `AND EXTRACT(YEAR FROM gr.answered_at AT TIME ZONE CONFIG.timezone || 'Asia/Kolkata') = ${year}`;
      periodLabel = `Year ${year}`;
    }

    // Fetch top 5
    const r = await db.query(
      `SELECT
         e.id,
         CONCAT(e.first_name, ' ', e.last_name) AS name,
         COALESCE(SUM(gr.score_change), 0)                                         AS total_score,
         COUNT(gr.id) FILTER (WHERE gr.is_correct = true)                          AS correct,
         COUNT(gr.id) FILTER (WHERE gr.is_correct = false AND gr.answer != 'skip') AS wrong
       FROM employees e
       JOIN gk_daily_responses gr ON gr.employee_id = e.id
       WHERE e.is_active = true ${dateFilter}
       GROUP BY e.id, e.first_name, e.last_name
       HAVING COUNT(gr.id) > 0
       ORDER BY total_score DESC, correct DESC
       LIMIT 5`
    );

    if (!r.rows.length) {
      return res.json({ success: false, message: 'No data for this period yet' });
    }

    const medals  = ['🥇','🥈','🥉','4️⃣','5️⃣'];
    const topList = r.rows.map((e, i) =>
      `${medals[i]} ${e.name} — ${parseFloat(e.total_score).toFixed(2)} pts (${e.correct} correct)`
    ).join('\n');

    const winner = r.rows[0].name;
    const title   = `🏆 GK ${period === 'month' ? 'Monthly' : 'Yearly'} Champions — ${periodLabel}`;
    const content = `🎉 Congratulations to our Top 5 GK Champions for ${periodLabel}!\n\n${topList}\n\n👏 Special shoutout to ${winner} for topping the leaderboard! Keep the knowledge flowing! 🧠🔥`;

    // Prevent duplicate for same period
    const dupCheck = await db.query(
      `SELECT id FROM announcements WHERE title = $1 AND created_at > NOW() - INTERVAL '25 days'`,
      [title]
    );
    if (dupCheck.rows.length) {
      return res.json({ success: false, message: 'Announcement for this period already exists' });
    }

    await db.query(
      `INSERT INTO announcements (title, content, type, posted_by, expires_at) VALUES ($1, $2, 'achievement', $3, NOW() + INTERVAL '24 hours')`,
      [title, content, postedBy]
    );

    // ── Notify ALL active employees via in-app notification ──────────────
    try {
      const allEmps = await db.query(`SELECT id FROM employees WHERE is_active = true`);
      for (const emp of allEmps.rows) {
        await db.query(
          `INSERT INTO notifications(employee_id, type, title, message)
           VALUES($1, 'announcement', $2, $3)`,
          [emp.id, title, `🏆 ${r.rows[0]?.name || 'Top performer'} topped the leaderboard! Check the announcement for full results.`]
        );
      }
      // ── Broadcast via Socket.IO so online users see it instantly ─────
      if (global.io) {
        global.io.emit('new_announcement', { title, content, type: 'achievement' });
      }
    } catch (notifErr) {
      console.error('[announceTop5] Notification failed (non-blocking):', notifErr.message);
    }

    res.json({ success: true, message: `Top 5 ${period} announcement posted!`, data: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
