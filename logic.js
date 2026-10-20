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
  var ROLES = ['admin', 'dispatcher', 'pm', 'engineer', 'customer'];
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
    'ticket.create':         ['admin', 'dispatcher', 'pm', 'engineer', 'customer'],
    'ticket.assign':         ['admin', 'dispatcher'],
    'ticket.edit.core':      ['admin', 'dispatcher'],          // title/desc/priority/site
    'ticket.edit.own':       ['customer'],                     // own ticket, only while open
    'ticket.fieldreport':    ['admin', 'dispatcher', 'engineer'],
    'ticket.transition':     ['admin', 'dispatcher', 'pm', 'engineer'],
    'comment.internal.post': ['admin', 'dispatcher', 'pm', 'engineer'],
    'photo.upload':          ['admin', 'dispatcher', 'pm', 'engineer', 'customer'],
    'site.manage':           ['admin', 'dispatcher', 'pm'],
    'site.delete':           ['admin'],
    'user.manage':           ['admin'],
    /* v2 additions */
    'part.view':             ['admin', 'dispatcher', 'pm', 'engineer'],  // catalog/warehouse read
    'part.manage':           ['admin', 'dispatcher'],                   // catalog/warehouse CRUD
    'plan.view':             ['admin', 'dispatcher', 'pm', 'engineer'],  // v5: planning/calendar read (customers excluded — isolation audit)
    'plan.manage':           ['admin', 'dispatcher'],                   // shift write
    'contract.manage':       ['admin', 'dispatcher'],                   // LTSA contract CRUD
    /* v6/v7 additions */
    'contact.manage':        ['admin', 'dispatcher', 'pm'],             // contacts master data
    'workflow.manage':       ['admin'],                                // workflow states/transitions
    'field.manage':          ['admin', 'dispatcher']                    // custom fields
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
                                             (role === 'engineer' && isAssignee);
        case 'assigned->open':        return role === 'admin' || role === 'dispatcher';
        case 'in_progress->resolved': return role === 'admin' || role === 'dispatcher' ||
                                             (role === 'engineer' && isAssignee);
        case 'in_progress->assigned': return role === 'admin' || role === 'dispatcher';
        case 'resolved->pending_customer': return role === 'admin' || role === 'dispatcher' ||
                                             (role === 'engineer' && isAssignee);
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
                                             (role === 'engineer' && isAssignee);
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
                                           (role === 'engineer' && isAssignee);
      case 'assigned->open':        return role === 'admin' || role === 'dispatcher';
      case 'in_progress->resolved': return role === 'admin' || role === 'dispatcher' ||
                                           (role === 'engineer' && isAssignee);
      case 'in_progress->assigned': return role === 'admin' || role === 'dispatcher';
      case 'in_progress->hq_approval': return role === 'admin' || role === 'dispatcher' ||
                                           (role === 'engineer' && isAssignee);
      case 'hq_approval->in_progress': return role === 'admin' || role === 'dispatcher';
      case 'hq_approval->resolved':  return role === 'admin' || role === 'dispatcher';
      case 'resolved->pending_customer': return role === 'admin' || role === 'dispatcher' ||
                                           (role === 'engineer' && isAssignee);
      case 'resolved->in_progress': return role === 'admin' || role === 'dispatcher';
      case 'resolved->closed': return (role === 'admin' || role === 'dispatcher' ||
                                         (role === 'pm' && inScope)) &&
                                         (ctx.source || 'customer_feedback') !== 'customer_feedback';
      case 'pending_customer->closed': return role === 'admin' || role === 'dispatcher' ||
                                         (role === 'pm' && inScope) ||
                                         (role === 'customer' && isCreator);
      case 'pending_customer->in_progress': return role === 'admin' || role === 'dispatcher' ||
                                         (role === 'engineer' && isAssignee);
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
   * empty visible_statuses → visible in every status.
   */
  function fieldVisibleIn(field, status) {
    if (!field) return false;
    var vs = field.visible_statuses || [];
    if (!vs.length) return true;
    return vs.indexOf(status) !== -1;
  }

  /**
   * validateCustomValues(fields, values) → array of error strings
   * ("<key>:required" / "<key>:invalid"). Pure; UI maps to i18n.
   */
  function validateCustomValues(fields, values) {
    var errs = [];
    values = values || {};
    (fields || []).forEach(function (f) {
      if (!f || f.is_active === false) return;
      var v = values[f.key];
      var empty = v === undefined || v === null || v === '' ||
                  (Array.isArray(v) && v.length === 0);
      if (f.required && empty) { errs.push(f.key + ':required'); return; }
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
    TRACKERS: TRACKERS,
    TRACKER_KEYS: TRACKER_KEYS,
    WORKFLOW_TEMPLATES: WORKFLOW_TEMPLATES,
    buildTransitions: buildTransitions,
    transitionRuleAllowed: transitionRuleAllowed,
    allowedTransitionsWf: allowedTransitionsWf,
    CF_TYPES: CF_TYPES,
    fieldVisibleIn: fieldVisibleIn,
    validateCustomValues: validateCustomValues,
    canCloseTicket: canCloseTicket,
    monthlyPlanDates: monthlyPlanDates,
    maintenanceProgress: maintenanceProgress,
    MAX_VIDEO_BYTES: MAX_VIDEO_BYTES,
    MAX_VIDEOS_PER_TICKET: MAX_VIDEOS_PER_TICKET,
    MAX_FILES_PER_TICKET: MAX_FILES_PER_TICKET,
    IMAGE_MAX_DIM: IMAGE_MAX_DIM
  };
}));
