/* ============================================================================
 * logic.test.js — independent verification suite for frontend/logic.js
 * (BESS ticketing platform v1). Written by the TESTER subagent, 2026-10-07.
 *
 * Run:  node logic.test.js        (also: node --check logic.js)
 * No dependencies. logic.js must stay DOM-free so this file can require it.
 * ========================================================================== */
'use strict';
const L = require('./logic.js');
const fs = require('fs');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.log('FAIL:', name); }
}
function eq(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b));
}
function arrEq(name, a, b) {
  const x = (a || []).slice().sort(), y = (b || []).slice().sort();
  ok(name, JSON.stringify(x) === JSON.stringify(y));
}

const ROLES = ['admin', 'dispatcher', 'pm', 'engineer', 'customer'];

/* ------------------------------------------------------------------ */
/* 1. can() — permission matrix for ALL 5 roles (contract §§1,5,8)       */
/* ------------------------------------------------------------------ */
const EXPECT_CAN = {
  'ticket.create':         { admin:1, dispatcher:1, pm:1, engineer:1, customer:1 },
  'ticket.assign':         { admin:1, dispatcher:1, pm:0, engineer:0, customer:0 },
  'ticket.edit.core':      { admin:1, dispatcher:1, pm:0, engineer:0, customer:0 },
  'ticket.edit.own':       { admin:0, dispatcher:0, pm:0, engineer:0, customer:1 },
  'ticket.fieldreport':    { admin:1, dispatcher:1, pm:0, engineer:1, customer:0 },
  'ticket.transition':     { admin:1, dispatcher:1, pm:1, engineer:1, customer:0 },
  'comment.internal.post': { admin:1, dispatcher:1, pm:1, engineer:1, customer:0 },
  'photo.upload':          { admin:1, dispatcher:1, pm:1, engineer:1, customer:1 },
  'site.manage':           { admin:1, dispatcher:1, pm:1, engineer:0, customer:0 },
  'site.delete':           { admin:1, dispatcher:0, pm:0, engineer:0, customer:0 },
  'user.manage':           { admin:1, dispatcher:0, pm:0, engineer:0, customer:0 },
};
Object.keys(EXPECT_CAN).forEach(perm => {
  ROLES.forEach(role => {
    ok(`can('${perm}','${role}') === ${!!EXPECT_CAN[perm][role]}`,
       L.can(perm, role) === !!EXPECT_CAN[perm][role]);
  });
});
ok('can() unknown permission → false', L.can('ticket.nuke', 'admin') === false);
ok('can() unknown role → false', L.can('ticket.create', 'superadmin') === false);
ok('can() undefined role → false', L.can('ticket.create', undefined) === false);
ok('can() null role → false', L.can('ticket.create', null) === false);
// Legacy role names from the old demo must NOT grant anything
ok('can() legacy role "agent" → false', L.can('ticket.create', 'agent') === false);
ok('can() legacy role "user" → false', L.can('ticket.create', 'user') === false);

/* ------------------------------------------------------------------ */
/* 2. allowedTransitions — contract §5, every status × role × ctx       */
/* ------------------------------------------------------------------ */
function T(status, role, ctx) { return L.allowedTransitions(status, role, ctx || {}); }

arrEq('open: admin',            T('open','admin'),            ['assigned','closed']);
arrEq('open: dispatcher',       T('open','dispatcher'),       ['assigned','closed']);
arrEq('open: pm',               T('open','pm'),               []);
arrEq('open: engineer assignee',T('open','engineer',{isAssignee:true}), []);
arrEq('open: customer creator', T('open','customer',{isCreator:true}), []);
arrEq('assigned: admin',        T('assigned','admin'),        ['in_progress','open']);
arrEq('assigned: dispatcher',   T('assigned','dispatcher'),   ['in_progress','open']);
arrEq('assigned: eng assignee', T('assigned','engineer',{isAssignee:true}), ['in_progress']);
arrEq('assigned: eng NOT assignee', T('assigned','engineer',{isAssignee:false}), []);
arrEq('assigned: eng no ctx',   T('assigned','engineer'),     []);
arrEq('assigned: pm',           T('assigned','pm'),           []);
arrEq('assigned: customer',     T('assigned','customer'),     []);
arrEq('in_progress: admin',     T('in_progress','admin'),     ['resolved','assigned']);
arrEq('in_progress: eng assignee', T('in_progress','engineer',{isAssignee:true}), ['resolved']);
arrEq('in_progress: eng not assignee', T('in_progress','engineer',{isAssignee:false}), []);
arrEq('in_progress: dispatcher',T('in_progress','dispatcher'),['resolved','assigned']);
arrEq('in_progress: pm',        T('in_progress','pm'),        []);
arrEq('in_progress: customer',  T('in_progress','customer'),  []);
arrEq('resolved: admin',        T('resolved','admin'),        ['closed','in_progress']);
arrEq('resolved: dispatcher',   T('resolved','dispatcher'),   ['closed','in_progress']);
arrEq('resolved: pm in scope',  T('resolved','pm',{inScope:true}), ['closed']);
arrEq('resolved: pm NOT in scope', T('resolved','pm',{inScope:false}), []);
arrEq('resolved: pm no ctx',    T('resolved','pm'),           []);
arrEq('resolved: engineer assignee', T('resolved','engineer',{isAssignee:true}), []);
arrEq('resolved: customer',     T('resolved','customer'),     []);
arrEq('closed: admin',          T('closed','admin'),          []);
arrEq('closed: dispatcher',     T('closed','dispatcher'),     []);
arrEq('closed: engineer',       T('closed','engineer'),       []);
arrEq('closed: customer',       T('closed','customer'),       []);
arrEq('pending: admin (unused status)', T('pending','admin'), []);
ok('unknown status → []', JSON.stringify(T('bogus','admin')) === '[]');
ok('unknown role → []', JSON.stringify(T('open','superadmin')) === '[]');
// engineer can never unassign or reopen
ok('engineer cannot assigned->open even as assignee',
   T('assigned','engineer',{isAssignee:true}).indexOf('open') === -1);
ok('engineer cannot in_progress->assigned even as assignee',
   T('in_progress','engineer',{isAssignee:true}).indexOf('assigned') === -1);
ok('engineer cannot resolved->in_progress even as assignee',
   T('resolved','engineer',{isAssignee:true}).indexOf('in_progress') === -1);
// customer can never close own ticket even while open
ok('customer cannot open->closed', T('open','customer',{isCreator:true}).indexOf('closed') === -1);

/* ------------------------------------------------------------------ */
/* 3. SLA — computation, states, escalation (contract §6)               */
/* ------------------------------------------------------------------ */
const created = '2026-10-01T00:00:00Z';
const dl = L.computeSlaDeadlines(created, 'urgent', L.DEFAULT_SLA_POLICIES);
eq('urgent response deadline = +1h',  new Date(dl.response).toISOString(), '2026-10-01T01:00:00.000Z');
eq('urgent onsite deadline = +24h',   new Date(dl.onsite).toISOString(),   '2026-10-02T00:00:00.000Z');
eq('urgent resolve deadline = +72h',  new Date(dl.resolve).toISOString(),  '2026-10-04T00:00:00.000Z');
const dlArr = L.computeSlaDeadlines(created, 'high',
  [{priority:'high', response_hours:4, onsite_hours:48, resolve_hours:120}]);
eq('array-form policies accepted', new Date(dlArr.response).toISOString(), '2026-10-01T04:00:00.000Z');
const dlUnknown = L.computeSlaDeadlines(created, 'nope', {});
eq('unknown priority falls back to medium policy', new Date(dlUnknown.response).toISOString(), '2026-10-01T08:00:00.000Z');
const dlBad = L.computeSlaDeadlines('not-a-date', 'high', L.DEFAULT_SLA_POLICIES);
ok('bad createdAt → null deadlines', dlBad.response === null && dlBad.resolve === null);
const norm = L.normalizePolicies([{priority:'low', response_hours:'24', onsite_hours:120, resolve_hours:336},
                                  {priority:'bogus', response_hours:1, onsite_hours:1, resolve_hours:1}]);
ok('normalizePolicies drops unknown priority, coerces strings', !!norm.low && !norm.bogus);
ok('normalizePolicies(null) → {}', JSON.stringify(L.normalizePolicies(null)) === '{}');

// slaState boundaries
const H = 3600 * 1000;
let s = L.slaState('2026-10-02T00:00:00Z', null, '2026-10-01T00:00:00Z');
eq('24h remaining → ok', s.state, 'ok');
s = L.slaState('2026-10-01T01:30:00Z', null, '2026-10-01T00:00:00Z');
eq('1.5h remaining → warning', s.state, 'warning');
s = L.slaState('2026-10-01T02:00:00Z', null, '2026-10-01T00:00:00Z');
eq('exactly 2h remaining → ok (warning is strictly <2h)', s.state, 'ok');
s = L.slaState('2026-10-01T00:00:00Z', null, '2026-10-01T01:00:00Z');
eq('past deadline, running → breached', s.state, 'breached');
ok('breached remainingMs negative', s.remainingMs < 0);
s = L.slaState('2026-10-02T00:00:00Z', '2026-10-01T12:00:00Z', '2026-10-05T00:00:00Z');
eq('stopped before deadline → ok', s.state, 'ok');
s = L.slaState('2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z', '2026-10-05T00:00:00Z');
eq('stopped after deadline → breached', s.state, 'breached');
s = L.slaState(null, null, '2026-10-01T00:00:00Z');
eq('no deadline → ok, null remaining', s.state, 'ok');
ok('no deadline → remainingMs null', s.remainingMs === null);

// ticketSla stoppers per contract: responded_at / visited_at / resolved_at
const t0 = { status:'open', sla_response_at:'2026-10-01T01:00:00Z', sla_onsite_at:'2026-10-02T00:00:00Z',
             sla_resolve_at:'2026-10-04T00:00:00Z', responded_at:'2026-10-01T00:30:00Z',
             visited_at:null, resolved_at:null };
const cs = L.ticketSla(t0, '2026-10-05T00:00:00Z');
eq('response stopped early → ok', cs.response.state, 'ok');
eq('onsite running past deadline → breached', cs.onsite.state, 'breached');
eq('resolution running past deadline → breached', cs.resolution.state, 'breached');

// isSlaBreached — escalation paths incl. documented deviation (c): skips terminal
ok('breach on running clock → true', L.isSlaBreached(t0, '2026-10-05T00:00:00Z') === true);
const tClosed = Object.assign({}, t0, { status:'closed' });
ok('DEVIATION (c): closed ticket never escalates even with breached clocks',
   L.isSlaBreached(tClosed, '2026-10-05T00:00:00Z') === false);
const tResolved = Object.assign({}, t0, { status:'resolved' });
ok('DEVIATION (c): resolved ticket never escalates', L.isSlaBreached(tResolved, '2026-10-05T00:00:00Z') === false);
const tFresh = { status:'open', sla_response_at:'2026-10-02T00:00:00Z', sla_onsite_at:'2026-10-05:00:00Z'.replace(':00:00Z', 'T00:00:00Z'),
                 sla_resolve_at:'2026-10-10T00:00:00Z' };
ok('no breach yet → false', L.isSlaBreached(tFresh, '2026-10-01T00:00:00Z') === false);
ok('null ticket → false', L.isSlaBreached(null, '2026-10-01T00:00:00Z') === false);
const tLateResp = { status:'open', sla_response_at:'2026-10-01T01:00:00Z', responded_at:'2026-10-01T05:00:00Z' };
ok('stopped-late response clock counts as breached (documents behavior)',
   L.isSlaBreached(tLateResp, '2026-10-02T00:00:00Z') === true);

/* ------------------------------------------------------------------ */
/* 4. Visibility — contract §8, edge cases                              */
/* ------------------------------------------------------------------ */
const U = (id, role, scope) => ({ id, role, project_scope: scope || [] });
const TK = (created_by, assigned_to, site_id) => ({ created_by, assigned_to, site_id });

const admin = U('a','admin'), disp = U('d','dispatcher'),
      pmAll = U('p1','pm',[]), pmScope = U('p2','pm',['siteA']),
      eng = U('e','engineer'), cust1 = U('c1','customer'), cust2 = U('c2','customer');

const t1 = TK('c1', null, 'siteA');   // customer1's open ticket at siteA
const t2 = TK('c2', null, 'siteB');
const t3 = TK('c1', 'e', 'siteA');    // assigned to engineer
const t4 = TK('p2', null, 'siteB');   // created by scoped pm, at siteB (out of own scope)
const tNoSite = TK('c1', null, null);

ok('admin sees all', L.canViewTicket(t2, admin) === true);
ok('dispatcher sees all', L.canViewTicket(t2, disp) === true);
ok('customer sees own', L.canViewTicket(t1, cust1) === true);
ok('customer cannot see others', L.canViewTicket(t2, cust1) === false);
ok('customer sees own assigned ticket', L.canViewTicket(t3, cust1) === true);
ok('engineer sees assigned', L.canViewTicket(t3, eng) === true);
ok('engineer cannot see unassigned', L.canViewTicket(t1, eng) === false);
ok('engineer sees own-created ticket (created_by=self rule)',
   L.canViewTicket(TK('e', null, 'siteB'), eng) === true);
ok('pm empty scope sees all', L.canViewTicket(t2, pmAll) === true);
ok('pm scoped sees ticket at in-scope site', L.canViewTicket(t1, pmScope) === true);
ok('pm scoped blocked at out-of-scope site', L.canViewTicket(t2, pmScope) === false);
ok('pm scoped sees own-created ticket even out of scope (creator rule)',
   L.canViewTicket(t4, pmScope) === true);
ok('pm scoped: ticket with null site_id NOT visible via scope',
   L.canViewTicket(tNoSite, pmScope) === false);
ok('pm scoped: null-site ticket visible to creator', L.canViewTicket(tNoSite, cust1) === true);
ok('null ticket → false', L.canViewTicket(null, admin) === false);
ok('null user → false', L.canViewTicket(t1, null) === false);
ok('user without id → false', L.canViewTicket(t1, { role:'admin' }) === false);
ok('unknown role → false', L.canViewTicket(t2, U('x','superadmin')) === false);

eq('visibilityReason admin → role', L.visibilityReason(t2, admin), 'role');
eq('visibilityReason creator → creator', L.visibilityReason(t1, cust1), 'creator');
eq('visibilityReason assignee → assignee', L.visibilityReason(t3, eng), 'assignee');
eq('visibilityReason pm scope → scope', L.visibilityReason(t1, pmScope), 'scope');
ok('visibilityReason denied → null', L.visibilityReason(t2, cust1) === null);

// canUploadPhoto — contract §7: view + (creator|assignee|dispatcher|admin)
ok('creator can upload', L.canUploadPhoto(t1, cust1) === true);
ok('assignee can upload', L.canUploadPhoto(t3, eng) === true);
ok('dispatcher can upload to any visible', L.canUploadPhoto(t1, disp) === true);
ok('admin can upload to any visible', L.canUploadPhoto(t1, admin) === true);
ok('pm cannot upload to in-scope ticket they neither created nor assigned',
   L.canUploadPhoto(t1, pmScope) === false);
ok('pm CAN upload to own-created ticket', L.canUploadPhoto(t4, pmScope) === true);
ok('customer cannot upload to invisible ticket', L.canUploadPhoto(t2, cust1) === false);
ok('engineer cannot upload to unassigned invisible ticket', L.canUploadPhoto(t1, eng) === false);

// canPostInternal — every non-customer role
ROLES.forEach(r => ok(`canPostInternal(${r}) === ${r !== 'customer'}`,
   L.canPostInternal(U('x', r)) === (r !== 'customer')));
ok('canPostInternal(null) → false', L.canPostInternal(null) === false);

// transitionCtx
const ctx = L.transitionCtx(t3, eng);
eq('transitionCtx engineer assignee', ctx, { isAssignee:true, isCreator:false, inScope:false });
const ctx2 = L.transitionCtx(t1, pmScope);
eq('transitionCtx pm in scope', ctx2, { isAssignee:false, isCreator:false, inScope:true });
const ctx3 = L.transitionCtx(t2, pmScope);
eq('transitionCtx pm out of scope', ctx3, { isAssignee:false, isCreator:false, inScope:false });
const ctx4 = L.transitionCtx(t4, pmScope);
eq('transitionCtx pm creator out-of-scope site → inScope false (scope is site-based)',
   ctx4, { isAssignee:false, isCreator:true, inScope:false });

/* ------------------------------------------------------------------ */
/* 5. Display helpers                                                   */
/* ------------------------------------------------------------------ */
eq('formatTicketNo(42)', L.formatTicketNo(42), 'T-0042');
eq('formatTicketNo(1)', L.formatTicketNo(1), 'T-0001');
eq('formatTicketNo("abc")', L.formatTicketNo('abc'), 'T-????');
eq('sanitizeFileName strips unsafe chars', L.sanitizeFileName('a/b\\c:d photo (1).png'), 'a_b_c_d_photo_1_.png');
ok('sanitizeFileName caps length at 120', L.sanitizeFileName('x'.repeat(200)).length === 120);
const pp = L.photoPath('tid-123', 'My Photo.png', 'fixed-uuid');
eq('photoPath convention <ticket>/<uuid>-<sanitized>', pp, 'tid-123/fixed-uuid-My_Photo.png');
ok('photoPath default uid present', L.photoPath('t','f.png').indexOf('t/') === 0);

/* ------------------------------------------------------------------ */
/* 6. i18n parity — every key in en must exist in zh and vice versa     */
/* ------------------------------------------------------------------ */
(function i18nParity() {
  const src = fs.readFileSync(__dirname + '/i18n.js', 'utf8');
  const sandbox = {};
  vm.runInNewContext(src, sandbox);
  const I18N = sandbox.I18N;
  ok('I18N exposes en', !!I18N && !!I18N.en);
  ok('I18N exposes zh', !!I18N && !!I18N.zh);
  const enKeys = Object.keys(I18N.en).sort();
  const zhKeys = Object.keys(I18N.zh).sort();
  const missingInZh = enKeys.filter(k => !(k in I18N.zh));
  const missingInEn = zhKeys.filter(k => !(k in I18N.en));
  ok(`i18n: 0 keys missing in zh (missing: ${missingInZh.join(',')})`, missingInZh.length === 0);
  ok(`i18n: 0 keys missing in en (missing: ${missingInEn.join(',')})`, missingInEn.length === 0);
  const emptyZh = enKeys.filter(k => !I18N.zh[k] || !String(I18N.zh[k]).trim());
  ok(`i18n: 0 empty zh values (empty: ${emptyZh.join(',')})`, emptyZh.length === 0);
  console.log(`i18n: ${enKeys.length} keys in en, ${zhKeys.length} keys in zh`);
})();

/* ------------------------------------------------------------------ */
console.log(`\nlogic.test.js: ${pass} passed, ${fail} failed`);
if (fail) { console.log('Failed:', failures.join(' | ')); process.exit(1); }
