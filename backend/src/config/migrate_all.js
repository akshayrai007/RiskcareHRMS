const CONFIG = require('../Main_file');
/**
 * HRMS — Master Migration (migrate_all.js)
 * Runs ALL migrations in correct order:
 *   1. Core schema (migrate.js)
 *   2. Additions (migrate_additions.js)
 *   3. GK Daily system (migrate_gk_daily.js)
 *
 * Usage: node src/config/migrate_all.js
 */

require('dotenv').config();
const db = require('./db');   // ← fixed: was `const pool = require('./db')`

async function runAllMigrations() {
  const client = await db.getClient();   // ← fixed: was pool.connect()
  try {
    console.log('🚀 Starting HRMS master migration...\n');
    await client.query('BEGIN');

    // ═══════════════════════════════════════════════════════════════
    // PART 1: CORE SCHEMA
    // ═══════════════════════════════════════════════════════════════
    console.log('📦 Part 1: Core schema...');

    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

    await client.query(`CREATE TABLE IF NOT EXISTS departments (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      code VARCHAR(20) UNIQUE,
      head_employee_id INT,
      description TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS designations (
      id SERIAL PRIMARY KEY,
      title VARCHAR(100) NOT NULL,
      department_id INT REFERENCES departments(id) ON DELETE SET NULL,
      grade VARCHAR(20),
      min_salary NUMERIC(12,2),
      max_salary NUMERIC(12,2),
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      employee_code VARCHAR(30) UNIQUE NOT NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL DEFAULT '',
      email VARCHAR(150) UNIQUE NOT NULL,
      phone VARCHAR(20),
      alternate_phone VARCHAR(20),
      gender VARCHAR(10),
      date_of_birth DATE,
      blood_group VARCHAR(5),
      marital_status VARCHAR(20),
      nationality VARCHAR(50) DEFAULT 'Indian',
      address_line1 TEXT,
      address_line2 TEXT,
      city VARCHAR(80),
      state VARCHAR(80),
      pincode VARCHAR(10),
      department_id INT REFERENCES departments(id),
      designation_id INT REFERENCES designations(id),
      reporting_manager_id INT REFERENCES employees(id),
      team_leader_id INT REFERENCES employees(id),
      employment_type VARCHAR(30) DEFAULT 'Full-Time',
      joining_date DATE NOT NULL,
      probation_end_date DATE,
      confirmation_date DATE,
      role VARCHAR(20) DEFAULT 'employee'
        CHECK (role IN ('super_admin','admin','hr','hr admin','accounts','accounts admin','manager','tl','employee')),
      level VARCHAR(10) DEFAULT 'L1',
      password_hash TEXT NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      pan_number VARCHAR(15),
      aadhar_number VARCHAR(15),
      uan_number VARCHAR(15),
      pf_number VARCHAR(30),
      esi_number VARCHAR(30),
      bank_name VARCHAR(100),
      bank_account VARCHAR(30),
      bank_ifsc VARCHAR(15),
      bank_branch VARCHAR(100),
      ctc NUMERIC(12,2) DEFAULT 0,
      basic_salary NUMERIC(12,2) DEFAULT 0,
      hra NUMERIC(12,2) DEFAULT 0,
      special_allowance NUMERIC(12,2) DEFAULT 0,
      travel_allowance NUMERIC(12,2) DEFAULT 0,
      profile_photo VARCHAR(255),
      resume_path VARCHAR(255),
      separation_date DATE,
      separation_reason TEXT,
      separation_type VARCHAR(30),
      approval_chain JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS leave_types (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      code VARCHAR(20) UNIQUE NOT NULL,
      days_allowed INT NOT NULL DEFAULT 0,
      monthly_accrual NUMERIC(4,2) DEFAULT 0,
      carry_forward BOOLEAN DEFAULT FALSE,
      max_carry_forward INT DEFAULT 0,
      is_paid BOOLEAN DEFAULT TRUE,
      applicable_gender VARCHAR(10) DEFAULT 'all',
      description TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS leave_balances (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
      leave_type_id INT REFERENCES leave_types(id) ON DELETE CASCADE,
      year INT NOT NULL,
      allocated NUMERIC(6,2) DEFAULT 0,
      used NUMERIC(6,2) DEFAULT 0,
      pending NUMERIC(6,2) DEFAULT 0,
      carry_forward NUMERIC(6,2) DEFAULT 0,
      UNIQUE(employee_id, leave_type_id, year)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS leave_requests (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id),
      leave_type_id INT REFERENCES leave_types(id),
      from_date DATE NOT NULL,
      to_date DATE NOT NULL,
      total_days NUMERIC(4,1),
      reason TEXT,
      leave_category VARCHAR(20) DEFAULT 'leave'
        CHECK (leave_category IN ('leave','od','lwp','compoff')),
      status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','cancelled')),
      l1_approver_id INT REFERENCES employees(id),
      l1_status VARCHAR(20) DEFAULT 'pending',
      l1_remarks TEXT,
      l1_action_at TIMESTAMP,
      l2_approver_id INT REFERENCES employees(id),
      l2_status VARCHAR(20) DEFAULT 'pending',
      l2_remarks TEXT,
      l2_action_at TIMESTAMP,
      l3_approver_id INT REFERENCES employees(id),
      l3_status VARCHAR(20) DEFAULT 'pending',
      l3_remarks TEXT,
      l3_action_at TIMESTAMP,
      applied_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS holidays (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      date DATE NOT NULL UNIQUE,
      type VARCHAR(30) DEFAULT 'national',
      description TEXT,
      year INT GENERATED ALWAYS AS (EXTRACT(YEAR FROM date)::INT) STORED
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id),
      date DATE NOT NULL,
      punch_in TIME,
      punch_out TIME,
      working_hours NUMERIC(4,2),
      status VARCHAR(20) DEFAULT 'present'
        CHECK (status IN ('present','absent','half-day','late','on-leave','od','lwp','holiday','weekend','regularized','missing_punch_out','wfh','h-el','h-cl','h-sl','h-lwp','h-wfh')),
      location_lat NUMERIC(10,6),
      location_lng NUMERIC(10,6),
      punch_in_location TEXT,
      punch_out_location TEXT,
      remarks TEXT,
      is_regularized BOOLEAN DEFAULT FALSE,
      regularization_reason TEXT,
      regularization_status VARCHAR(20) DEFAULT NULL
        CHECK (regularization_status IN ('pending','approved','rejected') OR regularization_status IS NULL),
      regularization_approved_by INT REFERENCES employees(id),
      regularization_applied_at TIMESTAMP,
      regularization_punch_in TIME DEFAULT NULL,
      regularization_punch_out TIME DEFAULT NULL,
      regularization_requested_at TIMESTAMPTZ DEFAULT NULL,
      regularization_actioned_by INT REFERENCES employees(id) ON DELETE SET NULL,
      regularization_actioned_at TIMESTAMPTZ DEFAULT NULL,
      regularization_remarks TEXT DEFAULT NULL,
      approved_by INT REFERENCES employees(id),
      UNIQUE(employee_id, date)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS office_locations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      latitude NUMERIC(10,7) NOT NULL,
      longitude NUMERIC(10,7) NOT NULL,
      radius_meters INT NOT NULL DEFAULT 100,
      address TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_by INT REFERENCES employees(id),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS employee_geofence (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
      office_location_id INT REFERENCES office_locations(id) ON DELETE CASCADE,
      is_universal BOOLEAN DEFAULT FALSE,
      assigned_by INT REFERENCES employees(id),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(employee_id, office_location_id)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS attendance_geofence_logs (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id),
      attendance_id INT REFERENCES attendance(id),
      punch_type VARCHAR(10),
      employee_lat NUMERIC(10,7),
      employee_lng NUMERIC(10,7),
      office_lat NUMERIC(10,7),
      office_lng NUMERIC(10,7),
      distance_meters INT,
      is_within_geofence BOOLEAN,
      office_location_id INT REFERENCES office_locations(id),
      office_name VARCHAR(150),
      employee_name VARCHAR(200),
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS payroll (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id),
      month INT NOT NULL,
      year INT NOT NULL,
      working_days INT DEFAULT 0,
      present_days NUMERIC(5,2) DEFAULT 0,
      paid_leave_days NUMERIC(5,2) DEFAULT 0,
      lop_days NUMERIC(5,2) DEFAULT 0,
      paid_days NUMERIC(5,2) DEFAULT 0,
      basic NUMERIC(12,2) DEFAULT 0,
      hra NUMERIC(12,2) DEFAULT 0,
      conveyance NUMERIC(12,2) DEFAULT 0,
      special_allowance NUMERIC(12,2) DEFAULT 0,
      other_allowance NUMERIC(12,2) DEFAULT 0,
      bonus NUMERIC(12,2) DEFAULT 0,
      gratuity NUMERIC(12,2) DEFAULT 0,
      gross_salary NUMERIC(12,2) DEFAULT 0,
      pf_employee NUMERIC(12,2) DEFAULT 0,
      pf_employer NUMERIC(12,2) DEFAULT 0,
      esi_employee NUMERIC(12,2) DEFAULT 0,
      esi_employer NUMERIC(12,2) DEFAULT 0,
      pf_admin NUMERIC(12,2) DEFAULT 0,
      tds NUMERIC(12,2) DEFAULT 0,
      lwf NUMERIC(12,2) DEFAULT 0,
      professional_tax NUMERIC(12,2) DEFAULT 0,
      advance_deduction NUMERIC(12,2) DEFAULT 0,
      loan_emi_recovery NUMERIC(12,2) DEFAULT 0,
      other_deduction NUMERIC(12,2) DEFAULT 0,
      total_deductions NUMERIC(12,2) DEFAULT 0,
      total_employer_cost NUMERIC(12,2) DEFAULT 0,
      net_salary NUMERIC(12,2) DEFAULT 0,
      ctc_monthly NUMERIC(12,2) DEFAULT 0,
      ctc_annual NUMERIC(12,2) DEFAULT 0,
      status VARCHAR(20) DEFAULT 'draft'
        CHECK (status IN ('draft','processed','paid')),
      payment_date DATE,
      payment_mode VARCHAR(30),
      transaction_ref VARCHAR(100),
      generated_by INT REFERENCES employees(id),
      generated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(employee_id, month, year)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS payroll_uploads (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255),
      uploaded_by INT REFERENCES employees(id),
      month INT, year INT,
      total_rows INT DEFAULT 0,
      processed_rows INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending','processing','done','failed')),
      error_log TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS payroll_upload_rows (
      id SERIAL PRIMARY KEY,
      upload_id INT REFERENCES payroll_uploads(id) ON DELETE CASCADE,
      employee_code VARCHAR(30),
      row_data JSONB,
      status VARCHAR(20) DEFAULT 'pending',
      error_message TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS employee_salary_structure (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id) ON DELETE CASCADE UNIQUE,
      basic NUMERIC(12,2) DEFAULT 0,
      hra NUMERIC(12,2) DEFAULT 0,
      conveyance NUMERIC(12,2) DEFAULT 0,
      special_allowance NUMERIC(12,2) DEFAULT 0,
      gratuity NUMERIC(12,2) DEFAULT 0,
      gross_salary NUMERIC(12,2) DEFAULT 0,
      pf_employee NUMERIC(12,2) DEFAULT 0,
      pf_employer NUMERIC(12,2) DEFAULT 0,
      esi_employee NUMERIC(12,2) DEFAULT 0,
      esi_employer NUMERIC(12,2) DEFAULT 0,
      pf_admin NUMERIC(12,2) DEFAULT 0,
      tds NUMERIC(12,2) DEFAULT 0,
      lwf NUMERIC(12,2) DEFAULT 0,
      professional_tax NUMERIC(12,2) DEFAULT 0,
      total_deductions NUMERIC(12,2) DEFAULT 0,
      total_employer_cost NUMERIC(12,2) DEFAULT 0,
      net_salary NUMERIC(12,2) DEFAULT 0,
      ctc_monthly NUMERIC(12,2) DEFAULT 0,
      ctc_annual NUMERIC(12,2) DEFAULT 0,
      pf_applicable BOOLEAN DEFAULT TRUE,
      esi_applicable BOOLEAN DEFAULT FALSE,
      pt_applicable BOOLEAN DEFAULT TRUE,
      lwf_applicable BOOLEAN DEFAULT FALSE,
      tds_applicable BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      content TEXT NOT NULL,
      type VARCHAR(30) DEFAULT 'general',
      target_role VARCHAR(20) DEFAULT 'all',
      department_id INT REFERENCES departments(id),
      posted_by INT REFERENCES employees(id),
      is_active BOOLEAN DEFAULT TRUE,
      expires_at DATE,
      image_url TEXT,
      link_url TEXT,
      link_label VARCHAR(100),
      thought_day_number INT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS employee_documents (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
      document_type VARCHAR(80) NOT NULL,
      file_name VARCHAR(255),
      file_path VARCHAR(255),
      uploaded_by INT REFERENCES employees(id),
      uploaded_at TIMESTAMP DEFAULT NOW(),
      is_verified BOOLEAN DEFAULT FALSE,
      verified_by INT REFERENCES employees(id)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS separations (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id),
      type VARCHAR(30) DEFAULT 'resignation'
        CHECK (type IN ('resignation','termination','retirement','absconding','mutual-separation')),
      reason TEXT,
      notice_date DATE,
      last_working_date DATE,
      exit_interview_done BOOLEAN DEFAULT FALSE,
      exit_feedback TEXT,
      clearance_done BOOLEAN DEFAULT FALSE,
      final_settlement_amount NUMERIC(12,2),
      status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','withdrawn','completed')),
      initiated_by INT REFERENCES employees(id),
      l1_approver_id INT REFERENCES employees(id), l1_status VARCHAR(20) DEFAULT 'pending',
      l1_remarks TEXT, l1_action_at TIMESTAMP, l1_actioned_by INT REFERENCES employees(id),
      l2_approver_id INT REFERENCES employees(id), l2_status VARCHAR(20) DEFAULT 'pending',
      l2_remarks TEXT, l2_action_at TIMESTAMP, l2_actioned_by INT REFERENCES employees(id),
      l3_approver_id INT REFERENCES employees(id), l3_status VARCHAR(20) DEFAULT 'pending',
      l3_remarks TEXT, l3_action_at TIMESTAMP, l3_actioned_by INT REFERENCES employees(id),
      l4_approver_id INT REFERENCES employees(id), l4_status VARCHAR(20) DEFAULT 'pending',
      l4_remarks TEXT, l4_action_at TIMESTAMP, l4_actioned_by INT REFERENCES employees(id),
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS advance_salary (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id),
      amount NUMERIC(12,2) NOT NULL,
      reason TEXT,
      requested_at TIMESTAMP DEFAULT NOW(),
      status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','recovered','disbursed','cleared')),
      approved_by INT REFERENCES employees(id),
      approved_at TIMESTAMP,
      remarks TEXT,
      recover_from_month INT,
      recover_from_year INT,
      recovered_amount NUMERIC(12,2) DEFAULT 0,
      recovery_complete BOOLEAN DEFAULT FALSE,
      approval_chain JSONB,
      current_approver_code VARCHAR(20),
      current_level SMALLINT DEFAULT 1,
      monthly_emi NUMERIC(12,2) DEFAULT 0,
      total_installments INT DEFAULT 1,
      balance_remaining NUMERIC(12,2) DEFAULT 0,
      emi_start_month INT,
      emi_start_year INT,
      purpose TEXT,
      project_id INT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS advance_approvals (
      id SERIAL PRIMARY KEY,
      advance_id INT REFERENCES advance_salary(id) ON DELETE CASCADE,
      approver_id INT REFERENCES employees(id),
      level INT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected')),
      remarks TEXT,
      action_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS loan_recovery_log (
      id SERIAL PRIMARY KEY,
      advance_id INT REFERENCES advance_salary(id),
      employee_id INT REFERENCES employees(id),
      payroll_id INT REFERENCES payroll(id),
      month INT, year INT,
      amount_recovered NUMERIC(12,2),
      recovered_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
      title VARCHAR(200),
      message TEXT,
      type VARCHAR(30) DEFAULT 'info',
      is_read BOOLEAN DEFAULT FALSE,
      reference_id INT,
      reference_type VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS wfh_requests (
      id SERIAL PRIMARY KEY,
      employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
      from_date DATE NOT NULL,
      to_date DATE NOT NULL,
      reason TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','cancelled')),
      actioned_by INT REFERENCES employees(id),
      action_at TIMESTAMP,
      remarks TEXT,
      applied_at TIMESTAMP DEFAULT NOW()
    )`);

    // ── Legacy GK (monthly) ────────────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS gk_questions (
      id SERIAL PRIMARY KEY,
      month INT NOT NULL CHECK(month BETWEEN 1 AND 12),
      year  INT NOT NULL,
      question TEXT NOT NULL,
      option_a TEXT NOT NULL, option_b TEXT NOT NULL,
      option_c TEXT NOT NULL, option_d TEXT NOT NULL,
      correct_answer CHAR(1) NOT NULL CHECK(correct_answer IN ('A','B','C','D')),
      about TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_by INT REFERENCES employees(id),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(month, year)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS gk_responses (
      id SERIAL PRIMARY KEY,
      question_id INT REFERENCES gk_questions(id) ON DELETE CASCADE,
      employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
      answer CHAR(1) NOT NULL,
      is_correct BOOLEAN NOT NULL,
      answered_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(question_id, employee_id)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS thought_of_day_schedules (
      id SERIAL PRIMARY KEY,
      day_number INT NOT NULL CHECK(day_number BETWEEN 1 AND 366),
      year INT NOT NULL,
      thought TEXT NOT NULL,
      author VARCHAR(200),
      display_date DATE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(day_number, year)
    )`);

    // ═══════════════════════════════════════════════════════════════
    // PART 2: ADDITIONAL COLUMNS
    // ═══════════════════════════════════════════════════════════════
    console.log('📦 Part 2: Additional columns...');

    const addCol = async (table, col, def) => {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def}`);
    };

    await addCol('payroll',    'bonus',                   'NUMERIC(10,2) DEFAULT 0');
    await addCol('payroll',    'advance_deduction',       'NUMERIC(10,2) DEFAULT 0');
    await addCol('attendance', 'source',                  "VARCHAR(20) DEFAULT 'manual'");
    await addCol('attendance', 'wfh_approved',            'BOOLEAN DEFAULT FALSE');
    await addCol('attendance', 'regularization_punch_in',     'TIME DEFAULT NULL');
    await addCol('attendance', 'regularization_punch_out',    'TIME DEFAULT NULL');
    await addCol('attendance', 'regularization_requested_at', 'TIMESTAMPTZ DEFAULT NULL');
    await addCol('attendance', 'regularization_actioned_by',  'INT REFERENCES employees(id) ON DELETE SET NULL');
    await addCol('attendance', 'regularization_actioned_at',  'TIMESTAMPTZ DEFAULT NULL');
    await addCol('attendance', 'regularization_remarks',      'TEXT DEFAULT NULL');
    await addCol('leave_requests', 'half_day',            'BOOLEAN DEFAULT FALSE');
    await addCol('leave_requests', 'half_day_type',       "VARCHAR(10) CHECK (half_day_type IN ('first','second'))");
    await addCol('separations', 'noc_issued',             'BOOLEAN DEFAULT FALSE');
    await addCol('separations', 'experience_letter_issued','BOOLEAN DEFAULT FALSE');
    await addCol('employees',   'saturday_policy',         "VARCHAR(20) DEFAULT '2nd_4th_off' CHECK (saturday_policy IN ('2nd_4th_off','all_working'))");

    // ── Fix 3: Single-device login ────────────────────────────────────────────
    await addCol('employees', 'device_token',      'VARCHAR(255) DEFAULT NULL');

    // ── Fix 4: App version tracking ───────────────────────────────────────────
    await addCol('employees', 'app_version',       'VARCHAR(30) DEFAULT NULL');
    await addCol('employees', 'last_login_at',     'TIMESTAMPTZ DEFAULT NULL');
    await addCol('employees', 'last_login_device', 'VARCHAR(255) DEFAULT NULL');

    // ── Fix 1: Announcement likes & comments ──────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS announcement_likes (
      id SERIAL PRIMARY KEY,
      announcement_id INT REFERENCES announcements(id) ON DELETE CASCADE,
      employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(announcement_id, employee_id)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS announcement_comments (
      id SERIAL PRIMARY KEY,
      announcement_id INT REFERENCES announcements(id) ON DELETE CASCADE,
      employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
      comment TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_ann_likes_ann   ON announcement_likes(announcement_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ann_comments_ann ON announcement_comments(announcement_id)`);

    // Saturday policy — configured via CONFIG.allWorkingSaturdayCodes

    await client.query(`CREATE TABLE IF NOT EXISTS gk_daily_questions (
      id SERIAL PRIMARY KEY,
      question_date DATE NOT NULL UNIQUE,
      question TEXT NOT NULL,
      option_a TEXT NOT NULL, option_b TEXT NOT NULL,
      option_c TEXT NOT NULL, option_d TEXT NOT NULL,
      correct_answer CHAR(1) NOT NULL CHECK(correct_answer IN ('A','B','C','D')),
      about TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_by INT REFERENCES employees(id),
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS gk_daily_responses (
      id SERIAL PRIMARY KEY,
      question_id INT NOT NULL REFERENCES gk_daily_questions(id) ON DELETE CASCADE,
      employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      answer VARCHAR(5) NOT NULL,
      is_correct BOOLEAN NOT NULL DEFAULT FALSE,
      score_change NUMERIC(6,2) NOT NULL DEFAULT 0,
      answered_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(question_id, employee_id)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS gk_daily_thoughts (
      id SERIAL PRIMARY KEY,
      thought_date DATE NOT NULL UNIQUE,
      thought TEXT NOT NULL,
      author VARCHAR(200),
      created_by INT REFERENCES employees(id),
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // ── Employee Movement Log ──────────────────────────────────────────────
    await client.query(`CREATE TABLE IF NOT EXISTS employee_movement_log (
      id              SERIAL PRIMARY KEY,
      employee_id     INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      lat             NUMERIC(11,8) NOT NULL,
      lng             NUMERIC(11,8) NOT NULL,
      accuracy        FLOAT,
      gps_status      BOOLEAN NOT NULL DEFAULT TRUE,
      internet_status BOOLEAN NOT NULL DEFAULT TRUE,
      battery         SMALLINT,
      logged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // Safe column additions for existing deployments
    await client.query(`ALTER TABLE employee_movement_log ADD COLUMN IF NOT EXISTS gps_status BOOLEAN NOT NULL DEFAULT TRUE`);
    await client.query(`ALTER TABLE employee_movement_log ADD COLUMN IF NOT EXISTS internet_status BOOLEAN NOT NULL DEFAULT TRUE`);
    await client.query(`ALTER TABLE employee_movement_log ADD COLUMN IF NOT EXISTS battery SMALLINT`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_movement_emp_date
      ON employee_movement_log(employee_id, DATE(logged_at AT TIME ZONE CONFIG.timezone || 'Asia/Kolkata'))`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_movement_emp_logged
      ON employee_movement_log(employee_id, logged_at)`);

    // ═══════════════════════════════════════════════════════════════
    // INDEXES
    // ═══════════════════════════════════════════════════════════════
    console.log('📦 Creating indexes...');


    // ── Feature #10: movement_alerts table ───────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS movement_alerts (
        id                SERIAL PRIMARY KEY,
        employee_id       INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        alert_date        DATE NOT NULL,
        alert_type        VARCHAR(20) NOT NULL
                            CHECK (alert_type IN ('silence','low_battery','gps_off','net_off')),
        message           TEXT NOT NULL,
        details           JSONB DEFAULT '{}',
        status            VARCHAR(20) DEFAULT 'open'
                            CHECK (status IN ('open','resolved','auto_resolved')),
        notified_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        resolved_at       TIMESTAMPTZ,
        resolved_by       INT REFERENCES employees(id),
        resolution_note   TEXT,
        manager_notified  BOOLEAN DEFAULT FALSE,
        UNIQUE(employee_id, alert_date, alert_type)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_alerts_emp_date ON movement_alerts(employee_id, alert_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_alerts_status ON movement_alerts(status)`);

    // ── Feature #7: beat_plans + beat_plan_stops tables ──────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS beat_plans (
        id           SERIAL PRIMARY KEY,
        employee_id  INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        plan_date    DATE NOT NULL,
        title        VARCHAR(200) DEFAULT 'Beat Plan',
        notes        TEXT,
        created_by   INT REFERENCES employees(id),
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(employee_id, plan_date)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS beat_plan_stops (
        id               SERIAL PRIMARY KEY,
        plan_id          INT NOT NULL REFERENCES beat_plans(id) ON DELETE CASCADE,
        sequence         INT NOT NULL DEFAULT 1,
        location_name    VARCHAR(200) NOT NULL,
        address          TEXT,
        lat              NUMERIC(10,6),
        lng              NUMERIC(10,6),
        notes            TEXT,
        expected_arrival TIME,
        visit_status     VARCHAR(20) DEFAULT 'pending'
                           CHECK (visit_status IN ('pending','visited','missed')),
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_beat_plans_emp_date ON beat_plans(employee_id, plan_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_beat_stops_plan ON beat_plan_stops(plan_id, sequence)`);

    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_attendance_emp_date    ON attendance(employee_id, date)',
      'CREATE INDEX IF NOT EXISTS idx_leave_req_emp          ON leave_requests(employee_id)',
      'CREATE INDEX IF NOT EXISTS idx_leave_bal_emp          ON leave_balances(employee_id)',
      'CREATE INDEX IF NOT EXISTS idx_payroll_emp            ON payroll(employee_id)',
      'CREATE INDEX IF NOT EXISTS idx_notifications_emp      ON notifications(employee_id)',
      'CREATE INDEX IF NOT EXISTS idx_announcements_type     ON announcements(type)',
      'CREATE INDEX IF NOT EXISTS idx_gk_responses_emp       ON gk_responses(employee_id)',
      'CREATE INDEX IF NOT EXISTS idx_wfh_emp                ON wfh_requests(employee_id)',
      'CREATE INDEX IF NOT EXISTS idx_wfh_status             ON wfh_requests(status)',
      'CREATE INDEX IF NOT EXISTS idx_gkdq_date              ON gk_daily_questions(question_date)',
      'CREATE INDEX IF NOT EXISTS idx_gkdr_emp               ON gk_daily_responses(employee_id)',
      'CREATE INDEX IF NOT EXISTS idx_gkdr_qid               ON gk_daily_responses(question_id)',
      'CREATE INDEX IF NOT EXISTS idx_gkdt_date              ON gk_daily_thoughts(thought_date)',
      'CREATE INDEX IF NOT EXISTS idx_geofence_emp           ON employee_geofence(employee_id)',
    ];

    for (const idx of indexes) {
      await client.query(idx);
    }

    // ═══════════════════════════════════════════════════════════════
    // SEED LEAVE TYPES
    // ═══════════════════════════════════════════════════════════════
    await client.query(`INSERT INTO leave_types (name, code, days_allowed, monthly_accrual, carry_forward, max_carry_forward, is_paid) VALUES
      ('Earned Leave',       'EL',  18,  1.5, true,  6, true),
      ('Sick Leave',         'SL',  6,   0.5, false, 0, true),
      ('Casual Leave',       'CL',  6,   0.5, false, 0, true),
      ('On Duty',            'OD',  0,   0,   false, 0, true),
      ('Loss of Pay',        'LWP', 0,   0,   false, 0, false),
      ('Maternity Leave',    'ML',  180, 0,   false, 0, true),
      ('Paternity Leave',    'PTL', 15,  0,   false, 0, true),
      ('Comp Off',           'CO',  0,   0,   false, 0, true),
      ('Provisional Leave',  'PL',  6,   0,   false, 0, true)
    ON CONFLICT (code) DO UPDATE SET
      days_allowed     = EXCLUDED.days_allowed,
      monthly_accrual  = EXCLUDED.monthly_accrual`);

    await client.query('COMMIT');
    console.log('\n✅ All migrations completed successfully!');
    console.log('   ✓ Core schema (all tables)');
    console.log('   ✓ Additional columns');
    console.log('   ✓ GK Daily tables');
    console.log('   ✓ Indexes');
    console.log('   ✓ Leave types seeded\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
    console.error(err);
    throw err;
  } finally {
    client.release();
    process.exit(0);   // ← force-exit so the pg pool doesn't hang
  }
}

runAllMigrations().catch(console.error);
