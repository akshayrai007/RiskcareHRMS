const CONFIG = require('../Main_file');
// src/routes/index.js — COMPLETE (Updated with Announcements, WFH, Import)
const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const { authenticate, authorize } = require('../middleware/auth');

// ── Controllers ───────────────────────────────────────────────────────────────
const chatCtrl       = require('../controllers/chatController');

const authCtrl       = require('../controllers/authController');
const empCtrl        = require('../controllers/employeeController');
const attCtrl        = require('../controllers/attendanceController');
const leaveCtrl      = require('../controllers/leaveController');
const advCtrl        = require('../controllers/advanceController');
const payCtrl        = require('../controllers/payrollController');
const geoCtrl        = require('../controllers/geofenceController');
const sepCtrl        = require('../controllers/separationController');
const empImportCtrl  = require('../controllers/employeeImportController');
const attImportCtrl   = require('../controllers/attendanceImportController');
const excelExportCtrl = require('../controllers/excelExportController');
const annCtrl        = require('../controllers/announcementController');
const gkCtrl         = require('../controllers/gkController');
const provCtrl       = require('../controllers/provisionController');
const itDeclCtrl     = require('../controllers/itDeclarationController');

const ADMIN      = ['admin','super_admin'];
const HR_ADMIN   = ['hr','admin','super_admin','accounts'];
const ACCOUNTS   = ['accounts','super_admin'];
const ADMIN_ONLY = ['admin','super_admin'];
const EMP_MGMT   = ['hr','accounts','admin','super_admin'];
const PROVISION_APPROVERS = ['hr','admin','super_admin','manager','tl'];

// ── Auth ──────────────────────────────────────────────────────────────────────
router.post('/auth/login',                      authCtrl.login);
router.post('/auth/refresh',                    authCtrl.refreshToken);
router.post('/auth/forgot-password/verify',     authCtrl.forgotVerify);
router.post('/auth/forgot-password/verify-pan', authCtrl.forgotVerifyPAN);
router.post('/auth/forgot-password/reset',      authCtrl.forgotReset);
router.get ('/auth/me',          authenticate,  authCtrl.getMe);
router.post('/auth/change-password', authenticate, authCtrl.changePassword);
router.post('/auth/update-photo',     authenticate, authCtrl.updatePhoto);

// ── Employees ─────────────────────────────────────────────────────────────────
router.get   ('/employees',               authenticate,                          empCtrl.getAll);
router.get   ('/employees/export',        authenticate, authorize(...EMP_MGMT), empCtrl.exportExcel || ((req,res) => res.status(501).json({success:false,message:'Not implemented'})));
router.get   ('/employees/export-master',        authenticate, authorize(...EMP_MGMT), empCtrl.exportMasterExcel);
router.get   ('/attendance/export-register',     authenticate, authorize('hr','accounts','super_admin'), empCtrl.exportAttendanceRegister);
router.get   ('/employees/code-preview',  authenticate, authorize(...EMP_MGMT), empCtrl.previewNextCode);
router.get   ('/employees/contacts',      authenticate,                          empCtrl.getContacts);
router.get   ('/employees/:id',           authenticate,                          empCtrl.getOne);
router.post  ('/employees',               authenticate, authorize(...EMP_MGMT),  empCtrl.create);
router.put   ('/employees/:id',           authenticate, authorize(...EMP_MGMT),  empCtrl.update);
router.patch ('/employees/:id',           authenticate, authorize(...EMP_MGMT),  empCtrl.update);
router.delete('/employees/:id',           authenticate, authorize(...EMP_MGMT),  empCtrl.deleteEmployee);
router.post  ('/employees/reset-password',authenticate, authorize(...EMP_MGMT), empCtrl.resetPassword);
router.post  ('/employees/:id/separate',  authenticate, authorize(...EMP_MGMT), (req,res)=>res.json({success:false,message:'Not implemented'}));

// ── Provision Confirmation Workflow ───────────────────────────────────────────
// Lists & details
router.get ('/provision',                authenticate, authorize(...PROVISION_APPROVERS), provCtrl.listProvisionEmployees);
router.get ('/provision/accrual-log',    authenticate, authorize('hr','admin','super_admin'), provCtrl.getAccrualLog);
router.get ('/provision/:id/status',     authenticate, authorize(...PROVISION_APPROVERS), provCtrl.getConfirmationStatus);
// Workflow actions
router.post('/provision/:id/initiate',   authenticate, authorize('hr','admin','super_admin'), provCtrl.initiateConfirmation);
router.post('/provision/:id/approve',    authenticate, authorize(...PROVISION_APPROVERS),    provCtrl.approveConfirmation);
// Monthly accrual (run 1st of each month, or manually)
router.post('/provision/monthly-accrual', authenticate, authorize('hr','admin','super_admin'), provCtrl.runMonthlyAccrual);

// ── Employee Bulk Import (Excel) ──────────────────────────────────────────────
router.post('/employees/import',
  authenticate, authorize(...EMP_MGMT),
  empImportCtrl.uploadMiddleware,
  empImportCtrl.importEmployees
);

// ── Attendance ────────────────────────────────────────────────────────────────
router.post('/attendance/punch-in',         authenticate, attCtrl.punchIn);
router.post('/attendance/punch-out',        authenticate, attCtrl.punchOut);

// ── Attendance Bulk Import — must be BEFORE generic GET /attendance ───────────
router.post('/attendance/import',
  authenticate, authorize(...['hr']),
  (req, res, next) => {
    attImportCtrl.uploadMiddleware(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.message || 'File upload error' });
      next();
    });
  },
  attImportCtrl.importAttendance
);

router.get ('/attendance',                  authenticate, attCtrl.get);
router.get ('/attendance/summary',          authenticate, attCtrl.getSummary);
router.get ('/attendance/team-today',       authenticate, attCtrl.getTeamToday);
router.get ('/attendance/punch-locations',  authenticate, attCtrl.getPunchLocations);
router.post('/attendance/regularize',       authenticate, attCtrl.requestRegularization);
router.get ('/attendance/regularizations',  authenticate, attCtrl.getRegularizations);
router.post('/attendance/regularize/action',authenticate, attCtrl.actionRegularization);
router.post('/attendance/force-regularize', authenticate, authorize('hr','super_admin'), attCtrl.forceRegularization);
router.get ('/attendance/emp-absent-dates',  authenticate, authorize('hr','super_admin'), attCtrl.getEmpAbsentDates);
router.post('/attendance/bulk-force-regularize', authenticate, authorize('hr','super_admin'), attCtrl.bulkForceRegularization);
router.get ('/attendance/absent-report',            authenticate, authorize('hr','super_admin','admin','accounts'), attCtrl.getAbsentReport);
router.get ('/attendance/absent-report/excel',      authenticate, authorize('hr','super_admin','admin','accounts'), excelExportCtrl.downloadAbsentReportExcel);
router.get ('/leave/summary/excel',                 authenticate, authorize('hr','super_admin','admin','accounts'), excelExportCtrl.downloadLeaveSummaryExcel);

// ── Attendance Bulk Import (Excel) — kept here for reference (defined above) ──

router.get ('/attendance/monthly-report',   authenticate, authorize('hr','accounts'), attImportCtrl.downloadAttendanceReport);

// ── OD / WFH apply (all employees) ───────────────────────────────────────────
router.post('/attendance/od',              authenticate, attCtrl.applyOD);
router.get ('/attendance/od',              authenticate, attCtrl.getODRequests);
router.post('/attendance/od/bulk-action',   authenticate, authorize('hr','super_admin','admin','manager','tl'), attCtrl.bulkActionOD);
router.post('/attendance/od/:id/action',   authenticate, authorize('hr','super_admin','admin','manager','tl'), attCtrl.actionOD);
router.post('/attendance/wfh',             authenticate, attCtrl.applyWFH);
router.get ('/attendance/wfh',             authenticate, attCtrl.getWFHRequests);
router.post('/attendance/wfh/:id/action',  authenticate, authorize('hr','super_admin','admin','manager','tl'), attCtrl.actionWFH);
router.get ('/attendance/report/download',  authenticate, authorize('hr','accounts'), attImportCtrl.downloadAttendanceReport);
// KC718 / super_admin: mark own attendance for a date range without punch in/out
router.post('/attendance/mark-range',      authenticate, attCtrl.markRange);




// ── WFH (Work From Home) ──────────────────────────────────────────────────────
router.post('/wfh/apply',       authenticate, attImportCtrl.applyWFH);
router.get ('/wfh',             authenticate, attImportCtrl.getWFH);
router.post('/wfh/:id/action',  authenticate, attImportCtrl.actionWFH);

// ── Leave ─────────────────────────────────────────────────────────────────────
router.get('/leave-types', authenticate, async (req, res) => {
  try {
    const db = require('../config/db');
    const empId = req.user.id;

    // Determine if this employee is currently on provisional period
    const empRes = await db.query(
      `SELECT employee_category, provision_end_date, joining_date FROM employees WHERE id=$1`,
      [empId]
    );
    const emp = empRes.rows[0];
    const now = new Date();

    // Contractual: provisional if still within 6 months of joining
    const joiningDate = emp?.joining_date ? new Date(emp.joining_date) : null;
    const sixMonthMark = joiningDate
      ? new Date(new Date(joiningDate).setMonth(joiningDate.getMonth() + 6))
      : null;
    const isContractualProvisional =
      emp?.employee_category === 'contractual' && sixMonthMark && now < sixMonthMark;

    // Provision category: provisional until provision_end_date passes
    const provisionEndDate = emp?.provision_end_date ? new Date(emp.provision_end_date) : null;
    const isProvisional =
      isContractualProvisional ||
      (emp?.employee_category === 'provision' && provisionEndDate && provisionEndDate > now);

    // Provisional employees: only PL. Confirmed employees: everything except PL.
    const codeFilter = isProvisional
      ? `AND code = 'PL'`
      : `AND code != 'PL'`;

    const r = await db.query(
      `SELECT id, name, code, days_allowed, monthly_accrual,
              carry_forward, max_carry_forward, is_paid, applicable_gender, is_active
       FROM leave_types WHERE is_active=true ${codeFilter} ORDER BY name`
    );
    res.json({ success: true, data: r.rows });
  } catch(e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

router.post('/leave/apply',           authenticate,                        leaveCtrl.apply);
router.get ('/leave/requests',        authenticate,                        leaveCtrl.getRequests);
router.get ('/leave/applications',    authenticate,                        leaveCtrl.getRequests);
router.get ('/leave/balance',         authenticate,                        leaveCtrl.getBalance);
router.post('/leave/:id/action',      authenticate,                        leaveCtrl.action);
router.put ('/leave/:id/action',      authenticate,                        leaveCtrl.action);
router.post('/leave/:id/cancel',      authenticate,                        leaveCtrl.cancel);
router.post('/leave/:id/revoke',      authenticate,                        leaveCtrl.revoke);
router.put ('/leave/balance',         authenticate, authorize(...HR_ADMIN), leaveCtrl.updateBalance);
router.post('/leave/monthly-accrual',        authenticate, authorize(...HR_ADMIN), leaveCtrl.monthlyAccrual);
router.post('/leave/recalculate/:id',        authenticate, authorize(...HR_ADMIN), leaveCtrl.recalculateEmployee);
router.get ('/leave/report',                 authenticate,                        leaveCtrl.getLeaveReport);
router.get ('/leave/summary',                authenticate, authorize(...HR_ADMIN), leaveCtrl.getLeaveSummary);
router.get ('/leave/transactions',           authenticate, authorize(...HR_ADMIN), leaveCtrl.getLeaveTransactions);


// ── Advance Salary ────────────────────────────────────────────────────────────
router.post('/advance/apply',                authenticate, advCtrl.apply);
router.get ('/advance/mine',                 authenticate, advCtrl.getMine);
router.get ('/advance',                      authenticate, advCtrl.getAll);
router.post('/advance/:id/action',           authenticate, advCtrl.action);
router.post('/advance/:id/revoke',           authenticate, advCtrl.revoke);
router.delete('/advance/:id/dismiss',        authenticate, advCtrl.dismiss);
router.post('/advance/:id/edit',             authenticate, advCtrl.edit);
router.post('/advance/:id/process-payment',  authenticate, authorize('accounts'), advCtrl.processPayment);
router.get ('/advance/:id/approvals',        authenticate, advCtrl.getApprovals);
router.get ('/advance/emi/list',             authenticate, authorize('accounts','hr','super_admin'), advCtrl.getEMIList);
router.post('/advance/emi',                  authenticate, authorize('accounts'), advCtrl.upsertEMI);
router.put ('/advance/emi/:id',              authenticate, authorize('accounts'), advCtrl.upsertEMI);
router.get ('/advance/emi/employee/:employee_id', authenticate, authorize('accounts','hr'), advCtrl.getActiveEMI);
router.post('/advance/:id/mark-disbursed',       authenticate, authorize('accounts'), advCtrl.markDisbursedWithEMI);
router.post('/advance/emi/:id/mark-paid',         authenticate, authorize('accounts'), advCtrl.markEMIPaid);

// ── Reimbursement ─────────────────────────────────────────────────────────────
const reimbCtrl = require('../controllers/reimbursementController');
router.post  ('/reimbursement/apply',               authenticate, reimbCtrl.apply);
router.post  ('/reimbursement/draft',               authenticate, reimbCtrl.saveDraft);
router.post  ('/reimbursement/:id/submit-draft',    authenticate, reimbCtrl.submitDraft);
router.get   ('/reimbursement/export',              authenticate, reimbCtrl.exportData);
router.get   ('/reimbursement',                     authenticate, reimbCtrl.getAll);
router.post  ('/reimbursement/:id/action',          authenticate, reimbCtrl.action);
router.post  ('/reimbursement/:id/revoke',          authenticate, reimbCtrl.revoke);
router.put   ('/reimbursement/:id/edit',            authenticate, reimbCtrl.edit);
router.post  ('/reimbursement/:id/disburse',        authenticate, authorize('accounts'), reimbCtrl.disburse);
router.get   ('/reimbursement/:id/approvals',       authenticate, reimbCtrl.getApprovals);
router.post  ('/reimbursement/item/:id/attachment', authenticate, reimbCtrl.uploadMiddleware, reimbCtrl.uploadAttachment);
router.get   ('/reimbursement/item/:id/attachment', authenticate, reimbCtrl.getAttachment);

// ── Payroll ───────────────────────────────────────────────────────────────────
router.get ('/payroll',              authenticate,                     payCtrl.getPayroll);
router.get ('/payroll/payslip',      authenticate,                     payCtrl.getPayslip);
router.get ('/my/payslip',           authenticate,                     payCtrl.getPayslip);
router.get ('/my/payslip-months',    authenticate, async (req, res) => {
  const db    = require('../config/db');
  const empId = req.user.id;
  const r     = await db.query(
    `SELECT DISTINCT month, year, status FROM payroll WHERE employee_id=$1 ORDER BY year DESC, month DESC LIMIT 6`,
    [empId]
  );
  res.json({ success: true, data: r.rows });
});
router.post('/payroll/process',      authenticate, authorize(...ACCOUNTS), async (req, res) => {
  res.json({ success: true, message: 'Use /payroll/upload to process payroll via Excel upload.' });
});
router.get ('/payroll/uploads',                   authenticate, authorize(...ACCOUNTS), payCtrl.getUploads);
router.get ('/payroll/salary-structures',         authenticate, authorize(...HR_ADMIN), payCtrl.getAllSalaryStructures);
router.get ('/payroll/salary-structure/:employee_id', authenticate,                    payCtrl.getSalaryStructure);
router.post('/payroll/salary-structure',          authenticate, authorize(...HR_ADMIN), payCtrl.upsertSalaryStructure);
router.post('/payroll/upload',                    authenticate, authorize('accounts'), payCtrl.uploadMiddleware, payCtrl.uploadPayroll);
router.get ('/payroll/template',                  authenticate, authorize('accounts','hr','super_admin'), payCtrl.downloadPayrollTemplate);
router.get ('/payroll/form16/years',              authenticate,                        payCtrl.getForm16Years);
router.get ('/payroll/form16',                    authenticate,                        payCtrl.getForm16);


// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    const db    = require('../config/db');
    const empId = req.user.id;
    // FIX: Use IST date — server runs UTC on Render
    const istToday = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone || 'Asia/Kolkata',
      year:'numeric', month:'2-digit', day:'2-digit'
    }).format(new Date());

    const attRes = await db.query(
      `SELECT *,
              TO_CHAR(punch_in::time,'HH12:MI AM')  AS punch_in_time,
              TO_CHAR(punch_out::time,'HH12:MI AM') AS punch_out_time,
              TO_CHAR(date,'YYYY-MM-DD')      AS date_str
       FROM attendance WHERE employee_id=$1 AND date=$2`,
      [empId, istToday]
    );

    // ── Auto-mark KC718 / super_admin as Present if no record exists today ────
    // They don't punch in/out; absence of a record = present on working days
    let todayAtt = attRes.rows[0] || null;
    const isSpecialUser = req.user.role === 'super_admin' || req.user.employee_code === CONFIG.cooEmployeeCode;
    if (isSpecialUser && !todayAtt) {
      // Only auto-present on working days (not Sunday, not 2nd/4th Saturday)
      const todayDate = new Date(new Date().toLocaleString('en-US', { timeZone: CONFIG.timezone || 'Asia/Kolkata' }));
      const dow = todayDate.getDay();
      const dayOfMonth = todayDate.getDate();
      // Rough 2nd/4th Saturday check
      const isSat = dow === 6;
      const satNum = Math.ceil(dayOfMonth / 7);
      const is2nd4thSat = isSat && (satNum === 2 || satNum === 4);
      const isSun = dow === 0;
      // Check if today is a public holiday
      const holCheck = await db.query(
        `SELECT 1 FROM holidays WHERE date=$1 AND (region='all' OR region='south_west' OR region='north') LIMIT 1`,
        [istToday]
      );
      const isHoliday = holCheck.rows.length > 0;

      if (!isSun && !is2nd4thSat && !isHoliday) {
        // Auto-insert present record
        try {
          await db.query(
            `INSERT INTO attendance(employee_id, date, status, remarks, punch_in_location)
             VALUES($1, $2, 'present', 'Auto-marked', 'Auto')
             ON CONFLICT(employee_id, date) DO NOTHING`,
            [empId, istToday]
          );
          // Re-fetch to return fresh record
          const freshAtt = await db.query(
            `SELECT *, TO_CHAR(date,'YYYY-MM-DD') AS date_str FROM attendance WHERE employee_id=$1 AND date=$2`,
            [empId, istToday]
          );
          todayAtt = freshAtt.rows[0] || { status: 'present', date_str: istToday };
        } catch (_) {
          // Non-critical: if insert fails just return synthetic present
          todayAtt = { status: 'present', date_str: istToday };
        }
      }
    }

    const now   = new Date();
    const istParts = new Intl.DateTimeFormat('en-IN', { timeZone:CONFIG.timezone || 'Asia/Kolkata',
      year:'numeric', month:'2-digit', day:'2-digit'
    }).formatToParts(now);
    const istP = {}; istParts.forEach(({type,value}) => { istP[type]=value; });
    const month = parseInt(istP.month);
    const year  = parseInt(istP.year);
    const msRes = await db.query(
      `SELECT
        COUNT(*) FILTER (WHERE status IN ('present','late','half-day')) AS present,
        COUNT(*) FILTER (WHERE status='absent') AS absent,
        COALESCE(SUM(working_hours),0) AS total_hours,
        COALESCE(AVG(working_hours) FILTER (
          WHERE working_hours > 0
            AND status IN ('present','late','regularized','od')
        ), 0) AS avg_hours
       FROM attendance
       WHERE employee_id=$1
         AND EXTRACT(MONTH FROM date)=$2
         AND EXTRACT(YEAR  FROM date)=$3`,
      [empId, month, year]
    );

    let pendingCount = 0;
    let pendingRegCount = 0;
    if (['manager','hr','admin','super_admin','tl'].includes(req.user.role)) {
      const pRes = await db.query(
        `SELECT COUNT(*) FROM leave_requests
         WHERE status='pending'
           AND employee_id != $1
           AND (
             current_approver_code = (SELECT employee_code FROM employees WHERE id=$1)
             OR $2 IN ('hr','super_admin')
           )`,
        [empId, req.user.role]
      );
      pendingCount = parseInt(pRes.rows[0].count) || 0;

      // Also count pending regularization requests — direct reports only
      // (Regularization goes to direct manager, not up the full tree)
      let regCond = '';
      let regParams = [];
      if (['super_admin','hr'].includes(req.user.role)) {
        regParams = [];
        regCond = `WHERE a.regularization_status='pending'`;
      } else if (['admin','manager'].includes(req.user.role)) {
        regParams = [empId];
        regCond = `WHERE a.regularization_status='pending' AND e.reporting_manager_id=$1`;
      } else if (req.user.role === 'tl') {
        regParams = [empId];
        regCond = `WHERE a.regularization_status='pending' AND (e.team_leader_id=$1 OR e.id=$1)`;
      }
      if (regCond) {
        const rRes = await db.query(
          `SELECT COUNT(*) FROM attendance a
           JOIN employees e ON e.id=a.employee_id
           ${regCond}`, regParams
        );
        pendingRegCount = parseInt(rRes.rows[0].count) || 0;
      }
    }

    // Count unread notifications for the logged-in employee
    const unreadNotifRes = await db.query(
      `SELECT COUNT(*) FROM notifications
       WHERE employee_id=$1 AND is_read=false
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [empId]
    );
    const unreadNotifCount = parseInt(unreadNotifRes.rows[0].count) || 0;

    res.json({
      success: true,
      data: {
        today_attendance:             todayAtt,
        monthly_summary:              msRes.rows[0]  || {},
        pending_leave_approvals:      pendingCount,
        pending_regularizations:      pendingRegCount,
        unread_notifications:         unreadNotifCount,
      }
    });
  } catch(e) {
    console.error('Dashboard error:', e.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Announcements ─────────────────────────────────────────────────────────────
router.get ('/announcements/feed',               authenticate,                         annCtrl.getFeed);
router.get ('/announcements',                    authenticate,                         annCtrl.getAll);
router.post('/announcements',                    authenticate, authorize(...HR_ADMIN), annCtrl.uploadMiddleware, annCtrl.create);
router.put ('/announcements/:id',                authenticate, authorize(...HR_ADMIN), annCtrl.uploadMiddleware, annCtrl.update);
router.delete('/announcements/:id',              authenticate, authorize(...HR_ADMIN), annCtrl.delete);
// Fix 1: Like & Comment
router.post('/announcements/:id/like',           authenticate,                         annCtrl.toggleLike);
router.get ('/announcements/:id/comments',       authenticate,                         annCtrl.getComments);
router.post('/announcements/:id/comments',       authenticate,                         annCtrl.addComment);
router.delete('/announcements/:id/comments/:commentId', authenticate,                  annCtrl.deleteComment);

// ── GK Quiz ───────────────────────────────────────────────────────────────────
router.post  ('/gk/answer',             authenticate,                         gkCtrl.submitAnswer);
router.get   ('/gk/leaderboard',        authenticate,                         gkCtrl.getLeaderboard);
router.get   ('/gk/question',           authenticate,                         gkCtrl.getQuestion);
router.get   ('/gk/thought',            authenticate,                         gkCtrl.getThought);
router.get   ('/gk/my-stats',           authenticate,                         gkCtrl.getMyStats);
router.get   ('/gk/responses',          authenticate, authorize(...HR_ADMIN), gkCtrl.getResponses);
router.get   ('/gk/questions',          authenticate, authorize(...HR_ADMIN), gkCtrl.getQuestions);
router.post  ('/gk/questions',          authenticate, authorize(...HR_ADMIN), gkCtrl.createQuestion);
router.put   ('/gk/questions/:id',      authenticate, authorize(...HR_ADMIN), gkCtrl.updateQuestion);
router.delete('/gk/questions/:id',      authenticate, authorize(...HR_ADMIN), gkCtrl.deleteQuestion);
router.get   ('/gk/thoughts',           authenticate, authorize(...HR_ADMIN), gkCtrl.getThoughts);
router.post  ('/gk/thoughts',           authenticate, authorize(...HR_ADMIN), gkCtrl.createThought);
router.delete('/gk/thoughts/:id',       authenticate, authorize(...HR_ADMIN), gkCtrl.deleteThought);
router.get   ('/gk/export/scores',      authenticate, authorize(...HR_ADMIN), gkCtrl.exportScores);
router.get   ('/gk/export/yearly',      authenticate, authorize(...HR_ADMIN), gkCtrl.exportYearly);
router.get   ('/gk/export/responses',   authenticate, authorize(...HR_ADMIN), gkCtrl.exportResponses);

// ── Import Thoughts + GK from Excel (single combined upload) ─────────────────
router.post('/gk/import',
  authenticate, authorize(...HR_ADMIN),
  gkCtrl.uploadMiddleware,
  gkCtrl.importBoth
);
// Individual sheet imports (fallback)
router.post('/gk/questions/import',
  authenticate, authorize(...HR_ADMIN),
  gkCtrl.uploadMiddleware,
  gkCtrl.importQuestions
);
router.post('/gk/thoughts/import',
  authenticate, authorize(...HR_ADMIN),
  gkCtrl.uploadMiddleware,
  gkCtrl.importThoughts
);

// ── Geofence ──────────────────────────────────────────────────────────────────
router.get   ('/geofence/locations',                          authenticate,                           geoCtrl.getLocations);
router.post  ('/geofence/locations',                          authenticate, authorize('admin','super_admin','hr'), geoCtrl.createLocation);
router.put   ('/geofence/locations/:id',                      authenticate, authorize('admin','super_admin','hr'), geoCtrl.updateLocation);
router.delete('/geofence/locations/:id',                      authenticate, authorize('admin','super_admin','hr'), geoCtrl.deleteLocation);
router.get   ('/geofence/locations/:id/employees',            authenticate, authorize('admin','super_admin','hr'), geoCtrl.getLocationEmployees);
router.get   ('/geofence/locations/:id/unassigned',           authenticate, authorize('admin','super_admin','hr'), geoCtrl.getUnassignedEmployees);
router.get   ('/geofence/employees',                          authenticate, authorize('admin','super_admin','hr'), geoCtrl.getEmployeesForLocation);
router.post  ('/geofence/validate',                           authenticate,                           geoCtrl.validatePunch);
router.get   ('/geofence/my-locations',                       authenticate,                           geoCtrl.getMyLocations);
router.get   ('/geofence/logs',                               authenticate,                           geoCtrl.getLogs);
router.get   ('/geofence/employee/:employee_id',              authenticate,                           geoCtrl.getEmployeeGeofence);
router.post  ('/geofence/assign',                             authenticate, authorize('admin','super_admin','hr'), geoCtrl.assignBuffer);
router.post  ('/geofence/bulk-assign',                        authenticate, authorize('admin','super_admin','hr'), geoCtrl.bulkAssignBuffer);
router.get   ('/geofence/unassigned-employees',                 authenticate, authorize('admin','super_admin','hr'), geoCtrl.getUnassignedToAnyLocation);
router.post  ('/geofence/fix-office-universal',               authenticate, authorize('admin','super_admin','hr'), geoCtrl.fixOfficeUniversal);
router.patch ('/geofence/:employee_id/:location_id/toggle',   authenticate, authorize('admin','super_admin','hr'), geoCtrl.toggleUniversal);
router.delete('/geofence/:employee_id/:location_id',          authenticate, authorize('admin','super_admin'), geoCtrl.removeBuffer);

// ── Buffer Rules ──────────────────────────────────────────────────────────────
router.post  ('/geofence/validate-buffer',                    authenticate,                           geoCtrl.validateBuffer);
router.get   ('/geofence/boundary',                           authenticate,                           geoCtrl.getBoundary);
router.get   ('/geofence/buffer-rules',                       authenticate, authorize('admin','super_admin','hr'), geoCtrl.getAllBufferRules);
router.get   ('/geofence/buffer-rules/:employee_id',          authenticate, authorize('admin','super_admin','hr'), geoCtrl.getBufferRule);
router.post  ('/geofence/buffer-rules',                       authenticate, authorize('admin','super_admin','hr'), geoCtrl.upsertBufferRule);
router.put   ('/geofence/buffer-rules/:employee_id',          authenticate, authorize('admin','super_admin','hr'), geoCtrl.upsertBufferRule);
router.delete('/geofence/buffer-rules/:employee_id',          authenticate, authorize('admin','super_admin'), geoCtrl.deleteBufferRule);

// ── Separation ────────────────────────────────────────────────────────────────
// NOTE: Specific/static routes MUST come before generic routes (POST /separations,
//       GET /separations) to avoid Express matching them against the HR_ADMIN guard.
router.get ('/separations/notice-period',        authenticate,                                                        sepCtrl.getNoticePeriod);
router.post('/separations/resign',               authenticate,                                                        sepCtrl.submitResignation);
router.post('/separations/process-lwd',          authenticate, authorize('super_admin','admin'),                      sepCtrl.processLWD);
router.get ('/separations/my',                   authenticate,                                                        sepCtrl.getMySeparations);
router.get ('/separations/:id',                  authenticate,                                                        sepCtrl.getOne);
router.post('/separations/:id/withdraw',         authenticate,                                                        sepCtrl.withdraw);
router.post('/separations/:id/manager-action',   authenticate, authorize('manager','tl','admin','super_admin'),       sepCtrl.managerAction);
router.post('/separations/:id/hr-action',        authenticate, authorize('hr','admin','super_admin'),                 sepCtrl.hrAction);
router.post('/separations/:id/accounts-action',  authenticate, authorize('accounts','admin','super_admin'),           sepCtrl.accountsAction);
router.post('/separations/:id/admin-action',     authenticate, authorize('admin','super_admin'),                      sepCtrl.adminAction);
// Generic routes last
router.get ('/separations',                      authenticate, authorize(...HR_ADMIN),                                sepCtrl.getAll);
router.post('/separations',                      authenticate, authorize(...HR_ADMIN),                                sepCtrl.initiate);

// ── Notifications ─────────────────────────────────────────────────────────────
router.get('/notifications', authenticate, async (req, res) => {
  try {
    const db     = require('../config/db');
    const result = await db.query(
      `SELECT * FROM notifications WHERE employee_id=$1 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    const unread = result.rows.filter(n => !n.is_read).length;
    res.json({ success: true, data: result.rows, unread });
  } catch(e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// read-all MUST come before :id/read to prevent route conflict
router.patch('/notifications/read-all', authenticate, async (req, res) => {
  try {
    await require('../config/db').query(
      `UPDATE notifications SET is_read=true WHERE employee_id=$1`,
      [req.user.id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

router.patch('/notifications/:id/read', authenticate, async (req, res) => {
  try {
    await require('../config/db').query(
      `UPDATE notifications SET is_read=true WHERE id=$1 AND employee_id=$2`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ── Departments & Designations ────────────────────────────────────────────────
router.get('/departments', authenticate, async (req, res) => {
  const r = await require('../config/db').query('SELECT * FROM departments ORDER BY name');
  res.json({ success: true, data: r.rows });
});
router.get('/designations', authenticate, async (req, res) => {
  const r = await require('../config/db').query('SELECT * FROM designations ORDER BY title');
  res.json({ success: true, data: r.rows });
});

// ── Holidays ──────────────────────────────────────────────────────────────────
router.get('/holidays', authenticate, async (req, res) => {
  try {
    const db   = require('../config/db');
    const { getEmployeeRegion } = require('../config/regionHelper');
    const year = parseInt(req.query.year) || new Date().getFullYear();

    // Get employee's city/state
    const empInfo = await db.query(
      `SELECT e.city, e.state, e.reporting_manager_id,
              m.city AS mgr_city, m.state AS mgr_state
       FROM employees e
       LEFT JOIN employees m ON e.reporting_manager_id = m.id
       WHERE e.id=$1`, [req.user.id]
    );
    const emp = empInfo.rows[0];
    const city  = emp?.city  || '';
    const state = emp?.state || '';

    // WFH or blank location → use manager's location as fallback
    const isWFH = city.toLowerCase().includes('work from home') ||
                  city.toLowerCase().includes('wfh') ||
                  (!city.trim() && !state.trim());

    const region = isWFH
      ? getEmployeeRegion(emp?.mgr_city || '', emp?.mgr_state || '')
      : getEmployeeRegion(city, state);

    const r = await db.query(
      `SELECT id, name, TO_CHAR(date,'YYYY-MM-DD') AS date, type, region, description, year
       FROM holidays
       WHERE year=$1 AND (region='all' OR region=$2)
       ORDER BY date ASC`,
      [year, region]
    );
    res.json({ success: true, data: r.rows });
  } catch(e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ── Birthdays ─────────────────────────────────────────────────────────────────

// GET /birthdays/upcoming — today + next 7 days, with like/wish counts
router.get('/birthdays/upcoming', authenticate, async (req, res) => {
  try {
    const db     = require('../config/db');
    const empId  = req.user.id;
    const today  = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone || 'Asia/Kolkata',
      year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());

    // Fetch employees whose birthday falls in next 7 days (month/day match, ignore year)
    const result = await db.query(`
      SELECT
        e.id,
        CONCAT(e.first_name,' ',e.last_name) AS full_name,
        e.employee_code,
        d.name   AS department_name,
        des.title AS designation_title,
        TO_CHAR(e.date_of_birth,'MM-DD') AS birth_md,
        TO_CHAR(e.date_of_birth,'DD Mon') AS birth_display,
        gs.offset_days AS days_until,
        COALESCE((SELECT COUNT(*) FROM birthday_likes  bl WHERE bl.birthday_emp_id=e.id AND bl.like_date=$1),0) AS like_count,
        COALESCE((SELECT COUNT(*) FROM birthday_wishes bw WHERE bw.birthday_emp_id=e.id AND bw.wish_date=$1),0) AS wish_count,
        COALESCE(EXISTS(SELECT 1 FROM birthday_likes  bl WHERE bl.birthday_emp_id=e.id AND bl.from_emp_id=$2 AND bl.like_date=$1),false) AS i_liked,
        COALESCE(EXISTS(SELECT 1 FROM birthday_wishes bw WHERE bw.birthday_emp_id=e.id AND bw.from_emp_id=$2 AND bw.wish_date=$1),false) AS i_wished
      FROM employees e
      JOIN generate_series(0, 7) AS gs(offset_days)
        ON TO_CHAR(e.date_of_birth, 'MM-DD') = TO_CHAR((NOW() AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}')::date + (gs.offset_days || ' days')::interval, 'MM-DD')
      LEFT JOIN departments  d   ON e.department_id  = d.id
      LEFT JOIN designations des ON e.designation_id = des.id
      WHERE e.is_active = TRUE
        AND e.date_of_birth IS NOT NULL
      ORDER BY gs.offset_days ASC, e.first_name ASC
    `, [today, empId]);

    res.json({ success: true, data: result.rows });
  } catch(e) {
    console.error('Birthday fetch error:', e.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /birthdays/:id/like — toggle like for today's birthday
router.post('/birthdays/:id/like', authenticate, async (req, res) => {
  try {
    const db           = require('../config/db');
    const birthdayEmpId = parseInt(req.params.id);
    const fromEmpId    = req.user.id;
    const today        = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone || 'Asia/Kolkata',
      year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());

    // Check if already liked
    const existing = await db.query(
      `SELECT id FROM birthday_likes WHERE birthday_emp_id=$1 AND from_emp_id=$2 AND like_date=$3`,
      [birthdayEmpId, fromEmpId, today]
    );

    if (existing.rows.length) {
      // Unlike
      await db.query(`DELETE FROM birthday_likes WHERE id=$1`, [existing.rows[0].id]);
      return res.json({ success: true, liked: false, message: 'Like removed' });
    }

    // Like
    await db.query(
      `INSERT INTO birthday_likes(birthday_emp_id, from_emp_id, like_date) VALUES($1,$2,$3)`,
      [birthdayEmpId, fromEmpId, today]
    );

    // Notify the birthday person
    const liker = await db.query(`SELECT first_name, last_name FROM employees WHERE id=$1`, [fromEmpId]);
    if (liker.rows.length) {
      await db.query(
        `INSERT INTO notifications(employee_id, title, message, type)
         VALUES($1,'❤️ Birthday Like',$2,'birthday')
         ON CONFLICT DO NOTHING`,
        [birthdayEmpId, `${liker.rows[0].first_name} ${liker.rows[0].last_name} liked your birthday! 🎂`]
      );
    }

    const count = await db.query(
      `SELECT COUNT(*) FROM birthday_likes WHERE birthday_emp_id=$1 AND like_date=$2`,
      [birthdayEmpId, today]
    );
    res.json({ success: true, liked: true, like_count: parseInt(count.rows[0].count) });
  } catch(e) {
    console.error('Birthday like error:', e.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /birthdays/:id/wish — send a birthday wish
router.post('/birthdays/:id/wish', authenticate, async (req, res) => {
  try {
    const db            = require('../config/db');
    const birthdayEmpId = parseInt(req.params.id);
    const fromEmpId     = req.user.id;
    const { message }   = req.body;
    const today         = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone || 'Asia/Kolkata',
      year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());

    if (!message?.trim())
      return res.status(400).json({ success: false, message: 'Message required' });

    await db.query(
      `INSERT INTO birthday_wishes(birthday_emp_id, from_emp_id, wish_date, message)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(birthday_emp_id, from_emp_id, wish_date) DO UPDATE SET message=EXCLUDED.message`,
      [birthdayEmpId, fromEmpId, today, message.trim()]
    );

    // Notify birthday person
    const wisher = await db.query(`SELECT first_name, last_name FROM employees WHERE id=$1`, [fromEmpId]);
    if (wisher.rows.length) {
      await db.query(
        `INSERT INTO notifications(employee_id, title, message, type)
         VALUES($1,'🎂 Birthday Wish',$2,'birthday')`,
        [birthdayEmpId, `${wisher.rows[0].first_name} ${wisher.rows[0].last_name}: "${message.trim().slice(0,80)}"`]
      );
    }

    res.json({ success: true, message: 'Wish sent! 🎉' });
  } catch(e) {
    console.error('Birthday wish error:', e.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /birthdays/:id/wishes — get all wishes for a birthday person today
router.get('/birthdays/:id/wishes', authenticate, async (req, res) => {
  try {
    const db = require('../config/db');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone || 'Asia/Kolkata',
      year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());

    const result = await db.query(`
      SELECT bw.id, bw.message, bw.created_at,
             bw.from_emp_id,
             CONCAT(e.first_name,' ',e.last_name) AS from_name,
             e.employee_code AS from_code
      FROM birthday_wishes bw
      JOIN employees e ON e.id = bw.from_emp_id
      WHERE bw.birthday_emp_id=$1 AND bw.wish_date=$2
      ORDER BY bw.created_at DESC
    `, [parseInt(req.params.id), today]);

    res.json({ success: true, data: result.rows });
  } catch(e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /birthdays/wishes/:id — delete own wish
router.delete('/birthdays/wishes/:id', authenticate, async (req, res) => {
  try {
    const db     = require('../config/db');
    const wishId = parseInt(req.params.id);
    const empId  = req.user.id;
    // Only allow deleting own wishes
    const result = await db.query(
      `DELETE FROM birthday_wishes WHERE id=$1 AND from_emp_id=$2 RETURNING id`,
      [wishId, empId]
    );
    if (!result.rows.length)
      return res.status(403).json({ success: false, message: 'Not found or not your wish' });
    res.json({ success: true, message: 'Wish deleted' });
  } catch(e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Work Anniversaries ────────────────────────────────────────────────────────
// GET /anniversaries/upcoming — today + next 7 days work anniversaries
router.get('/anniversaries/upcoming', authenticate, async (req, res) => {
  try {
    const db    = require('../config/db');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone || 'Asia/Kolkata',
      year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
    const todayIST   = new Date(new Date().toLocaleString('en-US', { timeZone: CONFIG.timezone || 'Asia/Kolkata' }));
    const currentYear = todayIST.getFullYear();
    const fromEmpId  = req.user.id;

    // Find employees whose joining date MM-DD falls in today → next 7 days
    const result = await db.query(
      `SELECT
         e.id, e.employee_code,
         CONCAT(e.first_name,' ',e.last_name) AS full_name,
         e.joining_date,
         d.name AS department_name,
         des.title AS designation_title,
         TO_CHAR(e.joining_date,'MM-DD') AS join_md,
         TO_CHAR(e.joining_date,'DD Mon') AS join_display,
         ($1::int - EXTRACT(YEAR FROM e.joining_date)::int) AS years_completed,
         CASE
           WHEN TO_CHAR(e.joining_date,'MMDD') = TO_CHAR(NOW() AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}','MMDD')
           THEN 0
           ELSE (
             TO_DATE(TO_CHAR($1::int,'9999') || '-' || TO_CHAR(e.joining_date,'MM-DD'), 'YYYY-MM-DD')
             - CURRENT_DATE
           )
         END AS days_until,
         COALESCE(EXISTS(
           SELECT 1 FROM birthday_likes bl
           WHERE bl.birthday_emp_id=e.id AND bl.from_emp_id=$2 AND bl.like_date=$3
         ),false) AS i_liked,
         COALESCE((SELECT COUNT(*) FROM birthday_likes bl
           WHERE bl.birthday_emp_id=e.id AND bl.like_date=$3),0) AS like_count,
         COALESCE(EXISTS(
           SELECT 1 FROM birthday_wishes bw
           WHERE bw.birthday_emp_id=e.id AND bw.from_emp_id=$2 AND bw.wish_date=$3
         ),false) AS i_wished,
         COALESCE((SELECT COUNT(*) FROM birthday_wishes bw
           WHERE bw.birthday_emp_id=e.id AND bw.wish_date=$3),0) AS wish_count
       FROM employees e
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN designations des ON e.designation_id = des.id
       WHERE e.is_active = true
         AND e.joining_date IS NOT NULL
         AND EXTRACT(YEAR FROM e.joining_date) < $1
         AND (
           TO_CHAR(e.joining_date,'MMDD') = TO_CHAR(NOW() AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}','MMDD')
           OR (
             TO_CHAR(e.joining_date,'MMDD') > TO_CHAR(NOW() AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}','MMDD')
             AND TO_CHAR(e.joining_date,'MMDD') <= TO_CHAR((NOW() AT TIME ZONE '${CONFIG.timezone || "Asia/Kolkata"}' + INTERVAL '7 days'),'MMDD')
           )
         )
       ORDER BY TO_CHAR(e.joining_date,'MMDD') ASC`,
      [currentYear, fromEmpId, today]
    );

    res.json({ success: true, data: result.rows });
  } catch(e) {
    console.error('Anniversary fetch error:', e.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Offer Letters ─────────────────────────────────────────────────────────────

// ── Test Email (debug only) ───────────────────────────────────────────────────
router.get('/test-email', authenticate, async (req, res) => {
  try {
    const emailSvc = require('../config/emailService');
    const emp = await require('../config/db').query(
      `SELECT email, first_name FROM employees WHERE id=$1`, [req.user.id]
    );
    const email = emp.rows[0]?.email;
    if (!email) return res.json({ success: false, message: 'No email found for your account' });

    await emailSvc.send({
      to:      email,
      toName:  emp.rows[0].first_name,
      subject: '✅ HRMS Email Test',
      preview: 'Email system is working!',
      html: `
        <div style="font-size:24px;text-align:center;padding:20px">✅</div>
        <div style="font-size:18px;font-weight:700;text-align:center;color:#1B5E20">Email System Working!</div>
        <p style="text-align:center;color:#555;margin-top:12px">
          This is a test email from HRMS.<br>
          Sent to: <strong>${email}</strong><br>
          Time: ${new Date().toLocaleString('en-IN', { timeZone: CONFIG.timezone || 'Asia/Kolkata' })}
        </p>
        <p style="text-align:center;font-size:12px;color:#999">
          EMAIL_ENABLED=${process.env.EMAIL_ENABLED}<br>
          EMAIL_FROM=${process.env.EMAIL_FROM}<br>
          BREVO_USER=${process.env.BREVO_SMTP_USER}
        </p>`
    });

    res.json({ success: true, message: `Test email sent to ${email}` });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── IT Declaration & Tax ──────────────────────────────────────────────────────
router.get   ('/it-declaration',              authenticate,                     itDeclCtrl.getDeclaration);
router.get   ('/it-declaration/all',          authenticate, authorize('hr','accounts'), itDeclCtrl.getAllDeclarations);
router.get   ('/it-declaration/tax-preview',  authenticate,                     itDeclCtrl.taxPreview);
router.get   ('/it-declaration/proofs',       authenticate, authorize('hr','accounts'), itDeclCtrl.getProofsByDeclaration);
router.post  ('/it-declaration',              authenticate,                     itDeclCtrl.saveDeclaration);
router.post  ('/it-declaration/proof',        authenticate, itDeclCtrl.uploadMiddleware, itDeclCtrl.uploadProof);
router.get   ('/it-declaration/proof/:id',    authenticate,                     itDeclCtrl.getProof);
router.get   ('/it-declaration/:id',           authenticate, authorize('hr','accounts','admin','super_admin'), itDeclCtrl.getDeclarationById);
router.post  ('/it-declaration/:id/review',   authenticate, authorize('hr','accounts'), itDeclCtrl.reviewDeclaration);
router.post  ('/it-declaration/proof/:id/review', authenticate, authorize('hr','accounts'), itDeclCtrl.reviewProof);

// ── Project Budget Tracking ───────────────────────────────────────────────────
const projCtrl = require('../controllers/projectController');

router.get   ('/projects/summary',                  authenticate, authorize('accounts','super_admin','admin'), projCtrl.getSummary);
router.get   ('/projects/pending-reports',          authenticate, projCtrl.pendingReports);
router.get   ('/projects/employees/:empId/allocation', authenticate, authorize('accounts','super_admin','admin'), projCtrl.getEmployeeAllocation);
router.put   ('/projects/employees/:empId/allocation', authenticate, authorize('accounts','super_admin','admin'), projCtrl.setSalaryAllocation);
router.get   ('/projects',                          authenticate, authorize('accounts','super_admin','admin','manager','tl','hr'), projCtrl.listProjects);
router.post  ('/projects',                          authenticate, authorize('accounts','super_admin','admin'), projCtrl.createProject);
router.get   ('/projects/:id',                      authenticate, authorize('accounts','super_admin','admin','manager','tl','hr'), projCtrl.getProject);
router.put   ('/projects/:id',                      authenticate, authorize('accounts','super_admin','admin'), projCtrl.updateProject);
router.delete('/projects/:id',                      authenticate, authorize('accounts','super_admin','admin'), projCtrl.deleteProject);
router.post  ('/projects/:id/assign',               authenticate, authorize('accounts','super_admin','admin'), projCtrl.assignEmployee);
router.delete('/projects/:id/employees/:empId',     authenticate, authorize('accounts','super_admin','admin'), projCtrl.removeEmployee);
router.post  ('/projects/:id/expenditure',          authenticate, authorize('accounts','super_admin','admin'), projCtrl.addExpenditure);
router.get   ('/projects/:id/expenditures',         authenticate, authorize('accounts','super_admin','admin','manager'), projCtrl.getExpenditures);
router.get   ('/projects/:id/export',               authenticate, authorize('accounts','super_admin','admin'), projCtrl.exportProjectExcel);
router.get   ('/projects/:id/reports',              authenticate, projCtrl.listReports);
router.post  ('/projects/:id/reports',              authenticate, projCtrl.submitReport);
router.patch ('/projects/reports/:reportId',        authenticate, projCtrl.updateReport);

// ═══════════════════════════════════════════════════════════════════════════════
// CHAT ROUTES — v3 (WhatsApp + Google Meet grade)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Groups ───────────────────────────────────────────────────────────────────
router.get   ('/chat/groups',                             authenticate, chatCtrl.listGroups);
router.post  ('/chat/groups',                             authenticate, chatCtrl.createGroup);
router.get   ('/chat/groups/join/:inviteCode',            authenticate, chatCtrl.joinByLink);
router.get   ('/chat/groups/:id',                         authenticate, chatCtrl.getGroup);
router.patch ('/chat/groups/:id',                         authenticate, chatCtrl.updateGroup);
router.post  ('/chat/groups/:id/members',                 authenticate, chatCtrl.addMembers);
router.delete('/chat/groups/:id/members/:memberId',       authenticate, chatCtrl.removeMember);
router.post  ('/chat/groups/:id/invite-link/reset',       authenticate, chatCtrl.resetInviteLink);
router.post  ('/chat/groups/:id/mute',                    authenticate, chatCtrl.muteGroup);
router.delete('/chat/groups/:id/mute',                    authenticate, chatCtrl.unmuteGroup);
router.delete('/chat/groups/:id',                         authenticate, chatCtrl.deleteGroupForMe);
router.delete('/chat/groups/:id/messages',                authenticate, chatCtrl.clearGroupMessages);
router.post  ('/chat/groups/:id/promote/:memberId',       authenticate, chatCtrl.promoteAdmin);
router.post  ('/chat/groups/:id/demote/:memberId',        authenticate, chatCtrl.demoteAdmin);
router.get   ('/chat/groups/:id/search',                  authenticate, chatCtrl.searchMessages);

// ── Messages ─────────────────────────────────────────────────────────────────
router.get   ('/chat/groups/:id/messages',                authenticate, chatCtrl.getMessages);
router.post  ('/chat/groups/:id/messages',                authenticate, chatCtrl.sendMessage);
// ── File upload: direct (<=50 MB) + chunked (up to 1 GB) ─────────────────────
const fileCtrl = require('../controllers/chatFileController');
router.post  ('/chat/groups/:id/files', authenticate, (req, res, next) => {
  fileCtrl.directUploadMiddleware(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    next();
  });
}, fileCtrl.sendFile);
// Chunked upload
router.post  ('/chat/upload/init',                        authenticate, fileCtrl.initUpload);
router.post  ('/chat/upload/chunk/:uploadId',             authenticate, fileCtrl.uploadChunk);
router.post  ('/chat/upload/complete/:uploadId',          authenticate, fileCtrl.completeUpload);
router.delete('/chat/upload/abort/:uploadId',             authenticate, fileCtrl.abortUpload);
router.get   ('/chat/upload/status/:uploadId',            authenticate, fileCtrl.uploadStatus);
router.patch ('/chat/messages/:id',                       authenticate, chatCtrl.editMessage);
router.delete('/chat/messages/:id/me',                    authenticate, chatCtrl.deleteForMe);
router.delete('/chat/messages/:id/everyone',              authenticate, chatCtrl.deleteForEveryone);

// ── Delivery / Read receipts ──────────────────────────────────────────────────
router.post  ('/chat/messages/delivered',                 authenticate, chatCtrl.markDelivered);
router.post  ('/chat/messages/seen',                      authenticate, chatCtrl.markSeen);

// ── Reactions ─────────────────────────────────────────────────────────────────
router.post  ('/chat/messages/:id/reactions',             authenticate, chatCtrl.addReaction);

// ── Pinned messages ───────────────────────────────────────────────────────────
router.post  ('/chat/messages/:id/pin',                   authenticate, chatCtrl.pinMessage);
router.delete('/chat/messages/:id/pin',                   authenticate, chatCtrl.unpinMessage);

// ── Presence ──────────────────────────────────────────────────────────────────
router.post  ('/chat/presence',                           authenticate, chatCtrl.updatePresence);
router.post  ('/chat/presence/offline',                    authenticate, chatCtrl.markOffline);
router.get   ('/chat/presence',                           authenticate, chatCtrl.getPresence);

// ── Scheduled meetings ────────────────────────────────────────────────────────

// ── Static file serving ───────────────────────────────────────────────────────
router.get   ('/chat/files/:id',  fileCtrl.serveFile);
router.get   ('/api/chat/files/:id', fileCtrl.serveFile);

// ── Call History ──────────────────────────────────────────────────────────────



// ── Performance ──────────────────────────────────────────────────────────
const perfCtrl = require('../controllers/performanceController');
router.get   ('/performance/cycles',                    authenticate,                                       perfCtrl.getCycles);
router.post  ('/performance/cycles',                    authenticate, authorize('hr','admin','super_admin'), perfCtrl.createCycle);
router.get   ('/performance/cycles/:id',                authenticate,                                       perfCtrl.getCycle);
router.post  ('/performance/cycles/:id/initiate',       authenticate, authorize('hr','admin','super_admin'), perfCtrl.initiateCycle);
router.get   ('/performance/my-reviews',                authenticate,                                       perfCtrl.getMyReviews);
router.get   ('/performance/team-reviews',              authenticate,                                       perfCtrl.getTeamReviews);
router.get   ('/performance/review/:id',                authenticate,                                       perfCtrl.getReview);
router.post  ('/performance/review/:id/goals',          authenticate,                                       perfCtrl.addGoal);
router.put   ('/performance/review/:id/goals/:goalId',  authenticate,                                       perfCtrl.updateGoal);
router.delete('/performance/review/:id/goals/:goalId',  authenticate,                                       perfCtrl.deleteGoal);
router.post  ('/performance/review/:id/submit',         authenticate,                                       perfCtrl.submitReview);
router.post  ('/performance/review/:id/complete',       authenticate, authorize('hr','admin','super_admin'), perfCtrl.completeReview);
router.get   ('/performance/summary/:employee_id',      authenticate,                                       perfCtrl.getSummary);
router.get   ('/performance/all',                       authenticate, authorize('hr','admin','super_admin'), perfCtrl.getAllReviews);
router.post  ('/performance/assign-reviewer',           authenticate, authorize('hr','admin','super_admin'), perfCtrl.assignReviewer);

router.get   ('/geofence/unassigned-employees', authenticate, authorize('admin','super_admin','hr'), geoCtrl.getUnassignedEmployeesGlobal);
router.post  ('/geofence/fix-office-universal',  authenticate, authorize('admin','super_admin','hr'), geoCtrl.fixOfficeUniversal);

module.exports = router;
