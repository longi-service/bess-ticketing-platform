-- =====================================================================
-- BESS Ticketing Platform — migration v8.2
-- Audit events for tickets: the detail timeline is synthesized from
-- milestone timestamp columns (created/responded/visited/escalated/
-- resolved/closed), so generic status transitions and assignments
-- left no trace (found in the 2026-10-23 full functional sweep).
-- This table stores one row per transition / assignment; the app
-- writes it fire-and-forget and merges it into the timeline + the
-- printed service report history.
-- Run AFTER migration_v8_1.sql. Idempotent.
-- =====================================================================

CREATE TABLE IF NOT EXISTS ticket_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_id UUID,
  kind TEXT NOT NULL,            -- 'status' | 'assigned'
  detail TEXT,                   -- status: 'open → assigned'; assigned: 'u:<uuid>' | 'g:<uuid>'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_events_ticket_idx
  ON ticket_events (ticket_id, created_at);

ALTER TABLE ticket_events ENABLE ROW LEVEL SECURITY;

-- Read: anyone who can see the ticket can see its audit trail.
DROP POLICY IF EXISTS te_read ON ticket_events;
CREATE POLICY te_read ON ticket_events
  FOR SELECT USING (ticket_visible(ticket_id));

-- Write: only as yourself, only on tickets you can see. No UPDATE or
-- DELETE policies — the audit trail is append-only.
DROP POLICY IF EXISTS te_insert ON ticket_events;
CREATE POLICY te_insert ON ticket_events
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated'
    AND actor_id = auth.uid()
    AND ticket_visible(ticket_id)
  );
