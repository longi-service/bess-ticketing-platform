/* ============================================================================
 * app.js — BESS Service Desk SPA (v1, vanilla JS, no build step).
 *
 * Data NEVER goes to localStorage (old-demo bug): only the Supabase Auth
 * session (managed by the supabase-js client itself) and the UI language
 * preference ('bess_lang') are persisted locally.
 *
 * UI gating uses BessLogic.can / allowedTransitions / canViewTicket; the
 * database RLS policies are the real enforcement — every mutation catches
 * errors and shows them visibly instead of failing silently.
 * ========================================================================== */
(function () {
  'use strict';

  var L = window.BessLogic;
  if (!L) { document.getElementById('app').innerHTML = '<p>logic.js failed to load.</p>'; return; }

  /* ------------------------------ config ------------------------------ */
  var cfg = window.APP_CONFIG || {};
  var KEY_MISSING = !cfg.SUPABASE_ANON_KEY ||
                    cfg.SUPABASE_ANON_KEY === 'PASTE_PUBLISHABLE_KEY_HERE';
  var CDN_MISSING = !window.supabase;
  var sb = null;
  if (!KEY_MISSING && !CDN_MISSING) {
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  }

  /* ------------------------------- i18n -------------------------------- */
  var lang = (function () {
    try { return localStorage.getItem('bess_lang') || 'en'; } catch (e) { return 'en'; }
  })();
  if (window.I18N && !window.I18N[lang]) lang = 'en';

  /** t('key', {var: val}) — missing key falls back to English, then the key. */
  function t(key, vars) {
    var d = (window.I18N && window.I18N[lang]) || {};
    var s = d[key];
    if (s == null && lang !== 'en') s = window.I18N.en[key];
    if (s == null) return key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.split('{' + k + '}').join(String(vars[k]));
      });
    }
    return s;
  }

  function setLang(l) {
    if (!window.I18N[l]) return;
    lang = l;
    try { localStorage.setItem('bess_lang', l); } catch (e) {}
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
    // Persist to profile (fire-and-forget; localStorage is the fallback).
    if (state.profile && sb) {
      sb.from('profiles').update({ language: l }).eq('id', state.profile.id)
        .then(function () {}, function () {});
    }
    render();
  }

  /* ------------------------------- state ------------------------------- */
  var state = {
    user: null,          // auth user
    profile: null,       // profiles row {id,email,display_name,role,...,project_scope,is_active}
    ready: false,
    slaPolicies: L.normalizePolicies(L.DEFAULT_SLA_POLICIES),
    sites: [],
    contracts: {},     // v2: site_id -> ltsa_contracts row
    v3: false,         // v3: true once migration_v3 tables are detected
    customers: [],     // v3: customer companies
    v4: false,         // v4: true once migration_v4 tables are detected
    statusDefs: [],    // v4: engineer_status_definitions rows (sort_order)
    statusDefMap: {},  // v4: status key -> definition row
    dutyDefs: [],      // v4: duty_type_definitions rows (sort_order)
    dutyDefMap: {},    // v4: duty key -> definition row
    nameCache: {},       // profile id -> display name (best effort)
    listFilters: { status: '', priority: '', source: '', site: '', assignee: '', q: '', tag: '', customer: '',
                 unassignedOnly: false, contractOnly: false }, // v3 U6: quick filters
    listPage: 0,           // v3 D7: pagination cursor (page index), reset on filter change
    siteSearch: ''       // v2: sites tree search text
  };

  /* ================= v4: table-driven status/duty definitions ============= */
  /* Fallback definitions — exact colors from migration_v4, used when the
     definition tables are unavailable (!state.v4). Labels come from i18n. */
  var STATUS_DEFS_FALLBACK = [
    { key: 'campo',      bg_color: '#fee2e2', text_color: '#b91c1c', sort_order: 1 },
    { key: 'ferie',      bg_color: '#dbeafe', text_color: '#1d4ed8', sort_order: 2 },
    { key: 'malattia',   bg_color: '#f1f5f9', text_color: '#475569', sort_order: 3 },
    { key: 'formazione',  bg_color: '#ede9fe', text_color: '#6d28d9', sort_order: 4 },
    { key: 'trasferta',   bg_color: '#ffedd5', text_color: '#9a3412', sort_order: 5 },
    { key: 'festivo',    bg_color: '#fef3c7', text_color: '#92400e', sort_order: 6 },
    { key: 'weekend',    bg_color: '#f8fafc', text_color: '#94a3b8', sort_order: 7 },
    { key: 'remoto',     bg_color: '#dcfce7', text_color: '#15803d', sort_order: 8 }
  ];
  var DUTY_DEFS_FALLBACK = [
    { key: 'remote_call',  bg_color: '#dcfce7', text_color: '#15803d', icon: 'message', sort_order: 1 },
    { key: 'phone_oncall', bg_color: '#dbeafe', text_color: '#1d4ed8', icon: 'phone',   sort_order: 2 },
    { key: 'field_oncall', bg_color: '#ffedd5', text_color: '#9a3412', icon: 'tool',    sort_order: 3 }
  ];
  var STATUS_FALLBACK_MAP = {}, DUTY_FALLBACK_MAP = {};
  STATUS_DEFS_FALLBACK.forEach(function (d) { STATUS_FALLBACK_MAP[d.key] = d; });
  DUTY_DEFS_FALLBACK.forEach(function (d) { DUTY_FALLBACK_MAP[d.key] = d; });

  /** statusDef(key) → definition row or gray fallback. dutyDef(key) likewise. */
  function statusDef(key) {
    return state.statusDefMap[key] || STATUS_FALLBACK_MAP[key] ||
      { key: key, bg_color: '#f1f5f9', text_color: '#64748b' };
  }
  function dutyDef(key) {
    return state.dutyDefMap[key] || DUTY_FALLBACK_MAP[key] ||
      { key: key, bg_color: '#f1f5f9', text_color: '#64748b', icon: 'phone' };
  }
  function statusDefs() {
    return state.statusDefs.length ? state.statusDefs : STATUS_DEFS_FALLBACK;
  }
  function dutyDefs() {
    return state.dutyDefs.length ? state.dutyDefs : DUTY_DEFS_FALLBACK;
  }
  /** statusLabel(key): live DB label when v4, else the i18n fallback. */
  function statusLabel(key) {
    var d = state.statusDefMap[key];
    if (d) return lang === 'zh' ? (d.label_zh || d.label_en || key) : (d.label_en || d.label_zh || key);
    return t('plan.status.' + key);
  }
  function dutyLabel(key) {
    var d = state.dutyDefMap[key];
    if (d) return lang === 'zh' ? (d.label_zh || d.label_en || key) : (d.label_en || d.label_zh || key);
    return t('plan.duty.' + key);
  }
  /** statusBadge(key, extra) — tinted badge rendered from the definition colors. */
  function statusBadge(key, extra) {
    var d = statusDef(key);
    return '<span class="badge"' + (extra ? ' ' + extra : '') +
      ' style="background:' + d.bg_color + ';color:' + d.text_color + '">' +
      esc(statusLabel(key)) + '</span>';
  }
  /** dutyBadgeHtml(key) — duty badge with its SVG icon, def-driven colors. */
  function dutyBadgeHtml(key) {
    var d = dutyDef(key);
    return '<span class="duty-badge" style="background:' + d.bg_color + ';color:' + d.text_color + '">' +
      icon(d.icon || 'phone', 11) + '<span>' + esc(dutyLabel(key)) + '</span></span>';
  }
  /** dayPartLabel('am') → i18n label. */
  function dayPartLabel(dp) {
    return t('plan.dayPart.' + (dp === 'am' || dp === 'pm' ? dp : 'full'));
  }
  /** absenceDefKey('vacation') → 'ferie' (DB shift status → definition key). */
  function absenceDefKey(s) {
    return (L.ABSENCE_TO_DEF[s] || 'ferie');
  }
  /** regionName('South EU') → i18n label. */
  var REGION_I18N = { 'DACH': 'region.dach', 'South EU': 'region.south_eu',
    'West EU': 'region.west_eu', 'North EU': 'region.north_eu', 'East EU': 'region.east_eu' };
  function regionName(r) {
    return REGION_I18N[r] ? t(REGION_I18N[r]) : r;
  }
  /** dutyKeyValid(key) — app-side validation of duty_type (the DB no longer
      constrains it; the app validates against the loaded definitions). */
  function dutyKeyValid(key) {
    if (!key) return false;
    if (state.dutyDefMap[key]) return true;
    return DUTY_FALLBACK_MAP[key] != null;
  }

  /* ================= v4: inline SVG icon set (no new CDN) ================= */
  /* Replaces emoji in duty badges, holiday markers and note markers so the
     scheduling UI renders identically on every platform. */
  var ICON_PATHS = {
    message: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    star: '<path d="M12 2l2.9 6.26 6.6 1.04-4.75 4.87L17.8 21 12 17.77 6.2 21l1.05-6.83L2.5 9.3l6.6-1.04L12 2z"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    laptop: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'
  };
  /**
   * icon(name, size) → inline SVG string. Star is filled; the rest are
   * stroke-based (currentColor) so they inherit the badge/text color.
   */
  function icon(name, size) {
    var s = size || 12;
    var p = ICON_PATHS[name] || ICON_PATHS.phone;
    var fill = name === 'star' ? ' fill="currentColor" stroke="none"'
                               : ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24"' + fill +
      ' aria-hidden="true">' + p + '</svg>';
  }

  /* ------------------------------ helpers ------------------------------ */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg, kind) {
    var root = document.getElementById('toast-root');
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(function () { el.remove(); }, (kind === 'error' || kind === 'warn') ? 6000 : 3500);
  }

  /** Human-readable Supabase/RLS error → toast + inline element message. */
  function apiError(err, fallbackKey) {
    var msg = (err && err.message) ? err.message : t(fallbackKey || 'common.error');
    // RLS denials come back as plain errors — surface them plainly, never crash.
    toast(msg, 'error');
    return msg;
  }

  function fmtDate(iso) {
    if (!iso) return t('common.notSet');
    var d = new Date(iso);
    if (isNaN(d)) return t('common.notSet');
    return d.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-GB',
      { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function fmtInputDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** fmtDur(ms) → "2d 3h" style using i18n units. */
  function fmtDur(ms) {
    ms = Math.abs(ms);
    var m = Math.floor(ms / 60000);
    var d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
    m = m % 60;
    if (d > 0) return t('time.days', { n: d }) + (h > 0 ? ' ' + t('time.hours', { n: h }) : '');
    if (h > 0) return t('time.hours', { n: h }) + (m > 0 ? ' ' + t('time.minutes', { n: m }) : '');
    if (m > 0) return t('time.minutes', { n: m });
    return t('time.justNow');
  }

  function slaCountdown(clock) {
    if (clock.remainingMs == null) return t('detail.sla.noDeadline');
    if (clock.state === 'breached') return t('time.overdueBy', { d: fmtDur(clock.remainingMs) });
    return t('time.remaining', { d: fmtDur(clock.remainingMs) });
  }

  function displayName(id) {
    if (!id) return t('common.unassigned');
    if (state.nameCache[id]) return state.nameCache[id];
    if (state.profile && id === state.profile.id) return state.profile.display_name || state.profile.email;
    return id.slice(0, 8) + '…';
  }

  /** Best-effort batch name resolution; falls back gracefully on RLS denial. */
  async function resolveNames(ids) {
    var missing = ids.filter(function (id) { return id && !state.nameCache[id]; });
    if (!missing.length || !sb) return;
    try {
      var res = await sb.from('profiles').select('id,display_name,email').in('id', missing);
      if (!res.error && res.data) {
        res.data.forEach(function (p) {
          state.nameCache[p.id] = p.display_name || p.email || p.id.slice(0, 8) + '…';
        });
      }
    } catch (e) { /* names stay as short ids — non-fatal */ }
  }

  function siteLabel(siteId) {
    var s = state.sites.find(function (x) { return x.id === siteId; });
    return s ? (s.code + ' — ' + s.name) : (siteId ? t('common.notSet') : t('common.notSet'));
  }

  /* ------------------------------ data --------------------------------- */
  async function loadReferenceData() {
    // SLA policies (authenticated SELECT per contract; fallback to seeds).
    try {
      var pr = await sb.from('sla_policies').select('*');
      if (!pr.error && pr.data && pr.data.length) {
        state.slaPolicies = L.normalizePolicies(pr.data);
      }
    } catch (e) {}
    // Sites (authenticated SELECT per contract).
    try {
      var sr = await sb.from('sites').select('*').order('code');
      if (!sr.error) state.sites = sr.data || [];
      else apiError(sr.error);
    } catch (e) {}
    // LTSA contracts (v2; table may not exist until migration_v2 is applied).
    try {
      var cr = await sb.from('ltsa_contracts').select('*');
      if (!cr.error) {
        state.contracts = {};
        (cr.data || []).forEach(function (c) { state.contracts[c.site_id] = c; });
      }
    } catch (e) {}
    // v3: feature probe — ticket_links exists only after migration_v3.
    // Gates all v3 UI (tags, links, onsite dates, duty types, holidays,
    // customers) so the app keeps working on a v2-only backend.
    state.v3 = false;
    try {
      var v3p = await sb.from('ticket_links').select('id', { count: 'exact', head: true });
      state.v3 = !v3p.error;
    } catch (e) { state.v3 = false; }
    // v3: customer companies (for site.customer_id picker + filters).
    state.customers = [];
    if (state.v3) {
      try {
        var cu = await sb.from('customers').select('*').order('company_name');
        if (!cu.error) state.customers = cu.data || [];
      } catch (e) {}
    }
    // v4: feature probe — engineer_status_definitions exists only after
    // migration_v4. When present, load both definition tables; the app
    // renders ALL status/duty colors and labels from them (table-driven,
    // zero code change to add a new status). Otherwise the hardcoded
    // fallback defs below are used (same colors, i18n labels).
    state.v4 = false;
    state.statusDefs = []; state.statusDefMap = {};
    state.dutyDefs = []; state.dutyDefMap = {};
    try {
      var v4p = await sb.from('engineer_status_definitions').select('id', { count: 'exact', head: true });
      state.v4 = !v4p.error;
    } catch (e) { state.v4 = false; }
    if (state.v4) {
      try {
        var sdr = await sb.from('engineer_status_definitions').select('*').order('sort_order');
        var ddr = await sb.from('duty_type_definitions').select('*').order('sort_order');
        if (!sdr.error) {
          state.statusDefs = sdr.data || [];
          state.statusDefs.forEach(function (d) { state.statusDefMap[d.key] = d; });
        }
        if (!ddr.error) {
          state.dutyDefs = ddr.data || [];
          state.dutyDefs.forEach(function (d) { state.dutyDefMap[d.key] = d; });
        }
      } catch (e) { /* defs stay empty → helpers fall back to hardcoded */ }
    }
  }

  /** Role-aware base ticket query (RLS is the real filter; this trims noise).
   *  columns/selectOpts are passed straight to .select() (default '*'). */
  function baseTicketQuery(columns, selectOpts) {
    var q = sb.from('tickets').select(columns || '*', selectOpts);
    var p = state.profile, role = p.role, me = p.id;
    if (role === 'admin' || role === 'dispatcher') { /* no extra filter */ }
    else if (role === 'pm') {
      var scope = p.project_scope || [];
      if (scope.length) {
        q = q.or('site_id.in.(' + scope.join(',') + '),created_by.eq.' + me + ',assigned_to.eq.' + me);
      }
    } else if (role === 'engineer') {
      q = q.or('created_by.eq.' + me + ',assigned_to.eq.' + me);
    } else { // customer
      q = q.eq('created_by', me);
    }
    return q;
  }

  async function fetchTickets(filters, opts) {
    opts = opts || {};
    var q = applyTicketFilters(baseTicketQuery(), filters).order('updated_at', { ascending: false });
    // v3 D7: pagination. Default keeps the old behavior (first 500 rows).
    var limit = opts.limit != null ? opts.limit : 500;
    if (opts.offset) q = q.range(opts.offset, opts.offset + limit - 1);
    else if (limit) q = q.limit(limit);
    var res = await q;
    if (res.error) { apiError(res.error); return []; }
    return res.data || [];
  }

  /** v3 D7/U6: shared filter application for fetchTickets/countTickets. */
  function applyTicketFilters(q, filters) {
    if (filters.status) q = q.eq('status', filters.status);
    if (filters.priority) q = q.eq('priority', filters.priority);
    if (filters.source) q = q.eq('source', filters.source);
    if (filters.site) q = q.eq('site_id', filters.site);
    if (filters.assignee) q = q.eq('assigned_to', filters.assignee);
    if (filters.tag) q = q.contains('tags', [filters.tag]);
    // v3 F6: customer filter resolves to that customer's site ids.
    if (filters.customer) {
      var cSiteIds = state.sites.filter(function (s) { return s.customer_id === filters.customer; })
        .map(function (s) { return s.id; });
      q = cSiteIds.length ? q.in('site_id', cSiteIds) : q.eq('site_id', '00000000-0000-0000-0000-000000000000');
    }
    // v3 U6: quick filters.
    if (filters.unassignedOnly) q = q.is('assigned_to', null);
    if (filters.contractOnly) q = q.eq('is_ltsa', true);
    if (filters.q) {
      var term = filters.q.trim();
      var m = term.match(/^t-?0*(\d+)$/i);
      if (m) q = q.eq('ticket_no', parseInt(m[1], 10));
      else {
        var like = '%' + term.replace(/[%_]/g, '') + '%';
        q = q.or('title.ilike.' + like + ',description.ilike.' + like);
      }
    }
    return q;
  }

  /** v3 D7/U5: exact count of tickets matching filters (RLS-scoped, no rows). */
  async function countTickets(filters) {
    var q = applyTicketFilters(baseTicketQuery('id', { count: 'exact', head: true }), filters);
    var res = await q;
    if (res.error || res.count == null) return 0;
    return res.count;
  }

  /**
   * App-side escalation job (contract §6: no cron in v1).
   * Breach ⇒ escalated=true, escalated_at=now(). Runs on list/detail render.
   * Update failures (e.g. RLS) are swallowed here — the badge still shows
   * "breached"; this is a background hint, not a user action.
   */
  async function runEscalationJob(tickets) {
    if (!sb) return;
    var now = new Date().toISOString();
    for (var i = 0; i < tickets.length; i++) {
      var tk = tickets[i];
      if (!tk.escalated && L.isSlaBreached(tk, now)) {
        try {
          var r = await sb.from('tickets')
            .update({ escalated: true, escalated_at: now }).eq('id', tk.id);
          if (!r.error) { tk.escalated = true; tk.escalated_at = now; }
        } catch (e) {}
      }
    }
  }

  /* ------------------------------ router -------------------------------- */
  var app = document.getElementById('app');

  function nav(hash) { window.location.hash = hash; }

  function currentRoute() {
    var h = window.location.hash || '#/dashboard';
    var m = h.match(/^#\/ticket\/([0-9a-f-]{36})$/i);
    if (m) return { name: 'detail', id: m[1] };
    var ms = h.match(/^#\/site\/([0-9a-f-]{36})$/i);
    if (ms) return { name: 'site', id: ms[1] };
    var name = h.replace(/^#\//, '').split('?')[0];
    if (['login', 'dashboard', 'tickets', 'new', 'parts', 'planning', 'calendar', 'users', 'sites', 'sla-alerts'].indexOf(name) === -1) name = 'dashboard';
    return { name: name };
  }

  function requireAuth(route) {
    if (!state.profile) { nav('#/login'); return false; }
    return true;
  }

  /** Route guard: permission string from the logic.js matrix (or null). */
  function guard(permission) {
    if (!permission) return true;
    if (!L.can(permission, state.profile.role)) {
      app.innerHTML = '<div class="page"><div class="inline-err">' +
        esc(t('common.noPermissionView')) + '</div></div>';
      return false;
    }
    return true;
  }

  window.addEventListener('hashchange', render);

  async function render() {
    var route = currentRoute();
    if (KEY_MISSING || CDN_MISSING) { viewLogin(true); return; }
    if (route.name === 'login') {
      if (state.profile) { nav('#/dashboard'); return; }
      viewLogin(false); return;
    }
    if (!requireAuth(route)) return;
    renderShell(route.name === 'site' ? 'sites' : route.name);
    var view = document.getElementById('view');
    view.innerHTML = '<div class="empty">' + esc(t('common.loading')) + '</div>';
    try {
      if (route.name === 'dashboard') await viewDashboard(view);
      else if (route.name === 'tickets') await viewTicketList(view);
      else if (route.name === 'detail') await viewTicketDetail(view, route.id);
      else if (route.name === 'new') viewNewTicket(view);
      else if (route.name === 'parts') {
        /* v3 I3: explicit empty state instead of the generic guard denial. */
        if (L.can('part.view', state.profile.role)) await viewParts(view);
        else viewPartsNoAccess(view);
      }
      else if (route.name === 'planning') { if (guard('plan.view')) await viewPlanning(view); }
      else if (route.name === 'calendar') { if (guard('plan.view')) await viewCalendar(view); }
      else if (route.name === 'site') { if (guard('site.manage')) await viewSiteDetail(view, route.id); }
      else if (route.name === 'users') { if (guard('user.manage')) await viewUsers(view); }
      else if (route.name === 'sites') { if (guard('site.manage')) await viewSites(view); }
      else if (route.name === 'sla-alerts') {
        /* v3 F8: dashboard-linked only (no nav item); dispatcher/admin/pm only. */
        if (['admin', 'dispatcher', 'pm'].indexOf(state.profile.role) === -1) {
          app.innerHTML = '<div class="page"><div class="inline-err">' +
            esc(t('common.noPermissionView')) + '</div></div>';
        } else await viewSlaAlerts(view);
      }
    } catch (e) {
      view.innerHTML = '<div class="inline-err">' + esc(e.message || t('common.error')) + '</div>';
    }
  }

  /* ------------------------------- shell -------------------------------- */
  /* v3: light sidebar (230px) replaces the top nav bar. Layout-only change:
     same 8 links, same order, same permission gating, same i18n labels. */
  function renderShell(active) {
    var p = state.profile;
    var groups = [
      { title: t('nav.group.overview'), links: [
        { id: 'dashboard', href: '#/dashboard', label: t('nav.dashboard'), perm: null }
      ] },
      { title: t('nav.group.work'), links: [
        { id: 'tickets',   href: '#/tickets',   label: t('nav.tickets'),   perm: null },
        { id: 'new',       href: '#/new',       label: t('nav.newTicket'), perm: 'ticket.create' },
        { id: 'parts',     href: '#/parts',     label: t('nav.parts'),     perm: 'part.view' },
        { id: 'planning',  href: '#/planning',  label: t('nav.planning'),  perm: 'plan.view' },
        { id: 'calendar',  href: '#/calendar',  label: t('nav.calendar'),  perm: 'plan.view' }
      ] },
      { title: t('nav.group.manage'), links: [
        { id: 'sites',     href: '#/sites',     label: t('nav.sites'),     perm: 'site.manage' },
        { id: 'users',     href: '#/users',     label: t('nav.users'),     perm: 'user.manage' }
      ] }
    ];
    var navHtml = groups.map(function (g) {
      var items = g.links
        .filter(function (l) { return !l.perm || L.can(l.perm, p.role); })
        .map(function (l) {
          return '<a href="' + l.href + '"' + (active === l.id ? ' class="active"' : '') + '>' +
                 esc(l.label) + '</a>';
        }).join('');
      if (!items) return '';
      return '<div class="nav-group"><div class="nav-group-title">' + esc(g.title) + '</div>' +
             items + '</div>';
    }).join('');
    app.innerHTML =
      '<div class="app-shell">' +
        '<aside class="sidebar" id="sidebar">' +
          '<div class="side-brand"><img src="assets/longi-logo.svg" alt="LONGi">' +
          '<span class="tagline">' + esc(t('app.tagline')) + '</span></div>' +
          '<nav class="side-nav">' + navHtml + '</nav>' +
          '<div class="side-user">' +
            '<div class="who"><b>' + esc(p.display_name || p.email) + '</b>' +
            '<span class="role-tag">' + esc(t('role.' + p.role)) + '</span></div>' +
            '<div class="side-user-actions">' +
              '<button class="lang-toggle" id="lang-toggle">' +
                (lang === 'en' ? '中文' : 'EN') + '</button>' +
              '<button class="btn btn-sm" id="logout-btn">' + esc(t('nav.logout')) + '</button>' +
            '</div>' +
          '</div>' +
        '</aside>' +
        '<div class="sidebar-scrim" id="sidebar-scrim"></div>' +
        '<div class="main-col">' +
          '<div class="mobile-topbar">' +
            '<button class="hamburger" id="hamburger" aria-label="Menu">☰</button>' +
            '<img src="assets/longi-logo.svg" alt="LONGi" class="mobile-logo">' +
          '</div>' +
          '<main class="page" id="view"></main>' +
        '</div>' +
      '</div>';
    document.getElementById('lang-toggle').onclick = function () {
      setLang(lang === 'en' ? 'zh' : 'en');
    };
    document.getElementById('logout-btn').onclick = logout;
    // Mobile off-canvas behavior.
    document.getElementById('hamburger').onclick = function () {
      document.body.classList.toggle('sidebar-open');
    };
    document.getElementById('sidebar-scrim').onclick = function () {
      document.body.classList.remove('sidebar-open');
    };
    // Close the off-canvas sidebar whenever navigation happens.
    document.querySelectorAll('.side-nav a').forEach(function (a) {
      a.addEventListener('click', function () {
        document.body.classList.remove('sidebar-open');
      });
    });
  }

  async function logout() {
    try { await sb.auth.signOut(); } catch (e) {}
    state.user = null; state.profile = null; state.nameCache = {};
    nav('#/login');
  }

  /* ------------------------------- login -------------------------------- */
  function viewLogin(configProblem) {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    var banner = (configProblem || KEY_MISSING)
      ? '<div class="setup-banner"><b>' + esc(t('auth.setupNeeded')) + '</b><br>' +
        esc(t('auth.setupMsg')) + '</div>'
      : '';
    app.innerHTML =
      '<div class="login-wrap"><div class="card login-card">' +
        '<div class="login-logo"><img src="assets/longi-logo.svg" alt="LONGi"></div>' +
        '<div class="login-tagline">' + esc(t('auth.tagline')) + '</div>' +
        '<h1>' + esc(t('auth.title')) + '</h1>' +
        banner +
        '<form id="login-form">' +
          '<div class="field"><label>' + esc(t('auth.email')) + '</label>' +
            '<input type="email" id="login-email" required autocomplete="username"></div>' +
          '<div class="field"><label>' + esc(t('auth.password')) + '</label>' +
            '<input type="password" id="login-password" required autocomplete="current-password"></div>' +
          '<div class="field-error" id="login-error" style="display:none"></div>' +
          '<div class="form-actions"><button class="btn btn-primary" style="width:100%;justify-content:center" ' +
            'type="submit" id="login-btn">' + esc(t('auth.signIn')) + '</button></div>' +
        '</form>' +
        '<div style="text-align:center;margin-top:10px">' +
          '<a href="#" id="login-forgot" style="font-size:13px;color:var(--brand-red,#E60012)">' +
            esc(t('auth.forgot')) + '</a>' +
        '</div>' +
        '<div style="text-align:center;margin-top:14px">' +
          '<button class="lang-toggle" id="login-lang">' + (lang === 'en' ? '中文' : 'EN') + '</button>' +
        '</div>' +
      '</div></div>';
    document.getElementById('login-lang').onclick = function () {
      setLang(lang === 'en' ? 'zh' : 'en');
    };
    document.getElementById('login-forgot').onclick = async function (e) {
      e.preventDefault();
      var errEl = document.getElementById('login-error');
      var email = document.getElementById('login-email').value.trim();
      if (!email) {
        errEl.textContent = t('auth.enterEmailFirst');
        errEl.style.display = 'block';
        return;
      }
      errEl.style.display = 'none';
      try {
        var redirectTo = window.location.origin + window.location.pathname;
        var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirectTo });
        if (r.error) throw r.error;
        toast(t('auth.resetSent'), 'ok');
      } catch (err2) {
        errEl.textContent = t('auth.resetFailed');
        errEl.style.display = 'block';
      }
    };
    if (KEY_MISSING || CDN_MISSING) return; // config banner only; no auth possible
    document.getElementById('login-form').onsubmit = async function (e) {
      e.preventDefault();
      var errEl = document.getElementById('login-error');
      var btn = document.getElementById('login-btn');
      errEl.style.display = 'none'; btn.disabled = true; btn.textContent = t('auth.signingIn');
      try {
        var email = document.getElementById('login-email').value.trim();
        var password = document.getElementById('login-password').value;
        var res = await sb.auth.signInWithPassword({ email: email, password: password });
        if (res.error) throw res.error;
        await afterSignIn(res.data.user);
      } catch (err) {
        errEl.textContent = (err && err.message) ? err.message : t('auth.failed');
        errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = t('auth.signIn');
      }
    };
    // If a session already exists (e.g. page reload), skip the form.
    sb.auth.getSession().then(function (r) {
      if (r.data && r.data.session && r.data.session.user && !state.profile) {
        afterSignIn(r.data.session.user).catch(function () {});
      }
    });
  }

  /* --------------------- set new password (recovery link) --------------------- */
  function viewSetPassword() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    app.innerHTML =
      '<div class="login-wrap"><div class="card login-card">' +
        '<div class="login-logo"><img src="assets/longi-logo.svg" alt="LONGi"></div>' +
        '<div class="login-tagline">' + esc(t('auth.tagline')) + '</div>' +
        '<h1>' + esc(t('auth.recoveryTitle')) + '</h1>' +
        '<form id="pw-form">' +
          '<div class="field"><label>' + esc(t('auth.newPassword')) + '</label>' +
            '<input type="password" id="pw-new" required autocomplete="new-password" minlength="6"></div>' +
          '<div class="field"><label>' + esc(t('auth.confirmPassword')) + '</label>' +
            '<input type="password" id="pw-confirm" required autocomplete="new-password" minlength="6"></div>' +
          '<div class="field-error" id="pw-error" style="display:none"></div>' +
          '<div class="form-actions"><button class="btn btn-primary" style="width:100%;justify-content:center" ' +
            'type="submit" id="pw-btn">' + esc(t('auth.setPassword')) + '</button></div>' +
        '</form>' +
      '</div></div>';
    document.getElementById('pw-form').onsubmit = async function (e) {
      e.preventDefault();
      var errEl = document.getElementById('pw-error');
      var btn = document.getElementById('pw-btn');
      var p1 = document.getElementById('pw-new').value;
      var p2 = document.getElementById('pw-confirm').value;
      errEl.style.display = 'none';
      if (p1.length < 6) { errEl.textContent = t('auth.passwordTooShort'); errEl.style.display = 'block'; return; }
      if (p1 !== p2) { errEl.textContent = t('auth.passwordMismatch'); errEl.style.display = 'block'; return; }
      btn.disabled = true;
      try {
        var r = await sb.auth.updateUser({ password: p1 });
        if (r.error) throw r.error;
        // Drop the recovery token from the URL, then return to sign-in.
        try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e2) {}
        await sb.auth.signOut();
        state.user = null; state.profile = null; state.nameCache = {};
        viewLogin();
        toast(t('auth.passwordUpdated'), 'ok');
      } catch (err) {
        errEl.textContent = (err && err.message) ? err.message : t('auth.failed');
        errEl.style.display = 'block';
        btn.disabled = false;
      }
    };
  }

  /** Shared post-sign-in: profile load + is_active gate. */
  async function afterSignIn(authUser) {
    var pr = await sb.from('profiles').select('*').eq('id', authUser.id).single();
    if (pr.error || !pr.data) {
      await sb.auth.signOut();
      throw new Error(t('auth.noProfile'));
    }
    if (!pr.data.is_active) {
      await sb.auth.signOut();
      throw new Error(t('auth.inactive'));
    }
    state.user = authUser;
    state.profile = pr.data;
    state.nameCache[pr.data.id] = pr.data.display_name || pr.data.email;
    // Language: profile wins; localStorage is the fallback.
    var pl = pr.data.language;
    if (pl && pl !== lang && window.I18N[pl]) {
      lang = pl;
      try { localStorage.setItem('bess_lang', pl); } catch (e) {}
    }
    await loadReferenceData();
    state.ready = true;
    nav('#/dashboard');
  }

  /* ----------------------------- dashboard ------------------------------ */
  var STATUS_COLORS = { open: '#6b7280', assigned: '#2b4acb', in_progress: '#0369a1',
                        pending: '#b45309', pending_customer: '#7e22ce',
                        resolved: '#1a7f4b', closed: '#9ca3af' };
  var PRI_COLORS = { low: '#9ca3af', medium: '#2b4acb', high: '#b45309', urgent: '#E60012' };

  /** donutSvg(segments) — inline SVG pie; segments: [{label, value, color}]. */
  function donutSvg(segments) {
    var total = segments.reduce(function (a, s) { return a + s.value; }, 0);
    var shown = total || 1;
    var r = 58, c = 2 * Math.PI * r, off = 0;
    var circles = segments.map(function (s) {
      var len = s.value / shown * c;
      var el = '<circle cx="75" cy="75" r="' + r + '" fill="none" stroke="' + s.color +
        '" stroke-width="24" stroke-dasharray="' + len.toFixed(2) + ' ' + (c - len).toFixed(2) +
        '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 75 75)"/>';
      off += len;
      return el;
    }).join('');
    return '<svg class="donut-svg" width="150" height="150" viewBox="0 0 150 150">' + circles +
      '<text x="75" y="82" text-anchor="middle" font-size="22" font-weight="800" fill="#1f2430">' +
      total + '</text></svg>';
  }

  function donutCard(title, segments) {
    var legend = segments.map(function (s) {
      return '<div class="li"><span class="sw" style="background:' + s.color + '"></span>' +
        esc(s.label) + '<span class="n">' + s.value + '</span></div>';
    }).join('');
    return '<div class="card"><h2>' + esc(title) + '</h2><div class="donut-wrap">' +
      donutSvg(segments) + '<div class="donut-legend">' + legend + '</div></div></div>';
  }

  /** siteAvailability(siteId, tickets, days) → % of tickets closed within
   *  sla_resolve_at over the last `days` days; null when none closed. */
  function siteAvailability(siteId, tickets, days) {
    var cutoff = Date.now() - days * 86400000;
    var closed = tickets.filter(function (x) {
      return x.site_id === siteId && x.closed_at &&
             new Date(x.closed_at).getTime() >= cutoff;
    });
    if (!closed.length) return null;
    var okN = closed.filter(function (x) {
      return x.sla_resolve_at &&
             new Date(x.closed_at).getTime() <= new Date(x.sla_resolve_at).getTime();
    }).length;
    return Math.round(100 * okN / closed.length);
  }

  /** ticketAtRisk(x) → any SLA clock warning or breached (open tickets). */
  function ticketAtRisk(x) {
    var c = L.ticketSla(x);
    return ['response', 'onsite', 'resolution'].some(function (k) {
      return c[k].state === 'warning' || c[k].state === 'breached';
    });
  }

  async function viewDashboard(view) {
    var tickets = await fetchTickets({});
    await runEscalationJob(tickets);
    await resolveNames(collectIds(tickets));
    var me = state.profile.id;
    var nowMs = Date.now(), d30 = nowMs - 30 * 86400000;
    var open = tickets.filter(function (x) { return L.TERMINAL_STATUSES.indexOf(x.status) === -1; });
    var unassigned = open.filter(function (x) { return !x.assigned_to; });
    var breached = open.filter(function (x) { return L.isSlaBreached(x); });
    var mine = open.filter(function (x) { return x.assigned_to === me || x.created_by === me; });
    var contractOpen = open.filter(function (x) { return x.is_ltsa; });
    var closed30 = tickets.filter(function (x) {
      return x.closed_at && new Date(x.closed_at).getTime() >= d30;
    });
    var responded30 = tickets.filter(function (x) {
      return x.responded_at && x.created_at && new Date(x.responded_at).getTime() >= d30;
    });
    var avgRespHrs = null;
    if (responded30.length) {
      var sum = responded30.reduce(function (a, x) {
        return a + (new Date(x.responded_at).getTime() - new Date(x.created_at).getTime());
      }, 0);
      avgRespHrs = sum / responded30.length / 3600000;
    }
    var compliant = closed30.filter(function (x) {
      return x.sla_resolve_at &&
             new Date(x.closed_at).getTime() <= new Date(x.sla_resolve_at).getTime();
    });
    var slaPct = closed30.length ? Math.round(100 * compliant.length / closed30.length) : null;

    function counter(label, n, danger, hash) {
      return '<div class="card counter kpi' + (danger ? ' danger' : '') + ' clickable" data-nav="' + hash + '">' +
        '<div class="kpi-accent"></div>' +
        '<div class="num">' + esc(String(n)) + '</div><div class="lbl">' + esc(label) + '</div></div>';
    }

  /** gaugeCard(label, pct, danger, hash) — radial SLA gauge (presentational;
   *  same data-nav click behavior as counter). */
  function gaugeCard(label, pct, danger, hash) {
    var r = 48, c = 2 * Math.PI * r;
    var p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    var off = c * (1 - p / 100);
    var col = danger ? '#E60012' : '#1a7f4b';
    var ring = '<svg class="gauge-svg" width="120" height="120" viewBox="0 0 120 120">' +
      '<circle cx="60" cy="60" r="' + r + '" fill="none" stroke="#edf0f4" stroke-width="12"/>' +
      '<circle class="gauge-ring" cx="60" cy="60" r="' + r + '" fill="none" stroke="' + col +
      '" stroke-width="12" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) +
      '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 60 60)"/>' +
      '<text x="60" y="68" text-anchor="middle" font-size="20" font-weight="800" fill="#1f2430">' +
      (pct == null ? '—' : pct + '%') + '</text></svg>';
    return '<div class="card counter kpi gauge-card' + (danger ? ' danger' : '') + ' clickable" data-nav="' + hash + '">' +
      '<div class="kpi-accent"></div>' + ring +
      '<div class="lbl">' + esc(label) + '</div></div>';
  }

    /* Donut data */
    var byStatus = L.STATUSES.map(function (s) {
      return { label: t('status.' + s), value: tickets.filter(function (x) { return x.status === s; }).length,
               color: STATUS_COLORS[s] || '#6b7280' };
    });
    var byPri = L.PRIORITIES.map(function (p) {
      return { label: t('priority.' + p), value: tickets.filter(function (x) { return x.priority === p; }).length,
               color: PRI_COLORS[p] || '#6b7280' };
    });

    /* Contract KPIs */
    var contracts = Object.keys(state.contracts || {}).map(function (k) { return state.contracts[k]; });
    var activeContracts = contracts.filter(function (c) { return L.isContractActive(c); });
    var contractBreached = contractOpen.filter(function (x) { return L.isSlaBreached(x); });
    var contractRows = activeContracts.map(function (c) {
      var site = state.sites.find(function (s) { return s.id === c.site_id; });
      var actual = siteAvailability(c.site_id, tickets, 90);
      var atRisk = open.filter(function (x) {
        return x.is_ltsa && x.site_id === c.site_id && ticketAtRisk(x);
      }).length;
      var hours = [c.response_hours, c.onsite_enabled ? c.onsite_hours : '—', c.resolve_hours]
        .map(function (h) { return h == null ? '—' : h + 'h'; }).join(' / ');
      return '<tr><td><b>' + esc(site ? site.code : '—') + '</b><br><span class="muted">' +
        esc(site ? site.name : '') + '</span></td>' +
        '<td>' + esc(c.availability_pct == null ? '—' : c.availability_pct + '%') + '</td>' +
        '<td>' + esc(actual == null ? '—' : actual + '%') + '</td>' +
        '<td class="muted">' + esc(c.coverage || '—') + '</td>' +
        '<td class="muted">' + esc(hours) + '</td>' +
        '<td>' + (atRisk > 0 ? badge('sla-breached', String(atRisk)) : esc(String(atRisk))) + '</td></tr>';
    }).join('');

    /* Team workload */
    var er = await sb.from('profiles').select('id,display_name,email')
      .eq('role', 'engineer').eq('is_active', true).order('display_name');
    var engineers = er.error ? [] : (er.data || []);
    var wl = engineers.map(function (e) {
      var assigned = open.filter(function (x) { return x.assigned_to === e.id; });
      return { eng: e,
               open: assigned.length,
               contract: assigned.filter(function (x) { return x.is_ltsa; }).length,
               breached: assigned.filter(function (x) { return L.isSlaBreached(x); }).length };
    });
    var maxOpen = Math.max.apply(null, wl.map(function (w) { return w.open; }).concat([1]));
    var wlRows = wl.map(function (w) {
      var pct = Math.round(100 * w.open / maxOpen);
      return '<tr><td><b>' + esc(w.eng.display_name || w.eng.email) + '</b></td>' +
        '<td><div style="display:flex;align-items:center;gap:8px"><div class="loadbar"><div style="width:' +
        pct + '%"></div></div><b>' + w.open + '</b></div></td>' +
        '<td>' + (w.contract ? badge('contract', String(w.contract)) : '<span class="muted">0</span>') + '</td>' +
        '<td>' + (w.breached ? badge('sla-breached', String(w.breached)) : '<span class="muted">0</span>') + '</td></tr>';
    }).join('');

    /* v3 U2: needs-attention queue — breached first, then unassigned, top 10 */
    var breachedIds = {};
    breached.forEach(function (x) { breachedIds[x.id] = true; });
    var attn = breached.concat(unassigned.filter(function (x) {
      return !breachedIds[x.id];
    })).slice(0, 10);
    var attnRows = attn.map(function (x) {
      var ageD = Math.max(0, Math.floor((nowMs - new Date(x.created_at).getTime()) / 86400000));
      var sla = L.ticketSla(x);
      var st = ['response', 'onsite', 'resolution'].map(function (k) { return sla[k].state; });
      var bCls = st.indexOf('breached') !== -1 ? 'sla-breached' :
                 st.indexOf('warning') !== -1 ? 'sla-warning' : 'sla-ok';
      var bLbl = bCls === 'sla-breached' ? t('detail.sla.breached') :
                 bCls === 'sla-warning' ? t('detail.sla.warning') : t('detail.sla.ok');
      return '<div class="attn-row" data-nav="#/ticket/' + x.id + '">' +
        '<span class="tnum">' + esc(L.formatTicketNo(x.ticket_no)) + '</span>' +
        '<span class="ttl">' + esc(x.title) + '</span>' +
        '<span class="meta">' + esc(siteShort(x.site_id)) + ' · ' + ageD + 'd</span>' +
        badge(bCls, bLbl) +
        (!x.assigned_to ? ' <span class="pill-unassigned">' + esc(t('list.unassigned')) + '</span>' : '') +
      '</div>';
    }).join('');

    var html =
      '<div class="page-head"><div><h1>' + esc(t('dash.title')) + '</h1>' +
      '<p class="page-sub">' + esc(t('dash.welcome')) + ', ' + esc(state.profile.display_name || '') +
      ' — ' + esc(t('dash.hint.' + state.profile.role)) + '</p></div></div>' +
      '<div class="grid-4">' +
        counter(t('dash.openTickets'), open.length, false, '#/tickets') +
        counter(t('dash.contractOpen'), contractOpen.length, contractOpen.length > 0, '#/tickets') +
        counter(t('dash.unassigned'), unassigned.length, unassigned.length > 0, '#/tickets') +
        /* v3 F8: breached-SLA counter navigates to the SLA alerts view (staff only). */
        counter(t('dash.breachedSla'), breached.length, breached.length > 0,
                ['admin', 'dispatcher', 'pm'].indexOf(state.profile.role) !== -1 ? '#/sla-alerts' : '#/tickets') +
      '</div>' +
      '<div class="grid-4" style="margin-top:16px">' +
        counter(t('dash.myTickets'), mine.length, false, '#/tickets') +
        counter(t('dash.avgResponse'), avgRespHrs == null ? '—' : avgRespHrs.toFixed(1) + 'h', false, '#/tickets') +
        counter(t('dash.closed30'), closed30.length, false, '#/tickets') +
        gaugeCard(t('dash.slaCompliance'), slaPct, slaPct != null && slaPct < 90, '#/tickets') +
      '</div>' +
      '<div class="card" style="margin-top:16px"><h2 class="section-title">' +
        esc(t('dash.needsAttention')) + '</h2>' +
        (attnRows || '<div class="empty">' + esc(t('dash.attention.none')) + '</div>') +
      '</div>' +
      '<div class="grid-2" style="margin-top:16px">' +
        donutCard(t('dash.byStatus'), byStatus) +
        donutCard(t('dash.byPriority'), byPri) +
      '</div>' +
      '<div class="card kpi-rail" style="margin-top:16px"><h2>' + esc(t('dash.contractKpi')) + '</h2>' +
        '<div class="grid-4">' +
          counter(t('dash.contractSites'), activeContracts.length, false, '#/sites') +
          counter(t('dash.contractOpenTickets'), contractOpen.length, contractOpen.length > 0, '#/tickets') +
          counter(t('dash.contractBreached'), contractBreached.length, contractBreached.length > 0, '#/tickets') +
          '<div></div>' +
        '</div>' +
        (activeContracts.length
          ? '<h2 style="margin-top:18px">' + esc(t('dash.contractTable')) + '</h2>' +
            '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
            '<th>' + esc(t('list.columns.site')) + '</th>' +
            '<th>' + esc(t('dash.col.contractAvail')) + '</th>' +
            '<th>' + esc(t('dash.col.actualAvail')) + '</th>' +
            '<th>' + esc(t('dash.col.coverage')) + '</th>' +
            '<th>' + esc(t('dash.col.hours')) + '</th>' +
            '<th>' + esc(t('dash.col.atRisk')) + '</th>' +
            '</tr></thead><tbody>' + contractRows + '</tbody></table></div>'
          : '<div class="empty">' + esc(t('dash.noContracts')) + '</div>') +
      '</div>' +
      '<div class="card" style="margin-top:16px"><h2>' + esc(t('dash.workload')) + '</h2>' +
        (wl.length
          ? '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
            '<th>' + esc(t('plan.engineer')) + '</th>' +
            '<th>' + esc(t('dash.col.open')) + '</th>' +
            '<th>' + esc(t('dash.col.contract')) + '</th>' +
            '<th>' + esc(t('dash.col.breached')) + '</th>' +
            '</tr></thead><tbody>' + wlRows + '</tbody></table></div>'
          : '<div class="empty">—</div>') +
      '</div>' +
      '<div class="card" style="margin-top:16px"><h2>' + esc(t('dash.recent')) + '</h2>' +
        ticketTable(tickets.slice(0, 8)) +
      '</div>';
    view.innerHTML = html;
    bindTableNav(view);
  }

  /* v3 F8: SLA alerts — breached clocks + clocks with <2h left, sorted by
     urgency. Dashboard-linked only (no nav item); dispatcher/admin/pm. */
  async function viewSlaAlerts(view) {
    var tickets = await fetchTickets({});
    await runEscalationJob(tickets);
    await resolveNames(collectIds(tickets));
    var breached = [], warning = [];
    tickets.forEach(function (x) {
      var lvl = L.slaAlertLevel(x);
      if (lvl === 'breached') breached.push(x);
      else if (lvl === 'warning') warning.push(x);
    });
    /* urgency: smallest remaining time first (most overdue → negative). */
    function worstRemaining(x) {
      var sla = L.ticketSla(x);
      var m = null;
      ['response', 'onsite', 'resolution'].forEach(function (k) {
        if (sla[k].remainingMs != null) m = m == null ? sla[k].remainingMs : Math.min(m, sla[k].remainingMs);
      });
      return m == null ? Infinity : m;
    }
    breached.sort(function (a, b) { return worstRemaining(a) - worstRemaining(b); });
    warning.sort(function (a, b) { return worstRemaining(a) - worstRemaining(b); });

    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('sla.title')) + '</h1></div>' +
      '<div class="card"><h2 class="section-title">' + esc(t('sla.breached')) + ' (' + breached.length + ')</h2>' +
        (breached.length ? ticketTable(breached)
                         : '<div class="empty">' + esc(t('sla.none')) + '</div>') + '</div>' +
      '<div class="card" style="margin-top:16px"><h2 class="section-title">' +
        esc(t('sla.warning2h')) + ' (' + warning.length + ')</h2>' +
        (warning.length ? ticketTable(warning)
                        : '<div class="empty">' + esc(t('sla.none')) + '</div>') + '</div>';
    bindTableNav(view);
  }

  function collectIds(tickets) {
    var ids = [];
    tickets.forEach(function (x) {
      [x.created_by, x.assigned_to].forEach(function (id) {
        if (id && ids.indexOf(id) === -1) ids.push(id);
      });
    });
    return ids;
  }

  /* ---------------------------- ticket table ---------------------------- */
  function badge(cls, text) { return '<span class="badge ' + cls + '">' + esc(text) + '</span>'; }
  function statusBadge(s) { return badge('status-' + s, t('status.' + s)); }
  function priBadge(p) { return badge('pri-' + p, t('priority.' + p)); }

  /* v3 F3: tags — comma-separated input -> string array; pills renderer. */
  function parseTags(s) {
    var seen = {};
    return String(s || '').split(',').map(function (x) { return x.trim(); })
      .filter(function (x) { return x && !seen[x] && (seen[x] = true); }).slice(0, 20);
  }
  function tagPills(tags) {
    tags = tags || [];
    if (!tags.length) return '';
    return '<span class="tag-pills">' + tags.map(function (x) {
      return '<span class="tag-pill">' + esc(x) + '</span>';
    }).join('') + '</span>';
  }

  /* v3 D7: single row HTML — "Load more" appends rows built by this. */
  function ticketRowHtml(x) {
      var sla = L.ticketSla(x);
      var states = ['response', 'onsite', 'resolution'].map(function (k) { return sla[k].state; });
      /* v3 U4: worst-clock badge — breached > warning > ok */
      var bCls = states.indexOf('breached') !== -1 ? 'sla-breached' :
                 states.indexOf('warning') !== -1 ? 'sla-warning' : 'sla-ok';
      var bLbl = bCls === 'sla-breached' ? t('detail.sla.breached') :
                 bCls === 'sla-warning' ? t('detail.sla.warning') : t('detail.sla.ok');
      /* v3 U3: unassigned open rows glow orange so stalled tickets can't be missed */
      var isOpen = L.TERMINAL_STATUSES.indexOf(x.status) === -1;
      var unassignedOpen = isOpen && !x.assigned_to;
      return '<tr class="clickable' + (x.is_ltsa ? ' is-ltsa' : '') +
        (unassignedOpen ? ' unassigned-open' : '') + '" data-id="' + x.id + '">' +
        '<td class="tnum">' + esc(L.formatTicketNo(x.ticket_no)) + '</td>' +
        '<td>' + esc(x.title) + '</td>' +
        '<td>' + statusBadge(x.status) + '</td>' +
        '<td>' + priBadge(x.priority) + '</td>' +
        '<td class="muted">' + esc(siteShort(x.site_id)) + '</td>' +
        '<td>' + (x.assigned_to ? esc(displayName(x.assigned_to))
                                : '<span class="pill-unassigned">' + esc(t('list.unassigned')) + '</span>') + '</td>' +
        '<td>' + badge(bCls, bLbl) +
             (x.escalated ? ' ' + badge('escalated', t('detail.escalated')) : '') + '</td>' +
        '<td class="muted">' + esc(fmtDate(x.updated_at)) + '</td>' +
      '</tr>';
  }

  function ticketTable(tickets) {
    if (!tickets.length) return '<div class="empty">' + esc(t('list.noResults')) + '</div>';
    var rows = tickets.map(ticketRowHtml).join('');
      return '<tr class="clickable' + (x.is_ltsa ? ' is-ltsa' : '') +
        (unassignedOpen ? ' unassigned-open' : '') + '" data-id="' + x.id + '">' +
        '<td class="tnum">' + esc(L.formatTicketNo(x.ticket_no)) + '</td>' +
        '<td>' + esc(x.title) + '</td>' +
        '<td>' + statusBadge(x.status) + '</td>' +
        '<td>' + priBadge(x.priority) + '</td>' +
        '<td class="muted">' + esc(siteShort(x.site_id)) + '</td>' +
        '<td>' + (x.assigned_to ? esc(displayName(x.assigned_to))
                                : '<span class="pill-unassigned">' + esc(t('list.unassigned')) + '</span>') + '</td>' +
        '<td>' + badge(bCls, bLbl) +
             (x.escalated ? ' ' + badge('escalated', t('detail.escalated')) : '') + '</td>' +
        '<td class="muted">' + esc(fmtDate(x.updated_at)) + '</td>' +
      '</tr>';
  }

  function ticketTable(tickets) {
    if (!tickets.length) return '<div class="empty">' + esc(t('list.noResults')) + '</div>';
    var rows = tickets.map(ticketRowHtml).join('');
    return '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
      '<th>' + esc(t('list.columns.ticket')) + '</th>' +
      '<th>' + esc(t('list.columns.title')) + '</th>' +
      '<th>' + esc(t('common.status')) + '</th>' +
      '<th>' + esc(t('common.priority')) + '</th>' +
      '<th>' + esc(t('list.columns.site')) + '</th>' +
      '<th>' + esc(t('list.columns.assignee')) + '</th>' +
      '<th>SLA</th>' +
      '<th>' + esc(t('common.updatedAt')) + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function siteShort(siteId) {
    var s = state.sites.find(function (x) { return x.id === siteId; });
    return s ? s.code : '—';
  }

  function bindTableNav(view) {
    view.querySelectorAll('[data-nav]').forEach(function (el) {
      el.onclick = function () { nav(el.getAttribute('data-nav')); };
    });
    view.querySelectorAll('tr.clickable[data-id]').forEach(function (el) {
      el.onclick = function () { nav('#/ticket/' + el.getAttribute('data-id')); };
    });
  }

  /* ----------------------------- ticket list ---------------------------- */
  /* v3 D7: page size for the ticket list ("Load more" pagination). */
  var LIST_PAGE_SIZE = 50;

  /* v3 U5: statuses shown as tracker tabs (excludes the unused 'pending'). */
  var TRACKER_STATUSES = ['open', 'in_progress', 'pending_customer', 'resolved', 'closed'];

  /* v3 U12: saved views live in localStorage — UI PREFERENCE ONLY.
     Ticket/user data is NEVER written to localStorage (old-demo bug). */
  var VIEWS_KEY = 'bess_views';
  function blankFilters() {
    return { status: '', priority: '', source: '', site: '', assignee: '', q: '', tag: '', customer: '',
             unassignedOnly: false, contractOnly: false };
  }
  function loadSavedViews() {
    try {
      var raw = localStorage.getItem(VIEWS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function storeSavedViews(arr) {
    try { localStorage.setItem(VIEWS_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  async function viewTicketList(view) {
    var f = state.listFilters;
    state.listPage = 0; // v3 D7: pagination cursor resets on every filter change
    var tickets = await fetchTickets(f, { limit: LIST_PAGE_SIZE });
    await runEscalationJob(tickets);
    await resolveNames(collectIds(tickets));

    /* v3 U8/D7: scope/filter transparency — never silently hide records.
       filteredCount = matches for the CURRENT filters (all pages);
       totalVisible  = unfiltered visible count (RLS already applied). */
    var filteredCount = await countTickets(f);
    var totalVisible = filteredCount;
    try {
      var cntRes = await baseTicketQuery('id', { count: 'exact', head: true });
      if (cntRes && cntRes.count != null) totalVisible = cntRes.count;
    } catch (e) {}

    /* v3 U5: tracker-tab counts respect every filter EXCEPT the tab (status) itself. */
    var fNoStatus = Object.assign({}, f, { status: '' });
    var tabCounts = {};
    tabCounts[''] = await countTickets(fNoStatus);
    for (var ti = 0; ti < TRACKER_STATUSES.length; ti++) {
      var tst = TRACKER_STATUSES[ti];
      tabCounts[tst] = await countTickets(Object.assign({}, fNoStatus, { status: tst }));
    }

    var role = state.profile.role;
    var filtersActive = !!(f.status || f.priority || f.source || f.site || f.q || f.tag || f.customer ||
                           f.unassignedOnly || f.contractOnly); // v3 U6 quick filters count too
    var scopeLimited = role === 'engineer' || role === 'customer' ||
      (role === 'pm' && (state.profile.project_scope || []).length > 0);
    /* v3 D7: "Showing X of Y" = loaded rows vs. filter matches (all pages). */
    function scopeLineInner(loaded) {
      return esc(t('list.showing').replace('{x}', String(loaded)).replace('{y}', String(filteredCount))) +
        (scopeLimited ? ' · ' + esc(t('list.scopeLimited')) : '') +
        (filtersActive && totalVisible > filteredCount
          ? ' · ' + esc(t('list.filtersHide').replace('{n}', String(totalVisible - filteredCount))) : '');
    }

    function opt(val, label, sel) {
      return '<option value="' + esc(val) + '"' + (sel === val ? ' selected' : '') + '>' + esc(label) + '</option>';
    }
    function selectOpts(values, labelKey, sel) {
      return '<option value="">' + esc(t('common.all')) + '</option>' +
        values.map(function (v) { return opt(v, t(labelKey + v), sel); }).join('');
    }
    var siteOpts = '<option value="">' + esc(t('common.all')) + '</option>' +
      state.sites.map(function (s) { return opt(s.id, s.code + ' — ' + s.name, f.site); }).join('');

    /* v3 U5: status tracker tabs with counts (above the filter card). */
    var tabBtns = [{ st: '', label: t('list.tab.all') }].concat(TRACKER_STATUSES.map(function (st) {
      return { st: st, label: t('status.' + st) };
    })).map(function (tb) {
      return '<button data-tab="' + tb.st + '"' + (f.status === tb.st ? ' class="active"' : '') + '>' +
        esc(tb.label) + ' <span class="tab-count">' + (tabCounts[tb.st] || 0) + '</span></button>';
    }).join('');

    /* v3 U12: saved views (localStorage, UI preference only). */
    var savedViews = loadSavedViews();
    var viewsSel = '<select id="view-sel" style="max-width:220px"><option value="">' + esc(t('list.views')) + '</option>' +
      savedViews.map(function (v, i) {
        return '<option value="' + i + '">' + esc(v.name) + '</option>';
      }).join('') + '</select>';

    /* v3 U11: CSV export — dispatcher/admin/pm only. */
    var canExport = ['admin', 'dispatcher', 'pm'].indexOf(role) !== -1;

    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('list.title')) + '</h1>' +
      (L.can('ticket.create', role)
        ? '<button class="btn btn-primary" id="new-ticket-btn">+ ' + esc(t('nav.newTicket')) + '</button>' : '') +
      '</div>' +
      '<div class="tabs" id="status-tabs">' + tabBtns + '</div>' +
      '<div class="card"><div class="filters">' +
        '<div class="f search"><label>' + esc(t('common.search')) + '</label>' +
          '<input type="text" id="f-q" placeholder="' + esc(t('list.searchPh')) + '" value="' + esc(f.q) + '"></div>' +
        '<div class="f"><label>' + esc(t('list.filter.status')) + '</label>' +
          '<select id="f-status">' + selectOpts(L.STATUSES, 'status.', f.status) + '</select></div>' +
        '<div class="f"><label>' + esc(t('list.filter.priority')) + '</label>' +
          '<select id="f-priority">' + selectOpts(L.PRIORITIES, 'priority.', f.priority) + '</select></div>' +
        '<div class="f"><label>' + esc(t('list.filter.source')) + '</label>' +
          '<select id="f-source">' + selectOpts(L.SOURCES, 'source.', f.source) + '</select></div>' +
        '<div class="f"><label>' + esc(t('list.filter.site')) + '</label>' +
          '<select id="f-site">' + siteOpts + '</select></div>' +
        (state.v3
          ? '<div class="f"><label>' + esc(t('list.filter.tag')) + '</label>' +
            '<input type="text" id="f-tag" placeholder="' + esc(t('list.filter.tagPh')) +
            '" value="' + esc(f.tag || '') + '"></div>'
          : '') +
        (state.v3 && state.customers.length
          ? '<div class="f"><label>' + esc(t('list.filter.customer')) + '</label>' +
            '<select id="f-customer"><option value="">' + esc(t('common.all')) + '</option>' +
            state.customers.map(function (c) {
              return '<option value="' + c.id + '"' + (f.customer === c.id ? ' selected' : '') + '>' +
                esc(c.company_name) + '</option>';
            }).join('') + '</select></div>'
          : '') +
        /* v3 U6: quick-filter toggle chips */
        '<div class="f"><label>&nbsp;</label><div class="qf-chips">' +
          '<button class="chip' + (f.unassignedOnly ? ' active' : '') + '" id="qf-unassigned">' +
            esc(t('list.quickFilter.unassignedOnly')) + '</button>' +
          '<button class="chip' + (f.contractOnly ? ' active' : '') + '" id="qf-contract">' +
            esc(t('list.quickFilter.contractOnly')) + '</button>' +
        '</div></div>' +
      '</div>' +
      '<div style="margin-bottom:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<button class="btn btn-sm" id="f-clear">' + esc(t('common.clear')) + '</button>' +
        (canExport ? '<button class="btn btn-sm" id="export-csv">' + esc(t('list.exportCsv')) + '</button>' : '') +
        viewsSel +
        '<button class="btn btn-sm" id="view-save">' + esc(t('list.saveView')) + '</button>' +
        '<button class="btn btn-sm btn-danger" id="view-del">' + esc(t('list.viewDelete')) + '</button>' +
      '</div>' +
      '<div class="list-scope-line" id="list-scope-line">' + scopeLineInner(tickets.length) + '</div>' +
      '<div id="list-result">' + ticketTable(tickets) + '</div>' +
      /* v3 D7: shown when the fetched page is full (more may exist) */
      (tickets.length === LIST_PAGE_SIZE
        ? '<div style="margin-top:12px;text-align:center"><button class="btn" id="load-more">' +
          esc(t('list.loadMore')) + '</button></div>'
        : '') +
      '</div>';

    if (L.can('ticket.create', role)) {
      document.getElementById('new-ticket-btn').onclick = function () { nav('#/new'); };
    }
    var deb = null;
    function refetch() {
      f.status = document.getElementById('f-status').value;
      f.priority = document.getElementById('f-priority').value;
      f.source = document.getElementById('f-source').value;
      f.site = document.getElementById('f-site').value;
      f.q = document.getElementById('f-q').value;
      var tagEl = document.getElementById('f-tag');
      if (tagEl) f.tag = tagEl.value.trim();
      var custEl = document.getElementById('f-customer');
      if (custEl) f.customer = custEl.value;
      render();
    }
    /* v3 U5: tab click sets the status filter and re-renders. */
    view.querySelectorAll('#status-tabs button').forEach(function (b) {
      b.onclick = function () { f.status = b.getAttribute('data-tab'); render(); };
    });
    /* v3 U6: quick-filter chips toggle and re-render. */
    document.getElementById('qf-unassigned').onclick = function () {
      f.unassignedOnly = !f.unassignedOnly; render();
    };
    document.getElementById('qf-contract').onclick = function () {
      f.contractOnly = !f.contractOnly; render();
    };
    ['f-status', 'f-priority', 'f-source', 'f-site'].forEach(function (id) {
      document.getElementById(id).onchange = refetch;
    });
    var custSel = document.getElementById('f-customer');
    if (custSel) custSel.onchange = refetch;
    document.getElementById('f-q').oninput = function () {
      clearTimeout(deb); deb = setTimeout(refetch, 400);
    };
    var tagInput = document.getElementById('f-tag');
    if (tagInput) tagInput.oninput = function () {
      clearTimeout(deb); deb = setTimeout(refetch, 400);
    };
    document.getElementById('f-clear').onclick = function () {
      state.listFilters = blankFilters();
      render();
    };
    /* v3 U12: saved views. */
    document.getElementById('view-save').onclick = function () {
      var name = window.prompt(t('list.viewName'), '');
      if (name == null) return;
      name = name.trim();
      if (!name) return;
      var arr = loadSavedViews();
      var dup = arr.some(function (v) { return v.name === name; });
      if (dup) { toast(t('list.viewExists'), 'error'); return; }
      arr.push({ name: name, filters: {
        status: f.status, priority: f.priority, source: f.source, site: f.site,
        tag: f.tag || '', customer: f.customer || '',
        unassignedOnly: !!f.unassignedOnly, contractOnly: !!f.contractOnly, q: f.q || ''
      } });
      storeSavedViews(arr);
      toast(t('list.viewSaved'), 'ok');
      render();
    };
    document.getElementById('view-sel').onchange = function () {
      var idx = this.value;
      if (idx === '') return;
      var v = loadSavedViews()[Number(idx)];
      if (!v) return;
      var nf = blankFilters();
      Object.keys(nf).forEach(function (k) {
        if (v.filters && v.filters[k] != null) nf[k] = v.filters[k];
      });
      state.listFilters = nf;
      render();
    };
    document.getElementById('view-del').onclick = function () {
      var sel = document.getElementById('view-sel');
      if (sel.value === '') return;
      var arr = loadSavedViews();
      arr.splice(Number(sel.value), 1);
      storeSavedViews(arr);
      toast(t('list.viewDeleted'), 'ok');
      render();
    };
    /* v3 U11: CSV export (all pages of the current filters, capped). */
    var expBtn = document.getElementById('export-csv');
    if (expBtn) expBtn.onclick = function () { exportTicketsCsv(f, expBtn); };
    /* v3 D7: load more appends rows without a full re-render. */
    var loadBtn = document.getElementById('load-more');
    if (loadBtn) loadBtn.onclick = async function () {
      var btn = this; btn.disabled = true;
      state.listPage++;
      var more = await fetchTickets(f, { limit: LIST_PAGE_SIZE, offset: state.listPage * LIST_PAGE_SIZE });
      await runEscalationJob(more);
      await resolveNames(collectIds(more));
      var tbody = view.querySelector('#list-result tbody');
      if (tbody && more.length) {
        tbody.insertAdjacentHTML('beforeend', more.map(ticketRowHtml).join(''));
        bindTableNav(view);
      }
      var scopeEl = document.getElementById('list-scope-line');
      if (scopeEl) {
        var loadedNow = (view.querySelectorAll('#list-result tbody tr') || []).length;
        scopeEl.innerHTML = scopeLineInner(loadedNow);
      }
      if (more.length < LIST_PAGE_SIZE) { if (btn.parentNode) btn.parentNode.remove(); }
      else btn.disabled = false;
    };
    bindTableNav(view);
  }

  /* v3 U11: export the CURRENTLY filtered tickets (all pages, cap 2000).
     Semicolon delimiter + UTF-8 BOM so Excel opens it directly. */
  async function exportTicketsCsv(f, btn) {
    btn.disabled = true;
    try {
      var rows = await fetchTickets(f, { limit: 2000 });
      await resolveNames(collectIds(rows));
      function cell(v) {
        var s = v == null ? '' : String(v);
        if (/[;"\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
        return s;
      }
      var lines = [[ 'ticket_no', 'title', 'status', 'priority', 'site', 'assignee',
                     'created_at', 'updated_at', 'sla_response_at', 'sla_onsite_at', 'sla_resolve_at'
                   ].map(cell).join(';')];
      rows.forEach(function (x) {
        lines.push([
          L.formatTicketNo(x.ticket_no), x.title, x.status, x.priority,
          siteShort(x.site_id), x.assigned_to ? displayName(x.assigned_to) : '',
          x.created_at, x.updated_at, x.sla_response_at, x.sla_onsite_at, x.sla_resolve_at
        ].map(cell).join(';'));
      });
      function p2(n) { return String(n).padStart(2, '0'); }
      var d = new Date();
      var fname = 'tickets-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) +
                  '-' + p2(d.getHours()) + p2(d.getMinutes()) + '.csv';
      var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast(t('list.exported', { n: rows.length }), 'ok');
    } catch (e) { apiError(e); }
    btn.disabled = false;
  }

  /* ---------------------------- ticket detail --------------------------- */
  async function viewTicketDetail(view, id) {
    var tr = await sb.from('tickets').select('*').eq('id', id).single();
    if (tr.error || !tr.data) {
      view.innerHTML = '<div class="inline-err">' +
        esc(tr.error ? tr.error.message : t('common.error')) + '</div>' +
        '<button class="btn" id="back-btn">' + esc(t('detail.backToList')) + '</button>';
      document.getElementById('back-btn').onclick = function () { nav('#/tickets'); };
      return;
    }
    var ticket = tr.data;
    // Client-side visibility check mirrors the contract (RLS already filtered).
    if (!L.canViewTicket(ticket, state.profile)) {
      view.innerHTML = '<div class="inline-err">' + esc(t('common.noPermissionView')) + '</div>';
      return;
    }
    await runEscalationJob([ticket]);
    if (ticket.escalated) {
      var re = await sb.from('tickets').select('escalated').eq('id', id).single();
      if (!re.error && re.data) ticket.escalated = re.data.escalated;
    }

    var cr = await sb.from('ticket_comments').select('*').eq('ticket_id', id).order('created_at');
    var comments = cr.error ? [] : (cr.data || []);
    if (cr.error) apiError(cr.error);
    var ar = await sb.from('ticket_attachments').select('*').eq('ticket_id', id).order('created_at');
    var photos = ar.error ? [] : (ar.data || []);
    if (ar.error) apiError(ar.error);
    await resolveNames(collectIds([ticket]).concat(
      comments.map(function (c) { return c.author_id; }),
      photos.map(function (p) { return p.uploaded_by; })
    ));

    var p = state.profile, role = p.role;
    var ctx = L.transitionCtx(ticket, p);
    var transitions = L.allowedTransitions(ticket.status, role, ctx);
    var canAssign = L.can('ticket.assign', role);
    var canFieldReport = L.can('ticket.fieldreport', role) && (role !== 'engineer' || ctx.isAssignee);
    var canEditCore = L.can('ticket.edit.core', role) ||
                      (role === 'customer' && ctx.isCreator && ticket.status === 'open');
    var canUpload = L.canUploadPhoto(ticket, p);
    var isCustomer = role === 'customer';

    /* ----- SLA badges ----- */
    var clocks = L.ticketSla(ticket);
    function clockCard(key) {
      var c = clocks[key];
      var stopped = key === 'response' ? ticket.responded_at :
                    key === 'onsite' ? ticket.visited_at : ticket.resolved_at;
      var cls = c.state === 'breached' ? 'sla-breached' :
                c.state === 'warning' ? 'sla-warning' : 'sla-ok';
      var label = c.state === 'breached' ? t('detail.sla.breached') :
                  c.state === 'warning' ? t('detail.sla.warning') : t('detail.sla.ok');
      var sub = stopped ? t('detail.sla.stopped') + ' · ' + fmtDate(stopped) : slaCountdown(c);
      return '<div class="sla-clock"><div class="clock-name">' + esc(t('detail.sla.' + key)) + '</div>' +
        '<div class="clock-line">' + badge(cls, label) +
        '<span class="clock-time">' + esc(sub) + '</span></div></div>';
    }

    /* ----- header ----- */
    var html =
      '<button class="btn btn-sm" id="back-btn" style="margin-bottom:12px">← ' + esc(t('detail.backToList')) + '</button>' +
      /* v4: print icon is inline SVG (no emoji). */
      /* v5: customers can print their own ticket's service report too —
         the report body filters to public comments only and skips the
         parts section for customers (no part.view). */
      ' <button class="btn btn-sm" id="print-report-btn" style="margin-bottom:12px">' +
        '<span class="note-ic">' + icon('printer', 12) + '</span> ' +
        esc(t('detail.printReport')) + '</button>' +
      '<div class="detail-head"><span class="tnum">' + esc(L.formatTicketNo(ticket.ticket_no)) + '</span>' +
        statusBadge(ticket.status) + priBadge(ticket.priority) +
        badge('status-open', t('source.' + ticket.source)) +
        (ticket.is_ltsa ? badge('escalated', t('detail.contractTicket')) : '') +
        (ticket.escalated ? badge('escalated', t('detail.escalated')) : '') +
        (state.v3 ? tagPills(ticket.tags) : '') + '</div>' +
      '<h1 class="detail-title">' + esc(ticket.title) + '</h1>' +
      '<div class="t-detail">' +
      '<div>' + // left column: work area
        '<div class="card"><h2>' + esc(t('detail.sla')) + '</h2>' +
          '<div class="sla-clocks">' + clockCard('response') + clockCard('onsite') + clockCard('resolution') + '</div>' +
        '</div>' +
        '<div class="card"><h2>' + esc(t('detail.requiredFields')) + '</h2>' +
          '<dl class="kv">' +
            '<dt>' + esc(t('detail.serialNumber')) + '</dt><dd>' + esc(ticket.serial_number || '—') + '</dd>' +
            '<dt>' + esc(t('detail.firmwareVersion')) + '</dt><dd>' + esc(ticket.firmware_version || '—') + '</dd>' +
            '<dt>' + esc(t('detail.errorCode')) + '</dt><dd>' + esc(ticket.error_code || '—') + '</dd>' +
            '<dt>' + esc(t('detail.actionsTaken')) + '</dt><dd>' + esc(ticket.actions_taken || '—') + '</dd>' +
          '</dl></div>' +
        '<div class="card"><h2>' + esc(t('detail.description')) + '</h2>' +
          '<div style="white-space:pre-wrap">' + esc(ticket.description || '—') + '</div>' +
          (canEditCore ? '<div style="margin-top:10px"><button class="btn btn-sm" id="edit-core-btn">' +
            esc(t('detail.editTicket')) + '</button></div>' : '') +
        '</div>' +
        '<div class="card"><h2>' + esc(t('detail.fieldReport')) + '</h2>' +
          '<dl class="kv">' +
            '<dt>' + esc(t('detail.visitedAt')) + '</dt><dd>' + esc(fmtDate(ticket.visited_at)) + '</dd>' +
            '<dt>' + esc(t('detail.problemCategory')) + '</dt><dd>' + esc(ticket.problem_category || '—') + '</dd>' +
            '<dt>' + esc(t('detail.resolution')) + '</dt><dd style="white-space:pre-wrap">' + esc(ticket.resolution || '—') + '</dd>' +
          '</dl>' +
          (canFieldReport ? '<div style="margin-top:10px"><button class="btn btn-sm" id="fieldreport-btn">' +
            esc(t('common.edit')) + '</button></div>' : '') +
        '</div>' +
        '<div class="card"><h2>' + esc(t('detail.photos')) + '</h2>' +
          '<div id="photo-gallery"></div>' +
          (canUpload
            ? '<div style="margin-top:10px"><input type="file" id="photo-input" accept="image/*,video/*" multiple>' +
              '<div class="hint" style="font-size:12px;color:var(--text-muted);margin:6px 0">' +
              esc(t('detail.photos.hint')) + '</div>' +
              '<button class="btn btn-sm btn-primary" id="photo-upload-btn">' + esc(t('common.upload')) + '</button></div>'
            : '') +
        '</div>' +
        '<div id="parts-block"></div>' +
        (state.v3 && !isCustomer
          ? '<div class="card"><h2 class="section-title">' + esc(t('detail.fieldActivity')) + '</h2>' +
            '<div class="fact-grid">' +
              '<div class="fact"><span class="fact-label">' + esc(t('detail.onsiteFrom')) + '</span>' +
                '<span class="fact-value">' + esc(ticket.onsite_from ? fmtDate(ticket.onsite_from) : '—') + '</span></div>' +
              '<div class="fact"><span class="fact-label">' + esc(t('detail.onsiteTo')) + '</span>' +
                '<span class="fact-value">' + esc(ticket.onsite_to ? fmtDate(ticket.onsite_to) : '—') + '</span></div>' +
            '</div>' +
            '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
              '<button class="btn btn-sm" id="onsite-edit-btn">' + esc(t('detail.setOnsiteDates')) + '</button>' +
              (canAssign ? '<button class="btn btn-sm btn-primary" id="book-resource-btn">' +
                esc(t('detail.bookResource')) + '</button>' : '') +
            '</div></div>'
          : '') +
        '<div class="card"><h2>' + esc(t('detail.comments')) + '</h2>' +
          '<div class="tabs" id="comment-tabs">' +
            '<button data-tab="public" class="active">' + esc(t('detail.comments.public')) + '</button>' +
            (isCustomer ? '' : '<button data-tab="internal">' + esc(t('detail.comments.internal')) + '</button>') +
          '</div>' +
          (isCustomer ? '' : '<div class="hint" style="font-size:12px;color:var(--text-muted);margin-bottom:8px">' +
            esc(t('detail.comments.internalOnly')) + '</div>') +
          '<div id="comment-list"></div>' +
          '<div class="field" style="margin-top:10px"><textarea id="comment-input" placeholder="' +
            esc(t('detail.comments.addPh')) + '"></textarea></div>' +
          '<div class="form-actions" style="margin-top:0"><button class="btn btn-primary btn-sm" id="comment-post">' +
            esc(t('detail.comments.post')) + '</button></div>' +
        '</div>' +
      '</div>' +
      '<div>' + // right column: facts rail
        '<div class="card"><h2>' + esc(t('common.details')) + '</h2>' +
          '<div class="sf-row"><span class="k">' + esc(t('detail.source')) + '</span>' +
            '<span class="v">' + esc(t('source.' + ticket.source)) + '</span></div>' +
          '<div class="sf-row"><span class="k">' + esc(t('detail.site')) + '</span>' +
            '<span class="v">' + esc(siteLabel(ticket.site_id)) + '</span></div>' +
          '<div class="sf-row"><span class="k">' + esc(t('detail.createdBy')) + '</span>' +
            '<span class="v">' + esc(displayName(ticket.created_by)) + '</span></div>' +
          '<div class="sf-row"><span class="k">' + esc(t('common.createdAt')) + '</span>' +
            '<span class="v">' + esc(fmtDate(ticket.created_at)) + '</span></div>' +
          '<div class="sf-row"><span class="k">' + esc(t('common.updatedAt')) + '</span>' +
            '<span class="v">' + esc(fmtDate(ticket.updated_at)) + '</span></div>' +
          (ticket.escalated_at ? '<div class="sf-row"><span class="k">' + esc(t('detail.escalated')) + '</span>' +
            '<span class="v">' + esc(fmtDate(ticket.escalated_at)) + '</span></div>' : '') +
        '</div>' +
        (canAssign
          ? '<div class="card"><h2>' + esc(t('detail.assignment')) + '</h2>' +
            '<div id="assign-box"><div class="empty">' + esc(t('common.loading')) + '</div></div></div>'
          : '<div class="card"><h2>' + esc(t('detail.assignment')) + '</h2>' +
            '<div class="sf-row"><span class="k">' + esc(t('detail.assignee')) + '</span>' +
              '<span class="v">' + esc(displayName(ticket.assigned_to)) + '</span></div>' +
            '<div class="sf-row"><span class="k">' + esc(t('detail.plannedCheckAt')) + '</span>' +
              '<span class="v">' + esc(fmtDate(ticket.planned_check_at)) + '</span></div>' +
            '</div>') +
        (transitions.length
          ? '<div class="card"><h2>' + esc(t('detail.transitions')) + '</h2>' +
            '<div class="status-btns">' + transitions.map(function (to) {
              return '<button class="btn btn-sm" data-transition="' + to + '">' +
                esc(t('detail.transition.to')) + ' “' + esc(t('status.' + to)) + '”</button>';
            }).join('') + '</div></div>'
          : '') +
        '<div class="card"><h2>' + esc(t('detail.timeline')) + '</h2><ul class="timeline" id="timeline"></ul></div>' +
        (state.v3 && !isCustomer
          ? '<div class="card"><h2>' + esc(t('detail.relatedTickets')) + '</h2>' +
            '<div id="related-list"><div class="empty">' + esc(t('common.loading')) + '</div></div>' +
            '<div style="margin-top:10px"><button class="btn btn-sm" id="link-ticket-btn">+ ' +
              esc(t('detail.linkTicket')) + '</button></div></div>'
          : '') +
      '</div></div>';

    view.innerHTML = html;
    document.getElementById('back-btn').onclick = function () { nav('#/tickets'); };
    /* v3 F9: print report (staff only). */
    var prBtn = document.getElementById('print-report-btn');
    if (prBtn) prBtn.onclick = function () { printServiceReport(ticket, comments); };
    renderPartsBlock(ticket);

    /* ----- edit core fields ----- */
    if (canEditCore) {
      document.getElementById('edit-core-btn').onclick = function () {
        openTicketEditModal(ticket, function () { render(); });
      };
    }

    /* ----- field report modal ----- */
    if (canFieldReport) {
      document.getElementById('fieldreport-btn').onclick = function () {
        openFieldReportModal(ticket, function () { render(); });
      };
    }

    /* ----- assignment ----- */
    if (canAssign) renderAssignBox(ticket, function () { render(); });

    /* ----- v3 I2: field activity dates + resource booking ----- */
    var oseBtn = document.getElementById('onsite-edit-btn');
    if (oseBtn) oseBtn.onclick = function () {
      openOnsiteDatesModal(ticket, function () { render(); });
    };
    var brBtn = document.getElementById('book-resource-btn');
    if (brBtn) brBtn.onclick = function () {
      openBookResourceModal(ticket, function () { render(); });
    };

    /* ----- transitions ----- */
    view.querySelectorAll('[data-transition]').forEach(function (btn) {
      btn.onclick = async function () {
        var to = btn.getAttribute('data-transition');
        // Re-check permission at click time (never trust the rendered button).
        var allowed = L.allowedTransitions(ticket.status, role, L.transitionCtx(ticket, state.profile));
        if (allowed.indexOf(to) === -1) { toast(t('common.noPermission'), 'error'); return; }
        btn.disabled = true;
        try {
          var patch = { status: to };
          // v2: resolved_at is set when entering resolved OR pending_customer
          // (customer confirmation); cleared when rework starts.
          if (to === 'resolved' || to === 'pending_customer') {
            patch.resolved_at = new Date().toISOString();
          }
          if (to === 'in_progress' &&
              (ticket.status === 'resolved' || ticket.status === 'pending_customer')) {
            patch.resolved_at = null;
          }
          // v2: closed_at is set when entering closed.
          if (to === 'closed') patch.closed_at = new Date().toISOString();
          var r = await sb.from('tickets').update(patch).eq('id', ticket.id);
          if (r.error) throw r.error;
          /* v3 F7: reopening a closed ticket leaves an internal timeline note
             (internal ⇒ does not stop the response clock). */
          if (ticket.status === 'closed' && to === 'open') {
            try {
              await sb.from('ticket_comments').insert({
                ticket_id: ticket.id, author_id: state.profile.id,
                body: t('detail.reopened', { name: state.profile.display_name || state.profile.email }),
                is_internal: true
              });
            } catch (e) { apiError(e); }
          }
          toast(t('detail.transition.done'), 'ok');
          render();
        } catch (e) { apiError(e); btn.disabled = false; }
      };
    });

    /* ----- photos ----- */
    renderGallery(photos, ticket);
    if (canUpload) {
      document.getElementById('photo-upload-btn').onclick = async function () {
        var input = document.getElementById('photo-input');
        var files = Array.prototype.slice.call(input.files || []);
        if (!files.length) return;
        /* v5 P4: hard media limits against the already-attached files. */
        var existingVideos = photos.filter(function (p) {
          return (p.content_type || '').indexOf('video/') === 0;
        }).length;
        var limErrs = L.checkMediaLimits(files.map(function (f) {
          return { name: f.name, size: f.size, type: f.type };
        }), existingVideos, photos.length);
        if (limErrs.length) { toast(mediaLimitMsg(limErrs[0]), 'error'); return; }
        var btn = this; btn.disabled = true; btn.textContent = t('common.uploading');
        try {
          for (var i = 0; i < files.length; i++) {
            await uploadPhoto(ticket, await prepareUploadFile(files[i]));
          }
          toast(t('detail.photoUploaded'), 'ok');
          render();
        } catch (e) { apiError(e); btn.disabled = false; btn.textContent = t('common.upload'); }
      };
    }

    /* ----- comments ----- */
    var activeTab = 'public';
    function renderComments() {
      var list = comments.filter(function (c) {
        return activeTab === 'public' ? !c.is_internal : c.is_internal;
      });
      document.getElementById('comment-list').innerHTML = list.length
        ? list.map(function (c) {
            return '<div class="comment' + (c.is_internal ? ' internal' : '') + '">' +
              '<div class="meta"><b>' + esc(displayName(c.author_id)) + '</b>' +
              '<span>' + esc(fmtDate(c.created_at)) + '</span>' +
              (c.is_internal ? badge('status-pending', t('detail.comments.internal')) : '') + '</div>' +
              '<div class="body">' + esc(c.body) + '</div></div>';
          }).join('')
        : '<div class="empty">—</div>';
    }
    renderComments();
    document.querySelectorAll('#comment-tabs button').forEach(function (b) {
      b.onclick = function () {
        document.querySelectorAll('#comment-tabs button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        activeTab = b.getAttribute('data-tab');
        renderComments();
      };
    });
    document.getElementById('comment-post').onclick = async function () {
      var bodyEl = document.getElementById('comment-input');
      var body = bodyEl.value.trim();
      if (!body) return;
      var isInternal = activeTab === 'internal';
      if (isInternal && !L.canPostInternal(state.profile)) {
        toast(t('common.noPermission'), 'error'); return;
      }
      var btn = this; btn.disabled = true;
      try {
        var ins = await sb.from('ticket_comments').insert({
          ticket_id: ticket.id, author_id: state.profile.id,
          body: body, is_internal: isInternal
        });
        if (ins.error) throw ins.error;
        // First PUBLIC comment stops the response clock (contract §4).
        if (!isInternal && !ticket.responded_at) {
          var up = await sb.from('tickets')
            .update({ responded_at: new Date().toISOString() }).eq('id', ticket.id);
          if (!up.error) toast(t('detail.comments.firstPublic'), 'ok');
        }
        toast(t('detail.comments.posted'), 'ok');
        render();
      } catch (e) { apiError(e); btn.disabled = false; }
    };

    /* ----- timeline (synthesized — no audit table in v1 contract) ----- */
    renderTimeline(ticket, comments, photos);
    if (state.v3 && !isCustomer) loadRelatedTickets(ticket.id);
  }

  async function renderAssignBox(ticket, done) {
    var box = document.getElementById('assign-box');
    var res;
    try {
      /* v4: extra columns feed the assignment recommendation. */
      res = await sb.from('profiles').select('id,display_name,email,country,country_code,regions,skills,remote_capable')
        .eq('role', 'engineer').eq('is_active', true).order('display_name');
    } catch (e) { res = { error: e }; }
    if (res.error) {
      box.innerHTML = '<div class="inline-err">' + esc(res.error.message || t('common.error')) + '</div>';
      return;
    }
    var engs = res.data || [];
    engs.forEach(function (e) { state.nameCache[e.id] = e.display_name || e.email; });
    /* v4: REAL ranking — region match first, then name (L.rankEngineers). */
    var site = (state.sites || []).filter(function (x) { return x.id === ticket.site_id; })[0] || {};
    var siteRegion = L.regionOfCountry(site.country);
    var ranked = L.rankEngineers(engs, site.country);
    box.innerHTML =
      '<dl class="kv" style="margin-bottom:12px">' +
        '<dt>' + esc(t('detail.assignee')) + '</dt><dd>' + esc(displayName(ticket.assigned_to)) + '</dd>' +
        '<dt>' + esc(t('detail.plannedCheckAt')) + '</dt><dd>' + esc(fmtDate(ticket.planned_check_at)) + '</dd>' +
      '</dl>' +
      '<div class="field"><label>' + esc(t('assign.ranked')) +
        (siteRegion ? ' <span class="muted">· ' + esc(t('assign.siteRegion')) + ': ' +
          esc(regionName(siteRegion)) + '</span>' : '') + '</label>' +
        candidateListHtml(ranked, ticket.assigned_to, 'assign-eng') + '</div>' +
      '<div class="field"><label>' + esc(t('detail.plannedCheckAt')) + '</label>' +
        '<input type="datetime-local" id="assign-planned" value="' + fmtInputDateTime(ticket.planned_check_at) + '"></div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-primary btn-sm" id="assign-btn">' +
          esc(ticket.assigned_to ? t('detail.reassign') : t('detail.assign')) + '</button>' +
        (ticket.assigned_to ? '<button class="btn btn-sm" id="unassign-btn">' + esc(t('detail.unassign')) + '</button>' : '') +
      '</div>';
    document.getElementById('assign-btn').onclick = async function () {
      var engId = candidateValue('assign-eng');
      if (!engId) { toast(t('users.pickEngineer'), 'error'); return; }
      var planned = document.getElementById('assign-planned').value;
      var btn = this; btn.disabled = true;
      try {
        var patch = { assigned_to: engId, planned_check_at: planned ? new Date(planned).toISOString() : null };
        // Assigning from "open" also moves the ticket to "assigned" (contract §5).
        if (ticket.status === 'open') patch.status = 'assigned';
        var r = await sb.from('tickets').update(patch).eq('id', ticket.id);
        if (r.error) throw r.error;
        toast(t('common.saved'), 'ok');
        done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
    var un = document.getElementById('unassign-btn');
    if (un) un.onclick = async function () {
      if (!window.confirm(t('detail.unassignConfirm'))) return;
      try {
        // "assigned → open" is an allowed transition for dispatcher/admin.
        var allowed = L.allowedTransitions(ticket.status, state.profile.role,
          L.transitionCtx(ticket, state.profile));
        if (allowed.indexOf('open') === -1) { toast(t('common.noPermission'), 'error'); return; }
        var r = await sb.from('tickets').update({ assigned_to: null, status: 'open' }).eq('id', ticket.id);
        if (r.error) throw r.error;
        toast(t('common.saved'), 'ok');
        done();
      } catch (e) { apiError(e); }
    };
  }

  /* v5 P4: human-readable message for a checkMediaLimits rejection. */
  function mediaLimitMsg(err) {
    if (err.key === 'videoSize') return t('media.limit.videoSize').replace('{name}', err.file);
    if (err.key === 'videoCount') return t('media.limit.videoCount');
    return t('media.limit.fileCount');
  }

  /* v5 P3: client-side image compression (Supabase free tier = 1GB).
     Images larger than IMAGE_MAX_DIM px are downscaled and re-encoded
     as JPEG 0.8; small images and non-images pass through untouched. */
  function prepareUploadFile(file) {
    return new Promise(function (resolve) {
      var isImg = (file.type || '').indexOf('image/') === 0;
      if (!isImg || typeof Image === 'undefined' || !document.createElement('canvas').getContext) {
        resolve(file); return;
      }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var ts = L.computeTargetSize(img.naturalWidth || img.width,
          img.naturalHeight || img.height, L.IMAGE_MAX_DIM);
        if (!ts) { resolve(file); return; } /* small enough — keep original */
        try {
          var cv = document.createElement('canvas');
          cv.width = ts.w; cv.height = ts.h;
          cv.getContext('2d').drawImage(img, 0, 0, ts.w, ts.h);
          cv.toBlob(function (blob) {
            if (!blob) { resolve(file); return; }
            var nm = file.name.replace(/\.[^.]+$/, '') + '.jpg';
            try { resolve(new File([blob], nm, { type: 'image/jpeg' })); }
            catch (e) { resolve(file); }
          }, 'image/jpeg', 0.8);
        } catch (e) { resolve(file); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  async function uploadPhoto(ticket, file) {
    var path = L.photoPath(ticket.id, file.name);
    var up = await sb.storage.from('ticket-photos').upload(path, file, {
      contentType: file.type || 'application/octet-stream', upsert: false
    });
    if (up.error) throw up.error;
    var ins = await sb.from('ticket_attachments').insert({
      ticket_id: ticket.id, storage_path: path, file_name: file.name,
      content_type: file.type || null, size_bytes: file.size || null,
      uploaded_by: state.profile.id
    });
    if (ins.error) {
      // Roll back the orphaned object — best effort.
      try { await sb.storage.from('ticket-photos').remove([path]); } catch (e) {}
      throw ins.error;
    }
  }

  async function renderGallery(photos, ticket) {
    var el = document.getElementById('photo-gallery');
    if (!photos.length) { el.innerHTML = '<div class="empty">' + esc(t('detail.photos.empty')) + '</div>'; return; }
    el.innerHTML = '<div class="empty">' + esc(t('common.loading')) + '</div>';
    var items = [];
    for (var i = 0; i < photos.length; i++) {
      var ph = photos[i], url = null;
      try {
        var s = await sb.storage.from('ticket-photos').createSignedUrl(ph.storage_path, 3600);
        if (!s.error) url = s.data.signedUrl;
      } catch (e) {}
      items.push({ ph: ph, url: url });
    }
    el.innerHTML = '<div class="gallery">' + items.map(function (it) {
      var ph = it.ph;
      /* v5 P4: videos render as <video>, images as before. */
      var isVideo = (ph.content_type || '').indexOf('video/') === 0;
      var media = it.url
        ? (isVideo
          ? '<video controls preload="metadata" src="' + esc(it.url) + '" class="gv"></video>'
          : '<a href="' + esc(it.url) + '" target="_blank" rel="noopener"><img src="' + esc(it.url) + '" alt=""></a>')
        : '<div class="empty">—</div>';
      return '<div class="photo">' + media +
        '<div class="pmeta" title="' + esc(ph.file_name || '') + '">' +
          esc(ph.file_name || ph.storage_path) + '<br>' + esc(fmtDate(ph.created_at)) + '</div>' +
        (L.canViewTicket(ticket, state.profile)
          ? '<button class="btn btn-sm btn-danger pdel" data-del="' + ph.id + '" data-path="' + esc(ph.storage_path) + '">✕</button>'
          : '') +
      '</div>';
    }).join('') + '</div>';
    el.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = async function () {
        if (!window.confirm(t('detail.deletePhotoConfirm'))) return;
        try {
          var dr = await sb.from('ticket_attachments').delete().eq('id', b.getAttribute('data-del'));
          if (dr.error) throw dr.error;
          try { await sb.storage.from('ticket-photos').remove([b.getAttribute('data-path')]); } catch (e) {}
          toast(t('common.deleted'), 'ok');
          render();
        } catch (e) { apiError(e); }
      };
    });
  }

  /* v3 U7: icon timeline — each event kind gets its own icon dot + color,
     so status changes, assignments, part issues and notes are instantly
     distinguishable (matters for LTSA penalty disputes). */
  /* v3 U7: icon timeline — each event kind gets its own icon dot + color,
     so status changes, assignments, part issues and notes are instantly
     distinguishable (matters for LTSA penalty disputes).
     v4: the emoji entries are inline SVG (same icon set as the duty badges);
     the plain glyphs stay as text. */
  var TL_ICONS = {
    created: '＋', responded: '↗', visited: '⚒', escalated: '⚠',
    resolved: '✓', closed: '■',
    comment: icon('message', 12), internal: icon('lock', 12), photo: icon('camera', 12)
  };
  function renderTimeline(ticket, comments, photos) {
    var el = document.getElementById('timeline');
    var ev = [];
    function add(ts, label, kind) { if (ts) ev.push({ ts: ts, label: label, kind: kind || 'created' }); }
    add(ticket.created_at, t('detail.tl.created'), 'created');
    add(ticket.responded_at, t('detail.tl.responded'), 'responded');
    add(ticket.visited_at, t('detail.tl.visited'), 'visited');
    add(ticket.escalated_at, t('detail.tl.escalated'), 'escalated');
    add(ticket.resolved_at || (ticket.status === 'closed' ? ticket.updated_at : null), t('detail.tl.resolved'), 'resolved');
    add(ticket.closed_at, t('detail.tl.closed'), 'closed');
    comments.forEach(function (c) {
      add(c.created_at, t('detail.tl.comment') + ' — ' + displayName(c.author_id) +
        (c.is_internal ? ' (' + t('detail.comments.internal') + ')' : ''),
        c.is_internal ? 'internal' : 'comment');
    });
    photos.forEach(function (p) {
      add(p.created_at, t('detail.tl.photo') + ' — ' + (p.file_name || ''), 'photo');
    });
    ev.sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });
    el.innerHTML = ev.map(function (e) {
      var ic = TL_ICONS[e.kind] || TL_ICONS.created;
      return '<li><i class="tl-ic k-' + e.kind + '">' + ic + '</i>' + esc(e.label) +
        '<div class="t-time">' + esc(fmtDate(e.ts)) + '</div></li>';
    }).join('') || '<li>—</li>';
  }

  /* v3 F9: printable service report. A print-only #print-report div is
     populated on click; @media print shows ONLY that div (sidebar/topbar/
     buttons/nav hidden). Includes public comments only — internal notes
     never go on the customer-facing report. */
  async function printServiceReport(ticket, comments) {
    var pr = document.getElementById('print-report');
    if (!pr) {
      pr = document.createElement('div');
      pr.id = 'print-report';
      document.body.appendChild(pr);
    }
    /* v5: customers have no part.view — skip the parts section for them. */
    var showParts = state.profile.role !== 'customer';
    /* parts used on this ticket */
    var txRows = '';
    if (showParts) {
    try {
      var trx = await sb.from('part_transactions').select('*').eq('ticket_id', ticket.id).order('created_at');
      var txs = trx.error ? [] : (trx.data || []);
      if (txs.length) {
        var pids = [];
        txs.forEach(function (x) { if (x.part_id && pids.indexOf(x.part_id) === -1) pids.push(x.part_id); });
        var pmap = {};
        if (pids.length) {
          try {
            var pr2 = await sb.from('spare_parts').select('id,code,name,unit').in('id', pids);
            (pr2.error ? [] : (pr2.data || [])).forEach(function (p) { pmap[p.id] = p; });
          } catch (e) {}
        }
        txRows = txs.map(function (x) {
          var p = pmap[x.part_id] || {};
          return '<tr><td>' + esc(p.code || '—') + '</td><td>' + esc(p.name || '') + '</td>' +
            '<td>' + esc(String(x.qty_delta)) + ' ' + esc(p.unit || '') + '</td>' +
            '<td>' + esc(fmtDate(x.created_at)) + '</td><td>' + esc(x.note || '') + '</td></tr>';
        }).join('');
      }
    } catch (e) { /* parts section renders empty — non-fatal */ }
    } /* end if (showParts) */
    /* status history (oldest first) */
    var hist = [];
    function hadd(ts, label) { if (ts) hist.push({ ts: ts, label: label }); }
    hadd(ticket.created_at, t('detail.tl.created'));
    hadd(ticket.responded_at, t('detail.tl.responded'));
    hadd(ticket.visited_at, t('detail.tl.visited'));
    hadd(ticket.resolved_at || (ticket.status === 'closed' ? ticket.updated_at : null), t('detail.tl.resolved'));
    hadd(ticket.closed_at, t('detail.tl.closed'));
    hist.sort(function (a, b) { return new Date(a.ts) - new Date(b.ts); });
    /* public comments only */
    var pubComments = (comments || []).filter(function (c) { return !c.is_internal; });
    function row(k, v) {
      return '<tr><th style="width:200px">' + esc(k) + '</th><td>' + esc(v) + '</td></tr>';
    }
    pr.innerHTML =
      '<h1>' + esc(t('report.title')) + ' — ' + esc(L.formatTicketNo(ticket.ticket_no)) + '</h1>' +
      '<div class="pr-meta">' + esc(t('report.generatedAt')) + ': ' + esc(fmtDate(new Date().toISOString())) + '</div>' +
      '<h2>' + esc(ticket.title) + '</h2>' +
      '<table><tbody>' +
        row(t('detail.site'), siteLabel(ticket.site_id)) +
        row(t('common.status'), t('status.' + ticket.status)) +
        row(t('common.priority'), t('priority.' + ticket.priority)) +
        row(t('detail.source'), t('source.' + ticket.source)) +
        row(t('detail.assignee'), displayName(ticket.assigned_to)) +
        row(t('detail.createdBy'), displayName(ticket.created_by)) +
        row(t('common.createdAt'), fmtDate(ticket.created_at)) +
        row(t('common.updatedAt'), fmtDate(ticket.updated_at)) +
      '</tbody></table>' +
      '<h2>' + esc(t('detail.description')) + '</h2><div>' + esc(ticket.description || '—') + '</div>' +
      '<h2>' + esc(t('detail.fieldReport')) + '</h2>' +
      '<table><tbody>' +
        row(t('detail.visitedAt'), fmtDate(ticket.visited_at)) +
        row(t('detail.problemCategory'), ticket.problem_category || '—') +
        row(t('detail.resolution'), ticket.resolution || '—') +
      '</tbody></table>' +
      /* v5: parts section hidden for customers (no part.view). */
      (showParts
        ? '<h2>' + esc(t('report.partsUsed')) + '</h2>' +
          (txRows
            ? '<table><thead><tr><th>' + esc(t('report.partCode')) + '</th><th>' + esc(t('report.partName')) +
              '</th><th>' + esc(t('report.qty')) + '</th><th>' + esc(t('report.date')) +
              '</th><th>' + esc(t('report.note')) + '</th></tr></thead><tbody>' + txRows + '</tbody></table>'
            : '<div>—</div>')
        : '') +
      '<h2>' + esc(t('report.statusHistory')) + '</h2>' +
      '<table><tbody>' + hist.map(function (h) {
        return '<tr><td style="width:200px">' + esc(fmtDate(h.ts)) + '</td><td>' + esc(h.label) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<h2>' + esc(t('detail.comments')) + '</h2>' +
      (pubComments.length
        ? pubComments.map(function (c) {
            return '<div style="margin-bottom:8px"><b>' + esc(displayName(c.author_id)) + '</b> · ' +
              esc(fmtDate(c.created_at)) + '<div>' + esc(c.body) + '</div></div>';
          }).join('')
        : '<div>—</div>');
    window.print();
  }

  /* v3 F2: related tickets — bidirectional links via ticket_links.
     Stored normalized (ticket_a < ticket_b) to satisfy uq_ticket_links_pair. */
  function normPair(id1, id2) {
    return id1 < id2 ? [id1, id2] : [id2, id1];
  }
  async function loadRelatedTickets(ticketId) {
    var box = document.getElementById('related-list');
    if (!box) return;
    try {
      var lr = await sb.from('ticket_links').select('*')
        .or('ticket_a.eq.' + ticketId + ',ticket_b.eq.' + ticketId);
      if (lr.error) throw lr.error;
      var links = lr.data || [];
      if (!links.length) {
        box.innerHTML = '<div class="empty">' + esc(t('detail.related.none')) + '</div>';
      } else {
        var otherIds = links.map(function (l) {
          return l.ticket_a === ticketId ? l.ticket_b : l.ticket_a;
        });
        var tr = await sb.from('tickets').select('id,ticket_no,title,status')
          .in('id', otherIds);
        var map = {};
        (tr.error ? [] : (tr.data || [])).forEach(function (x) { map[x.id] = x; });
        box.innerHTML = links.map(function (l) {
          var o = l.ticket_a === ticketId ? l.ticket_b : l.ticket_a;
          var x = map[o];
          if (!x) return '';
          return '<div class="related-row">' +
            '<a href="#/ticket/' + x.id + '" class="tnum">' + esc(L.formatTicketNo(x.ticket_no)) + '</a> ' +
            '<span class="ttl">' + esc(x.title) + '</span> ' + statusBadge(x.status) +
            ' <button class="btn-link danger" data-unlink="' + l.id + '" title="' +
              esc(t('common.remove')) + '">✕</button></div>';
        }).join('');
        box.querySelectorAll('[data-unlink]').forEach(function (b) {
          b.onclick = async function () {
            try {
              var dr = await sb.from('ticket_links').delete().eq('id', b.getAttribute('data-unlink'));
              if (dr.error) throw dr.error;
              toast(t('detail.related.unlinked'), 'ok');
              loadRelatedTickets(ticketId);
            } catch (e) { apiError(e); }
          };
        });
      }
      var btn = document.getElementById('link-ticket-btn');
      if (btn) btn.onclick = function () { openLinkTicketModal(ticketId, function () { loadRelatedTickets(ticketId); }); };
    } catch (e) {
      box.innerHTML = '<div class="inline-err">' + esc(e.message || t('common.error')) + '</div>';
    }
  }
  function openLinkTicketModal(ticketId, done) {
    var body =
      '<div class="field"><label>' + esc(t('detail.related.searchPh')) + '</label>' +
        '<input type="text" id="lt-q" placeholder="' + esc(t('list.searchPh')) + '"></div>' +
      '<div id="lt-results" style="max-height:260px;overflow-y:auto"></div>';
    var close = openModal(t('detail.linkTicket'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    var deb = null;
    async function search() {
      var q = document.getElementById('lt-q').value.trim();
      var box = document.getElementById('lt-results');
      if (!q) { box.innerHTML = ''; return; }
      try {
        var r = await baseTicketQuery('id,ticket_no,title,status')
          .neq('id', ticketId)
          .or('title.ilike.%' + q + '%,description.ilike.%' + q + '%')
          .order('updated_at', { ascending: false }).limit(15);
        if (r.error) throw r.error;
        box.innerHTML = (r.data || []).map(function (x) {
          return '<div class="related-row">' +
            '<a href="#/ticket/' + x.id + '" class="tnum">' + esc(L.formatTicketNo(x.ticket_no)) + '</a> ' +
            '<span class="ttl">' + esc(x.title) + '</span> ' + statusBadge(x.status) +
            ' <button class="btn btn-sm" data-link="' + x.id + '">' + esc(t('common.add')) + '</button></div>';
        }).join('') || '<div class="empty">' + esc(t('list.noResults')) + '</div>';
        box.querySelectorAll('[data-link]').forEach(function (b) {
          b.onclick = async function () {
            try {
              var pair = normPair(ticketId, b.getAttribute('data-link'));
              var ir = await sb.from('ticket_links').insert({
                ticket_a: pair[0], ticket_b: pair[1], created_by: state.profile.id
              });
              if (ir.error) throw ir.error;
              toast(t('detail.related.linked'), 'ok');
              close(); done();
            } catch (e) { apiError(e); }
          };
        });
      } catch (e) { apiError(e); }
    }
    document.getElementById('lt-q').oninput = function () {
      clearTimeout(deb); deb = setTimeout(search, 400);
    };
  }
  function openModal(title, bodyHtml, footHtml, wide) {
    var root = document.getElementById('modal-root');
    root.innerHTML =
      '<div class="modal-backdrop" id="m-back"><div class="modal' + (wide ? ' wide' : '') + '" role="dialog">' +
        '<div class="modal-head"><h2>' + esc(title) + '</h2>' +
        '<button class="btn-link" id="m-x">✕</button></div>' +
        '<div class="modal-body">' + bodyHtml + '</div>' +
        (footHtml ? '<div class="modal-foot">' + footHtml + '</div>' : '') +
      '</div></div>';
    function close() { root.innerHTML = ''; }
    document.getElementById('m-x').onclick = close;
    document.getElementById('m-back').onclick = function (e) {
      if (e.target.id === 'm-back') close();
    };
    return close;
  }

  /* v4: ranked engineer candidate list — the assignment recommendation,
     made REAL: region matches first (site region from site.country), then
     name. Each candidate shows a region-match badge, skills text and a
     remote-capable icon. Used by the ticket assign box and the booking flow. */
  function candidateListHtml(ranked, selectedId, inputName) {
    return '<div class="cand-list" role="radiogroup" aria-label="' + esc(t('assign.ranked')) + '">' +
      ranked.map(function (r, i) {
        var e = r.eng;
        var checked = (selectedId && e.id === selectedId) || (!selectedId && i === 0);
        var rc = e.remote_capable !== false;
        var regs = r.regions.length ? r.regions.map(regionName).join(', ') : '—';
        return '<label class="cand"><input type="radio" name="' + inputName + '" value="' + e.id + '"' +
          (checked ? ' checked' : '') + '>' +
          '<span class="cand-name">' + esc(e.display_name || e.email) + '</span>' +
          '<span class="region-badge ' + (r.regionMatch ? 'match' : 'nomatch') + '" title="' +
            esc(t('assign.region') + ': ' + regs) + '">' +
            (r.regionMatch ? '✓ ' + esc(t('assign.regionMatch')) : esc(regs)) + '</span>' +
          (e.skills ? '<span class="cand-skills">' + esc(e.skills) + '</span>' : '') +
          '<span class="cand-remote' + (rc ? '' : ' off') + '" title="' +
            esc(rc ? t('assign.remoteCapable') : t('assign.noRemoteCapable')) + '">' +
            icon('laptop', 14) + '</span></label>';
      }).join('') + '</div>';
  }
  function candidateValue(inputName) {
    var el = document.querySelector('input[name="' + inputName + '"]:checked');
    return el ? el.value : null;
  }
  /* ------------------------- modals: edit ticket ------------------------ */

  /* v3 I2: field-activity dates + "book resource" with conflict warnings.
     Dates live on tickets (onsite_from/to); booking writes shifts rows
     (status=assigned, ticket_id set) so the planning board shows the work. */
  function openOnsiteDatesModal(ticket, done) {
    var body =
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('detail.onsiteFrom')) + '</label>' +
          '<input type="date" id="os-from" value="' + esc(ticket.onsite_from || '') + '"></div>' +
        '<div class="field"><label>' + esc(t('detail.onsiteTo')) + '</label>' +
          '<input type="date" id="os-to" value="' + esc(ticket.onsite_to || '') + '"></div>' +
      '</div>' +
      '<div class="hint">' + esc(t('detail.onsiteHint')) + '</div>';
    var close = openModal(t('detail.setOnsiteDates'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    document.getElementById('m-save').onclick = async function () {
      var from = document.getElementById('os-from').value || null;
      var to = document.getElementById('os-to').value || null;
      if (from && to && to < from) { toast(t('detail.onsiteDateErr'), 'error'); return; }
      this.disabled = true;
      try {
        var r = await sb.from('tickets').update({ onsite_from: from, onsite_to: to }).eq('id', ticket.id);
        if (r.error) throw r.error;
        close(); toast(t('common.saved'), 'ok'); done();
      } catch (e) { apiError(e); this.disabled = false; }
    };
  }
  function eachDay(from, to) {
    var out = [], d = new Date(from + 'T12:00:00'), end = new Date(to + 'T12:00:00');
    while (d <= end) { out.push(ymd(d)); d.setDate(d.getDate() + 1); }
    return out;
  }
  async function openBookResourceModal(ticket, done) {
    if (!ticket.onsite_from || !ticket.onsite_to) {
      toast(t('detail.bookNeedsDates'), 'error');
      return;
    }
    /* v4: booking requires an assigned engineer first. */
    if (!ticket.assigned_to) {
      toast(t('detail.bookNeedsAssignee'), 'error');
      return;
    }
    var er = await sb.from('profiles').select('id,display_name,email,country,country_code,regions,skills,remote_capable')
      .eq('role', 'engineer').eq('is_active', true).order('display_name');
    if (er.error) { apiError(er.error); return; }
    var engineers = er.data || [];
    /* v4: rank engineers by region match (REAL ranking, not decorative). */
    var bSite = (state.sites || []).filter(function (x) { return x.id === ticket.site_id; })[0] || {};
    var bSiteRegion = L.regionOfCountry(bSite.country);
    var bRanked = L.rankEngineers(engineers, bSite.country);
    var body =
      '<div class="field"><label>' + esc(t('assign.ranked')) +
        (bSiteRegion ? ' <span class="muted">· ' + esc(t('assign.siteRegion')) + ': ' +
          esc(regionName(bSiteRegion)) + '</span>' : '') + '</label>' +
        candidateListHtml(bRanked, ticket.assigned_to, 'bk-eng') + '</div>' +
      '<div class="muted">' + esc(t('detail.bookRange')
        .replace('{from}', fmtDate(ticket.onsite_from)).replace('{to}', fmtDate(ticket.onsite_to))) + '</div>' +
      '<div id="bk-warnings" style="margin-top:10px"></div>';
    var close = openModal(t('detail.bookResource'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn" id="bk-check">' + esc(t('detail.checkConflicts')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('detail.bookConfirm')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    var lastCheck = null;
    async function check() {
      var engId = candidateValue('bk-eng');
      var box = document.getElementById('bk-warnings');
      box.innerHTML = '<div class="empty">' + esc(t('common.loading')) + '</div>';
      var warnings = [];
      try {
        var days = eachDay(ticket.onsite_from, ticket.onsite_to);
        /* v4: conflicts cover the new absence types (vacation/sick/training/
           travel) plus legacy leave, other assignments, holidays and weekends. */
        var sr = await sb.from('shifts').select('day,status,day_part').eq('engineer_id', engId)
          .gte('day', ticket.onsite_from).lte('day', ticket.onsite_to);
        (sr.error ? [] : (sr.data || [])).forEach(function (s) {
          if (L.ABSENCE_TO_DEF[s.status]) {
            warnings.push({ day: s.day, kind: 'absence', status: s.status, dayPart: s.day_part });
          } else if (s.status === 'assigned' || s.status === 'field') {
            warnings.push({ day: s.day, kind: 'busy' });
          }
        });
        // 2) holidays in the engineer's country
        var eng = engineers.filter(function (e) { return e.id === engId; })[0] || {};
        var cc = ((eng.country_code || eng.country) || '').toUpperCase();
        if (cc && state.v3) {
          var hr = await sb.from('holidays').select('day,name').eq('country_code', cc)
            .gte('day', ticket.onsite_from).lte('day', ticket.onsite_to);
          (hr.error ? [] : (hr.data || [])).forEach(function (h) {
            warnings.push({ day: h.day, kind: 'holiday', name: h.name });
          });
        }
        // 3) weekends
        days.forEach(function (d) {
          var dw = new Date(d + 'T12:00:00').getDay();
          if (dw === 0 || dw === 6) warnings.push({ day: d, kind: 'weekend' });
        });
        lastCheck = { engId: engId, days: days, warnings: warnings };
        /* v4: amber info-box naming the engineer + dates — warn, don't block. */
        box.innerHTML = warnings.length
          ? '<div class="inline-warn"><div class="warn-head">' + icon('alert', 14) +
            esc(t('detail.warn.conflictTitle')
              .replace('{name}', eng.display_name || eng.email || '')) + '</div>' +
            warnings.map(function (w) {
              var lbl = w.kind === 'absence'
                ? statusLabel(absenceDefKey(w.status)) +
                  (w.dayPart && w.dayPart !== 'full' ? ' · ' + dayPartLabel(w.dayPart) : '')
                : w.kind === 'busy' ? t('detail.warn.busy')
                : w.kind === 'holiday' ? t('detail.warn.holiday').replace('{name}', w.name || '')
                : t('detail.warn.weekend');
              return '<div>' + esc(w.day) + ' — ' + esc(lbl) + '</div>';
            }).join('') +
            '<div class="warn-note">' + esc(t('detail.warn.conflictNote')) + '</div></div>'
          : '<div class="ok-line">' + esc(t('detail.warn.none')) + '</div>';
      } catch (e) {
        box.innerHTML = '<div class="inline-err">' + esc(e.message || t('common.error')) + '</div>';
      }
    }
    document.getElementById('bk-check').onclick = check;
    document.getElementById('m-save').onclick = async function () {
      if (!lastCheck || lastCheck.engId !== candidateValue('bk-eng')) {
        toast(t('detail.bookCheckFirst'), 'error');
        return;
      }
      if (lastCheck.warnings.length &&
          !window.confirm(t('detail.bookWarnConfirm').replace('{n}', String(lastCheck.warnings.length)))) return;
      this.disabled = true;
      try {
        var rows = lastCheck.days.map(function (d) {
          return {
            engineer_id: lastCheck.engId, day: d, status: 'assigned',
            site_id: ticket.site_id || null, ticket_id: ticket.id,
            note: L.formatTicketNo(ticket.ticket_no)
          };
        });
        var r = await sb.from('shifts').upsert(rows, { onConflict: 'engineer_id,day' });
        if (r.error) throw r.error;
        // Keep the ticket's assignee in sync with the booked engineer.
        if (ticket.assigned_to !== lastCheck.engId) {
          await sb.from('tickets').update({ assigned_to: lastCheck.engId }).eq('id', ticket.id);
        }
        close(); toast(t('detail.booked'), 'ok'); done();
      } catch (e) { apiError(e); this.disabled = false; }
    };
  }
  function openTicketEditModal(ticket, done) {
    var body =
      '<div class="field"><label>' + esc(t('new.field.title')) + '<span class="req">*</span></label>' +
        '<input type="text" id="et-title" value="' + esc(ticket.title) + '"></div>' +
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('new.field.priority')) + '</label>' +
          '<select id="et-priority">' + L.PRIORITIES.map(function (pr) {
            return '<option value="' + pr + '"' + (ticket.priority === pr ? ' selected' : '') + '>' +
              esc(t('priority.' + pr)) + '</option>';
          }).join('') + '</select></div>' +
        '<div class="field"><label>' + esc(t('new.field.site')) + '</label>' +
          '<select id="et-site"><option value="">' + esc(t('common.none')) + '</option>' +
          state.sites.map(function (s) {
            return '<option value="' + s.id + '"' + (ticket.site_id === s.id ? ' selected' : '') + '>' +
              esc(s.code + ' — ' + s.name) + '</option>';
          }).join('') + '</select></div>' +
      '</div>' +
      '<div class="field"><label>' + esc(t('new.field.description')) + '</label>' +
        '<textarea id="et-desc">' + esc(ticket.description || '') + '</textarea></div>' +
      (state.v3
        ? '<div class="field"><label>' + esc(t('new.field.tags')) + '</label>' +
          '<input type="text" id="et-tags" placeholder="' + esc(t('new.field.tagsPh')) +
          '" value="' + esc((ticket.tags || []).join(', ')) + '"></div>'
        : '');
    var close = openModal(t('detail.editTicket'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    document.getElementById('m-save').onclick = async function () {
      var title = document.getElementById('et-title').value.trim();
      if (!title) { toast(t('new.fillRequired'), 'error'); return; }
      this.disabled = true;
      try {
        var upd = {
          title: title,
          description: document.getElementById('et-desc').value,
          priority: document.getElementById('et-priority').value,
          site_id: document.getElementById('et-site').value || null
        };
        if (state.v3) {
          var etTags = document.getElementById('et-tags');
          upd.tags = etTags ? parseTags(etTags.value) : (ticket.tags || []);
        }
        var r = await sb.from('tickets').update(upd).eq('id', ticket.id);
        if (r.error) throw r.error;
        close(); toast(t('detail.editSaved'), 'ok'); done();
      } catch (e) { apiError(e); this.disabled = false; }
    };
  }

  function openFieldReportModal(ticket, done) {
    var body =
      '<div class="field"><label>' + esc(t('detail.visitedAt')) + '</label>' +
        '<input type="datetime-local" id="fr-visited" value="' + fmtInputDateTime(ticket.visited_at) + '">' +
        '<div class="hint">' + esc(t('detail.sla.onsite')) + ': ' + esc(t('detail.sla.stopped')) + '</div></div>' +
      '<div class="field"><label>' + esc(t('detail.problemCategory')) + '</label>' +
        '<input type="text" id="fr-cat" value="' + esc(ticket.problem_category || '') + '"></div>' +
      '<div class="field"><label>' + esc(t('detail.description')) + '</label>' +
        '<textarea id="fr-desc">' + esc(ticket.description || '') + '</textarea></div>' +
      '<div class="field"><label>' + esc(t('detail.resolution')) + '</label>' +
        '<textarea id="fr-res">' + esc(ticket.resolution || '') + '</textarea></div>';
    var close = openModal(t('detail.fieldReport'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('detail.saveFieldReport')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    document.getElementById('m-save').onclick = async function () {
      this.disabled = true;
      try {
        var v = document.getElementById('fr-visited').value;
        var r = await sb.from('tickets').update({
          visited_at: v ? new Date(v).toISOString() : null,
          problem_category: document.getElementById('fr-cat').value.trim() || null,
          description: document.getElementById('fr-desc').value,
          resolution: document.getElementById('fr-res').value.trim() || null
        }).eq('id', ticket.id);
        if (r.error) throw r.error;
        close(); toast(t('detail.fieldReport.saved'), 'ok'); done();
      } catch (e) { apiError(e); this.disabled = false; }
    };
  }

  /* ------------------------------ new ticket ---------------------------- */
  function viewNewTicket(view) {
    if (!L.can('ticket.create', state.profile.role)) {
      view.innerHTML = '<div class="inline-err">' + esc(t('common.noPermissionView')) + '</div>';
      return;
    }
    var role = state.profile.role;
    var sources = role === 'customer' ? ['customer_feedback'] : L.SOURCES;
    /* v5 P1: role-differentiated required fields. Customers only need
       title + site + description + a photo/video; the technical fields
       (serial/fw/error/actions) become optional with an "if known" hint. */
    var isCustomer = (role === 'customer');
    var reqIds = L.requiredNewTicketFields(role);
    if (isCustomer && !state.sites.length) {
      /* Edge: a customer with no sites in scope must not be dead-ended. */
      reqIds = reqIds.filter(function (id) { return id !== 'nt-site'; });
    }
    var need = function (id) { return reqIds.indexOf(id) !== -1; };
    var star = function (id) { return need(id) ? '<span class="req">*</span>' : ''; };
    var reqAttr = function (id) { return need(id) ? ' required' : ''; };
    var ifKnown = isCustomer
      ? '<div class="hint">' + esc(t('new.hint.ifKnown')) + '</div>' : '';
    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('new.title')) + '</h1></div>' +
      /* v4: banner when launched from the planning cell workbench. */
      (newTicketPrefill
        ? '<div class="inline-warn" style="margin-bottom:16px">' +
          esc(t('new.prefillField')
            .replace('{name}', newTicketPrefill.engineerName || '')
            .replace('{day}', newTicketPrefill.day || '')) + '</div>'
        : '') +
      '<div class="card"><h2>' + esc(t('new.formTitle')) + '</h2>' +
      '<form id="new-form" class="nt-grid">' +
        '<div class="field span2"><label>' + esc(t('new.field.title')) + star('nt-title') + '</label>' +
          '<input type="text" id="nt-title"' + reqAttr('nt-title') + '></div>' +
        '<div class="field"><label>' + esc(t('new.field.priority')) + '</label>' +
          '<select id="nt-priority">' + L.PRIORITIES.map(function (pr) {
            return '<option value="' + pr + '"' + (pr === 'medium' ? ' selected' : '') + '>' +
              esc(t('priority.' + pr)) + '</option>';
          }).join('') + '</select></div>' +
        '<div class="field"><label>' + esc(t('new.field.source')) + '<span class="req">*</span></label>' +
          '<select id="nt-source">' + sources.map(function (s) {
            return '<option value="' + s + '">' + esc(t('source.' + s)) + '</option>';
          }).join('') + '</select>' +
          (isCustomer ? '<div class="hint">' + esc(t('new.sourceHint.customer')) + '</div>' : '') + '</div>' +
        '<div class="field"><label>' + esc(t('new.field.site')) + star('nt-site') + '</label>' +
          '<select id="nt-site"' + reqAttr('nt-site') + '><option value="">' + esc(t('common.none')) + '</option>' +
          state.sites.map(function (s) {
            return '<option value="' + s.id + '">' + esc(s.code + ' — ' + s.name) + '</option>';
          }).join('') + '</select>' +
          '<div class="inline-err" id="nt-contract-notice" style="display:none;margin-top:8px;margin-bottom:0">' +
            esc(t('new.contractNotice')) + '</div></div>' +
        '<div class="field"><label>' + esc(t('detail.serialNumber')) + star('nt-serial') + '</label>' +
          '<input type="text" id="nt-serial"' + reqAttr('nt-serial') + '>' + ifKnown + '</div>' +
        '<div class="field"><label>' + esc(t('detail.firmwareVersion')) + star('nt-fw') + '</label>' +
          '<input type="text" id="nt-fw"' + reqAttr('nt-fw') + '>' + ifKnown + '</div>' +
        '<div class="field"><label>' + esc(t('detail.errorCode')) + star('nt-err') + '</label>' +
          '<input type="text" id="nt-err"' + reqAttr('nt-err') + '>' + ifKnown + '</div>' +
        '<div class="field"><label>' + esc(t('detail.actionsTaken')) + star('nt-actions') + '</label>' +
          '<input type="text" id="nt-actions"' + reqAttr('nt-actions') + '>' + ifKnown + '</div>' +
        '<div class="field span2"><label>' + esc(t('new.field.description')) + star('nt-desc') + '</label>' +
          '<textarea id="nt-desc"' + reqAttr('nt-desc') + '></textarea></div>' +
        /* v5 P2: photo/video picker right on the form. Customers must
           attach at least one file (it replaces the technical fields). */
        '<div class="field span2"><label>' + esc(t('new.field.attachments')) +
          (isCustomer ? '<span class="req">*</span>' : '') + '</label>' +
          '<input type="file" id="nt-files" accept="image/*,video/*" multiple>' +
          '<div class="hint">' + esc(t('new.attachments.hint')) + '</div>' +
          '<div id="nt-preview" class="nt-preview"></div></div>' +
        (state.v3
          ? '<div class="field span2"><label>' + esc(t('new.field.tags')) + '</label>' +
            '<input type="text" id="nt-tags" placeholder="' + esc(t('new.field.tagsPh')) + '"></div>'
          : '') +
        '<div class="form-actions span2">' +
          '<button type="submit" class="btn btn-primary" id="nt-submit">' + esc(t('common.create')) + '</button>' +
          '<button type="button" class="btn" id="nt-cancel">' + esc(t('common.cancel')) + '</button>' +
        '</div>' +
      '</form></div>';
    document.getElementById('nt-cancel').onclick = function () { nav('#/tickets'); };
    /* v2 R3: a site with an active LTSA contract forces is_ltsa + urgent + contract SLA. */
    var siteSel = document.getElementById('nt-site');
    var priSel = document.getElementById('nt-priority');
    /* v4: apply the planning workbench prefill (site). */
    if (newTicketPrefill && newTicketPrefill.siteId) {
      siteSel.value = newTicketPrefill.siteId;
    }
    function refreshContractState() {
      var c = state.contracts[siteSel.value];
      var active = c && L.isContractActive(c);
      var notice = document.getElementById('nt-contract-notice');
      if (active) {
        priSel.value = 'urgent'; priSel.disabled = true;
        notice.style.display = 'block';
      } else {
        priSel.disabled = false; notice.style.display = 'none';
      }
    }
    siteSel.onchange = refreshContractState;
    refreshContractState();
    /* v5 P2: live preview thumbnails for the picked files. */
    var ntPrevUrls = [];
    document.getElementById('nt-files').onchange = function () {
      ntPrevUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
      ntPrevUrls = [];
      var prev = document.getElementById('nt-preview');
      var files = this.files || [];
      var html = '';
      for (var i = 0; i < files.length; i++) {
        var f = files[i], url = URL.createObjectURL(f);
        ntPrevUrls.push(url);
        var isVideo = (f.type || '').indexOf('video/') === 0;
        html += '<div class="nt-thumb" title="' + esc(f.name) + '">' +
          (isVideo
            ? '<video src="' + url + '" preload="metadata"></video><span class="nt-vid">▶</span>'
            : '<img src="' + url + '" alt="">') +
          '</div>';
      }
      prev.innerHTML = html;
    };
    document.getElementById('new-form').onsubmit = async function (e) {
      e.preventDefault();
      var get = function (id) { return document.getElementById(id).value.trim(); };
      /* v5 P1: required set depends on the role. */
      var missing = reqIds.some(function (id) { return !get(id); });
      if (missing) { toast(t('new.fillRequired'), 'error'); return; }
      /* v5 P2: collect the picked files; customers must attach ≥1. */
      var pickedFiles = Array.prototype.slice.call(
        (document.getElementById('nt-files') || {}).files || []);
      if (isCustomer && !pickedFiles.length) {
        toast(t('new.attachments.required'), 'error'); return;
      }
      /* v5 P4: hard media limits before anything is uploaded. */
      var limErrs = L.checkMediaLimits(pickedFiles.map(function (f) {
        return { name: f.name, size: f.size, type: f.type };
      }), 0, 0);
      if (limErrs.length) { toast(mediaLimitMsg(limErrs[0]), 'error'); return; }
      var btn = document.getElementById('nt-submit');
      btn.disabled = true;
      try {
        var now = new Date();
        var siteVal = siteSel.value || null;
        var contract = (siteVal && state.contracts[siteVal]) || null;
        var useContract = contract && L.isContractActive(contract);
        var priority, isLtsa = false, slaR, slaO, slaS;
        if (useContract) {
          var ac = L.applyContract(now, contract);
          priority = 'urgent'; isLtsa = true;
          slaR = ac.sla_response_at; slaO = ac.sla_onsite_at; slaS = ac.sla_resolve_at;
        } else {
          var dl = L.computeSlaDeadlines(now, get('nt-priority') || 'medium', state.slaPolicies);
          priority = priSel.value;
          slaR = dl.response && dl.response.toISOString();
          slaO = dl.onsite && dl.onsite.toISOString();
          slaS = dl.resolve && dl.resolve.toISOString();
        }
        var insData = {
          title: get('nt-title'),
          description: get('nt-desc'),
          priority: priority,
          is_ltsa: isLtsa,
          source: document.getElementById('nt-source').value,
          site_id: siteVal,
          serial_number: get('nt-serial'),
          firmware_version: get('nt-fw'),
          error_code: get('nt-err'),
          actions_taken: get('nt-actions'),
          created_by: state.profile.id,
          sla_response_at: slaR,
          sla_onsite_at: slaO,
          sla_resolve_at: slaS
        };
        if (state.v3) {
          var tagEl = document.getElementById('nt-tags');
          insData.tags = tagEl ? parseTags(tagEl.value) : [];
        }
        var ins = await sb.from('tickets').insert(insData).select('id,ticket_no').single();
        if (ins.error) throw ins.error;
        /* v4: planning workbench prefill — set the assignee and the field
           date right after creation, then consume the prefill. */
        var pf = newTicketPrefill; newTicketPrefill = null;
        if (pf && pf.engineerId) {
          try {
            await sb.from('tickets').update({
              assigned_to: pf.engineerId,
              onsite_from: pf.day || null,
              onsite_to: pf.day || null
            }).eq('id', ins.data.id);
          } catch (e) { /* assignee/date stay unset — non-fatal */ }
        }
        toast(t('new.created', { no: L.formatTicketNo(ins.data.ticket_no) }), 'ok');
        /* v5 P2: upload the form-picked files against the new ticket.
           Ticket stays even if some uploads fail — report the failures. */
        if (pickedFiles.length) {
          btn.textContent = t('common.uploading');
          var failed = [];
          for (var fi = 0; fi < pickedFiles.length; fi++) {
            try {
              await uploadPhoto({ id: ins.data.id }, await prepareUploadFile(pickedFiles[fi]));
            } catch (e) { failed.push(pickedFiles[fi].name); }
          }
          if (failed.length) {
            toast(t('new.upload.partial').replace('{names}', failed.join(', ')), 'warn');
          }
        }
        ntPrevUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
        nav('#/ticket/' + ins.data.id);
      } catch (err) { apiError(err); btn.disabled = false; }
    };
  }

  /* --------------------------- user management -------------------------- */
  async function viewUsers(view) {
    var res = await sb.from('profiles').select('*').order('created_at', { ascending: false });
    if (res.error) {
      view.innerHTML = '<div class="inline-err">' + esc(res.error.message) + '</div>';
      return;
    }
    var users = res.data || [];
    users.forEach(function (u) { state.nameCache[u.id] = u.display_name || u.email; });
    /* v4: EU country options for the engineer country_code picker. */
    var EU_COUNTRIES = ['DE', 'IT', 'ES', 'FR', 'NL', 'PL', 'GR', 'RO', 'AT', 'CH', 'BE', 'PT', 'CZ', 'HU', 'SE'];
    var rows = users.map(function (u) {
      var scope = (u.project_scope && u.project_scope.length)
        ? u.project_scope.map(siteShort).join(', ') : t('users.projectScopeAll');
      var main = '<tr>' +
        '<td><b>' + esc(u.display_name || '—') + '</b><br><span class="muted">' + esc(u.email || '') + '</span></td>' +
        '<td>' + esc(t('role.' + u.role)) + '</td>' +
        '<td>' + certBadge(u.cert_level) + '</td>' +
        '<td class="muted">' + esc(u.country || '—') + '</td>' +
        '<td class="muted">' + esc(scope) + '</td>' +
        '<td>' + (u.is_active
            ? badge('sla-ok', t('users.active'))
            : badge('status-closed', t('users.deactivate'))) + '</td>' +
        '<td><button class="btn btn-sm" data-edit="' + u.id + '">' + esc(t('common.edit')) + '</button> ' +
        (u.is_active
          ? '<button class="btn btn-sm btn-danger" data-deact="' + u.id + '">' + esc(t('users.deactivate')) + '</button>'
          : '<button class="btn btn-sm" data-react="' + u.id + '">' + esc(t('users.active')) + '</button>') +
        '</td></tr>';
      /* v4: inline-editable scheduling master data for engineers —
         country_code, remote_capable, skills, regions. Hidden when !v4
         (columns don't exist on older backends). */
      var extra = '';
      if (state.v4 && u.role === 'engineer') {
        var ccVal = ((u.country_code || u.country) || '').toUpperCase();
        extra = '<tr class="eng-extra" data-engrow="' + u.id + '"><td colspan="7">' +
          '<div class="micro-label" style="margin-bottom:8px">' + esc(t('users.scheduling')) + '</div>' +
          '<div class="ee-grid">' +
            '<div class="field"><label>' + esc(t('users.countryCode')) + '</label>' +
              '<select data-f="country_code"><option value="">' + esc(t('common.none')) + '</option>' +
              EU_COUNTRIES.map(function (c) {
                return '<option value="' + c + '"' + (ccVal === c ? ' selected' : '') + '>' + c + '</option>';
              }).join('') + '</select></div>' +
            '<div class="field"><label>' + esc(t('users.remoteCapable')) + '</label>' +
              '<input type="checkbox" data-f="remote_capable" style="width:auto"' +
              (u.remote_capable !== false ? ' checked' : '') + '></div>' +
            '<div class="field wide"><label>' + esc(t('users.skills')) + '</label>' +
              '<input type="text" data-f="skills" value="' + esc(u.skills || '') +
              '" placeholder="' + esc(t('users.skillsPh')) + '"></div>' +
            '<div class="field"><label>' + esc(t('users.regions')) + '</label>' +
              '<div class="regions-cbs">' + L.REGION_SET.map(function (r) {
                return '<label><input type="checkbox" data-region="' + esc(r) + '"' +
                  ((u.regions || []).indexOf(r) !== -1 ? ' checked' : '') + '> ' +
                  esc(regionName(r)) + '</label>';
              }).join('') + '</div></div>' +
            '<div class="field"><label>&nbsp;</label>' +
              '<button class="btn btn-sm btn-primary" data-schedsave="' + u.id + '">' +
              esc(t('common.save')) + '</button></div>' +
          '</div></td></tr>';
      }
      return main + extra;
    }).join('');
    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('users.title')) + '</h1>' +
      '<button class="btn btn-primary" id="user-new">+ ' + esc(t('users.new')) + '</button></div>' +
      '<div class="card"><h2 class="section-title">' + esc(t('users.listTitle')) + '</h2>' +
      '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
      '<th>' + esc(t('users.displayName')) + '</th><th>' + esc(t('common.role')) + '</th>' +
      '<th>' + esc(t('users.certLevel')) + '</th>' +
      '<th>' + esc(t('common.country')) + '</th><th>' + esc(t('users.projectScope')) + '</th>' +
      '<th>' + esc(t('common.status')) + '</th><th>' + esc(t('common.actions')) + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    document.getElementById('user-new').onclick = function () { openUserModal(null, users, function () { render(); }); };
    /* v4: save inline scheduling master data (engineer rows). */
    view.querySelectorAll('[data-schedsave]').forEach(function (b) {
      b.onclick = async function () {
        var id = b.getAttribute('data-schedsave');
        var row = view.querySelector('tr[data-engrow="' + id + '"]');
        if (!row) return;
        function fval(f) {
          var el = row.querySelector('[data-f="' + f + '"]');
          return el ? el.value : '';
        }
        var payload = {
          country_code: (fval('country_code') || '').toUpperCase() || null,
          remote_capable: !!row.querySelector('[data-f="remote_capable"]').checked,
          skills: fval('skills').trim() || null,
          regions: Array.prototype.map.call(
            row.querySelectorAll('[data-region]:checked'),
            function (c) { return c.getAttribute('data-region'); })
        };
        b.disabled = true;
        try {
          var r = await sb.from('profiles').update(payload).eq('id', id);
          if (r.error) throw r.error;
          toast(t('users.schedSaved'), 'ok');
        } catch (e) { apiError(e); }
        b.disabled = false;
      };
    });
    view.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function () {
        var u = users.find(function (x) { return x.id === b.getAttribute('data-edit'); });
        openUserModal(u, users, function () { render(); });
      };
    });
    view.querySelectorAll('[data-react]').forEach(function (b) {
      b.onclick = async function () {
        var id = b.getAttribute('data-react');
        try {
          var r = await sb.from('profiles').update({ is_active: true }).eq('id', id);
          if (r.error) throw r.error;
          toast(t('users.reactivated'), 'ok'); render();
        } catch (e) { apiError(e); }
      };
    });
    view.querySelectorAll('[data-deact]').forEach(function (b) {
      b.onclick = function () {
        var u = users.find(function (x) { return x.id === b.getAttribute('data-deact'); });
        openDeactivateModal(u, users, function () { render(); });
      };
    });
  }

  function scopeChecklist(selected) {
    selected = selected || [];
    return '<div class="checklist">' + state.sites.map(function (s) {
      var on = selected.indexOf(s.id) !== -1;
      return '<label><input type="checkbox" class="scope-cb" value="' + s.id + '"' +
        (on ? ' checked' : '') + '> ' + esc(s.code + ' — ' + s.name) + '</label>';
    }).join('') + '</div>' +
    '<div class="hint">' + esc(t('users.projectScopeHint')) + '</div>';
  }

  function openUserModal(user, users, done) {
    var isNew = !user;
    user = user || {};
    var body =
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('users.displayName')) + '<span class="req">*</span></label>' +
          '<input type="text" id="u-name" value="' + esc(user.display_name || '') + '"></div>' +
        '<div class="field"><label>' + esc(t('users.email')) + '<span class="req">*</span></label>' +
          '<input type="email" id="u-email" value="' + esc(user.email || '') + '"' +
          (isNew ? '' : ' disabled') + '></div>' +
      '</div>' +
      (isNew
        ? '<div class="field"><label>' + esc(t('users.tempPassword')) + '<span class="req">*</span></label>' +
          '<input type="password" id="u-pass" autocomplete="new-password">' +
          '<div class="hint">' + esc(t('users.tempPasswordHint')) + '</div></div>'
        : '') +
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('common.role')) + '</label>' +
          '<select id="u-role">' + L.ROLES.map(function (r) {
            return '<option value="' + r + '"' + (user.role === r ? ' selected' : '') + '>' +
              esc(t('role.' + r)) + '</option>';
          }).join('') + '</select></div>' +
        '<div class="field"><label>' + esc(t('common.language')) + '</label>' +
          '<select id="u-lang">' + L.LANGUAGES.map(function (l) {
            return '<option value="' + l + '"' + ((user.language || 'en') === l ? ' selected' : '') + '>' +
              (l === 'en' ? 'English' : '中文') + '</option>';
          }).join('') + '</select></div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('users.phone')) + '</label>' +
          '<input type="tel" id="u-phone" value="' + esc(user.phone || '') + '"></div>' +
        '<div class="field"><label>' + esc(t('users.country')) + '</label>' +
          '<input type="text" id="u-country" maxlength="2" placeholder="' + esc(t('users.countryPh')) +
          '" value="' + esc(user.country || '') + '" style="text-transform:uppercase"></div>' +
      '</div>' +
      '<div class="field"><label>' + esc(t('users.skills')) + '</label>' +
        '<input type="text" id="u-skills" placeholder="' + esc(t('users.skillsPh')) +
        '" value="' + esc(user.skills || '') + '"></div>' +
      '<div class="field"><label>' + esc(t('users.certLevel')) + '</label>' +
        '<select id="u-cert"><option value="">' + esc(t('users.cert.none')) + '</option>' +
        '<option value="associate"' + (user.cert_level === 'associate' ? ' selected' : '') + '>' +
          esc(t('users.cert.associate')) + '</option>' +
        '<option value="professional"' + (user.cert_level === 'professional' ? ' selected' : '') + '>' +
          esc(t('users.cert.professional')) + '</option></select></div>' +
      '<div class="field"><label>' + esc(t('users.projectScope')) + '</label>' +
        scopeChecklist(user.project_scope) + '</div>';
    var close = openModal(isNew ? t('users.new') : t('users.edit'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' +
        esc(isNew ? t('common.create') : t('common.save')) + '</button>', true);
    document.getElementById('m-cancel').onclick = close;
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var scope = Array.prototype.slice.call(document.querySelectorAll('.scope-cb'))
          .filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
        var fields = {
          display_name: document.getElementById('u-name').value.trim(),
          role: document.getElementById('u-role').value,
          language: document.getElementById('u-lang').value,
          phone: document.getElementById('u-phone').value.trim() || null,
          country: (document.getElementById('u-country').value.trim() || null),
          skills: document.getElementById('u-skills').value.trim() || null,
          cert_level: document.getElementById('u-cert').value || null,
          project_scope: scope
        };
        if (fields.country) fields.country = fields.country.toUpperCase();
        if (!fields.display_name) { toast(t('new.fillRequired'), 'error'); btn.disabled = false; return; }
        if (isNew) await createUserFlow(fields, users);
        else {
          var r = await sb.from('profiles').update(fields).eq('id', user.id);
          if (r.error) throw r.error;
          toast(t('users.updated'), 'ok');
        }
        close(); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  /**
   * createUserFlow — the anon key cannot call the Auth admin API, so a new
   * login must be created via signUp (which fires the handle_new_user
   * trigger to create the profile row).
   * - If email confirmation is ON, the admin session survives: patch the new
   *   profile (incl. role) directly.
   * - If confirmation is OFF, signUp signs in as the new user: patch only
   *   self-updatable fields, sign out, and tell the admin to sign back in
   *   and set the role via Edit. Non-admins cannot set their own role
   *   (contract §2 WITH CHECK), so the role step is never skipped silently.
   */
  async function createUserFlow(fields, users) {
    var email = document.getElementById('u-email').value.trim();
    var password = document.getElementById('u-pass').value;
    if (!email || !password || password.length < 6) throw new Error(t('new.fillRequired'));
    var adminId = state.profile.id;
    var su = await sb.auth.signUp({
      email: email, password: password,
      options: { data: { display_name: fields.display_name } }
    });
    if (su.error) throw su.error;
    var newUser = su.data.user;
    var sessionNow = await sb.auth.getSession();
    var stillAdmin = sessionNow.data.session &&
                     sessionNow.data.session.user.id === adminId;
    if (stillAdmin) {
      // Email confirmation is on: profile row exists via trigger, admin patches all fields.
      var r = await sb.from('profiles').update(fields).eq('id', newUser.id);
      if (r.error) throw r.error;
      toast(t('users.created', { email: email }), 'ok');
    } else {
      // Signed in as the new user: patch non-role fields only (role change
      // would be rejected by RLS for non-admins — contract §2).
      var selfFields = {
        display_name: fields.display_name, language: fields.language,
        phone: fields.phone, country: fields.country, skills: fields.skills,
        project_scope: fields.project_scope
      };
      var r2 = await sb.from('profiles').update(selfFields).eq('id', newUser.id);
      if (r2.error) throw r2.error;
      await sb.auth.signOut();
      state.user = null; state.profile = null;
      toast(t('users.created', { email: email }) + ' ' + t('users.createdRoleNote'), 'ok');
      toast(t('users.createdSignBackIn'), 'error');
      setTimeout(function () { nav('#/login'); }, 1200);
    }
  }

  function openDeactivateModal(user, users, done) {
    // GUARD 1: cannot deactivate self (old-demo P0 bug).
    if (user.id === state.profile.id) { toast(t('users.cannotDeactivateSelf'), 'error'); return; }
    // GUARD 2: cannot deactivate the last active admin.
    var activeAdmins = users.filter(function (u) { return u.is_active && u.role === 'admin'; });
    if (user.role === 'admin' && activeAdmins.length <= 1) {
      toast(t('users.cannotDeactivateLastAdmin'), 'error'); return;
    }
    // GUARD 3: open assigned tickets must be reassigned first (old-demo P0 bug).
    sb.from('tickets').select('id,ticket_no,title')
      .eq('assigned_to', user.id).not('status', 'in', '(resolved,closed)')
      .then(function (res) {
        if (res.error) { apiError(res.error); return; }
        var open = res.data || [];
        var body =
          '<p>' + esc(t('users.deactivateConfirm', { name: user.display_name || user.email })) + '</p>';
        var foot;
        if (!open.length) {
          foot = '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
            '<button class="btn btn-danger" id="m-deact">' + esc(t('users.deactivate')) + '</button>';
        } else {
          body += '<div class="inline-err">' +
            esc(t('users.hasOpenTickets', { name: user.display_name || user.email, n: open.length })) + '</div>' +
            '<ul style="padding-left:18px">' + open.map(function (x) {
              return '<li>' + esc(L.formatTicketNo(x.ticket_no) + ' — ' + x.title) + '</li>';
            }).join('') + '</ul>' +
            '<div class="field"><label>' + esc(t('users.reassignAllTo')) + '</label>' +
            '<select id="reassign-to"><option value="">' + esc(t('users.pickEngineer')) + '</option></select></div>';
          foot = '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
            '<button class="btn btn-danger" id="m-deact">' + esc(t('users.reassignAndDeactivate')) + '</button>';
        }
        var close = openModal(t('users.deactivateTitle'), body, foot);
        document.getElementById('m-cancel').onclick = close;
        if (open.length) {
          // Engineer picker for reassignment.
          sb.from('profiles').select('id,display_name,email')
            .eq('is_active', true).neq('id', user.id).order('display_name')
            .then(function (er) {
              if (!er.error) {
                document.getElementById('reassign-to').innerHTML =
                  '<option value="">' + esc(t('users.pickEngineer')) + '</option>' +
                  (er.data || []).map(function (e) {
                    return '<option value="' + e.id + '">' + esc((e.display_name || e.email) +
                      ' (' + t('role.' + (users.find(function (u) { return u.id === e.id; }) || {}).role || '') + ')') +
                      '</option>';
                  }).join('');
              }
            });
        }
        document.getElementById('m-deact').onclick = async function () {
          var btn = this; btn.disabled = true;
          try {
            if (open.length) {
              var to = document.getElementById('reassign-to').value;
              if (!to) { toast(t('users.pickEngineer'), 'error'); btn.disabled = false; return; }
              var rr = await sb.from('tickets').update({ assigned_to: to })
                .eq('assigned_to', user.id).not('status', 'in', '(resolved,closed)');
              if (rr.error) throw rr.error;
            }
            var dr = await sb.from('profiles').update({ is_active: false }).eq('id', user.id);
            if (dr.error) throw dr.error;
            close(); toast(t('users.deactivated'), 'ok'); done();
          } catch (e) { apiError(e); btn.disabled = false; }
        };
      });
  }

  /* ------------------------------- sites -------------------------------- */
  /** contractBadgeFor(contract) — active green / expiring ≤30d amber / none grey. */
  function daysUntil(dateStr) {
    if (!dateStr) return null;
    return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
  }
  function contractBadgeFor(contract) {
    if (!contract || !L.isContractActive(contract)) {
      return badge('contract-none', t('sites.contract.none'));
    }
    var days = daysUntil(contract.valid_to);
    if (days != null && days <= 30) {
      return badge('contract-expiring', t('sites.contract.expiring') +
        (days >= 0 ? ' · ' + t('sites.expiringIn', { n: days }) : ''));
    }
    return badge('contract-active', t('sites.contract.active'));
  }

  /** certBadge(level) — Associate/Professional pill. */
  function certBadge(level) {
    if (level === 'associate') return badge('cert-associate', t('plan.cert.associate'));
    if (level === 'professional') return badge('cert-professional', t('plan.cert.professional'));
    return '<span class="muted">—</span>';
  }

  async function viewSites(view) {
    var q = (state.siteSearch || '').trim().toLowerCase();
    var children = {};
    state.sites.forEach(function (s) {
      var k = s.parent_site_id || '__root';
      (children[k] = children[k] || []).push(s);
    });
    Object.keys(children).forEach(function (k) {
      children[k].sort(function (a, b) { return a.code < b.code ? -1 : 1; });
    });
    // Open (non-terminal) ticket counts per site, role-aware like the list.
    var counts = {};
    try {
      var cr = await baseTicketQuery('site_id').not('status', 'in', '(resolved,closed)');
      (cr.data || []).forEach(function (r) {
        if (r.site_id) counts[r.site_id] = (counts[r.site_id] || 0) + 1;
      });
    } catch (e) {}
    await resolveNames(state.sites.map(function (s) { return s.remote_owner_id; }));

    function nodeHtml(s, depth) {
      var contract = (state.contracts || {})[s.id];
      return '<div class="tree-node clickable" data-site="' + s.id + '"' +
        ' style="padding-left:' + (12 + depth * 26) + 'px">' +
        '<span class="tcode">' + esc(s.code) + '</span>' +
        '<span class="tname">' + esc(s.name) + '</span>' +
        '<span class="grow"></span>' +
        contractBadgeFor(contract) +
        '<span class="badge status-open">' + (counts[s.id] || 0) + ' ' + esc(t('sites.openTickets')) + '</span>' +
        '<span class="muted" style="font-size:12px">' + esc(displayName(s.remote_owner_id)) + '</span>' +
      '</div>';
    }
    var bodyHtml;
    if (q) {
      var hits = state.sites.filter(function (s) {
        return ((s.code || '') + ' ' + (s.name || '')).toLowerCase().indexOf(q) !== -1;
      });
      bodyHtml = hits.map(function (s) { return nodeHtml(s, 0); }).join('') ||
        '<div class="empty">' + esc(t('list.noResults')) + '</div>';
    } else {
      var out = [];
      var seenWalk = {};
      (function walk(k, depth) {
        (children[k] || []).forEach(function (s) {
          if (seenWalk[s.id]) return; // corrupted data guard: never loop
          seenWalk[s.id] = true;
          out.push(nodeHtml(s, depth)); walk(s.id, depth + 1);
        });
      })('__root', 0);
      bodyHtml = out.join('') || '<div class="empty">' + esc(t('list.noResults')) + '</div>';
    }
    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('sites.title')) + '</h1>' +
      '<button class="btn btn-primary" id="site-new">+ ' + esc(t('sites.new')) + '</button></div>' +
      '<div class="card"><h2 class="section-title">' + esc(t('sites.tree')) + '</h2>' +
      '<div class="field" style="max-width:360px"><input type="text" id="site-q" placeholder="' +
        esc(t('sites.searchPh')) + '" value="' + esc(state.siteSearch || '') + '"></div>' +
      '<div id="site-tree">' + bodyHtml + '</div></div>' +
      (state.v3 ? '<div class="card" id="customers-card"></div>' : '');
    var deb = null;
    document.getElementById('site-q').oninput = function () {
      var v = this.value;
      clearTimeout(deb);
      deb = setTimeout(function () { state.siteSearch = v; render(); }, 400);
    };
    document.getElementById('site-new').onclick = function () {
      openSiteModal(null, function () { render(); });
    };
    view.querySelectorAll('[data-site]').forEach(function (el) {
      el.onclick = function () { nav('#/site/' + el.getAttribute('data-site')); };
    });
    if (state.v3) renderCustomersCard();
  }

  /* v3 F6: customer company register (admin/dispatcher via site.manage gate). */
  function renderCustomersCard() {
    var card = document.getElementById('customers-card');
    if (!card) return;
    var siteCount = {};
    state.sites.forEach(function (s) {
      if (s.customer_id) siteCount[s.customer_id] = (siteCount[s.customer_id] || 0) + 1;
    });
    card.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
        '<h2 class="section-title" style="margin:0">' + esc(t('customers.title')) + '</h2>' +
        '<button class="btn btn-sm btn-primary" id="cust-new">+ ' + esc(t('customers.new')) + '</button></div>' +
      '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
      '<th>' + esc(t('customers.company')) + '</th><th>' + esc(t('common.country')) + '</th>' +
      '<th>' + esc(t('customers.contact')) + '</th><th>' + esc(t('sites.title')) + '</th>' +
      '<th>' + esc(t('common.actions')) + '</th></tr></thead><tbody>' +
      ((state.customers || []).map(function (c) {
        return '<tr><td><b>' + esc(c.company_name) + '</b></td>' +
          '<td class="muted">' + esc(c.country || '—') + '</td>' +
          '<td class="muted">' + esc(c.contact_name || c.contact_email || '—') + '</td>' +
          '<td>' + (siteCount[c.id] || 0) + '</td>' +
          '<td><button class="btn btn-sm" data-custedit="' + c.id + '">' + esc(t('common.edit')) + '</button></td></tr>';
      }).join('') || '<tr><td colspan="5"><div class="empty">' + esc(t('customers.none')) + '</div></td></tr>') +
      '</tbody></table></div>';
    document.getElementById('cust-new').onclick = function () {
      openCustomerModal(null, function () { loadReferenceData().then(render); });
    };
    card.querySelectorAll('[data-custedit]').forEach(function (b) {
      b.onclick = function () {
        var c = state.customers.filter(function (x) { return x.id === b.getAttribute('data-custedit'); })[0];
        openCustomerModal(c, function () { loadReferenceData().then(render); });
      };
    });
  }
  function openCustomerModal(customer, done) {
    customer = customer || {};
    function fld(id, label, val, ph) {
      return '<div class="field"><label>' + esc(label) + '</label>' +
        '<input type="text" id="' + id + '" value="' + esc(val || '') + '"' +
        (ph ? ' placeholder="' + esc(ph) + '"' : '') + '></div>';
    }
    var body =
      '<div class="field"><label>' + esc(t('customers.company')) + '<span class="req">*</span></label>' +
        '<input type="text" id="cu-name" value="' + esc(customer.company_name || '') + '"></div>' +
      '<div class="form-row">' +
        fld('cu-country', t('common.country'), customer.country) +
        fld('cu-vat', t('customers.vat'), customer.vat_id) +
      '</div>' +
      '<div class="form-row">' +
        fld('cu-contact', t('customers.contactName'), customer.contact_name) +
        fld('cu-email', t('customers.contactEmail'), customer.contact_email) +
      '</div>' +
      '<div class="form-row">' +
        fld('cu-phone', t('customers.contactPhone'), customer.contact_phone) +
        fld('cu-note', t('customers.note'), customer.note) +
      '</div>';
    var close = openModal(customer.id ? t('customers.edit') : t('customers.new'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var name = document.getElementById('cu-name').value.trim();
        if (!name) { toast(t('new.fillRequired'), 'error'); btn.disabled = false; return; }
        var row = {
          company_name: name,
          country: document.getElementById('cu-country').value.trim().toUpperCase() || null,
          vat_id: document.getElementById('cu-vat').value.trim() || null,
          contact_name: document.getElementById('cu-contact').value.trim() || null,
          contact_email: document.getElementById('cu-email').value.trim() || null,
          contact_phone: document.getElementById('cu-phone').value.trim() || null,
          note: document.getElementById('cu-note').value.trim() || null
        };
        var r = customer.id
          ? await sb.from('customers').update(row).eq('id', customer.id)
          : await sb.from('customers').insert(row);
        if (r.error) throw r.error;
        close(); toast(t('common.saved'), 'ok'); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  function openSiteModal(site, done) {
    site = site || {};
    // Cycle guard (UI): a site cannot be parented to itself or any of its
    // descendants — that would silently hide sites from the tree.
    // (DB trigger trg_sites_no_cycle enforces the same server-side.)
    var forbiddenParent = {};
    if (site.id) {
      forbiddenParent[site.id] = true;
      var grew = true;
      while (grew) {
        grew = false;
        state.sites.forEach(function (x) {
          if (x.parent_site_id && forbiddenParent[x.parent_site_id] && !forbiddenParent[x.id]) {
            forbiddenParent[x.id] = true;
            grew = true;
          }
        });
      }
    }
    var body =
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('sites.code')) + '<span class="req">*</span></label>' +
          '<input type="text" id="s-code" placeholder="' + esc(t('sites.codePh')) +
          '" value="' + esc(site.code || '') + '"></div>' +
        '<div class="field"><label>' + esc(t('sites.name')) + '<span class="req">*</span></label>' +
          '<input type="text" id="s-name" value="' + esc(site.name || '') + '"></div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('common.country')) + '</label>' +
          '<input type="text" id="s-country" maxlength="2" value="' + esc(site.country || '') +
          '" style="text-transform:uppercase"></div>' +
        '<div class="field"><label>' + esc(t('common.city')) + '</label>' +
          '<input type="text" id="s-city" value="' + esc(site.city || '') + '"></div>' +
      '</div>' +
      '<div class="field"><label>' + esc(t('sites.address')) + '</label>' +
        '<input type="text" id="s-addr" value="' + esc(site.address || '') + '"></div>' +
      '<div class="field"><label>' + esc(t('sites.parentSite')) + '</label>' +
        '<select id="s-parent"><option value="">' + esc(t('sites.noParent')) + '</option>' +
        state.sites.filter(function (x) { return !forbiddenParent[x.id]; }).map(function (x) {
          return '<option value="' + x.id + '"' + (site.parent_site_id === x.id ? ' selected' : '') + '>' +
            esc(x.code + ' — ' + x.name) + '</option>';
        }).join('') + '</select></div>' +
      '<div class="field"><label>' + esc(t('sites.remoteOwner')) + '</label>' +
        '<select id="s-owner"><option value="">' + esc(t('sites.noOwner')) + '</option></select></div>' +
      (state.v3
        ? '<div class="field"><label>' + esc(t('sites.customer')) + '</label>' +
          '<select id="s-customer"><option value="">' + esc(t('common.none')) + '</option>' +
          state.customers.map(function (c) {
            return '<option value="' + c.id + '"' + (site.customer_id === c.id ? ' selected' : '') + '>' +
              esc(c.company_name) + '</option>';
          }).join('') + '</select></div>'
        : '');
    var close = openModal(site.id ? t('sites.edit') : t('sites.new'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    // Remote-owner picker: any active non-customer user (best effort on RLS).
    sb.from('profiles').select('id,display_name,email,role').eq('is_active', true)
      .order('display_name').then(function (r) {
        var sel = document.getElementById('s-owner');
        if (!sel) return;
        if (!r.error) {
          (r.data || []).forEach(function (u) {
            if (u.role === 'customer') return;
            state.nameCache[u.id] = u.display_name || u.email;
            var o = document.createElement('option');
            o.value = u.id;
            o.textContent = (u.display_name || u.email) + ' (' + t('role.' + u.role) + ')';
            if (site.remote_owner_id === u.id) o.selected = true;
            sel.appendChild(o);
          });
        }
      });
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var code = document.getElementById('s-code').value.trim();
        var name = document.getElementById('s-name').value.trim();
        if (!code || !name) { toast(t('new.fillRequired'), 'error'); btn.disabled = false; return; }
        var fields = {
          code: code,
          name: name,
          country: (document.getElementById('s-country').value.trim() || null),
          city: document.getElementById('s-city').value.trim() || null,
          address: document.getElementById('s-addr').value.trim() || null,
          parent_site_id: document.getElementById('s-parent').value || null,
          remote_owner_id: document.getElementById('s-owner').value || null
        };
        if (state.v3) {
          var custSel = document.getElementById('s-customer');
          fields.customer_id = custSel ? (custSel.value || null) : (site.customer_id || null);
        }
        if (fields.country) fields.country = fields.country.toUpperCase();
        var r = site.id
          ? await sb.from('sites').update(fields).eq('id', site.id)
          : await sb.from('sites').insert(fields);
        if (r.error) throw r.error;
        toast(t('sites.saved'), 'ok');
        await loadReferenceData();
        close(); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  async function deleteSite(site, done) {
    if (!window.confirm(t('sites.deleteConfirm', { code: site.code }))) return;
    try {
      var c = await sb.from('tickets').select('id', { count: 'exact', head: true })
        .eq('site_id', site.id);
      if (!c.error && c.count > 0) {
        toast(t('sites.inUse', { n: c.count }), 'error');
        return;
      }
      var r = await sb.from('sites').delete().eq('id', site.id);
      if (r.error) throw r.error;
      toast(t('sites.deleted'), 'ok');
      await loadReferenceData();
      done();
    } catch (e) { apiError(e); }
  }

  /* ============================ v2: spare parts ============================ */
  /* v3 I3: explicit empty state when the user lacks part.view —
     never a blank page; deep link to #/sites. */
  function viewPartsNoAccess(view) {
    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('nav.parts')) + '</h1></div>' +
      '<div class="card"><div class="empty">' + esc(t('parts.noAccess')) + '</div>' +
      '<div style="margin-top:12px"><button class="btn btn-primary" id="noaccess-sites">' +
        esc(t('parts.noAccessBtn')) + '</button></div></div>';
    document.getElementById('noaccess-sites').onclick = function () { nav('#/sites'); };
  }
  async function viewParts(view) {
    var canManage = L.can('part.manage', state.profile.role);
    var pr = await sb.from('spare_parts').select('*').order('code');
    if (pr.error) {
      view.innerHTML = '<div class="inline-err">' + esc(pr.error.message) + '</div>';
      return;
    }
    var parts = pr.data || [];
    var wr = await sb.from('warehouses').select('*').order('code');
    var warehouses = wr.error ? [] : (wr.data || []);
    if (wr.error) apiError(wr.error);
    var slr = await sb.from('stock_levels').select('*');
    var stock = slr.error ? [] : (slr.data || []);
    if (slr.error) apiError(slr.error);
    var txr = await sb.from('part_transactions').select('*')
      .order('created_at', { ascending: false }).limit(100);
    var txs = txr.error ? [] : (txr.data || []);
    if (txr.error) apiError(txr.error);

    var partMap = {}; parts.forEach(function (p) { partMap[p.id] = p; });
    var whMap = {}; warehouses.forEach(function (w) { whMap[w.id] = w; });
    var siteMap = {}; state.sites.forEach(function (s) { siteMap[s.id] = s; });
    await resolveNames(txs.map(function (x) { return x.actor_id; }));
    var ticketNos = {};
    var tids = [];
    txs.forEach(function (x) { if (x.ticket_id && tids.indexOf(x.ticket_id) === -1) tids.push(x.ticket_id); });
    if (tids.length) {
      try {
        var tr = await sb.from('tickets').select('id,ticket_no').in('id', tids);
        (tr.data || []).forEach(function (x) { ticketNos[x.id] = x.ticket_no; });
      } catch (e) {}
    }

    /* catalog */
    var catRows = parts.map(function (p) {
      return '<tr><td class="tnum">' + esc(p.code) + '</td>' +
        '<td><b>' + esc(p.name) + '</b></td>' +
        '<td class="muted">' + esc(p.category || '—') + '</td>' +
        '<td class="muted">' + esc(p.unit || '—') + '</td>' +
        '<td>' + (canManage
            ? '<button class="btn btn-sm" data-partedit="' + p.id + '">' + esc(t('common.edit')) + '</button> ' +
              '<button class="btn btn-sm btn-danger" data-partdel="' + p.id + '">' + esc(t('common.delete')) + '</button>'
            : '<span class="muted">—</span>') + '</td></tr>';
    }).join('');

    /* warehouse tree + stock */
    var whChildren = {};
    warehouses.forEach(function (w) {
      var k = w.parent_warehouse_id || '__root';
      (whChildren[k] = whChildren[k] || []).push(w);
    });
    function stockRowsFor(whId) {
      return stock.filter(function (s) { return s.warehouse_id === whId; }).map(function (s) {
        var p = partMap[s.part_id] || {};
        var qty = Number(s.qty), min = s.min_qty == null ? null : Number(s.min_qty);
        var low = min != null && qty < min;
        var out = min != null && qty <= 0;
        var cls = low ? (out ? 'low-stock-red' : 'low-stock-amber') : '';
        return '<tr class="' + cls + '"><td></td>' +
          '<td><b>' + esc(p.code || '—') + '</b> ' + esc(p.name || '') + '</td>' +
          '<td class="tnum">' + esc(String(s.qty)) + ' ' + esc(p.unit || '') + '</td>' +
          '<td class="muted">' + esc(min == null ? '—' : String(s.min_qty)) + '</td>' +
          '<td>' + (low ? badge(out ? 'sla-breached' : 'sla-warning',
              t(out ? 'parts.outOfStock' : 'parts.lowStock')) : '<span class="muted">—</span>') + '</td>' +
          '<td></td></tr>';
      }).join('');
    }
    var whHtml = '';
    (function walk(k, depth) {
      (whChildren[k] || []).forEach(function (w) {
        var site = siteMap[w.site_id];
        whHtml += '<tr><td style="padding-left:' + (12 + depth * 26) + 'px"><b>' + esc(w.code) + '</b> — ' +
          esc(w.name) + '<br><span class="muted" style="font-size:12px">' +
          esc(site ? site.code + ' — ' + site.name : t('parts.noSite')) + '</span></td>' +
          '<td></td><td></td><td></td><td></td>' +
          '<td>' + (canManage
            ? '<button class="btn btn-sm" data-whedit="' + w.id + '">' + esc(t('common.edit')) + '</button> ' +
              '<button class="btn btn-sm btn-danger" data-whdel="' + w.id + '">' + esc(t('common.delete')) + '</button>'
            : '<span class="muted">—</span>') + '</td></tr>';
        whHtml += stockRowsFor(w.id);
        walk(w.id, depth + 1);
      });
    })('__root', 0);

    /* ledger */
    var ledgerRows = txs.map(function (x) {
      var p = partMap[x.part_id] || {};
      var w = whMap[x.warehouse_id] || {};
      var isIssue = Number(x.qty_delta) < 0;
      var tno = ticketNos[x.ticket_id];
      return '<tr><td class="muted">' + esc(fmtDate(x.created_at)) + '</td>' +
        '<td>' + badge(isIssue ? 'pri-high' : 'sla-ok',
          t(isIssue ? 'parts.tx.issue' : 'parts.tx.return')) + '</td>' +
        '<td><b>' + esc(p.code || '—') + '</b> ' + esc(p.name || '') + '</td>' +
        '<td class="tnum">' + esc(String(Math.abs(Number(x.qty_delta)))) + ' ' + esc(p.unit || '') + '</td>' +
        '<td class="muted">' + esc(w.code || '—') + '</td>' +
        '<td>' + (tno != null
            ? '<a href="#/ticket/' + x.ticket_id + '">' + esc(L.formatTicketNo(tno)) + '</a>'
            : '<span class="muted">—</span>') + '</td>' +
        '<td class="muted">' + esc(displayName(x.actor_id)) + '</td>' +
        '<td class="muted">' + esc(x.note || '—') + '</td></tr>';
    }).join('');

    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('parts.title')) + '</h1>' +
      (canManage
        ? '<div style="display:flex;gap:8px">' +
          '<button class="btn" id="part-import">⇪ ' + esc(t('parts.import')) + '</button>' +
          '<button class="btn btn-primary" id="part-new">+ ' + esc(t('parts.newPart')) + '</button></div>'
        : '') +
      '</div>' +
      '<div class="card"><h2>' + esc(t('parts.catalog')) + '</h2>' +
        '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
        '<th>' + esc(t('parts.code')) + '</th><th>' + esc(t('parts.name')) + '</th>' +
        '<th>' + esc(t('parts.category')) + '</th><th>' + esc(t('parts.unit')) + '</th>' +
        '<th>' + esc(t('common.actions')) + '</th></tr></thead><tbody>' + catRows + '</tbody></table></div></div>' +
      '<div class="card"><h2>' + esc(t('parts.warehouses')) + '</h2>' +
        '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
        '<th>' + esc(t('parts.warehouse')) + '</th><th>' + esc(t('parts.name')) + '</th>' +
        '<th>' + esc(t('parts.qty')) + '</th><th>' + esc(t('parts.minQty')) + '</th>' +
        '<th>' + esc(t('parts.stock')) + '</th><th>' + esc(t('common.actions')) + '</th>' +
        '</tr></thead><tbody>' + (whHtml || '<tr><td colspan="6"><div class="empty">—</div></td></tr>') +
        '</tbody></table></div></div>' +
      '<div class="card"><h2>' + esc(t('parts.ledger')) + '</h2>' +
        '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
        '<th>' + esc(t('common.createdAt')) + '</th><th>' + esc(t('parts.tx.type')) + '</th>' +
        '<th>' + esc(t('parts.name')) + '</th><th>' + esc(t('parts.qty')) + '</th>' +
        '<th>' + esc(t('parts.warehouse')) + '</th><th>' + esc(t('parts.tx.ticket')) + '</th>' +
        '<th>' + esc(t('parts.tx.actor')) + '</th><th>' + esc(t('parts.tx.note')) + '</th>' +
        '</tr></thead><tbody>' + (ledgerRows || '<tr><td colspan="8"><div class="empty">—</div></td></tr>') +
        '</tbody></table></div></div>';

    if (canManage) {
      document.getElementById('part-new').onclick = function () {
        openPartModal(null, function () { render(); });
      };
      document.getElementById('part-import').onclick = function () {
        openPartsImportModal(warehouses, function () { render(); });
      };
    }
    view.querySelectorAll('[data-partedit]').forEach(function (b) {
      b.onclick = function () {
        var p = parts.find(function (x) { return x.id === b.getAttribute('data-partedit'); });
        openPartModal(p, function () { render(); });
      };
    });
    view.querySelectorAll('[data-partdel]').forEach(function (b) {
      b.onclick = function () {
        var p = parts.find(function (x) { return x.id === b.getAttribute('data-partdel'); });
        deletePart(p, function () { render(); });
      };
    });
    view.querySelectorAll('[data-whedit]').forEach(function (b) {
      b.onclick = function () {
        var w = warehouses.find(function (x) { return x.id === b.getAttribute('data-whedit'); });
        openWarehouseModal(null, w, warehouses, function () { render(); });
      };
    });
    view.querySelectorAll('[data-whdel]').forEach(function (b) {
      b.onclick = function () {
        var w = warehouses.find(function (x) { return x.id === b.getAttribute('data-whdel'); });
        deleteWarehouse(w, function () { render(); });
      };
    });
  }

  function openPartModal(part, done) {
    part = part || {};
    var body =
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('parts.code')) + '<span class="req">*</span></label>' +
          '<input type="text" id="p-code" value="' + esc(part.code || '') + '"></div>' +
        '<div class="field"><label>' + esc(t('parts.name')) + '<span class="req">*</span></label>' +
          '<input type="text" id="p-name" value="' + esc(part.name || '') + '"></div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('parts.category')) + '</label>' +
          '<input type="text" id="p-cat" value="' + esc(part.category || '') + '"></div>' +
        '<div class="field"><label>' + esc(t('parts.unit')) + '</label>' +
          '<input type="text" id="p-unit" value="' + esc(part.unit || '') + '"></div>' +
      '</div>';
    var close = openModal(part.id ? t('parts.editPart') : t('parts.newPart'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var code = document.getElementById('p-code').value.trim();
        var name = document.getElementById('p-name').value.trim();
        if (!code || !name) { toast(t('new.fillRequired'), 'error'); btn.disabled = false; return; }
        var fields = { code: code, name: name,
                       category: document.getElementById('p-cat').value.trim() || null,
                       unit: document.getElementById('p-unit').value.trim() || null };
        var r = part.id
          ? await sb.from('spare_parts').update(fields).eq('id', part.id)
          : await sb.from('spare_parts').insert(fields);
        if (r.error) throw r.error;
        close(); toast(t('parts.saved'), 'ok'); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  async function deletePart(part, done) {
    if (!window.confirm(t('parts.deleteConfirm', { code: part.code }))) return;
    try {
      var r = await sb.from('spare_parts').delete().eq('id', part.id);
      if (r.error) throw r.error;
      toast(t('parts.deleted'), 'ok'); done();
    } catch (e) { apiError(e); }
  }

  async function deletePart(part, done) {
    if (!window.confirm(t('parts.deleteConfirm', { code: part.code }))) return;
    try {
      var r = await sb.from('spare_parts').delete().eq('id', part.id);
      if (r.error) throw r.error;
      toast(t('parts.deleted'), 'ok'); done();
    } catch (e) { apiError(e); }
  }

  /* v3 F1: spare-parts bulk import — paste or upload CSV/TSV ->
     column mapping -> preview -> upsert by part code.
     (Works on v2 tables; does not need migration_v3.) */
  var IMPORT_FIELDS = [
    { key: 'code', req: true }, { key: 'name', req: true },
    { key: 'warehouse_code', req: true }, { key: 'qty', req: true },
    { key: 'category', req: false }, { key: 'unit', req: false }, { key: 'min_qty', req: false }
  ];
  function parseDelimited(text) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
      .filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) return { headers: [], rows: [] };
    var first = lines[0];
    var delim = '\t';
    var counts = [',', ';', '\t'].map(function (d) { return first.split(d).length; });
    if (counts[0] > counts[2] && counts[0] >= counts[1]) delim = ',';
    else if (counts[1] > counts[2] && counts[1] > counts[0]) delim = ';';
    function splitLine(l) {
      var out = [], cur = '', inQ = false;
      for (var i = 0; i < l.length; i++) {
        var c = l[i];
        if (inQ) {
          if (c === '"') {
            if (l[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
          } else cur += c;
        } else if (c === '"') inQ = true;
        else if (c === delim) { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return out.map(function (x) { return x.trim(); });
    }
    var headers = splitLine(lines[0]);
    var rows = lines.slice(1).map(splitLine);
    return { headers: headers, rows: rows };
  }
  function guessMapping(headers) {
    var map = {};
    var norm = headers.map(function (h) { return h.toLowerCase().replace(/[^a-z0-9]/g, ''); });
    IMPORT_FIELDS.forEach(function (f) {
      var keys = {
        code: ['code', 'partcode', 'partno', 'sku', 'itemcode'],
        name: ['name', 'partname', 'description', 'desc', 'itemname'],
        warehouse_code: ['warehousecode', 'warehouse', 'whcode', 'wh', 'location'],
        qty: ['qty', 'quantity', 'stock', 'amount', 'count'],
        category: ['category', 'cat', 'type', 'group'],
        unit: ['unit', 'uom'],
        min_qty: ['minqty', 'min', 'minimum', 'safetystock', 'reorder']
      }[f.key];
      for (var i = 0; i < norm.length; i++) {
        if (keys.indexOf(norm[i]) !== -1) { map[f.key] = headers[i]; break; }
      }
      if (map[f.key] == null) map[f.key] = '';
    });
    return map;
  }
  function openPartsImportModal(warehouses, done) {
    var whByCode = {};
    warehouses.forEach(function (w) { whByCode[(w.code || '').toUpperCase()] = w; });
    var parsed = null, mapping = {};
    var body =
      '<div id="pi-step1">' +
        '<div class="field"><label>' + esc(t('parts.imp.paste')) + '</label>' +
          '<textarea id="pi-text" rows="6" placeholder="' +
            esc(t('parts.imp.pastePh')) + '"></textarea></div>' +
        '<div class="field"><label>' + esc(t('parts.imp.upload')) + '</label>' +
          '<input type="file" id="pi-file" accept=".csv,.tsv,.txt"></div>' +
        '<button class="btn btn-primary" id="pi-parse">' + esc(t('parts.imp.parse')) + '</button>' +
      '</div>' +
      '<div id="pi-step2" style="display:none">' +
        '<div class="field"><label>' + esc(t('parts.imp.mapping')) + '</label>' +
          '<div id="pi-map"></div></div>' +
        '<div class="field"><label>' + esc(t('parts.imp.qtyMode')) + '</label>' +
          '<label style="font-weight:400"><input type="radio" name="pi-mode" value="set" checked style="width:auto"> ' +
            esc(t('parts.imp.modeSet')) + '</label><br>' +
          '<label style="font-weight:400"><input type="radio" name="pi-mode" value="add" style="width:auto"> ' +
            esc(t('parts.imp.modeAdd')) + '</label></div>' +
        '<div style="display:flex;gap:8px">' +
          '<button class="btn" id="pi-back1">← ' + esc(t('common.back')) + '</button>' +
          '<button class="btn btn-primary" id="pi-preview">' + esc(t('parts.imp.preview')) + '</button></div>' +
      '</div>' +
      '<div id="pi-step3" style="display:none">' +
        '<div id="pi-summary" style="margin-bottom:10px"></div>' +
        '<div style="overflow-x:auto;max-height:320px;overflow-y:auto"><table class="tbl"><thead><tr>' +
          '<th>#</th>' + IMPORT_FIELDS.map(function (f) {
            return '<th>' + esc(t('parts.imp.f.' + f.key)) + (f.req ? '<span class="req">*</span>' : '') + '</th>';
          }).join('') + '<th>' + esc(t('parts.imp.status')) + '</th></tr></thead>' +
          '<tbody id="pi-rows"></tbody></table></div>' +
        '<div style="display:flex;gap:8px;margin-top:12px">' +
          '<button class="btn" id="pi-back2">← ' + esc(t('common.back')) + '</button>' +
          '<button class="btn btn-primary" id="pi-run">' + esc(t('parts.imp.run')) + '</button></div>' +
        '<div id="pi-progress" style="margin-top:10px"></div>' +
      '</div>';
    var close = openModal(t('parts.import'), body, '', true);
    function show(step) {
      [1, 2, 3].forEach(function (n) {
        document.getElementById('pi-step' + n).style.display = n === step ? 'block' : 'none';
      });
    }
    function validateRows() {
      var rows = [];
      parsed.rows.forEach(function (cells, idx) {
        var rec = {};
        IMPORT_FIELDS.forEach(function (f) {
          var hi = parsed.headers.indexOf(mapping[f.key]);
          rec[f.key] = hi === -1 ? '' : (cells[hi] || '').trim();
        });
        var errs = [];
        if (!rec.code) errs.push(t('parts.imp.f.code'));
        if (!rec.name) errs.push(t('parts.imp.f.name'));
        if (!rec.warehouse_code) errs.push(t('parts.imp.f.warehouse_code'));
        else if (!whByCode[rec.warehouse_code.toUpperCase()]) errs.push(t('parts.imp.badWh'));
        if (rec.qty === '' || isNaN(Number(rec.qty))) errs.push(t('parts.imp.f.qty'));
        if (rec.min_qty && isNaN(Number(rec.min_qty))) errs.push(t('parts.imp.f.min_qty'));
        rows.push({ rec: rec, errs: errs, line: idx + 2 });
      });
      return rows;
    }
    document.getElementById('pi-file').onchange = function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { document.getElementById('pi-text').value = rd.result; };
      rd.readAsText(f);
    };
    document.getElementById('pi-parse').onclick = function () {
      parsed = parseDelimited(document.getElementById('pi-text').value);
      if (!parsed.headers.length) { toast(t('parts.imp.empty'), 'error'); return; }
      mapping = guessMapping(parsed.headers);
      document.getElementById('pi-map').innerHTML = IMPORT_FIELDS.map(function (f) {
        return '<div class="form-row" style="margin-bottom:6px;align-items:center">' +
          '<div style="width:150px;font-weight:600">' + esc(t('parts.imp.f.' + f.key)) +
            (f.req ? '<span class="req">*</span>' : '') + '</div>' +
          '<select id="pi-map-' + f.key + '" style="flex:1">' +
            '<option value="">' + esc(t('common.none')) + '</option>' +
            parsed.headers.map(function (h) {
              return '<option value="' + esc(h) + '"' +
                (mapping[f.key] === h ? ' selected' : '') + '>' + esc(h) + '</option>';
            }).join('') + '</select></div>';
      }).join('');
      show(2);
    };
    document.getElementById('pi-back1').onclick = function () { show(1); };
    document.getElementById('pi-back2').onclick = function () { show(2); };
    document.getElementById('pi-preview').onclick = function () {
      IMPORT_FIELDS.forEach(function (f) {
        mapping[f.key] = document.getElementById('pi-map-' + f.key).value;
      });
      var missing = IMPORT_FIELDS.filter(function (f) { return f.req && !mapping[f.key]; });
      if (missing.length) {
        toast(t('parts.imp.mapMissing', { f: missing.map(function (x) { return t('parts.imp.f.' + x.key); }).join(', ') }), 'error');
        return;
      }
      var rows = validateRows();
      var ok = rows.filter(function (r) { return !r.errs.length; }).length;
      document.getElementById('pi-summary').innerHTML =
        '<div class="muted">' + esc(t('parts.imp.summary')
          .replace('{ok}', String(ok)).replace('{bad}', String(rows.length - ok))) + '</div>';
      document.getElementById('pi-rows').innerHTML = rows.map(function (r, i) {
        return '<tr class="' + (r.errs.length ? 'low-stock-red' : '') + '"><td class="muted">' + r.line + '</td>' +
          IMPORT_FIELDS.map(function (f) {
            return '<td>' + esc(r.rec[f.key]) + '</td>';
          }).join('') +
          '<td>' + (r.errs.length
            ? '<span class="pill-unassigned">' + esc(r.errs.join(', ')) + '</span>'
            : '<span style="color:var(--ok)">✓</span>') + '</td></tr>';
      }).join('');
      document.getElementById('pi-run').disabled = ok === 0;
      show(3);
    };
    document.getElementById('pi-run').onclick = async function () {
      var btn = this; btn.disabled = true;
      var rows = validateRows().filter(function (r) { return !r.errs.length; });
      var mode = document.querySelector('input[name="pi-mode"]:checked').value;
      var prog = document.getElementById('pi-progress');
      var okN = 0, failN = 0, fails = [];
      for (var i = 0; i < rows.length; i++) {
        var rec = rows[i].rec;
        prog.innerHTML = '<div class="muted">' + esc(t('parts.imp.progress')
          .replace('{i}', String(i + 1)).replace('{n}', String(rows.length))) + '</div>';
        try {
          var up = await sb.from('spare_parts').upsert({
            code: rec.code, name: rec.name,
            category: rec.category || null, unit: rec.unit || null
          }, { onConflict: 'code' }).select('id').single();
          if (up.error) throw up.error;
          var wh = whByCode[rec.warehouse_code.toUpperCase()];
          var cur = await sb.from('stock_levels').select('id,qty')
            .eq('warehouse_id', wh.id).eq('part_id', up.data.id).maybeSingle();
          if (cur.error) throw cur.error;
          var qty = mode === 'add'
            ? Number((cur.data && cur.data.qty) || 0) + Number(rec.qty)
            : Number(rec.qty);
          var srow = { warehouse_id: wh.id, part_id: up.data.id, qty: qty };
          if (rec.min_qty !== '') srow.min_qty = Number(rec.min_qty);
          var su = await sb.from('stock_levels').upsert(srow, { onConflict: 'warehouse_id,part_id' });
          if (su.error) throw su.error;
          await sb.from('part_transactions').insert({
            warehouse_id: wh.id, part_id: up.data.id,
            qty_delta: mode === 'add' ? Number(rec.qty) : (qty - Number((cur.data && cur.data.qty) || 0)),
            actor_id: state.profile.id, note: 'bulk import'
          });
          okN++;
        } catch (e) { failN++; fails.push('L' + rows[i].line + ': ' + (e.message || 'error')); }
      }
      prog.innerHTML = '<div class="' + (failN ? 'inline-err' : 'ok-line') + '">' +
        esc(t('parts.imp.done').replace('{ok}', String(okN)).replace('{bad}', String(failN))) +
        (fails.length ? '<br>' + esc(fails.slice(0, 5).join('; ')) : '') + '</div>';
      if (okN) done();
    };
  }

  function openWarehouseModal(site, warehouse, allWarehouses, done) {
    warehouse = warehouse || {};
    allWarehouses = allWarehouses || [];
    var body =
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('parts.code')) + '<span class="req">*</span></label>' +
          '<input type="text" id="w-code" value="' + esc(warehouse.code || '') + '"></div>' +
        '<div class="field"><label>' + esc(t('parts.name')) + '<span class="req">*</span></label>' +
          '<input type="text" id="w-name" value="' + esc(warehouse.name || '') + '"></div>' +
      '</div>' +
      (site
        ? '<div class="field"><label>' + esc(t('parts.site')) + '</label>' +
          '<input type="text" value="' + esc(site.code + ' — ' + site.name) + '" disabled></div>'
        : '') +
      '<div class="field"><label>' + esc(t('parts.parentWarehouse')) + '</label>' +
        '<select id="w-parent"><option value="">' + esc(t('common.none')) + '</option>' +
        allWarehouses.filter(function (w) { return w.id !== warehouse.id; }).map(function (w) {
          return '<option value="' + w.id + '"' + (warehouse.parent_warehouse_id === w.id ? ' selected' : '') + '>' +
            esc(w.code + ' — ' + w.name) + '</option>';
        }).join('') + '</select></div>';
    var close = openModal(warehouse.id ? t('parts.editWarehouse') : t('parts.newWarehouse'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var code = document.getElementById('w-code').value.trim();
        var name = document.getElementById('w-name').value.trim();
        if (!code || !name) { toast(t('new.fillRequired'), 'error'); btn.disabled = false; return; }
        var fields = { code: code, name: name,
                       parent_warehouse_id: document.getElementById('w-parent').value || null };
        if (site) fields.site_id = site.id;
        var r = warehouse.id
          ? await sb.from('warehouses').update(fields).eq('id', warehouse.id)
          : await sb.from('warehouses').insert(fields);
        if (r.error) throw r.error;
        close(); toast(t('parts.warehouseSaved'), 'ok'); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  async function deleteWarehouse(wh, done) {
    var sCount = 0, cCount = 0;
    try {
      var s = await sb.from('stock_levels').select('warehouse_id', { count: 'exact', head: true })
        .eq('warehouse_id', wh.id);
      if (!s.error) sCount = s.count || 0;
      var c = await sb.from('warehouses').select('id', { count: 'exact', head: true })
        .eq('parent_warehouse_id', wh.id);
      if (!c.error) cCount = c.count || 0;
    } catch (e) {}
    var blocked = sCount > 0 || cCount > 0;
    var body = '<p>' + esc(t('parts.warehouseDeleteConfirm', { code: wh.code })) + '</p>' +
      (blocked ? '<div class="inline-err">' + esc(t('parts.stock') + ': ' + sCount +
        ' · ' + t('parts.warehouses') + ': ' + cCount) + '</div>' : '');
    var close = openModal(t('parts.warehouse') + ' — ' + wh.code, body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      (blocked ? '' : '<button class="btn btn-danger" id="m-del">' + esc(t('common.delete')) + '</button>'));
    document.getElementById('m-cancel').onclick = close;
    var del = document.getElementById('m-del');
    if (del) del.onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var r = await sb.from('warehouses').delete().eq('id', wh.id);
        if (r.error) throw r.error;
        close(); toast(t('parts.warehouseDeleted'), 'ok'); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  /* ------------- ticket detail: spare parts block + issue/return ------------- */
  async function renderPartsBlock(ticket) {
    var el = document.getElementById('parts-block');
    if (!el) return;
    var role = state.profile.role;
    var canIssue = L.can('part.view', role); // everyone except customer
    var canReturn = role === 'engineer' || role === 'dispatcher' || role === 'admin';
    el.innerHTML = '<div class="card"><h2>' + esc(t('detail.parts')) + '</h2>' +
      '<div class="empty">' + esc(t('common.loading')) + '</div></div>';
    var res = await sb.from('part_transactions').select('*')
      .eq('ticket_id', ticket.id).order('created_at', { ascending: false });
    if (res.error) {
      el.innerHTML = '<div class="card"><h2>' + esc(t('detail.parts')) + '</h2>' +
        '<div class="inline-err">' + esc(res.error.message) + '</div></div>';
      return;
    }
    var txs = res.data || [];
    var partMap = {}, whMap = {};
    var pids = [], wids = [];
    txs.forEach(function (x) {
      if (x.part_id && pids.indexOf(x.part_id) === -1) pids.push(x.part_id);
      if (x.warehouse_id && wids.indexOf(x.warehouse_id) === -1) wids.push(x.warehouse_id);
    });
    try {
      if (pids.length) {
        var pr = await sb.from('spare_parts').select('id,code,name,unit').in('id', pids);
        (pr.data || []).forEach(function (p) { partMap[p.id] = p; });
      }
      if (wids.length) {
        var wr = await sb.from('warehouses').select('id,code,name').in('id', wids);
        (wr.data || []).forEach(function (w) { whMap[w.id] = w; });
      }
    } catch (e) {}
    var rows = txs.map(function (x) {
      var p = partMap[x.part_id] || {};
      var w = whMap[x.warehouse_id] || {};
      var isIssue = Number(x.qty_delta) < 0;
      return '<tr><td class="muted">' + esc(fmtDate(x.created_at)) + '</td>' +
        '<td><b>' + esc(p.code || '—') + '</b> ' + esc(p.name || '') + '</td>' +
        '<td>' + badge(isIssue ? 'pri-high' : 'sla-ok',
          t(isIssue ? 'parts.tx.issue' : 'parts.tx.return')) + '</td>' +
        '<td class="tnum">' + esc(String(Math.abs(Number(x.qty_delta)))) + ' ' + esc(p.unit || '') + '</td>' +
        '<td class="muted">' + esc(w.code || '—') + '</td>' +
        '<td class="muted">' + esc(x.note || '—') + '</td>' +
        (canReturn && isIssue
          ? '<td><button class="btn btn-sm" data-return="' + x.id + '">' +
              esc(t('detail.parts.return')) + '</button></td>'
          : '<td></td>') +
      '</tr>';
    }).join('');
    el.innerHTML = '<div class="card"><h2>' + esc(t('detail.parts')) + '</h2>' +
      (txs.length
        ? '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
          '<th>' + esc(t('common.createdAt')) + '</th>' +
          '<th>' + esc(t('parts.name')) + '</th>' +
          '<th>' + esc(t('parts.tx.type')) + '</th>' +
          '<th>' + esc(t('parts.qty')) + '</th>' +
          '<th>' + esc(t('parts.warehouse')) + '</th>' +
          '<th>' + esc(t('parts.tx.note')) + '</th><th></th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty">' + esc(t('detail.parts.none')) + '</div>') +
      (canIssue ? '<div class="form-actions"><button class="btn btn-sm btn-primary" id="issue-part-btn">+ ' +
        esc(t('detail.parts.issue')) + '</button></div>' : '') +
    '</div>';
    if (canIssue) {
      document.getElementById('issue-part-btn').onclick = function () {
        openIssuePartDialog(ticket, function () { render(); });
      };
    }
    el.querySelectorAll('[data-return]').forEach(function (b) {
      b.onclick = async function () {
        if (!window.confirm(t('parts.returnConfirm'))) return;
        try {
          var r = await sb.rpc('return_spare_part', { p_transaction_id: b.getAttribute('data-return') });
          if (r.error) throw r.error;
          toast(t('parts.returned'), 'ok');
          render();
        } catch (e) { apiError(e); }
      };
    });
  }

  async function openIssuePartDialog(ticket, done) {
    var warehouses = [];
    if (ticket.site_id) {
      try {
        var wr = await sb.from('warehouses').select('id,code,name')
          .eq('site_id', ticket.site_id).order('code');
        if (!wr.error) warehouses = wr.data || [];
      } catch (e) {}
    }
    var pr = await sb.from('spare_parts').select('id,code,name,unit').order('code');
    if (pr.error) { apiError(pr.error); return; }
    var parts = pr.data || [];
    var body =
      (warehouses.length
        ? '<div class="field"><label>' + esc(t('parts.warehouse')) + '</label>' +
          '<select id="ip-wh">' + warehouses.map(function (w) {
            return '<option value="' + w.id + '">' + esc(w.code + ' — ' + w.name) + '</option>';
          }).join('') + '</select></div>'
        : '<div class="inline-err">' + esc(t('parts.noWarehouseLinked')) + '</div>') +
      '<div class="field"><label>' + esc(t('detail.parts')) + ' (' + esc(t('parts.name')) +
        ')<span class="req">*</span></label>' +
        '<select id="ip-part"><option value="">' + esc(t('common.select')) + '</option>' +
        parts.map(function (p) {
          return '<option value="' + p.id + '">' + esc(p.code + ' — ' + p.name) +
            (p.unit ? ' (' + esc(p.unit) + ')' : '') + '</option>';
        }).join('') + '</select></div>' +
      '<div class="field"><label>' + esc(t('parts.qty')) + '<span class="req">*</span></label>' +
        '<input type="number" id="ip-qty" min="1" step="1" value="1"></div>';
    var close = openModal(t('parts.issueTitle'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      (warehouses.length
        ? '<button class="btn btn-primary" id="m-save">' + esc(t('parts.issueTitle')) + '</button>'
        : ''));
    document.getElementById('m-cancel').onclick = close;
    var saveBtn = document.getElementById('m-save');
    if (saveBtn) saveBtn.onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var partId = document.getElementById('ip-part').value;
        var qty = Number(document.getElementById('ip-qty').value);
        if (!partId || !(qty > 0)) { toast(t('new.fillRequired'), 'error'); btn.disabled = false; return; }
        var r = await sb.rpc('issue_spare_part', {
          p_ticket_id: ticket.id, p_part_id: partId, p_qty: qty,
          p_warehouse_id: document.getElementById('ip-wh').value || null
        });
        if (r.error) throw r.error;
        close(); toast(t('parts.issued'), 'ok'); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  /* ============================ v2: site detail ============================ */
  var CONTRACT_TICKET_STATUSES = ['open', 'assigned', 'in_progress', 'pending', 'pending_customer'];

  /**
   * recomputeContractTickets(siteId, contract) — contract save: open tickets
   * become is_ltsa + urgent + contract SLA (base created_at; onsite null when
   * disabled). contract null (delete): is_ltsa=false, priority high, SLA from
   * the 'high' policy. resolved_at/closed_at are never touched.
   */
  async function recomputeContractTickets(siteId, contract) {
    try {
      var res = await sb.from('tickets').select('id,created_at')
        .eq('site_id', siteId).in('status', CONTRACT_TICKET_STATUSES);
      if (res.error) throw res.error;
      var list = res.data || [];
      for (var i = 0; i < list.length; i++) {
        var patch;
        if (contract) {
          var ac = L.applyContract(list[i].created_at, contract);
          patch = { is_ltsa: true, priority: 'urgent',
                    sla_response_at: ac.sla_response_at,
                    sla_onsite_at: ac.sla_onsite_at,
                    sla_resolve_at: ac.sla_resolve_at };
        } else {
          var dl = L.computeSlaDeadlines(list[i].created_at, 'high', state.slaPolicies);
          patch = { is_ltsa: false, priority: 'high',
                    sla_response_at: dl.response && dl.response.toISOString(),
                    sla_onsite_at: dl.onsite && dl.onsite.toISOString(),
                    sla_resolve_at: dl.resolve && dl.resolve.toISOString() };
        }
        var up = await sb.from('tickets').update(patch).eq('id', list[i].id);
        if (up.error) throw up.error;
      }
    } catch (e) { apiError(e); }
  }

  async function viewSiteDetail(view, id) {
    var site = state.sites.find(function (s) { return s.id === id; });
    if (!site) {
      view.innerHTML = '<div class="inline-err">' + esc(t('common.error')) + '</div>';
      return;
    }
    var contract = (state.contracts || {})[id] || null;
    var canContract = L.can('contract.manage', state.profile.role);
    var canSite = L.can('site.manage', state.profile.role);
    var canPartManage = L.can('part.manage', state.profile.role);
    var parent = site.parent_site_id && state.sites.find(function (s) { return s.id === site.parent_site_id; });
    var children = state.sites.filter(function (s) { return s.parent_site_id === id; });

    var wr = await sb.from('warehouses').select('*').eq('site_id', id).order('code');
    var warehouses = wr.error ? [] : (wr.data || []);
    if (wr.error) apiError(wr.error);
    var tr = await baseTicketQuery().eq('site_id', id).order('updated_at', { ascending: false }).limit(8);
    var tickets = tr.error ? [] : (tr.data || []);
    if (tr.error) apiError(tr.error);
    /* v3 I4: this site's open tickets (for the contract SLA table). */
    var openTr = await baseTicketQuery().eq('site_id', id).not('status', 'in', '(resolved,closed)')
      .order('updated_at', { ascending: false });
    var openTickets = openTr.error ? [] : (openTr.data || []);
    if (openTr.error) apiError(openTr.error);
    var openCount = 0;
    try {
      var cc = await baseTicketQuery('id', { count: 'exact', head: true })
        .eq('site_id', id).not('status', 'in', '(resolved,closed)');
      if (!cc.error) openCount = cc.count || 0;
    } catch (e) {}
    await resolveNames([site.remote_owner_id].concat(collectIds(tickets)));

    var ident =
      '<div class="card"><h2>' + esc(t('sites.identity')) + '</h2><dl class="kv">' +
      '<dt>' + esc(t('sites.code')) + '</dt><dd><b>' + esc(site.code) + '</b></dd>' +
      '<dt>' + esc(t('sites.name')) + '</dt><dd>' + esc(site.name) + '</dd>' +
      '<dt>' + esc(t('common.country')) + ' / ' + esc(t('common.city')) + '</dt><dd>' +
        esc([site.city, site.country].filter(Boolean).join(', ') || '—') + '</dd>' +
      '<dt>' + esc(t('sites.address')) + '</dt><dd>' + esc(site.address || '—') + '</dd>' +
      '<dt>' + esc(t('sites.parentSite')) + '</dt><dd>' +
        (parent ? '<a href="#/site/' + parent.id + '">' + esc(parent.code + ' — ' + parent.name) + '</a>'
                : esc(t('sites.noParent'))) + '</dd>' +
      '<dt>' + esc(t('sites.remoteOwner')) + '</dt><dd>' + esc(displayName(site.remote_owner_id)) + '</dd>' +
      '</dl>' +
      (canContract
        ? '<div style="margin-top:12px"><div class="field"><label>' + esc(t('sites.setOwner')) + '</label>' +
          '<select id="owner-sel"><option value="">' + esc(t('sites.noOwner')) + '</option></select></div>' +
          '<button class="btn btn-sm btn-primary" id="owner-save">' + esc(t('common.save')) + '</button></div>'
        : '') +
      (canSite ? '<div class="form-actions"><button class="btn btn-sm" id="site-edit">' + esc(t('sites.edit')) +
        '</button>' +
        (L.can('site.delete', state.profile.role)
          ? ' <button class="btn btn-sm btn-danger" id="site-del">' + esc(t('common.delete')) + '</button>' : '') +
        '</div>' : '') +
      '</div>';

    var csum = contract
      ? '<dl class="kv">' +
        '<dt>' + esc(t('contract.status')) + '</dt><dd>' + contractBadgeFor(contract) + '</dd>' +
        '<dt>' + esc(t('contract.phoneEnabled')) + '</dt><dd>' +
          esc(contract.phone_enabled ? t('common.yes') : t('common.no')) + '</dd>' +
        '<dt>' + esc(t('contract.onsiteEnabled')) + '</dt><dd>' +
          esc(contract.onsite_enabled ? t('common.yes') : t('common.no')) + '</dd>' +
        '<dt>' + esc(t('contract.responseHours')) + '</dt><dd>' +
          esc(contract.response_hours == null ? '—' : contract.response_hours) + '</dd>' +
        '<dt>' + esc(t('contract.onsiteHours')) + '</dt><dd>' +
          esc(contract.onsite_hours == null ? '—' : contract.onsite_hours) + '</dd>' +
        '<dt>' + esc(t('contract.resolveHours')) + '</dt><dd>' +
          esc(contract.resolve_hours == null ? '—' : contract.resolve_hours) + '</dd>' +
        '<dt>' + esc(t('contract.availability')) + '</dt><dd>' +
          esc(contract.availability_pct == null ? '—' : contract.availability_pct + '%') + '</dd>' +
        '<dt>' + esc(t('contract.coverage')) + '</dt><dd>' + esc(contract.coverage || '—') + '</dd>' +
        '<dt>' + esc(t('contract.validFrom')) + ' – ' + esc(t('contract.validTo')) + '</dt><dd>' +
          esc(contract.valid_from || '—') + ' – ' + esc(contract.valid_to || '—') + '</dd>' +
        '<dt>' + esc(t('contract.penaltyResponse')) + '</dt><dd>' + esc(contract.penalty_response || '—') + '</dd>' +
        '<dt>' + esc(t('contract.penaltyOnsite')) + '</dt><dd>' + esc(contract.penalty_onsite || '—') + '</dd>' +
        '<dt>' + esc(t('contract.penaltyResolve')) + '</dt><dd>' + esc(contract.penalty_resolve || '—') + '</dd>' +
        '</dl>'
      : '<div class="empty">' + esc(t('sites.contract.none')) + '</div>';
    var ccard =
      '<div class="card"><h2>' + esc(t('sites.contractInfo')) + '</h2>' + csum + contractOpenTicketsTable() +
      (canContract ? '<div class="form-actions">' +
        '<button class="btn btn-sm btn-primary" id="contract-edit">' +
          esc(contract ? t('sites.contractEdit') : t('sites.contractNew')) + '</button>' +
        (contract ? ' <button class="btn btn-sm btn-danger" id="contract-del">' +
          esc(t('sites.contractDelete')) + '</button>' : '') +
        '</div>' : '') +
      '</div>';

    /* v3 I4: this site's open tickets with the 3 SLA clock badges, reusing
       the badge() helper and L.ticketSla() (no v3 migration needed). */
    function slaBadgeCell(clockState) {
      var cls = clockState === 'breached' ? 'sla-breached' :
                clockState === 'warning' ? 'sla-warning' : 'sla-ok';
      var lbl = clockState === 'breached' ? t('detail.sla.breached') :
                clockState === 'warning' ? t('detail.sla.warning') : t('detail.sla.ok');
      return badge(cls, lbl);
    }
    function contractOpenTicketsTable() {
      var rows = openTickets.map(function (x) {
        var sla = L.ticketSla(x);
        return '<tr class="clickable" data-id="' + x.id + '">' +
          '<td class="tnum">' + esc(L.formatTicketNo(x.ticket_no)) + '</td>' +
          '<td>' + esc(x.title) + '</td>' +
          '<td>' + slaBadgeCell(sla.response.state) + '</td>' +
          '<td>' + slaBadgeCell(sla.onsite.state) + '</td>' +
          '<td>' + slaBadgeCell(sla.resolution.state) + '</td></tr>';
      }).join('');
      return '<h3 class="section-title" style="margin-top:14px">' +
        esc(t('sites.contractOpenTickets')) + '</h3>' +
        (rows
          ? '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
            '<th>' + esc(t('list.columns.ticket')) + '</th>' +
            '<th>' + esc(t('list.columns.title')) + '</th>' +
            '<th>' + esc(t('detail.sla.response')) + '</th>' +
            '<th>' + esc(t('detail.sla.onsite')) + '</th>' +
            '<th>' + esc(t('detail.sla.resolution')) + '</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>'
          : '<div class="empty">' + esc(t('sites.contractOpenTickets.none')) + '</div>');
    }

    var whRows = warehouses.map(function (w) {
      var pw = w.parent_warehouse_id && warehouses.find(function (x) { return x.id === w.parent_warehouse_id; });
      return '<div class="tree-node">' +
        '<span class="tcode">' + esc(w.code) + '</span><span class="tname">' + esc(w.name) + '</span>' +
        (pw ? '<span class="muted" style="font-size:12px">← ' + esc(pw.code) + '</span>' : '') +
        '<span class="grow"></span>' +
        (canPartManage ? '<button class="btn btn-sm" data-whedit="' + w.id + '">' + esc(t('common.edit')) + '</button> ' +
          '<button class="btn btn-sm btn-danger" data-whdel="' + w.id + '">' + esc(t('common.delete')) + '</button>' : '') +
      '</div>';
    }).join('');
    var whcard =
      '<div class="card"><h2>' + esc(t('sites.warehouses')) + '</h2>' +
      (whRows || '<div class="empty">—</div>') +
      (canPartManage ? '<div class="form-actions"><button class="btn btn-sm btn-primary" id="wh-new">+ ' +
        esc(t('parts.newWarehouse')) + '</button></div>' : '') +
      '</div>';

    var tcard = '<div class="card"><h2>' + esc(t('sites.recentTickets')) + '</h2>' +
      ticketTable(tickets) + '</div>';
    var chcard = '<div class="card"><h2>' + esc(t('sites.childSites')) + '</h2>' +
      (children.length
        ? children.map(function (c) {
            return '<div class="tree-node clickable" data-child="' + c.id + '"><span class="tcode">' +
              esc(c.code) + '</span><span class="tname">' + esc(c.name) + '</span><span class="grow"></span>' +
              contractBadgeFor((state.contracts || {})[c.id]) + '</div>';
          }).join('')
        : '<div class="empty">—</div>') + '</div>';

    view.innerHTML =
      '<button class="btn btn-sm" id="back-btn" style="margin-bottom:12px">← ' + esc(t('sites.backToSites')) + '</button>' +
      '<div class="detail-head"><span class="tnum">' + esc(site.code) + '</span>' +
        contractBadgeFor(contract) +
        '<span class="badge status-open">' + openCount + ' ' + esc(t('sites.openTickets')) + '</span></div>' +
      '<h1 class="detail-title">' + esc(site.name) + '</h1>' +
      '<div class="grid-2"><div>' + ident + ccard + '</div><div>' + whcard + tcard + chcard + '</div></div>';
    document.getElementById('back-btn').onclick = function () { nav('#/sites'); };
    bindTableNav(view);
    view.querySelectorAll('[data-child]').forEach(function (el) {
      el.onclick = function () { nav('#/site/' + el.getAttribute('data-child')); };
    });

    if (canContract) {
      // Remote-owner picker: active admin/dispatcher/engineer (M5).
      sb.from('profiles').select('id,display_name,email,role').eq('is_active', true)
        .order('display_name').then(function (r) {
          var sel = document.getElementById('owner-sel');
          if (!sel) return;
          if (!r.error) {
            (r.data || []).forEach(function (u) {
              if (['admin', 'dispatcher', 'engineer'].indexOf(u.role) === -1) return;
              state.nameCache[u.id] = u.display_name || u.email;
              var o = document.createElement('option');
              o.value = u.id;
              o.textContent = (u.display_name || u.email) + ' (' + t('role.' + u.role) + ')';
              if (site.remote_owner_id === u.id) o.selected = true;
              sel.appendChild(o);
            });
          }
          document.getElementById('owner-save').onclick = async function () {
            try {
              var up = await sb.from('sites').update({ remote_owner_id: sel.value || null }).eq('id', site.id);
              if (up.error) throw up.error;
              toast(t('sites.ownerSaved'), 'ok');
              await loadReferenceData();
              render();
            } catch (e) { apiError(e); }
          };
        });
      document.getElementById('contract-edit').onclick = function () {
        openContractModal(site, contract, function () { render(); });
      };
      var cdel = document.getElementById('contract-del');
      if (cdel) cdel.onclick = function () { deleteContract(site, function () { render(); }); };
    }
    if (canPartManage) {
      var whNew = document.getElementById('wh-new');
      if (whNew) whNew.onclick = function () {
        openWarehouseModal(site, null, warehouses, function () { render(); });
      };
      view.querySelectorAll('[data-whedit]').forEach(function (b) {
        b.onclick = function () {
          var w = warehouses.find(function (x) { return x.id === b.getAttribute('data-whedit'); });
          openWarehouseModal(site, w, warehouses, function () { render(); });
        };
      });
      view.querySelectorAll('[data-whdel]').forEach(function (b) {
        b.onclick = function () {
          var w = warehouses.find(function (x) { return x.id === b.getAttribute('data-whdel'); });
          deleteWarehouse(w, function () { render(); });
        };
      });
    }
    if (canSite) {
      document.getElementById('site-edit').onclick = function () {
        openSiteModal(site, function () { render(); });
      };
      var sdel = document.getElementById('site-del');
      if (sdel) sdel.onclick = function () { deleteSite(site, function () { nav('#/sites'); }); };
    }
  }

  function openContractModal(site, contract, done) {
    contract = contract || {};
    function num(id, v, label) {
      return '<div class="field"><label>' + esc(label) + '</label>' +
        '<input type="number" id="' + id + '" min="0" step="any" value="' +
        (v == null ? '' : esc(String(v))) + '"></div>';
    }
    function txt(id, v, label, date) {
      return '<div class="field"><label>' + esc(label) + '</label>' +
        '<input type="' + (date ? 'date' : 'text') + '" id="' + id + '" value="' + esc(v || '') + '"></div>';
    }
    var body =
      '<div class="form-row">' +
        '<div class="field"><label><input type="checkbox" id="c-phone"' +
          (contract.phone_enabled ? ' checked' : '') + ' style="width:auto;margin-right:6px">' +
          esc(t('contract.phoneEnabled')) + '</label></div>' +
        '<div class="field"><label><input type="checkbox" id="c-onsite"' +
          (contract.onsite_enabled ? ' checked' : '') + ' style="width:auto;margin-right:6px">' +
          esc(t('contract.onsiteEnabled')) + '</label></div>' +
      '</div>' +
      '<div class="form-row">' +
        num('c-resp', contract.response_hours, t('contract.responseHours')) +
        num('c-onsite-h', contract.onsite_hours, t('contract.onsiteHours')) +
      '</div>' +
      '<div class="form-row">' +
        num('c-resolve', contract.resolve_hours, t('contract.resolveHours')) +
        num('c-avail', contract.availability_pct, t('contract.availability')) +
      '</div>' +
      '<div class="form-row">' +
        txt('c-from', contract.valid_from, t('contract.validFrom'), true) +
        txt('c-to', contract.valid_to, t('contract.validTo'), true) +
      '</div>' +
      txt('c-coverage', contract.coverage, t('contract.coverage')) +
      txt('c-pen-r', contract.penalty_response, t('contract.penaltyResponse')) +
      txt('c-pen-o', contract.penalty_onsite, t('contract.penaltyOnsite')) +
      txt('c-pen-s', contract.penalty_resolve, t('contract.penaltyResolve'));
    var close = openModal(t('sites.contractInfo') + ' — ' + site.code, body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>', true);
    document.getElementById('m-cancel').onclick = close;
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        function nv(id) {
          var v = document.getElementById(id).value.trim();
          return v === '' ? null : Number(v);
        }
        function tv(id) {
          var v = document.getElementById(id).value.trim();
          return v || null;
        }
        var row = {
          site_id: site.id,
          phone_enabled: document.getElementById('c-phone').checked,
          onsite_enabled: document.getElementById('c-onsite').checked,
          response_hours: nv('c-resp'),
          onsite_hours: nv('c-onsite-h'),
          resolve_hours: nv('c-resolve'),
          penalty_response: tv('c-pen-r'),
          penalty_onsite: tv('c-pen-o'),
          penalty_resolve: tv('c-pen-s'),
          availability_pct: nv('c-avail'),
          coverage: tv('c-coverage'),
          valid_from: tv('c-from'),
          valid_to: tv('c-to')
        };
        var r = await sb.from('ltsa_contracts').upsert(row, { onConflict: 'site_id' });
        if (r.error) throw r.error;
        var re = await sb.from('ltsa_contracts').select('*').eq('site_id', site.id).single();
        var saved = re.error ? row : re.data;
        state.contracts[site.id] = saved;
        await recomputeContractTickets(site.id, saved);
        close(); toast(t('sites.contractSaved'), 'ok'); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  async function deleteContract(site, done) {
    if (!window.confirm(t('sites.contractDeleteConfirm', { site: site.code }))) return;
    try {
      var r = await sb.from('ltsa_contracts').delete().eq('site_id', site.id);
      if (r.error) throw r.error;
      delete state.contracts[site.id];
      await recomputeContractTickets(site.id, null);
      toast(t('sites.contractDeleted'), 'ok'); done();
    } catch (e) { apiError(e); }
  }

  /* ====================== v2: planning & calendar ====================== */
  var planUi = { weeks: 2, offset: 0, q: '', cert: '' };
  var calUi = { y: null, m: null };
  /* v4: prefill stashed by the planning workbench ("create field ticket");
     consumed once by viewNewTicket on creation. */
  var newTicketPrefill = null;

  function ymd(d) {
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function mondayOf(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }

  /* v4: "today band" — 4 KPI cards above the planning grid, aligned to the
     demo's Today band: remote-available (& remote_capable) / in-field /
     absent-or-holiday / on-duty, each listing names. */
  async function planTodayBand(engineers, todayKey) {
    var tShifts = {};
    try {
      var tr = await sb.from('shifts').select('*').eq('day', todayKey);
      (tr.error ? [] : (tr.data || [])).forEach(function (s) { tShifts[s.engineer_id] = s; });
    } catch (e) {}
    var holMap = {};
    if (state.v3) {
      try {
        var hr = await sb.from('holidays').select('country_code,name').eq('day', todayKey);
        (hr.error ? [] : (hr.data || [])).forEach(function (h) {
          holMap[(h.country_code || '').toUpperCase()] = h.name;
        });
      } catch (e) {}
    }
    var tNos = {};
    var tTids = [];
    Object.keys(tShifts).forEach(function (k) {
      var tid = tShifts[k].ticket_id;
      if (tid && tTids.indexOf(tid) === -1) tTids.push(tid);
    });
    if (tTids.length) {
      try {
        var nr = await sb.from('tickets').select('id,ticket_no').in('id', tTids);
        (nr.error ? [] : (nr.data || [])).forEach(function (x) { tNos[x.id] = x.ticket_no; });
      } catch (e) {}
    }
    var groups = { remote: [], field: [], absent: [], duty: [] };
    var ABSENT_KEYS = ['ferie', 'malattia', 'formazione', 'trasferta', 'festivo'];
    engineers.forEach(function (e) {
      var sh = tShifts[e.id];
      var stKey = L.resolveDayState({
        shiftStatus: sh && sh.status,
        dayPart: sh && sh.day_part,
        hasFieldTicket: !!(sh && (sh.status === 'field' || sh.ticket_id || sh.site_id)),
        holidayName: state.v3 ? (holMap[((e.country_code || e.country) || '').toUpperCase()] || null) : null,
        dateStr: todayKey
      });
      var nm = e.display_name || e.email;
      if (stKey === 'remoto' && e.remote_capable !== false) groups.remote.push(nm);
      else if (stKey === 'campo') {
        groups.field.push({ name: nm, id: sh && sh.ticket_id,
                            no: sh && sh.ticket_id ? tNos[sh.ticket_id] : null });
      } else if (ABSENT_KEYS.indexOf(stKey) !== -1) {
        groups.absent.push(nm + ' (' + statusLabel(stKey) + ')');
      }
      if (state.v3 && sh && sh.duty_type && dutyKeyValid(sh.duty_type)) {
        groups.duty.push({ name: nm, duty: sh.duty_type });
      }
    });
    function card(label, color, items, itemHtml) {
      return '<div class="card today-card"><div class="micro-label">' + esc(label) + '</div>' +
        '<div class="tc-num" style="color:' + color + '">' + items.length + '</div>' +
        '<div class="tc-names">' +
          (items.length ? items.map(itemHtml).join('<br>') : esc(t('plan.today.none'))) +
        '</div></div>';
    }
    return '<div class="today-band">' +
      card(t('plan.today.remote'), '#15803d', groups.remote, function (n) { return esc(n); }) +
      card(t('plan.today.field'), '#b91c1c', groups.field, function (f) {
        return esc(f.name) + (f.no
          ? ' → <a class="tnum" href="#/ticket/' + f.id + '">' + esc(L.formatTicketNo(f.no)) + '</a>' : '');
      }) +
      card(t('plan.today.absent'), '#92400e', groups.absent, function (n) { return esc(n); }) +
      card(t('plan.today.duty'), '#1d4ed8', groups.duty, function (x) {
        var d = dutyDef(x.duty);
        return '<span class="duty-ic" style="color:' + d.text_color + '">' +
          icon(d.icon || 'phone', 11) + '</span>' + esc(x.name);
      }) +
    '</div>';
  }

  /* v4: planning legend — auto-rendered from the loaded definitions, so a
     newly added status/duty shows up with zero code change. */
  function planningLegend() {
    return '<div class="plan-legend"><span class="micro-label">' + esc(t('plan.wb.legend')) + '</span>' +
      statusDefs().map(function (d) {
        return '<span class="legend-item"><span class="legend-sw" style="background:' +
          d.bg_color + '"></span>' + esc(statusLabel(d.key)) + '</span>';
      }).join('') + '<span class="legend-sep">|</span>' +
      dutyDefs().map(function (d) {
        return '<span class="legend-item"><span class="legend-sw" style="background:' +
          d.bg_color + '"></span>' + esc(dutyLabel(d.key)) + '</span>';
      }).join('') + '</div>';
  }

  async function viewPlanning(view) {
    var canWrite = L.can('plan.manage', state.profile.role);
    var er = await sb.from('profiles').select('*').eq('role', 'engineer').eq('is_active', true)
      .order('display_name');
    if (er.error) {
      view.innerHTML = '<div class="inline-err">' + esc(er.error.message) + '</div>';
      return;
    }
    var engineers = er.data || [];
    var start = mondayOf(new Date());
    start.setDate(start.getDate() + planUi.offset * 7 * planUi.weeks);
    var nDays = planUi.weeks * 7;
    var days = [];
    for (var i = 0; i < nDays; i++) { var d = new Date(start); d.setDate(d.getDate() + i); days.push(d); }
    var from = ymd(days[0]), to = ymd(days[nDays - 1]);
    var sr = await sb.from('shifts').select('*').gte('day', from).lte('day', to);
    if (sr.error) apiError(sr.error);
    var shiftMap = {};
    (sr.error ? [] : (sr.data || [])).forEach(function (s) {
      shiftMap[s.engineer_id + '|' + s.day] = s;
    });
    // v3 F5: holidays for the visible range (matched per engineer by country).
    var holidayMap = {};
    if (state.v3) {
      try {
        var hr = await sb.from('holidays').select('country_code,day,name')
          .gte('day', from).lte('day', to);
        (hr.error ? [] : (hr.data || [])).forEach(function (h) {
          holidayMap[(h.country_code || '').toUpperCase() + '|' + h.day] = h.name;
        });
      } catch (e) {}
    }
    // v3 I2: ticket numbers for shifts that carry a ticket_id.
    var shiftTicketNos = {};
    if (state.v3) {
      var sTids = [];
      Object.keys(shiftMap).forEach(function (k) {
        var tid = shiftMap[k].ticket_id;
        if (tid && sTids.indexOf(tid) === -1) sTids.push(tid);
      });
      if (sTids.length) {
        try {
          var tr2 = await sb.from('tickets').select('id,ticket_no').in('id', sTids);
          (tr2.error ? [] : (tr2.data || [])).forEach(function (x) {
            shiftTicketNos[x.id] = x.ticket_no;
          });
        } catch (e) {}
      }
    }
    /* v4: ticket onsite ranges also mark field days (demo precedence #1).
       Booking always writes shift rows too; this covers ranges set directly
       on the ticket (e.g. before the booking flow existed). */
    var fieldTicketMap = {}, fieldTicketId = {};
    try {
      var oqr = await baseTicketQuery('id,ticket_no,assigned_to,onsite_from,onsite_to')
        .not('onsite_from', 'is', null).not('onsite_to', 'is', null)
        .lte('onsite_from', to).gte('onsite_to', from)
        .not('status', 'in', '(resolved,closed,pending_customer)').limit(500);
      (oqr.error ? [] : (oqr.data || [])).forEach(function (x) {
        if (!x.assigned_to) return;
        eachDay(x.onsite_from, x.onsite_to).forEach(function (dd) {
          if (dd >= from && dd <= to) {
            fieldTicketMap[x.assigned_to + '|' + dd] = x.ticket_no;
            fieldTicketId[x.assigned_to + '|' + dd] = x.id;
          }
        });
      });
    } catch (e) {}

    var q = planUi.q.trim().toLowerCase();
    var list = engineers.filter(function (e) {
      if (q && ((e.display_name || '') + ' ' + (e.email || '')).toLowerCase().indexOf(q) === -1) return false;
      if (planUi.cert && (e.cert_level || '') !== planUi.cert) return false;
      return true;
    });
    list.forEach(function (e) { state.nameCache[e.id] = e.display_name || e.email; });

    var cols = '200px repeat(' + nDays + ', minmax(70px, 1fr))';
    var loc = lang === 'zh' ? 'zh-CN' : 'en-GB';
    var todayKey = ymd(new Date());
    var headCells = days.map(function (d) {
      /* v4: today's column header — blue tint (was red). */
      var isToday = ymd(d) === todayKey;
      return '<div class="plan-cell plan-head' + (isToday ? ' plan-today' : '') + '">' +
        esc(d.toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'numeric' })) + '</div>';
    }).join('');
    var rowsHtml = list.map(function (e) {
      var cc = ((e.country_code || e.country) || '').toUpperCase();
      var cellStrs = days.map(function (d) {
        var key = ymd(d);
        var sh = shiftMap[e.id + '|' + key];
        var holName = state.v3 ? (holidayMap[cc + '|' + key] || null) : null;
        var ftKey = e.id + '|' + key;
        var ftNo = fieldTicketMap[ftKey] || null;
        /* v4: day-state resolution (pure logic, table-driven display). */
        var stKey = L.resolveDayState({
          shiftStatus: sh && sh.status,
          dayPart: sh && sh.day_part,
          hasFieldTicket: !!(sh && (sh.status === 'field' || sh.ticket_id || sh.site_id)) || !!ftNo,
          holidayName: holName,
          dateStr: key
        });
        var def = statusDef(stKey);
        var dp = sh && sh.day_part;
        var inner = '<div><b>' + esc(statusLabel(stKey)) + '</b></div>';
        if (dp && dp !== 'full' && stKey !== 'campo' && stKey !== 'remoto') {
          inner += '<div class="muted" style="font-size:10px">' + esc(dayPartLabel(dp)) + '</div>';
        }
        if (holName) {
          inner += '<div class="cal-hol" title="' + esc(holName) + '">' + icon('star', 11) +
            '<span>' + esc(holName.length > 16 ? holName.slice(0, 15) + '…' : holName) + '</span></div>';
        }
        if (stKey === 'campo' && sh && sh.site_id) {
          inner += '<div class="muted">' + esc(siteShort(sh.site_id)) + '</div>';
        } else if (sh && sh.note) {
          inner += '<div class="muted note-ic" title="' + esc(sh.note) + '">' + icon('pencil', 11) + '</div>';
        }
        // v3 I2: ticket number — shift-linked ticket first, then onsite-range ticket.
        var tNo = (state.v3 && sh && sh.ticket_id && shiftTicketNos[sh.ticket_id]) || ftNo || null;
        var tId = (state.v3 && sh && sh.ticket_id) || fieldTicketId[ftKey] || null;
        if (tNo) {
          inner += '<div>' + (tId
            ? '<a href="#/ticket/' + tId + '" class="tnum" style="font-size:11px">' +
              esc(L.formatTicketNo(tNo)) + '</a>'
            : '<span class="tnum" style="font-size:11px">' + esc(L.formatTicketNo(tNo)) + '</span>') + '</div>';
        }
        // v3 F4: duty-type badge, colors from the duty definitions.
        if (state.v3 && sh && sh.duty_type && dutyKeyValid(sh.duty_type)) {
          inner += '<div>' + dutyBadgeHtml(sh.duty_type) + '</div>';
        }
        var isToday = key === todayKey;
        var cellCls = 'plan-cell cell-' + stKey + (canWrite ? ' clickable' : '') +
          (isToday ? ' plan-today' : '');
        /* Merge key for the visual run-merge: same resolved state + day-part,
           and no extra markers (holiday/ticket/note/duty) that would make
           the cells visually different. */
        var hasExtras = !!(holName || tNo || (sh && sh.note) || (sh && sh.duty_type));
        var mergeKey = stKey + '|' + (dp || 'full') + '|' + (hasExtras ? 'x' : '');
        return {
          html: '<div class="' + cellCls + '" data-eng="' + e.id + '" data-day="' + key + '"' +
            ' style="background:' + def.bg_color + ';color:' + def.text_color + '">' + inner + '</div>',
          mergeKey: mergeKey
        };
      });
      /* v4: render consecutive same-state days as a merged visual span.
         NOTE — data stays one row per engineer+day (UNIQUE engineer_id+day);
         only the grid hides the dividers. Safer than merging DB rows. */
      for (var ci = 1; ci < cellStrs.length; ci++) {
        if (cellStrs[ci].mergeKey === cellStrs[ci - 1].mergeKey) {
          cellStrs[ci - 1].html = cellStrs[ci - 1].html
            .replace('class="plan-cell ', 'class="plan-cell run-prev ');
        }
      }
      var cells = cellStrs.map(function (c) { return c.html; }).join('');
      var noRemote = state.v4 && e.remote_capable === false
        ? ' <span class="muted" style="font-size:10px">· ' + esc(t('assign.noRemoteCapable')) + '</span>' : '';
      return '<div class="plan-row" style="grid-template-columns:' + cols + '">' +
        '<div class="plan-cell plan-eng"><span>' + esc(e.display_name || e.email) + noRemote + '</span>' +
        '<span>' + certBadge(e.cert_level) + '</span></div>' + cells + '</div>';
    }).join('');

    var bandHtml = await planTodayBand(engineers, todayKey);

    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('plan.title')) + '</h1></div>' +
      bandHtml +
      '<div class="card"><div class="filters">' +
        '<div class="f search"><label>' + esc(t('common.search')) + '</label>' +
          '<input type="text" id="plan-q" placeholder="' + esc(t('plan.searchPh')) +
          '" value="' + esc(planUi.q) + '"></div>' +
        '<div class="f"><label>' + esc(t('users.certLevel')) + '</label>' +
          '<select id="plan-cert"><option value="">' + esc(t('plan.allCerts')) + '</option>' +
          '<option value="associate"' + (planUi.cert === 'associate' ? ' selected' : '') + '>' +
            esc(t('plan.cert.associate')) + '</option>' +
          '<option value="professional"' + (planUi.cert === 'professional' ? ' selected' : '') + '>' +
            esc(t('plan.cert.professional')) + '</option></select></div>' +
        '<div class="f"><label>&nbsp;</label><div style="display:flex;gap:6px;align-items:center">' +
          [1, 2, 4].map(function (w) {
            return '<button class="btn btn-sm' + (planUi.weeks === w ? ' btn-primary' : '') + '" data-weeks="' + w + '">' +
              esc(t('plan.weeks' + w)) + '</button>';
          }).join('') +
          '<button class="btn btn-sm" id="plan-prev">‹</button>' +
          '<button class="btn btn-sm" id="plan-next">›</button>' +
        '</div></div>' +
      '</div>' +
      '<div class="hint" style="margin-bottom:12px">' + esc(t('plan.wb.tip')) + '</div>' +
      '<div class="plan-grid">' +
        '<div class="plan-row" style="grid-template-columns:' + cols + '">' +
          '<div class="plan-cell plan-head">' + esc(t('plan.engineer')) + '</div>' + headCells +
        '</div>' +
        (rowsHtml || '<div class="empty">' + esc(t('list.noResults')) + '</div>') +
      '</div>' + planningLegend() + '</div>';

    view.querySelectorAll('[data-weeks]').forEach(function (b) {
      b.onclick = function () { planUi.weeks = Number(b.getAttribute('data-weeks')); render(); };
    });
    document.getElementById('plan-prev').onclick = function () { planUi.offset--; render(); };
    document.getElementById('plan-next').onclick = function () { planUi.offset++; render(); };
    var deb = null;
    document.getElementById('plan-q').oninput = function () {
      var v = this.value;
      clearTimeout(deb);
      deb = setTimeout(function () { planUi.q = v; render(); }, 400);
    };
    document.getElementById('plan-cert').onchange = function () { planUi.cert = this.value; render(); };
    if (canWrite) {
      view.querySelectorAll('.plan-cell[data-eng]').forEach(function (el) {
        el.onclick = function () {
          var eng = engineers.find(function (x) { return x.id === el.getAttribute('data-eng'); });
          var day = el.getAttribute('data-day');
          openShiftModal(eng, day, shiftMap[eng.id + '|' + day] || null, function () { render(); });
        };
      });
    }
  }

  /* v4: cell workbench dispatcher — full workbench on a v4 backend,
     legacy status modal on older backends (their DB CHECK rejects the
     new status values). */
  function openShiftModal(engineer, day, existing, done) {
    if (!state.v4) { openShiftModalLegacy(engineer, day, existing, done); return; }
    openShiftWorkbench(engineer, day, existing || {}, done);
  }

  /* v4: day workbench — restore-remote / field / absence entry with
     day-parts / duty toggle / covered sites / open-ticket picker. */
  function openShiftWorkbench(engineer, day, existing, done) {
    var ABSENCE_STATUSES = ['vacation', 'sick', 'training', 'travel'];
    var initAbsence = ABSENCE_STATUSES.indexOf(existing.status) !== -1 ? existing.status
      : (existing.status === 'leave' ? 'vacation' : 'vacation');
    var initMode = (existing.status === 'field' || existing.status === 'assigned') ? 'field'
      : ((ABSENCE_STATUSES.indexOf(existing.status) !== -1 || existing.status === 'leave')
          ? 'absence' : 'remote');
    var sel = {
      mode: initMode,                 // 'remote' | 'field' | 'absence'
      absence: initAbsence,            // DB status value for absence mode
      dayPart: existing.day_part || 'full',
      duty: existing.duty_type || null,
      siteId: existing.site_id || null,     // preserved across panel re-renders
      ticketId: existing.ticket_id || null  // preserved across panel re-renders
    };
    var covSites = existing.covered_site_ids || [];
    var loc = lang === 'zh' ? 'zh-CN' : 'en-GB';
    var dayLabel = new Date(day + 'T12:00:00')
      .toLocaleDateString(loc, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    var curKey = L.resolveDayState({
      shiftStatus: existing.status,
      hasFieldTicket: !!(existing.status === 'field' || existing.ticket_id || existing.site_id),
      dateStr: day
    });

    function stateBtn(mode, absence, label, swBg, swFg) {
      var active = sel.mode === mode && (mode !== 'absence' || sel.absence === absence);
      return '<button type="button" class="wb-btn' + (active ? ' active' : '') + '"' +
        ' data-mode="' + mode + '"' + (absence ? ' data-absence="' + absence + '"' : '') +
        (active ? ' style="color:' + swFg + ';border-color:' + swFg + '"' : '') + '>' +
        '<span class="wb-sw" style="background:' + swBg + '"></span>' + esc(label) + '</button>';
    }
    function stateButtons() {
      var rem = statusDef('remoto'), fld = statusDef('campo');
      var h = stateBtn('remote', null, t('plan.wb.remote'), rem.bg_color, rem.text_color) +
              stateBtn('field', null, t('plan.wb.field'), fld.bg_color, fld.text_color);
      h += ABSENCE_STATUSES.map(function (s) {
        var d = statusDef(absenceDefKey(s));
        return stateBtn('absence', s, t('plan.wb.absence.' + s), d.bg_color, d.text_color);
      }).join('');
      return h;
    }
    function dutyButtons() {
      return dutyDefs().map(function (d) {
        var active = sel.duty === d.key;
        return '<button type="button" class="wb-btn' + (active ? ' active' : '') + '" data-duty="' + d.key + '"' +
          (active ? ' style="color:' + d.text_color + ';border-color:' + d.text_color +
            ';background:' + d.bg_color + '"' : '') + '>' +
          icon(d.icon || 'phone', 13) + esc(dutyLabel(d.key)) + '</button>';
      }).join('');
    }
    function panelHtml() {
      if (sel.mode === 'remote') {
        return '<div class="hint">' + esc(t('plan.wb.restoreHint')) + '</div>' +
          '<div style="margin-top:10px"><button type="button" class="btn btn-danger" id="wb-restore">' +
          esc(t('plan.wb.restore')) + '</button></div>';
      }
      if (sel.mode === 'field') {
        return '<div class="hint" style="margin-bottom:10px">' + esc(t('plan.wb.fieldHint')) + '</div>' +
          '<div class="field"><label>' + esc(t('plan.site')) + '</label>' +
          '<select id="wb-site"><option value="">' + esc(t('common.none')) + '</option>' +
          state.sites.map(function (s) {
            return '<option value="' + s.id + '"' + (sel.siteId === s.id ? ' selected' : '') + '>' +
              esc(s.code + ' — ' + s.name) + '</option>';
          }).join('') + '</select></div>' +
          (state.v3
            ? '<div class="field"><label>' + esc(t('plan.assignTicket')) + '</label>' +
              '<select id="wb-ticket"><option value="">' + esc(t('common.none')) + '</option></select>' +
              '<div class="hint">' + esc(t('plan.assignTicketHint')) + '</div></div>'
            : '') +
          '<div><button type="button" class="btn btn-sm" id="wb-newticket">' +
          esc(t('plan.wb.createFieldTicket')) + '</button> ' +
          '<span class="hint">' + esc(t('plan.wb.createFieldTicketHint')) + '</span></div>';
      }
      /* absence mode: type comes from the buttons above; day-part selector
         is shown for absence statuses only. */
      var d = statusDef(absenceDefKey(sel.absence));
      return '<div class="field"><label>' + esc(t('plan.dayPartLabel')) + '</label>' +
        '<div class="daypart-radios">' +
        ['full', 'am', 'pm'].map(function (p) {
          return '<label><input type="radio" name="wb-dp" value="' + p + '"' +
            (sel.dayPart === p ? ' checked' : '') + '> ' + esc(dayPartLabel(p)) + '</label>';
        }).join('') + '</div></div>' +
        '<div class="hint">' + esc(statusLabel(absenceDefKey(sel.absence))) + '</div>';
    }

    var body =
      '<div class="wb-sec"><div class="wb-cur"><b>' + esc(engineer.display_name || engineer.email) + '</b> ' +
        certBadge(engineer.cert_level) + '<span class="muted">' + esc(dayLabel) + '</span> ' +
        statusBadge(curKey) + '</div></div>' +
      '<div class="wb-sec"><div class="micro-label" style="margin-bottom:8px">' +
        esc(t('plan.wb.dayState')) + '</div><div class="wb-btns" id="wb-states">' + stateButtons() + '</div></div>' +
      '<div class="wb-sec" id="wb-panel">' + panelHtml() + '</div>' +
      '<div class="wb-sec"><div class="micro-label" style="margin-bottom:8px">' +
        esc(t('plan.wb.dutyToday')) + '</div><div class="wb-btns" id="wb-duties">' + dutyButtons() + '</div>' +
        '<div class="hint" style="margin-top:6px">' + esc(t('plan.wb.dutyOff')) + '</div></div>' +
      (state.v3
        ? '<div class="wb-sec"><div class="micro-label" style="margin-bottom:8px">' +
          esc(t('plan.coveredSites')) + '</div>' +
          '<div class="check-list">' + state.sites.map(function (s) {
            return '<label><input type="checkbox" data-cov="' + s.id + '"' +
              (covSites.indexOf(s.id) !== -1 ? ' checked' : '') + ' style="width:auto"> ' +
              esc(s.code) + '</label>';
          }).join('') + '</div></div>'
        : '') +
      '<div class="wb-sec"><div class="field" style="margin-bottom:0"><label>' + esc(t('plan.note')) + '</label>' +
        '<input type="text" id="wb-note" value="' + esc(existing.note || '') + '"></div></div>';

    var close = openModal(t('plan.wb.title'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>', true);
    document.getElementById('m-cancel').onclick = close;

    /* Selection state that must survive panel re-renders (initialized above). */
    function updateSaveBtn() {
      document.getElementById('m-save').style.display = sel.mode === 'remote' ? 'none' : '';
    }
    /* Capture the field panel's live picks before it is re-rendered. */
    function capturePanel() {
      var s = document.getElementById('wb-site');
      if (s) sel.siteId = s.value || null;
      var tk = document.getElementById('wb-ticket');
      if (tk) sel.ticketId = tk.value || null;
    }
    function renderStates() {
      document.getElementById('wb-states').innerHTML = stateButtons();
      document.querySelectorAll('#wb-states .wb-btn').forEach(function (b) {
        b.onclick = function () {
          capturePanel();
          sel.mode = b.getAttribute('data-mode');
          if (b.getAttribute('data-absence')) sel.absence = b.getAttribute('data-absence');
          renderStates(); renderPanel(); updateSaveBtn();
        };
      });
    }
    function renderDuties() {
      /* Duty toggle re-renders ONLY the duty buttons — the field panel
         (site/ticket picks) is left untouched. */
      document.getElementById('wb-duties').innerHTML = dutyButtons();
      document.querySelectorAll('#wb-duties .wb-btn').forEach(function (b) {
        b.onclick = function () {
          var k = b.getAttribute('data-duty');
          sel.duty = (sel.duty === k) ? null : k;   // toggle on/off for the day
          renderDuties();
        };
      });
    }
    function renderPanel() {
      document.getElementById('wb-panel').innerHTML = panelHtml();
      var dpRadios = document.querySelectorAll('input[name="wb-dp"]');
      Array.prototype.forEach.call(dpRadios, function (r) {
        r.onchange = function () { sel.dayPart = r.value; };
      });
      var siteSel = document.getElementById('wb-site');
      if (siteSel) {
        siteSel.value = sel.siteId || '';
        siteSel.onchange = function () { sel.siteId = siteSel.value || null; };
      }
      var rb = document.getElementById('wb-restore');
      if (rb) rb.onclick = async function () {
        if (!existing.id) { close(); done(); return; }
        try {
          var r = await sb.from('shifts').delete().eq('id', existing.id);
          if (r.error) throw r.error;
          close(); toast(t('plan.cleared'), 'ok'); done();
        } catch (e) { apiError(e); }
      };
      var nt = document.getElementById('wb-newticket');
      if (nt) nt.onclick = function () {
        capturePanel();
        newTicketPrefill = {
          engineerId: engineer.id,
          engineerName: engineer.display_name || engineer.email,
          day: day,
          siteId: sel.siteId
        };
        close(); nav('#/new');
      };
      loadOpenTickets();
    }
    /* v3 I1: open-ticket picker (unassigned, not terminal). The shift's
       current ticket is included even though it's now assigned. */
    function loadOpenTickets() {
      var selEl = document.getElementById('wb-ticket');
      if (!selEl) return;
      var curTid = sel.ticketId || null;
      baseTicketQuery('id,ticket_no,title,site_id,assigned_to')
        .is('assigned_to', null)
        .not('status', 'in', '(resolved,closed,pending_customer)')
        .order('created_at', { ascending: true }).limit(100)
        .then(function (r) {
          if (r.error || !document.getElementById('wb-ticket')) return;
          var list = r.data || [];
          function renderOpts(extra) {
            var s = document.getElementById('wb-ticket');
            if (!s) return;
            var all = (extra ? [extra] : []).concat(list.filter(function (x) {
              return !extra || x.id !== extra.id;
            }));
            s.innerHTML = '<option value="">' + esc(t('common.none')) + '</option>' +
              all.map(function (x) {
                return '<option value="' + x.id + '"' +
                  (curTid === x.id ? ' selected' : '') +
                  ' data-site="' + (x.site_id || '') + '">' +
                  esc(L.formatTicketNo(x.ticket_no) + ' — ' + x.title) + '</option>';
              }).join('');
            s.onchange = function () {
              sel.ticketId = s.value || null;
              var o = s.options[s.selectedIndex];
              var siteId = o && o.getAttribute('data-site');
              var siteSel = document.getElementById('wb-site');
              if (siteId && siteSel) { siteSel.value = siteId; sel.siteId = siteId; }
            };
          }
          if (curTid) {
            sb.from('tickets').select('id,ticket_no,title,site_id').eq('id', curTid).single()
              .then(function (cr) { renderOpts(cr.error ? null : cr.data); });
          } else renderOpts(null);
        });
    }
    renderStates(); renderDuties(); renderPanel(); updateSaveBtn();

    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      capturePanel();
      try {
        var ticketId = sel.mode === 'field' ? sel.ticketId : null;
        var row = {
          engineer_id: engineer.id,
          day: day,
          status: sel.mode === 'absence' ? sel.absence : (ticketId ? 'assigned' : 'field'),
          day_part: sel.mode === 'absence' ? sel.dayPart : 'full',
          site_id: sel.mode === 'field' ? sel.siteId : null,
          note: document.getElementById('wb-note').value.trim() || null,
          /* App-side validation: duty_type is free text in the DB now;
             only values from the loaded definitions are written. */
          duty_type: dutyKeyValid(sel.duty) ? sel.duty : null,
          covered_site_ids: state.v3 ? Array.prototype.map.call(
            document.querySelectorAll('[data-cov]:checked'), function (c) {
              return c.getAttribute('data-cov');
            }) : [],
          ticket_id: ticketId
        };
        var r = await sb.from('shifts').upsert(row, { onConflict: 'engineer_id,day' });
        if (r.error) throw r.error;
        // v3 I1: assigning a ticket from planning sets the ticket's owner
        // and stamps that day as the field-visit date.
        if (ticketId) {
          var tr = await sb.from('tickets').update({
            assigned_to: engineer.id,
            onsite_from: day,
            onsite_to: day
          }).eq('id', ticketId);
          if (tr.error) throw tr.error;
        }
        close(); toast(t('plan.saved'), 'ok'); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  /* v3 legacy cell modal (statuses available/assigned/leave only) — used on
     backends without migration_v4, whose DB CHECK rejects the new values. */
  function openShiftModalLegacy(engineer, day, existing, done) {
    existing = existing || {};
    var dutyTypes = ['remote_call', 'phone_oncall', 'field_oncall'];
    var covSites = existing.covered_site_ids || [];
    var body =
      '<div class="field"><label>' + esc(t('plan.engineer')) + '</label>' +
        '<div><b>' + esc(engineer.display_name || engineer.email) + '</b> ' + certBadge(engineer.cert_level) +
        '<div class="muted">' + esc(day) + '</div></div></div>' +
      '<div class="field"><label>' + esc(t('plan.statusLabel')) + '</label>' +
        '<select id="sh-status">' +
        ['available', 'assigned', 'leave'].map(function (s) {
          return '<option value="' + s + '"' + (existing.status === s ? ' selected' : '') + '>' +
            esc(t('plan.' + s)) + '</option>';
        }).join('') + '</select></div>' +
      '<div class="field" id="sh-site-wrap"><label>' + esc(t('plan.site')) + '</label>' +
        '<select id="sh-site"><option value="">' + esc(t('common.none')) + '</option>' +
        state.sites.map(function (s) {
          return '<option value="' + s.id + '"' + (existing.site_id === s.id ? ' selected' : '') + '>' +
            esc(s.code + ' — ' + s.name) + '</option>';
        }).join('') + '</select></div>' +
      /* v3 I1: assign an open ticket from the planning cell */
      (state.v3
        ? '<div class="field" id="sh-ticket-wrap"><label>' + esc(t('plan.assignTicket')) + '</label>' +
          '<select id="sh-ticket"><option value="">' + esc(t('common.none')) + '</option></select>' +
          '<div class="hint">' + esc(t('plan.assignTicketHint')) + '</div></div>'
        : '') +
      /* v3 F4: duty type + covered sites */
      (state.v3
        ? '<div class="field"><label>' + esc(t('plan.dutyType')) + '</label>' +
          '<select id="sh-duty"><option value="">' + esc(t('common.none')) + '</option>' +
          dutyTypes.map(function (d) {
            return '<option value="' + d + '"' + (existing.duty_type === d ? ' selected' : '') + '>' +
              esc(t('plan.duty.' + d)) + '</option>';
          }).join('') + '</select></div>' +
          '<div class="field"><label>' + esc(t('plan.coveredSites')) + '</label>' +
            '<div class="check-list">' + state.sites.map(function (s) {
              return '<label><input type="checkbox" data-cov="' + s.id + '"' +
                (covSites.indexOf(s.id) !== -1 ? ' checked' : '') + ' style="width:auto"> ' +
                esc(s.code) + '</label>';
            }).join('') + '</div></div>'
        : '') +
      '<div class="field"><label>' + esc(t('plan.note')) + '</label>' +
        '<input type="text" id="sh-note" value="' + esc(existing.note || '') + '"></div>';
    var close = openModal(t('plan.setStatus'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      (existing.id ? '<button class="btn btn-danger" id="m-clear">' + esc(t('plan.clear')) + '</button>' : '') +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    function toggleSite() {
      var assigned = document.getElementById('sh-status').value === 'assigned';
      document.getElementById('sh-site-wrap').style.display = assigned ? 'block' : 'none';
      var tw = document.getElementById('sh-ticket-wrap');
      if (tw) tw.style.display = assigned ? 'block' : 'none';
    }
    document.getElementById('sh-status').onchange = toggleSite;
    toggleSite();
    // v3 I1: open-ticket picker (unassigned, not terminal).
    // The shift's current ticket is included even though it's now assigned.
    (function loadOpenTickets() {
      var sel = document.getElementById('sh-ticket');
      if (!sel) return;
      var curTid = existing.ticket_id || null;
      baseTicketQuery('id,ticket_no,title,site_id,assigned_to')
        .is('assigned_to', null)
        .not('status', 'in', '(resolved,closed,pending_customer)')
        .order('created_at', { ascending: true }).limit(100)
        .then(function (r) {
          if (r.error || !document.getElementById('sh-ticket')) return;
          var list = r.data || [];
          function renderOpts(extra) {
            var s = document.getElementById('sh-ticket');
            if (!s) return;
            var all = (extra ? [extra] : []).concat(list.filter(function (x) {
              return !extra || x.id !== extra.id;
            }));
            s.innerHTML = '<option value="">' + esc(t('common.none')) + '</option>' +
              all.map(function (x) {
                return '<option value="' + x.id + '"' +
                  (curTid === x.id ? ' selected' : '') +
                  ' data-site="' + (x.site_id || '') + '">' +
                  esc(L.formatTicketNo(x.ticket_no) + ' — ' + x.title) + '</option>';
              }).join('');
            s.onchange = function () {
              var o = s.options[s.selectedIndex];
              var siteId = o && o.getAttribute('data-site');
              var siteSel = document.getElementById('sh-site');
              if (siteId && siteSel) siteSel.value = siteId;
            };
          }
          if (curTid) {
            sb.from('tickets').select('id,ticket_no,title,site_id').eq('id', curTid).single()
              .then(function (cr) { renderOpts(cr.error ? null : cr.data); });
          } else renderOpts(null);
        });
    })();
    var clearBtn = document.getElementById('m-clear');
    if (clearBtn) clearBtn.onclick = async function () {
      try {
        var r = await sb.from('shifts').delete().eq('id', existing.id);
        if (r.error) throw r.error;
        close(); toast(t('plan.cleared'), 'ok'); done();
      } catch (e) { apiError(e); }
    };
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var status = document.getElementById('sh-status').value;
        var ticketSel = document.getElementById('sh-ticket');
        var ticketId = status === 'assigned' && ticketSel ? (ticketSel.value || null) : null;
        var row = {
          engineer_id: engineer.id,
          day: day,
          status: status,
          site_id: status === 'assigned' ? (document.getElementById('sh-site').value || null) : null,
          note: document.getElementById('sh-note').value.trim() || null
        };
        if (state.v3) {
          var dutySel = document.getElementById('sh-duty');
          row.duty_type = dutySel ? (dutySel.value || null) : null;
          row.covered_site_ids = Array.prototype.map.call(
            document.querySelectorAll('[data-cov]:checked'), function (c) {
              return c.getAttribute('data-cov');
            });
          row.ticket_id = ticketId;
        }
        var r = await sb.from('shifts').upsert(row, { onConflict: 'engineer_id,day' });
        if (r.error) throw r.error;
        // v3 I1: assigning a ticket from planning sets the ticket's owner
        // and stamps that day as the field-visit date.
        if (state.v3 && ticketId) {
          var tr = await sb.from('tickets').update({
            assigned_to: engineer.id,
            onsite_from: day,
            onsite_to: day
          }).eq('id', ticketId);
          if (tr.error) throw tr.error;
        }
        close(); toast(t('plan.saved'), 'ok'); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  async function viewCalendar(view) {
    var now = new Date();
    if (calUi.y == null) { calUi.y = now.getFullYear(); calUi.m = now.getMonth(); }
    var first = new Date(calUi.y, calUi.m, 1);
    var gridStart = mondayOf(first);
    var days = [];
    for (var i = 0; i < 42; i++) { var d = new Date(gridStart); d.setDate(d.getDate() + i); days.push(d); }
    var from = ymd(days[0]);
    var endPlus = new Date(days[41]); endPlus.setDate(endPlus.getDate() + 1);
    var sr = await sb.from('shifts').select('*').gte('day', from).lt('day', ymd(endPlus));
    var shifts = sr.error ? [] : (sr.data || []);
    if (sr.error) apiError(sr.error);
    var engIds = [];
    shifts.forEach(function (s) { if (engIds.indexOf(s.engineer_id) === -1) engIds.push(s.engineer_id); });
    await resolveNames(engIds);
    /* v4: engineer countries for per-engineer holiday resolution in the
       calendar chips (same resolveDayState + colors as planning). */
    var engCountry = {};
    if (state.v3 && engIds.length) {
      try {
        var pr = await sb.from('profiles').select('id,country_code,country').in('id', engIds);
        (pr.error ? [] : (pr.data || [])).forEach(function (p) {
          engCountry[p.id] = ((p.country_code || p.country) || '').toUpperCase();
        });
      } catch (e) {}
    }
    var calHolMap = {};
    if (state.v3) {
      try {
        var chr = await sb.from('holidays').select('country_code,day,name')
          .gte('day', from).lt('day', ymd(endPlus));
        (chr.error ? [] : (chr.data || [])).forEach(function (h) {
          calHolMap[(h.country_code || '').toUpperCase() + '|' + h.day] = h.name;
        });
      } catch (e) {}
    }
    var t0 = new Date(from + 'T00:00:00');
    var tr = await baseTicketQuery('id,ticket_no,title,planned_check_at,is_ltsa')
      .not('planned_check_at', 'is', null)
      .gte('planned_check_at', t0.toISOString())
      .lt('planned_check_at', endPlus.toISOString()).limit(500);
    var ctickets = tr.error ? [] : (tr.data || []);
    if (tr.error) apiError(tr.error);
    var byDay = {};
    shifts.forEach(function (s) {
      var b = (byDay[s.day] = byDay[s.day] || { shifts: [], tickets: [] });
      b.shifts.push(s);
    });
    ctickets.forEach(function (x) {
      var k = ymd(new Date(x.planned_check_at));
      var b = (byDay[k] = byDay[k] || { shifts: [], tickets: [] });
      b.tickets.push(x);
    });
    var loc = lang === 'zh' ? 'zh-CN' : 'en-GB';
    var title = first.toLocaleDateString(loc, { year: 'numeric', month: 'long' });
    var dows = [];
    for (var w = 0; w < 7; w++) {
      var dd = new Date(gridStart); dd.setDate(dd.getDate() + w);
      dows.push('<div class="cal-dow">' +
        esc(dd.toLocaleDateString(loc, { weekday: 'short' })) + '</div>');
    }
    var todayK = ymd(new Date());
    var cells = days.map(function (d) {
      var k = ymd(d);
      var b = byDay[k] || { shifts: [], tickets: [] };
      /* v4: calendar chips use the same resolveDayState + definition colors
         as the planning grid (per-engineer holiday by their own country). */
      var chips = b.shifts.map(function (s) {
        var hol = state.v3 ? (calHolMap[(engCountry[s.engineer_id] || '') + '|' + k] || null) : null;
        var stKey = L.resolveDayState({
          shiftStatus: s.status,
          dayPart: s.day_part,
          hasFieldTicket: !!(s.status === 'field' || s.ticket_id || s.site_id),
          holidayName: hol,
          dateStr: k
        });
        var cd = statusDef(stKey);
        return '<span class="cal-chip shift-' + stKey + '"' +
          ' style="background:' + cd.bg_color + ';color:' + cd.text_color + '" title="' +
          esc(displayName(s.engineer_id)) + ' — ' + esc(statusLabel(stKey)) +
          (hol ? ' · ' + esc(hol) : '') + '">' +
          esc(displayName(s.engineer_id)) + ' · ' + esc(statusLabel(stKey)) + '</span>';
      }).join('');
      var tchips = b.tickets.map(function (x) {
        return '<span class="cal-chip ticket' + (x.is_ltsa ? ' is-ltsa' : '') + '" data-id="' + x.id +
          '" title="' + esc(x.title || '') + '">' + esc(L.formatTicketNo(x.ticket_no)) + ' ' +
          esc((x.title || '').slice(0, 18)) + '</span>';
      }).join('');
      var cls = 'cal-day' + (d.getMonth() !== calUi.m ? ' other' : '') + (k === todayK ? ' today' : '');
      return '<div class="' + cls + '"><div class="cal-num">' + d.getDate() + '</div>' +
        chips + tchips + '</div>';
    }).join('');
    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('cal.title')) + '</h1>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<button class="btn btn-sm" id="cal-prev">‹</button>' +
        '<b>' + esc(title) + '</b>' +
        '<button class="btn btn-sm" id="cal-next">›</button>' +
        '<button class="btn btn-sm" id="cal-today">' + esc(t('cal.today')) + '</button>' +
      '</div></div>' +
      '<div class="card"><div class="cal-grid">' + dows.join('') + cells + '</div></div>';
    document.getElementById('cal-prev').onclick = function () {
      calUi.m--; if (calUi.m < 0) { calUi.m = 11; calUi.y--; } render();
    };
    document.getElementById('cal-next').onclick = function () {
      calUi.m++; if (calUi.m > 11) { calUi.m = 0; calUi.y++; } render();
    };
    document.getElementById('cal-today').onclick = function () {
      calUi.y = null; calUi.m = null; render();
    };
    view.querySelectorAll('.cal-chip.ticket').forEach(function (el) {
      el.onclick = function () { nav('#/ticket/' + el.getAttribute('data-id')); };
    });
  }

  /* -------------------------------- boot -------------------------------- */
  async function boot() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    if (KEY_MISSING || CDN_MISSING) { render(); return; }
    // Password-recovery landing: Supabase redirects here with #type=recovery.
    var isRecovery = window.location.hash.indexOf('type=recovery') !== -1;
    sb.auth.onAuthStateChange(function (event) {
      if (event === 'SIGNED_OUT' && state.profile) {
        state.user = null; state.profile = null; state.nameCache = {};
        nav('#/login');
      }
    });
    try {
      var s = await sb.auth.getSession();
      if (s.data && s.data.session && s.data.session.user) {
        if (isRecovery) { viewSetPassword(); return; }
        await afterSignIn(s.data.session.user);
        return; // afterSignIn navigates to dashboard
      }
    } catch (e) { /* fall through to login */ }
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
