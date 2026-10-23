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
    listFilters: { status: '', tracker: '', priority: '', source: '', site: '', assignee: '', q: '', tag: '', customer: '',
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
    /* v7.15: customers cannot SELECT profiles (RLS), so the lookup above
       returns nothing for them and names render as raw id fragments.
       Fall back to the directory_names() RPC (display names only). */
    var still = ids.filter(function (id) { return id && !state.nameCache[id]; });
    if (!still.length) return;
    try {
      var rr = await sb.rpc('directory_names');
      if (!rr.error && rr.data) {
        rr.data.forEach(function (p) {
          if (!state.nameCache[p.id]) {
            state.nameCache[p.id] = p.display_name || p.id.slice(0, 8) + '…';
          }
        });
      }
    } catch (e) { /* non-fatal */ }
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
    // v6: feature probe — contacts exists only after migration_v6.
    state.v6 = false; state.contacts = []; state.contactProjects = [];
    try {
      var v6p = await sb.from('contacts').select('id', { count: 'exact', head: true });
      state.v6 = !v6p.error;
    } catch (e) { state.v6 = false; }
    if (state.v6) {
      try {
        var cor = await sb.from('contacts').select('*').order('first_name').order('last_name');
        if (!cor.error) state.contacts = cor.data || [];
        var cpr = await sb.from('contact_projects').select('*');
        if (!cpr.error) state.contactProjects = cpr.data || [];
        var lcc = await sb.from('ltsa_contract_contacts').select('*');
        state.contractContacts = {};
        (lcc.data || []).forEach(function (r) {
          if (!state.contractContacts[r.contract_id]) state.contractContacts[r.contract_id] = [];
          state.contractContacts[r.contract_id].push(r.contact_id);
        });
      } catch (e) { /* contacts stay empty */ }
    }
    // v7: feature probe — custom_fields exists only after migration_v7.
    state.v7 = false; state.customFields = []; state.wfStates = []; state.wfTrans = {};
    try {
      var v7p = await sb.from('custom_fields').select('id', { count: 'exact', head: true });
      state.v7 = !v7p.error;
    } catch (e) { state.v7 = false; }
    if (state.v7) {
      try {
        var cfr = await sb.from('custom_fields').select('*').order('sort');
        if (!cfr.error) state.customFields = (cfr.data || []).filter(function (f) { return f.is_active !== false; });
        var wsr = await sb.from('workflow_states').select('*').order('workflow_key').order('sort');
        if (!wsr.error) state.wfStates = wsr.data || [];
        var wtr = await sb.from('workflow_transitions').select('*');
        if (!wtr.error) {
          (wtr.data || []).forEach(function (r) {
            var k = r.workflow_key || 'ci';
            if (!state.wfTrans[k]) state.wfTrans[k] = {};
            if (!state.wfTrans[k][r.from_key]) state.wfTrans[k][r.from_key] = [];
            if (state.wfTrans[k][r.from_key].indexOf(r.to_key) === -1)
              state.wfTrans[k][r.from_key].push(r.to_key);
          });
        }
      } catch (e) { /* v7 features fall back to logic.js templates */ }
    }
    /* v6.1: feature probe — groups exists only after migration_v6_1.
       New-column writes (contacts.group_name, contact_projects.role,
       sites.default_group_id, tickets.assigned_group_id, spare_parts
       extra columns) are gated on this flag so old backends keep working. */
    state.v61 = false; state.groups = []; state.groupMembers = [];
    try {
      var v61p = await sb.from('groups').select('id', { count: 'exact', head: true });
      state.v61 = !v61p.error;
    } catch (e) { state.v61 = false; }
    if (state.v61) {
      try {
        var gr = await sb.from('groups').select('*').order('name');
        if (!gr.error) state.groups = gr.data || [];
        var gmr = await sb.from('group_members').select('*');
        if (!gmr.error) state.groupMembers = gmr.data || [];
      } catch (e) { /* groups stay empty */ }
    }
    /* v6.2: feature probe — email_templates exists only after
       migration_v6_2. Flag state.emailAvailable turns false for the
       session if the send-email Edge Function is not deployed yet,
       so notification attempts degrade silently instead of spamming
       the console. */
    state.v62 = false; state.appSettings = {}; state.emailAvailable = true;
    try {
      var v62p = await sb.from('email_templates').select('id', { count: 'exact', head: true });
      state.v62 = !v62p.error;
    } catch (e) { state.v62 = false; }
    if (state.v62) {
      try {
        var sr = await sb.from('app_settings').select('*');
        if (!sr.error) (sr.data || []).forEach(function (r) { state.appSettings[r.key] = r.value; });
      } catch (e) { /* defaults: master on, customer mail off */ }
    }
    /* v8: dictionaries + tracker registry live in app_settings and merge
       over the logic.js defaults, so behavior is unchanged until an admin
       edits them on the Settings page. */
    state.segments = L.segmentDict(state.appSettings.dict_segments);
    state.sources = L.sourceDict(state.appSettings.dict_sources);
    state.trackers = L.trackerRegistry(state.appSettings.trackers);
    /* v8: feature probes — notifications / ticket_watchers /
       ticket_contacts / group_sites exist only after migration_v8.
       Each surface degrades silently on an un-migrated backend. */
    state.v8 = false; state.v8tc = false; state.groupSites = [];
    try {
      var v8p = await sb.from('notifications').select('id', { count: 'exact', head: true });
      state.v8 = !v8p.error;
    } catch (e) { state.v8 = false; }
    if (state.v8) {
      try {
        var tcp = await sb.from('ticket_watchers').select('ticket_id', { count: 'exact', head: true });
        state.v8tc = !tcp.error;
        var gsr = await sb.from('group_sites').select('*');
        if (!gsr.error) state.groupSites = gsr.data || [];
      } catch (e) { /* v8 link tables stay off */ }
    }
    /* v8: custom_fields.depends_on / required_states exist only after
       migration_v8 — gate the writes so older backends keep saving. */
    state.v8owner = false; state.v8cf = false;
    try {
      var ow = await sb.from('sites').select('remote_owner_group_id').limit(1);
      state.v8owner = !ow.error;
      var cfp = await sb.from('custom_fields').select('depends_on').limit(1);
      state.v8cf = !cfp.error;
    } catch (e) { state.v8owner = false; state.v8cf = false; }
    /* v8.2: ticket_events audit table exists only after migration_v8_2. */
    state.v82 = false;
    try {
      var evp = await sb.from('ticket_events').select('id', { count: 'exact', head: true });
      state.v82 = !evp.error;
    } catch (e) { state.v82 = false; }
  }

  /**
   * wfTransitions(workflowKey) — DB-driven transition map if loaded,
   * otherwise the logic.js built-in template. Never throws.
   */
  function wfTransitions(workflowKey) {
    /* v8: any workflow key may be bound (tracker/segment settings); the
       legacy rule forced everything except 'utility' onto 'ci'. */
    var k = workflowKey || 'ci';
    if (state.v7 && state.wfTrans[k] && Object.keys(state.wfTrans[k]).length)
      return state.wfTrans[k];
    var tpl = L.WORKFLOW_TEMPLATES[k] || L.WORKFLOW_TEMPLATES.ci;
    return tpl.transitions;
  }

  /**
   * ticketTransitions(ticket, role, ctx) — v7.8 configurable workflow:
   * DB-driven transition map (by ticket.workflow_key) with role rules from
   * logic.js; falls back to the legacy fixed flow when nothing is loaded.
   */
  function ticketTransitions(ticket, role, ctx) {
    var map = wfTransitions(ticket && ticket.workflow_key);
    if (map && Object.keys(map).length)
      return L.allowedTransitionsWf(map, ticket.status, role, ctx);
    return L.allowedTransitions(ticket.status, role, ctx);
  }

  /**
   * wfStateList(workflowKey) — DB-driven states if loaded, else template.
   */
  function wfStateList(workflowKey) {
    var k = workflowKey || 'ci';
    if (state.v7 && state.wfStates.length) {
      var list = state.wfStates.filter(function (s) { return s.workflow_key === k; });
      if (list.length) return list;
    }
    var tpl = L.WORKFLOW_TEMPLATES[k] || L.WORKFLOW_TEMPLATES.ci;
    return tpl.states.map(function (s, i) {
      return { workflow_key: k, key: s.key, kind: s.kind, sort: (i + 1) * 10,
               name_en: s.key, name_zh: s.key,
               color_bg: '#f1f5f9', color_fg: '#475569' };
    });
  }

  /** wfStateName(s) — localized workflow state name. */
  function wfStateName(s) {
    if (!s) return '';
    return lang === 'zh' ? (s.name_zh || s.name_en || s.key) : (s.name_en || s.name_zh || s.key);
  }

  /** wfStateMap(workflowKey) — key → state row. */
  function wfStateMap(workflowKey) {
    var m = {};
    wfStateList(workflowKey).forEach(function (s) { m[s.key] = s; });
    return m;
  }

  /**
   * fieldsForTracker(tracker) — active custom fields bound to a tracker.
   */
  function fieldsForTracker(tracker) {
    if (!state.v7) return [];
    return state.customFields.filter(function (f) {
      return (f.trackers || []).indexOf(tracker) !== -1;
    });
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
    } else if (role === 'engineer' || role === 'tech_manager') {
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
    if (filters.tracker) q = q.eq('tracker', filters.tracker);
    if (filters.priority) q = q.eq('priority', filters.priority);
    if (filters.source) q = q.eq('source', filters.source);
    if (filters.site) q = q.eq('site_id', filters.site);
    if (filters.assignee) q = q.eq('assigned_to', filters.assignee);
    /* v6.1: support group filter (column only exists after migration_v6_1). */
    if (filters.group) q = q.eq('assigned_group_id', filters.group);
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
        /* v6.2 item 15: first time this ticket breaches → notify
           (session-deduped: a viewer without update rights would
           otherwise re-trigger on every render). */
        if (!state._slaBreachSent) state._slaBreachSent = {};
        if (!state._slaBreachSent[tk.id]) {
          state._slaBreachSent[tk.id] = true;
          notifyTicketEvent('sla_breach', tk, null);
        }
      } else {
        /* v6.2 item 15: SLA warning-state clocks → notify once per
           ticket+clock per session (client-side dedupe; there is no
           cron in this architecture). */
        var clocks = L.ticketSla(tk, now);
        ['response', 'onsite', 'resolution'].forEach(function (ck) {
          var st = clocks[ck].state;
          if (st === 'warning') {
            var key = tk.id + ':' + ck;
            if (state._slaWarnSent && state._slaWarnSent[key]) return;
            if (!state._slaWarnSent) state._slaWarnSent = {};
            state._slaWarnSent[key] = true;
            var dl = tk['sla_' + (ck === 'resolution' ? 'resolve' : ck) + '_at'];
            notifyTicketEvent('sla_warning', tk,
              { sla_deadline: fmtDate(dl), sla_clock: t('detail.sla.' + ck) });
          }
        });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* v6.2 item 15 — email notifier (fire-and-forget).                   */
  /* The send-email Edge Function does SMTP + email_log; this side only */
  /* assembles recipients + template variables. Any failure is          */
  /* console-only and never blocks the UI.                              */
  /* ------------------------------------------------------------------ */
  function appBaseUrl() {
    return window.location.origin +
      window.location.pathname.replace(/index\.html?$/, '');
  }

  function emailEventVars(ticket, extraVars) {
    var site = ticket.site_id
      ? (state.sites || []).filter(function (s) { return s.id === ticket.site_id; })[0]
      : null;
    var vars = {
      ticket_no: L.formatTicketNo(ticket.ticket_no),
      ticket_title: ticket.title || '',
      site_name: site ? (site.name || site.code || '') : '',
      actor_name: state.profile
        ? (state.profile.display_name || state.profile.email || '') : '',
      status: ticket.status ? t('status.' + ticket.status) : '',
      priority: ticket.priority ? t('priority.' + ticket.priority) : '',
      app_url: appBaseUrl() + '#/ticket/' + ticket.id
    };
    if (extraVars) Object.keys(extraVars).forEach(function (k) { vars[k] = extraVars[k]; });
    return vars;
  }

  /** collectRecipients(ticket, eventKey, opts) → L.assembleRecipients input,
   *  resolved against live state (profiles fetched on demand). */
  async function collectRecipients(ticket, eventKey, opts) {
    opts = opts || {};
    var ids = [];
    function need(id) { if (id && ids.indexOf(id) === -1) ids.push(id); }
    need(ticket.created_by); need(ticket.assigned_to);
    var site = ticket.site_id
      ? (state.sites || []).filter(function (s) { return s.id === ticket.site_id; })[0]
      : null;
    if (site) need(site.remote_owner_id);
    (state.groupMembers || []).forEach(function (m) {
      if (m.group_id === ticket.assigned_group_id && m.member_type === 'profile') need(m.member_id);
    });
    var profilesById = {};
    if (ids.length) {
      try {
        var pr = await sb.from('profiles')
          .select('id,email,role,language,is_active').in('id', ids);
        if (!pr.error) (pr.data || []).forEach(function (p) { profilesById[p.id] = p; });
      } catch (e) { /* recipients degrade to remote emails only */ }
    }
    var prefsByUser = {};
    if (state.v62 && ids.length) {
      try {
        var nr = await sb.from('notification_preferences').select('*').in('user_id', ids);
        if (!nr.error) (nr.data || []).forEach(function (r) {
          (prefsByUser[r.user_id] = prefsByUser[r.user_id] || {})[r.event_key] = !!r.enabled;
        });
      } catch (e) { /* absent row = enabled */ }
    }
    var contactsById = {};
    (state.contacts || []).forEach(function (c) { contactsById[c.id] = c; });
    return L.assembleRecipients({
      ticket: ticket,
      profilesById: profilesById,
      groupMembers: state.groupMembers || [],
      contactsById: contactsById,
      site: site,
      prefsByUser: prefsByUser,
      eventKey: eventKey,
      customerNotifyEnabled: state.appSettings.customer_email_notifications === 'true',
      staffOnly: !!opts.staffOnly,
      actorId: state.profile ? state.profile.id : null,
      actorEmail: state.profile ? state.profile.email : null
    });
  }

  /** Mark the send-email function unavailable for this session when the
   *  error shows it is not deployed (404 / relay / fetch errors).
   *  Transient SMTP 5xx keeps the flag — next invoke retries. */
  function emailMarkUnavailable(e) {
    if (!e) return;
    var st = e.context && e.context.status;
    if (st === 404 || e.name === 'FunctionsFetchError' || e.name === 'FunctionsRelayError') {
      state.emailAvailable = false;
    }
  }

  /* v8.2: audit events (status changes, assignments). The timeline is
     synthesized from milestone columns, so generic transitions used to
     leave no trace (found in the 2026-10-23 full sweep, item 3b).
     Fire-and-forget: auditing must never block the action itself.
     No-op until migration_v8_2 lands (state.v82). */
  function logTicketEvent(ticketId, kind, detail) {
    if (!state.v82 || !state.profile) return;
    try {
      sb.from('ticket_events').insert({
        ticket_id: ticketId, actor_id: state.profile.id,
        kind: kind, detail: detail || null
      }).then(function () {}, function () {});
    } catch (e) { /* audit is best-effort */ }
  }

  function notifyTicketEvent(eventKey, ticket, extraVars, opts) {
    if (!state.v62 || !state.emailAvailable || !sb || !ticket || !ticket.id) return;
    if (state.appSettings.email_enabled === 'false') return;  // master kill switch
    collectRecipients(ticket, eventKey, opts).then(function (recs) {
      if (!recs.length) return;
      var vars = emailEventVars(ticket, extraVars);
      recs.forEach(function (r) {
        try {
          Promise.resolve(sb.functions.invoke('send-email', {
            body: {
              to: r.email,
              template_key: eventKey,
              lang: r.lang,
              variables: vars,
              ticket_id: ticket.id,
              event_key: eventKey
            }
          })).then(function (res) {
            if (res && res.error) {
              console.warn('[email] send failed for ' + r.email + ':', res.error.message);
              emailMarkUnavailable(res.error);
            }
          }).catch(function (e) {
            console.warn('[email] invoke failed for ' + r.email + ':', e);
            emailMarkUnavailable(e);
          });
        } catch (e) {
          console.warn('[email] invoke threw for ' + r.email + ':', e);
          emailMarkUnavailable(e);
        }
      });
    }).catch(function (e) { console.warn('[email] notify failed:', e); });
  }

  /* ------------------------------ router -------------------------------- */
  var app = document.getElementById('app');

  function nav(hash) { window.location.hash = hash; }

  /* v8 (#1): navigate, or render in place when the hash is already the
     target — assigning the same hash fires no hashchange, which used to
     leave a white page on refresh (boot relied on the event). */
  function go(hash) {
    if (window.location.hash === hash) render();
    else nav(hash);
  }

  function currentRoute() {
    var h = window.location.hash || '#/dashboard';
    var m = h.match(/^#\/ticket\/([0-9a-f-]{36})$/i);
    if (m) return { name: 'detail', id: m[1] };
    var ms = h.match(/^#\/site\/([0-9a-f-]{36})$/i);
    if (ms) return { name: 'site', id: ms[1] };
    var name = h.replace(/^#\//, '').split('?')[0];
    if (['login', 'dashboard', 'tickets', 'new', 'parts', 'planning', 'calendar', 'users', 'sites', 'sla-alerts', 'contacts', 'workflow', 'fields', 'groups', 'email', 'settings'].indexOf(name) === -1) name = 'dashboard';
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
      if (state.profile) { go('#/dashboard'); return; }
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
      else if (route.name === 'site') { if (guard('site.view')) await viewSiteDetail(view, route.id); }
      else if (route.name === 'users') { if (guard('user.manage')) await viewUsers(view); }
      else if (route.name === 'sites') { if (guard('site.view')) await viewSites(view); }
      else if (route.name === 'contacts') { if (guard('contact.manage')) await viewContacts(view); }
      /* v6.1: support groups management */
      else if (route.name === 'groups') { if (guard('group.manage')) await viewGroups(view); }
      /* v6.2: email notification settings (admin) */
      else if (route.name === 'email') { if (guard('email.manage')) await viewEmail(view); }
      else if (route.name === 'workflow') { if (guard('workflow.manage')) await viewWorkflow(view); }
      else if (route.name === 'settings') { if (guard('settings.manage')) await viewSettings(view); }
      else if (route.name === 'fields') { if (guard('field.manage')) await viewCustomFields(view); }
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
        { id: 'sites',     href: '#/sites',     label: t('nav.sites'),     perm: 'site.view' },
        { id: 'contacts',  href: '#/contacts',  label: t('nav.contacts'),  perm: 'contact.manage' },
        /* v6.1: support groups (dispatch rules per Massimo) */
        { id: 'groups',    href: '#/groups',    label: t('nav.groups'),    perm: 'group.manage' },
        /* v6.2: email notifications admin (item 15) */
        { id: 'email',     href: '#/email',     label: t('nav.email'),     perm: 'email.manage' },
        { id: 'workflow',  href: '#/workflow',  label: t('nav.workflow'),  perm: 'workflow.manage' },
        { id: 'fields',    href: '#/fields',    label: t('nav.fields'),    perm: 'field.manage' },
        /* v8: dictionaries + tracker registry (governed settings) */
        { id: 'settings',  href: '#/settings',  label: t('nav.settings'),  perm: 'settings.manage' },
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
              /* v8 (#4): in-app notification bell */
              '<button class="btn btn-sm" id="notif-bell-btn" style="display:none">🔔' +
                '<span id="notif-badge" class="notif-badge" style="display:none"></span></button>' +
              /* v6.2: personal email-notification preferences */
              '<button class="btn btn-sm" id="notif-prefs-btn">' + esc(t('nav.myNotifications')) + '</button>' +
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
    /* v6.2: personal notification preferences modal (all roles). */
    document.getElementById('notif-prefs-btn').onclick = openMyNotificationsModal;
    /* v8 (#4): notification bell — badge refresh + panel. */
    var bellBtn = document.getElementById('notif-bell-btn');
    if (bellBtn) {
      bellBtn.onclick = function () { openNotifPanel(); };
      refreshNotifBadge();
    }
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

  /* ------------------------- v8 helpers ------------------------------- */
  /* Localized dictionary label: stored name wins, i18n key is fallback. */
  function dictName(item, i18nKey) {
    if (!item) return i18nKey || '';
    var n = lang === 'zh' ? (item.name_zh || item.name_en) : (item.name_en || item.name_zh);
    if (n) return n;
    if (i18nKey) { var s = t(i18nKey); if (s !== i18nKey) return s; }
    return item.key || '';
  }
  function sourceLabel(key) {
    var it = null;
    (state.sources || []).forEach(function (s) { if (s.key === key) it = s; });
    return dictName(it, 'source.' + key);
  }
  function segmentLabel(key) {
    var it = null;
    (state.segments || []).forEach(function (s) { if (s.key === key) it = s; });
    return dictName(it, 'sites.segment.' + key);
  }
  function trackerByKey(key) {
    var it = null;
    (state.trackers || []).forEach(function (x) { if (x.key === key) it = x; });
    if (!it && L.TRACKERS[key]) {
      var d = L.TRACKERS[key];
      it = { key: key, prefix: d.prefix, color: d.color, workflow_key: '' };
    }
    return it;
  }
  function trackerName(key) {
    var tr = trackerByKey(key);
    return tr ? dictName(tr, 'tracker.' + key) : key;
  }

  /* v8 (#4): notification bell badge + panel. Data comes from the
     notifications table (migration_v8, trigger-populated). */
  async function refreshNotifBadge() {
    var btn = document.getElementById('notif-bell-btn');
    var badge = document.getElementById('notif-badge');
    if (!btn || !badge) return;
    if (!state.v8 || !state.profile) { btn.style.display = 'none'; return; }
    btn.style.display = '';
    try {
      var r = await sb.from('notifications').select('id', { count: 'exact', head: true })
        .eq('user_id', state.profile.id).eq('is_read', false);
      var n = r.count || 0;
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.style.display = n ? '' : 'none';
    } catch (e) { /* badge stays hidden on error */ }
  }

  async function openNotifPanel() {
    if (!state.v8) { toast(t('notif.unavailable'), 'error'); return; }
    var r = await sb.from('notifications').select('*')
      .eq('user_id', state.profile.id)
      .order('created_at', { ascending: false }).limit(30);
    var rows = (r && r.data) || [];
    var body = rows.length ? rows.map(function (n) {
      return '<div class="notif-row' + (n.is_read ? '' : ' unread') + '" data-nid="' + n.id + '"' +
        (n.ticket_id ? ' data-ticket="' + n.ticket_id + '"' : '') + '>' +
        '<div class="notif-kind">' + esc(t('notif.kind.' + n.kind)) + '</div>' +
        '<div class="notif-main"><b>' + esc(n.ticket_no || '') + '</b> ' + esc(n.detail || '') + '</div>' +
        '<div class="notif-time muted">' + esc(fmtDate(n.created_at)) + '</div></div>';
    }).join('') : '<div class="empty">' + esc(t('notif.empty')) + '</div>';
    var close = openModal(t('notif.title'),
      '<div class="notif-list">' + body + '</div>',
      '<button class="btn" id="notif-readall">' + esc(t('notif.markAllRead')) + '</button>');
    var ra = document.getElementById('notif-readall');
    if (ra) ra.onclick = async function () {
      await sb.from('notifications').update({ is_read: true })
        .eq('user_id', state.profile.id).eq('is_read', false);
      close(); refreshNotifBadge();
    };
    document.querySelectorAll('.notif-row').forEach(function (el) {
      el.onclick = async function () {
        var nid = el.getAttribute('data-nid');
        var tid = el.getAttribute('data-ticket');
        try { await sb.from('notifications').update({ is_read: true }).eq('id', nid); } catch (e) {}
        close(); refreshNotifBadge();
        if (tid) nav('#/ticket/' + tid);
      };
    });
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
  async function afterSignIn(authUser, opts) {
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
    /* v8 (#1): on boot (page refresh) restore the route the user was on
       instead of always forcing the dashboard — and render explicitly,
       because navigating to the hash already in the URL fires no
       hashchange and used to leave a white page. */
    if (opts && opts.fromBoot) {
      var h = window.location.hash || '';
      if (!h || h === '#/login') { go('#/dashboard'); return; }
      render(); return;
    }
    go('#/dashboard');
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
    /* v7.13: active user count for the KPI row (head count only). */
    try {
      var uc = await sb.from('profiles').select('id', { count: 'exact', head: true }).eq('is_active', true);
      if (!uc.error && uc.count != null) state._activeUserCount = uc.count;
    } catch (e) {}
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
      .in('role', ['engineer', 'tech_manager']).eq('is_active', true).order('display_name');
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
    /* v7.13: SLA risk list — warning-state clocks, worst first, top 10. */
    var slaRiskRows = open.filter(function (x) {
      var sla = L.ticketSla(x);
      return ['response', 'onsite', 'resolution'].some(function (k) { return sla[k].state === 'warning'; });
    }).slice(0, 10).map(function (x) {
      var ageD = Math.max(0, Math.floor((nowMs - new Date(x.created_at).getTime()) / 86400000));
      var sla = L.ticketSla(x);
      var worst = ['response', 'onsite', 'resolution'].filter(function (k) {
        return sla[k].state === 'warning';
      }).map(function (k) { return t('detail.sla.' + k); }).join(' · ');
      return '<div class="attn-row" data-nav="#/ticket/' + x.id + '">' +
        '<span class="tnum">' + esc(L.formatTicketNo(x.ticket_no)) + '</span>' +
        '<span class="ttl">' + esc(x.title) + '</span>' +
        '<span class="meta">' + esc(siteShort(x.site_id)) + ' · ' + esc(worst) + ' · ' + ageD + 'd</span>' +
        badge('sla-warning', t('detail.sla.warning')) +
      '</div>';
    }).join('');

    /* v7.12: this month's planned-maintenance tickets (tracker=maintenance). */
    function maintThisMonth(allTickets) {
      var y = new Date().getFullYear(), m = new Date().getMonth();
      var mth = allTickets.filter(function (x) {
        if (x.tracker !== 'maintenance' || !x.planned_date) return false;
        var d = new Date(x.planned_date);
        return d.getFullYear() === y && d.getMonth() === m;
      });
      var done = mth.filter(function (x) { return L.TERMINAL_STATUSES.indexOf(x.status) !== -1; }).length;
      return { done: done, total: mth.length };
    }

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
      /* v7.13: TechCRM-style master data KPIs + SLA risk list. */
      '<div class="grid-4" style="margin-top:16px">' +
        counter(t('dash.activeProjects'),
                state.sites.filter(function (s) { return (s.status || 'active') === 'active'; }).length,
                false, '#/sites') +
        counter(t('dash.activeUsers'), state._activeUserCount || '—', false, '#/users') +
        counter(t('dash.plannedMaint'),
                state.v7 ? maintThisMonth(tickets).done + '/' + maintThisMonth(tickets).total : '—',
                false, '#/tickets') +
        counter(t('dash.slaRisk'),
                open.filter(function (x) { return L.ticketSla(x).response.state === 'warning' ||
                  L.ticketSla(x).onsite.state === 'warning' || L.ticketSla(x).resolution.state === 'warning'; }).length,
                false, '#/tickets') +
      '</div>' +
      '<div class="card" style="margin-top:16px"><h2 class="section-title">' +
        esc(t('dash.slaRiskList')) + '</h2>' +
        (slaRiskRows || '<div class="empty">' + esc(t('dash.risk.none')) + '</div>') +
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
        (state.v7 ? '<td>' + trackerBadge(x.tracker) + '</td>' : '') +
        '<td>' + esc(x.title) + '</td>' +
        '<td>' + statusBadge(x.status) + '</td>' +
        '<td>' + priBadge(x.priority) + '</td>' +
        '<td class="muted">' + esc(siteShort(x.site_id)) + '</td>' +
        '<td>' + (x.assigned_to ? esc(displayName(x.assigned_to))
                                : '<span class="pill-unassigned">' + esc(t('list.unassigned')) + '</span>') +
          /* v6.1: routed support group badge */
          (state.v61 && x.assigned_group_id
            ? ' <span class="badge status-assigned">' + esc(groupName(x.assigned_group_id)) + '</span>' : '') +
        '</td>' +
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
                                : '<span class="pill-unassigned">' + esc(t('list.unassigned')) + '</span>') +
          /* v6.1: routed support group badge */
          (state.v61 && x.assigned_group_id
            ? ' <span class="badge status-assigned">' + esc(groupName(x.assigned_group_id)) + '</span>' : '') +
        '</td>' +
        '<td>' + badge(bCls, bLbl) +
             (x.escalated ? ' ' + badge('escalated', t('detail.escalated')) : '') + '</td>' +
        '<td class="muted">' + esc(fmtDate(x.updated_at)) + '</td>' +
      '</tr>';
  }

  /** v7.7: tracker badge (color-coded). v8: registry-driven label/color. */
  function trackerBadge(tracker) {
    var tr = trackerByKey(tracker) || trackerByKey('support');
    return '<span class="badge" style="background:' + tr.color + '22;color:' + tr.color +
      ';border:1px solid ' + tr.color + '55">' + esc(trackerName(tr.key)) + '</span>';
  }

  function ticketTable(tickets) {
    if (!tickets.length) return '<div class="empty">' + esc(t('list.noResults')) + '</div>';
    var rows = tickets.map(ticketRowHtml).join('');
    return '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
      '<th>' + esc(t('list.columns.ticket')) + '</th>' +
      (state.v7 ? '<th>' + esc(t('tickets.tracker')) + '</th>' : '') +
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
    return { status: '', tracker: '', priority: '', source: '', site: '', assignee: '', q: '', tag: '', customer: '',
             unassignedOnly: false, contractOnly: false, group: '' /* v6.1 */ };
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
                           f.unassignedOnly || f.contractOnly || f.group); // v3 U6 quick filters count too
    var scopeLimited = role === 'engineer' || role === 'tech_manager' || role === 'customer' ||
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
        /* v7.7: tracker filter */
        (state.v7
          ? '<div class="f"><label>' + esc(t('tickets.tracker')) + '</label>' +
            '<select id="f-tracker"><option value="">' + esc(t('common.all')) + '</option>' +
            state.trackers.map(function (tr) {
              return '<option value="' + esc(tr.key) + '"' + (f.tracker === tr.key ? ' selected' : '') + '>' +
                esc(trackerName(tr.key)) + '</option>';
            }).join('') + '</select></div>'
          : '') +
        '<div class="f"><label>' + esc(t('list.filter.priority')) + '</label>' +
          '<select id="f-priority">' + selectOpts(L.PRIORITIES, 'priority.', f.priority) + '</select></div>' +
        '<div class="f"><label>' + esc(t('list.filter.source')) + '</label>' +
          '<select id="f-source">' + '<option value="">' + esc(t('common.all')) + '</option>' +
          state.sources.map(function (s) {
            return '<option value="' + esc(s.key) + '"' + (f.source === s.key ? ' selected' : '') + '>' +
              esc(sourceLabel(s.key)) + '</option>';
          }).join('') + '</select></div>' +
        '<div class="f"><label>' + esc(t('list.filter.site')) + '</label>' +
          '<select id="f-site">' + siteOpts + '</select></div>' +
        /* v6.1: support group filter */
        (state.v61
          ? '<div class="f"><label>' + esc(t('list.filter.group')) + '</label>' +
            '<select id="f-group"><option value="">' + esc(t('common.all')) + '</option>' +
            state.groups.map(function (g) {
              return '<option value="' + g.id + '"' + (f.group === g.id ? ' selected' : '') + '>' +
                esc(g.name) + '</option>';
            }).join('') + '</select></div>'
          : '') +
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
      var trkEl = document.getElementById('f-tracker');
      if (trkEl) f.tracker = trkEl.value;
      f.priority = document.getElementById('f-priority').value;
      f.source = document.getElementById('f-source').value;
      f.site = document.getElementById('f-site').value;
      f.q = document.getElementById('f-q').value;
      var grpEl = document.getElementById('f-group');
      if (grpEl) f.group = grpEl.value;
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
    ['f-status', 'f-tracker', 'f-priority', 'f-source', 'f-site', 'f-group'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.onchange = refetch;
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
      /* v7.15: a missing or RLS-hidden ticket surfaces PostgREST's raw
         PGRST116 text ("Cannot coerce the result to a single JSON
         object"). Show a friendly notice instead; not-found and
         no-access stay deliberately indistinguishable. */
      view.innerHTML = '<div class="inline-err">' +
        esc(t('detail.notFoundOrNoAccess')) + '</div>' +
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
    /* v8.2: audit events for the timeline (status changes, assignments). */
    var events = [];
    if (state.v82) {
      var evr = await sb.from('ticket_events').select('*').eq('ticket_id', id).order('created_at');
      if (!evr.error) events = evr.data || [];
    }
    await resolveNames(collectIds([ticket]).concat(
      comments.map(function (c) { return c.author_id; }),
      photos.map(function (p) { return p.uploaded_by; }),
      events.map(function (e) { return e.actor_id; }),
      events.filter(function (e) { return e.kind === 'assigned' && e.detail && e.detail.indexOf('u:') === 0; })
        .map(function (e) { return e.detail.slice(2); })
    ));

    var p = state.profile, role = p.role;
    var ctx = L.transitionCtx(ticket, p);
    var transitions = ticketTransitions(ticket, role, ctx);
    var canAssign = L.can('ticket.assign', role);
    var canFieldReport = L.can('ticket.fieldreport', role) && ((role !== 'engineer' && role !== 'tech_manager') || ctx.isAssignee);
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
        trackerBadge(ticket.tracker) +
        badge('status-open', sourceLabel(ticket.source)) +
        (ticket.is_ltsa ? badge('escalated', t('detail.contractTicket')) : '') +
        (ticket.escalated ? badge('escalated', t('detail.escalated')) : '') +
        (state.v3 ? tagPills(ticket.tags) : '') + '</div>' +
      '<h1 class="detail-title">' + esc(ticket.title) + '</h1>' +
      '<div class="t-detail">' +
      '<div>' + // left column: work area
        '<div class="card"><h2>' + esc(t('detail.sla')) + '</h2>' +
          '<div class="sla-clocks">' + clockCard('response') + clockCard('onsite') + clockCard('resolution') + '</div>' +
          /* v7.9: contract SLA terms driving these clocks (LTSA tickets). */
          (ticket.is_ltsa && state.contracts[ticket.site_id]
            ? '<div class="hint" style="margin-top:8px">' + esc(t('ticket.contractReq')) + '： ' +
              esc(t('ticket.contractReqLine', {
                resp: state.contracts[ticket.site_id].response_hours != null
                  ? state.contracts[ticket.site_id].response_hours : '—',
                res: state.contracts[ticket.site_id].resolve_hours != null
                  ? state.contracts[ticket.site_id].resolve_hours : '—'
              })) +
              (state.contracts[ticket.site_id].availability_pct != null
                ? ' · ' + esc(t('contract.availability')) + ' ' +
                  esc(String(state.contracts[ticket.site_id].availability_pct)) + '%'
                : '') +
              (state.contracts[ticket.site_id].support_24_7 ? ' · 24/7' : '') +
              '</div>'
            : '') +
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
        /* v7.11: service reports (mandatory before close, with signature). */
        (!isCustomer && state.v7
          ? '<div class="card"><h2>' + esc(t('ticket.serviceReport')) + '</h2>' +
            '<div id="report-list"><div class="empty">' + esc(t('common.loading')) + '</div></div>' +
            '<div style="margin-top:10px"><button class="btn btn-sm btn-primary" id="report-upload-btn">' +
              esc(t('ticket.uploadReport')) + '</button></div></div>'
          : '') +
        /* v7.14: custom fields bound to this ticket's tracker. */
        (state.v7
          ? '<div class="card"><h2>' + esc(t('cf.title')) + '</h2>' +
          '<div id="cf-list"><div class="empty">' + esc(t('common.loading')) + '</div></div>' +
          (canEditCore ? '<div style="margin-top:10px"><button class="btn btn-sm" id="cf-edit-btn">' +
            esc(t('common.edit')) + '</button></div>' : '') +
        '</div>'
          : '') +
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
            '<span class="v">' + esc(sourceLabel(ticket.source)) + '</span></div>' +
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
        /* v7.10: master/sub-tickets (parent_ticket_id hierarchy). */
        (!isCustomer && state.v7
          ? '<div class="card"><h2>' + esc(t('ticket.subTickets')) + '</h2>' +
            '<div id="sub-list"><div class="empty">' + esc(t('common.loading')) + '</div></div>' +
            '<div style="margin-top:10px;display:flex;gap:8px">' +
              '<button class="btn btn-sm" id="new-sub-btn">+ ' + esc(t('ticket.newSub')) + '</button>' +
            '</div></div>'
          : '') +
        /* v8: related contacts + internal watchers (staff only). */
        (!isCustomer && state.v8tc
          ? '<div class="card"><h2>' + esc(t('detail.people')) + '</h2>' +
            '<div class="muted" style="margin-bottom:4px">' + esc(t('detail.contacts')) + '</div>' +
            '<div id="tk-contacts"><div class="empty">' + esc(t('common.loading')) + '</div></div>' +
            '<div style="display:flex;gap:6px;margin:8px 0 14px">' +
              '<select id="tk-contact-add" style="flex:1"></select>' +
              '<button class="btn btn-sm" id="tk-contact-add-btn">+ ' + esc(t('common.add')) + '</button>' +
              '<button class="btn btn-sm" id="tk-contact-new-btn">+ ' + esc(t('contacts.new')) + '</button></div>' +
            '<div class="muted" style="margin-bottom:4px">' + esc(t('detail.watchers')) + '</div>' +
            '<div id="tk-watchers"><div class="empty">' + esc(t('common.loading')) + '</div></div>' +
            '<div style="display:flex;gap:6px;margin-top:8px">' +
              '<select id="tk-watcher-add" style="flex:1"></select>' +
              '<button class="btn btn-sm" id="tk-watcher-add-btn">+ ' + esc(t('common.add')) + '</button></div></div>'
          : '') +
      '</div></div>';

    view.innerHTML = html;
    document.getElementById('back-btn').onclick = function () { nav('#/tickets'); };
    /* v3 F9: print report (staff only). */
    var prBtn = document.getElementById('print-report-btn');
    if (prBtn) prBtn.onclick = function () { printServiceReport(ticket, comments, photos, events); };
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
        var allowed = ticketTransitions(ticket, role, L.transitionCtx(ticket, state.profile));
        if (allowed.indexOf(to) === -1) { toast(t('common.noPermission'), 'error'); return; }
        btn.disabled = true;
        try {
          /* v7.11: close gate — a service report (with customer signature)
             must be uploaded before the ticket can be closed. */
          if (to === 'closed' && state.v7) {
            var gate = L.canCloseTicket(ticket, photos, ticket.custom_values);
            if (!gate.ok) {
              toast(t(gate.reason === 'signature_missing' ? 'ticket.signatureMissing'
                                                          : 'ticket.reportRequired'), 'error');
              btn.disabled = false; return;
            }
          }
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
          /* v6.2 item 15: notify status change (separate from assignment
             notifications — that path never reaches here). */
          notifyTicketEvent('status_changed', Object.assign({}, ticket, { status: to }), null);
          /* v8.2: audit event so the timeline shows every transition. */
          logTicketEvent(ticket.id, 'status', ticket.status + ' → ' + to);
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
        /* v6.2 item 15: notify comment; internal comments stay inside
           staff (no customers, no external contacts/remote addresses). */
        notifyTicketEvent('comment_added', ticket, { comment: body },
          { staffOnly: isInternal });
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
    renderTimeline(ticket, comments, photos, events);
    if (state.v3 && !isCustomer) loadRelatedTickets(ticket.id);
    if (!isCustomer && state.v7) loadSubTickets(ticket);
    if (!isCustomer && state.v8tc) loadTicketPeople(ticket);
    /* v7.11: service reports + v7.14 custom fields */
    if (!isCustomer && state.v7) loadServiceReports(ticket);
    if (state.v7) renderCustomFieldValues(ticket);
    var cfBtn = document.getElementById('cf-edit-btn');
    if (cfBtn) cfBtn.onclick = function () { openCustomFieldsModal(ticket, function () { render(); }); };
    var ruBtn = document.getElementById('report-upload-btn');
    if (ruBtn) ruBtn.onclick = function () {
      openServiceReportModal(ticket, function () { render(); });
    };
    var nsb = document.getElementById('new-sub-btn');
    if (nsb) nsb.onclick = function () {
      /* v7.10: spare-part approval sub-ticket goes to HQ (dispatcher/admin). */
      newTicketPrefill = {
        parentTicketId: ticket.id,
        siteId: ticket.site_id,
        tracker: 'spare',
        title: t('tracker.spare') + ' — ' + ticket.title
      };
      nav('#/new');
    };
  }

  /* v7.11: service reports list (attachments kind='service_report'). */
  async function loadServiceReports(ticket) {
    var box = document.getElementById('report-list');
    if (!box) return;
    try {
      var r = await sb.from('ticket_attachments').select('*')
        .eq('ticket_id', ticket.id).eq('kind', 'service_report').order('created_at');
      if (r.error) throw r.error;
      var rows = r.data || [];
      if (!rows.length) {
        box.innerHTML = '<div class="inline-warn">' + esc(t('ticket.reportRequired')) + '</div>';
        return;
      }
      box.innerHTML = rows.map(function (a) {
        var signed = a.meta && a.meta.signed;
        return '<div class="related-row"><span class="ttl">' + esc(a.file_name || 'report') + '</span> ' +
          badge(signed ? 'sla-ok' : 'sla-warning',
            esc(t(signed ? 'ticket.signed' : 'ticket.signatureMissing'))) +
          ' <span class="muted">' + esc(fmtDate(a.created_at)) + '</span></div>';
      }).join('');
    } catch (e) {
      box.innerHTML = '<div class="inline-err">' + esc(e.message || t('common.error')) + '</div>';
    }
  }

  /**
   * v7.11: service-report upload modal — file upload + customer signature pad.
   * The signature is drawn on a canvas and stored (data URL) in the
   * attachment meta; canCloseTicket() gates the close transition.
   */
  function openServiceReportModal(ticket, done) {
    var body =
      '<div class="field"><label>' + esc(t('ticket.serviceReport')) + '</label>' +
        '<input type="file" id="sr-file" accept=".pdf,.doc,.docx,image/*"></div>' +
      '<div class="field"><label>' + esc(t('ticket.signHere')) + '</label>' +
        '<canvas id="sr-sig" width="520" height="160" style="border:1px solid var(--border);border-radius:6px;touch-action:none;width:100%"></canvas>' +
        '<div style="margin-top:6px"><button class="btn btn-sm" id="sr-clear">' +
          esc(t('ticket.clearSig')) + '</button> ' +
          '<label style="font-weight:normal"><input type="checkbox" id="sr-signed"> ' +
          esc(t('ticket.signed')) + '</label></div></div>';
    var close = openModal(t('ticket.uploadReport'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>', true);
    document.getElementById('m-cancel').onclick = close;
    var canvas = document.getElementById('sr-sig');
    var ctx2 = canvas.getContext('2d');
    var drawing = false, hasDrawn = false;
    function pos(e) {
      var r = canvas.getBoundingClientRect();
      var src = e.touches ? e.touches[0] : e;
      return { x: (src.clientX - r.left) * (canvas.width / r.width),
               y: (src.clientY - r.top) * (canvas.height / r.height) };
    }
    /* v7.2: ANY stroke start (pointer/mouse/touch) marks the pad as drawn.
       Previously hasInk was only set inside move() after a mouse/touch
       down, so pointer-driven input (and a simple tap) never registered
       and the saved report kept reporting "signature missing". */
    function down(e) {
      drawing = true; hasDrawn = true;
      var p = pos(e); ctx2.beginPath(); ctx2.moveTo(p.x, p.y); e.preventDefault();
    }
    function move(e) {
      if (!drawing) return;
      var p = pos(e); ctx2.lineTo(p.x, p.y); ctx2.strokeStyle = '#1f2937'; ctx2.lineWidth = 2; ctx2.stroke();
      hasDrawn = true;
    }
    function up() { drawing = false; }
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('mousedown', down); canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', up); canvas.addEventListener('mouseleave', up);
    canvas.addEventListener('touchstart', down); canvas.addEventListener('touchmove', move);
    canvas.addEventListener('touchend', up);
    document.getElementById('sr-clear').onclick = function () {
      ctx2.clearRect(0, 0, canvas.width, canvas.height); hasDrawn = false;
    };
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var fileEl = document.getElementById('sr-file');
        var file = fileEl.files && fileEl.files[0];
        if (!file) { toast(t('new.fillRequired'), 'error'); btn.disabled = false; return; }
        /* v7.2: ink on the pad alone attests the signature (previously
           signed required the checkbox AND ink, so a drawn signature was
           still saved as unsigned). The checkbox remains as a manual
           attestation for reports the customer signed on paper. */
        var signed = hasDrawn || document.getElementById('sr-signed').checked;
        var path = L.photoPath(ticket.id, file.name);
        /* v7.3: no uid segment — with uid the path is deterministic
           (ticket/user/filename), so re-saving the same file hits the SAME
           storage object and upsert's UPDATE leg is RLS-denied (the bucket
           has no UPDATE policy). A random unique path keeps every save a
           pure INSERT, exactly like uploadPhoto. */
        var up = await sb.storage.from('ticket-photos').upload(path, file, {
          contentType: file.type || 'application/octet-stream', upsert: true
        });
        if (up.error) throw up.error;
        var ins = await sb.from('ticket_attachments').insert({
          ticket_id: ticket.id, storage_path: path, file_name: file.name,
          content_type: file.type || null, size_bytes: file.size || null,
          uploaded_by: state.profile.id, kind: 'service_report',
          meta: { signed: signed, signature: hasDrawn ? canvas.toDataURL('image/png') : null }
        });
        if (ins.error) throw ins.error;
        toast(t('ticket.reportSaved'), 'ok');
        close(); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  /** v7.14: render this ticket's custom-field values (read-only list). */
  function renderCustomFieldValues(ticket) {
    var box = document.getElementById('cf-list');
    if (!box) return;
    var fields = fieldsForTracker(ticket.tracker);
    if (!fields.length) {
      box.innerHTML = '<div class="empty muted">—</div>';
      return;
    }
    var values = ticket.custom_values || {};
    box.innerHTML = '<dl class="kv">' + fields.filter(function (f) {
      return L.fieldVisibleIn(f, ticket.status);
    }).map(function (f) {
      var v = values[f.key];
      var label = lang === 'zh' ? (f.label_zh || f.label_en) : (f.label_en || f.label_zh);
      var disp;
      if (f.type === 'checkbox') disp = v ? '✓' : '—';
      else if (f.type === 'checklist') disp = Array.isArray(v) ? esc(v.join(', ')) : '—';
      else if (f.type === 'signature') disp = v ? '✓' : '—';
      else disp = v == null || v === '' ? '—' : esc(String(v));
      return '<dt>' + esc(label) + (f.required ? '<span class="req">*</span>' : '') + '</dt><dd>' + disp + '</dd>';
    }).join('') + '</dl>';
  }

  /** v7.14: edit custom-field values (per tracker), validated by logic.js. */
  function openCustomFieldsModal(ticket, done) {
    var fields = fieldsForTracker(ticket.tracker).filter(function (f) {
      return L.fieldVisibleIn(f, ticket.status);
    });
    var values = Object.assign({}, ticket.custom_values || {});
    function fldHtml(f) {
      var label = lang === 'zh' ? (f.label_zh || f.label_en) : (f.label_en || f.label_zh);
      var v = values[f.key];
      var opts = Array.isArray(f.options) ? f.options : [];
      var inner;
      switch (f.type) {
        case 'textarea':
          inner = '<textarea id="cf-' + f.key + '" style="height:70px">' + esc(v || '') + '</textarea>';
          break;
        case 'number':
          inner = '<input type="number" step="any" id="cf-' + f.key + '" value="' + esc(v == null ? '' : v) + '">';
          break;
        case 'date':
          inner = '<input type="date" id="cf-' + f.key + '" value="' + esc(v || '') + '">';
          break;
        case 'url':
          inner = '<input type="url" id="cf-' + f.key + '" value="' + esc(v || '') + '">';
          break;
        case 'dropdown':
          inner = '<select id="cf-' + f.key + '"><option value=""></option>' + opts.map(function (o) {
            return '<option value="' + esc(o) + '"' + (String(v) === String(o) ? ' selected' : '') + '>' +
              esc(o) + '</option>';
          }).join('') + '</select>';
          break;
        case 'checkbox':
          inner = '<input type="checkbox" id="cf-' + f.key + '"' + (v ? ' checked' : '') + '>';
          break;
        case 'checklist':
          inner = opts.map(function (o) {
            var on = Array.isArray(v) && v.indexOf(o) !== -1;
            return '<label style="display:block;font-weight:normal"><input type="checkbox" class="cf-cl-' +
              f.key + '" value="' + esc(o) + '"' + (on ? ' checked' : '') + '> ' + esc(o) + '</label>';
          }).join('');
          break;
        case 'signature':
          inner = '<input type="text" id="cf-' + f.key + '" placeholder="data:…" value="' +
            esc(v ? '✓' : '') + '" disabled>';
          break;
        default:
          inner = '<input type="text" id="cf-' + f.key + '" value="' + esc(v || '') + '">';
      }
      return '<div class="field" id="cfw-' + f.key + '"><label>' + esc(label) +
        (L.fieldRequiredIn(f, ticket.status) ? '<span class="req">*</span>' : '') + '</label>' + inner + '</div>';
    }
    var body = fields.map(fldHtml).join('');
    var close = openModal(t('cf.title'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    /* v8 (#23): field dependencies — re-evaluate visibility on every
       input; a field whose dependency fails is not rendered at all. */
    function collectCfValues() {
      var out = Object.assign({}, values);
      fields.forEach(function (f) {
        var el = document.getElementById('cf-' + f.key);
        if (f.type === 'checkbox') { if (el) out[f.key] = el.checked; }
        else if (f.type === 'checklist') {
          out[f.key] = Array.prototype.map.call(
            document.querySelectorAll('.cf-cl-' + f.key + ':checked'),
            function (x) { return x.value; });
        } else if (f.type === 'signature') { /* unchanged here */ }
        else if (el) out[f.key] = el.value;
      });
      return out;
    }
    function applyDeps() {
      var cur = collectCfValues();
      fields.forEach(function (f) {
        var w = document.getElementById('cfw-' + f.key);
        if (w) w.style.display = L.fieldDepVisible(f, cur) ? '' : 'none';
      });
    }
    fields.forEach(function (f) {
      var el = document.getElementById('cf-' + f.key);
      if (el) { el.addEventListener('change', applyDeps); el.addEventListener('input', applyDeps); }
      document.querySelectorAll('.cf-cl-' + f.key).forEach(function (c) {
        c.addEventListener('change', applyDeps);
      });
    });
    applyDeps();
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var out = Object.assign({}, values);
        fields.forEach(function (f) {
          if (f.type === 'checkbox') out[f.key] = document.getElementById('cf-' + f.key).checked;
          else if (f.type === 'checklist') {
            out[f.key] = Array.prototype.map.call(
              document.querySelectorAll('.cf-cl-' + f.key + ':checked'),
              function (el) { return el.value; });
          } else if (f.type === 'signature') { /* unchanged here */ }
          else out[f.key] = document.getElementById('cf-' + f.key).value;
        });
        var errs = L.validateCustomValues(fields, out, ticket.status);
        if (errs.length) { toast(t('cf.invalid'), 'error'); btn.disabled = false; return; }
        var r = await sb.from('tickets').update({ custom_values: out }).eq('id', ticket.id);
        if (r.error) throw r.error;
        close(); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  /* v7.10: load child tickets (parent_ticket_id) + show their status. */
  /* v8: related contacts + watchers on the ticket detail page. */
  async function loadTicketPeople(ticket) {
    var cBox = document.getElementById('tk-contacts');
    var wBox = document.getElementById('tk-watchers');
    if (!cBox || !wBox) return;
    try {
      var cr = await sb.from('ticket_contacts').select('*').eq('ticket_id', ticket.id);
      var links = cr.error ? [] : (cr.data || []);
      var linkedC = {};
      links.forEach(function (l) { linkedC[l.contact_id] = true; });
      cBox.innerHTML = links.map(function (l) {
        var c = (state.contacts || []).filter(function (x) { return x.id === l.contact_id; })[0];
        if (!c) return '';
        var nm = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || c.email || '—';
        return '<div class="related-row"><b>' + esc(nm) + '</b> ' +
          (c.company ? '<span class="muted">(' + esc(c.company) + ')</span> ' : '') +
          (c.email ? '<span class="muted">' + esc(c.email) + '</span>' : '') +
          ' <button class="btn-link danger" data-tcdel="' + l.id + '">✕</button></div>';
      }).join('') || '<div class="empty">—</div>';
      var cSel = document.getElementById('tk-contact-add');
      if (cSel) {
        cSel.innerHTML = (state.contacts || []).filter(function (c) { return !linkedC[c.id]; })
          .map(function (c) {
            var nm = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || c.email || '—';
            return '<option value="' + c.id + '">' + esc(nm + (c.company ? ' (' + c.company + ')' : '')) + '</option>';
          }).join('') || '<option value="">' + esc(t('common.none')) + '</option>';
      }
      var wr = await sb.from('ticket_watchers').select('*').eq('ticket_id', ticket.id);
      var watchers = wr.error ? [] : (wr.data || []);
      await resolveNames(watchers.map(function (w) { return w.user_id; }));
      var linkedW = {};
      watchers.forEach(function (w) { linkedW[w.user_id] = true; });
      wBox.innerHTML = watchers.map(function (w) {
        return '<div class="related-row">' + esc(displayName(w.user_id)) +
          ' <button class="btn-link danger" data-twdel="' + w.id + '">✕</button></div>';
      }).join('') || '<div class="empty">—</div>';
      var pr = await sb.from('profiles').select('id,display_name,email,role')
        .eq('is_active', true).order('display_name');
      var wSel = document.getElementById('tk-watcher-add');
      if (wSel && !pr.error) {
        wSel.innerHTML = (pr.data || []).filter(function (u) {
          return u.role !== 'customer' && !linkedW[u.id];
        }).map(function (u) {
          state.nameCache[u.id] = u.display_name || u.email;
          return '<option value="' + u.id + '">' + esc(u.display_name || u.email) + '</option>';
        }).join('') || '<option value="">' + esc(t('common.none')) + '</option>';
      }
      cBox.querySelectorAll('[data-tcdel]').forEach(function (b) {
        b.onclick = async function () {
          await sb.from('ticket_contacts').delete().eq('id', b.getAttribute('data-tcdel'));
          loadTicketPeople(ticket);
        };
      });
      wBox.querySelectorAll('[data-twdel]').forEach(function (b) {
        b.onclick = async function () {
          await sb.from('ticket_watchers').delete().eq('id', b.getAttribute('data-twdel'));
          loadTicketPeople(ticket);
        };
      });
      var caBtn = document.getElementById('tk-contact-add-btn');
      if (caBtn) caBtn.onclick = async function () {
        var cid = cSel && cSel.value;
        if (!cid) return;
        var r = await sb.from('ticket_contacts').insert(
          { ticket_id: ticket.id, contact_id: cid, added_by: state.profile.id });
        if (r.error) { apiError(r.error); return; }
        loadTicketPeople(ticket);
      };
      var cnBtn = document.getElementById('tk-contact-new-btn');
      if (cnBtn) cnBtn.onclick = function () {
        openQuickContactModal(async function (c) {
          if (!c || !c.id) return;
          await sb.from('ticket_contacts').insert(
            { ticket_id: ticket.id, contact_id: c.id, added_by: state.profile.id });
          loadTicketPeople(ticket);
        });
      };
      var waBtn = document.getElementById('tk-watcher-add-btn');
      if (waBtn) waBtn.onclick = async function () {
        var uid = wSel && wSel.value;
        if (!uid) return;
        var r = await sb.from('ticket_watchers').insert(
          { ticket_id: ticket.id, user_id: uid, added_by: state.profile.id });
        if (r.error) { apiError(r.error); return; }
        loadTicketPeople(ticket);
      };
    } catch (e) {
      cBox.innerHTML = '<div class="inline-err">' + esc(e.message || t('common.error')) + '</div>';
    }
  }

  async function loadSubTickets(ticket) {
    var box = document.getElementById('sub-list');
    if (!box) return;
    try {
      var r = await sb.from('tickets').select('id,ticket_no,title,status,tracker,assigned_to')
        .eq('parent_ticket_id', ticket.id).order('created_at');
      if (r.error) throw r.error;
      var rows = r.data || [];
      if (!rows.length) {
        box.innerHTML = '<div class="empty">—</div>';
        return;
      }
      await resolveNames(rows.map(function (x) { return x.assigned_to; }));
      box.innerHTML = rows.map(function (x) {
        return '<div class="related-row">' +
          '<a href="#/ticket/' + x.id + '" class="tnum">' + esc(L.formatTicketNo(x.ticket_no)) + '</a> ' +
          trackerBadge(x.tracker) + ' ' +
          '<span class="ttl">' + esc(x.title) + '</span> ' + statusBadge(x.status) +
          (x.assigned_to ? ' <span class="muted">' + esc(displayName(x.assigned_to)) + '</span>' : '') +
          '</div>';
      }).join('');
    } catch (e) {
      box.innerHTML = '<div class="inline-err">' + esc(e.message || t('common.error')) + '</div>';
    }
  }

  async function renderAssignBox(ticket, done) {
    var box = document.getElementById('assign-box');
    var res;
    try {
      /* v4: extra columns feed the assignment recommendation. */
      res = await sb.from('profiles').select('id,display_name,email,country,country_code,regions,skills,remote_capable')
        .in('role', ['engineer', 'tech_manager']).eq('is_active', true).order('display_name');
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
        /* v6.1: routed support group on the assignee card. */
        (state.v61
          ? '<dt>' + esc(t('detail.assignedGroup')) + '</dt><dd>' +
            esc(ticket.assigned_group_id ? groupName(ticket.assigned_group_id) : '—') + '</dd>'
          : '') +
      '</dl>' +
      (state.v61
        ? '<div class="field"><label>' + esc(t('detail.assignedGroup')) + '</label>' +
          '<select id="assign-group"><option value="">' + esc(t('common.none')) + '</option>' +
          state.groups.filter(function (g) { return g.is_active !== false; }).map(function (g) {
            return '<option value="' + g.id + '"' +
              (ticket.assigned_group_id === g.id ? ' selected' : '') + '>' + esc(g.name) + '</option>';
          }).join('') + '</select></div>'
        : '') +
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
      /* v6.1: the ticket can be routed to a support group even without
         picking an individual engineer. */
      var gsel = document.getElementById('assign-group');
      var gid = gsel ? (gsel.value || null) : null;
      if (!engId && !(state.v61 && gid)) { toast(t('users.pickEngineer'), 'error'); return; }
      var planned = document.getElementById('assign-planned').value;
      var btn = this; btn.disabled = true;
      try {
        var patch = { planned_check_at: planned ? new Date(planned).toISOString() : null };
        if (engId) patch.assigned_to = engId;
        if (state.v61) patch.assigned_group_id = gid;
        // Assigning from "open" also moves the ticket to "assigned" (contract §5).
        if (ticket.status === 'open') patch.status = 'assigned';
        var r = await sb.from('tickets').update(patch).eq('id', ticket.id);
        if (r.error) throw r.error;
        /* v6.2 item 15: notify assignment (single event — the implied
           open→assigned status change does not send a second mail). */
        notifyTicketEvent('ticket_assigned', Object.assign({}, ticket, patch), null);
        /* v8.2: audit events (detail stores 'u:<userId>' / 'g:<groupId>'
           for assignments so names resolve at render time). */
        if (patch.assigned_to) logTicketEvent(ticket.id, 'assigned', 'u:' + patch.assigned_to);
        else if (patch.assigned_group_id) logTicketEvent(ticket.id, 'assigned', 'g:' + patch.assigned_group_id);
        if (patch.status) logTicketEvent(ticket.id, 'status', ticket.status + ' → ' + patch.status);
        toast(t('common.saved'), 'ok');
        done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
    var un = document.getElementById('unassign-btn');
    if (un) un.onclick = async function () {
      if (!window.confirm(t('detail.unassignConfirm'))) return;
      try {
        // "assigned → open" is an allowed transition for dispatcher/admin.
        var allowed = ticketTransitions(ticket, state.profile.role,
          L.transitionCtx(ticket, state.profile));
        if (allowed.indexOf('open') === -1) { toast(t('common.noPermission'), 'error'); return; }
        var r = await sb.from('tickets').update({ assigned_to: null, status: 'open' }).eq('id', ticket.id);
        if (r.error) throw r.error;
        /* v8.2: audit event for the implied status change. */
        logTicketEvent(ticket.id, 'status', ticket.status + ' → open');
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
      contentType: file.type || 'application/octet-stream', upsert: true
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
    /* v7.2: ONE delegated handler on the gallery container. The old
       per-button onclick bindings were attached to nodes built after
       several awaits and were stranded whenever the gallery HTML was
       rebuilt, leaving the ✕ visible but inert. The container node
       itself survives innerHTML rebuilds, and onclick assignment keeps
       repeat renders idempotent. Steps unchanged: confirm → delete the
       ticket_attachments row → remove the storage object → re-render. */
    el.onclick = function (e) {
      var b = e.target;
      while (b && b !== el && !(b.getAttribute && b.getAttribute('data-del'))) b = b.parentNode;
      if (!b || b === el) return;
      var delId = b.getAttribute('data-del'), delPath = b.getAttribute('data-path');
      (async function () {
        if (!window.confirm(t('detail.deletePhotoConfirm'))) return;
        try {
          var dr = await sb.from('ticket_attachments').delete().eq('id', delId);
          if (dr.error) throw dr.error;
          try { await sb.storage.from('ticket-photos').remove([delPath]); } catch (e2) {}
          toast(t('common.deleted'), 'ok');
          render();
        } catch (e3) { apiError(e3); }
      })();
    };
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
    resolved: '✓', closed: '■', status: '⇄', assigned: '↦',
    comment: icon('message', 12), internal: icon('lock', 12), photo: icon('camera', 12)
  };
  /* v8.2: 'open → assigned' style detail → localized status names.
     Unknown keys (custom workflows) fall back to the raw key. */
  var TL_STATUS_KEYS = ['open', 'assigned', 'in_progress', 'on_site',
    'pending_customer', 'resolved', 'closed', 'hq_approval'];
  function statusLabelPair(detail) {
    if (!detail) return '';
    return detail.split(' → ').map(function (s) {
      return TL_STATUS_KEYS.indexOf(s) !== -1 ? t('status.' + s) : s;
    }).join(' → ');
  }
  function renderTimeline(ticket, comments, photos, events) {
    var el = document.getElementById('timeline');
    var ev = [];
    function add(ts, label, kind) { if (ts) ev.push({ ts: ts, label: label, kind: kind || 'created' }); }
    add(ticket.created_at, t('detail.tl.created'), 'created');
    add(ticket.responded_at, t('detail.tl.responded'), 'responded');
    add(ticket.visited_at, t('detail.tl.visited'), 'visited');
    add(ticket.escalated_at, t('detail.tl.escalated'), 'escalated');
    add(ticket.resolved_at || (ticket.status === 'closed' ? ticket.updated_at : null), t('detail.tl.resolved'), 'resolved');
    add(ticket.closed_at, t('detail.tl.closed'), 'closed');
    /* v8.2: audit events (status transitions + assignments). */
    (events || []).forEach(function (e) {
      var who = e.actor_id ? ' — ' + displayName(e.actor_id) : '';
      if (e.kind === 'status') {
        add(e.created_at, t('detail.tl.status') + ': ' + statusLabelPair(e.detail) + who, 'status');
      } else if (e.kind === 'assigned') {
        var target = '';
        if (e.detail && e.detail.indexOf('u:') === 0) target = displayName(e.detail.slice(2));
        else if (e.detail && e.detail.indexOf('g:') === 0) target = groupName(e.detail.slice(2));
        else target = e.detail || '';
        add(e.created_at, t('detail.tl.assigned') + ': ' + target + who, 'assigned');
      }
    });
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
  async function printServiceReport(ticket, comments, attachments, events) {
    attachments = attachments || [];
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
    /* v8.2: audit status transitions join the printed history. */
    (events || []).forEach(function (e) {
      if (e.kind === 'status') hadd(e.created_at, t('detail.tl.status') + ': ' + statusLabelPair(e.detail));
    });
    hist.sort(function (a, b) { return new Date(a.ts) - new Date(b.ts); });
    /* public comments only */
    var pubComments = (comments || []).filter(function (c) { return !c.is_internal; });
    /* v7.12/7.14: photos for the report (signed URLs, images only) + custom fields. */
    var imgRows = attachments.filter(function (a) {
      return (a.content_type || '').indexOf('image/') === 0 && a.storage_path;
    });
    var imgUrls = [];
    for (var ii = 0; ii < imgRows.slice(0, 12).length; ii++) {
      try {
        var sg = await sb.storage.from('ticket-photos').createSignedUrl(imgRows[ii].storage_path, 3600);
        if (!sg.error && sg.data) imgUrls.push(sg.data.signedUrl);
      } catch (e) {}
    }
    var cfFields = state.v7 ? (state.customFields || []).filter(function (f) {
      return f.trackers && f.trackers.indexOf(ticket.tracker) !== -1 && f.is_active !== false;
    }) : [];
    var cfVals = ticket.custom_values || {};
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
        row(t('detail.source'), sourceLabel(ticket.source)) +
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
      (cfFields.length
        ? '<h2>' + esc(t('cf.title')) + '</h2><table><tbody>' +
          cfFields.map(function (f) {
            var label = lang === 'zh' ? (f.label_zh || f.label_en) : (f.label_en || f.label_zh);
            var v = cfVals[f.key];
            var disp = Array.isArray(v) ? v.join(', ') : (v == null || v === '' ? '—' : String(v));
            return row(label, disp);
          }).join('') + '</tbody></table>'
        : '') +
      (imgUrls.length
        ? '<h2>' + esc(t('detail.photos')) + '</h2>' +
          '<div>' + imgUrls.map(function (u) {
            return '<img src="' + esc(u) + '" style="max-width:300px;max-height:220px;margin:4px;border:1px solid #ddd">';
          }).join('') + '</div>'
        : '') +
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
      .in('role', ['engineer', 'tech_manager']).eq('is_active', true).order('display_name');
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
    /* v8 (#17): sources come from the maintained dictionary. */
    var sources = role === 'customer'
      ? ['customer_feedback']
      : state.sources.map(function (s) { return s.key; });
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
            return '<option value="' + esc(s) + '">' + esc(sourceLabel(s)) + '</option>';
          }).join('') + '</select>' +
          (isCustomer ? '<div class="hint">' + esc(t('new.sourceHint.customer')) + '</div>' : '') + '</div>' +
        /* v7.7: tracker selection (hidden until migration_v7).
           v8 (#19/#21): options come from the governed tracker registry. */
        (state.v7
          ? '<div class="field"><label>' + esc(t('new.tracker')) + '</label>' +
            '<select id="nt-tracker">' + state.trackers.map(function (tr) {
              return '<option value="' + esc(tr.key) + '"' + (tr.key === 'support' ? ' selected' : '') + '>' +
                esc(trackerName(tr.key)) + '</option>';
            }).join('') + '</select></div>'
          : '') +
        '<div class="field"><label>' + esc(t('new.field.site')) + star('nt-site') + '</label>' +
          '<select id="nt-site"' + reqAttr('nt-site') + '><option value="">' + esc(t('common.none')) + '</option>' +
          state.sites.map(function (s) {
            return '<option value="' + s.id + '">' + esc(s.code + ' — ' + s.name) + '</option>';
          }).join('') + '</select>' +
          '<div class="inline-err" id="nt-contract-notice" style="display:none;margin-top:8px;margin-bottom:0">' +
            esc(t('new.contractNotice')) + '</div></div>' +
        /* v6.1: support group assignment — defaults to the site's
           default group (Massimo's dispatch rule). */
        (state.v61
          ? '<div class="field"><label>' + esc(t('new.field.group')) + '</label>' +
            '<select id="nt-group"><option value="">' + esc(t('common.none')) + '</option>' +
            state.groups.filter(function (g) { return g.is_active !== false; }).map(function (g) {
              return '<option value="' + g.id + '">' + esc(g.name) + '</option>';
            }).join('') + '</select></div>'
          : '') +
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
        /* v8 (tier-2 variant): related contacts + internal watchers.
           Contacts are external people (no account needed); watchers are
           internal users only — external mail stays on the customer
           channel by design. */
        (state.v8tc && !isCustomer
          ? '<div class="field span2"><label>' + esc(t('new.contacts')) + '</label>' +
            '<input type="text" id="nt-contact-q" placeholder="' + esc(t('new.contactsPh')) + '">' +
            '<div id="nt-contacts" class="check-list"></div>' +
            '<button type="button" class="btn btn-sm" id="nt-contact-new">+ ' + esc(t('contacts.new')) + '</button></div>' +
            '<div class="field span2"><label>' + esc(t('new.watchers')) + '</label>' +
            '<div id="nt-watchers" class="check-list"><span class="muted">' + esc(t('common.loading')) + '</span></div></div>'
          : '') +
        '<div class="form-actions span2">' +
          '<button type="submit" class="btn btn-primary" id="nt-submit">' + esc(t('common.create')) + '</button>' +
          '<button type="button" class="btn" id="nt-cancel">' + esc(t('common.cancel')) + '</button>' +
        '</div>' +
      '</form></div>';
    document.getElementById('nt-cancel').onclick = function () { nav('#/tickets'); };
    /* v8: contacts/watchers picker state + rendering. */
    var ntContactSel = {};
    var ntWatcherSel = {};
    function renderNtContacts() {
      var box = document.getElementById('nt-contacts');
      if (!box) return;
      var q = (document.getElementById('nt-contact-q').value || '').trim().toLowerCase();
      var list = (state.contacts || []).filter(function (c) {
        if (!q) return true;
        return (((c.first_name || '') + ' ' + (c.last_name || '') + ' ' +
          (c.company || '') + ' ' + (c.email || '')).toLowerCase().indexOf(q) !== -1);
      }).slice(0, 30);
      box.innerHTML = list.map(function (c) {
        var nm = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || c.email || '—';
        return '<label><input type="checkbox" class="nt-contact" value="' + c.id + '"' +
          (ntContactSel[c.id] ? ' checked' : '') + '> ' + esc(nm) +
          (c.company ? ' <span class="muted">(' + esc(c.company) + ')</span>' : '') + '</label>';
      }).join('') || '<span class="muted">' + esc(t('contacts.none')) + '</span>';
      box.querySelectorAll('.nt-contact').forEach(function (cb) {
        cb.onchange = function () { ntContactSel[cb.value] = cb.checked; };
      });
    }
    if (state.v8tc && !isCustomer) {
      renderNtContacts();
      document.getElementById('nt-contact-q').oninput = renderNtContacts;
      document.getElementById('nt-contact-new').onclick = function () {
        openQuickContactModal(function (c) {
          if (c && c.id) { ntContactSel[c.id] = true; renderNtContacts(); }
        });
      };
      sb.from('profiles').select('id,display_name,email,role').eq('is_active', true)
        .order('display_name').then(function (r) {
          var box = document.getElementById('nt-watchers');
          if (!box) return;
          var users = (r.error ? [] : (r.data || [])).filter(function (u) {
            return u.role !== 'customer' && u.id !== state.profile.id;
          });
          box.innerHTML = users.map(function (u) {
            state.nameCache[u.id] = u.display_name || u.email;
            return '<label><input type="checkbox" class="nt-watcher" value="' + u.id + '"> ' +
              esc(u.display_name || u.email) + ' <span class="muted">(' + esc(t('role.' + u.role)) + ')</span></label>';
          }).join('') || '<span class="muted">—</span>';
          box.querySelectorAll('.nt-watcher').forEach(function (cb) {
            cb.onchange = function () { ntWatcherSel[cb.value] = cb.checked; };
          });
        });
    }
    /* v2 R3: a site with an active LTSA contract forces is_ltsa + urgent + contract SLA. */
    var siteSel = document.getElementById('nt-site');
    var priSel = document.getElementById('nt-priority');
    /* v4: apply the planning workbench prefill (site). */
    if (newTicketPrefill && newTicketPrefill.siteId) {
      siteSel.value = newTicketPrefill.siteId;
    }
    /* v7.10: sub-ticket prefill (parent + tracker + title). */
    if (newTicketPrefill && newTicketPrefill.parentTicketId) {
      if (newTicketPrefill.tracker) {
        var tsel = document.getElementById('nt-tracker');
        if (tsel) tsel.value = newTicketPrefill.tracker;
      }
      if (newTicketPrefill.title) {
        var tti = document.getElementById('nt-title');
        if (tti && !tti.value) tti.value = newTicketPrefill.title;
      }
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
      /* v6.1: route to the site's default support group. */
      var gsel = document.getElementById('nt-group');
      if (gsel) {
        var st = state.sites.filter(function (x) { return x.id === siteSel.value; })[0];
        gsel.value = (st && st.default_group_id) || '';
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
        /* v7.7/7.8: tracker + workflow key (from site segment), parent for sub-tickets. */
        var trackerEl = document.getElementById('nt-tracker');
        var trackerVal = trackerEl ? trackerEl.value : 'support';
        var siteRow = siteVal ? state.sites.filter(function (s) { return s.id === siteVal; })[0] : null;
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
        if (state.v7) {
          insData.tracker = trackerVal;
          /* v8 (#22): tracker binding wins, then segment binding. */
          insData.workflow_key = L.resolveWorkflowKey(
            trackerByKey(trackerVal), siteRow && siteRow.segment, state.segments);
          if (newTicketPrefill && newTicketPrefill.parentTicketId) {
            insData.parent_ticket_id = newTicketPrefill.parentTicketId;
          }
        }
        if (state.v3) {
          var tagEl = document.getElementById('nt-tags');
          insData.tags = tagEl ? parseTags(tagEl.value) : [];
        }
        /* v6.1: support group routing (manual pick or site default). */
        if (state.v61) {
          var gEl = document.getElementById('nt-group');
          insData.assigned_group_id = gEl ? (gEl.value || null)
            : ((siteRow && siteRow.default_group_id) || null);
        }
        var ins = await sb.from('tickets').insert(insData).select('id,ticket_no').single();
        if (ins.error) throw ins.error;
        /* v8: persist related contacts + watchers chosen on the form. */
        if (state.v8tc) {
          try {
            var wRows = Object.keys(ntWatcherSel).filter(function (k) { return ntWatcherSel[k]; })
              .map(function (uid) { return { ticket_id: ins.data.id, user_id: uid, added_by: state.profile.id }; });
            if (wRows.length) await sb.from('ticket_watchers').insert(wRows);
            var cRows = Object.keys(ntContactSel).filter(function (k) { return ntContactSel[k]; })
              .map(function (cid) { return { ticket_id: ins.data.id, contact_id: cid, added_by: state.profile.id }; });
            if (cRows.length) await sb.from('ticket_contacts').insert(cRows);
          } catch (e) { /* links are best-effort; the ticket itself is saved */ }
        }
        /* v6.2 item 15: notify creation (creator is excluded by the
           notifier itself — they don't need mail about their own action). */
        notifyTicketEvent('ticket_created',
          Object.assign({}, insData, { id: ins.data.id, ticket_no: ins.data.ticket_no }), null);
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
      /* v8 (#7): the user's support groups, from group_members. */
      var ugroups = (state.groupMembers || [])
        .filter(function (m) { return m.member_type === 'profile' && m.member_id === u.id; })
        .map(function (m) { return groupName(m.group_id); }).filter(Boolean).join(', ') || '—';
      var main = '<tr>' +
        '<td><b>' + esc(u.display_name || '—') + '</b><br><span class="muted">' + esc(u.email || '') + '</span></td>' +
        '<td>' + esc(t('role.' + u.role)) + '</td>' +
        '<td>' + certBadge(u.cert_level) + '</td>' +
        '<td class="muted">' + esc(u.country || '—') + '</td>' +
        '<td class="muted">' + esc(scope) + '</td>' +
        '<td class="muted">' + esc(ugroups) + '</td>' +
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
      if (state.v4 && (u.role === 'engineer' || u.role === 'tech_manager')) {
        var ccVal = ((u.country_code || u.country) || '').toUpperCase();
        extra = '<tr class="eng-extra" data-engrow="' + u.id + '"><td colspan="8">' +
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
      /* v8 (#7): group memberships visible next to the project scope */
      '<th>' + esc(t('nav.groups')) + '</th>' +
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
      var statusBadge = (s.status && s.status !== 'active')
        ? '<span class="badge status-closed">' + esc(t('sites.status.' + s.status)) + '</span> '
        : '';
      return '<div class="tree-node clickable" data-site="' + s.id + '"' +
        ' style="padding-left:' + (12 + depth * 26) + 'px">' +
        '<span class="tcode">' + esc(s.code) + '</span>' +
        '<span class="tname">' + esc(s.name) + '</span>' +
        '<span class="grow"></span>' + statusBadge +
        contractBadgeFor(contract) +
        '<span class="badge status-open">' + (counts[s.id] || 0) + ' ' + esc(t('sites.openTickets')) + '</span>' +
        '<span class="muted" style="font-size:12px">' +
          esc(s.remote_owner_group_id ? ('👥 ' + groupName(s.remote_owner_group_id)) : displayName(s.remote_owner_id)) + '</span>' +
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
    /* v8 (#9): engineers get this page read-only (site.view without
       site.manage) — creation and the customer register stay gated. */
    var canManageSites = L.can('site.manage', state.profile.role);
    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('sites.title')) + '</h1>' +
      (canManageSites
        ? '<button class="btn btn-primary" id="site-new">+ ' + esc(t('sites.new')) + '</button>'
        : '<span class="muted">' + esc(t('sites.readOnly')) + '</span>') + '</div>' +
      '<div class="card"><h2 class="section-title">' + esc(t('sites.tree')) + '</h2>' +
      '<div class="field" style="max-width:360px"><input type="text" id="site-q" placeholder="' +
        esc(t('sites.searchPh')) + '" value="' + esc(state.siteSearch || '') + '"></div>' +
      '<div id="site-tree">' + bodyHtml + '</div></div>' +
      (state.v3 && canManageSites ? '<div class="card" id="customers-card"></div>' : '');
    var deb = null;
    document.getElementById('site-q').oninput = function () {
      var v = this.value;
      clearTimeout(deb);
      deb = setTimeout(function () { state.siteSearch = v; render(); }, 400);
    };
    var siteNewBtn = document.getElementById('site-new');
    if (siteNewBtn) siteNewBtn.onclick = function () {
      openSiteModal(null, function () { render(); });
    };
    view.querySelectorAll('[data-site]').forEach(function (el) {
      el.onclick = function () { nav('#/site/' + el.getAttribute('data-site')); };
    });
    if (state.v3 && canManageSites) renderCustomersCard();
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
  /* ================= v6.2: contacts (external, independent of profiles) ==== */
  async function viewContacts(view) {
    if (!state.v6) {
      view.innerHTML = '<div class="page"><div class="inline-err">' +
        esc(t('common.migrationRequired').replace('{v}', 'v6')) + '</div></div>';
      return;
    }
    var q = (viewContacts._q || '').trim().toLowerCase();
    var list = state.contacts.filter(function (c) {
      if (!q) return true;
      return ((c.first_name || '') + ' ' + (c.last_name || '') + ' ' +
              (c.company || '') + ' ' + (c.email || '')).toLowerCase().indexOf(q) !== -1;
    });
    var siteMap = {};
    state.sites.forEach(function (s) { siteMap[s.id] = s; });
    var projByContact = {};
    state.contactProjects.forEach(function (r) {
      (projByContact[r.contact_id] = projByContact[r.contact_id] || []).push(r.site_id);
    });
    var rows = list.map(function (c) {
      var projs = (projByContact[c.id] || []).map(function (sid) {
        var s = siteMap[sid]; return s ? esc(s.code) : null;
      }).filter(Boolean).join(', ') || '<span class="muted">—</span>';
      return '<tr><td><b>' + esc(((c.first_name || '') + ' ' + (c.last_name || '')).trim() || '—') + '</b></td>' +
        '<td class="muted">' + esc(c.company || '—') + '</td>' +
        '<td class="muted">' + esc(c.role || '—') + '</td>' +
        '<td class="muted">' + esc(c.phone || '—') + '</td>' +
        '<td class="muted">' + esc(c.email || '—') + '</td>' +
        '<td>' + badge(c.is_active === false ? 'status-closed' : 'sla-ok',
            t(c.is_active === false ? 'contacts.inactive' : 'contacts.active')) + '</td>' +
        '<td class="muted">' + projs + '</td>' +
        '<td><button class="btn btn-sm" data-cedit="' + c.id + '">' + esc(t('common.edit')) + '</button> ' +
        '<button class="btn btn-sm btn-danger" data-cdel="' + c.id + '">' + esc(t('common.delete')) + '</button></td></tr>';
    }).join('');
    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('contacts.title')) + '</h1>' +
      '<button class="btn btn-primary" id="contact-new">+ ' + esc(t('contacts.new')) + '</button></div>' +
      '<p class="muted">' + esc(t('contacts.sub')) + '</p>' +
      '<div class="card"><div style="margin-bottom:10px">' +
      '<input type="text" id="contact-q" class="input" style="max-width:320px" placeholder="' +
        esc(t('contacts.searchPh')) + '" value="' + esc(viewContacts._q || '') + '"></div>' +
      '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
      '<th>' + esc(t('contacts.firstName')) + '</th><th>' + esc(t('contacts.company')) + '</th>' +
      '<th>' + esc(t('contacts.role')) + '</th><th>' + esc(t('contacts.phone')) + '</th>' +
      '<th>' + esc(t('contacts.email')) + '</th><th>' + esc(t('contacts.active')) + '</th>' +
      '<th>' + esc(t('contacts.projects')) + '</th><th>' + esc(t('common.actions')) + '</th>' +
      '</tr></thead><tbody>' +
      (rows || '<tr><td colspan="8"><div class="empty">' + esc(t('contacts.none')) + '</div></td></tr>') +
      '</tbody></table></div></div>';
    document.getElementById('contact-q').oninput = function (e) {
      viewContacts._q = e.target.value;
      var pos = e.target.selectionStart;
      viewContacts(view);
      var el = document.getElementById('contact-q');
      if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    };
    document.getElementById('contact-new').onclick = function () {
      openContactModal(null, function () { loadReferenceData().then(function () { viewContacts(view); }); });
    };
    view.querySelectorAll('[data-cedit]').forEach(function (b) {
      b.onclick = function () {
        var c = state.contacts.filter(function (x) { return x.id === b.getAttribute('data-cedit'); })[0];
        openContactModal(c, function () { loadReferenceData().then(function () { viewContacts(view); }); });
      };
    });
    view.querySelectorAll('[data-cdel]').forEach(function (b) {
      b.onclick = async function () {
        var c = state.contacts.filter(function (x) { return x.id === b.getAttribute('data-cdel'); })[0];
        if (!c || !window.confirm(t('contacts.confirmDelete'))) return;
        var r = await sb.from('contacts').delete().eq('id', c.id);
        if (r.error) { apiError(r.error); return; }
        toast(t('contacts.deleted'), 'ok');
        await loadReferenceData(); viewContacts(view);
      };
    });
  }

  /* v6.1: support groups — people (login profiles and/or external
     contacts) grouped for ticket dispatch (Massimo's dispatch rules).
     Gated on state.v61 (migration_v6_1). */
  function groupMemberName(m) {
    if (m.member_type === 'contact') {
      var c = state.contacts.filter(function (x) { return x.id === m.member_id; })[0];
      if (!c) return m.member_id;
      var nm = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || c.email || m.member_id;
      return nm + (c.company ? ' · ' + c.company : '');
    }
    return displayName(m.member_id);
  }

  function groupName(id) {
    var g = state.groups.filter(function (x) { return x.id === id; })[0];
    return g ? g.name : (id ? id.slice(0, 8) + '…' : t('common.unassigned'));
  }

  async function viewGroups(view) {
    if (!state.v61) {
      view.innerHTML = '<div class="page"><div class="inline-err">' +
        esc(t('common.migrationRequired').replace('{v}', 'v6.1')) + '</div></div>';
      return;
    }
    var needIds = [];
    state.groupMembers.forEach(function (m) {
      if (m.member_type === 'profile' && !state.nameCache[m.member_id]) needIds.push(m.member_id);
    });
    if (needIds.length) await resolveNames(needIds);
    var memByGroup = {};
    state.groupMembers.forEach(function (m) {
      (memByGroup[m.group_id] = memByGroup[m.group_id] || []).push(m);
    });
    var rows = state.groups.map(function (g) {
      /* v8 (#6): projects linked to this group. */
      var gprojects = (state.groupSites || [])
        .filter(function (gs) { return gs.group_id === g.id; })
        .map(function (gs) { return siteShort(gs.site_id); }).filter(Boolean).join(', ') || '—';
      return '<tr><td><b>' + esc(g.name) + '</b></td>' +
        '<td class="muted">' + esc(g.description || '—') + '</td>' +
        '<td class="muted">' + esc(gprojects) + '</td>' +
        '<td>' + (memByGroup[g.id] || []).length + '</td>' +
        '<td>' + badge(g.is_active === false ? 'status-closed' : 'sla-ok',
            t(g.is_active === false ? 'groups.inactive' : 'groups.active')) + '</td>' +
        '<td><button class="btn btn-sm" data-gmem="' + g.id + '">' + esc(t('groups.members')) + '</button> ' +
        '<button class="btn btn-sm" data-gedit="' + g.id + '">' + esc(t('common.edit')) + '</button> ' +
        '<button class="btn btn-sm btn-danger" data-gdel="' + g.id + '">' + esc(t('common.delete')) + '</button></td></tr>';
    }).join('');
    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('groups.title')) + '</h1>' +
      '<button class="btn btn-primary" id="group-new">+ ' + esc(t('groups.new')) + '</button></div>' +
      '<p class="muted">' + esc(t('groups.sub')) + '</p>' +
      '<div class="card"><div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
      '<th>' + esc(t('groups.name')) + '</th><th>' + esc(t('groups.description')) + '</th>' +
      '<th>' + esc(t('groups.projects')) + '</th>' +
      '<th>' + esc(t('groups.members')) + '</th><th>' + esc(t('groups.active')) + '</th>' +
      '<th>' + esc(t('common.actions')) + '</th>' +
      '</tr></thead><tbody>' +
      (rows || '<tr><td colspan="6"><div class="empty">' + esc(t('groups.none')) + '</div></td></tr>') +
      '</tbody></table></div></div>';
    function refresh() { loadReferenceData().then(function () { viewGroups(view); }); }
    document.getElementById('group-new').onclick = function () {
      openGroupModal(null, refresh);
    };
    view.querySelectorAll('[data-gedit]').forEach(function (b) {
      b.onclick = function () {
        var g = state.groups.filter(function (x) { return x.id === b.getAttribute('data-gedit'); })[0];
        openGroupModal(g, refresh);
      };
    });
    view.querySelectorAll('[data-gmem]').forEach(function (b) {
      b.onclick = function () {
        var g = state.groups.filter(function (x) { return x.id === b.getAttribute('data-gmem'); })[0];
        openGroupMembersModal(g, refresh);
      };
    });
    view.querySelectorAll('[data-gdel]').forEach(function (b) {
      b.onclick = async function () {
        var g = state.groups.filter(function (x) { return x.id === b.getAttribute('data-gdel'); })[0];
        if (!g || !window.confirm(t('groups.confirmDelete'))) return;
        var r = await sb.from('groups').delete().eq('id', g.id);
        if (r.error) { apiError(r.error); return; }
        toast(t('groups.deleted'), 'ok');
        refresh();
      };
    });
  }

  function openGroupModal(group, done) {
    group = group || {};
    /* v8 (#6): a group can be linked to projects (group_sites). */
    var linkedSites = {};
    (state.groupSites || []).forEach(function (gs) {
      if (group.id && gs.group_id === group.id) linkedSites[gs.site_id] = true;
    });
    var body =
      '<div class="field"><label>' + esc(t('groups.name')) + '<span class="req">*</span></label>' +
        '<input type="text" id="g-name" value="' + esc(group.name || '') + '"></div>' +
      '<div class="field"><label>' + esc(t('groups.description')) + '</label>' +
        '<textarea id="g-desc" style="height:52px">' + esc(group.description || '') + '</textarea></div>' +
      (state.v8
        ? '<div class="field"><label>' + esc(t('groups.projects')) + '</label>' +
          '<div class="check-list">' +
          state.sites.map(function (s) {
            return '<label><input type="checkbox" class="g-site" value="' + s.id + '"' +
              (linkedSites[s.id] ? ' checked' : '') + '> ' + esc(s.code + ' — ' + s.name) + '</label>';
          }).join('') + '</div></div>'
        : '') +
      '<div class="field"><label><input type="checkbox" id="g-active"' +
        (group.is_active !== false ? ' checked' : '') + '> ' + esc(t('groups.active')) + '</label></div>';
    var close = openModal(group.id ? t('groups.edit') : t('groups.new'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var row = {
          name: document.getElementById('g-name').value.trim(),
          description: document.getElementById('g-desc').value.trim() || null,
          is_active: document.getElementById('g-active').checked
        };
        if (!row.name) { toast(t('new.fillRequired'), 'error'); btn.disabled = false; return; }
        var gid = group.id;
        if (gid) {
          var ru = await sb.from('groups').update(row).eq('id', gid);
          if (ru.error) throw ru.error;
        } else {
          var ri = await sb.from('groups').insert(row).select('id');
          if (ri.error) throw ri.error;
          gid = ri.data && ri.data[0] && ri.data[0].id;
        }
        /* v8 (#6): rewrite this group's project links. */
        if (state.v8 && gid) {
          var want = {};
          document.querySelectorAll('.g-site:checked').forEach(function (c) { want[c.value] = true; });
          await sb.from('group_sites').delete().eq('group_id', gid);
          var ids = Object.keys(want);
          if (ids.length) {
            var rl = await sb.from('group_sites').insert(
              ids.map(function (sid) { return { group_id: gid, site_id: sid }; }));
            if (rl.error) throw rl.error;
          }
        }
        toast(t('groups.saved'), 'ok');
        close(); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  async function openGroupMembersModal(group, done) {
    var pr = await sb.from('profiles').select('id,display_name,email,role')
      .eq('is_active', true).order('display_name');
    var profiles = pr.error ? [] : (pr.data || []).filter(function (u) { return u.role !== 'customer'; });
    profiles.forEach(function (u) { state.nameCache[u.id] = u.display_name || u.email; });
    function memberRow(m) {
      return '<div class="li" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">' +
        '<div style="flex:1"><b>' + esc(groupMemberName(m)) + '</b>' +
        '<div class="muted" style="font-size:12px">' + esc(t('groups.type.' + m.member_type)) +
        (m.role ? ' · ' + esc(m.role) : '') + '</div></div>' +
        '<button class="btn btn-sm btn-danger" data-mdel="' + m.member_type + ':' + m.member_id + '">' +
        esc(t('groups.remove')) + '</button></div>';
    }
    var mems = state.groupMembers.filter(function (m) { return m.group_id === group.id; });
    var body =
      '<div id="gm-list">' +
      (mems.map(memberRow).join('') || '<div class="empty">' + esc(t('groups.noMembers')) + '</div>') + '</div>' +
      '<div class="form-row" style="margin-top:14px">' +
        '<div class="field"><label>' + esc(t('groups.memberType')) + '</label>' +
          '<select id="gm-type"><option value="profile">' + esc(t('groups.type.profile')) + '</option>' +
          '<option value="contact">' + esc(t('groups.type.contact')) + '</option></select></div>' +
        '<div class="field"><label>' + esc(t('groups.member')) + '</label>' +
          '<select id="gm-member"></select></div>' +
      '</div>' +
      '<div class="field"><label>' + esc(t('groups.role')) + '</label>' +
        '<input type="text" id="gm-role" placeholder="' + esc(t('groups.rolePh')) + '"></div>';
    var close = openModal(t('groups.members') + ' — ' + group.name, body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="gm-add">' + esc(t('groups.addMember')) + '</button>');
    function fillMembers() {
      var type = document.getElementById('gm-type').value;
      var sel = document.getElementById('gm-member');
      var taken = {};
      state.groupMembers.forEach(function (m) {
        if (m.group_id === group.id && m.member_type === type) taken[m.member_id] = true;
      });
      var opts = '';
      if (type === 'profile') {
        opts = profiles.filter(function (u) { return !taken[u.id]; }).map(function (u) {
          return '<option value="' + u.id + '">' + esc((u.display_name || u.email) + ' (' + t('role.' + u.role) + ')') + '</option>';
        }).join('');
      } else {
        opts = state.contacts.filter(function (c) { return !taken[c.id]; }).map(function (c) {
          return '<option value="' + c.id + '">' +
            esc(((c.first_name || '') + ' ' + (c.last_name || '')).trim() || c.email || c.id) + '</option>';
        }).join('');
      }
      sel.innerHTML = opts || '<option value="">' + esc(t('common.none')) + '</option>';
    }
    document.getElementById('gm-type').onchange = fillMembers;
    fillMembers();
    document.getElementById('m-cancel').onclick = close;
    document.getElementById('gm-add').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var mid = document.getElementById('gm-member').value;
        if (!mid) { toast(t('groups.pickMember'), 'error'); btn.disabled = false; return; }
        var r = await sb.from('group_members').insert({
          group_id: group.id,
          member_type: document.getElementById('gm-type').value,
          member_id: mid,
          role: document.getElementById('gm-role').value.trim() || null
        });
        if (r.error) throw r.error;
        toast(t('groups.saved'), 'ok');
        close(); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
    document.getElementById('gm-list').querySelectorAll('[data-mdel]').forEach(function (b) {
      b.onclick = async function () {
        var parts = b.getAttribute('data-mdel').split(':');
        var r = await sb.from('group_members').delete()
          .eq('group_id', group.id).eq('member_type', parts[0]).eq('member_id', parts[1]);
        if (r.error) { apiError(r.error); return; }
        toast(t('groups.saved'), 'ok');
        close(); done();
      };
    });
  }

  /* v7.8: workflow management — states CRUD + transition matrix per
     template (C&I / Utility). DB rows drive ticketTransitions() at runtime. */
  /* v6.2 item 15: email notification admin — send log, templates,
     switches, test send. Gated on state.v62 (migration_v6_2). */
  /* ================= v8: settings (dictionaries + trackers) ============
   * #10/#17: Segment and Source dictionaries are maintained here and
   * stored as JSON in app_settings; forms read the merged registry from
   * logic.js, so defaults apply until something is saved here.
   * #21/#22 (governed): trackers are created/edited ONLY here, by
   * tracker.manage holders (admin + dispatcher since v8.1) — each
   * tracker binds a status workflow and the custom fields already
   * bind per tracker on the Fields page. */
  async function viewSettings(view) {
    var wfKeys = ['ci', 'utility'];
    (state.wfStates || []).forEach(function (s) {
      if (wfKeys.indexOf(s.workflow_key) === -1) wfKeys.push(s.workflow_key);
    });
    function wfOptions(sel) {
      return '<option value="">' + esc(t('common.none')) + '</option>' + wfKeys.map(function (k) {
        return '<option value="' + esc(k) + '"' + (sel === k ? ' selected' : '') + '>' + esc(k) + '</option>';
      }).join('');
    }
    function dictRows(kind, items, withWorkflow) {
      return items.map(function (it, i) {
        return '<tr>' +
          '<td><input type="text" class="ds-key" data-k="' + kind + '" data-i="' + i + '" value="' + esc(it.key) + '"></td>' +
          '<td><input type="text" class="ds-en" data-k="' + kind + '" data-i="' + i + '" value="' + esc(it.name_en || '') + '"></td>' +
          '<td><input type="text" class="ds-zh" data-k="' + kind + '" data-i="' + i + '" value="' + esc(it.name_zh || '') + '"></td>' +
          (withWorkflow
            ? '<td><select class="ds-wf" data-k="' + kind + '" data-i="' + i + '">' + wfOptions(it.workflow_key || '') + '</select></td>'
            : '') +
          '<td><button class="btn btn-sm btn-danger" data-dsdel="' + kind + ':' + i + '">' + esc(t('common.delete')) + '</button></td></tr>';
      }).join('');
    }
    var canTrackers = L.can('tracker.manage', state.profile.role);
    var trackerRows = (state.trackers || []).map(function (tr, i) {
      return '<tr>' +
        '<td><input type="text" class="tk-key" data-i="' + i + '" value="' + esc(tr.key) + '"></td>' +
        '<td><input type="text" class="tk-en" data-i="' + i + '" value="' + esc(tr.name_en || '') + '"></td>' +
        '<td><input type="text" class="tk-zh" data-i="' + i + '" value="' + esc(tr.name_zh || '') + '"></td>' +
        '<td><input type="text" class="tk-prefix" data-i="' + i + '" value="' + esc(tr.prefix || '') + '" style="width:64px"></td>' +
        '<td><input type="color" class="tk-color" data-i="' + i + '" value="' + esc(tr.color || '#4f8ef7') + '"></td>' +
        '<td><select class="tk-wf" data-i="' + i + '">' + wfOptions(tr.workflow_key || '') + '</select></td>' +
        '<td><button class="btn btn-sm btn-danger" data-tkdel="' + i + '">' + esc(t('common.delete')) + '</button></td></tr>';
    }).join('');
    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('settings.title')) + '</h1></div>' +
      '<div class="card"><h2 class="section-title">' + esc(t('settings.dictTitle')) + '</h2>' +
      '<p class="muted">' + esc(t('settings.dictSub')) + '</p>' +
      '<h3>' + esc(t('sites.segment')) + '</h3>' +
      '<table class="tbl"><thead><tr><th>Key</th><th>EN</th><th>中文</th><th>' + esc(t('settings.workflow')) + '</th><th></th></tr></thead>' +
      '<tbody id="ds-segments">' + dictRows('segments', state.segments, true) + '</tbody></table>' +
      '<button class="btn btn-sm" id="ds-seg-add">+ ' + esc(t('settings.addRow')) + '</button>' +
      '<h3 style="margin-top:18px">' + esc(t('settings.sources')) + '</h3>' +
      '<table class="tbl"><thead><tr><th>Key</th><th>EN</th><th>中文</th><th></th></tr></thead>' +
      '<tbody id="ds-sources">' + dictRows('sources', state.sources, false) + '</tbody></table>' +
      '<button class="btn btn-sm" id="ds-src-add">+ ' + esc(t('settings.addRow')) + '</button>' +
      '<div class="form-actions"><button class="btn btn-primary" id="ds-save">' + esc(t('common.save')) + '</button></div></div>' +
      (canTrackers
        ? '<div class="card"><h2 class="section-title">' + esc(t('settings.trackers')) + '</h2>' +
          '<p class="muted">' + esc(t('settings.trackersSub')) + '</p>' +
          '<table class="tbl"><thead><tr><th>Key</th><th>EN</th><th>中文</th><th>' + esc(t('settings.prefix')) + '</th>' +
          '<th>' + esc(t('settings.color')) + '</th><th>' + esc(t('settings.workflow')) + '</th><th></th></tr></thead>' +
          '<tbody id="tk-body">' + trackerRows + '</tbody></table>' +
          '<button class="btn btn-sm" id="tk-add">+ ' + esc(t('settings.addRow')) + '</button>' +
          '<div class="form-actions"><button class="btn btn-primary" id="tk-save">' + esc(t('common.save')) + '</button></div></div>'
        : '');
    function collectDict(kind, withWorkflow) {
      var out = [];
      view.querySelectorAll('.ds-key[data-k="' + kind + '"]').forEach(function (inp) {
        var i = inp.getAttribute('data-i');
        var key = inp.value.trim();
        if (!key) return;
        var item = {
          key: key,
          name_en: view.querySelector('.ds-en[data-k="' + kind + '"][data-i="' + i + '"]').value.trim(),
          name_zh: view.querySelector('.ds-zh[data-k="' + kind + '"][data-i="' + i + '"]').value.trim()
        };
        if (withWorkflow) {
          item.workflow_key = view.querySelector('.ds-wf[data-k="' + kind + '"][data-i="' + i + '"]').value || '';
        }
        out.push(item);
      });
      return out;
    }
    async function saveSettingsKey(key, value) {
      var r = await sb.from('app_settings').upsert({ key: key, value: value }, { onConflict: 'key' });
      if (r.error) throw r.error;
      state.appSettings[key] = value;
    }
    view.querySelectorAll('[data-dsdel]').forEach(function (b) {
      b.onclick = function () {
        var row = b.closest('tr'); if (row) row.remove();
      };
    });
    function addDictRow(kind, withWorkflow) {
      var tb = document.getElementById(kind === 'segments' ? 'ds-segments' : 'ds-sources');
      var i = 'n' + Date.now();
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td><input type="text" class="ds-key" data-k="' + kind + '" data-i="' + i + '" value=""></td>' +
        '<td><input type="text" class="ds-en" data-k="' + kind + '" data-i="' + i + '" value=""></td>' +
        '<td><input type="text" class="ds-zh" data-k="' + kind + '" data-i="' + i + '" value=""></td>' +
        (withWorkflow ? '<td><select class="ds-wf" data-k="' + kind + '" data-i="' + i + '">' + wfOptions('') + '</select></td>' : '') +
        '<td><button class="btn btn-sm btn-danger" onclick="this.closest(\'tr\').remove()">' + esc(t('common.delete')) + '</button></td>';
      tb.appendChild(tr);
    }
    document.getElementById('ds-seg-add').onclick = function () { addDictRow('segments', true); };
    document.getElementById('ds-src-add').onclick = function () { addDictRow('sources', false); };
    document.getElementById('ds-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        await saveSettingsKey('dict_segments', collectDict('segments', true));
        await saveSettingsKey('dict_sources', collectDict('sources', false));
        await loadReferenceData();
        toast(t('common.saved'), 'ok'); render();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
    if (canTrackers) {
      view.querySelectorAll('[data-tkdel]').forEach(function (b) {
        b.onclick = function () { var row = b.closest('tr'); if (row) row.remove(); };
      });
      document.getElementById('tk-add').onclick = function () {
        var tb = document.getElementById('tk-body');
        var i = 'n' + Date.now();
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td><input type="text" class="tk-key" data-i="' + i + '" value=""></td>' +
          '<td><input type="text" class="tk-en" data-i="' + i + '" value=""></td>' +
          '<td><input type="text" class="tk-zh" data-i="' + i + '" value=""></td>' +
          '<td><input type="text" class="tk-prefix" data-i="' + i + '" value="" style="width:64px"></td>' +
          '<td><input type="color" class="tk-color" data-i="' + i + '" value="#4f8ef7"></td>' +
          '<td><select class="tk-wf" data-i="' + i + '">' + wfOptions('') + '</select></td>' +
          '<td><button class="btn btn-sm btn-danger" onclick="this.closest(\'tr\').remove()">' + esc(t('common.delete')) + '</button></td>';
        tb.appendChild(tr);
      };
      document.getElementById('tk-save').onclick = async function () {
        var btn = this; btn.disabled = true;
        try {
          var out = [];
          view.querySelectorAll('.tk-key').forEach(function (inp) {
            var i = inp.getAttribute('data-i');
            var key = inp.value.trim();
            if (!key) return;
            out.push({
              key: key,
              name_en: view.querySelector('.tk-en[data-i="' + i + '"]').value.trim(),
              name_zh: view.querySelector('.tk-zh[data-i="' + i + '"]').value.trim(),
              prefix: view.querySelector('.tk-prefix[data-i="' + i + '"]').value.trim().toUpperCase(),
              color: view.querySelector('.tk-color[data-i="' + i + '"]').value,
              workflow_key: view.querySelector('.tk-wf[data-i="' + i + '"]').value || '',
              is_active: true
            });
          });
          /* Deactivated = trackers that existed before but were removed
             from the table: mark them inactive so the registry merge
             drops them (their tickets keep the stored key). */
          (state.trackers || []).forEach(function (tr) {
            if (!out.some(function (o) { return o.key === tr.key; })) {
              out.push(Object.assign({}, tr, { is_active: false }));
            }
          });
          await saveSettingsKey('trackers', out);
          await loadReferenceData();
          toast(t('common.saved'), 'ok'); render();
        } catch (e) { apiError(e); btn.disabled = false; }
      };
    }
  }

  async function viewEmail(view) {
    if (!state.v62) {
      view.innerHTML = '<div class="page"><div class="inline-err">' +
        esc(t('common.migrationRequired').replace('{v}', 'v6.2')) + '</div></div>';
      return;
    }
    var logRes = await sb.from('email_log').select('*')
      .order('sent_at', { ascending: false }).limit(150);
    var tplRes = await sb.from('email_templates').select('*').order('key').order('lang');
    var logs = logRes.data || [];
    var tpls = tplRes.data || [];
    var sent = logs.filter(function (l) { return l.status === 'sent'; }).length;
    var failed = logs.filter(function (l) { return l.status === 'failed'; }).length;

    var logRows = logs.map(function (l) {
      return '<tr><td class="muted">' + esc(fmtDate(l.sent_at)) + '</td>' +
        '<td>' + esc(l.event_key ? t('email.event.' + l.event_key) : '—') + '</td>' +
        '<td>' + esc(l.recipient) + '</td>' +
        '<td>' + esc(l.subject || '') + '</td>' +
        '<td>' + (l.status === 'sent' ? badge('sla-ok', t('email.statusSent'))
                                       : badge('sla-breached', t('email.statusFailed'))) + '</td>' +
        '<td class="muted">' + esc(l.error || '') + '</td></tr>';
    }).join('');
    if (!logRows) logRows = '<tr><td colspan="6" class="muted">' + esc(t('email.logEmpty')) + '</td></tr>';

    var tplRows = L.EMAIL_EVENTS.map(function (k) {
      return tpls.filter(function (x) { return x.key === k; }).map(function (x) {
        return '<tr><td><b>' + esc(t('email.event.' + k)) + '</b><br>' +
          '<span class="muted">' + esc(x.key) + ' · ' + esc(x.lang.toUpperCase()) + '</span></td>' +
          '<td>' + esc(x.subject) + '</td>' +
          '<td>' + (x.is_active ? badge('sla-ok', t('email.active')) : badge('status-closed', t('email.inactive'))) + '</td>' +
          '<td><button class="btn btn-sm" data-tpl="' + x.id + '">' + esc(t('common.edit')) + '</button></td></tr>';
      }).join('');
    }).join('');

    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('email.title')) + '</h1></div>' +
      '<div class="card"><h3>' + esc(t('email.settings')) + '</h3>' +
        '<label class="checkbox"><input type="checkbox" id="em-enabled"' +
          (state.appSettings.email_enabled !== 'false' ? ' checked' : '') + '> ' +
          esc(t('email.masterSwitch')) + '</label>' +
        '<label class="checkbox"><input type="checkbox" id="em-cust"' +
          (state.appSettings.customer_email_notifications === 'true' ? ' checked' : '') + '> ' +
          esc(t('email.customerSwitch')) + '</label>' +
        '<div class="form-actions">' +
          '<button class="btn btn-primary btn-sm" id="em-test">' + esc(t('email.testSend')) + '</button>' +
          '<span class="muted" style="margin-left:8px">' + esc(t('email.testSendHint')) + '</span>' +
        '</div>' +
        '<div class="muted" style="margin-top:6px">' +
          esc(t('email.recent')) + ': ' + sent + ' ' + esc(t('email.statusSent')) + ' / ' +
          failed + ' ' + esc(t('email.statusFailed')) + '</div>' +
      '</div>' +
      '<div class="card"><h3>' + esc(t('email.templates')) + '</h3>' +
        '<div class="muted" style="margin-bottom:8px">' + esc(t('email.varsHint')) + '</div>' +
        '<table class="tbl"><thead><tr><th>' + esc(t('email.colEvent')) + '</th><th>' +
          esc(t('email.colSubject')) + '</th><th></th><th></th></tr></thead>' +
          '<tbody>' + tplRows + '</tbody></table></div>' +
      '<div class="card"><h3>' + esc(t('email.log')) + '</h3>' +
        '<table class="tbl"><thead><tr><th>' + esc(t('email.colTime')) + '</th><th>' +
          esc(t('email.colEvent')) + '</th><th>' + esc(t('email.colRecipient')) + '</th><th>' +
          esc(t('email.colSubject')) + '</th><th>' + esc(t('email.colStatus')) + '</th><th>' +
          esc(t('email.colError')) + '</th></tr></thead>' +
          '<tbody>' + logRows + '</tbody></table></div>';

    async function saveSetting(key, value) {
      var r = await sb.from('app_settings').upsert({ key: key, value: value }, { onConflict: 'key' });
      if (r.error) { apiError(r.error); return; }
      state.appSettings[key] = value;
      toast(t('common.saved'), 'ok');
    }
    document.getElementById('em-enabled').onchange = function () {
      saveSetting('email_enabled', this.checked ? 'true' : 'false');
    };
    document.getElementById('em-cust').onchange = function () {
      saveSetting('customer_email_notifications', this.checked ? 'true' : 'false');
    };
    document.getElementById('em-test').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var res = await sb.functions.invoke('send-email', {
          body: {
            to: state.profile.email,
            subject: t('email.testSubject'),
            html: '<p>' + esc(t('email.testBody')) + '</p>',
            event_key: 'test'
          }
        });
        if (res.error) throw res.error;
        toast(t('email.testSent'), 'ok');
        setTimeout(function () { viewEmail(view); }, 600);
      } catch (e) {
        toast(t('email.testFailed') + ': ' + (e.message || e), 'error');
        btn.disabled = false;
      }
    };
    view.querySelectorAll('[data-tpl]').forEach(function (btn) {
      btn.onclick = function () {
        var tpl = tpls.filter(function (x) { return x.id === btn.getAttribute('data-tpl'); })[0];
        if (!tpl) return;
        var close = openModal(t('email.editTemplate') + ' — ' + tpl.key + ' (' + tpl.lang.toUpperCase() + ')',
          '<div class="field"><label>' + esc(t('email.colSubject')) + '</label>' +
          '<input type="text" id="tpl-subject" value="' + esc(tpl.subject) + '"></div>' +
          '<div class="field"><label>' + esc(t('email.bodyHtml')) + '</label>' +
          '<textarea id="tpl-body" rows="12" style="width:100%">' + esc(tpl.body_html) + '</textarea></div>' +
          '<label class="checkbox"><input type="checkbox" id="tpl-active"' +
            (tpl.is_active ? ' checked' : '') + '> ' + esc(t('email.active')) + '</label>',
          '<button class="btn btn-primary" id="tpl-save">' + esc(t('common.save')) + '</button>');
        document.getElementById('tpl-save').onclick = async function () {
          var r = await sb.from('email_templates').upsert({
            key: tpl.key, lang: tpl.lang,
            subject: document.getElementById('tpl-subject').value,
            body_html: document.getElementById('tpl-body').value,
            is_active: document.getElementById('tpl-active').checked
          }, { onConflict: 'key,lang' });
          if (r.error) { apiError(r.error); return; }
          toast(t('common.saved'), 'ok');
          close();
          viewEmail(view);
        };
      };
    });
  }

  /* v6.2 item 15: personal notification preferences — every logged-in
     user toggles each event for themselves (absent row = enabled). */
  async function openMyNotificationsModal() {
    if (!state.v62) { toast(t('nav.myNotifications') + ': ' +
      t('common.migrationRequired').replace('{v}', 'v6.2'), 'error'); return; }
    var mine = {};
    try {
      var r = await sb.from('notification_preferences').select('*')
        .eq('user_id', state.profile.id);
      if (!r.error) (r.data || []).forEach(function (x) { mine[x.event_key] = !!x.enabled; });
    } catch (e) { /* defaults apply */ }
    var body = '<div class="muted" style="margin-bottom:8px">' + esc(t('email.prefsHint')) + '</div>' +
      L.EMAIL_EVENTS.map(function (k) {
        var on = mine[k] !== false;
        return '<label class="checkbox"><input type="checkbox" data-ev="' + k + '"' +
          (on ? ' checked' : '') + '> ' + esc(t('email.event.' + k)) + '</label>';
      }).join('');
    var close = openModal(t('nav.myNotifications'), body,
      '<button class="btn btn-primary" id="np-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('np-save').onclick = async function () {
      var rows = [];
      document.querySelectorAll('[data-ev]').forEach(function (cb) {
        rows.push({ user_id: state.profile.id, event_key: cb.getAttribute('data-ev'),
                    enabled: cb.checked,
                    updated_at: new Date().toISOString() });
      });
      var r = await sb.from('notification_preferences')
        .upsert(rows, { onConflict: 'user_id,event_key' });
      if (r.error) { apiError(r.error); return; }
      toast(t('common.saved'), 'ok');
      close();
    };
  }

  async function viewWorkflow(view) {
    if (!state.v7) {
      view.innerHTML = '<div class="page"><div class="inline-err">migration_v7 required</div></div>';
      return;
    }
    var wfKey = viewWorkflow._wf || 'ci';
    var states = wfStateList(wfKey);
    var map = wfTransitions(wfKey);
    var tpl = L.WORKFLOW_TEMPLATES[wfKey];
    var matHtml = states.map(function (fs) {
      return '<tr><td><b>' + esc(wfStateName(fs.key)) + '</b><div class="muted" style="font-size:11px">' +
        esc(fs.key) + '</div></td>' + states.map(function (ts) {
        if (fs.key === ts.key) return '<td class="muted" style="text-align:center">—</td>';
        var on = map[fs.key] && map[fs.key].indexOf(ts.key) !== -1;
        return '<td style="text-align:center"><input type="checkbox" class="wf-edge" data-from="' +
          esc(fs.key) + '" data-to="' + esc(ts.key) + '"' + (on ? ' checked' : '') + '></td>';
      }).join('') + '</tr>';
    }).join('');
    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('workflow.title')) + '</h1></div>' +
      '<p class="muted">' + esc(t('workflow.sub')) + '</p>' +
      '<div class="tabs">' + Object.keys(L.WORKFLOW_TEMPLATES).map(function (k) {
        return '<button data-wf="' + k + '"' + (wfKey === k ? ' class="active"' : '') + '>' +
          esc(t('workflow.template.' + k)) + '</button>';
      }).join('') + '</div>' +
      '<div class="card"><div class="page-head"><h2>' + esc(t('workflow.states')) + '</h2>' +
        '<button class="btn btn-primary btn-sm" id="wf-state-new">+ ' + esc(t('workflow.newState')) + '</button></div>' +
      '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
        '<th>' + esc(t('workflow.key')) + '</th><th>' + esc(t('workflow.labelEn')) + '</th>' +
        '<th>' + esc(t('workflow.labelZh')) + '</th><th>' + esc(t('workflow.isTerminal')) + '</th>' +
        '<th>' + esc(t('workflow.color')) + '</th><th>' + esc(t('common.actions')) + '</th>' +
      '</tr></thead><tbody>' + states.map(function (s) {
        return '<tr><td><b>' + esc(s.key) + '</b></td><td>' + esc(s.label_en || '—') + '</td>' +
          '<td>' + esc(s.label_zh || '—') + '</td>' +
          '<td>' + (s.is_terminal ? '✓' : '—') + '</td>' +
          '<td><span class="badge" style="background:' + (s.color || '#eef1f4') + '22">&nbsp;</span> ' +
            esc(s.color || '—') + '</td>' +
          '<td><button class="btn btn-sm" data-wfedit="' + esc(s.key) + '">' + esc(t('common.edit')) + '</button> ' +
          '<button class="btn btn-sm btn-danger" data-wfdel="' + esc(s.key) + '">' + esc(t('common.delete')) + '</button></td></tr>';
      }).join('') + '</tbody></table></div></div>' +
      '<div class="card"><h2>' + esc(t('workflow.matrix')) + '</h2>' +
      '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>' + esc(t('workflow.fromTo')) + '</th>' +
        states.map(function (s) { return '<th style="text-align:center">' + esc(s.key) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + matHtml + '</tbody></table></div>' +
      '<div style="margin-top:10px"><button class="btn btn-primary" id="wf-save">' +
        esc(t('workflow.saveMatrix')) + '</button></div></div>';
    view.querySelectorAll('[data-wf]').forEach(function (b) {
      b.onclick = function () { viewWorkflow._wf = b.getAttribute('data-wf'); viewWorkflow(view); };
    });
    document.getElementById('wf-state-new').onclick = function () {
      openWfStateModal(wfKey, null, function () { loadReferenceData().then(function () { viewWorkflow(view); }); });
    };
    view.querySelectorAll('[data-wfedit]').forEach(function (b) {
      b.onclick = function () {
        var s = wfStateList(wfKey).filter(function (x) { return x.key === b.getAttribute('data-wfedit'); })[0];
        openWfStateModal(wfKey, s, function () { loadReferenceData().then(function () { viewWorkflow(view); }); });
      };
    });
    view.querySelectorAll('[data-wfdel]').forEach(function (b) {
      b.onclick = async function () {
        if (!window.confirm(t('workflow.confirmDeleteState'))) return;
        var r = await sb.from('workflow_states').delete().eq('workflow_key', wfKey).eq('key', b.getAttribute('data-wfdel'));
        if (r.error) { apiError(r.error); return; }
        toast(t('workflow.stateDeleted'), 'ok');
        await loadReferenceData(); viewWorkflow(view);
      };
    });
    document.getElementById('wf-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var edges = [];
        view.querySelectorAll('.wf-edge:checked').forEach(function (el) {
          edges.push({ workflow_key: wfKey, from_state: el.getAttribute('data-from'), to_state: el.getAttribute('data-to') });
        });
        var del = await sb.from('workflow_transitions').delete().eq('workflow_key', wfKey);
        if (del.error) throw del.error;
        if (edges.length) {
          var ins = await sb.from('workflow_transitions').insert(edges);
          if (ins.error) throw ins.error;
        }
        toast(t('workflow.matrixSaved'), 'ok');
        await loadReferenceData(); viewWorkflow(view);
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  function openWfStateModal(wfKey, st, done) {
    st = st || {};
    function fld(id, label, val) {
      return '<div class="field"><label>' + esc(label) + '</label>' +
        '<input type="text" id="' + id + '" value="' + esc(val || '') + '"></div>';
    }
    var body = fld('wfs-key', t('workflow.key'), st.key) +
      fld('wfs-len', t('workflow.labelEn'), st.label_en) +
      fld('wfs-lzh', t('workflow.labelZh'), st.label_zh) +
      '<div class="field"><label>' + esc(t('workflow.color')) + '</label>' +
        '<input type="color" id="wfs-color" value="' + esc(st.color || '#64748b') + '"></div>' +
      '<div class="field"><label style="font-weight:normal"><input type="checkbox" id="wfs-term"' +
        (st.is_terminal ? ' checked' : '') + '> ' + esc(t('workflow.isTerminal')) + '</label></div>' +
      '<div class="field"><label>' + esc(t('workflow.sortOrder')) + '</label>' +
        '<input type="number" id="wfs-sort" value="' + esc(st.sort_order != null ? st.sort_order : 0) + '"></div>';
    var close = openModal(t('workflow.newState'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    if (st.key) document.getElementById('wfs-key').disabled = true;
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var row = {
          workflow_key: wfKey,
          key: document.getElementById('wfs-key').value.trim(),
          label_en: document.getElementById('wfs-len').value.trim() || null,
          label_zh: document.getElementById('wfs-lzh').value.trim() || null,
          color: document.getElementById('wfs-color').value || null,
          is_terminal: document.getElementById('wfs-term').checked,
          sort_order: Number(document.getElementById('wfs-sort').value) || 0
        };
        if (!row.key) { toast(t('new.fillRequired'), 'error'); btn.disabled = false; return; }
        var r = st.key
          ? await sb.from('workflow_states').update(row).eq('workflow_key', wfKey).eq('key', st.key)
          : await sb.from('workflow_states').insert(row);
        if (r.error) throw r.error;
        toast(t('common.saved'), 'ok'); close(); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  /* v7.14: custom-field management — 9 types, bound per tracker. */
  async function viewCustomFields(view) {
    if (!state.v7) {
      view.innerHTML = '<div class="page"><div class="inline-err">migration_v7 required</div></div>';
      return;
    }
    var trk = viewCustomFields._trk || 'support';
    var list = state.customFields.filter(function (f) {
      return f.trackers && f.trackers.indexOf(trk) !== -1;
    }).sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
    var typeName = function (tp) { return t('cf.type.' + tp); };
    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('cf.title')) + '</h1>' +
      '<button class="btn btn-primary" id="cf-new">+ ' + esc(t('cf.new')) + '</button></div>' +
      '<p class="muted">' + esc(t('cf.sub')) + '</p>' +
      '<div class="tabs">' + state.trackers.map(function (tr) {
        return '<button data-trk="' + esc(tr.key) + '"' + (trk === tr.key ? ' class="active"' : '') + '>' +
          esc(trackerName(tr.key)) + '</button>';
      }).join('') + '</div>' +
      '<div class="card"><div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
        '<th>' + esc(t('cf.key')) + '</th><th>' + esc(t('cf.labelEn')) + '</th>' +
        '<th>' + esc(t('cf.type')) + '</th><th>' + esc(t('cf.required')) + '</th>' +
        '<th>' + esc(t('cf.visibleStatuses')) + '</th><th>' + esc(t('common.active')) + '</th>' +
        '<th>' + esc(t('common.actions')) + '</th>' +
      '</tr></thead><tbody>' + (list.map(function (f) {
        var label = lang === 'zh' ? (f.label_zh || f.label_en) : (f.label_en || f.label_zh);
        return '<tr><td><b>' + esc(f.key) + '</b></td><td>' + esc(label) + '</td>' +
          '<td>' + esc(typeName(f.type)) + '</td>' +
          '<td>' + (f.required ? '✓' : '—') + '</td>' +
          '<td class="muted">' + esc((f.show_in_states || []).join(', ') || '—') + '</td>' +
          '<td>' + (f.is_active === false ? '—' : '✓') + '</td>' +
          '<td><button class="btn btn-sm" data-cfedit="' + f.id + '">' + esc(t('common.edit')) + '</button> ' +
          '<button class="btn btn-sm btn-danger" data-cfdel="' + f.id + '">' + esc(t('common.delete')) + '</button></td></tr>';
      }).join('') || '<tr><td colspan="7"><div class="empty">—</div></td></tr>') +
      '</tbody></table></div></div>';
    view.querySelectorAll('[data-trk]').forEach(function (b) {
      b.onclick = function () { viewCustomFields._trk = b.getAttribute('data-trk'); viewCustomFields(view); };
    });
    document.getElementById('cf-new').onclick = function () {
      openCustomFieldModal(trk, null, function () { loadReferenceData().then(function () { viewCustomFields(view); }); });
    };
    view.querySelectorAll('[data-cfedit]').forEach(function (b) {
      b.onclick = function () {
        var f = state.customFields.filter(function (x) { return x.id === b.getAttribute('data-cfedit'); })[0];
        openCustomFieldModal(trk, f, function () { loadReferenceData().then(function () { viewCustomFields(view); }); });
      };
    });
    view.querySelectorAll('[data-cfdel]').forEach(function (b) {
      b.onclick = async function () {
        if (!window.confirm(t('cf.confirmDelete'))) return;
        var r = await sb.from('custom_fields').delete().eq('id', b.getAttribute('data-cfdel'));
        if (r.error) { apiError(r.error); return; }
        toast(t('cf.deleted'), 'ok');
        await loadReferenceData(); viewCustomFields(view);
      };
    });
  }

  function openCustomFieldModal(trk, field, done) {
    field = field || {};
    var trks = field.trackers && field.trackers.length ? field.trackers : [trk];
    var body =
      '<div class="field"><label>' + esc(t('cf.key')) + '</label>' +
        '<input type="text" id="cfi-key" value="' + esc(field.key || '') + '" placeholder="x_longi_field"' +
        (field.key ? ' disabled' : '') + '></div>' +
      '<div class="field"><label>' + esc(t('cf.type')) + '</label>' +
        '<select id="cfi-type">' + L.CF_TYPES.map(function (tp) {
          return '<option value="' + tp + '"' + (field.type === tp ? ' selected' : '') + '>' +
            esc(t('cf.type.' + tp)) + '</option>';
        }).join('') + '</select></div>' +
      '<div class="field"><label>' + esc(t('cf.labelEn')) + '</label>' +
        '<input type="text" id="cfi-len" value="' + esc(field.label_en || '') + '"></div>' +
      '<div class="field"><label>' + esc(t('cf.labelZh')) + '</label>' +
        '<input type="text" id="cfi-lzh" value="' + esc(field.label_zh || '') + '"></div>' +
      '<div class="field"><label>' + esc(t('cf.options')) + '</label>' +
        '<input type="text" id="cfi-opts" value="' +
        esc(Array.isArray(field.options) ? field.options.join(', ') : '') + '"></div>' +
      '<div class="field"><label>' + esc(t('cf.trackers')) + '</label>' +
        state.trackers.map(function (tr) {
          return '<label style="display:block;font-weight:normal"><input type="checkbox" class="cfi-trk" value="' +
            esc(tr.key) + '"' + (trks.indexOf(tr.key) !== -1 ? ' checked' : '') + '> ' + esc(trackerName(tr.key)) + '</label>';
        }).join('') + '</div>' +
      '<div class="field"><label>' + esc(t('cf.visibleStatuses')) + '</label>' +
        '<input type="text" id="cfi-states" value="' + esc((field.show_in_states || []).join(', ')) + '"></div>' +
      /* v8 (#21): required only in specific states (empty = all states). */
      (state.v8cf
        ? '<div class="field"><label>' + esc(t('cf.requiredStatuses')) + '</label>' +
          '<input type="text" id="cfi-reqstates" value="' + esc((field.required_states || []).join(', ')) + '">' +
          '<div class="hint">' + esc(t('cf.requiredStatusesHint')) + '</div></div>' +
          /* v8 (#23): dependency — this field renders only when the
             source field satisfies the condition (same tracker). */
          '<div class="field"><label>' + esc(t('cf.dependsOn')) + '</label>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
          '<select id="cfi-dep-field" style="flex:2;min-width:140px"><option value="">' + esc(t('common.none')) + '</option>' +
          state.customFields.filter(function (x) { return x.key !== field.key; }).map(function (x) {
            var lb = lang === 'zh' ? (x.label_zh || x.label_en) : (x.label_en || x.label_zh);
            return '<option value="' + esc(x.key) + '"' +
              (field.depends_on && field.depends_on.field === x.key ? ' selected' : '') + '>' +
              esc(lb || x.key) + '</option>';
          }).join('') + '</select>' +
          '<select id="cfi-dep-op" style="flex:1;min-width:110px">' + L.DEP_OPS.map(function (op) {
            return '<option value="' + op + '"' +
              (field.depends_on && field.depends_on.op === op ? ' selected' : '') + '>' +
              esc(t('cf.dep.op.' + op)) + '</option>';
          }).join('') + '</select>' +
          '<input type="text" id="cfi-dep-value" style="flex:1;min-width:100px" placeholder="' +
            esc(t('cf.dep.valuePh')) + '" value="' +
            esc(field.depends_on && field.depends_on.value != null ? field.depends_on.value : '') + '">' +
          '</div><div class="hint">' + esc(t('cf.dependsOnHint')) + '</div></div>'
        : '') +
      '<div class="field"><label style="font-weight:normal"><input type="checkbox" id="cfi-req"' +
        (field.required ? ' checked' : '') + '> ' + esc(t('cf.required')) + '</label> ' +
        '<label style="font-weight:normal"><input type="checkbox" id="cfi-active"' +
        (field.is_active !== false ? ' checked' : '') + '> ' + esc(t('common.active')) + '</label></div>';
    var close = openModal(t('cf.new'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var selTrks = Array.prototype.map.call(document.querySelectorAll('.cfi-trk:checked'),
          function (el) { return el.value; });
        var row = {
          type: document.getElementById('cfi-type').value,
          label_en: document.getElementById('cfi-len').value.trim() || null,
          label_zh: document.getElementById('cfi-lzh').value.trim() || null,
          options: document.getElementById('cfi-opts').value.split(',')
            .map(function (s) { return s.trim(); }).filter(Boolean),
          trackers: selTrks.length ? selTrks : ['support'],
          show_in_states: document.getElementById('cfi-states').value.split(',')
            .map(function (s) { return s.trim(); }).filter(Boolean),
          required: document.getElementById('cfi-req').checked,
          is_active: document.getElementById('cfi-active').checked
        };
        /* v8: dependency + per-state required (migration_v8 columns). */
        if (state.v8cf) {
          row.required_states = document.getElementById('cfi-reqstates').value.split(',')
            .map(function (s) { return s.trim(); }).filter(Boolean);
          var depField = document.getElementById('cfi-dep-field').value;
          row.depends_on = depField
            ? { field: depField,
                op: document.getElementById('cfi-dep-op').value,
                value: document.getElementById('cfi-dep-value').value }
            : null;
        }
        var errs = L.validateCustomFieldDef(Object.assign({ key: field.key || 'tmp' }, row));
        if (errs.length) { toast(t(errs[0].code), 'error'); btn.disabled = false; return; }
        /* v7.3: custom_fields.label_en/label_zh are both NOT NULL in the
           DB, while the form/validator only require at least one — mirror
           the filled side into the empty one so the write cannot trip the
           not-null constraint. Both-empty was already rejected above. */
        if (!row.label_en) row.label_en = row.label_zh;
        if (!row.label_zh) row.label_zh = row.label_en;
        if (field.key) row.key = field.key;
        else row.key = document.getElementById('cfi-key').value.trim();
        if (!row.key) { toast(t('new.fillRequired'), 'error'); btn.disabled = false; return; }
        var r = field.id
          ? await sb.from('custom_fields').update(row).eq('id', field.id)
          : await sb.from('custom_fields').insert(row);
        if (r.error) throw r.error;
        toast(t('common.saved'), 'ok'); close(); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  function openContactModal(contact, done) {
    contact = contact || {};
    function fld(id, label, val, ph) {
      return '<div class="field"><label>' + esc(label) + '</label>' +
        '<input type="text" id="' + id + '" value="' + esc(val || '') + '"' +
        (ph ? ' placeholder="' + esc(ph) + '"' : '') + '></div>';
    }
    var linked = {};
    state.contactProjects.forEach(function (r) {
      if (r.contact_id === contact.id) linked[r.site_id] = r;
    });
    var tree = L.buildSiteTree(state.sites.slice());
    function projChecks(list, depth) {
      var h = '';
      list.forEach(function (s) {
        var lk = linked[s.id];
        h += '<label style="display:block;padding:3px 0 3px ' + (depth * 22) + 'px;font-weight:normal">' +
          '<input type="checkbox" class="cp-proj" value="' + s.id + '"' +
          (lk ? ' checked' : '') + '> ' + esc(s.code + ' — ' + s.name) +
          /* v6.1: per-project role (Field Service Technician, …) */
          (state.v61
            ? ' <input type="text" class="cp-role" data-site="' + s.id + '"' +
              ' placeholder="' + esc(t('contacts.siteRole')) + '"' +
              ' value="' + esc((lk && lk.role) || '') + '"' +
              ' style="width:170px;margin-left:8px">'
            : '') + '</label>';
        h += projChecks(s.children, depth + 1);
      });
      return h;
    }
    var body =
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('contacts.firstName')) + '<span class="req">*</span></label>' +
          '<input type="text" id="ct-first" value="' + esc(contact.first_name || '') + '"></div>' +
        '<div class="field"><label>' + esc(t('contacts.lastName')) + '</label>' +
          '<input type="text" id="ct-last" value="' + esc(contact.last_name || '') + '"></div>' +
      '</div>' +
      '<div class="form-row">' +
        fld('ct-company', t('contacts.company'), contact.company) +
        fld('ct-role', t('contacts.role'), contact.role) +
      '</div>' +
      '<div class="form-row">' +
        fld('ct-phone', t('contacts.phone'), contact.phone) +
        fld('ct-email', t('contacts.email'), contact.email) +
      '</div>' +
      '<div class="field"><label><input type="checkbox" id="ct-active"' +
        (contact.is_active !== false ? ' checked' : '') + '> ' + esc(t('contacts.active')) + '</label></div>' +
      '<div class="field"><label>' + esc(t('contacts.notes')) + '</label>' +
        '<textarea id="ct-notes" style="height:52px">' + esc(contact.notes || '') + '</textarea></div>' +
      '<div class="field"><label>' + esc(t('contacts.projects')) + '</label>' +
        '<div style="max-height:180px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:8px 10px">' +
        (projChecks(tree, 0) || '<span class="muted">—</span>') + '</div></div>';
    var close = openModal(contact.id ? t('contacts.edit') : t('contacts.new'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var row = {
          first_name: document.getElementById('ct-first').value.trim(),
          last_name: document.getElementById('ct-last').value.trim() || null,
          company: document.getElementById('ct-company').value.trim() || null,
          role: document.getElementById('ct-role').value.trim() || null,
          phone: document.getElementById('ct-phone').value.trim() || null,
          email: document.getElementById('ct-email').value.trim() || null,
          is_active: document.getElementById('ct-active').checked,
          notes: document.getElementById('ct-notes').value.trim() || null
        };
        var errs = L.validateContact(row);
        if (errs.length) {
          toast(t(errs[0] === 'contact.email' ? 'contacts.badEmail' : 'new.fillRequired'), 'error');
          btn.disabled = false; return;
        }
        var saved;
        if (contact.id) {
          var ur = await sb.from('contacts').update(row).eq('id', contact.id).select('id').single();
          if (ur.error) throw ur.error;
          saved = ur.data;
        } else {
          var ir = await sb.from('contacts').insert(row).select('id').single();
          if (ir.error) throw ir.error;
          saved = ir.data;
        }
        var sel = Array.prototype.map.call(
          document.querySelectorAll('.cp-proj:checked'), function (el) { return el.value; });
        await sb.from('contact_projects').delete().eq('contact_id', saved.id);
        if (sel.length) {
          var prow = sel.map(function (sid) {
            var link = { contact_id: saved.id, site_id: sid };
            /* v6.1: per-project role (gated — column only exists after migration_v6_1). */
            if (state.v61) {
              var ri = document.querySelector('.cp-role[data-site="' + sid + '"]');
              var rv = ri ? ri.value.trim() : '';
              if (rv) link.role = rv;
            }
            return link;
          });
          var pr = await sb.from('contact_projects').insert(prow);
          if (pr.error) throw pr.error;
        }
        toast(t('contacts.saved'), 'ok');
        close(); done();
      } catch (e) { apiError(e); btn.disabled = false; }
    };
  }

  /* v8 (#15): quick-create a contact from anywhere (ticket forms).
     Inserts into the shared contact directory, then calls done(contact). */
  function openQuickContactModal(done) {
    var body =
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('contacts.firstName')) + '<span class="req">*</span></label>' +
          '<input type="text" id="qc-first"></div>' +
        '<div class="field"><label>' + esc(t('contacts.lastName')) + '</label>' +
          '<input type="text" id="qc-last"></div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('contacts.email')) + '</label>' +
          '<input type="email" id="qc-email"></div>' +
        '<div class="field"><label>' + esc(t('contacts.phone')) + '</label>' +
          '<input type="text" id="qc-phone"></div>' +
      '</div>' +
      '<div class="field"><label>' + esc(t('contacts.company')) + '</label>' +
        '<input type="text" id="qc-company"></div>';
    var close = openModal(t('contacts.new'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var first = document.getElementById('qc-first').value.trim();
        if (!first) { toast(t('new.fillRequired'), 'error'); btn.disabled = false; return; }
        var row = {
          first_name: first,
          last_name: document.getElementById('qc-last').value.trim() || null,
          email: document.getElementById('qc-email').value.trim() || null,
          phone: document.getElementById('qc-phone').value.trim() || null,
          company: document.getElementById('qc-company').value.trim() || null
        };
        var r = await sb.from('contacts').insert(row).select('*').single();
        if (r.error) throw r.error;
        await loadReferenceData();
        toast(t('common.saved'), 'ok');
        close(); if (done) done(r.data);
      } catch (e) { apiError(e); btn.disabled = false; }
    };
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
      '<div class="field"><label>' + esc(t('sites.description')) + '</label>' +
        '<textarea id="s-desc" style="height:52px">' + esc(site.description || '') + '</textarea></div>' +
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('sites.latitude')) + '</label>' +
          '<input type="number" step="any" id="s-lat" value="' + esc(site.latitude == null ? '' : site.latitude) + '"></div>' +
        '<div class="field"><label>' + esc(t('sites.longitude')) + '</label>' +
          '<input type="number" step="any" id="s-lng" value="' + esc(site.longitude == null ? '' : site.longitude) + '"></div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('sites.status')) + '</label>' +
          '<select id="s-status">' +
          ['active', 'paused', 'closed'].map(function (k) {
            return '<option value="' + k + '"' + ((site.status || 'active') === k ? ' selected' : '') + '>' +
              esc(t('sites.status.' + k)) + '</option>';
          }).join('') + '</select></div>' +
        '<div class="field"><label>' + esc(t('sites.segment')) + '</label>' +
          '<select id="s-segment">' +
          state.segments.map(function (sg) {
            return '<option value="' + esc(sg.key) + '"' + ((site.segment || 'ci') === sg.key ? ' selected' : '') + '>' +
              esc(dictName(sg, 'sites.segment.' + sg.key)) + '</option>';
          }).join('') + '</select></div>' +
      '</div>' +
      '<div class="field"><label>' + esc(t('sites.workflowMode')) + '</label>' +
        '<select id="s-wfmode">' +
        '<option value="default"' + ((site.workflow_mode || 'default') === 'default' ? ' selected' : '') + '>' +
          esc(t('sites.workflowDefault')) + '</option>' +
        '<option value="inherit"' + (site.workflow_mode === 'inherit' ? ' selected' : '') + '>' +
          esc(t('sites.workflowInherit')) + '</option></select></div>' +
      /* v6.1: default support group — new tickets for this site are
         auto-routed to it (Massimo's dispatch rule). */
      (state.v61
        ? '<div class="field"><label>' + esc(t('sites.defaultGroup')) + '</label>' +
          '<select id="s-group"><option value="">' + esc(t('common.none')) + '</option>' +
          state.groups.filter(function (g) { return g.is_active !== false; }).map(function (g) {
            return '<option value="' + g.id + '"' + (site.default_group_id === g.id ? ' selected' : '') + '>' +
              esc(g.name) + '</option>';
          }).join('') + '</select></div>'
        : '') +
      '<div class="field"><label>' + esc(t('sites.parentSite')) + '</label>' +
        '<select id="s-parent"><option value="">' + esc(t('sites.noParent')) + '</option>' +
        state.sites.filter(function (x) { return !forbiddenParent[x.id]; }).map(function (x) {
          return '<option value="' + x.id + '"' + (site.parent_site_id === x.id ? ' selected' : '') + '>' +
            esc(x.code + ' — ' + x.name) + '</option>';
        }).join('') + '</select></div>' +
      '<div class="field"><label>' + esc(t('sites.remoteOwner')) + '</label>' +
        '<select id="s-owner"><option value="">' + esc(t('sites.noOwner')) + '</option>' +
        '<optgroup id="s-owner-people" label="' + esc(t('sites.ownerPeople')) + '"></optgroup>' +
        (state.v8owner
          ? '<optgroup id="s-owner-groups" label="' + esc(t('sites.ownerGroups')) + '">' +
            state.groups.filter(function (g) { return g.is_active !== false; }).map(function (g) {
              return '<option value="g:' + g.id + '"' +
                (site.remote_owner_group_id === g.id ? ' selected' : '') + '>' + esc(g.name) + '</option>';
            }).join('') + '</optgroup>'
          : '') +
        '</select></div>' +
      (state.v3
        ? '<div class="field"><label>' + esc(t('sites.customer')) + '</label>' +
          '<div style="display:flex;gap:6px"><select id="s-customer" style="flex:1"><option value="">' + esc(t('common.none')) + '</option>' +
          state.customers.map(function (c) {
            return '<option value="' + c.id + '"' + (site.customer_id === c.id ? ' selected' : '') + '>' +
              esc(c.company_name) + '</option>';
          }).join('') + '</select>' +
          /* v8 (#12): create the customer right here — the register used
             to be discoverable only at the bottom of the Projects page. */
          '<button type="button" class="btn btn-sm" id="s-customer-new">+ ' + esc(t('customers.new')) + '</button></div></div>'
        : '');
    var close = openModal(site.id ? t('sites.edit') : t('sites.new'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    /* v8 (#12): quick-create a customer from the site form. */
    var custNewBtn = document.getElementById('s-customer-new');
    if (custNewBtn) custNewBtn.onclick = function () {
      var before = {};
      state.customers.forEach(function (c) { before[c.id] = true; });
      openCustomerModal(null, async function () {
        await loadReferenceData();
        var sel = document.getElementById('s-customer');
        if (!sel) return;
        var cur = sel.value;
        sel.innerHTML = '<option value="">' + esc(t('common.none')) + '</option>' +
          state.customers.map(function (c) {
            return '<option value="' + c.id + '">' + esc(c.company_name) + '</option>';
          }).join('');
        var fresh = state.customers.filter(function (c) { return !before[c.id]; })[0];
        sel.value = fresh ? fresh.id : cur;
      });
    };
    sb.from('profiles').select('id,display_name,email,role').eq('is_active', true)
      .order('display_name').then(function (r) {
        var sel = document.getElementById('s-owner');
        var og = document.getElementById('s-owner-people');
        if (!sel || !og) return;
        if (!r.error) {
          (r.data || []).forEach(function (u) {
            if (u.role === 'customer') return;
            state.nameCache[u.id] = u.display_name || u.email;
            var o = document.createElement('option');
            o.value = u.id;
            o.textContent = (u.display_name || u.email) + ' (' + t('role.' + u.role) + ')';
            if (site.remote_owner_id === u.id) o.selected = true;
            og.appendChild(o);
          });
        }
      });
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var code = document.getElementById('s-code').value.trim();
        var name = document.getElementById('s-name').value.trim();
        if (!code || !name) { toast(t('new.fillRequired'), 'error'); btn.disabled = false; return; }
        function numOrNull(id) {
          var v = document.getElementById(id).value.trim();
          return v === '' || isNaN(Number(v)) ? null : Number(v);
        }
        var ownerVal = document.getElementById('s-owner').value || '';
        var fields = {
          code: code,
          name: name,
          country: (document.getElementById('s-country').value.trim() || null),
          city: document.getElementById('s-city').value.trim() || null,
          address: document.getElementById('s-addr').value.trim() || null,
          parent_site_id: document.getElementById('s-parent').value || null,
          /* v8 (#11): remote owner may be a group ("g:<id>") or a person. */
          remote_owner_id: ownerVal.indexOf('g:') === 0 ? null : (ownerVal || null),
          description: document.getElementById('s-desc').value.trim() || null,
          status: document.getElementById('s-status').value,
          latitude: numOrNull('s-lat'),
          longitude: numOrNull('s-lng'),
          workflow_mode: document.getElementById('s-wfmode').value,
          segment: document.getElementById('s-segment').value
        };
        if (state.v8owner) {
          fields.remote_owner_group_id = ownerVal.indexOf('g:') === 0 ? ownerVal.slice(2) : null;
        }
        if (state.v3) {
          var custSel = document.getElementById('s-customer');
          fields.customer_id = custSel ? (custSel.value || null) : (site.customer_id || null);
        }
        /* v6.1: default support group (gated — column only exists after migration_v6_1). */
        if (state.v61) {
          var grpSel = document.getElementById('s-group');
          fields.default_group_id = grpSel ? (grpSel.value || null) : (site.default_group_id || null);
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
        '<td>' + badge((p.owner || 'longi') === 'customer' ? 'contract' : 'sla-ok',
            t('parts.owner.' + (p.owner || 'longi'))) + '</td>' +
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
        /* v6.4: TechCRM 3-state stock badge (OK/low/critical). */
        var st = L.stockStatus(qty, min);
        var stCls = st === 'critical' ? 'sla-breached' : st === 'low' ? 'sla-warning' : 'sla-ok';
        var cls = st === 'ok' ? '' : (st === 'critical' ? 'low-stock-red' : 'low-stock-amber');
        return '<tr class="' + cls + '"><td></td>' +
          '<td><b>' + esc(p.code || '—') + '</b> ' + esc(p.name || '') + '</td>' +
          '<td class="tnum">' + esc(String(s.qty)) + ' ' + esc(p.unit || '') + '</td>' +
          '<td class="muted">' + esc(min == null ? '—' : String(s.min_qty)) + '</td>' +
          '<td>' + badge(stCls, t('parts.stock.' + st)) + '</td>' +
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
      '<div class="card"><h2>' + esc(t('parts.stockStatus')) + '</h2>' +
        '<input type="text" id="part-xsearch" class="input" style="max-width:420px;margin-bottom:10px" placeholder="' +
        esc(t('parts.searchAllPh')) + '">' +
        '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
        '<th>' + esc(t('parts.name')) + '</th><th>' + esc(t('parts.warehouse')) + '</th>' +
        '<th>' + esc(t('parts.qty')) + '</th><th>' + esc(t('parts.stock')) + '</th>' +
        '<th>' + esc(t('parts.owner')) + '</th></tr></thead>' +
        '<tbody id="part-xresults"><tr><td colspan="5"><div class="empty muted">' +
        esc(t('parts.searchAllPh')) + '</div></td></tr></tbody></table></div></div>' +
      '<div class="card"><h2>' + esc(t('parts.catalog')) + '</h2>' +
        '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
        '<th>' + esc(t('parts.code')) + '</th><th>' + esc(t('parts.name')) + '</th>' +
        '<th>' + esc(t('parts.category')) + '</th><th>' + esc(t('parts.unit')) + '</th>' +
        '<th>' + esc(t('parts.owner')) + '</th>' +
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

    /* v6.4: cross-warehouse part search — which warehouse holds this part. */
    (function () {
      var inp = document.getElementById('part-xsearch');
      var out = document.getElementById('part-xresults');
      if (!inp || !out) return;
      inp.oninput = function () {
        var q = inp.value.trim().toLowerCase();
        if (q.length < 2) {
          out.innerHTML = '<tr><td colspan="5"><div class="empty muted">' +
            esc(t('parts.searchAllPh')) + '</div></td></tr>';
          return;
        }
        var rows = [];
        stock.forEach(function (s) {
          var p = partMap[s.part_id] || {};
          var w = whMap[s.warehouse_id] || {};
          var hay = ((p.code || '') + ' ' + (p.name || '')).toLowerCase();
          if (hay.indexOf(q) === -1) return;
          var st = L.stockStatus(s.qty, s.min_qty);
          rows.push('<tr><td><b>' + esc(p.code || '—') + '</b> ' + esc(p.name || '') + '</td>' +
            '<td class="muted">' + esc(w.code ? w.code + ' — ' + w.name : '—') + '</td>' +
            '<td class="tnum">' + esc(String(s.qty)) + ' ' + esc(p.unit || '') + '</td>' +
            '<td>' + badge(st === 'critical' ? 'sla-breached' : st === 'low' ? 'sla-warning' : 'sla-ok',
              t('parts.stock.' + st)) + '</td>' +
            '<td>' + esc(t('parts.owner.' + (p.owner || 'longi'))) + '</td></tr>');
        });
        out.innerHTML = rows.length ? rows.join('')
          : '<tr><td colspan="5"><div class="empty">' + esc(t('common.noResults')) + '</div></td></tr>';
      };
    })();

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
        '<div class="field"><label>' + esc(t('parts.unit')) + '<span class="req">*</span></label>' +
          '<input type="text" id="p-unit" value="' + esc(part.unit || '') + '"></div>' +
      '</div>' +
      '<div class="field"><label>' + esc(t('parts.owner')) + '</label>' +
        '<select id="p-owner">' +
        ['longi', 'customer'].map(function (k) {
          return '<option value="' + k + '"' + ((part.owner || 'longi') === k ? ' selected' : '') + '>' +
            esc(t('parts.owner.' + k)) + '</option>';
        }).join('') + '</select></div>';
    var close = openModal(part.id ? t('parts.editPart') : t('parts.newPart'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    document.getElementById('m-save').onclick = async function () {
      var btn = this; btn.disabled = true;
      try {
        var code = document.getElementById('p-code').value.trim();
        var name = document.getElementById('p-name').value.trim();
        var unit = document.getElementById('p-unit').value.trim();
        /* v7.1 fix: spare_parts.unit is NOT NULL in the DB — block the
           save up front instead of surfacing the raw Postgres error. */
        if (!code || !name || !unit) { toast(t('new.fillRequired'), 'error'); btn.disabled = false; return; }
        var fields = { code: code, name: name,
                       category: document.getElementById('p-cat').value.trim() || null,
                       unit: unit,
                       owner: document.getElementById('p-owner').value };
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
    { key: 'category', req: false }, { key: 'unit', req: true }, { key: 'min_qty', req: false },
    /* v6.1: Massimo inventory columns */
    { key: 'owner', req: false }, { key: 'location', req: false },
    { key: 'target_stock', req: false }, { key: 'part_number', req: false },
    { key: 'criticality', req: false }, { key: 'supplier', req: false }
  ];
  /* v6.5: multi-entity import. Each entity: fields (key/req/label/aliases),
     template row, and a run(rec) writer. 'parts' keeps the legacy flow. */
  var IMPORT_ENTITIES = {
    parts: { fields: IMPORT_FIELDS, aliases: {
      /* v6.1: 'id' / 'descriptionen' / 'stockonhand' / 'minstock' match
         Massimo's sheet (ID, Description EN, Stock on hand, Min. stock). */
      code: ['code', 'partcode', 'partno', 'sku', 'itemcode', 'id'],
      name: ['name', 'partname', 'description', 'desc', 'itemname', 'descriptionen'],
      warehouse_code: ['warehousecode', 'warehouse', 'whcode', 'wh', 'location'],
      qty: ['qty', 'quantity', 'stock', 'amount', 'count', 'stockonhand'],
      category: ['category', 'cat', 'type', 'group', 'component'],
      unit: ['unit', 'uom'],
      min_qty: ['minqty', 'min', 'minimum', 'safetystock', 'reorder', 'minstock'],
      owner: ['owner', 'ownership'],
      location: ['locationpalletshelfbin', 'bin', 'shelf', 'pallet'],
      target_stock: ['targetstock'],
      part_number: ['partnumber', 'pn', 'longipn', 'longipotispn', 'potispn'],
      criticality: ['criticality'],
      supplier: ['supplier', 'primarysupplier'] },
      template: 'code,name,warehouse_code,qty,category,unit,min_qty,owner\nBAT-001,Battery module,WH-EU-01,10, ESS,pcs,2,longi' },
    sites: { fields: [
      { key: 'code', req: true, label: 'Project code' }, { key: 'name', req: true, label: 'Project name' },
      { key: 'country', req: false, label: 'Country (2-letter)' }, { key: 'city', req: false, label: 'City' },
      { key: 'address', req: false, label: 'Address' },
      { key: 'latitude', req: false, label: 'Latitude' }, { key: 'longitude', req: false, label: 'Longitude' },
      { key: 'parent_code', req: false, label: 'Parent site code' },
      { key: 'remote_owner_email', req: false, label: 'Remote owner email' },
      { key: 'description', req: false, label: 'Description' } ], aliases: {
      code: ['code', 'sitecode'], name: ['name', 'sitename'],
      /* v6.1: Massimo's bilingual header normalizes to 'countryiso'. */
      country: ['country', 'countryiso'], city: ['city'], address: ['address'],
      latitude: ['latitude', 'lat'], longitude: ['longitude', 'lng', 'lon'],
      parent_code: ['parentcode', 'parentsitecode', 'parent'],
      remote_owner_email: ['remoteowneremail', 'owneremail', 'owner'],
      description: ['description', 'desc'] },
      template: 'code,name,country,city,latitude,longitude,parent_code,remote_owner_email\nIT-MDC-01,Montalto di Castro,IT,Montalto di Castro,42.35,11.61,IT,,massimo@longi.com' },
    warehouses: { fields: [
      { key: 'code', req: true, label: 'Warehouse code' }, { key: 'name', req: true, label: 'Warehouse name' },
      { key: 'parent_code', req: false, label: 'Parent warehouse code' },
      { key: 'type', req: false, label: 'Type (on_site/off_site)' },
      { key: 'address', req: false, label: 'Address' },
      { key: 'contact_name', req: false, label: 'Contact name' },
      { key: 'contact_phone', req: false, label: 'Contact phone' },
      { key: 'contact_email', req: false, label: 'Contact email' },
      /* v6.1: prefix match — Massimo's header is the long
         "Delivery notes (opening hours, delivery instructions…)". */
      { key: 'delivery_notes', req: false, label: 'Delivery notes', prefix: true } ], aliases: {
      code: ['code', 'warehousecode'], name: ['name', 'warehousename'],
      parent_code: ['parentcode', 'parentwarehousecode', 'parent'],
      type: ['type', 'warehousetype'], address: ['address'],
      /* v6.1: 'contactperson' / 'mobilephone' / 'email' match Massimo's
         sheet (Contact person, Mobile phone, E-mail). */
      contact_name: ['contactname', 'contactperson'],
      contact_phone: ['contactphone', 'mobilephone', 'mobile'],
      contact_email: ['contactemail', 'email', 'mail'],
      delivery_notes: ['deliverynotes', 'delivery'] },
      template: 'code,name,parent_code,type,address,contact_name,contact_phone\nWH-EU-01,EU central warehouse,,off_site, Rotterdam NL,Jan Jansen,+31101234567' },
    contacts: { fields: [
      { key: 'first_name', req: true, label: 'First name' }, { key: 'last_name', req: false, label: 'Last name' },
      { key: 'company', req: false, label: 'Company' }, { key: 'role', req: false, label: 'Role' },
      { key: 'phone', req: false, label: 'Phone' }, { key: 'email', req: false, label: 'Email' },
      /* v6.1: Key People "Group" column → contacts.group_name */
      { key: 'group_name', req: false, label: 'Group' } ], aliases: {
      first_name: ['firstname', 'name', 'givenname'], last_name: ['lastname', 'surname', 'familyname'],
      company: ['company', 'organisation', 'organization'], role: ['role', 'title', 'position'],
      phone: ['phone', 'mobile', 'tel'], email: ['email', 'mail'],
      group_name: ['groupname', 'group'] },
      template: 'first_name,last_name,company,role,phone,email\nMario,Rossi,Rapsody,Field technician,+393331234567,mario.rossi@rapsody.it' },
    contracts: { fields: [
      { key: 'site_code', req: true, label: 'Project code' },
      { key: 'response_hours', req: false, label: 'Response hours' },
      { key: 'onsite_hours', req: false, label: 'On-site hours' },
      { key: 'resolve_hours', req: false, label: 'Resolve hours' },
      { key: 'availability_pct', req: false, label: 'Availability %' },
      { key: 'valid_from', req: false, label: 'Valid from (YYYY-MM-DD)' },
      { key: 'valid_to', req: false, label: 'Valid to (YYYY-MM-DD)' },
      { key: 'coverage', req: false, label: 'Coverage' },
      { key: 'phone_enabled', req: false, label: 'Phone enabled (true/false)' },
      { key: 'onsite_enabled', req: false, label: 'On-site enabled (true/false)' },
      { key: 'support_24_7', req: false, label: '24/7 (true/false)' },
      { key: 'penalty_response', req: false, label: 'Penalty response' },
      { key: 'penalty_onsite', req: false, label: 'Penalty on-site' },
      { key: 'penalty_resolve', req: false, label: 'Penalty resolve' } ], aliases: {
      site_code: ['sitecode', 'site', 'code'],
      response_hours: ['responsehours', 'response'], onsite_hours: ['onsitehours', 'onsite'],
      resolve_hours: ['resolvehours', 'resolve'], availability_pct: ['availabilitypct', 'availability'],
      valid_from: ['validfrom', 'from'], valid_to: ['validto', 'to'],
      coverage: ['coverage'], phone_enabled: ['phoneenabled', 'phone'],
      onsite_enabled: ['onsiteenabled', 'onsite'], support_24_7: ['support247', '247'],
      penalty_response: ['penaltyresponse'], penalty_onsite: ['penaltyonsite'],
      penalty_resolve: ['penaltyresolve'] },
      template: 'site_code,response_hours,resolve_hours,availability_pct,valid_from,valid_to,onsite_enabled,support_24_7\nIT-MDC-01,3,5,98,2026-01-01,2028-12-31,true,true' },
    engineers: { fields: [
      { key: 'first_name', req: true, label: 'First name' }, { key: 'last_name', req: false, label: 'Last name' },
      { key: 'company', req: false, label: 'Company' }, { key: 'role', req: false, label: 'Role' },
      { key: 'phone', req: false, label: 'Phone' }, { key: 'email', req: false, label: 'Email' },
      /* v6.1: Massimo Engineers sheet columns */
      { key: 'country', req: false, label: 'Country (2-letter)' },
      { key: 'skills', req: false, label: 'Skills' },
      { key: 'cert_level', req: false, label: 'Cert level' },
      { key: 'project_scope', req: false, label: 'Project scope (site names)' },
      { key: 'language', req: false, label: 'Language' } ], aliases: {
      first_name: ['firstname', 'name', 'givenname'], last_name: ['lastname', 'surname', 'familyname'],
      company: ['company', 'organisation', 'organization'], role: ['role', 'title', 'position'],
      phone: ['phone', 'mobile', 'tel'], email: ['email', 'mail'],
      country: ['country', 'countryiso'], skills: ['skills', 'skill'],
      cert_level: ['certlevel', 'certification', 'cert'],
      project_scope: ['projectscope', 'scope'],
      language: ['language', 'languages', 'lang'] },
      template: 'first_name,last_name,company,role,phone,email\nHassan,Benali,LONGi EU,Field technician,+393331234567,hassan.benali@longi.com' }
  };
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
  function guessMapping(headers, fields, aliases) {
    var map = {};
    var norm = headers.map(function (h) { return h.toLowerCase().replace(/[^a-z0-9]/g, ''); });
    (fields || IMPORT_FIELDS).forEach(function (f) {
      var keys = ((aliases || {})[f.key]) || [f.key];
      for (var i = 0; i < norm.length; i++) {
        if (keys.indexOf(norm[i]) !== -1) { map[f.key] = headers[i]; break; }
      }
      /* v6.1: prefix fallback for flagged fields — exact match first,
         so generic headers keep existing behavior. */
      if (map[f.key] == null && f.prefix) {
        for (var j = 0; j < norm.length; j++) {
          var hit = false;
          for (var k = 0; k < keys.length; k++) {
            if (norm[j].indexOf(keys[k]) === 0 && norm[j].length > keys[k].length) { hit = true; break; }
          }
          if (hit) { map[f.key] = headers[j]; break; }
        }
      }
      if (map[f.key] == null) map[f.key] = '';
    });
    return map;
  }
  function openPartsImportModal(warehouses, done) {
    var whByCode = {};
    warehouses.forEach(function (w) { whByCode[(w.code || '').toUpperCase()] = w; });
    var parsed = null, mapping = {};
    var impEntity = 'parts';
    function impFields() { return IMPORT_ENTITIES[impEntity].fields; }
    function impLabel(f) {
      return f.label || t('parts.imp.f.' + f.key);
    }
    var body =
      '<div id="pi-step1">' +
        '<div class="field"><label>' + esc(t('parts.imp.entity')) + '</label>' +
          '<select id="pi-entity">' +
          ['parts', 'sites', 'warehouses', 'contacts', 'contracts', 'engineers'].map(function (k) {
            return '<option value="' + k + '">' + esc(t('parts.imp.entity.' + k)) + '</option>';
          }).join('') + '</select></div>' +
        '<div class="field"><button class="btn btn-sm" id="pi-template">⇩ ' +
          esc(t('parts.imp.template')) + '</button> ' +
          '<span class="muted" id="pi-engnote" style="display:none">' +
          esc(t('parts.imp.engineerNote')) + '</span></div>' +
        '<div class="field"><label>' + esc(t('parts.imp.paste')) + '</label>' +
          '<textarea id="pi-text" rows="6" placeholder="' +
            esc(t('parts.imp.pastePh')) + '"></textarea></div>' +
        '<div class="field"><label>' + esc(t('parts.imp.upload')) + '</label>' +
          '<input type="file" id="pi-file" accept=".csv,.tsv,.txt,.xlsx,.xls"></div>' +
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
          '<th>#</th><th>' + esc(t('parts.imp.status')) + '</th></tr></thead>' +
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
      var fields = impFields();
      parsed.rows.forEach(function (cells, idx) {
        var rec = {};
        fields.forEach(function (f) {
          var hi = parsed.headers.indexOf(mapping[f.key]);
          rec[f.key] = hi === -1 ? '' : (cells[hi] || '').trim();
        });
        /* v6.1: Key People / Engineers sheets carry a single "Name"
           column — split into first/last for display + writers. */
        if ((impEntity === 'contacts' || impEntity === 'engineers') &&
            rec.first_name && !rec.last_name) {
          var sp = L.splitFullName(rec.first_name);
          rec.first_name = sp.first; rec.last_name = sp.last;
        }
        /* v6.1: Massimo writes "TBD" for unknown emails (3 of 10
           engineers) — a placeholder is "no email", not a row error. */
        if ((impEntity === 'contacts' || impEntity === 'engineers') && rec.email &&
            (L.isNaLike(rec.email) || (rec.email || '').toUpperCase() === 'TBD')) rec.email = '';
        var errs = [];
        fields.forEach(function (f) {
          if (f.req && !rec[f.key]) errs.push(impLabel(f));
        });
        /* entity-specific checks */
        if (impEntity === 'parts') {
          if (rec.warehouse_code && !L.findWarehouse(rec.warehouse_code, warehouses))
            errs.push(t('parts.imp.badWh'));
          if (rec.qty === '' || isNaN(Number(rec.qty))) errs.push(impLabel({ key: 'qty', label: 'qty' }));
          if (rec.min_qty && isNaN(Number(rec.min_qty))) errs.push(impLabel({ key: 'min_qty', label: 'min_qty' }));
          if (rec.target_stock && isNaN(Number(rec.target_stock))) errs.push(impLabel({ key: 'target_stock', label: 'target_stock' }));
          if (rec.owner && !L.normalizeOwner(rec.owner))
            errs.push('owner');
        } else if (impEntity === 'sites') {
          if (rec.latitude && L.parseCoordinate(rec.latitude) == null) errs.push('latitude');
          if (rec.longitude && L.parseCoordinate(rec.longitude) == null) errs.push('longitude');
          if (rec.country && rec.country.length !== 2) errs.push('country');
        } else if (impEntity === 'warehouses') {
          if (rec.type && !L.normalizeWarehouseType(rec.type)) errs.push('type');
        } else if (impEntity === 'contacts' || impEntity === 'engineers') {
          if (rec.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.email)) errs.push('email');
        } else if (impEntity === 'contracts') {
          ['response_hours', 'onsite_hours', 'resolve_hours', 'availability_pct'].forEach(function (k) {
            if (rec[k] && isNaN(Number(rec[k]))) errs.push(k);
          });
          ['phone_enabled', 'onsite_enabled', 'support_24_7'].forEach(function (k) {
            if (rec[k] && ['true', 'false', '1', '0', 'yes', 'no'].indexOf(rec[k].toLowerCase()) === -1) errs.push(k);
          });
        }
        rows.push({ rec: rec, errs: errs, line: idx + 2 });
      });
      return rows;
    }
    document.getElementById('pi-file').onchange = function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var setText = function (txt) { document.getElementById('pi-text').value = txt; };
      /* v7.1 fix: Excel workbooks must go through SheetJS — reading them
         as text yields binary garbage. Convert the sheet that matches the
         selected import entity (fallback: first sheet) to CSV and feed
         the existing paste/parse pipeline. */
      if (/\.(xlsx|xls)$/i.test(f.name || '')) {
        if (typeof XLSX === 'undefined') { toast(t('parts.imp.xlsxUnavailable'), 'error'); return; }
        var xrd = new FileReader();
        xrd.onload = function () {
          try {
            var wb = XLSX.read(new Uint8Array(xrd.result), { type: 'array' });
            var names = wb.SheetNames || [];
            if (!names.length) { toast(t('parts.imp.xlsxUnavailable'), 'error'); return; }
            var pick = names.filter(function (n) { return n === impEntity; })[0] ||
              names.filter(function (n) { return n.toLowerCase() === impEntity; })[0] ||
              names[0];
            setText(XLSX.utils.sheet_to_csv(wb.Sheets[pick]));
          } catch (e) { toast(t('parts.imp.xlsxUnavailable'), 'error'); }
        };
        xrd.readAsArrayBuffer(f);
        return;
      }
      var rd = new FileReader();
      rd.onload = function () { setText(rd.result); };
      rd.readAsText(f);
    };
    function currentEntity() { return IMPORT_ENTITIES[impEntity]; }
    document.getElementById('pi-entity').onchange = function () {
      impEntity = this.value;
      document.getElementById('pi-engnote').style.display =
        impEntity === 'engineers' ? 'inline' : 'none';
      /* v6.5: qty set/add mode only makes sense for spare parts. */
      var qm = document.querySelector('input[name="pi-mode"]');
      if (qm) qm.closest('.field').style.display = impEntity === 'parts' ? 'block' : 'none';
    };
    document.getElementById('pi-template').onclick = function () {
      var blob = new Blob([currentEntity().template], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'import-template-' + impEntity + '.csv';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    };
    document.getElementById('pi-parse').onclick = function () {
      parsed = parseDelimited(document.getElementById('pi-text').value);
      if (!parsed.headers.length) { toast(t('parts.imp.empty'), 'error'); return; }
      mapping = guessMapping(parsed.headers, impFields(), currentEntity().aliases);
      document.getElementById('pi-map').innerHTML = impFields().map(function (f) {
        return '<div class="form-row" style="margin-bottom:6px;align-items:center">' +
          '<div style="width:150px;font-weight:600">' + esc(impLabel(f)) +
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
      impFields().forEach(function (f) {
        mapping[f.key] = document.getElementById('pi-map-' + f.key).value;
      });
      var missing = impFields().filter(function (f) { return f.req && !mapping[f.key]; });
      if (missing.length) {
        toast(t('parts.imp.mapMissing', { f: missing.map(function (x) { return impLabel(x); }).join(', ') }), 'error');
        return;
      }
      var rows = validateRows();
      var ok = rows.filter(function (r) { return !r.errs.length; }).length;
      document.getElementById('pi-summary').innerHTML =
        '<div class="muted">' + esc(t('parts.imp.summary')
          .replace('{ok}', String(ok)).replace('{bad}', String(rows.length - ok))) + '</div>';
      /* rebuild the header for the selected entity */
      var tbl = document.getElementById('pi-rows').closest('table');
      tbl.querySelector('thead').innerHTML = '<tr><th>#</th>' +
        impFields().map(function (f) {
          return '<th>' + esc(impLabel(f)) + (f.req ? '<span class="req">*</span>' : '') + '</th>';
        }).join('') + '<th>' + esc(t('parts.imp.status')) + '</th></tr>';
      document.getElementById('pi-rows').innerHTML = rows.map(function (r, i) {
        return '<tr class="' + (r.errs.length ? 'low-stock-red' : '') + '"><td class="muted">' + r.line + '</td>' +
          impFields().map(function (f) {
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
      var modeEl = document.querySelector('input[name="pi-mode"]:checked');
      var mode = modeEl ? modeEl.value : 'set';
      var prog = document.getElementById('pi-progress');
      var okN = 0, failN = 0, fails = [];
      function toBool(v) {
        if (v === '' || v == null) return null;
        return ['true', '1', 'yes'].indexOf(String(v).toLowerCase()) !== -1;
      }
      /* pre-resolve lookups for non-parts entities */
      var siteByCode = {}, profByEmail = {};
      if (impEntity === 'sites' || impEntity === 'contracts') {
        state.sites.forEach(function (s) { siteByCode[(s.code || '').toUpperCase()] = s; });
      }
      if (impEntity === 'sites') {
        try {
          var pr = await sb.from('profiles').select('id,email');
          (pr.data || []).forEach(function (u) { if (u.email) profByEmail[u.email.toLowerCase()] = u.id; });
        } catch (e) {}
      }
      for (var i = 0; i < rows.length; i++) {
        var rec = rows[i].rec;
        prog.innerHTML = '<div class="muted">' + esc(t('parts.imp.progress')
          .replace('{i}', String(i + 1)).replace('{n}', String(rows.length))) + '</div>';
        try {
          if (impEntity === 'parts') {
            /* v6.1: extra inventory columns (migration_v6_1; gated so old
               backends without the columns keep working). */
            var partRow = {
              code: rec.code, name: rec.name,
              category: rec.category || null, unit: rec.unit || null,
              owner: L.normalizeOwner(rec.owner) || 'longi'
            };
            if (state.v61) {
              if (rec.location) partRow.location = rec.location;
              if (rec.target_stock !== '' && !isNaN(Number(rec.target_stock)))
                partRow.target_stock = Number(rec.target_stock);
              if (rec.part_number) partRow.part_number = rec.part_number;
              if (rec.criticality) partRow.criticality = rec.criticality;
              if (rec.supplier) partRow.supplier = rec.supplier;
            }
            var up = await sb.from('spare_parts').upsert(partRow, { onConflict: 'code' }).select('id').single();
            if (up.error) throw up.error;
            /* v6.1: warehouse may be given by code OR by name
               (Massimo's sheet writes names). */
            var wh = L.findWarehouse(rec.warehouse_code, warehouses);
            if (!wh) throw new Error(t('parts.imp.badWh') + ': ' + rec.warehouse_code);
            var cur = await sb.from('stock_levels').select('qty')
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
              tx_type: mode === 'add' ? 'in' : 'adjust',
              actor_id: state.profile.id, note: 'bulk import'
            });
          } else if (impEntity === 'sites') {
            var sfields = {
              code: rec.code, name: rec.name,
              country: (rec.country || '').toUpperCase() || null,
              city: rec.city || null, address: rec.address || null,
              /* v6.1: DMS coordinates from Massimo's sheet. */
              latitude: L.parseCoordinate(rec.latitude),
              longitude: L.parseCoordinate(rec.longitude),
              description: rec.description || null
            };
            if (rec.parent_code && !L.isNaLike(rec.parent_code)) {
              var ps = siteByCode[(rec.parent_code || '').toUpperCase()];
              if (!ps) throw new Error('parent site not found: ' + rec.parent_code);
              sfields.parent_site_id = ps.id;
            }
            if (rec.remote_owner_email) {
              /* v6.1: MULTIPLE mailboxes (newline/comma separated, prose
                 around them is ignored). The full list is stored
                 comma-separated; the first mailbox still resolves the
                 legacy remote_owner_id profile link. */
              var mailList = L.extractEmails(rec.remote_owner_email);
              if (mailList.length) {
                if (state.v61) sfields.remote_owner_email = mailList.join(',');
                var oid = profByEmail[mailList[0]];
                if (oid) sfields.remote_owner_id = oid;
              }
            }
            /* v7.2: .single() — without it data is an ARRAY and the
               siteByCode registration below read .code off it (undefined
               → toUpperCase crash AFTER the row was already upserted,
               so imported sites were reported as failed). */
            var sr2 = await sb.from('sites').upsert(sfields, { onConflict: 'code' }).select('id,code').single();
            if (sr2.error) throw sr2.error;
            siteByCode[sr2.data.code.toUpperCase()] = sr2.data;
          } else if (impEntity === 'warehouses') {
            var wfields = {
              code: rec.code, name: rec.name,
              /* v6.1: "On-site"/"Off-site" → on_site/off_site. */
              type: L.normalizeWarehouseType(rec.type),
              address: rec.address || null,
              contact_name: rec.contact_name || null,
              contact_phone: rec.contact_phone || null,
              contact_email: rec.contact_email || null,
              delivery_notes: rec.delivery_notes || null
            };
            if (rec.parent_code) {
              var pw = whByCode[(rec.parent_code || '').toUpperCase()];
              if (!pw) throw new Error('parent warehouse not found: ' + rec.parent_code);
              wfields.parent_warehouse_id = pw.id;
            }
            /* v7.2: .single() — same array-data crash as the sites branch. */
            var wr2 = await sb.from('warehouses').upsert(wfields, { onConflict: 'code' }).select('id,code').single();
            if (wr2.error) throw wr2.error;
            whByCode[wr2.data.code.toUpperCase()] = wr2.data;
          } else if (impEntity === 'contacts' || impEntity === 'engineers') {
            var cfields = {
              first_name: rec.first_name, last_name: rec.last_name || null,
              company: rec.company || null,
              role: rec.role || (impEntity === 'engineers' ? 'engineer' : null),
              phone: rec.phone || null, email: rec.email || null
            };
            /* v6.1: Key People "Group" column (gated by migration_v6_1). */
            if (state.v61 && rec.group_name) cfields.group_name = rec.group_name;
            /* v6.1: engineers' Project Scope = site NAMES (fallback codes). */
            var scopeIds = (impEntity === 'engineers' && rec.project_scope)
              ? L.resolveSiteScope(rec.project_scope, state.sites) : [];
            if (impEntity === 'engineers' && cfields.email) {
              /* If a login profile already exists for this email, enrich
                 the profile master data instead of duplicating a contact. */
              var pex = await sb.from('profiles').select('id').eq('email', cfields.email).maybeSingle();
              if (pex.error) throw pex.error;
              if (pex.data) {
                var pfields = {};
                if (rec.country) pfields.country = rec.country.toUpperCase();
                if (rec.skills) pfields.skills = rec.skills;
                var cl = String(rec.cert_level || '').toLowerCase();
                if (cl === 'associate' || cl === 'professional') pfields.cert_level = cl;
                if (rec.language) pfields.language = rec.language.toLowerCase().indexOf('zh') !== -1 ? 'zh' : 'en';
                if (scopeIds.length) pfields.project_scope = scopeIds;
                var pur = await sb.from('profiles').update(pfields).eq('id', pex.data.id);
                if (pur.error) throw pur.error;
                okN++; continue;
              }
            }
            if (cfields.email) {
              var ex = await sb.from('contacts').select('id').eq('email', cfields.email).maybeSingle();
              if (ex.error) throw ex.error;
              if (ex.data) { okN++; continue; } // skip duplicates by email
            }
            var cr2 = await sb.from('contacts').insert(cfields).select('id').single();
            if (cr2.error) throw cr2.error;
            if (scopeIds.length) {
              var links = scopeIds.map(function (sid) {
                return { contact_id: cr2.data.id, site_id: sid };
              });
              var lir = await sb.from('contact_projects').insert(links);
              if (lir.error) throw lir.error;
            }
          } else if (impEntity === 'contracts') {
            var st = siteByCode[(rec.site_code || '').toUpperCase()];
            if (!st) throw new Error('site not found: ' + rec.site_code);
            /* v6.1: coverage "24/7" also implies the support_24_7 flag. */
            var s247 = toBool(rec.support_24_7);
            if (L.coverageIs247(rec.coverage)) s247 = true;
            var cfr = {
              site_id: st.id,
              response_hours: rec.response_hours === '' ? null : Number(rec.response_hours),
              onsite_hours: rec.onsite_hours === '' ? null : Number(rec.onsite_hours),
              resolve_hours: rec.resolve_hours === '' ? null : Number(rec.resolve_hours),
              /* v6.1: 0.98-style fractions → 98 (percent). */
              availability_pct: L.normalizeAvailability(rec.availability_pct),
              valid_from: rec.valid_from || null, valid_to: rec.valid_to || null,
              coverage: rec.coverage || null,
              phone_enabled: toBool(rec.phone_enabled),
              onsite_enabled: toBool(rec.onsite_enabled),
              support_24_7: s247,
              penalty_response: rec.penalty_response || null,
              penalty_onsite: rec.penalty_onsite || null,
              penalty_resolve: rec.penalty_resolve || null
            };
            var ur2 = await sb.from('ltsa_contracts').upsert(cfr, { onConflict: 'site_id' });
            if (ur2.error) throw ur2.error;
          }
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
        }).join('') + '</select></div>' +
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('parts.whType')) + '</label>' +
          '<select id="w-type"><option value="">' + esc(t('common.none')) + '</option>' +
          ['on_site', 'off_site'].map(function (k) {
            return '<option value="' + k + '"' + (warehouse.type === k ? ' selected' : '') + '>' +
              esc(t('parts.whType.' + k)) + '</option>';
          }).join('') + '</select></div>' +
      '</div>' +
      '<div class="field"><label>' + esc(t('parts.whAddress')) + '</label>' +
        '<input type="text" id="w-addr" value="' + esc(warehouse.address || '') + '"></div>' +
      '<div class="form-row">' +
        '<div class="field"><label>' + esc(t('parts.contactName')) + '</label>' +
          '<input type="text" id="w-cname" value="' + esc(warehouse.contact_name || '') + '"></div>' +
        '<div class="field"><label>' + esc(t('parts.contactPhone')) + '</label>' +
          '<input type="text" id="w-cphone" value="' + esc(warehouse.contact_phone || '') + '"></div>' +
      '</div>' +
      '<div class="field"><label>' + esc(t('parts.contactEmail')) + '</label>' +
        '<input type="text" id="w-cemail" value="' + esc(warehouse.contact_email || '') + '"></div>' +
      '<div class="field"><label>' + esc(t('parts.deliveryNotes')) + '</label>' +
        '<textarea id="w-dnotes" style="height:52px">' + esc(warehouse.delivery_notes || '') + '</textarea></div>';
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
                       parent_warehouse_id: document.getElementById('w-parent').value || null,
                       type: document.getElementById('w-type').value || null,
                       address: document.getElementById('w-addr').value.trim() || null,
                       contact_name: document.getElementById('w-cname').value.trim() || null,
                       contact_phone: document.getElementById('w-cphone').value.trim() || null,
                       contact_email: document.getElementById('w-cemail').value.trim() || null,
                       delivery_notes: document.getElementById('w-dnotes').value.trim() || null };
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
    var canReturn = role === 'engineer' || role === 'tech_manager' || role === 'dispatcher' || role === 'admin';
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
    /* v7.12: yearly planned-maintenance plan for this site — 12 tickets
       (tracker=maintenance, planned_date per month) + progress + print. */
    var maintYear = (new Date()).getFullYear();
    var maintTickets = [];
    async function loadMaintTickets() {
      if (!state.v7) return;
      try {
        var r = await baseTicketQuery('id,ticket_no,title,status,planned_date')
          .eq('site_id', id).eq('tracker', 'maintenance')
          .gte('planned_date', maintYear + '-01-01').lt('planned_date', (maintYear + 1) + '-01-01')
          .order('planned_date');
        if (!r.error) maintTickets = r.data || [];
      } catch (e) {}
    }
    function maintCard() {
      if (!state.v7) return '';
      var plan = L.monthlyPlanDates(maintYear);
      var prog = L.maintenanceProgress(maintTickets, maintYear);
      var rows = plan.map(function (md, i) {
        var tk = maintTickets.filter(function (x) {
          return x.planned_date && x.planned_date.indexOf(md) === 0;
        })[0];
        return '<tr><td>' + esc(md) + '</td><td>' +
          (tk
            ? '<a href="#/ticket/' + tk.id + '" class="tnum">' + esc(L.formatTicketNo(tk.ticket_no)) + '</a> ' +
              statusBadge(tk.status)
            : '<span class="muted">—</span>') +
          '</td></tr>';
      }).join('');
      var pct = Math.round(100 * prog.done / 12);
      return '<div class="card"><h2>' + esc(t('maint.planTitle')) + ' (' + maintYear + ')</h2>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><div class="loadbar" style="flex:1">' +
          '<div style="width:' + pct + '%"></div></div><b>' + prog.done + '/12</b></div>' +
        '<div style="overflow-x:auto;max-height:280px;overflow-y:auto"><table class="tbl"><thead><tr>' +
          '<th>' + esc(t('maint.month')) + '</th><th>' + esc(t('list.columns.ticket')) + '</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        (L.can('ticket.create', state.profile.role)
          ? '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="btn btn-sm btn-primary" id="maint-gen">' + esc(t('maint.generate')) + '</button>' +
            '<button class="btn btn-sm" id="maint-print">' + esc(t('maint.printYear')) + '</button></div>'
          : '') +
      '</div>';
    }
    await resolveNames([site.remote_owner_id].concat(collectIds(tickets)));
    if (state.v7) await loadMaintTickets();

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
      '<dt>' + esc(t('sites.remoteOwner')) + '</dt><dd>' +
        esc(site.remote_owner_group_id ? ('👥 ' + groupName(site.remote_owner_group_id)) : displayName(site.remote_owner_id)) + '</dd>' +
      /* v6.1: remote owner email list + default support group (dispatch) */
      (state.v61 && site.remote_owner_email
        ? '<dt>' + esc(t('sites.remoteOwnerEmail')) + '</dt><dd>' + esc(site.remote_owner_email) + '</dd>' : '') +
      (state.v61
        ? '<dt>' + esc(t('sites.defaultGroup')) + '</dt><dd>' +
          esc(site.default_group_id ? groupName(site.default_group_id) : '—') + '</dd>' : '') +
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

    /* v6.1: site team roster — contacts linked via contact_projects,
       showing the per-project role (e.g. Field Service Technician). */
    function teamCard() {
      if (!state.v6) return '';
      var links = state.contactProjects.filter(function (r) { return r.site_id === id; });
      if (!links.length) return '';
      var rows = links.map(function (r) {
        var c = state.contacts.filter(function (x) { return x.id === r.contact_id; })[0];
        if (!c) return '';
        var nm = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || c.email || '—';
        var role = (state.v61 && r.role) ? r.role : (c.role || '—');
        return '<tr><td><b>' + esc(nm) + '</b></td>' +
          '<td class="muted">' + esc(c.company || '—') + '</td>' +
          '<td>' + esc(role) + '</td>' +
          '<td class="muted">' + esc(c.phone || '—') + '</td>' +
          '<td class="muted">' + esc(c.email || '—') + '</td></tr>';
      }).join('');
      return '<div class="card"><h2>' + esc(t('sites.team')) + '</h2>' +
        '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
        '<th>' + esc(t('contacts.firstName')) + '</th><th>' + esc(t('contacts.company')) + '</th>' +
        '<th>' + esc(t('sites.teamRole')) + '</th><th>' + esc(t('contacts.phone')) + '</th>' +
        '<th>' + esc(t('contacts.email')) + '</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    }

    /* v8 (#6/#8): project members & linked groups. Members are derived
       from profiles.project_scope; all-scope staff (empty scope) are
       summarized, not listed. Editing is admin-only (user.manage) and
       writes project_scope — the single source of truth. */
    var siteUsers = [];
    try {
      var sur = await sb.from('profiles')
        .select('id,display_name,email,role,project_scope').eq('is_active', true);
      if (!sur.error) siteUsers = sur.data || [];
    } catch (e) { siteUsers = []; }
    function membersCard() {
      var gids = {};
      if (site.default_group_id) gids[site.default_group_id] = true;
      (state.groupSites || []).forEach(function (gs) { if (gs.site_id === id) gids[gs.group_id] = true; });
      var gnames = Object.keys(gids).map(function (gid) { return groupName(gid); }).filter(Boolean);
      var explicit = siteUsers.filter(function (u) {
        return Array.isArray(u.project_scope) && u.project_scope.indexOf(id) !== -1;
      });
      var allScopeCount = siteUsers.filter(function (u) {
        return u.role !== 'customer' && (!Array.isArray(u.project_scope) || !u.project_scope.length);
      }).length;
      var canEditMembers = L.can('user.manage', state.profile.role);
      var rows = explicit.map(function (u) {
        return '<tr><td><b>' + esc(u.display_name || u.email) + '</b></td>' +
          '<td><span class="role-tag">' + esc(t('role.' + u.role)) + '</span></td>' +
          '<td class="muted">' + esc(u.email || '') + '</td>' +
          (canEditMembers
            ? '<td><button class="btn btn-sm btn-danger" data-member-remove="' + u.id + '">' +
              esc(t('common.remove')) + '</button></td>'
            : '') + '</tr>';
      }).join('');
      var candidates = siteUsers.filter(function (u) {
        return explicit.indexOf(u) === -1 &&
          (!Array.isArray(u.project_scope) || u.project_scope.length);
      });
      return '<div class="card"><h2>' + esc(t('sites.members')) + '</h2>' +
        '<div class="muted" style="margin-bottom:6px">' + esc(t('sites.linkedGroups')) + ': ' +
          esc(gnames.length ? gnames.join(', ') : '—') + '</div>' +
        (allScopeCount
          ? '<div class="muted" style="margin-bottom:6px">' +
            esc(t('sites.allScopeStaff', { n: allScopeCount })) + '</div>' : '') +
        (rows
          ? '<table class="tbl"><tbody>' + rows + '</tbody></table>'
          : '<div class="empty">' + esc(t('sites.noMembers')) + '</div>') +
        (canEditMembers && candidates.length
          ? '<div style="display:flex;gap:6px;margin-top:10px"><select id="member-add-sel" style="flex:1">' +
            candidates.map(function (u) {
              return '<option value="' + u.id + '">' + esc((u.display_name || u.email) + ' (' + u.email + ')') + '</option>';
            }).join('') + '</select>' +
            '<button class="btn btn-sm btn-primary" id="member-add-btn">+ ' + esc(t('sites.addMember')) + '</button></div>'
          : '') +
      '</div>';
    }

    view.innerHTML =
      '<button class="btn btn-sm" id="back-btn" style="margin-bottom:12px">← ' + esc(t('sites.backToSites')) + '</button>' +
      '<div class="detail-head"><span class="tnum">' + esc(site.code) + '</span>' +
        contractBadgeFor(contract) +
        '<span class="badge status-open">' + openCount + ' ' + esc(t('sites.openTickets')) + '</span></div>' +
      '<h1 class="detail-title">' + esc(site.name) + '</h1>' +
      '<div class="grid-2"><div>' + ident + ccard + '</div><div>' + whcard + tcard + teamCard() + membersCard() + maintCard() + chcard + '</div></div>';
    document.getElementById('back-btn').onclick = function () { nav('#/sites'); };
    /* v8 (#8): member add/remove writes profiles.project_scope. */
    var memberAddBtn = document.getElementById('member-add-btn');
    if (memberAddBtn) memberAddBtn.onclick = async function () {
      var uid = document.getElementById('member-add-sel').value;
      var u = siteUsers.filter(function (x) { return x.id === uid; })[0];
      if (!u) return;
      var scope = (Array.isArray(u.project_scope) ? u.project_scope : []).concat([id]);
      var r = await sb.from('profiles').update({ project_scope: scope }).eq('id', uid);
      if (r.error) { apiError(r.error); return; }
      toast(t('common.saved'), 'ok'); render();
    };
    view.querySelectorAll('[data-member-remove]').forEach(function (b) {
      b.onclick = async function () {
        var uid = b.getAttribute('data-member-remove');
        var u = siteUsers.filter(function (x) { return x.id === uid; })[0];
        if (!u) return;
        var scope = (u.project_scope || []).filter(function (s) { return s !== id; });
        var r = await sb.from('profiles').update({ project_scope: scope }).eq('id', uid);
        if (r.error) { apiError(r.error); return; }
        toast(t('common.saved'), 'ok'); render();
      };
    });
    bindTableNav(view);
    /* v7.12: generate the yearly plan (12 maintenance tickets) + print. */
    var mgBtn = document.getElementById('maint-gen');
    if (mgBtn) mgBtn.onclick = async function () {
      mgBtn.disabled = true;
      try {
        var plan = L.monthlyPlanDates(maintYear);
        var existing = {};
        maintTickets.forEach(function (x) {
          if (x.planned_date) existing[x.planned_date.slice(0, 10)] = true;
        });
        var clField = (state.customFields || []).filter(function (f) {
          return f.key === 'maint_checklist';
        })[0];
        var cv = clField ? { maint_checklist: [] } : {};
        var created = 0;
        for (var mi = 0; mi < plan.length; mi++) {
          if (existing[plan[mi]]) continue;
          /* Planned (scheduled) tickets carry no reactive SLA clocks. */
          var c9 = (state.contracts || {})[site.id];
          var ins = await sb.from('tickets').insert({
            title: t('tracker.maintenance') + ' — ' + site.code + ' ' + plan[mi].slice(0, 7),
            description: '', status: 'open', priority: 'medium', source: 'internal_discovery',
            tracker: 'maintenance', workflow_key: site.segment === 'utility' ? 'utility' : 'ci',
            site_id: site.id, planned_date: plan[mi], custom_values: cv,
            created_by: state.profile.id, is_ltsa: !!(c9 && L.isContractActive(c9))
          });
          if (ins.error) throw ins.error;
          created++;
        }
        toast(t('maint.generatedCount').replace('{n}', String(created)), 'ok');
        render();
      } catch (e) { apiError(e); mgBtn.disabled = false; }
    };
    var mpBtn = document.getElementById('maint-print');
    if (mpBtn) mpBtn.onclick = function () {
      var pr = document.getElementById('print-report');
      if (!pr) {
        pr = document.createElement('div'); pr.id = 'print-report';
        document.body.appendChild(pr);
      }
      var plan = L.monthlyPlanDates(maintYear);
      var prog = L.maintenanceProgress(maintTickets, maintYear);
      pr.innerHTML = '<h1>' + esc(t('maint.planTitle')) + ' — ' +
        esc(site.code + ' ' + site.name) + ' (' + maintYear + ')</h1>' +
        '<div class="pr-meta">' + esc(t('maint.progress')) + ': ' + prog.done + '/12</div>' +
        '<table><thead><tr><th>' + esc(t('maint.month')) + '</th><th>' +
          esc(t('list.columns.ticket')) + '</th><th>' + esc(t('common.status')) + '</th></tr></thead><tbody>' +
        plan.map(function (md) {
          var tk = maintTickets.filter(function (x) {
            return x.planned_date && x.planned_date.indexOf(md) === 0;
          })[0];
          return '<tr><td>' + esc(md) + '</td><td>' +
            esc(tk ? L.formatTicketNo(tk.ticket_no) : '—') + '</td><td>' +
            esc(tk ? t('status.' + tk.status) : '—') + '</td></tr>';
        }).join('') + '</tbody></table>';
      window.print();
    };
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
        '<div class="field"><label><input type="checkbox" id="c-247"' +
          (contract.support_24_7 ? ' checked' : '') + ' style="width:auto;margin-right:6px">' +
          esc(t('contract.support247')) + '</label></div>' +
      '</div>' +
      (state.v6
        ? '<div class="field"><label>' + esc(t('contract.contacts')) + '</label>' +
          '<div style="max-height:150px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:8px 10px">' +
          state.contacts.map(function (c) {
            var nm = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || c.email || c.id;
            var linked = state.contractContacts[contract.id] || [];
            return '<label style="display:block;padding:2px 0;font-weight:normal">' +
              '<input type="checkbox" class="cc-contact" value="' + c.id + '"' +
              (linked.indexOf(c.id) !== -1 ? ' checked' : '') + '> ' +
              esc(nm + (c.company ? ' (' + c.company + ')' : '')) + '</label>';
          }).join('') + '</div></div>'
        : '') +
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
          support_24_7: document.getElementById('c-247').checked,
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
        /* v6: sync contract <-> contact links (multi contacts per contract). */
        if (state.v6 && saved.id) {
          var selC = Array.prototype.map.call(
            document.querySelectorAll('.cc-contact:checked'), function (el) { return el.value; });
          await sb.from('ltsa_contract_contacts').delete().eq('contract_id', saved.id);
          if (selC.length) {
            var lr = await sb.from('ltsa_contract_contacts').insert(
              selC.map(function (cid) { return { contract_id: saved.id, contact_id: cid }; }));
            if (lr.error) throw lr.error;
          }
          state.contractContacts[saved.id] = selC;
        }
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
    var er = await sb.from('profiles').select('*').in('role', ['engineer', 'tech_manager']).eq('is_active', true)
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
        await afterSignIn(s.data.session.user, { fromBoot: true });
        return; // afterSignIn restores the current route (v8 #1)
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
