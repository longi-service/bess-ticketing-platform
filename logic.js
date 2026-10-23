/* ============================================================================
 * logic.js — PURE business logic for the BESS ticketing platform (v1).
 *
 * ZERO DOM dependencies: safe to require() from Node for unit tests and
 * to load as a plain <script> in the browser (exposes window.BessLogic).
 *
 * Implements DATA_CONTRACT.md §5 (transitions), §6 (SLA), §8 (visibility)
 * plus the UI permission matrix. Server-side enforcement lives in
 * Supabase RLS; the functions here drive UI gating (hide/disable) so the
 * UI never offers an action the backend would reject.
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();            // Node: const L = require('./logic.js')
  } else {
    root.BessLogic = factory();            // Browser: window.BessLogic
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Constants (mirror DATA_CONTRACT.md)                                 */
  /* ------------------------------------------------------------------ */
  var ROLES = ['admin', 'dispatcher', 'pm', 'engineer', 'customer', 'tech_manager'];
  var STATUSES = ['open', 'assigned', 'in_progress', 'pending', 'pending_customer', 'resolved', 'closed'];
  var PRIORITIES = ['low', 'medium', 'high', 'urgent'];
  var SOURCES = ['customer_feedback', 'internal_discovery', 'pm_logged'];
  var LANGUAGES = ['en', 'zh'];
  var TERMINAL_STATUSES = ['resolved', 'closed'];

  /** Warning threshold: SLA clock shows "warning" when < 2h remain. */
  var WARNING_THRESHOLD_MS = 2 * 3600 * 1000;

  /**
   * Seed SLA policies from the contract (§6), used as a fallback when the
   * sla_policies table cannot be read (e.g. before login). Hours per priority.
   */
  var DEFAULT_SLA_POLICIES = {
    urgent: { response_hours: 1,  onsite_hours: 24,  resolve_hours: 72  },
    high:   { response_hours: 4,  onsite_hours: 48,  resolve_hours: 120 },
    medium: { response_hours: 8,  onsite_hours: 72,  resolve_hours: 168 },
    low:    { response_hours: 24, onsite_hours: 120, resolve_hours: 336 }
  };

  /* ------------------------------------------------------------------ */
  /* Permission matrix — UI gating. RLS is the real enforcement.         */
  /* ------------------------------------------------------------------ */
  var PERMISSION_MATRIX = {
    'ticket.create':         ['admin', 'dispatcher', 'pm', 'engineer', 'customer', 'tech_manager'],
    'ticket.assign':         ['admin', 'dispatcher', 'engineer', 'tech_manager'],
    'ticket.edit.core':      ['admin', 'dispatcher'],          // title/desc/priority/site
    'ticket.edit.own':       ['customer'],                     // own ticket, only while open
    'ticket.fieldreport':    ['admin', 'dispatcher', 'engineer', 'tech_manager'],
    'ticket.transition':     ['admin', 'dispatcher', 'pm', 'engineer', 'tech_manager'],
    'comment.internal.post': ['admin', 'dispatcher', 'pm', 'engineer', 'tech_manager'],
    'photo.upload':          ['admin', 'dispatcher', 'pm', 'engineer', 'customer', 'tech_manager'],
    'site.manage':           ['admin', 'dispatcher', 'pm'],
    'site.delete':           ['admin'],
    'user.manage':           ['admin'],
    /* v2 additions */
    'part.view':             ['admin', 'dispatcher', 'pm', 'engineer', 'tech_manager'],  // catalog/warehouse read
    'part.manage':           ['admin', 'dispatcher'],                   // catalog/warehouse CRUD
    'plan.view':             ['admin', 'dispatcher', 'pm', 'engineer', 'tech_manager'],  // v5: planning/calendar read (customers excluded — isolation audit)
    'plan.manage':           ['admin', 'dispatcher'],                   // shift write
    'contract.manage':       ['admin', 'dispatcher'],                   // LTSA contract CRUD
    /* v6/v7 additions */
    'contact.manage':        ['admin', 'dispatcher', 'pm', 'tech_manager'],             // contacts master data
    'workflow.manage':       ['admin', 'dispatcher'],                  // v8: dispatcher included (operations role)
    'field.manage':          ['admin', 'dispatcher'],                    // custom fields
    /* v6.1 additions */
    'group.manage':          ['admin', 'dispatcher', 'pm'],             // support groups
    /* v6.2 additions */
    'email.manage':          ['admin'],                                 // email templates / log / customer-mail switch
    /* v8 additions (Europe trial feedback) */
    'site.view':             ['admin', 'dispatcher', 'pm', 'engineer', 'tech_manager'], // read-only project view
    'settings.manage':       ['admin', 'dispatcher'],                   // dictionaries (segments / sources)
    'tracker.manage':        ['admin', 'dispatcher']                     // tracker registry (opened to dispatchers 2026-10-23)
  };

  /**
   * can(permission, role) → boolean. Unknown permission/role → false (deny).
   */
  function can(permission, role) {
    var allowed = PERMISSION_MATRIX[permission];
    if (!allowed || ROLES.indexOf(role) === -1) return false;
    return allowed.indexOf(role) !== -1;
  }

  /* ------------------------------------------------------------------ */
  /* Status transitions — DATA_CONTRACT.md §5 + v2 'pending_customer'      */
  /* ------------------------------------------------------------------ */
  var TRANSITIONS = {
    open:             ['assigned', 'closed'],
    assigned:         ['in_progress', 'open'],
    in_progress:      ['resolved', 'assigned'],
    resolved:         ['pending_customer', 'in_progress', 'closed'],
    pending_customer: ['closed', 'in_progress'],
    /* v3 F7: closed tickets can be reopened to open (staff only —
       customer/engineer excluded; audit trail via internal comment). */
    closed:           ['open']
  };

  /**
   * allowedTransitions(status, role, ctx) → array of target statuses the
   * user may move the ticket to. ctx: { isAssignee, isCreator, inScope }.
   * - assign / unassign / close           → dispatcher, admin
   * - reopen (closed → open)              → dispatcher, admin, pm
   *   (customer and engineer are excluded)
   * - accept (assigned→in_progress) / resolve → assigned engineer, or dispatcher/admin
   * - resolved → pending_customer ("request confirmation"): assigned
   *   engineer, dispatcher, admin
   * - resolved → closed (direct close): admin, dispatcher, pm (in scope) —
   *   ONLY for internal tickets (source != 'customer_feedback'); customer
   *   tickets must go through pending_customer
   * - pending_customer → closed (customer confirms): customer (creator),
   *   pm (in scope), dispatcher, admin
   * - pending_customer → in_progress (rework): assigned engineer,
   *   dispatcher, admin
   * - customers get no transitions except closing their own
   *   pending_customer ticket
   */
  function allowedTransitions(status, role, ctx) {
    ctx = ctx || {};
    var isAssignee = !!ctx.isAssignee;
    var isCreator = !!ctx.isCreator;
    var inScope = !!ctx.inScope;
    var targets = TRANSITIONS[status] || [];
    return targets.filter(function (to) {
      switch (status + '->' + to) {
        case 'open->assigned':        return role === 'admin' || role === 'dispatcher';
        case 'open->closed':          return role === 'admin' || role === 'dispatcher';
        case 'assigned->in_progress': return role === 'admin' || role === 'dispatcher' ||
                                             ((role === 'engineer' || role === 'tech_manager') && isAssignee);
        case 'assigned->open':        return role === 'admin' || role === 'dispatcher';
        case 'in_progress->resolved': return role === 'admin' || role === 'dispatcher' ||
                                             ((role === 'engineer' || role === 'tech_manager') && isAssignee);
        case 'in_progress->assigned': return role === 'admin' || role === 'dispatcher';
        case 'resolved->pending_customer': return role === 'admin' || role === 'dispatcher' ||
                                             ((role === 'engineer' || role === 'tech_manager') && isAssignee);
        case 'resolved->in_progress': return role === 'admin' || role === 'dispatcher';
        // v2: internal tickets (source != customer_feedback) may close directly;
        // customer tickets MUST go through pending_customer. Missing source
        // defaults to the restrictive side (no direct close).
        case 'resolved->closed': return (role === 'admin' || role === 'dispatcher' ||
                                             (role === 'pm' && inScope)) &&
                                             (ctx.source || 'customer_feedback') !== 'customer_feedback';
        case 'pending_customer->closed': return role === 'admin' || role === 'dispatcher' ||
                                             (role === 'pm' && inScope) ||
                                             (role === 'customer' && isCreator);
        case 'pending_customer->in_progress': return role === 'admin' || role === 'dispatcher' ||
                                             ((role === 'engineer' || role === 'tech_manager') && isAssignee);
        // v3 F7: reopen — dispatcher/admin/pm only (NOT customer, NOT engineer).
        case 'closed->open': return role === 'admin' || role === 'dispatcher' || role === 'pm';
        default: return false;
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* SLA — DATA_CONTRACT.md §6                                           */
  /* ------------------------------------------------------------------ */

  /**
   * normalizePolicies(raw) — accept either an array of sla_policies rows
   * ({priority, response_hours, onsite_hours, resolve_hours}) or an object
   * keyed by priority. Returns { priority: {response_hours, onsite_hours,
   * resolve_hours} }. Unknown/missing priorities are dropped.
   */
  function normalizePolicies(raw) {
    var out = {};
    if (!raw) return out;
    function pick(p) {
      if (!p) return null;
      var r = p.response_hours != null ? Number(p.response_hours) : p.response;
      var o = p.onsite_hours   != null ? Number(p.onsite_hours)   : p.onsite;
      var s = p.resolve_hours  != null ? Number(p.resolve_hours)  : p.resolve;
      if (isNaN(r) || isNaN(o) || isNaN(s)) return null;
      return { response_hours: r, onsite_hours: o, resolve_hours: s };
    }
    if (Array.isArray(raw)) {
      raw.forEach(function (row) {
        if (row && PRIORITIES.indexOf(row.priority) !== -1) {
          var p = pick(row);
          if (p) out[row.priority] = p;
        }
      });
    } else {
      PRIORITIES.forEach(function (pr) {
        var p = pick(raw[pr]);
        if (p) out[pr] = p;
      });
    }
    return out;
  }

  /**
   * computeSlaDeadlines(createdAt, priority, policies) →
   *   { response: Date|null, onsite: Date|null, resolve: Date|null }
   * Deadlines = createdAt + policy hours. Falls back to the 'medium'
   * policy (and then DEFAULT_SLA_POLICIES) when the priority is unknown,
   * so a ticket never ends up without computable clocks.
   */
  function computeSlaDeadlines(createdAt, priority, policies) {
    var base = new Date(createdAt).getTime();
    if (isNaN(base)) return { response: null, onsite: null, resolve: null };
    var norm = normalizePolicies(policies);
    var p = norm[priority] || norm.medium || DEFAULT_SLA_POLICIES[priority] ||
            DEFAULT_SLA_POLICIES.medium;
    function add(h) { return new Date(base + Number(h) * 3600 * 1000); }
    return { response: add(p.response_hours), onsite: add(p.onsite_hours), resolve: add(p.resolve_hours) };
  }

  /**
   * slaState(deadline, stoppedAt, now) →
   *   { state: 'ok'|'warning'|'breached', remainingMs: number|null }
   * - stoppedAt set (clock stopped): ok if stopped before the deadline,
   *   breached if it was already past.
   * - running clock: breached when past; warning when < 2h remain.
   * - no deadline: ok with remainingMs null.
   */
  function slaState(deadline, stoppedAt, now) {
    var nowMs = now ? new Date(now).getTime() : Date.now();
    var dl = deadline ? new Date(deadline).getTime() : NaN;
    if (isNaN(dl)) return { state: 'ok', remainingMs: null };
    if (stoppedAt) {
      var stoppedMs = new Date(stoppedAt).getTime();
      var rem = dl - stoppedMs;
      return { state: rem >= 0 ? 'ok' : 'breached', remainingMs: rem };
    }
    var remaining = dl - nowMs;
    if (remaining < 0) return { state: 'breached', remainingMs: remaining };
    if (remaining < WARNING_THRESHOLD_MS) return { state: 'warning', remainingMs: remaining };
    return { state: 'ok', remainingMs: remaining };
  }

  /**
   * ticketSla(ticket, now) → per-clock states for the three independent
   * SLA clocks. Clock stoppers per contract:
   *   response → ticket.responded_at (first PUBLIC comment)
   *   onsite   → ticket.visited_at   (actual on-site time)
   *   resolution → ticket.resolved_at (set by the app on resolve)
   */
  function ticketSla(ticket, now) {
    return {
      response:   slaState(ticket.sla_response_at, ticket.responded_at, now),
      onsite:     slaState(ticket.sla_onsite_at,   ticket.visited_at,   now),
      resolution: slaState(ticket.sla_resolve_at,  ticket.resolved_at,  now)
    };
  }

  /**
   * isSlaBreached(ticket, now) → true when any RUNNING clock is past its
   * deadline. Used by the app-side escalation job (no cron in v1):
   * breach ⇒ escalated = true.
   */
  function isSlaBreached(ticket, now) {
    if (!ticket || TERMINAL_STATUSES.indexOf(ticket.status) !== -1) return false;
    var clocks = ticketSla(ticket, now);
    return ['response', 'onsite', 'resolution'].some(function (k) {
      return clocks[k].state === 'breached';
    });
  }

  /**
   * slaAlertLevel(ticket, now) → 'breached' | 'warning' | 'none'.
   * v3 F8: 'breached' when any clock is breached (not terminal);
   * 'warning' when any clock is in warning state with < 2h remaining
   * (computed from sla_*_at minus now, not terminal).
   */
  function slaAlertLevel(ticket, now) {
    if (!ticket || TERMINAL_STATUSES.indexOf(ticket.status) !== -1) return 'none';
    var clocks = ticketSla(ticket, now);
    var warned = false;
    var breached = ['response', 'onsite', 'resolution'].some(function (k) {
      var c = clocks[k];
      if (c.state === 'warning' && c.remainingMs != null &&
          c.remainingMs < WARNING_THRESHOLD_MS) warned = true;
      return c.state === 'breached';
    });
    if (breached) return 'breached';
    return warned ? 'warning' : 'none';
  }

  /* ------------------------------------------------------------------ */
  /* Ticket visibility — DATA_CONTRACT.md §8 (single source of truth)    */
  /* ------------------------------------------------------------------ */

  /**
   * canViewTicket(ticket, user) → boolean. user: { id, role, project_scope[] }.
   * project_scope empty array = all sites.
   */
  function canViewTicket(ticket, user) {
    if (!ticket || !user || !user.id) return false;
    if (user.role === 'admin' || user.role === 'dispatcher') return true;
    if (ticket.created_by === user.id) return true;
    if (ticket.assigned_to === user.id) return true;
    if (user.role === 'pm') {
      var scope = user.project_scope || [];
      if (scope.length === 0) return true;
      return ticket.site_id != null && scope.indexOf(ticket.site_id) !== -1;
    }
    return false;
  }

  /**
   * visibilityReason(ticket, user) → 'role' | 'creator' | 'assignee' |
   * 'scope' | null — explains WHY access is granted (null = denied).
   */
  function visibilityReason(ticket, user) {
    if (!ticket || !user || !user.id) return null;
    if (user.role === 'admin' || user.role === 'dispatcher') return 'role';
    if (ticket.created_by === user.id) return 'creator';
    if (ticket.assigned_to === user.id) return 'assignee';
    if (user.role === 'pm') {
      var scope = user.project_scope || [];
      if (scope.length === 0) return 'scope';
      if (ticket.site_id != null && scope.indexOf(ticket.site_id) !== -1) return 'scope';
    }
    return null;
  }

  /**
   * canUploadPhoto(ticket, user) → boolean. Contract §7: INSERT allowed iff
   * the requester can view the ticket AND is creator / assignee /
   * dispatcher / admin.
   */
  function canUploadPhoto(ticket, user) {
    if (!can('photo.upload', user && user.role)) return false;
    if (!canViewTicket(ticket, user)) return false;
    return ticket.created_by === user.id ||
           ticket.assigned_to === user.id ||
           user.role === 'admin' || user.role === 'dispatcher';
  }

  /**
   * canPostInternal(user) → boolean. Internal comments: any non-customer role.
   */
  function canPostInternal(user) {
    return can('comment.internal.post', user && user.role);
  }

  /**
   * transitionCtx(ticket, user) → { isAssignee, isCreator, inScope, source } for
   * allowedTransitions().
   */
  function transitionCtx(ticket, user) {
    var scope = (user && user.project_scope) || [];
    return {
      isAssignee: !!(ticket && user && ticket.assigned_to === user.id),
      isCreator:  !!(ticket && user && ticket.created_by === user.id),
      inScope:    !!(user && user.role === 'pm') &&
                  (scope.length === 0 ||
                   (ticket && ticket.site_id != null && scope.indexOf(ticket.site_id) !== -1)),
      source:     (ticket && ticket.source) || null
    };
  }

  /* ------------------------------------------------------------------ */
  /* v2: LTSA contracts & planning — pure helpers (DOM-free)              */
  /* ------------------------------------------------------------------ */

  /** dateOnlyStr(d) → 'YYYY-MM-DD' (UTC) or null for invalid input. */
  function dateOnlyStr(d) {
    if (!d) return null;
    var dt = new Date(d);
    if (isNaN(dt)) return null;
    function p(n) { return String(n).padStart(2, '0'); }
    return dt.getUTCFullYear() + '-' + p(dt.getUTCMonth() + 1) + '-' + p(dt.getUTCDate());
  }

  /**
   * isContractActive(contract, today) → boolean.
   * Contract-active rule: (valid_from IS NULL OR valid_from <= today) AND
   * (valid_to IS NULL OR valid_to >= today). today defaults to now.
   */
  function isContractActive(contract, today) {
    if (!contract) return false;
    var t = dateOnlyStr(today === undefined ? new Date() : today);
    if (!t) return false;
    var from = contract.valid_from ? dateOnlyStr(contract.valid_from) : null;
    var to = contract.valid_to ? dateOnlyStr(contract.valid_to) : null;
    if (from && from > t) return false;
    if (to && to < t) return false;
    return true;
  }

  /**
   * applyContract(ticketCreatedAt, contract) →
   *   { is_ltsa, priority, sla_response_at, sla_onsite_at, sla_resolve_at }
   * SLA deadlines from the contract's hour fields, based at ticket creation;
   * the onsite deadline is null when onsite support is not enabled. Values
   * are ISO strings (or null) ready for the tickets row.
   */
  function applyContract(ticketCreatedAt, contract) {
    var out = { is_ltsa: true, priority: 'urgent',
                sla_response_at: null, sla_onsite_at: null, sla_resolve_at: null };
    var base = ticketCreatedAt ? new Date(ticketCreatedAt).getTime() : NaN;
    if (isNaN(base) || !contract) return out;
    function add(h) {
      h = Number(h);
      if (isNaN(h) || h < 0) return null;
      return new Date(base + h * 3600 * 1000).toISOString();
    }
    out.sla_response_at = add(contract.response_hours);
    out.sla_onsite_at = contract.onsite_enabled ? add(contract.onsite_hours) : null;
    out.sla_resolve_at = add(contract.resolve_hours);
    return out;
  }

  /**
   * dayState(shiftStatus, date) →
   *   'available' | 'assigned' | 'leave' | 'weekend' | 'remote'.
   * A stored shift status wins; otherwise the day defaults to 'weekend' on
   * Sat/Sun and 'remote' on weekdays. Pure (no DOM, no network).
   */
  function dayState(shiftStatus, date) {
    if (shiftStatus === 'available' || shiftStatus === 'assigned' || shiftStatus === 'leave') {
      return shiftStatus;
    }
    var dow = NaN;
    if (typeof date === 'string') {
      var m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) dow = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
    }
    if (isNaN(dow)) {
      var dt = new Date(date);
      if (dt && !isNaN(dt)) dow = dt.getDay();
    }
    if (dow === 0 || dow === 6) return 'weekend';
    return 'remote';
  }

  /* ------------------------------------------------------------------ */
  /* v4: scheduling — day-state resolution, regions, recommendations      */
  /* ------------------------------------------------------------------ */

  /**
   * dowOf(dateStr) → 0-6 (Sunday=0) for 'YYYY-MM-DD', NaN when unparseable.
   * Uses UTC so a pure date string never shifts across midnight locally.
   */
  function dowOf(dateStr) {
    if (typeof dateStr !== 'string') return NaN;
    var m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return NaN;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  }

  /**
   * resolveDayState(opts) → one of the 8 engineer-status definition keys:
   *   'campo' | 'ferie' | 'malattia' | 'formazione' | 'trasferta' |
   *   'festivo' | 'weekend' | 'remoto'.
   * opts: { shiftStatus, dayPart, hasFieldTicket, holidayName, dateStr }.
   * Precedence (first hit wins):
   *   1. field activity — shift.status 'field', legacy 'assigned' booking
   *      rows, or hasFieldTicket (shift carries site/ticket, or a ticket's
   *      onsite range covers the day) → 'campo'
   *   2. absence — vacation→ferie, sick→malattia, training→formazione,
   *      travel→trasferta, legacy 'leave'→ferie
   *   3. public holiday in the engineer's OWN country → 'festivo'
   *   4. Saturday / Sunday → 'weekend'
   *   5. default → 'remoto' (includes legacy 'available', 'remote', and
   *      no shift row at all — "remote by default" scheduling assumption)
   * Pure (no DOM, no network); the caller pre-resolves holidayName and
   * hasFieldTicket from its own queries.
   */
  var ABSENCE_TO_DEF = {
    vacation: 'ferie', sick: 'malattia', training: 'formazione',
    travel: 'trasferta', leave: 'ferie'   // legacy 'leave' → ferie
  };
  function resolveDayState(opts) {
    opts = opts || {};
    var status = opts.shiftStatus;
    if (status === 'field' || status === 'assigned' || opts.hasFieldTicket) return 'campo';
    if (ABSENCE_TO_DEF[status]) return ABSENCE_TO_DEF[status];
    if (opts.holidayName) return 'festivo';
    var dow = dowOf(opts.dateStr);
    if (dow === 0 || dow === 6) return 'weekend';
    return 'remoto';
  }

  /**
   * Region model for assignment recommendation (v4).
   * Region set: DACH, South EU, West EU, North EU, East EU.
   */
  var REGION_SET = ['DACH', 'South EU', 'West EU', 'North EU', 'East EU'];
  var COUNTRY_REGION = (function () {
    var m = {};
    function put(region, ccs) {
      ccs.forEach(function (c) { m[c] = region; });
    }
    put('DACH',     ['DE', 'AT', 'CH']);
    put('South EU', ['IT', 'ES', 'PT', 'GR', 'CY', 'MT']);
    put('West EU',  ['FR', 'BE', 'NL', 'LU', 'IE', 'GB']);
    put('North EU', ['SE', 'FI', 'DK', 'NO', 'IS', 'EE', 'LV', 'LT']);
    put('East EU',  ['PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'HR', 'SI', 'RS']);
    return m;
  })();

  /** regionOfCountry('de') → 'DACH'; unknown/empty → null. */
  function regionOfCountry(cc) {
    cc = String(cc || '').trim().toUpperCase();
    return COUNTRY_REGION[cc] || null;
  }

  /**
   * engineerRegions(eng) → array of region codes for an engineer profile.
   * Uses eng.regions (v4) when non-empty; otherwise falls back to the
   * region of eng.country_code || eng.country; [] when undeterminable.
   */
  function engineerRegions(eng) {
    if (eng && Array.isArray(eng.regions) && eng.regions.length) {
      return eng.regions.filter(function (r) { return REGION_SET.indexOf(r) !== -1; });
    }
    var c = regionOfCountry(eng && (eng.country_code || eng.country));
    return c ? [c] : [];
  }

  /**
   * rankEngineers(engineers, siteCountry) → [{ eng, regions, regionMatch }]
   * sorted with region matches first (site region derived from the site's
   * country), then by display_name. This is a REAL ranking used by the
   * assignment UIs — not decorative.
   */
  function rankEngineers(engineers, siteCountry) {
    var siteRegion = regionOfCountry(siteCountry);
    return (engineers || []).map(function (e) {
      var regs = engineerRegions(e);
      return {
        eng: e,
        regions: regs,
        regionMatch: !!(siteRegion && regs.indexOf(siteRegion) !== -1)
      };
    }).sort(function (a, b) {
      if (a.regionMatch !== b.regionMatch) return a.regionMatch ? -1 : 1;
      var an = String(a.eng.display_name || a.eng.email || '').toLowerCase();
      var bn = String(b.eng.display_name || b.eng.email || '').toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return 0;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Display helpers                                                     */
  /* ------------------------------------------------------------------ */

  /** formatTicketNo(42) → "T-0042" (ticket_no is a serial in the DB). */
  function formatTicketNo(ticketNo) {
    var n = Number(ticketNo);
    if (isNaN(n)) return 'T-????';
    return 'T-' + String(n).padStart(4, '0');
  }

  /** sanitizeFileName(name) → storage-safe segment for the ticket-photos bucket. */
  function sanitizeFileName(name) {
    return String(name || 'file')
      .replace(/[^\w.\-]+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 120);
  }

  /** photoPath(ticketId, fileName, uid) → "<ticket_id>/<uuid>-<sanitized>" per contract §7. */
  function photoPath(ticketId, fileName, uid) {
    var u = uid || ('u' + Math.random().toString(36).slice(2) + Date.now().toString(36));
    return ticketId + '/' + u + '-' + sanitizeFileName(fileName);
  }

  /* v5: role-differentiated required fields on the new-ticket form.
     Customers only need title + site + description + a photo/video;
     the technical fields become optional for them. */
  function requiredNewTicketFields(role) {
    var base = ['nt-title', 'nt-desc'];
    if (role === 'customer') return base.concat(['nt-site']);
    return base.concat(['nt-serial', 'nt-fw', 'nt-err', 'nt-actions']);
  }

  /* v5: media limits (Supabase free tier = 1GB storage).
     checkMediaLimits(newFiles, existingVideos, existingTotal) →
     array of {file, key} rejections; [] = all clear. Pure. */
  var MAX_VIDEO_BYTES = 100 * 1024 * 1024; /* 100 MB per video */
  var MAX_VIDEOS_PER_TICKET = 3;
  var MAX_FILES_PER_TICKET = 10;
  var IMAGE_MAX_DIM = 1600; /* px — client-side compression target */
  function checkMediaLimits(newFiles, existingVideos, existingTotal) {
    var errs = [], vids = existingVideos || 0, total = existingTotal || 0;
    for (var i = 0; i < newFiles.length; i++) {
      var f = newFiles[i];
      var isVideo = (f.type || '').indexOf('video/') === 0;
      if (isVideo && f.size > MAX_VIDEO_BYTES) { errs.push({ file: f.name, key: 'videoSize' }); continue; }
      if (isVideo && vids >= MAX_VIDEOS_PER_TICKET) { errs.push({ file: f.name, key: 'videoCount' }); continue; }
      if (total >= MAX_FILES_PER_TICKET) { errs.push({ file: f.name, key: 'fileCount' }); continue; }
      if (isVideo) vids++;
      total++;
    }
    return errs;
  }

  /** computeTargetSize(w, h, maxDim) → {w,h} scaled to fit, or null when
      no scaling is needed. Pure — the canvas work lives in app.js. */
  function computeTargetSize(w, h, maxDim) {
    var m = Math.max(w, h);
    if (!(m > 0) || m <= maxDim) return null;
    var s = maxDim / m;
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }

  /* ------------------------------------------------------------------ */
  /* v6 — master data helpers                                          */
  /* ------------------------------------------------------------------ */

  /**
   * stockStatus(qty, minQty) → 'ok' | 'low' | 'critical'.
   * Mirrors TechCRM renderWarehouse: OK when qty >= min; low when qty is at
   * least half of min but below min; critical otherwise. Null min → 'ok'.
   */
  function stockStatus(qty, minQty) {
    var q = Number(qty), m = minQty == null || minQty === '' ? null : Number(minQty);
    if (isNaN(q)) q = 0;
    if (m == null || isNaN(m) || m <= 0) return 'ok';
    if (q >= m) return 'ok';
    if (q >= Math.floor(m * 0.5)) return 'low';
    return 'critical';
  }

  /**
   * buildSiteTree(sites) → nested [{...site, children: [...]}] roots-first.
   * Pure helper for the project hierarchy (EU Service → country → site).
   * Guards against self-parenting and missing parents.
   */
  function buildSiteTree(sites) {
    var byId = {}, roots = [];
    (sites || []).forEach(function (s) {
      byId[s.id] = s;
      s.children = [];
    });
    (sites || []).forEach(function (s) {
      var p = s.parent_site_id;
      if (p && byId[p] && p !== s.id) byId[p].children.push(s);
      else roots.push(s);
    });
    function sortDeep(list) {
      list.sort(function (a, b) {
        return String(a.code || '').localeCompare(String(b.code || ''));
      });
      list.forEach(function (s) { sortDeep(s.children); });
    }
    sortDeep(roots);
    return roots;
  }

  /**
   * validateContact(c) → array of error keys (empty = valid).
   * Contacts are external people, independent of auth profiles.
   */
  function validateContact(c) {
    var errs = [];
    c = c || {};
    if (!String(c.first_name || '').trim()) errs.push('contact.firstName');
    if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(c.email).trim())) errs.push('contact.email');
    return errs;
  }

  /* ------------------------------------------------------------------ */
  /* v6.1 — Massimo Excel import compatibility + support groups         */
  /* ------------------------------------------------------------------ */

  /**
   * parseCoordinate(str) → decimal degrees (number) or null.
   * Accepts plain decimals ("42.35", "-11.61", "42,35") and DMS
   * ("42°22'47.8\"N", "11°33'09.2\"E", "42°22.79'N"). S/W → negative.
   * Returns null when the string cannot be parsed as a coordinate.
   */
  function parseCoordinate(str) {
    if (str == null) return null;
    var s = String(str).trim();
    if (!s) return null;
    // fast path: plain decimal ("42.35", "-11.61", "42,35")
    if (/^[+-]?(\d+([.,]\d+)?|[.,]\d+)$/.test(s)) {
      var d = Number(s.replace(',', '.'));
      return isNaN(d) ? null : d;
    }
    var m = s.match(/^\s*([+-]?\d+(?:[.,]\d+)?)\s*[°ºdD]?\s*(?:(\d+(?:[.,]\d+)?)\s*['′'mM]?\s*)?(?:(\d+(?:[.,]\d+)?)\s*["″"sS]?\s*)?\s*([NSEWnsew])?\s*$/);
    if (!m) return null;
    function num(x) { return Number(String(x).replace(',', '.')); }
    var deg = num(m[1]);
    var min = m[2] != null ? num(m[2]) : 0;
    var sec = m[3] != null ? num(m[3]) : 0;
    if (isNaN(deg) || isNaN(min) || isNaN(sec)) return null;
    if (min >= 60 || sec >= 60) return null;
    var v = Math.abs(deg) + min / 60 + sec / 3600;
    var hemi = (m[4] || '').toUpperCase();
    var neg = deg < 0 || hemi === 'S' || hemi === 'W';
    return neg ? -v : v;
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /**
   * extractEmails(text) → array of unique lowercase valid emails.
   * Splits on whitespace / commas / semicolons; drops prose tokens
   * (e.g. Massimo's "IMPORTANT: IS NECESSARY TO CREATE ANOTHER EMAIL…").
   */
  function extractEmails(text) {
    var out = [], seen = {};
    String(text || '').split(/[\s,;]+/).forEach(function (tok) {
      var t = tok.trim().toLowerCase();
      if (EMAIL_RE.test(t) && !seen[t]) { seen[t] = true; out.push(t); }
    });
    return out;
  }

  /**
   * isNaLike(v) → true for NA / N/A / '-' / 'NA (…)' style placeholders,
   * so junk like "NA (what do you mean for parent site code?)" is
   * treated as "no parent" instead of a lookup error.
   */
  function isNaLike(v) {
    var w = String(v == null ? '' : v).trim().toUpperCase();
    if (!w) return false;
    return w === 'NA' || w === 'N/A' || w === '-' ||
      w.indexOf('NA ') === 0 || w.indexOf('NA(') === 0 ||
      w.indexOf('N/A ') === 0 || w.indexOf('N/A(') === 0;
  }

  /**
   * splitFullName(name) → { first, last }; splits at the FIRST space.
   * "Massimo Marchetti" → {first:'Massimo', last:'Marchetti'}.
   */
  function splitFullName(name) {
    var s = String(name || '').trim().replace(/\s+/g, ' ');
    var i = s.indexOf(' ');
    if (i === -1) return { first: s, last: '' };
    return { first: s.slice(0, i), last: s.slice(i + 1) };
  }

  /**
   * normalizeWarehouseType(v) → 'on_site' | 'off_site' | null.
   * Accepts "On-site", "off_site", "OFF SITE", …
   */
  function normalizeWarehouseType(v) {
    var w = String(v == null ? '' : v).trim().toLowerCase().replace(/[-\s]+/g, '_');
    if (w === 'on_site' || w === 'off_site') return w;
    return null;
  }

  /**
   * normalizeOwner(v) → 'longi' | 'customer' | null (case-insensitive).
   */
  function normalizeOwner(v) {
    var w = String(v == null ? '' : v).trim().toLowerCase();
    return (w === 'longi' || w === 'customer') ? w : null;
  }

  /**
   * normalizeAvailability(v) → percentage number or null.
   * Fractions ≤ 1 (e.g. 0.98) are ×100; plain percentages pass through.
   */
  function normalizeAvailability(v) {
    if (v == null || String(v).trim() === '') return null;
    var n = Number(String(v).trim().replace(',', '.'));
    if (isNaN(n) || n < 0) return null;
    if (n <= 1) n = n * 100;
    return Math.round(n * 100) / 100;
  }

  /**
   * coverageIs247(v) → true when the coverage text means 24/7.
   */
  function coverageIs247(v) {
    return String(v == null ? '' : v).replace(/\s+/g, '') === '24/7';
  }

  /**
   * resolveSiteScope(value, sites) → array of site ids.
   * Tokens split on [,;\n]; each token matches a site by NAME
   * (case-insensitive) first, then by CODE, then by CITY — Massimo
   * writes "Montalto di Castro" while the site is named
   * 'Montalto " La Viola"' (city name is how people refer to it).
   */
  function resolveSiteScope(value, sites) {
    var out = [], seen = {};
    var byName = {}, byCode = {};
    function push(id) { if (id && !seen[id]) { seen[id] = true; out.push(id); } }
    (sites || []).forEach(function (s) {
      if (s.name) byName[String(s.name).trim().toLowerCase()] = s.id;
      if (s.code) byCode[String(s.code).trim().toUpperCase()] = s.id;
    });
    String(value || '').split(/[,\;\n]+/).forEach(function (tok) {
      var t = tok.trim();
      if (!t) return;
      var id = byName[t.toLowerCase()] || byCode[t.toUpperCase()];
      if (id) { push(id); return; }
      (sites || []).forEach(function (s) {
        if (s.city && String(s.city).trim().toLowerCase() === t.toLowerCase()) push(s.id);
      });
    });
    return out;
  }

  /**
   * normKey(s) → normalized key for fuzzy name matching
   * (lowercase, trimmed, collapsed whitespace, dashes unified).
   */
  function normKey(s) {
    return String(s == null ? '' : s).toLowerCase().trim()
      .replace(/[–—−]/g, '-').replace(/\s+/g, ' ');
  }

  /**
   * findWarehouse(value, warehouses) → warehouse row or null.
   * Code match first, then name match (both normalized) — Massimo's
   * spare-parts sheet writes warehouse NAMES, not codes.
   */
  function findWarehouse(value, warehouses) {
    var v = normKey(value);
    if (!v) return null;
    var list = warehouses || [], hit = null, i;
    for (i = 0; i < list.length; i++) {
      if (normKey(list[i].code) === v) { hit = list[i]; break; }
    }
    if (!hit) {
      for (i = 0; i < list.length; i++) {
        if (normKey(list[i].name) === v) { hit = list[i]; break; }
      }
    }
    return hit;
  }

  /* ------------------------------------------------------------------ */
  /* v7 — trackers, configurable workflow, custom fields                 */
  /* ------------------------------------------------------------------ */

  /**
   * TRACKERS — the four ticket trackers (TechCRM § Tipi di ticket).
   * prefix mirrors Massimo's prototype (SUP/MAN/RIC/QLT).
   */
  var TRACKERS = {
    support:     { key: 'support',     prefix: 'SUP', color: '#4f8ef7' },
    maintenance: { key: 'maintenance', prefix: 'MAN', color: '#22c55e' },
    spare:       { key: 'spare',       prefix: 'RIC', color: '#f59e0b' },
    quality:     { key: 'quality',     prefix: 'QLT', color: '#8b5cf6' }
  };
  var TRACKER_KEYS = ['support', 'maintenance', 'spare', 'quality'];

  /* ------------------------------------------------------------------ */
  /* v8 — maintainable dictionaries + tracker registry                   */
  /* Stored in app_settings (JSON), merged over these built-in defaults */
  /* so the app works unchanged before any admin edits them.            */
  /* ------------------------------------------------------------------ */

  /** Segments: key doubles as the label i18n suffix; workflow_key binds
      the segment to a status workflow (ticket creation fallback). */
  var DEFAULT_SEGMENTS = [
    { key: 'ci',      name_en: 'C&I',           name_zh: '工商业',   workflow_key: 'ci' },
    { key: 'utility', name_en: 'Utility scale', name_zh: '大型电站', workflow_key: 'utility' }
  ];

  /** Sources: key doubles as the label i18n suffix (source.<key>). */
  var DEFAULT_SOURCES = [
    { key: 'customer_feedback',  name_en: 'Customer feedback',  name_zh: '客户反馈' },
    { key: 'internal_discovery', name_en: 'Internal discovery', name_zh: '内部发现' },
    { key: 'pm_logged',          name_en: 'PM logged',          name_zh: 'PM 记录' }
  ];

  /** Tracker registry defaults (mirror TRACKERS + display names). */
  var DEFAULT_TRACKERS = [
    { key: 'support',     name_en: 'Support',          name_zh: '支持',   prefix: 'SUP', color: '#4f8ef7', workflow_key: '', is_active: true },
    { key: 'maintenance', name_en: 'Maintenance',      name_zh: '维护',   prefix: 'MAN', color: '#22c55e', workflow_key: '', is_active: true },
    { key: 'spare',       name_en: 'Spare parts',      name_zh: '备件',   prefix: 'RIC', color: '#f59e0b', workflow_key: '', is_active: true },
    { key: 'quality',     name_en: 'Quality',          name_zh: '质量',   prefix: 'QLT', color: '#8b5cf6', workflow_key: '', is_active: true }
  ];

  /** Merge a stored dictionary (array of items with .key) over defaults:
      stored items override same-key defaults; new keys are appended;
      items with is_active === false are dropped. Invalid input → defaults. */
  function mergeDict(defaults, stored) {
    var out = (defaults || []).map(function (d) { return Object.assign({}, d); });
    if (!Array.isArray(stored)) return out;
    stored.forEach(function (s) {
      if (!s || !s.key) return;
      var i = -1;
      out.forEach(function (o, j) { if (o.key === s.key) i = j; });
      if (s.is_active === false) { if (i !== -1) out.splice(i, 1); return; }
      if (i !== -1) out[i] = Object.assign({}, out[i], s);
      else out.push(Object.assign({}, s));
    });
    return out;
  }

  function segmentDict(stored) { return mergeDict(DEFAULT_SEGMENTS, stored); }
  function sourceDict(stored) { return mergeDict(DEFAULT_SOURCES, stored); }
  function trackerRegistry(stored) { return mergeDict(DEFAULT_TRACKERS, stored); }

  /* v9 (#25): all site ids in the subtree rooted at rootId, root first.
     Sites link via parent_site_id; cycles are guarded. */
  function subtreeSiteIds(sites, rootId) {
    var out = [];
    if (!rootId) return out;
    var seen = {};
    var queue = [rootId];
    while (queue.length) {
      var id = queue.shift();
      if (seen[id]) continue;
      seen[id] = true;
      out.push(id);
      (sites || []).forEach(function (s) {
        if (s.parent_site_id === id && !seen[s.id]) queue.push(s.id);
      });
    }
    return out;
  }

  /* v9 (#25): trackers available for a project. allowedKeys null/empty
     means "no project restriction" -> every active tracker. Otherwise
     only the listed keys (still active ones). Returns tracker objects. */
  function availableTrackers(trackers, allowedKeys) {
    var active = (trackers || []).filter(function (tr) { return tr.is_active !== false; });
    if (!allowedKeys || !allowedKeys.length) return active;
    var allow = {};
    allowedKeys.forEach(function (k) { allow[k] = true; });
    return active.filter(function (tr) { return allow[tr.key]; });
  }

  /** Workflow for a new ticket: tracker binding wins, then the site
      segment's binding, then the legacy segment rule (utility → utility). */
  function resolveWorkflowKey(tracker, segmentKey, segments) {
    if (tracker && tracker.workflow_key) return tracker.workflow_key;
    var seg = null;
    (segments || DEFAULT_SEGMENTS).forEach(function (s) { if (s.key === segmentKey) seg = s; });
    if (seg && seg.workflow_key) return seg.workflow_key;
    return segmentKey === 'utility' ? 'utility' : 'ci';
  }

  /* ------------------------------------------------------------------ */
  /* v8 — custom-field dependencies (Massimo manual §24)                 */
  /* depends_on = { field: <source key>, op: <op>, value: <any> }.      */
  /* Ops: eq / neq / one_of / filled / empty / gt. When the condition    */
  /* is false the dependent field is NOT rendered at all. Dependencies   */
  /* only evaluate within the same form (same tracker).                  */
  /* ------------------------------------------------------------------ */
  var DEP_OPS = ['eq', 'neq', 'one_of', 'filled', 'empty', 'gt'];

  function depValueEmpty(v) {
    return v === undefined || v === null || v === '' ||
           (Array.isArray(v) && v.length === 0);
  }

  function evalDependency(dep, values) {
    if (!dep || !dep.field || DEP_OPS.indexOf(dep.op) === -1) return true;
    var v = (values || {})[dep.field];
    switch (dep.op) {
      case 'filled': return !depValueEmpty(v);
      case 'empty':  return depValueEmpty(v);
      case 'eq':     return String(v === undefined || v === null ? '' : v) === String(dep.value === undefined || dep.value === null ? '' : dep.value);
      case 'neq':    return String(v === undefined || v === null ? '' : v) !== String(dep.value === undefined || dep.value === null ? '' : dep.value);
      case 'one_of': {
        var list = String(dep.value === undefined || dep.value === null ? '' : dep.value)
          .split(',').map(function (s) { return s.trim(); });
        if (Array.isArray(v)) return v.some(function (x) { return list.indexOf(String(x)) !== -1; });
        return list.indexOf(String(v === undefined || v === null ? '' : v)) !== -1;
      }
      case 'gt': {
        var a = Number(v), b = Number(dep.value);
        return !isNaN(a) && !isNaN(b) && a > b;
      }
      default: return true;
    }
  }

  /** Is this field currently visible, considering its dependency? */
  function fieldDepVisible(field, values) {
    if (!field || !field.depends_on) return true;
    return evalDependency(field.depends_on, values || {});
  }

  /** Required check honoring required_states (v8): when required_states
      is a non-empty array the field is mandatory only in those states;
      otherwise the plain `required` flag applies to every state. */
  function fieldRequiredIn(field, status) {
    if (!field) return false;
    var rs = field.required_states || [];
    if (Array.isArray(rs) && rs.length) {
      if (!status) return !!field.required;
      return rs.indexOf(status) !== -1;
    }
    return !!field.required;
  }

  /**
   * WORKFLOW_TEMPLATES — built-in C&I / Utility templates.
   * Mirrors migration_v7.sql seeds; used as fallback when the
   * workflow_states / workflow_transitions tables cannot be read.
   */
  var WORKFLOW_TEMPLATES = {
    ci: {
      states: [
        { key: 'open',             kind: 'start'  },
        { key: 'assigned',         kind: 'normal' },
        { key: 'in_progress',      kind: 'normal' },
        { key: 'pending',          kind: 'normal' },
        { key: 'pending_customer', kind: 'normal' },
        { key: 'resolved',         kind: 'normal' },
        { key: 'closed',           kind: 'end'    }
      ],
      transitions: {
        open:             ['assigned', 'closed'],
        assigned:         ['in_progress', 'open'],
        in_progress:      ['resolved', 'assigned'],
        pending:          ['in_progress', 'assigned'],
        resolved:         ['pending_customer', 'in_progress', 'closed'],
        pending_customer: ['closed', 'in_progress'],
        closed:           ['open']
      }
    },
    utility: {
      states: [
        { key: 'open',             kind: 'start'  },
        { key: 'assigned',         kind: 'normal' },
        { key: 'in_progress',      kind: 'normal' },
        { key: 'hq_approval',      kind: 'normal' },
        { key: 'pending',          kind: 'normal' },
        { key: 'pending_customer', kind: 'normal' },
        { key: 'resolved',         kind: 'normal' },
        { key: 'closed',           kind: 'end'    }
      ],
      transitions: {
        open:             ['assigned', 'closed'],
        assigned:         ['in_progress', 'open'],
        in_progress:      ['resolved', 'assigned', 'hq_approval'],
        hq_approval:      ['in_progress', 'resolved'],
        pending:          ['in_progress', 'assigned'],
        resolved:         ['pending_customer', 'in_progress', 'closed'],
        pending_customer: ['closed', 'in_progress'],
        closed:           ['open']
      }
    }
  };

  /**
   * buildTransitions(rows) → { fromKey: [toKey, ...] } from
   * workflow_transitions rows ({workflow_key, from_key, to_key}).
   */
  function buildTransitions(rows) {
    var map = {};
    (rows || []).forEach(function (r) {
      if (!r || !r.from_key || !r.to_key) return;
      if (!map[r.from_key]) map[r.from_key] = [];
      if (map[r.from_key].indexOf(r.to_key) === -1) map[r.from_key].push(r.to_key);
    });
    return map;
  }

  /**
   * transitionRuleAllowed(status, to, role, ctx) — the role rule for one
   * status→target pair. Extracted from allowedTransitions so DB-driven
   * workflows reuse the identical role gating.
   */
  function transitionRuleAllowed(status, to, role, ctx) {
    ctx = ctx || {};
    var isAssignee = !!ctx.isAssignee;
    var isCreator = !!ctx.isCreator;
    var inScope = !!ctx.inScope;
    switch (status + '->' + to) {
      case 'open->assigned':        return role === 'admin' || role === 'dispatcher';
      case 'open->closed':          return role === 'admin' || role === 'dispatcher';
      case 'assigned->in_progress': return role === 'admin' || role === 'dispatcher' ||
                                           ((role === 'engineer' || role === 'tech_manager') && isAssignee);
      case 'assigned->open':        return role === 'admin' || role === 'dispatcher';
      case 'in_progress->resolved': return role === 'admin' || role === 'dispatcher' ||
                                           ((role === 'engineer' || role === 'tech_manager') && isAssignee);
      case 'in_progress->assigned': return role === 'admin' || role === 'dispatcher';
      case 'in_progress->hq_approval': return role === 'admin' || role === 'dispatcher' ||
                                           ((role === 'engineer' || role === 'tech_manager') && isAssignee);
      case 'hq_approval->in_progress': return role === 'admin' || role === 'dispatcher';
      case 'hq_approval->resolved':  return role === 'admin' || role === 'dispatcher';
      case 'resolved->pending_customer': return role === 'admin' || role === 'dispatcher' ||
                                           ((role === 'engineer' || role === 'tech_manager') && isAssignee);
      case 'resolved->in_progress': return role === 'admin' || role === 'dispatcher';
      case 'resolved->closed': return (role === 'admin' || role === 'dispatcher' ||
                                         (role === 'pm' && inScope)) &&
                                         (ctx.source || 'customer_feedback') !== 'customer_feedback';
      case 'pending_customer->closed': return role === 'admin' || role === 'dispatcher' ||
                                         (role === 'pm' && inScope) ||
                                         (role === 'customer' && isCreator);
      case 'pending_customer->in_progress': return role === 'admin' || role === 'dispatcher' ||
                                         ((role === 'engineer' || role === 'tech_manager') && isAssignee);
      case 'closed->open': return role === 'admin' || role === 'dispatcher' || role === 'pm';
      default: return false;
    }
  }

  /**
   * allowedTransitionsWf(transMap, status, role, ctx) — allowedTransitions
   * against a DB-driven transition map (v7 configurable workflow).
   */
  function allowedTransitionsWf(transMap, status, role, ctx) {
    var targets = (transMap && transMap[status]) || [];
    return targets.filter(function (to) {
      return transitionRuleAllowed(status, to, role, ctx);
    });
  }

  /* Custom field types (TechCRM § Campi personalizzati) */
  var CF_TYPES = ['text', 'number', 'date', 'url', 'dropdown', 'checkbox',
                  'checklist', 'signature', 'textarea'];

  /**
   * fieldVisibleIn(field, status) — simplified field/status permission:
   * empty show_in_states → visible in every status.
   */
  function fieldVisibleIn(field, status) {
    if (!field) return false;
    var vs = field.show_in_states || [];
    if (!vs.length) return true;
    return vs.indexOf(status) !== -1;
  }

  /**
   * validateCustomValues(fields, values, [status]) → array of error strings
   * ("<key>:required" / "<key>:invalid"). Pure; UI maps to i18n.
   * v8: fields hidden by an unsatisfied dependency are skipped entirely;
   * required honors required_states when a status is supplied.
   */
  function validateCustomValues(fields, values, status) {
    var errs = [];
    values = values || {};
    (fields || []).forEach(function (f) {
      if (!f || f.is_active === false) return;
      if (!fieldDepVisible(f, values)) return;
      var v = values[f.key];
      var empty = v === undefined || v === null || v === '' ||
                  (Array.isArray(v) && v.length === 0);
      if (fieldRequiredIn(f, status) && empty) { errs.push(f.key + ':required'); return; }
      if (empty) return;
      switch (f.type) {
        case 'number':
          if (isNaN(Number(v))) errs.push(f.key + ':invalid');
          break;
        case 'date':
          if (isNaN(new Date(v).getTime())) errs.push(f.key + ':invalid');
          break;
        case 'url':
          if (!/^https?:\/\//i.test(String(v))) errs.push(f.key + ':invalid');
          break;
        case 'dropdown': {
          var opts = (f.options || []).map(function (o) { return String(o); });
          if (opts.length && opts.indexOf(String(v)) === -1) errs.push(f.key + ':invalid');
          break;
        }
        case 'checklist':
          if (!Array.isArray(v)) errs.push(f.key + ':invalid');
          break;
        default: break;
      }
    });
    return errs;
  }

  /**
   * validateCustomFieldDef(def) → array of { code } error entries
   * (empty = valid). `code` is an i18n key; the UI toasts t(errs[0].code).
   * def mirrors the custom_fields row built by the field editor:
   * { key, type, label_en, label_zh, options, trackers, show_in_states,
   *   required, is_active }.
   */
  function validateCustomFieldDef(def) {
    var errs = [];
    def = def || {};
    var key = String(def.key == null ? '' : def.key).trim();
    if (!key) errs.push({ code: 'cf.err.keyRequired' });
    else if (!/^[a-z][a-z0-9_]*$/.test(key)) errs.push({ code: 'cf.err.keyFormat' });
    if (CF_TYPES.indexOf(def.type) === -1) errs.push({ code: 'cf.err.type' });
    var hasLabel = !!String(def.label_en || '').trim() ||
                   !!String(def.label_zh || '').trim();
    if (!hasLabel) errs.push({ code: 'cf.err.label' });
    if (def.type === 'dropdown' || def.type === 'checklist') {
      var opts = (Array.isArray(def.options) ? def.options : [])
        .map(function (o) { return String(o == null ? '' : o).trim(); })
        .filter(Boolean);
      if (!opts.length) errs.push({ code: 'cf.err.options' });
    }
    if (def.trackers !== undefined && def.trackers !== null) {
      var trks = Array.isArray(def.trackers) ? def.trackers : [];
      if (!trks.length ||
          trks.some(function (k) { return TRACKER_KEYS.indexOf(k) === -1; })) {
        errs.push({ code: 'cf.err.trackers' });
      }
    }
    return errs;
  }

  /**
   * canCloseTicket(ticket, attachments) → { ok, reason }.
   * v7.11: closing requires an uploaded service report (kind
   * 'service_report'); the report should carry a customer signature
   * (meta.signed or a signature custom value).
   */
  function canCloseTicket(ticket, attachments, customValues) {
    var reports = (attachments || []).filter(function (a) {
      return a && a.kind === 'service_report';
    });
    if (!reports.length) return { ok: false, reason: 'service_report_missing' };
    var signed = reports.some(function (a) { return a.meta && a.meta.signed; }) ||
      !!(customValues && customValues.svc_signature);
    if (!signed) return { ok: false, reason: 'signature_missing' };
    return { ok: true, reason: null };
  }

  /**
   * monthlyPlanDates(year) → 12 ISO date strings (1st of each month).
   * v7.12: one planned-maintenance ticket per month per project.
   */
  function monthlyPlanDates(year) {
    var y = Number(year);
    if (!y || y < 2000 || y > 2100) return [];
    var out = [];
    for (var m = 0; m < 12; m++) {
      out.push(y + '-' + String(m + 1).padStart(2, '0') + '-01');
    }
    return out;
  }

  /**
   * maintenanceProgress(tickets) → { total, done, pct } where done counts
   * terminal statuses (resolved/closed).
   */
  function maintenanceProgress(tickets) {
    var total = (tickets || []).length, done = 0;
    (tickets || []).forEach(function (t) {
      if (TERMINAL_STATUSES.indexOf(t.status) !== -1) done++;
    });
    return { total: total, done: done, pct: total ? Math.round(done / total * 100) : 0 };
  }

  /**
   * validateContact — (also listed here for discoverability; defined above)
   */

  /* ------------------------------------------------------------------ */
  /* v6.2: email notifications (item 15 — sending only; inbound          */
  /* auto-ticketing stays out of scope). Pure helpers: the app assembles */
  /* recipients + variables, the send-email Edge Function renders and    */
  /* delivers via the company SMTP mailbox.                              */
  /* ------------------------------------------------------------------ */

  /** Notification events. Keys double as email_templates.key values. */
  var EMAIL_EVENTS = ['ticket_created', 'ticket_assigned', 'status_changed',
    'comment_added', 'sla_warning', 'sla_breach'];

  function _escapeHtmlValue(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _substituteTemplate(text, vars, escapeValues) {
    if (text == null) return '';
    return String(text).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, function (m, k) {
      var v = vars ? vars[k] : null;
      if (v == null) return '';
      return escapeValues ? _escapeHtmlValue(v) : String(v);
    });
  }

  /**
   * renderEmailTemplate(text, vars) → {{key}} substitution for HTML
   * bodies: substituted values are HTML-escaped (template HTML itself
   * is trusted — it is written by admins). Unknown keys render empty.
   */
  function renderEmailTemplate(text, vars) {
    return _substituteTemplate(text, vars, true);
  }

  /** renderEmailSubject(text, vars) → same substitution, NO escaping
   *  (subjects are plain text). */
  function renderEmailSubject(text, vars) {
    return _substituteTemplate(text, vars, false);
  }

  /**
   * assembleRecipients(input) → [{ email, user_id, lang, kind }]
   *
   * input:
   *   ticket      { created_by, assigned_to, assigned_group_id, site_id }
   *   profilesById  { id → { id, email, role, language, is_active } }
   *   groupMembers  [ { group_id, member_type, member_id } ] (v6.1)
   *   contactsById  { id → { id, email } }   (external group members)
   *   site          { remote_owner_id, remote_owner_email } | null
   *   prefsByUser   { userId → { eventKey → bool } } (absent = enabled)
   *   eventKey      one of EMAIL_EVENTS
   *   customerNotifyEnabled  bool — customer-ROLE profiles only get mail
   *                            when the admin switch is on.
   *   staffOnly     bool — internal events (e.g. internal comments):
   *                            only staff profiles, no contacts/remote.
   *   actorId / actorEmail — the user who triggered the event never
   *                            mails themselves.
   *
   * Order is stable (creator → assignee → group → remote owner) and
   * de-duplicated by lowercased email; first occurrence wins.
   */
  function assembleRecipients(input) {
    var o = input || {};
    var ticket = o.ticket || {};
    var profiles = o.profilesById || {};
    var contacts = o.contactsById || {};
    var prefs = o.prefsByUser || {};
    var out = [], seen = {};
    var actorId = o.actorId || null;
    var actorEmail = o.actorEmail ? String(o.actorEmail).toLowerCase() : null;

    function push(email, userId, lang, kind) {
      if (!email) return;
      var key = String(email).toLowerCase();
      if (seen[key]) return;
      if (actorEmail && key === actorEmail) return;
      seen[key] = true;
      out.push({ email: String(email), user_id: userId || null,
                 lang: (lang === 'zh' ? 'zh' : 'en'), kind: kind });
    }
    function pushProfile(p, kind) {
      if (!p || !p.email) return;
      if (p.is_active === false) return;
      if (actorId && p.id === actorId) return;
      if (p.role === 'customer' && !o.customerNotifyEnabled) return;
      if (o.staffOnly && p.role === 'customer') return;
      var pu = prefs[p.id];
      if (pu && pu[o.eventKey] === false) return;
      push(p.email, p.id, p.language, kind);
    }

    pushProfile(profiles[ticket.created_by], 'creator');
    pushProfile(profiles[ticket.assigned_to], 'assignee');
    if (ticket.assigned_group_id) {
      (o.groupMembers || []).forEach(function (m) {
        if (m.group_id !== ticket.assigned_group_id) return;
        if (m.member_type === 'profile') {
          pushProfile(profiles[m.member_id], 'group');
        } else if (m.member_type === 'contact' && !o.staffOnly) {
          var c = contacts[m.member_id];
          if (c && c.email) push(c.email, null, 'en', 'group');
        }
      });
    }
    if (o.site) {
      /* The remote owner PROFILE is a staff member — included even for
         staffOnly events. The raw remote_owner_email list is an external
         channel and is skipped for staffOnly events. */
      pushProfile(profiles[o.site.remote_owner_id], 'remote_owner');
      if (!o.staffOnly) {
        extractEmails(o.site.remote_owner_email).forEach(function (e) {
          push(e, null, 'en', 'remote_owner');
        });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  return {
    ROLES: ROLES,
    STATUSES: STATUSES,
    PRIORITIES: PRIORITIES,
    SOURCES: SOURCES,
    LANGUAGES: LANGUAGES,
    TERMINAL_STATUSES: TERMINAL_STATUSES,
    WARNING_THRESHOLD_MS: WARNING_THRESHOLD_MS,
    DEFAULT_SLA_POLICIES: DEFAULT_SLA_POLICIES,
    PERMISSION_MATRIX: PERMISSION_MATRIX,
    can: can,
    allowedTransitions: allowedTransitions,
    normalizePolicies: normalizePolicies,
    computeSlaDeadlines: computeSlaDeadlines,
    slaState: slaState,
    ticketSla: ticketSla,
    isSlaBreached: isSlaBreached,
    slaAlertLevel: slaAlertLevel,
    canViewTicket: canViewTicket,
    visibilityReason: visibilityReason,
    canUploadPhoto: canUploadPhoto,
    canPostInternal: canPostInternal,
    transitionCtx: transitionCtx,
    isContractActive: isContractActive,
    applyContract: applyContract,
    dayState: dayState,
    resolveDayState: resolveDayState,
    ABSENCE_TO_DEF: ABSENCE_TO_DEF,
    REGION_SET: REGION_SET,
    COUNTRY_REGION: COUNTRY_REGION,
    regionOfCountry: regionOfCountry,
    engineerRegions: engineerRegions,
    rankEngineers: rankEngineers,
    formatTicketNo: formatTicketNo,
    sanitizeFileName: sanitizeFileName,
    photoPath: photoPath,
    requiredNewTicketFields: requiredNewTicketFields,
    checkMediaLimits: checkMediaLimits,
    computeTargetSize: computeTargetSize,
    stockStatus: stockStatus,
    buildSiteTree: buildSiteTree,
    validateContact: validateContact,
    /* v6.1 additions */
    parseCoordinate: parseCoordinate,
    extractEmails: extractEmails,
    isNaLike: isNaLike,
    splitFullName: splitFullName,
    normalizeWarehouseType: normalizeWarehouseType,
    normalizeOwner: normalizeOwner,
    normalizeAvailability: normalizeAvailability,
    coverageIs247: coverageIs247,
    resolveSiteScope: resolveSiteScope,
    normKey: normKey,
    findWarehouse: findWarehouse,
    TRACKERS: TRACKERS,
    TRACKER_KEYS: TRACKER_KEYS,
    /* v8 additions */
    DEFAULT_SEGMENTS: DEFAULT_SEGMENTS,
    DEFAULT_SOURCES: DEFAULT_SOURCES,
    DEFAULT_TRACKERS: DEFAULT_TRACKERS,
    segmentDict: segmentDict,
    sourceDict: sourceDict,
    trackerRegistry: trackerRegistry,
    subtreeSiteIds: subtreeSiteIds,
    availableTrackers: availableTrackers,
    resolveWorkflowKey: resolveWorkflowKey,
    DEP_OPS: DEP_OPS,
    evalDependency: evalDependency,
    fieldDepVisible: fieldDepVisible,
    fieldRequiredIn: fieldRequiredIn,
    WORKFLOW_TEMPLATES: WORKFLOW_TEMPLATES,
    buildTransitions: buildTransitions,
    transitionRuleAllowed: transitionRuleAllowed,
    allowedTransitionsWf: allowedTransitionsWf,
    CF_TYPES: CF_TYPES,
    fieldVisibleIn: fieldVisibleIn,
    validateCustomFieldDef: validateCustomFieldDef,
    validateCustomValues: validateCustomValues,
    canCloseTicket: canCloseTicket,
    monthlyPlanDates: monthlyPlanDates,
    maintenanceProgress: maintenanceProgress,
    /* v6.2 additions */
    EMAIL_EVENTS: EMAIL_EVENTS,
    renderEmailTemplate: renderEmailTemplate,
    renderEmailSubject: renderEmailSubject,
    assembleRecipients: assembleRecipients,
    MAX_VIDEO_BYTES: MAX_VIDEO_BYTES,
    MAX_VIDEOS_PER_TICKET: MAX_VIDEOS_PER_TICKET,
    MAX_FILES_PER_TICKET: MAX_FILES_PER_TICKET,
    IMAGE_MAX_DIM: IMAGE_MAX_DIM
  };
}));
