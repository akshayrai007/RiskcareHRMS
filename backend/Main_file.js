// ============================================================
// Main_file.js — White-label HRMS Backend Config — RISKCARE
// ============================================================
// 📌 WHERE TO PLACE THIS FILE:
//    HRMS-main/backend/Main_file.js
//
// ✅ Change ONLY the values below for each new client.
// ❌ Do NOT hardcode any of these values in any other backend file.
//    Every controller, service, and cron reads from this single source.
// ============================================================

const CONFIG = {

  // ── 🏢 Client Identity ─────────────────────────────────────────────────────
  clientName:        "RiskCareHR",
  companyName:       "RiskCareHR",
  companyFullName:   "Risk Care Insurance Broking Services Pvt. Ltd.",
  companyShortName:  "Risk Care Insurance",
  companyCIN:        "U51109MH2005PTC199431",
  companyOfficeAddr: "708, 7th Floor, Hubtown Viva, Western Express Highway, Shankarwadi, Jogeshwari (East), Mumbai - 400060",
  companyCorporateAddr: "708, 7th Floor, Hubtown Viva, Western Express Highway, Shankarwadi, Jogeshwari (East), Mumbai - 400060",
  companyTel:        "+912261473232",
  companyCorporateTel:  "+919004028426",
  companyCity:       "Mumbai",
  tagline:           "Servicing All Risks",

  // ── 🌐 Backend / API ───────────────────────────────────────────────────────
  backendUrl:        "https://riskcarehr.onrender.com",
  apiBasePath:       "/api",

  // ── 🖥️ Frontend / App URLs ─────────────────────────────────────────────────
  frontendUrl:       "https://riskcare-hr.vercel.app",
  websiteUrl:        "riskcareinsure.com",
  appDeepLinkScheme: "riskcarehr",

  // ── 🎨 Branding & Theme (UI) ───────────────────────────────────────────────
  // Riskcare brand: red #E8303A + cyan #00AEEF + navy #1A2B5A
  primaryColor:      "#E8303A",       // Brand red — buttons, headers in UI
  secondaryColor:    "#ffffff",        // White — text on coloured backgrounds
  accentColor:       "#C0272D",        // Deep red — hover states, highlights
  fontFamily:        "DM Sans, sans-serif",

  // ── 📧 Email Branding ──────────────────────────────────────────────────────
  emailPrimaryColor:      "#C0272D",   // Email header background — deep red
  emailAccentColor:       "#E8303A",   // Email button & link colour — brand red
  emailBgColor:           "#F5F8FB",   // Email outer background — neutral light
  emailFooterBgColor:     "#EAF7FC",   // Email footer background — pale cyan
  emailCardBgColor:       "#EAF7FC",   // Info card/table background — pale cyan
  emailCardBorderColor:   "#B8E4F5",   // Table row divider / card border — cyan
  emailLogoAccentColor:   "#00AEEF",   // Accent in logo text ('Care' in 'RiskCareHR')
  emailLogoCaptionColor:  "#B8E4F5",   // Sub-caption below logo in email header

  // ── 📊 Excel Export Colors (ARGB — FF prefix = fully opaque) ─────────────
  excelPrimaryArgb:  'FFC0272D',   // Deep red  → Excel title rows, report headers
  excelAccentArgb:   'FFE8303A',   // Brand red → section headers, earnings columns
  excelLightArgb:    'FF00AEEF',   // Brand cyan → employee detail column headers

  // ── 📧 Email Logo Image ───────────────────────────────────────────────────
  emailLogoDataUri: "data:image/png;base64,REPLACE_WITH_RISKCARE_LOGO_BASE64",

  // ── 🖼️ Logo & Assets (UI) ─────────────────────────────────────────────────
  logoPath:          "/assets/logo.png",
  faviconPath:       "/assets/favicon.ico",
  cloudinaryFolder:  "riskcarehr",

  // ── 📄 Joining Form ───────────────────────────────────────────────────────
  joiningFormFilename:    "joining_form.docx",
  joiningFormDisplayName: "Joining Form",

  // ── 🔑 LocalStorage Keys ──────────────────────────────────────────────────
  localStoragePrefix: "riskcarehr_",
  tokenKey:           "riskcarehr_token",
  userKey:            "riskcarehr_user",

  // ── 📧 Email / Support ────────────────────────────────────────────────────
  supportEmail:      "support@riskcare.co.in",
  senderName:        "RiskCareHR Team",

  // ── 🔐 Auth & Security ────────────────────────────────────────────────────
  jwtSecret:         "",            // Set in .env as JWT_SECRET — never hardcode here
  jwtExpiresIn:      "30d",
  sessionTimeout:    86400,

  // ── 🤖 AI / External API URLs ────────────────────────────────────────────
  anthropicApiUrl:   "https://api.anthropic.com/v1/messages",
  anthropicModel:    "claude-sonnet-4-20250514",   // Update when upgrading model
  brevoApiUrl:       "https://api.brevo.com/v3/smtp/email",

  // ── 👤 Special Employee Codes ─────────────────────────────────────────────
  employeeCodePrefix:   "RC",
  employerTAN:          "",         // Set Riskcare employer TAN for Form 16
  cooEmployeeCode:      "RC001",
  mdEmployeeCode:       "RC01",
  accountsEmployeeCode: "RC002",
  directToCooEmployeeCodes: [],

  // ── 🔢 Employee Code Generation ───────────────────────────────────────────
  permanentEmpCodePrefix:    "RC",
  permanentEmpCodeStart:     1,
  contractualEmpCodePrefix:  "CT",
  sampleEmpCodePrefix:       "emp",

  // ── 🔒 Default Passwords ──────────────────────────────────────────────────
  defaultImportPassword:  "Welcome@123",
  defaultResetPassword:   "Welcome@123",
  defaultPassword:        "Admin@1234",

  // ── 🌍 Employee Defaults ──────────────────────────────────────────────────
  defaultNationality:  "Indian",

  // ── 📅 Saturday Policy ────────────────────────────────────────────────────
  allWorkingSaturdayCodes: [],   // Populate with Riskcare employee codes as needed

  // ── 📦 App Meta ───────────────────────────────────────────────────────────
  appVersion:        "1.0.0",
  timezone:          "Asia/Kolkata",
  currency:          "INR",
  currencySymbol:    "₹",
  currencyLocale:    "en-IN",
  dateLocale:        "en-CA",
  dateFormat:        "DD/MM/YYYY",
  defaultRegion:     "south_west",  // Non-north fallback region (used when employee is NOT in north states)
  secondaryRegion:   "north",       // North India region (matched via northRegionRegex)

  // ── 💬 Chat & File Sharing ────────────────────────────────────────────────
  chatFileMaxSizeMB:       1024,          // Max file size for chat uploads (MB)
  chatFileRoute:           '/api/chat/files',
  chatBlockedExtensions:   ['.exe','.bat','.sh','.cmd','.msi','.ps1','.vbs'],
  chatAdminRoles:          ['admin','super_admin','hr'],

  // ── 🎯 Performance Management ────────────────────────────────
  performanceRatingScale:    5,           // Max rating per goal (1–N)
  performanceDefaultWeight:  20,          // Default goal weightage %
  performanceReviewerRoles:  ['hr','admin','super_admin','manager','tl'],
  performanceSelfRoles:      ['employee','manager','tl','hr','accounts','admin','super_admin'],
  performanceAdminRoles:     ['hr','admin','super_admin'],
  performanceFinalRatings: [
    'Outstanding',
    'Exceeds Expectations',
    'Meets Expectations',
    'Needs Improvement',
    'Unsatisfactory'
  ],

  // ── 📋 Separation / Notice Period Policy ─────────────────────────────────
  noticePeriodSeniorDays:   90,
  noticePeriodManagerDays:  45,
  noticePeriodEmployeeDays: 30,

  // Approval chain roles — each level only allows the listed role(s).
  // L1 is always the employee's reporting_manager_id (not role-based).
  separationL2Role:    'hr',                         // Role for L2 HR step
  separationL3Role:    'accounts',                   // Role for L3 Accounts step
  separationL4Roles:   ['admin', 'super_admin'],     // Roles for L4 final Admin step

  // ── 🌿 Leave Accrual Rates (per month) ───────────────────────────────────
  leaveAccrualEL:       1.5,
  leaveAccrualSL:       0.5,
  leaveAccrualCL:       0.5,
  leaveAccrualPL:       1.0,
  provisionPeriodMonths: 6,

  // ── 📅 Annual Leave Entitlements ─────────────────────────────────────────
  annualEL:             18,
  annualCL:              6,
  annualSL:              6,
  annualPL:              6,
  elMaxCarryForward:     6,
  plMaxAnnual:           6,

  // ── 💰 Statutory Payroll Rates (India) ───────────────────────────────────
  pfWageCeiling:        15000,
  pfEmployeeRate:       0.12,
  pfEmployerRate:       0.12,
  pfAdminCharge:        150,
  esiGrossCeiling:      21000,
  esiEmployeeRate:      0.0075,
  esiEmployerRate:      0.0325,
  ptThreshold:          10000,
  ptMonthlyAmount:      200,
  standardDeduction:    50000,
  sec80cPFCap:          150000,
  defaultWorkingDays:   26,

  // ── ⏰ Attendance Business Rules ──────────────────────────────────────────
  autoPunchInTime:      '09:30:00',
  autoPunchOutTime:     '18:30:00',
  autoWorkingHours:     9.0,

  punchInCutoffHour:    10,
  punchInCutoffMinute:  30,
  punchOutCutoffHour:   18,
  punchOutCutoffMinute: 30,
  missingPunchOutHour:  21,

  odTrackingWindowStart: 930,
  odTrackingWindowEnd:   1830,

  movementLogRetentionDays: 3,
  compoffExpiryDays:    30,

  // ── 🗺️ Region Detection ───────────────────────────────────────────────────
  northRegionRegex: "(delhi|up |uttar pradesh|uttarakhand|haryana|punjab|rajasthan|bihar|madhya pradesh|\\bmp\\b|himachal|jammu|kashmir|jharkhand|chhattisgarh|west bengal|bengal|assam|odisha|chandigarh)",

  // ── 🏠 HRA & Tax Config ───────────────────────────────────────────────────
  hraMetroCities:   "(mumbai|delhi|kolkata|chennai)",
  newRegimeStdDeduction: 75000,
  sec80dSelfCap:    25000,
  sec80dParentsCap: 50000,
  sec80ccdNpsCap:   50000,
  sec24bHomeLoanCap: 200000,

};

// ── emailLogoHtml built after CONFIG so it references emailLogoAccentColor ──
CONFIG.emailLogoHtml = `Risk<span style="color:${CONFIG.emailLogoAccentColor};">Care</span>HR`;

module.exports = CONFIG;
