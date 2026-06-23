// app.js — Shared utilities for all HRMS pages
// ── Global currency symbol injection ──────────────────────────────────────────
// Replaces all <span class="ccy-sym"> elements with the configured symbol
(function applyCurrencySymbol() {
  const sym = (window.CFG && window.CFG.currencySymbol) ? window.CFG.currencySymbol : '₹';
  function setSymbols() {
    document.querySelectorAll('.ccy-sym').forEach(el => el.textContent = sym);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setSymbols);
  } else {
    setSymbols();
  }
  // Also observe dynamic content (tables rendered by JS)
  const obs = new MutationObserver(setSymbols);
  obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
// ── Page Title from CFG ──────────────────────────────────────────────────────
(function setPageTitle() {
  const titleEl = document.getElementById('page-title');
  const base = window.CFG?.clientName || '';
  if (titleEl) {
    // page has id="page-title" <title> — prepend clientName
    const pageLabel = titleEl.textContent.trim();
    document.title = base ? `${base} - ${pageLabel}` : pageLabel;
  } else if (document.title && base) {
    // fallback: if title doesn't have the client name already, prepend it
    if (!document.title.startsWith(base)) {
      document.title = `${base} - ${document.title}`;
    }
  }
})();


const API_BASE = window.CFG.apiBase;

const Auth = {
  getToken:   () => localStorage.getItem(window.CFG.tokenKey),
  getUser:    () => JSON.parse(localStorage.getItem(window.CFG.userKey) || 'null'),
  setSession: (token, user) => { localStorage.setItem(window.CFG.tokenKey, token); localStorage.setItem(window.CFG.userKey, JSON.stringify(user)); },
  clear:      () => { localStorage.removeItem(window.CFG.tokenKey); localStorage.removeItem(window.CFG.userKey); },
  guard:      () => { if (!Auth.getToken()) { window.location.href = 'login.html'; return false; } return true; },
  guardDashboard: () => {
    if (!Auth.getToken()) { window.location.href = 'login.html'; return false; }
    if (!['admin','super_admin','hr','accounts'].includes(Auth.getUser()?.role)) { window.location.href = 'attendance.html'; return false; }
    return true;
  },
  logout: () => { Auth.clear(); window.location.href = 'login.html'; },
  getForgotToken: (token) => {
    const params = new URLSearchParams(window.location.search);
    return params.get('token');
  },
};

async function api(method, path, body, _retry = 0) {
  const token = Auth.getToken();
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    // FIX: abort if server takes > 15s (Render cold-start can be slow)
    signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(API_BASE + path, opts);
    if (res.status === 401) { Auth.logout(); return null; }
    // FIX: guard against non-JSON responses (e.g. 502/504 HTML error pages from Render cold-start)
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      const text = await res.text();
      console.warn('[HRMS] Non-JSON response from', path, res.status, text.slice(0, 120));
      if ((res.status === 502 || res.status === 503 || res.status === 504) && _retry === 0) {
        toast('Server is starting up… retrying in 3s', 'warning');
        await new Promise(r => setTimeout(r, 3000));
        return api(method, path, body, 1);
      }
      return { success: false, message: 'Server error (' + res.status + ') — please try again' };
    }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') return { success: false, message: 'Request timed out — server may be starting, please retry in a moment' };
    return { success: false, message: 'Cannot connect to server' };
  }
}

function toast(msg, type = 'success') {
  let el = document.getElementById('__toast');
  if (!el) {
    el = document.createElement('div'); el.id = '__toast';
    el.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;padding:13px 20px;border-radius:12px;font-size:13.5px;font-weight:600;font-family:'Plus Jakarta Sans',sans-serif;max-width:360px;box-shadow:0 8px 32px rgba(15,23,42,.18);transition:all .3s cubic-bezier(.4,0,.2,1);transform:translateY(80px);opacity:0;display:flex;align-items:center;gap:10px;min-width:240px;`;
    document.body.appendChild(el);
  }
  const icons={success:'✓',error:'✕',warning:'⚠'}, colors={success:'#10b981',error:'#ef4444',warning:'#f59e0b'};
  el.innerHTML = `<span style="width:22px;height:22px;border-radius:50%;background:${colors[type]||colors.success};color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0">${icons[type]||icons.success}</span><span>${msg}</span>`;
  el.style.cssText += `background:#0f172a;color:#fff;border-left:3px solid ${colors[type]||colors.success};transform:translateY(0);opacity:1;`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.transform='translateY(80px)'; el.style.opacity='0'; }, 3500);
}

const fmt = {
  date:   s => { if (!s) return '—'; return new Date(s).toLocaleDateString(window.CFG.currencyLocale,{day:'2-digit',month:'short',year:'numeric'}); },
  time:   s => { if (!s) return '—'; return String(s).slice(0,5); },
  money:  n => (window.CFG.currencySymbol||'₹')+(parseFloat(n)||0).toLocaleString(window.CFG.currencyLocale,{minimumFractionDigits:0}),
  num:    n => parseFloat(n||0).toFixed(1),
  ago:    s => { if (!s) return ''; const d=(Date.now()-new Date(s))/1000; if(d<60) return 'just now'; if(d<3600) return Math.floor(d/60)+'m ago'; if(d<86400) return Math.floor(d/3600)+'h ago'; return Math.floor(d/86400)+'d ago'; },
  months: ['January','February','March','April','May','June','July','August','September','October','November','December'],
};

const Role = {
  is:            (...r) => r.includes(Auth.getUser()?.role),
  isAdminOrHR: () => Role.is('admin','super_admin','hr','accounts'),          // super_admin EXCLUDED — view only
  // Only HR, Accounts, COO (cooEmployeeCode), and Super Admin can view salary/compensation
  canViewSalary: () => Role.is('super_admin','hr','accounts') || Auth.getUser()?.employee_code === window.CFG.cooEmployeeCode,
  isAdminOnly:   ()     => Role.is('admin','super_admin'),
  isManagerUp:   ()     => Role.is('admin','super_admin','hr','accounts','manager'),
  isDashboard:   ()     => Role.is('admin','super_admin','hr','accounts','manager','tl'),
  canApproveLeave: ()   => Role.is('admin','manager','tl'),            // only these can approve leaves
  canUploadPayroll: ()  => Role.is('accounts'),                        // only accounts can upload payroll
  canProcessAdvancePayment: () => Role.is('accounts'),                 // only accounts can mark advance paid
  badge: r => ({admin:'#ef4444',super_admin:'#7c3aed',hr:'#10b981',accounts:'#f59e0b',manager:'#4361ee',tl:'#f59e0b',employee:'#6b7280'})[r]||'#6b7280',
};

// SVG icons — consistent, clean, professional
// Emoji icons — consistent size via CSS, clean and recognisable
const ICONS = {
  dashboard:    `🏠`,
  attendance:   `🕐`,
  leaves:       `🌿`,
  announcements:`📢`,
  form16:       `📋`,
  itdecl:       `🧾`,
  payslip:      `💳`,
  employees:    `👥`,
  separation:   `🚪`,
  payroll:      `💰`,
  advance:      `💸`,
  reimbursement:`🧾`,
  provision:    `⏳`,
  geofence:     `📍`,
  projects:     `📊`,
  performance:  `🎯`,
  aivoice:      `🤖`,
  requests:     `📋`,
  chat:         `💬`,
};

const NAV_GROUPS = [
  {
    label: null,
    items: [
      { href:'dashboard.html',      icon: ICONS.dashboard,    label:'Dashboard',        roles:['admin','super_admin','hr','accounts','manager','tl'] },
    ]
  },
  {
    label: 'Workspace',
    items: [
      { href:'attendance.html',     icon: ICONS.attendance,   label:'Attendance',       always:true },
      { href:'leaves.html',         icon: ICONS.leaves,       label:'Leaves',           always:true },
      { href:'announcements.html',  icon: ICONS.announcements,label:'Announcements',    roles:['employee'] },
      { href:'performance.html',    icon: ICONS.performance,  label:'Performance',      always:true },
      { href:'chat.html',           icon: ICONS.chat,         label:'Chat & Meetings',  always:true }
    ]
  },
  {
    label: 'Documents',
    items: [
      { href:'form16.html',         icon: ICONS.form16,       label:'Form 16',          always:true },
      { href:'it-declaration.html', icon: ICONS.itdecl,       label:'IT Declaration',   always:true },
      { href:'payslip.html',        icon: ICONS.payslip,      label:'My Payslip',       always:true },
    ]
  },
  {
    label: 'Organisation',
    items: [
      { href:'employees.html',      icon: ICONS.employees,    label:'Employees',        roles:['admin','super_admin','hr','accounts','manager','tl'] },
      { href:'separation.html',     icon: ICONS.separation,   label:'Separation',       always:true },
    ]
  },
  {
    label: 'Finance',
    items: [
      { href:'payroll.html',        icon: ICONS.payroll,      label:'Payroll',          roles:['super_admin','hr','accounts'] },
      { href:'advance.html',        icon: ICONS.advance,        label:'Advance Salary',   always:true },
      { href:'reimbursement.html',  icon: ICONS.reimbursement,  label:'Reimbursement',    always:true },
      { href:'provision.html',      icon: ICONS.provision,    label:'Provision',        roles:['admin','super_admin','hr','manager','tl'] },
      { href:'projects.html',       icon: ICONS.projects,     label:'Projects',         roles:['admin','super_admin','accounts'] },
    ]
  },
  {
    label: 'System',
    items: [
      { href:'geofence.html', icon: ICONS.geofence, label:'Geofence', roles:['admin','super_admin','hr'] },
      { href:'ai-voice.html',       icon: ICONS.aivoice,      label:'Voice Assistant',  always:true },
    ]
  },
];

// Flat NAV kept for any code that references it
const NAV = NAV_GROUPS.flatMap(g => g.items);

function buildSidebar(activePage) {
  const user = Auth.getUser(); if (!user) return;

  // Inject logo image
  const logoEl = document.getElementById('sidebar-logo-mark');
  if (logoEl) {
    logoEl.innerHTML = '<img src="' + (window.CFG.logoUrl || 'Logo.png') + '" alt="' + window.CFG.clientName + '" style="width:100%;height:100%;object-fit:contain;border-radius:0;">';
  }
  // Inject logo text only — no subtitle
  const logoText = document.getElementById('sidebar-logo-text');
  if (logoText) logoText.innerHTML = window.CFG.logoHtml || window.CFG.clientName;
  // Hide company sub and edition lines
  ['sidebar-company-short','sidebar-company-sub','sidebar-edition'].forEach(function(id){
    var el = document.getElementById(id); if(el) el.style.display = 'none';
  });

  const nav = document.getElementById('sidebar-nav'); if (!nav) return;

  // Build grouped nav HTML with collapsible sections
  // Load saved collapse states from localStorage
  let collapseState = {};
  try { collapseState = JSON.parse(localStorage.getItem('navCollapse') || '{}'); } catch(e) {}

  let html = '';
  for (const group of NAV_GROUPS) {
    const visibleItems = group.items.filter(l => {
      if (l.hideRoles && l.hideRoles.includes(user.role)) return false;
      return l.always || (l.roles && l.roles.includes(user.role));
    });
    if (visibleItems.length === 0) continue;

    if (group.label) {
      const groupId = 'navgroup-' + group.label.replace(/\s+/g, '-').toLowerCase();
      const hasActive = visibleItems.some(l => l.href === activePage);
      // Default closed; open if user expanded it before OR if it contains the active page
      const savedOpen = collapseState[groupId]; // true/false/undefined
      const open = hasActive || savedOpen === true;
      html += `
        <div class="nav-section-header" data-group="${groupId}" onclick="toggleNavGroup('${groupId}')" style="${open ? 'border-radius:10px 10px 0 0;border-bottom:none;margin-bottom:0' : 'border-radius:10px'}">
          <span class="nav-section-label-text">${group.label}</span>
          <span class="nav-section-chevron ${open ? 'open' : ''}">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2 4L6 8L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
        </div>
        <div class="nav-section-items ${open ? 'open' : ''}" id="${groupId}">
      `;
      for (const l of visibleItems) {
        html += `<a href="${l.href}" class="nav-link ${activePage === l.href ? 'active' : ''}"><span class="nav-icon">${l.icon}</span><span>${l.label}</span></a>`;
      }
      html += `</div>`;
    } else {
      // No label group (Dashboard) — always visible
      for (const l of visibleItems) {
        html += `<a href="${l.href}" class="nav-link ${activePage === l.href ? 'active' : ''}"><span class="nav-icon">${l.icon}</span><span>${l.label}</span></a>`;
      }
    }
  }
  nav.innerHTML = html;

  const u = document.getElementById('sidebar-user');
  if (u) u.innerHTML = `<div class="user-avatar">${(user.first_name?.[0]||'')}${(user.last_name?.[0]||'')}</div><div class="user-info" style="flex:1;min-width:0"><div class="user-name">${user.first_name} ${user.last_name}</div><div class="user-role" style="background:${Role.badge(user.role)}">${user.role.toUpperCase()}</div></div>`;
}

function toggleNavGroup(groupId) {
  const items = document.getElementById(groupId);
  const header = document.querySelector('[data-group="' + groupId + '"]');
  if (!items || !header) return;
  const chevron = header.querySelector(".nav-section-chevron");
  const isOpen = items.classList.contains("open");

  if (isOpen) {
    // Collapse with animation
    items.style.height = items.scrollHeight + "px";
    items.style.overflow = "hidden";
    items.style.transition = "height 0.25s ease";
    requestAnimationFrame(() => {
      items.style.height = "0px";
    });
    setTimeout(() => {
      items.classList.remove("open");
      items.style.height = "";
      items.style.overflow = "";
      items.style.transition = "";
    }, 260);
  } else {
    // Expand with animation
    items.classList.add("open");
    const h = items.scrollHeight;
    items.style.height = "0px";
    items.style.overflow = "hidden";
    items.style.transition = "height 0.25s ease";
    requestAnimationFrame(() => {
      items.style.height = h + "px";
    });
    setTimeout(() => {
      items.style.height = "";
      items.style.overflow = "";
      items.style.transition = "";
      // Force sidebar-nav to recalculate scroll
      const nav = document.getElementById("sidebar-nav");
      if (nav) { nav.style.overflow = "hidden"; requestAnimationFrame(() => { nav.style.overflow = "auto"; }); }
    }, 260);
  }

  if (chevron) chevron.classList.toggle("open", !isOpen);
  // Toggle rounded corners on header based on open state
  header.style.borderRadius = !isOpen ? '10px 10px 0 0' : '10px';
  header.style.borderBottom = !isOpen ? 'none' : '';
  header.style.marginBottom = !isOpen ? '0' : '0';
  let collapseState = {};
  try { collapseState = JSON.parse(localStorage.getItem("navCollapse") || "{}"); } catch(e) {}
  collapseState[groupId] = !isOpen;
  localStorage.setItem("navCollapse", JSON.stringify(collapseState));
}

function getNotifDeepLink(n) {
  const type = n.reference_type || '';
  const id   = n.reference_id   || '';
  if (type === 'attendance_regularization') return `attendance.html#regularize:${id}`;
  if (type === 'leave')                     return `leaves.html`;
  if (type === 'advance')                   return `advance.html`;
  if (type === 'payslip')                   return `payroll.html`;
  return null;
}

async function loadNotifBadge() {
  const data = await api('GET', '/notifications');
  if (!data?.success) return;

  const unread = data.unread || 0;
  const notifs = data.data   || [];

  // Badge
  const badge = document.getElementById('notif-badge');
  if (badge) {
    if (unread > 0) { badge.textContent = unread > 99 ? '99+' : unread; badge.style.display = 'flex'; }
    else             { badge.style.display = 'none'; }
  }

  // Bell button — inject if not present
  const bellBtn = document.getElementById('notif-bell-btn');
  if (!bellBtn) return;

  // Panel
  let panel = document.getElementById('notif-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'notif-panel';
    panel.style.cssText = `
      display:none;position:fixed;top:56px;right:16px;z-index:9998;
      width:360px;max-height:480px;overflow-y:auto;
      background:#fff;border-radius:16px;box-shadow:0 8px 40px rgba(15,23,42,.18);
      border:1px solid #e2e8f0;font-family:var(--cfg-font,'DM Sans',sans-serif);`;
    document.body.appendChild(panel);
  }

  function renderPanel() {
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #f1f5f9;position:sticky;top:0;background:#fff;z-index:1">
        <div style="font-weight:700;font-size:15px;color:#0f172a">Notifications</div>
        <div style="display:flex;gap:8px;align-items:center">
          <button onclick="markAllNotifsRead()" style="font-size:11px;color:#10b981;font-weight:600;background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:6px;hover:background:#f0fdf4">Mark all read</button>
          <button onclick="document.getElementById('notif-panel').style.display='none'" style="background:none;border:none;cursor:pointer;font-size:18px;color:#94a3b8;line-height:1">×</button>
        </div>
      </div>
      ${notifs.length === 0
        ? `<div style="padding:32px;text-align:center;color:#94a3b8;font-size:13px">No notifications</div>`
        : notifs.map(n => {
            const link    = getNotifDeepLink(n);
            const isUnread= !n.is_read;
            return `
            <div onclick="handleNotifClick(${n.id},'${link||''}')"
                 style="padding:14px 16px;border-bottom:1px solid #f8fafc;cursor:${link?'pointer':'default'};
                        background:${isUnread?'#f0fdf4':'#fff'};transition:background .15s"
                 onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='${isUnread?'#f0fdf4':'#fff'}'">
              <div style="display:flex;gap:10px;align-items:flex-start">
                <div style="font-size:20px;flex-shrink:0;margin-top:1px">${n.title?.match(/[\u{1F300}-\u{1FFFF}]|[\u2600-\u27FF]/u)?.[0] || '🔔'}</div>
                <div style="flex:1;min-width:0">
                  <div style="font-weight:${isUnread?'700':'600'};font-size:13px;color:#0f172a;margin-bottom:2px">${n.title}</div>
                  <div style="font-size:12px;color:#64748b;line-height:1.45">${n.message}</div>
                  <div style="font-size:11px;color:#94a3b8;margin-top:5px">${fmt.ago(n.created_at)}</div>
                </div>
                ${isUnread ? `<div style="width:8px;height:8px;border-radius:50%;background:#10b981;flex-shrink:0;margin-top:5px"></div>` : ''}
              </div>
            </div>`;
          }).join('')
      }`;
  }

  renderPanel();

  // Toggle on bell click
  bellBtn.onclick = (e) => {
    e.stopPropagation();
    const visible = panel.style.display === 'block';
    panel.style.display = visible ? 'none' : 'block';
    if (!visible) loadNotifBadge(); // refresh on open
  };

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (panel.style.display === 'block' && !panel.contains(e.target) && e.target !== bellBtn)
      panel.style.display = 'none';
  }, { once: false });
}

async function handleNotifClick(id, link) {
  await api('PATCH', `/notifications/${id}/read`);
  if (link) window.location.href = link;
}

async function markAllNotifsRead() {
  await api('PATCH', '/notifications/read-all');
  document.getElementById('notif-panel').style.display = 'none';
  loadNotifBadge();
}

function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
document.addEventListener('click', e => {
  // Only close the modal when clicking directly on the semi-transparent backdrop overlay,
  // not when a button/link inside the modal fires and the event bubbles up to document.
  // e.target is the exact element clicked; it will be the backdrop div only when the
  // user clicks outside the white modal box.
  if (e.target.classList.contains('modal-backdrop')) {
    e.target.classList.remove('open');
  }
});

// ── Sidebar mobile toggle ─────────────────────────────────────────
function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (!sidebar) return;
  sidebar.classList.toggle('open');
  if (overlay) overlay.classList.toggle('open');
}
function closeSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
}

// ── Floating Voice Assistant Bubble (shown on all pages except ai-voice.html) ──
(function injectVoiceBubble() {
  if (window.location.pathname.includes('ai-voice.html')) return;
  if (window.location.pathname.includes('login.html')) return;
  if (window.location.pathname.includes('forgot-password.html')) return;

  const style = document.createElement('style');
  style.textContent = `
    #va-bubble {
      position: fixed;
      bottom: 28px;
      right: 28px;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: center;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      animation: va-float 3s ease-in-out infinite;
    }
    #va-bubble:hover #va-circle { transform: scale(1.08); }
    #va-bubble:active #va-circle { transform: scale(0.95); }
    #va-circle {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: linear-gradient(145deg, var(--cfg-primary, #333), var(--cfg-accent, #555), var(--cfg-light, #888));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      box-shadow: 0 6px 24px rgba(192,39,45,.4);
      transition: transform .2s cubic-bezier(.34,1.56,.64,1), box-shadow .3s;
      position: relative;
    }
    #va-circle::after {
      content: '';
      position: absolute;
      inset: -4px;
      border-radius: 50%;
      border: 2px solid rgba(192,39,45,.35);
      animation: va-ring 2.5s ease-out infinite;
    }
    #va-label {
      margin-top: 7px;
      background: #0f172a;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      padding: 5px 12px;
      border-radius: 20px;
      white-space: nowrap;
      box-shadow: 0 3px 12px rgba(0,0,0,.25);
      font-family: var(--cfg-font, 'DM Sans', sans-serif);
    }
    @keyframes va-float {
      0%,100% { transform: translateY(0); }
      50%      { transform: translateY(-6px); }
    }
    @keyframes va-ring {
      0%   { transform: scale(1); opacity: .6; }
      100% { transform: scale(1.6); opacity: 0; }
    }
    @media (max-width: 600px) {
      #va-bubble { bottom: 18px; right: 16px; }
      #va-circle { width: 54px; height: 54px; font-size: 24px; }
    }
  `;
  document.head.appendChild(style);

  const bubble = document.createElement('div');
  bubble.id = 'va-bubble';
  bubble.title = 'Voice HR Assistant';
  bubble.innerHTML = '<div id="va-circle">🤖</div><div id="va-label">Voice Assistant</div>';
  bubble.addEventListener('click', () => { window.location.href = 'ai-voice.html'; });
  document.body.appendChild(bubble);
})();
