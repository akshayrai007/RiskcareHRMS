// ============================================================
// config.js — Frontend White-label Config
// ============================================================
// 📌 PLACE IN: frontend/ (same folder as app.js, index.html)
// 📌 LOAD FIRST in every HTML <head>:
//      <script src="config.js"></script>   ← BEFORE app.js
//
// ✅ Fill in ALL values below for each new client.
// ❌ Do NOT hardcode any of these values anywhere else.
// ❌ Do NOT leave any value blank that the app depends on.
// ============================================================

window.CFG = {

  // ── 🏢 Client Identity ──────────────────────────────────────────────────
  clientName:        "RiskCareHR",
  companyShortName:  "",
  companyFullName:   "Risk Care Insurance Broking Services Pvt. Ltd.",
  companyCity:       "Mumbai",
  tagline:           "Servicing All Risks",

  // Logo rendered in sidebar (use HTML for styled spans, plain text also fine)
  logoHtml:          'Risk<span>Care</span>HR',

  // Logo image for printed docs (payslip, offer letter). Path relative to frontend/.
  logoUrl:           "Logo.png",

  // App edition label shown below logo in sidebar (leave blank to hide)
  appEdition:        "",

  // ── 🔤 Typography ────────────────────────────────────────────────────────
  fontFamily:        "DM Sans",
  googleFontUrl:     "https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700;800&display=swap",

  // ── 🌐 API ──────────────────────────────────────────────────────────────
  apiBase:           "https://riskcarehrms.onrender.com/api",

  // ── 🖥️ Frontend URL (used for meeting links, invite links) ──────────────
  // ✅ Set this to your PRODUCTION Vercel URL — never a preview URL
  frontendUrl:       "https://riskcare-hrms.vercel.app",

  // ── 🗺️ Google Maps ───────────────────────────────────────────────────────
  googleMapsApiKey:  "AIzaSyBlfD24fvfHS4agCYkrxg4v_SQWgnYuNxA",

  // ── 🤖 AI Voice Assistant (Anthropic) ────────────────────────────────────
  // ⚠️  WARNING: Exposing an API key in frontend JS is insecure.
  //     Recommended: proxy calls through your backend instead of calling
  //     api.anthropic.com directly from the browser.
  anthropicApiKey:   "",          // Set your Anthropic API key here (or proxy via backend)
  anthropicModel:    "claude-sonnet-4-20250514",
  anthropicApiUrl:   "https://api.anthropic.com/v1/messages",

  // ── 🔑 LocalStorage Keys ────────────────────────────────────────────────
  // Must be unique per client so multiple HRMS deployments don't clash on same browser
  tokenKey:          "riskcarehr_token",
  userKey:           "riskcarehr_user",

  // ── 👤 Special Employee Codes ───────────────────────────────────────────
  cooEmployeeCode:              "RC001",
  mdEmployeeCode:               "RC01",
  accountsEmployeeCode:         "RC002",
  directToCooEmployeeCodes:     [],

  // ── 🔢 Employee Code Prefixes ────────────────────────────────────────────
  permanentEmpCodePrefix:       "RC",
  permanentEmpCodeStart:        10000,
  contractualEmpCodePrefix:     "Cont",

  // ── 🔒 Default Password for new employees ────────────────────────────────
  defaultPassword:   "Admin@1234",

  // ── 🏢 Company Address & Contact ─────────────────────────────────────────
  companyOfficeAddr: "708, 7th Floor, Hubtown Viva, Western Express Highway, Shankarwadi, Jogeshwari (East), Mumbai – 400060",
  supportEmail:      "support@riskcare.co.in",
  websiteUrl:        "www.riskcareinsure.com",

  // ── 📋 Separation / Approval Chain ───────────────────────────────────────
  separationL2Role:          "hr",
  separationL3Role:          "accounts",
  separationL4Roles:         ["admin", "super_admin"],
  separationPendingTabRoles: ["manager", "tl", "accounts"],

  // ── 🎯 Performance Management ─────────────────────────────────────────────
  performanceRatingScale:    5,
  performanceDefaultWeight:  20,
  performanceAdminRoles:     ["hr", "admin", "super_admin"],
  performanceManagerRoles:   ["hr", "admin", "super_admin", "manager", "tl"],
  performanceFinalRatings: [
    "Outstanding",
    "Exceeds Expectations",
    "Meets Expectations",
    "Needs Improvement",
    "Unsatisfactory"
  ],

  // ── 💰 Currency & Locale ─────────────────────────────────────────────────
  currencySymbol:    "₹",
  currencyLocale:    "en-IN",
  currencyWord:      "Rupees",

  // ── 💬 Chat & File Sharing ───────────────────────────────────────────────
  chatFileMaxSizeMB: 50,
  chatFileRoute:     "/chat/files",

  // ── 📹 Video Meetings — WebRTC ICE/STUN ──────────────────────────────────
  meetingStunServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ],

  // ── 🎙️ AI Voice Assistant ─────────────────────────────────────────────────
  voiceLang:       "en-IN",
  voiceTtsRate:    0.95,
  voiceTtsVolume:  1.0,
  voiceTtsPitch:   1.05,

  // ── 🕐 Timezone & Date ───────────────────────────────────────────────────
  timezone:          "Asia/Kolkata",
  dateLocale:        "en-CA",          // Must produce YYYY-MM-DD output

  // ── 🌐 Third-party Service URLs ──────────────────────────────────────────
  brevoApiUrl:       "https://api.brevo.com/v3/smtp/email",

  // ── 📄 Page Titles ────────────────────────────────────────────────────────
  // Used in <title> tags across HTML pages
  pageTitleITDeclaration:  "RiskCareHR - IT Declaration",
  pageTitleProjects:       "RiskCareHR — Project Budget Tracking",
  pageTitleReimbursement:  "Reimbursement – RiskCareHR",

  // ── 📡 Service Worker ─────────────────────────────────────────────────────
  swSyncTag:         "riskcare-tracking",
  swDbName:          "RiskCareHR_SW",

  // ── ⏰ Attendance Cutoffs ─────────────────────────────────────────────────
  punchInCutoffHour:    10,
  punchInCutoffMinute:  30,
  punchOutCutoffHour:   18,
  punchOutCutoffMinute: 30,
  odTrackingWindowStart: 930,
  odTrackingWindowEnd:   1830,

  // ── 🎨 Brand Colors ───────────────────────────────────────────────────────
  // Injected as CSS variables: var(--cfg-primary), var(--cfg-accent), etc.
  primaryColor:      "#C0272D",   // Deep red — sidebar, headers, key buttons
  accentColor:       "#E8303A",   // Brand red — hover, active, links
  lightColor:        "#00AEEF",   // Brand cyan — column headers, tags, chips
  paleColor:         "#EAF7FC",   // Pale cyan — card backgrounds, table rows
  borderColor:       "#B8E4F5",   // Cyan-tinted borders/dividers

  uploadBorderColor: "#00AEEF",   // Dashed border on file drop zone
  uploadBgColor:     "#F0FAFF",   // Background tint on file drop zone
  darkColor:         "#1A2B5A",   // Navy — body text, sidebar bg
  darkerColor:       "#0F1A38",   // Darkest navy — headings, labels
  activeCardBg:      "#FEF2F2",   // Pale red — active/selected card bg
  subHeaderBg:       "#FFF5F5",   // Pale red — sub-header row (payslip etc.)

  // ── ⏱️ Separation / Notice Periods ───────────────────────────────────────
  noticePeriodDays: {
    super_admin: 90, admin: 90, hr: 90, accounts: 90,
    manager: 45, tl: 30, employee: 30,
  },

  // ── 🌿 Leave Type Codes ──────────────────────────────────────────────────
  leaveTypeCodes: {
    earnedLeave: 'EL', sickLeave: 'SL', casualLeave: 'CL',
    onDuty: 'OD', lossOfPay: 'LWP', compOff: 'CO', provisionalLeave: 'PL',
  },

  // ── 📄 Export / Download filenames ───────────────────────────────────────
  exportFilenames: {
    employees:     'Employees',        // → "{clientName}_Employees_DATE.xlsx"
    payrollMaster: 'Payroll_Master',   // → "{clientName}_Payroll_Master_MONTHYEAR.xlsx"
    reimbursements:'Reimbursements',
  },

  // ── 📍 Geofence Zone Codes ────────────────────────────────────────────────


};

// ── Inject CSS variables ────────────────────────────────────────────────────
(function () {
  // ── Inject Google Font dynamically ───────────────────────────────────────
  if (window.CFG.googleFontUrl) {
    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = window.CFG.googleFontUrl;
    document.head.appendChild(link);
  }

  const r = document.documentElement.style;
  r.setProperty('--cfg-primary',        window.CFG.primaryColor);
  r.setProperty('--cfg-accent',         window.CFG.accentColor);
  r.setProperty('--cfg-light',          window.CFG.lightColor);
  r.setProperty('--cfg-pale',           window.CFG.paleColor);
  r.setProperty('--cfg-border',         window.CFG.borderColor);
  r.setProperty('--cfg-upload-border',  window.CFG.uploadBorderColor);
  r.setProperty('--cfg-upload-bg',      window.CFG.uploadBgColor);
  r.setProperty('--cfg-dark',           window.CFG.darkColor);
  r.setProperty('--cfg-darker',         window.CFG.darkerColor);
  r.setProperty('--cfg-active-card',    window.CFG.activeCardBg);
  r.setProperty('--cfg-sub-header',     window.CFG.subHeaderBg);
  if (window.CFG.fontFamily) r.setProperty('--cfg-font', "'" + window.CFG.fontFamily + "', sans-serif");
})();
