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
    nameCache: {},       // profile id -> display name (best effort)
    listFilters: { status: '', priority: '', source: '', site: '', assignee: '', q: '' }
  };

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
    setTimeout(function () { el.remove(); }, kind === 'error' ? 6000 : 3500);
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
  }

  /** Role-aware base ticket query (RLS is the real filter; this trims noise). */
  function baseTicketQuery() {
    var q = sb.from('tickets').select('*');
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

  async function fetchTickets(filters) {
    var q = baseTicketQuery().order('updated_at', { ascending: false }).limit(500);
    if (filters.status) q = q.eq('status', filters.status);
    if (filters.priority) q = q.eq('priority', filters.priority);
    if (filters.source) q = q.eq('source', filters.source);
    if (filters.site) q = q.eq('site_id', filters.site);
    if (filters.assignee) q = q.eq('assigned_to', filters.assignee);
    if (filters.q) {
      var term = filters.q.trim();
      var m = term.match(/^t-?0*(\d+)$/i);
      if (m) q = q.eq('ticket_no', parseInt(m[1], 10));
      else {
        var like = '%' + term.replace(/[%_]/g, '') + '%';
        q = q.or('title.ilike.' + like + ',description.ilike.' + like);
      }
    }
    var res = await q;
    if (res.error) { apiError(res.error); return []; }
    return res.data || [];
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
    var name = h.replace(/^#\//, '').split('?')[0];
    if (['login', 'dashboard', 'tickets', 'new', 'users', 'sites'].indexOf(name) === -1) name = 'dashboard';
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
    renderShell(route.name);
    var view = document.getElementById('view');
    view.innerHTML = '<div class="empty">' + esc(t('common.loading')) + '</div>';
    try {
      if (route.name === 'dashboard') await viewDashboard(view);
      else if (route.name === 'tickets') await viewTicketList(view);
      else if (route.name === 'detail') await viewTicketDetail(view, route.id);
      else if (route.name === 'new') viewNewTicket(view);
      else if (route.name === 'users') { if (guard('user.manage')) await viewUsers(view); }
      else if (route.name === 'sites') { if (guard('site.manage')) await viewSites(view); }
    } catch (e) {
      view.innerHTML = '<div class="inline-err">' + esc(e.message || t('common.error')) + '</div>';
    }
  }

  /* ------------------------------- shell -------------------------------- */
  function renderShell(active) {
    var p = state.profile;
    var links = [
      { id: 'dashboard', href: '#/dashboard', label: t('nav.dashboard'), perm: null },
      { id: 'tickets',   href: '#/tickets',   label: t('nav.tickets'),   perm: null },
      { id: 'new',       href: '#/new',       label: t('nav.newTicket'), perm: 'ticket.create' },
      { id: 'sites',     href: '#/sites',     label: t('nav.sites'),     perm: 'site.manage' },
      { id: 'users',     href: '#/users',     label: t('nav.users'),     perm: 'user.manage' }
    ];
    var navHtml = links
      .filter(function (l) { return !l.perm || L.can(l.perm, p.role); })
      .map(function (l) {
        return '<a href="' + l.href + '"' + (active === l.id ? ' class="active"' : '') + '>' +
               esc(l.label) + '</a>';
      }).join('');
    app.innerHTML =
      '<header class="app-header"><div class="header-inner">' +
        '<div class="brand"><img src="assets/longi-logo.svg" alt="LONGi">' +
        '<span class="tagline">' + esc(t('app.tagline')) + '</span></div>' +
        '<nav class="main-nav">' + navHtml + '</nav>' +
        '<div class="header-spacer"></div>' +
        '<div class="header-user">' +
          '<button class="lang-toggle" id="lang-toggle">' +
            (lang === 'en' ? '中文' : 'EN') + '</button>' +
          '<div class="who"><b>' + esc(p.display_name || p.email) + '</b>' +
          '<span><span class="role-tag">' + esc(t('role.' + p.role)) + '</span></span></div>' +
          '<button class="btn btn-sm" id="logout-btn">' + esc(t('nav.logout')) + '</button>' +
        '</div>' +
      '</div></header>' +
      '<main class="page" id="view"></main>';
    document.getElementById('lang-toggle').onclick = function () {
      setLang(lang === 'en' ? 'zh' : 'en');
    };
    document.getElementById('logout-btn').onclick = logout;
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
  async function viewDashboard(view) {
    var tickets = await fetchTickets({});
    await runEscalationJob(tickets);
    await resolveNames(collectIds(tickets));
    var me = state.profile.id;
    var open = tickets.filter(function (x) { return L.TERMINAL_STATUSES.indexOf(x.status) === -1; });
    var unassigned = open.filter(function (x) { return !x.assigned_to; });
    var breached = open.filter(function (x) { return L.isSlaBreached(x); });
    var mine = open.filter(function (x) { return x.assigned_to === me || x.created_by === me; });

    function counter(label, n, danger, hash) {
      return '<div class="card counter' + (danger && n > 0 ? ' danger' : '') + ' clickable" data-nav="' + hash + '">' +
        '<div class="num">' + n + '</div><div class="lbl">' + esc(label) + '</div></div>';
    }
    var html =
      '<div class="page-head"><div><h1>' + esc(t('dash.title')) + '</h1>' +
      '<p class="page-sub">' + esc(t('dash.welcome')) + ', ' + esc(state.profile.display_name || '') +
      ' — ' + esc(t('dash.hint.' + state.profile.role)) + '</p></div></div>' +
      '<div class="grid-4">' +
        counter(t('dash.openTickets'), open.length, false, '#/tickets') +
        counter(t('dash.unassigned'), unassigned.length, unassigned.length > 0, '#/tickets') +
        counter(t('dash.breachedSla'), breached.length, true, '#/tickets') +
        counter(t('dash.myTickets'), mine.length, false, '#/tickets') +
      '</div>' +
      '<div class="card" style="margin-top:16px"><h2>' + esc(t('dash.recent')) + '</h2>' +
        ticketTable(tickets.slice(0, 8)) +
      '</div>';
    view.innerHTML = html;
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

  function ticketTable(tickets) {
    if (!tickets.length) return '<div class="empty">' + esc(t('list.noResults')) + '</div>';
    var rows = tickets.map(function (x) {
      var sla = L.ticketSla(x);
      var worst = ['response', 'onsite', 'resolution'].some(function (k) { return sla[k].state === 'breached'; });
      return '<tr class="clickable" data-id="' + x.id + '">' +
        '<td class="tnum">' + esc(L.formatTicketNo(x.ticket_no)) + '</td>' +
        '<td>' + esc(x.title) + '</td>' +
        '<td>' + statusBadge(x.status) + '</td>' +
        '<td>' + priBadge(x.priority) + '</td>' +
        '<td class="muted">' + esc(siteShort(x.site_id)) + '</td>' +
        '<td>' + esc(displayName(x.assigned_to)) + '</td>' +
        '<td>' + (worst ? badge('sla-breached', t('detail.sla.breached'))
                        : badge('sla-ok', t('detail.sla.ok'))) +
             (x.escalated ? ' ' + badge('escalated', t('detail.escalated')) : '') + '</td>' +
        '<td class="muted">' + esc(fmtDate(x.updated_at)) + '</td>' +
      '</tr>';
    }).join('');
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
  async function viewTicketList(view) {
    var f = state.listFilters;
    var tickets = await fetchTickets(f);
    await runEscalationJob(tickets);
    await resolveNames(collectIds(tickets));

    function opt(val, label, sel) {
      return '<option value="' + esc(val) + '"' + (sel === val ? ' selected' : '') + '>' + esc(label) + '</option>';
    }
    function selectOpts(values, labelKey, sel) {
      return '<option value="">' + esc(t('common.all')) + '</option>' +
        values.map(function (v) { return opt(v, t(labelKey + v), sel); }).join('');
    }
    var siteOpts = '<option value="">' + esc(t('common.all')) + '</option>' +
      state.sites.map(function (s) { return opt(s.id, s.code + ' — ' + s.name, f.site); }).join('');

    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('list.title')) + '</h1>' +
      (L.can('ticket.create', state.profile.role)
        ? '<button class="btn btn-primary" id="new-ticket-btn">+ ' + esc(t('nav.newTicket')) + '</button>' : '') +
      '</div>' +
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
      '</div>' +
      '<div style="margin-bottom:12px"><button class="btn btn-sm" id="f-clear">' + esc(t('common.clear')) + '</button></div>' +
      '<div id="list-result">' + ticketTable(tickets) + '</div></div>';

    if (L.can('ticket.create', state.profile.role)) {
      document.getElementById('new-ticket-btn').onclick = function () { nav('#/new'); };
    }
    var deb = null;
    function refetch() {
      f.status = document.getElementById('f-status').value;
      f.priority = document.getElementById('f-priority').value;
      f.source = document.getElementById('f-source').value;
      f.site = document.getElementById('f-site').value;
      f.q = document.getElementById('f-q').value;
      render();
    }
    ['f-status', 'f-priority', 'f-source', 'f-site'].forEach(function (id) {
      document.getElementById(id).onchange = refetch;
    });
    document.getElementById('f-q').oninput = function () {
      clearTimeout(deb); deb = setTimeout(refetch, 400);
    };
    document.getElementById('f-clear').onclick = function () {
      state.listFilters = { status: '', priority: '', source: '', site: '', assignee: '', q: '' };
      render();
    };
    bindTableNav(view);
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
      '<div class="detail-head"><span class="tnum">' + esc(L.formatTicketNo(ticket.ticket_no)) + '</span>' +
        statusBadge(ticket.status) + priBadge(ticket.priority) +
        badge('status-open', t('source.' + ticket.source)) +
        (ticket.escalated ? badge('escalated', t('detail.escalated')) : '') + '</div>' +
      '<h1 class="detail-title">' + esc(ticket.title) + '</h1>' +
      '<div class="grid-2">' +
      '<div>' + // left column
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
            ? '<div style="margin-top:10px"><input type="file" id="photo-input" accept="image/*" multiple>' +
              '<div class="hint" style="font-size:12px;color:var(--text-muted);margin:6px 0">' +
              esc(t('detail.photos.hint')) + '</div>' +
              '<button class="btn btn-sm btn-primary" id="photo-upload-btn">' + esc(t('common.upload')) + '</button></div>'
            : '') +
        '</div>' +
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
      '<div>' + // right column
        '<div class="card"><h2>' + esc(t('common.details')) + '</h2><dl class="kv">' +
          '<dt>' + esc(t('detail.source')) + '</dt><dd>' + esc(t('source.' + ticket.source)) + '</dd>' +
          '<dt>' + esc(t('detail.site')) + '</dt><dd>' + esc(siteLabel(ticket.site_id)) + '</dd>' +
          '<dt>' + esc(t('detail.createdBy')) + '</dt><dd>' + esc(displayName(ticket.created_by)) + '</dd>' +
          '<dt>' + esc(t('common.createdAt')) + '</dt><dd>' + esc(fmtDate(ticket.created_at)) + '</dd>' +
          '<dt>' + esc(t('common.updatedAt')) + '</dt><dd>' + esc(fmtDate(ticket.updated_at)) + '</dd>' +
          (ticket.escalated_at ? '<dt>' + esc(t('detail.escalated')) + '</dt><dd>' + esc(fmtDate(ticket.escalated_at)) + '</dd>' : '') +
        '</dl></div>' +
        (canAssign
          ? '<div class="card"><h2>' + esc(t('detail.assignment')) + '</h2>' +
            '<div id="assign-box"><div class="empty">' + esc(t('common.loading')) + '</div></div></div>'
          : '<div class="card"><h2>' + esc(t('detail.assignment')) + '</h2><dl class="kv">' +
            '<dt>' + esc(t('detail.assignee')) + '</dt><dd>' + esc(displayName(ticket.assigned_to)) + '</dd>' +
            '<dt>' + esc(t('detail.plannedCheckAt')) + '</dt><dd>' + esc(fmtDate(ticket.planned_check_at)) + '</dd>' +
            '</dl></div>') +
        (transitions.length
          ? '<div class="card"><h2>' + esc(t('detail.transitions')) + '</h2>' +
            '<div class="status-btns">' + transitions.map(function (to) {
              return '<button class="btn btn-sm" data-transition="' + to + '">' +
                esc(t('detail.transition.to')) + ' “' + esc(t('status.' + to)) + '”</button>';
            }).join('') + '</div></div>'
          : '') +
        '<div class="card"><h2>' + esc(t('detail.timeline')) + '</h2><ul class="timeline" id="timeline"></ul></div>' +
      '</div></div>';

    view.innerHTML = html;
    document.getElementById('back-btn').onclick = function () { nav('#/tickets'); };

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
          if (to === 'resolved') patch.resolved_at = new Date().toISOString();
          if (to === 'in_progress' && ticket.status === 'resolved') patch.resolved_at = null;
          var r = await sb.from('tickets').update(patch).eq('id', ticket.id);
          if (r.error) throw r.error;
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
        var files = input.files;
        if (!files.length) return;
        var btn = this; btn.disabled = true; btn.textContent = t('common.uploading');
        try {
          for (var i = 0; i < files.length; i++) {
            await uploadPhoto(ticket, files[i]);
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
  }

  async function renderAssignBox(ticket, done) {
    var box = document.getElementById('assign-box');
    var res;
    try {
      res = await sb.from('profiles').select('id,display_name,email')
        .eq('role', 'engineer').eq('is_active', true).order('display_name');
    } catch (e) { res = { error: e }; }
    if (res.error) {
      box.innerHTML = '<div class="inline-err">' + esc(res.error.message || t('common.error')) + '</div>';
      return;
    }
    var engs = res.data || [];
    engs.forEach(function (e) { state.nameCache[e.id] = e.display_name || e.email; });
    box.innerHTML =
      '<dl class="kv" style="margin-bottom:12px">' +
        '<dt>' + esc(t('detail.assignee')) + '</dt><dd>' + esc(displayName(ticket.assigned_to)) + '</dd>' +
        '<dt>' + esc(t('detail.plannedCheckAt')) + '</dt><dd>' + esc(fmtDate(ticket.planned_check_at)) + '</dd>' +
      '</dl>' +
      '<div class="assign-row"><div class="field"><label>' + esc(t('detail.assignee')) + '</label>' +
        '<select id="assign-eng"><option value="">' + esc(t('common.select')) + '</option>' +
        engs.map(function (e) {
          return '<option value="' + e.id + '"' + (ticket.assigned_to === e.id ? ' selected' : '') + '>' +
            esc(e.display_name || e.email) + '</option>';
        }).join('') + '</select></div>' +
      '<div class="field"><label>' + esc(t('detail.plannedCheckAt')) + '</label>' +
        '<input type="datetime-local" id="assign-planned" value="' + fmtInputDateTime(ticket.planned_check_at) + '"></div>' +
      '</div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-primary btn-sm" id="assign-btn">' +
          esc(ticket.assigned_to ? t('detail.reassign') : t('detail.assign')) + '</button>' +
        (ticket.assigned_to ? '<button class="btn btn-sm" id="unassign-btn">' + esc(t('detail.unassign')) + '</button>' : '') +
      '</div>';
    document.getElementById('assign-btn').onclick = async function () {
      var engId = document.getElementById('assign-eng').value;
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
      var img = it.url
        ? '<a href="' + esc(it.url) + '" target="_blank" rel="noopener"><img src="' + esc(it.url) + '" alt=""></a>'
        : '<div class="empty">—</div>';
      return '<div class="photo">' + img +
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

  function renderTimeline(ticket, comments, photos) {
    var el = document.getElementById('timeline');
    var ev = [];
    function add(ts, label, hot) { if (ts) ev.push({ ts: ts, label: label, hot: !!hot }); }
    add(ticket.created_at, t('detail.tl.created'));
    add(ticket.responded_at, t('detail.tl.responded'));
    add(ticket.visited_at, t('detail.tl.visited'));
    add(ticket.escalated_at, t('detail.tl.escalated'), true);
    add(ticket.resolved_at || (ticket.status === 'closed' ? ticket.updated_at : null), t('detail.tl.resolved'));
    comments.forEach(function (c) {
      add(c.created_at, t('detail.tl.comment') + ' — ' + displayName(c.author_id) +
        (c.is_internal ? ' (' + t('detail.comments.internal') + ')' : ''));
    });
    photos.forEach(function (p) {
      add(p.created_at, t('detail.tl.photo') + ' — ' + (p.file_name || ''));
    });
    ev.sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });
    el.innerHTML = ev.map(function (e) {
      return '<li class="' + (e.hot ? 'hot' : '') + '">' + esc(e.label) +
        '<div class="t-time">' + esc(fmtDate(e.ts)) + '</div></li>';
    }).join('') || '<li>—</li>';
  }

  /* ------------------------- modals: edit ticket ------------------------ */
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
        '<textarea id="et-desc">' + esc(ticket.description || '') + '</textarea></div>';
    var close = openModal(t('detail.editTicket'), body,
      '<button class="btn" id="m-cancel">' + esc(t('common.cancel')) + '</button>' +
      '<button class="btn btn-primary" id="m-save">' + esc(t('common.save')) + '</button>');
    document.getElementById('m-cancel').onclick = close;
    document.getElementById('m-save').onclick = async function () {
      var title = document.getElementById('et-title').value.trim();
      if (!title) { toast(t('new.fillRequired'), 'error'); return; }
      this.disabled = true;
      try {
        var r = await sb.from('tickets').update({
          title: title,
          description: document.getElementById('et-desc').value,
          priority: document.getElementById('et-priority').value,
          site_id: document.getElementById('et-site').value || null
        }).eq('id', ticket.id);
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
    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('new.title')) + '</h1></div>' +
      '<div class="card"><h2>' + esc(t('new.formTitle')) + '</h2>' +
      '<form id="new-form">' +
        '<div class="field"><label>' + esc(t('new.field.title')) + '<span class="req">*</span></label>' +
          '<input type="text" id="nt-title" required></div>' +
        '<div class="form-row">' +
          '<div class="field"><label>' + esc(t('new.field.priority')) + '</label>' +
            '<select id="nt-priority">' + L.PRIORITIES.map(function (pr) {
              return '<option value="' + pr + '"' + (pr === 'medium' ? ' selected' : '') + '>' +
                esc(t('priority.' + pr)) + '</option>';
            }).join('') + '</select></div>' +
          '<div class="field"><label>' + esc(t('new.field.source')) + '<span class="req">*</span></label>' +
            '<select id="nt-source">' + sources.map(function (s) {
              return '<option value="' + s + '">' + esc(t('source.' + s)) + '</option>';
            }).join('') + '</select>' +
            (role === 'customer' ? '<div class="hint">' + esc(t('new.sourceHint.customer')) + '</div>' : '') + '</div>' +
        '</div>' +
        '<div class="field"><label>' + esc(t('new.field.site')) + '</label>' +
          '<select id="nt-site"><option value="">' + esc(t('common.none')) + '</option>' +
          state.sites.map(function (s) {
            return '<option value="' + s.id + '">' + esc(s.code + ' — ' + s.name) + '</option>';
          }).join('') + '</select></div>' +
        '<div class="form-row">' +
          '<div class="field"><label>' + esc(t('detail.serialNumber')) + '<span class="req">*</span></label>' +
            '<input type="text" id="nt-serial" required></div>' +
          '<div class="field"><label>' + esc(t('detail.firmwareVersion')) + '<span class="req">*</span></label>' +
            '<input type="text" id="nt-fw" required></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="field"><label>' + esc(t('detail.errorCode')) + '<span class="req">*</span></label>' +
            '<input type="text" id="nt-err" required></div>' +
          '<div class="field"><label>' + esc(t('detail.actionsTaken')) + '<span class="req">*</span></label>' +
            '<input type="text" id="nt-actions" required></div>' +
        '</div>' +
        '<div class="field"><label>' + esc(t('new.field.description')) + '<span class="req">*</span></label>' +
          '<textarea id="nt-desc" required></textarea></div>' +
        '<div class="form-actions">' +
          '<button type="submit" class="btn btn-primary" id="nt-submit">' + esc(t('common.create')) + '</button>' +
          '<button type="button" class="btn" id="nt-cancel">' + esc(t('common.cancel')) + '</button>' +
        '</div>' +
      '</form></div>';
    document.getElementById('nt-cancel').onclick = function () { nav('#/tickets'); };
    document.getElementById('new-form').onsubmit = async function (e) {
      e.preventDefault();
      var get = function (id) { return document.getElementById(id).value.trim(); };
      var required = ['nt-title', 'nt-serial', 'nt-fw', 'nt-err', 'nt-actions', 'nt-desc'];
      var missing = required.some(function (id) { return !get(id); });
      if (missing) { toast(t('new.fillRequired'), 'error'); return; }
      var btn = document.getElementById('nt-submit');
      btn.disabled = true;
      try {
        var now = new Date();
        var dl = L.computeSlaDeadlines(now, get('nt-priority') || 'medium', state.slaPolicies);
        var siteVal = document.getElementById('nt-site').value || null;
        var ins = await sb.from('tickets').insert({
          title: get('nt-title'),
          description: get('nt-desc'),
          priority: document.getElementById('nt-priority').value,
          source: document.getElementById('nt-source').value,
          site_id: siteVal,
          serial_number: get('nt-serial'),
          firmware_version: get('nt-fw'),
          error_code: get('nt-err'),
          actions_taken: get('nt-actions'),
          created_by: state.profile.id,
          sla_response_at: dl.response && dl.response.toISOString(),
          sla_onsite_at: dl.onsite && dl.onsite.toISOString(),
          sla_resolve_at: dl.resolve && dl.resolve.toISOString()
        }).select('id,ticket_no').single();
        if (ins.error) throw ins.error;
        toast(t('new.created', { no: L.formatTicketNo(ins.data.ticket_no) }), 'ok');
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
    var rows = users.map(function (u) {
      var scope = (u.project_scope && u.project_scope.length)
        ? u.project_scope.map(siteShort).join(', ') : t('users.projectScopeAll');
      return '<tr>' +
        '<td><b>' + esc(u.display_name || '—') + '</b><br><span class="muted">' + esc(u.email || '') + '</span></td>' +
        '<td>' + esc(t('role.' + u.role)) + '</td>' +
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
    }).join('');
    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('users.title')) + '</h1>' +
      '<button class="btn btn-primary" id="user-new">+ ' + esc(t('users.new')) + '</button></div>' +
      '<div class="card"><div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
      '<th>' + esc(t('users.displayName')) + '</th><th>' + esc(t('common.role')) + '</th>' +
      '<th>' + esc(t('common.country')) + '</th><th>' + esc(t('users.projectScope')) + '</th>' +
      '<th>' + esc(t('common.status')) + '</th><th>' + esc(t('common.actions')) + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    document.getElementById('user-new').onclick = function () { openUserModal(null, users, function () { render(); }); };
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
  async function viewSites(view) {
    var rows = state.sites.map(function (s) {
      return '<tr><td class="tnum">' + esc(s.code) + '</td>' +
        '<td><b>' + esc(s.name) + '</b><br><span class="muted">' +
        esc([s.city, s.country].filter(Boolean).join(', ')) + '</span></td>' +
        '<td class="muted">' + esc(s.address || '—') + '</td>' +
        '<td>' + esc(displayName(s.remote_owner_id)) + '</td>' +
        '<td><button class="btn btn-sm" data-edit="' + s.id + '">' + esc(t('common.edit')) + '</button> ' +
        (L.can('site.delete', state.profile.role)
          ? '<button class="btn btn-sm btn-danger" data-del="' + s.id + '">' + esc(t('common.delete')) + '</button>'
          : '') + '</td></tr>';
    }).join('');
    view.innerHTML =
      '<div class="page-head"><h1>' + esc(t('sites.title')) + '</h1>' +
      '<button class="btn btn-primary" id="site-new">+ ' + esc(t('sites.new')) + '</button></div>' +
      '<div class="card"><div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
      '<th>' + esc(t('sites.code')) + '</th><th>' + esc(t('sites.name')) + '</th>' +
      '<th>' + esc(t('sites.address')) + '</th><th>' + esc(t('sites.remoteOwner')) + '</th>' +
      '<th>' + esc(t('common.actions')) + '</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    await resolveNames(state.sites.map(function (s) { return s.remote_owner_id; }));
    // Re-render names after resolution (cheap: full re-render).
    document.getElementById('site-new').onclick = function () {
      openSiteModal(null, function () { render(); });
    };
    view.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function () {
        var s = state.sites.find(function (x) { return x.id === b.getAttribute('data-edit'); });
        openSiteModal(s, function () { render(); });
      };
    });
    view.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function () {
        var s = state.sites.find(function (x) { return x.id === b.getAttribute('data-del'); });
        deleteSite(s, function () { render(); });
      };
    });
    // Refresh once names resolved.
    if (state.sites.some(function (s) { return s.remote_owner_id && !state.nameCache[s.remote_owner_id]; })) {
      render();
    }
  }

  function openSiteModal(site, done) {
    site = site || {};
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
      '<div class="field"><label>' + esc(t('sites.remoteOwner')) + '</label>' +
        '<select id="s-owner"><option value="">' + esc(t('sites.noOwner')) + '</option></select></div>';
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
          remote_owner_id: document.getElementById('s-owner').value || null
        };
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
