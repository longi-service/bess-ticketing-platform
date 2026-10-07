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
  var STATUSES = ['open', 'assigned', 'in_progress', 'pending', 'resolved', 'closed'];
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
    'user.manage':           ['admin']
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
  /* Status transitions — DATA_CONTRACT.md §5                            */
  /* ------------------------------------------------------------------ */
  var TRANSITIONS = {
    open:        ['assigned', 'closed'],
    assigned:    ['in_progress', 'open'],
    in_progress: ['resolved', 'assigned'],
    resolved:    ['closed', 'in_progress'],
    closed:      []
  };

  /**
   * allowedTransitions(status, role, ctx) → array of target statuses the
   * user may move the ticket to. ctx: { isAssignee, isCreator, inScope }.
   * - assign / unassign / reopen / close      → dispatcher, admin
   * - accept (assigned→in_progress) / resolve → assigned engineer, or dispatcher/admin
   * - pm may additionally close a *resolved* ticket inside their project scope
   * - customers get no transitions at all
   */
  function allowedTransitions(status, role, ctx) {
    ctx = ctx || {};
    var isAssignee = !!ctx.isAssignee;
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
        case 'resolved->closed':       return role === 'admin' || role === 'dispatcher' ||
                                             (role === 'pm' && inScope);
        case 'resolved->in_progress': return role === 'admin' || role === 'dispatcher';
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
   * transitionCtx(ticket, user) → { isAssignee, isCreator, inScope } for
   * allowedTransitions().
   */
  function transitionCtx(ticket, user) {
    var scope = (user && user.project_scope) || [];
    return {
      isAssignee: !!(ticket && user && ticket.assigned_to === user.id),
      isCreator:  !!(ticket && user && ticket.created_by === user.id),
      inScope:    !!(user && user.role === 'pm') &&
                  (scope.length === 0 ||
                   (ticket && ticket.site_id != null && scope.indexOf(ticket.site_id) !== -1))
    };
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
    canViewTicket: canViewTicket,
    visibilityReason: visibilityReason,
    canUploadPhoto: canUploadPhoto,
    canPostInternal: canPostInternal,
    transitionCtx: transitionCtx,
    formatTicketNo: formatTicketNo,
    sanitizeFileName: sanitizeFileName,
    photoPath: photoPath
  };
}));
