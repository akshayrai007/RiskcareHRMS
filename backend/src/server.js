const CONFIG = require('./Main_file');
// src/server.js — MAIN ENTRY POINT
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const db      = require('./config/db');
const http    = require('http');
const { Server: SocketIO } = require('socket.io');
const jwt_sock = require('jsonwebtoken');
const routes  = require('./routes/index');
const chatCtrl   = require('./controllers/chatController');
const attCtrl    = require('./controllers/attendanceController');
const alertsCtrl = require('./controllers/movementAlertsController');
const emailSvc = require('./config/emailService'); // for startup repair
const offerCtrl  = require('./controllers/offerLetterController');
const itDeclCtrl = require('./controllers/itDeclarationController');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
const corsOptions = {
  origin: '*',
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logger (dev only)
app.use((req, _res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
// ── Socket.IO ─────────────────────────────────────────────────────────────────
const io = new SocketIO(server, { cors: { origin: '*', methods: ['GET','POST'] }, maxHttpBufferSize: 1e6 });
global.io = io;
io.use((socket, next) => {
  const token  = socket.handshake.auth?.token || socket.handshake.query?.token;
  const device = socket.handshake.auth?.device || socket.handshake.query?.device || 'web';
  if (!token) return next(new Error('Authentication required'));
  try {
    const decoded = jwt_sock.verify(token, process.env.JWT_SECRET || 'change-me');
    socket.user   = decoded;
    socket.device = device;  // 'web' | 'mobile'
    next();
  } catch (e) { next(new Error('Invalid token')); }
});
// Per-user socket tracking: userId -> Map<socketId, { socket, device }>
global.userSockets    = new Map();  // userId -> Set of socketIds (legacy, kept for compat)
global.userSocketsMeta = new Map(); // userId -> Map<socketId, device>
io.on('connection', (socket) => {
  const user = socket.user;
  console.log(`[Socket] ${user.first_name || user.id} connected`);

  // Track socket for this user
  if (!global.userSockets.has(String(user.id))) global.userSockets.set(String(user.id), new Set());
  global.userSockets.get(String(user.id)).add(socket.id);
  // Also track device type per socket
  if (!global.userSocketsMeta.has(String(user.id))) global.userSocketsMeta.set(String(user.id), new Map());
  global.userSocketsMeta.get(String(user.id)).set(socket.id, socket.device || 'web');

  // Broadcast online presence
  io.emit('userOnline', { userId: user.id });

  // Join a chat group room
  socket.on('joinGroup', (groupId) => {
    socket.join(`group:${groupId}`);
  });
  socket.on('leaveGroup', (groupId) => {
    socket.leave(`group:${groupId}`);
  });

  // Typing indicators
  socket.on('typing', ({ groupId, name }) => {
    socket.to(`group:${groupId}`).emit('userTyping', { userId: user.id, name });
  });
  socket.on('stopTyping', ({ groupId }) => {
    socket.to(`group:${groupId}`).emit('userStoppedTyping', { userId: user.id });
  });

  // Mark messages seen via socket (for DMs — no HTTP roundtrip)
  socket.on('markSeen', async ({ groupId, messageId }) => {
    try {
      const db = require('./config/db');
      await db.query(`
        INSERT INTO chat_read_receipts(group_id, employee_id, read_at)
        VALUES($1,$2,NOW())
        ON CONFLICT(group_id, employee_id) DO UPDATE SET read_at=NOW()
      `, [groupId, user.id]);
      // Notify senders in group
      const senders = await db.query(
        `SELECT DISTINCT sender_id FROM chat_messages WHERE group_id=$1 AND sender_id != $2`,
        [groupId, user.id]
      );
      senders.rows.forEach(row => {
        const ss = global.userSockets.get(String(row.sender_id));
        if (ss) ss.forEach(sid => io.to(sid).emit('messageSeen', { group_id: groupId, seen_by: user.id }));
      });
    } catch(e) { /* non-fatal */ }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] ${user.first_name || user.id} disconnected`);
    // Remove socket from tracking
    const sockets = global.userSockets.get(String(user.id));
    if (sockets) {
      sockets.delete(socket.id);
      if (!sockets.size) {
        global.userSockets.delete(String(user.id));
        io.emit('userOffline', { userId: user.id });
      }
    }
    const meta = global.userSocketsMeta.get(String(user.id));
    if (meta) {
      meta.delete(socket.id);
      if (!meta.size) global.userSocketsMeta.delete(String(user.id));
    }
  });
});


// Static: serve chat uploaded files
// Served under BOTH paths so old file_url values (/chat/files/...) still work
// and new uploads (/api/chat/files/...) work too
const chatUploadDir = require('path').join(__dirname, '..', 'uploads', 'chat');
if (!require('fs').existsSync(chatUploadDir)) require('fs').mkdirSync(chatUploadDir, { recursive: true });
app.use('/chat/files', require('express').static(chatUploadDir));  // legacy disk files only

app.use('/api', routes);  // /api/chat/files/:id served by chatFileController (DB + disk)

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.0.0' });
});

// ── Redirect HTML page requests to Vercel frontend ────────────────────────────
// Mobile app navigates using backend URL — redirect to correct Vercel frontend
const FRONTEND_URL = 'https://krishi-hr-mu.vercel.app';
app.get('/*.html', (req, res) => {
  res.redirect(301, FRONTEND_URL + req.path);
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ── Cron Jobs ─────────────────────────────────────────────────────────────────

// 1. Monthly leave accrual — runs at 00:01 on the 1st of every month
cron.schedule('1 0 1 * *', async () => {
  console.log('⏰ Running monthly leave accrual...');
  try {
    const now   = new Date();
    const year  = now.getFullYear();
    const types = await db.query(
      `SELECT id, code, monthly_accrual, days_allowed FROM leave_types WHERE monthly_accrual > 0 AND is_active=true`
    );
    const employees = await db.query(
      `SELECT id, employee_category, joining_date FROM employees WHERE is_active=true`
    );

    for (const emp of employees.rows) {
      // Determine which leave types this employee can accrue this month
      let allowedCodes = null; // null = use all types (permanent/provision)

      if (emp.employee_category === 'contractual') {
        const joiningDate  = new Date(emp.joining_date);
        const sixMonthMark = new Date(joiningDate);
        sixMonthMark.setMonth(sixMonthMark.getMonth() + 6);
        // Under 6 months: PL only (provisional period)
        // Over 6 months: no accrual (LWP+OD are unlimited, no monthly quota)
        allowedCodes = now < sixMonthMark ? ['PL'] : [];
      }

      for (const lt of types.rows) {
        if (allowedCodes !== null && !allowedCodes.includes(lt.code)) continue;

        await db.query(
          `INSERT INTO leave_balances(employee_id,leave_type_id,year,allocated)
           VALUES($1,$2,$3,0) ON CONFLICT(employee_id,leave_type_id,year) DO NOTHING`,
          [emp.id, lt.id, year]
        );
        await db.query(
          `UPDATE leave_balances SET allocated=LEAST(allocated+$1,$2)
           WHERE employee_id=$3 AND leave_type_id=$4 AND year=$5`,
          [lt.monthly_accrual, lt.days_allowed, emp.id, lt.id, year]
        );
      }
    }
    console.log(`✅ Leave accrual done for ${employees.rows.length} employees`);
  } catch (err) {
    console.error('❌ Leave accrual cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

// 2. Mark absent — runs at 23:55 every weekday for employees who didn't punch in
cron.schedule('55 23 * * 1-6', async () => {
  console.log('⏰ Marking absent for employees with no attendance today...');
  try {
    // FIX: use IST date — server runs UTC, toISOString() gives wrong date after 18:30 IST
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: CONFIG.timezone || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date()); // "YYYY-MM-DD" in IST

    // Skip if today is a public holiday (applies to ALL employees)
    const holiday = await db.query('SELECT id FROM holidays WHERE date=$1', [today]);
    if (holiday.rows.length) { console.log('Holiday today — skipping absent marking'); return; }

    // Check if today is Saturday and which occurrence (1st/2nd/3rd/4th/5th)
    const dt = new Date(today);
    const isSaturday = dt.getDay() === 6;
    let satCount = 0;
    if (isSaturday) {
      for (let d = 1; d <= dt.getDate(); d++) {
        if (new Date(dt.getFullYear(), dt.getMonth(), d).getDay() === 6) satCount++;
      }
    }
    const is2ndOr4thSat = isSaturday && (satCount === 2 || satCount === 4);

    if (is2ndOr4thSat) {
      // 2nd or 4th Saturday:
      // - Onsite employees (saturday_policy = '2nd_4th_off') → weekend
      // - Offsite/Field employees (saturday_policy = 'all_working') → absent if no punch
      await db.query(
        `INSERT INTO attendance(employee_id, date, status)
         SELECT e.id, $1,
           CASE
             WHEN COALESCE(e.saturday_policy, '2nd_4th_off') = '2nd_4th_off' THEN 'weekend'
             ELSE 'absent'
           END
         FROM employees e
         WHERE e.is_active = true
           AND NOT EXISTS (
             SELECT 1 FROM attendance a WHERE a.employee_id = e.id AND a.date = $1
           )
         ON CONFLICT(employee_id, date) DO NOTHING`,
        [today]
      );
      // Also correct any already-inserted wrong 'absent' for onsite employees today
      await db.query(
        `UPDATE attendance
         SET status = 'weekend'
         WHERE date = $1
           AND status = 'absent'
           AND employee_id IN (
             SELECT id FROM employees
             WHERE is_active = true
               AND COALESCE(saturday_policy, '2nd_4th_off') = '2nd_4th_off'
           )`,
        [today]
      );
      console.log(`✅ Absent marking done (2nd/4th Saturday: onsite → weekend, offsite → absent if no punch)`);
    } else {
      // Normal working day (Mon–Fri, or 1st/3rd/5th Saturday for offsite):
      // All employees who didn't punch in → absent
      await db.query(
        `INSERT INTO attendance(employee_id, date, status)
         SELECT e.id, $1, 'absent'
         FROM employees e
         WHERE e.is_active = true
           AND NOT EXISTS (
             SELECT 1 FROM attendance a WHERE a.employee_id = e.id AND a.date = $1
           )
         ON CONFLICT(employee_id, date) DO NOTHING`,
        [today]
      );
      console.log('✅ Absent marking done');
    }
  } catch (err) {
    console.error('❌ Absent marking cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

// ── Nightly 21:05 IST: mark missing punch-outs ───────────────────────────────
// Employees who punched in today but never punched out get status = 'missing_punch_out'
cron.schedule('5 21 * * 1-6', async () => {
  console.log('⏰ Checking for missing punch-outs...');
  try {
    await attCtrl.fixMissingPunchOuts();
  } catch (err) {
    console.error('❌ fixMissingPunchOuts cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });
async function isNonWorkingDay(today) {
  const holiday = await db.query('SELECT id FROM holidays WHERE date=$1', [today]);
  if (holiday.rows.length) return true;
  const dt = new Date(today);
  if (dt.getDay() === 6) {
    const dayOfMonth = dt.getDate();
    let satCount = 0;
    for (let d = 1; d <= dayOfMonth; d++) {
      if (new Date(dt.getFullYear(), dt.getMonth(), d).getDay() === 6) satCount++;
    }
    if (satCount === 2 || satCount === 4) return true;
  }
  return false;
}

// ── Cron 1: Auto punch-IN for permanent WFH + super_admin at 9:30 AM IST ─────
cron.schedule('30 9 * * 1-6', async () => {
  console.log('⏰ Auto punch-IN for permanent WFH employees and super_admin...');
  try {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: CONFIG.timezone || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());

    if (await isNonWorkingDay(today)) { console.log('Non-working day — skipping WFH punch-in'); return; }

    const wfhEmps = await db.query(
      `SELECT id, role FROM employees WHERE is_active=true AND (is_wfh_permanent=true OR role='super_admin' OR employee_code=CONFIG.cooEmployeeCode)`
    );
    if (!wfhEmps.rows.length) { console.log('No permanent WFH/auto-present employees'); return; }

    let marked = 0;
    for (const emp of wfhEmps.rows) {
      // super_admin / KC718 → auto present (office), permanent WFH employees → wfh
      const isOfficeUser = emp.role === 'super_admin' || emp.employee_code === CONFIG.cooEmployeeCode;
      await db.query(
        `INSERT INTO attendance(employee_id, date, status, punch_in, punch_in_location, remarks, wfh_approved)
         VALUES($1, $2, 'present', '09:30:00', $3, $4, $5)
         ON CONFLICT(employee_id, date) DO NOTHING`,
        [emp.id, today,
          isOfficeUser ? 'Office' : 'Work from Home',
          isOfficeUser ? 'Auto Present' : 'Auto WFH',
          isOfficeUser ? false : true]
      );
      marked++;
    }
    console.log(`✅ Auto punch-IN done for ${marked} employees`);
  } catch (err) {
    console.error('❌ WFH auto punch-IN cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

// ── Cron 2: Auto punch-OUT for permanent WFH + super_admin at 6:30 PM IST ────
cron.schedule('30 18 * * 1-6', async () => {
  console.log('⏰ Auto punch-OUT for permanent WFH employees and super_admin...');
  try {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: CONFIG.timezone || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());

    if (await isNonWorkingDay(today)) { console.log('Non-working day — skipping WFH punch-out'); return; }

    const wfhEmps = await db.query(
      `SELECT id, role FROM employees WHERE is_active=true AND (is_wfh_permanent=true OR role='super_admin' OR employee_code=CONFIG.cooEmployeeCode)`
    );
    if (!wfhEmps.rows.length) return;

    for (const emp of wfhEmps.rows) {
      const isOfficeUser = emp.role === 'super_admin' || emp.employee_code === CONFIG.cooEmployeeCode;
      // Only fill punch-out if punch-in exists and punch-out is missing
      await db.query(
        `UPDATE attendance
         SET punch_out='18:30:00', punch_out_location=$3,
             working_hours=9.0, status='present'
         WHERE employee_id=$1 AND date=$2
           AND punch_in IS NOT NULL AND punch_out IS NULL`,
        [emp.id, today, isOfficeUser ? 'Office' : 'Work from Home']
      );
    }
    console.log(`✅ Auto punch-OUT done`);
  } catch (err) {
    console.error('❌ WFH auto punch-OUT cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

// ── Run auto-present on startup DISABLED — was exhausting DB pool on cold start ──
// Cron jobs handle this at scheduled times instead.
/*
(async () => {
  await new Promise(r => setTimeout(r, 15000)); // wait 15s for DB pool to warm up on cold start
  try {
    const now = new Date();
    const istDate = new Date(now.toLocaleString('en-US', { timeZone: CONFIG.timezone || 'Asia/Kolkata' }));
    const istHour = istDate.getHours();
    const istMin  = istDate.getMinutes();
    const day = istDate.getDay();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone || 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

    if (day < 1 || day > 6) return; // skip Sundays
    if (await isNonWorkingDay(today)) return;

    const wfhEmps = await db.query(
      `SELECT id, role FROM employees WHERE is_active=true AND (is_wfh_permanent=true OR role='super_admin' OR employee_code=CONFIG.cooEmployeeCode)`
    );
    if (!wfhEmps.rows.length) return;

    const afterPunchIn  = istHour > 9 || (istHour === 9 && istMin >= 30);
    const afterPunchOut = istHour > 18 || (istHour === 18 && istMin >= 30);

    for (const emp of wfhEmps.rows) {
      const isOfficeUser = emp.role === 'super_admin' || emp.employee_code === CONFIG.cooEmployeeCode;
      if (afterPunchIn) {
        await db.query(
          `INSERT INTO attendance(employee_id, date, status, punch_in, punch_in_location, remarks, wfh_approved)
           VALUES($1, $2, 'present', '09:30:00', $3, $4, $5)
           ON CONFLICT(employee_id, date) DO NOTHING`,
          [emp.id, today,
            isOfficeUser ? 'Office' : 'Work from Home',
            isOfficeUser ? 'Auto Present' : 'Auto WFH',
            isOfficeUser ? false : true]
        );
      }
      if (afterPunchOut) {
        await db.query(
          `UPDATE attendance
           SET punch_out='18:30:00', punch_out_location=$3,
               working_hours=9.0, status='present'
           WHERE employee_id=$1 AND date=$2
             AND punch_in IS NOT NULL AND punch_out IS NULL`,
          [emp.id, today, isOfficeUser ? 'Office' : 'Work from Home']
        );
      }
    }
    if (wfhEmps.rows.length) console.log(`✅ Startup auto-present done for ${wfhEmps.rows.length} employees`);
  } catch (err) { console.error('Startup WFH error:', err.message); }
})();
*/

// ── Cleanup: Delete expired notifications every day at 2 AM IST ─────────────
cron.schedule('0 2 * * *', async () => {
  try {
    const result = await db.query(
      `DELETE FROM notifications WHERE expires_at IS NOT NULL AND expires_at < NOW()`
    );
    console.log(`✅ Expired notifications cleaned up: ${result.rowCount} deleted`);
  } catch (err) {
    console.error('❌ Notification cleanup cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

// 3. Year-end carry forward — runs at 00:30 on Jan 1st
cron.schedule('30 0 1 1 *', async () => {
  console.log('⏰ Running year-end carry forward...');
  try {
    const prevYear = new Date().getFullYear() - 1;
    const newYear  = new Date().getFullYear();

    // Get EL (Earned Leave) which has carry forward
    const elType = await db.query(`SELECT id, max_carry_forward FROM leave_types WHERE code='EL'`);
    if (!elType.rows.length) return;
    const { id: elId, max_carry_forward } = elType.rows[0];

    // For each employee, carry forward min(remaining EL, max_carry_forward)
    const prevBalances = await db.query(
      `SELECT employee_id,
              GREATEST(0, allocated + carry_forward - used - pending) AS remaining
       FROM leave_balances WHERE leave_type_id=$1 AND year=$2`,
      [elId, prevYear]
    );

    for (const bal of prevBalances.rows) {
      const cf = Math.min(parseFloat(bal.remaining), max_carry_forward);
      if (cf > 0) {
        await db.query(
          `INSERT INTO leave_balances(employee_id,leave_type_id,year,carry_forward)
           VALUES($1,$2,$3,$4)
           ON CONFLICT(employee_id,leave_type_id,year)
           DO UPDATE SET carry_forward=$4`,
          [bal.employee_id, elId, newYear, cf]
        );
      }
    }
    console.log(`✅ Year-end carry forward done for ${prevBalances.rows.length} employees`);
  } catch (err) {
    console.error('❌ Carry forward cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

// 4. Auto-deactivate employees whose last_working_date has passed (separation approved)
// Runs every night at 00:10
cron.schedule('10 0 * * *', async () => {
  console.log('⏰ Checking for employees to auto-deactivate...');
  try {
    const today = new Date().toISOString().split('T')[0];

    const result = await db.query(
      `UPDATE employees
       SET is_active = false,
           updated_at = NOW()
       WHERE is_active = true
         AND separation_date IS NOT NULL
         AND separation_date <= $1
         AND id IN (
           SELECT employee_id FROM separations
           WHERE status = 'approved'
         )
       RETURNING id, employee_code, first_name, last_name, separation_date`,
      [today]
    );

    if (result.rows.length > 0) {
      console.log(`✅ Auto-deactivated ${result.rows.length} employee(s):`);
      result.rows.forEach(e =>
        console.log(`   → ${e.first_name} ${e.last_name} (${e.employee_code}) — LWD: ${e.separation_date}`)
      );

      for (const emp of result.rows) {
        await db.query(
          `UPDATE separations SET status='completed', updated_at=NOW()
           WHERE employee_id=$1 AND status='approved'`,
          [emp.id]
        );
        const hr = await db.query(
          `SELECT id FROM employees WHERE role IN ('hr','admin') AND is_active=true LIMIT 1`
        );
        if (hr.rows.length) {
          await db.query(
            `INSERT INTO notifications(employee_id,title,message,type)
             VALUES($1,'🔴 Employee Separated',$2,'info')`,
            [hr.rows[0].id,
             `${emp.first_name} ${emp.last_name} (${emp.employee_code}) has been auto-deactivated. Last working day: ${emp.separation_date}`]
          );
        }
      }
    } else {
      console.log('✅ No employees to deactivate today');
    }
  } catch (err) {
    console.error('❌ Auto-deactivation cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

// ── Auto-initiate provision confirmation — runs at 09:00 AM IST every day ────
// Finds employees whose provision_end_date is TODAY or in the past (overdue)
// and no confirmation workflow has been started yet → auto-creates one and
// notifies the reporting manager by email + in-app notification
cron.schedule('0 9 * * *', async () => {
  console.log('⏰ Auto-initiating provision confirmations...');
  try {
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: CONFIG.timezone || 'Asia/Kolkata' }));
    const todayStr = today.toISOString().split('T')[0];

    // Find all provision employees whose period has ended and no workflow yet
    const due = await db.query(
      `SELECT e.id, e.employee_code, e.first_name, e.last_name,
              e.provision_end_date, e.reporting_manager_id,
              m.first_name AS mgr_first, m.last_name AS mgr_last, m.employee_code AS mgr_code
       FROM employees e
       LEFT JOIN employees m ON e.reporting_manager_id = m.id
       WHERE e.is_active = TRUE
         AND e.employee_category = 'provision'
         AND e.provision_end_date <= $1
         AND NOT EXISTS (
           SELECT 1 FROM provision_confirmations pc WHERE pc.employee_id = e.id
         )`,
      [todayStr]
    );

    if (!due.rows.length) {
      console.log('✅ No provision employees due for auto-initiation today');
      return;
    }

    // Find an HR user to act as initiator
    const hrRes = await db.query(
      `SELECT id FROM employees WHERE role IN ('hr','admin','super_admin') AND is_active = TRUE LIMIT 1`
    );
    const initiatorId = hrRes.rows[0]?.id || null;

    for (const emp of due.rows) {
      try {
        // Create the confirmation record
        await db.query(
          `INSERT INTO provision_confirmations
             (employee_id, manager_id, overall_status, initiated_by, notes)
           VALUES ($1, $2, 'pending', $3, $4)
           ON CONFLICT DO NOTHING`,
          [emp.id, emp.reporting_manager_id, initiatorId,
           `Auto-initiated by system on ${todayStr} (provision ended ${emp.provision_end_date})`]
        );

        // In-app notification to manager
        if (emp.reporting_manager_id) {
          await db.query(
            `INSERT INTO notifications (employee_id, type, title, message, is_read)
             VALUES ($1, 'provision_confirm', '⏳ Provision Confirmation Required',
                     $2, FALSE)`,
            [
              emp.reporting_manager_id,
              `${emp.first_name} ${emp.last_name} (${emp.employee_code}) has completed their provision period. Please review and approve their permanent confirmation.`
            ]
          );
        }

        // In-app notification to all HR
        const hrList = await db.query(
          `SELECT id FROM employees WHERE role IN ('hr','admin','super_admin') AND is_active = TRUE`
        );
        for (const hr of hrList.rows) {
          await db.query(
            `INSERT INTO notifications (employee_id, type, title, message, is_read)
             VALUES ($1, 'provision_confirm', '⏳ Provision Period Ended — Confirmation Initiated',
                     $2, FALSE)`,
            [
              hr.id,
              `Auto-initiated confirmation for ${emp.first_name} ${emp.last_name} (${emp.employee_code}). Provision ended ${emp.provision_end_date}. Awaiting manager approval.`
            ]
          );
        }

        // Email the manager
        emailSvc.notifyProvisionManagerApprovalNeeded(emp.id, emp).catch(console.error);

        console.log(`✅ Auto-initiated confirmation for ${emp.first_name} ${emp.last_name} (${emp.employee_code})`);
      } catch (empErr) {
        console.error(`❌ Failed to auto-initiate for ${emp.employee_code}:`, empErr.message);
      }
    }

    console.log(`✅ Provision auto-initiation done. Processed: ${due.rows.length} employee(s)`);
  } catch (err) {
    console.error('❌ Provision auto-initiation cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

// 5. Birthday notifications — runs at 08:00 AM IST every day
cron.schedule('0 8 * * *', async () => {
  console.log('⏰ Running birthday notifications...');
  try {
    const istNow    = new Date(new Date().toLocaleString('en-US', { timeZone: CONFIG.timezone || 'Asia/Kolkata' }));
    const todayMD   = `${String(istNow.getMonth()+1).padStart(2,'0')}${String(istNow.getDate()).padStart(2,'0')}`;
    const tomorrow  = new Date(istNow); tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowMD = `${String(tomorrow.getMonth()+1).padStart(2,'0')}${String(tomorrow.getDate()).padStart(2,'0')}`;

    // TODAY birthdays
    const todayBdays = await db.query(
      `SELECT id, first_name, last_name, employee_code
       FROM employees WHERE is_active=TRUE AND date_of_birth IS NOT NULL
       AND TO_CHAR(date_of_birth,'MMDD') = $1`, [todayMD]
    );

    for (const emp of todayBdays.rows) {
      const all = await db.query(`SELECT id FROM employees WHERE is_active=TRUE AND id != $1`, [emp.id]);
      for (const r of all.rows) {
        await db.query(
          `INSERT INTO notifications(employee_id, title, message, type)
           VALUES($1,'🎂 Birthday Today!',$2,'birthday')`,
          [r.id, `🎉 Today is ${emp.first_name} ${emp.last_name}'s birthday! Wish them well.`]
        );
      }
      await db.query(
        `INSERT INTO notifications(employee_id, title, message, type)
         VALUES($1,'🎂 Happy Birthday!','Wishing you a very Happy Birthday! 🎉🎂','birthday')`,
        [emp.id]
      );
      emailSvc.notifyBirthday(emp.id).catch(console.error);
      console.log(`[Birthday] Today: ${emp.first_name} ${emp.last_name}`);
    }

    // TOMORROW birthdays — advance notice
    const tomorrowBdays = await db.query(
      `SELECT id, first_name, last_name FROM employees WHERE is_active=TRUE AND date_of_birth IS NOT NULL
       AND TO_CHAR(date_of_birth,'MMDD') = $1`, [tomorrowMD]
    );

    for (const emp of tomorrowBdays.rows) {
      const all = await db.query(`SELECT id FROM employees WHERE is_active=TRUE AND id != $1`, [emp.id]);
      for (const r of all.rows) {
        await db.query(
          `INSERT INTO notifications(employee_id, title, message, type)
           VALUES($1,'🎂 Upcoming Birthday',$2,'birthday')`,
          [r.id, `Tomorrow is ${emp.first_name} ${emp.last_name}'s birthday! Don't forget to wish them 🎉`]
        );
      }
      console.log(`[Birthday] Tomorrow: ${emp.first_name} ${emp.last_name}`);
    }

    console.log(`✅ Birthday cron done. Today: ${todayBdays.rows.length}, Tomorrow: ${tomorrowBdays.rows.length}`);
  } catch (err) {
    console.error('❌ Birthday cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

// Work Anniversary emails — daily at 8:05 AM IST
cron.schedule('5 8 * * *', async () => {
  console.log('⏰ Running work anniversary emails...');
  try {
    await emailSvc.sendDailyAnniversaryEmails();
    console.log('✅ Anniversary emails done');
  } catch(err) {
    console.error('❌ Anniversary cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

// ── Feature #10: Tracking silence / low-battery alerts every 30 min ──────────
// Runs during work hours 9:00–21:00 IST — checks punched-in field employees
// for silence (no GPS ping >30 min), low battery, GPS off, internet off
cron.schedule('*/30 9-20 * * 1-6', async () => {
  try {
    const result = await alertsCtrl.checkTrackingSilence();
    if (result.alerts > 0) {
      console.log(`[TrackingAlerts] ✅ ${result.alerts} alerts created/updated for ${result.checked} employees`);
    }
  } catch (err) {
    console.error('❌ TrackingAlerts cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

async function start() {
  try {
    await db.query('SELECT 1');
    console.log('✅ Database connected');

    await db.query(`CREATE TABLE IF NOT EXISTS birthday_likes (
      id SERIAL PRIMARY KEY,
      birthday_emp_id INT REFERENCES employees(id) ON DELETE CASCADE,
      from_emp_id INT REFERENCES employees(id) ON DELETE CASCADE,
      like_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(birthday_emp_id, from_emp_id, like_date)
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS birthday_wishes (
      id SERIAL PRIMARY KEY,
      birthday_emp_id INT REFERENCES employees(id) ON DELETE CASCADE,
      from_emp_id INT REFERENCES employees(id) ON DELETE CASCADE,
      message TEXT,
      wish_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(birthday_emp_id, from_emp_id, wish_date)
    )`);
    console.log('✅ Birthday tables ready');

    // ✅ Start listening IMMEDIATELY — don't block port binding on ALTER TABLE queries
    // ALTER TABLE can lock tables and hang for seconds; Render times out waiting for port
    server.listen(PORT, () => {
      console.log('');
      console.log('╔═══════════════════════════════════════╗');
      console.log(`║  HRMS Backend on port ${PORT}         ║`);
      console.log('╠═══════════════════════════════════════╣');
      console.log('║  Health:  GET /health                 ║');
      console.log('║  Login:   POST /api/auth/login        ║');
      console.log('║  Docs:    See README.md               ║');
      console.log('╚═══════════════════════════════════════╝');
      console.log('');
    });

    // ✅ Run lightweight schema additions in background — non-blocking
    setTimeout(async () => {
      try {
        await db.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS employee_type VARCHAR(20) DEFAULT 'onsite'`);
        await db.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS separation_date DATE DEFAULT NULL`);
        await db.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS separation_type VARCHAR(50) DEFAULT NULL`);
        await db.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS separation_reason TEXT DEFAULT NULL`);
        await offerCtrl.initTables();
        await itDeclCtrl.initTables();
        const projCtrl = require('./controllers/projectController');
        await projCtrl.migrate();
        // ── Add deactivation_remark column if it doesn't exist ─────────────
        await db.query(`
          ALTER TABLE employees
          ADD COLUMN IF NOT EXISTS deactivation_remark TEXT DEFAULT NULL
        `).catch(() => {});
        console.log('✅ DB schema ready');
        // NOTE: fixWrongAbsents, fixMissingPunchOuts, fixTimezoneShiftedLeaves removed from
        // startup — they held DB connections and starved the pool causing login timeouts.
        // Run these manually via pgAdmin when needed.
      } catch (err) {
        console.error('❌ Background startup fix failed:', err.message);
      }
    }, 5000);
  } catch (err) {
    console.error('❌ Failed to start:', err.message);
    console.error('   Make sure PostgreSQL is running and .env is configured');
    process.exit(1);
  }
}

// ── EMI Installment Reminder Cron — runs daily 1st–7th of month at 9:05 AM IST ──
// Notifies accounts team about active loans pending this month's installment
cron.schedule('5 9 1-7 * *', async () => {
  try {
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: CONFIG.timezone || 'Asia/Kolkata' }));
    const m = nowIST.getMonth() + 1;
    const y = nowIST.getFullYear();
    const MONTHS = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];

    // Find active loans where this month's installment not yet logged
    const pending = await db.query(`
      SELECT a.id, a.monthly_emi, a.installments_paid, a.total_installments,
             CONCAT(e.first_name,' ',e.last_name) AS emp_name, e.employee_code
      FROM advance_salary a
      JOIN employees e ON e.id = a.employee_id
      WHERE a.status = 'disbursed'
        AND a.installments_paid < a.total_installments
        AND NOT EXISTS (
          SELECT 1 FROM loan_recovery_log lr
          WHERE lr.advance_id = a.id
            AND lr.payroll_month = $1
            AND lr.payroll_year  = $2
        )
    `, [m, y]);

    if (!pending.rows.length) {
      console.log('[EMI Reminder] All installments recorded for', MONTHS[m-1], y);
      return;
    }

    // Notify all accounts users
    const accounts = await db.query(
      `SELECT id FROM employees WHERE role='accounts' AND is_active=true`
    );

    const empList = pending.rows.map(r =>
      `${r.emp_name} (${r.employee_code}) — ₹${parseFloat(r.monthly_emi).toLocaleString('en-IN')} — Inst. ${parseInt(r.installments_paid)+1}/${r.total_installments}`
    ).join('\n');

    for (const acc of accounts.rows) {
      await db.query(
        `INSERT INTO notifications(employee_id,type,title,message)
         VALUES($1,'advance','💳 EMI Pending — ${MONTHS[m-1]} ${y}',$2)`,
        [acc.id,
         `${pending.rows.length} loan installment(s) not yet recorded for ${MONTHS[m-1]} ${y}:
${empList}

Go to Advance Salary → EMI Tracker to mark them paid.`]
      ).catch(()=>{});
    }
    console.log(`[EMI Reminder] ✅ Notified accounts — ${pending.rows.length} pending installment(s) for ${MONTHS[m-1]} ${y}`);
  } catch (err) {
    console.error('❌ EMI reminder cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

// ── GK End-of-Day Skip Cron — runs at 11:59 PM IST every day ─────────────────
// Any assigned question with no response yet gets auto-marked as 'skip'
cron.schedule('59 23 * * *', async () => {
  console.log('⏰ [GK] Running end-of-day skip marking...');
  try {
    const istDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: CONFIG.timezone || 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());

    // Find all assignments for today that have no response
    const unanswered = await db.query(
      `SELECT ea.employee_id, ea.question_id
       FROM gk_employee_assignments ea
       WHERE ea.assigned_date = $1
         AND NOT EXISTS (
           SELECT 1 FROM gk_daily_responses gr
           WHERE gr.employee_id = ea.employee_id
             AND gr.question_id = ea.question_id
         )`,
      [istDate]
    );

    if (!unanswered.rows.length) {
      console.log('[GK] No unanswered assignments to skip today.');
      return;
    }

    // Bulk insert skip records
    for (const row of unanswered.rows) {
      await db.query(
        `INSERT INTO gk_daily_responses
           (question_id, employee_id, answer, is_correct, score_change, answered_at)
         VALUES ($1, $2, 'skip', false, 0, NOW())
         ON CONFLICT DO NOTHING`,
        [row.question_id, row.employee_id]
      );
    }

    console.log(`✅ [GK] Auto-skipped ${unanswered.rows.length} unanswered question(s) for ${istDate}`);
  } catch (err) {
    console.error('❌ GK end-of-day skip cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

// ── GK Monthly Top 5 Announcement (last day of every month, 11:59 PM IST) ──────
cron.schedule('59 23 28-31 * *', async () => {
  try {
    // Only fire on the actual last day of the month
    const now      = new Date(new Date().toLocaleString('en-US', { timeZone: CONFIG.timezone || 'Asia/Kolkata' }));
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (tomorrow.getDate() !== 1) return; // not last day — skip

    console.log('[CRON] 📅 Posting monthly GK Top 5 announcement...');
    const gkCtrl = require('./controllers/gkController');
    const admin  = await db.query(`SELECT id FROM employees WHERE role IN ('admin','super_admin') AND is_active=true LIMIT 1`);
    if (!admin.rows.length) return console.warn('[CRON] No admin found for GK announcement');

    await gkCtrl.announceTop5(
      { body: { period: 'month' }, user: { id: admin.rows[0].id } },
      { json: (d) => console.log('[CRON] Monthly Top5 result:', d.message) }
    );
  } catch (err) {
    console.error('❌ GK monthly top5 cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

// ── GK Yearly Top 5 Announcement removed — only monthly winners are announced ──


// ── Comp Off Auto-Grant Cron — runs at 11:30 PM IST every day ─────────────────
// Scans today's attendance and grants COMPOFF to eligible employees
cron.schedule('30 23 * * *', async () => {
  try {
    const compoffCtrl = require('./controllers/compoffController');
    const istDate = new Date(new Date().toLocaleString('en-US', { timeZone: CONFIG.timezone || 'Asia/Kolkata' }));
    const dateStr = istDate.toISOString().split('T')[0];
    console.log(`[CRON] 🗓️  Running COMPOFF auto-grant for ${dateStr}...`);
    const result = await compoffCtrl.autoGrantForDate(dateStr);
    console.log(`[CRON] ✅ COMPOFF auto-grant done — granted: ${result.granted}, skipped: ${result.skipped}`);
  } catch (err) {
    console.error('❌ COMPOFF auto-grant cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

// ── Comp Off Expiry Cron — runs at 12:05 AM IST every day ────────────────────
// Marks credits past their 30-day expiry as 'expired' and reduces leave_balances
cron.schedule('5 0 * * *', async () => {
  try {
    const compoffCtrl = require('./controllers/compoffController');
    console.log('[CRON] ⏳ Running COMPOFF expiry check...');
    await compoffCtrl.expireOldCredits();
    console.log('[CRON] ✅ COMPOFF expiry check done');
  } catch (err) {
    console.error('❌ COMPOFF expiry cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

// ── Reimbursement Auto-Delete Cron ───────────────────────────────────────────
// Rejected: deleted after 24 hours | Approved: deleted after 6 months
cron.schedule('0 * * * *', async () => {
  console.log('⏰ Running reimbursement auto-cleanup...');
  try {
    // Delete rejected reimbursements older than 24 hours
    const rejectedResult = await db.query(`
      DELETE FROM reimbursements
      WHERE status = 'rejected'
        AND updated_at < NOW() - INTERVAL '24 hours'
      RETURNING id
    `);

    // Delete approved reimbursements older than 6 months
    const approvedResult = await db.query(`
      DELETE FROM reimbursements
      WHERE status = 'approved'
        AND approved_at < NOW() - INTERVAL '6 months'
      RETURNING id
    `);

    const rCount = rejectedResult.rowCount;
    const aCount = approvedResult.rowCount;
    if (rCount > 0) console.log(`🗑️ Deleted ${rCount} rejected reimbursement(s) (>24h old)`);
    if (aCount > 0) console.log(`🗑️ Deleted ${aCount} approved reimbursement(s) (>6 months old)`);
    if (rCount === 0 && aCount === 0) console.log('✅ No reimbursements to clean up');
  } catch (err) {
    console.error('❌ Reimbursement auto-cleanup cron failed:', err.message);
  }
}, { timezone: CONFIG.timezone || 'Asia/Kolkata' });

start();

// ── Keep-Alive Ping (prevents Render free tier sleep) ─────────────────────────
// ── Keep-Alive Ping (prevents Render free tier sleep) ─────────────────────────
const https = require('https');
const PING_URL = 'https://hrms-zuui.onrender.com/health';
const INTERVAL_MS = 5 * 60 * 1000;     // 5 minutes
const INITIAL_DELAY_MS = 10 * 1000;    // 10 seconds after start
function pingServer() {
  https.get(PING_URL, (res) => {
    // Silent
  }).on('error', (err) => {
    console.error(`[Keep-Alive] ⚠️ ping failed: ${err.message}`);
  });
}
setTimeout(() => {
  pingServer();
  setInterval(pingServer, INTERVAL_MS);
}, INITIAL_DELAY_MS);

// ── DB Keep-Alive — keeps Neon DB pool warm every 5 minutes ──────────────────
// NOTE: chatCtrl.migrate() was removed from here — it ran every minute causing
// log spam ("✅ Chat tables migrated") and unnecessary DB load.
// Migrations now run ONCE at startup only (see start() above).
const DB_PING_INTERVAL = 5 * 60 * 1000; // 5 minutes (was 1 min — too aggressive)
setInterval(async () => {
  try {
    await db.query('SELECT 1');
  } catch (err) {
    console.warn('[DB Keep-Alive] ⚠️ DB ping failed:', err.message);
  }
}, DB_PING_INTERVAL);

