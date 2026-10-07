# v2 Frontend — Build & Test Report

Date: 2026-10-07 · Scope: `~/workspace/ticket-platform/v1/frontend/` (extended in place; `demo/`, `transfer/` untouched; **not pushed**)

## Modules built

**M1 Spare parts** (`viewParts`, `#/parts`)
- Parts catalog table (code/name/category/unit) with CRUD dialogs, gated to `part.manage` (admin/dispatcher); engineers/PM read-only; customers hidden via nav perm `part.view` + route guard.
- Warehouse tree indented by `parent_warehouse_id`, with per-part stock rows from `stock_levels`; low-stock (`qty < min_qty`) highlighted amber, out-of-stock red.
- Recent `part_transactions` ledger (100 rows): type badge issue/return (sign of `qty_delta`), part, qty, warehouse, ticket link, actor, note.
- Ticket detail “Spare parts” block: lists issues for the ticket; “Issue part” dialog → warehouse select limited to the ticket site's warehouses (notice `parts.noWarehouseLinked` + no save button when none), part select, qty → `sb.rpc('issue_spare_part', …)`; RPC errors (e.g. insufficient stock) surface as error toasts. Per-issue “Return” button → `sb.rpc('return_spare_part', …)` (engineer/dispatcher/admin only).

**M2 Planning + Calendar** (`viewPlanning` `#/planning`, `viewCalendar` `#/calendar`)
- Planning: active engineers × day grid, 1/2/4-week switcher, prev/next, search filter, cert filter; click cell → modal to set `available`/`assigned`/`leave` (+site select when assigned, note), upsert on `(engineer_id,day)`; empty day renders via pure `L.dayState` (weekend→`weekend`, else `remote`); cert badges on rows. Write actions gated to `plan.manage` (admin/dispatcher); nav visible to all authenticated.
- Calendar: month view (Mon-start, prev/today/next), shift chips per day + tickets with `planned_check_at` that day; ticket chip click → detail. Contract tickets get the red rail chip.

**M3 Dashboard** (extended `viewDashboard`, existing 4 counters kept)
- Counters: open, contract-priority open (`is_ltsa`), unassigned, breached SLA, my tickets, avg first-response hrs (30d), closed last 30d (`closed_at`), SLA compliance % (closed 30d with `closed_at <= sla_resolve_at`).
- Inline-SVG donuts (no libs): tickets by status, by priority.
- Contract KPI rail (red accent): plants under contract, open contract tickets, breached contract tickets; per-site table — contract `availability_pct` vs actual (% closed within `sla_resolve_at`, 90d, `—` if none), coverage, R/O/S hours, at-risk count (open contract tickets with warning/breached clock).
- Team workload: per-engineer open assigned count + load bar, of-which contract, breached.

**M4 Project tree + LTSA contracts** (`viewSites` tree, `viewSiteDetail` `#/site/:id`)
- Sites page is now a tree (indent by `parent_site_id`) with name/code search; per-node badges: contract active (green) / expiring ≤30d (amber, “Expires in Nd”) / none (grey); open-ticket count chip; click → site detail.
- Site detail: identity card, contract card (summary + new/edit/delete via dialog with all `ltsa_contracts` fields, admin/dispatcher only), warehouses (list + create/link via `site_id`), remote-owner display + assign select (active admin/dispatcher/engineer), recent tickets, child-site list. Site modal now also edits `parent_site_id`.
- `recomputeContractTickets(siteId, contract)`: on save → open-status tickets get `is_ltsa=true`, `priority='urgent'`, `sla_*_at` from contract hours via `L.applyContract` (base `created_at`; onsite null when disabled); on delete → `is_ltsa=false`, `priority='high'`, SLA from `sla_policies('high')`. `resolved_at`/`closed_at` untouched.
- R3 on ticket create: site with active contract → priority select forced to `urgent` + disabled with notice, `is_ltsa=true`, SLA from contract.
- Ticket list rows and detail header show red rail / “Contract ticket” badge for `is_ltsa`.

**M5 Benchmark integrations**
- `pending_customer` status: new transition map in `logic.js` (`resolved→{pending_customer,in_progress}`, `pending_customer→{closed,in_progress}`); role rules per spec (engineer/dispatcher/admin request confirmation; customer-creator/pm-in-scope/dispatcher/admin close; engineer/dispatcher/admin rework). App sets `resolved_at` on entering `resolved`/`pending_customer`, clears on rework, sets `closed_at` on entering `closed`. Timeline shows closed event.
- `cert_level`: admin-only select (None/Associate/Professional) in user form; badges in users list + planning rows; planning cert filter.
- Remote owner: site detail select (active admin/dispatcher/engineer) + display.
- Availability widget: contract vs actual in dashboard contract table.
- `logic.js` pure helpers: `isContractActive(contract, today)`, `applyContract(createdAt, contract)`, `dayState(shiftStatus, date)` — all unit-tested. New UI perms: `part.view`, `part.manage`, `plan.manage`, `contract.manage`.

## Tests run + results
- `node --check` on `logic.js`, `i18n.js`, `app.js`, `logic.test.js` — all pass.
- `node frontend/logic.test.js` — **234 passed, 0 failed**, incl.:
  - updated v2 transition matrix (old `resolved→closed` cases replaced; new `pending_customer` cases for all roles/ctx),
  - 4 new permission-matrix entries × 5 roles,
  - new sections: `isContractActive` (9), `applyContract` (10), `dayState` (9),
  - i18n parity block: **374 keys en / 374 keys zh, 0 missing, 0 empty**.
- Static cross-check: all 115 static `getElementById` ids resolve (only `app`/`toast-root`/`modal-root` come from `index.html`); all 325 static `t('…')` keys exist in both dicts; all dynamic `status./priority./source./role./dash.hint./plan.` keys verified.

## Deviations from spec (intentional)
1. **Transition map changed per the v2 spec**: `resolved→closed` no longer exists — close now flows `resolved → pending_customer → closed` (customer/pm confirm). This supersedes DATA_CONTRACT.md §5; `logic.test.js` was updated accordingly (the spec explicitly gave the new full map).
2. Shift editing uses the existing modal pattern instead of a floating popover (same fields/behavior; more robust on mobile).
3. Parts-ledger “type” is derived from the sign of `qty_delta` (issue < 0, return > 0) since `part_transactions` has no explicit type column.

## Known gaps / follow-ups
- **Backend dependency**: `../supabase/migration_v2.sql` did not exist at build time. All v2 queries (`spare_parts`, `warehouses`, `stock_levels`, `part_transactions`, `shifts`, `ltsa_contracts`, `profiles.cert_level`, `sites.parent_site_id`, `tickets.is_ltsa/resolved_at/closed_at`, RPCs) fail visibly (inline error / toast) until the migration is applied — no silent breakage, and v1 views are unaffected.
- `recomputeContractTickets` issues one UPDATE per ticket (fine for typical volumes; could be batched server-side later).
- Site-parent selector does not prevent hierarchy cycles client-side (relies on backend/RLS).
- Planning grid re-queries shifts on every navigation; no realtime subscription (same as v1 patterns).
- Not pushed to GitHub per instructions; working tree only.
