-- ==========================================================================
-- migration_v8.sql — Europe trial feedback (tiers 1 + 2)
-- Run in the Supabase SQL Editor (Frankfurt project). Idempotent.
--
-- Contents:
--   1. sites.remote_owner_group_id          (#11 remote owner can be a group)
--   2. custom_fields.depends_on / required_states   (#23 / #21)
--   3. group_sites                          (#6 group <-> project links)
--   4. ticket_watchers / ticket_contacts    (tier-2: internal watchers +
--                                            related contacts, no accounts)
--   5. notifications + triggers             (#4 in-app notification bell)
--   6. RLS alignment: workflow writes for dispatchers (#18), dictionary
--      keys for dispatchers (#10/#17), trackers key stays admin-only
--   7. profiles.role check allows 'tech_manager'  (#24 fixed role)
-- RLS follows the platform pattern: role read from the JWT user_metadata
-- (kept in sync with profiles.role by the account scripts).
-- ==========================================================================

-- ---------------------------------------------------------------------------
-- 1. Remote owner group (#11)
-- ---------------------------------------------------------------------------
ALTER TABLE sites ADD COLUMN IF NOT EXISTS remote_owner_group_id UUID
  REFERENCES groups(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 2. Custom-field dependencies + per-state required (#23 / #21)
--    depends_on = {"field": "<source key>", "op": "eq|neq|one_of|filled|empty|gt",
--                  "value": "<compare value>"}
-- ---------------------------------------------------------------------------
ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS depends_on JSONB;
ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS required_states TEXT[] DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- 3. group_sites (#6)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_sites (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  site_id  UUID NOT NULL REFERENCES sites(id)  ON DELETE CASCADE,
  PRIMARY KEY (group_id, site_id)
);
ALTER TABLE group_sites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS group_sites_read ON group_sites;
CREATE POLICY group_sites_read ON group_sites
  FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS group_sites_write ON group_sites;
CREATE POLICY group_sites_write ON group_sites
  FOR ALL USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() -> 'user_metadata' ->> 'role') IN ('admin', 'dispatcher', 'pm')
  );

-- ---------------------------------------------------------------------------
-- 4. Ticket watchers (internal users only) + related contacts (#3/#5/#14)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_watchers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  UUID NOT NULL REFERENCES tickets(id)  ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  added_by   UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, user_id)
);
CREATE TABLE IF NOT EXISTS ticket_contacts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  UUID NOT NULL REFERENCES tickets(id)  ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_by   UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, contact_id)
);
ALTER TABLE ticket_watchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ticket_watchers_read ON ticket_watchers;
CREATE POLICY ticket_watchers_read ON ticket_watchers
  FOR SELECT USING (auth.role() = 'authenticated' AND ticket_visible(ticket_id));
DROP POLICY IF EXISTS ticket_watchers_write ON ticket_watchers;
CREATE POLICY ticket_watchers_write ON ticket_watchers
  FOR ALL USING (
    auth.role() = 'authenticated' AND ticket_visible(ticket_id)
    AND (auth.jwt() -> 'user_metadata' ->> 'role')
        IN ('admin', 'dispatcher', 'pm', 'engineer', 'tech_manager')
  );
DROP POLICY IF EXISTS ticket_contacts_read ON ticket_contacts;
CREATE POLICY ticket_contacts_read ON ticket_contacts
  FOR SELECT USING (auth.role() = 'authenticated' AND ticket_visible(ticket_id));
DROP POLICY IF EXISTS ticket_contacts_write ON ticket_contacts;
CREATE POLICY ticket_contacts_write ON ticket_contacts
  FOR ALL USING (
    auth.role() = 'authenticated' AND ticket_visible(ticket_id)
    AND (auth.jwt() -> 'user_metadata' ->> 'role')
        IN ('admin', 'dispatcher', 'pm', 'engineer', 'tech_manager')
  );

-- ---------------------------------------------------------------------------
-- 5. In-app notifications (#4) — populated by triggers, read by the bell.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  ticket_id  UUID REFERENCES tickets(id) ON DELETE CASCADE,
  ticket_no  TEXT,
  kind       TEXT NOT NULL,   -- ticket_created | ticket_assigned | status_changed | comment_added
  detail     TEXT,
  is_read    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, is_read, created_at DESC);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_read ON notifications;
CREATE POLICY notifications_read ON notifications
  FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS notifications_update ON notifications;
CREATE POLICY notifications_update ON notifications
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
-- (No client INSERT policy on purpose: rows are created by the
--  SECURITY DEFINER trigger functions below.)

-- Helper: insert one notification per recipient, skipping the actor,
-- duplicates within the set, and inactive profiles.
CREATE OR REPLACE FUNCTION notify_users(
  p_ticket tickets, p_kind TEXT, p_detail TEXT,
  p_recipients UUID[], p_actor UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE uid UUID;
BEGIN
  IF p_recipients IS NULL THEN RETURN; END IF;
  FOREACH uid IN ARRAY p_recipients LOOP
    IF uid IS NULL OR uid = p_actor THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM profiles WHERE id = uid AND is_active) THEN
      INSERT INTO notifications (user_id, ticket_id, ticket_no, kind, detail)
      VALUES (uid, p_ticket.id, p_ticket.ticket_no::text, p_kind, p_detail);
    END IF;
  END LOOP;
END $$;

-- Helper: the staff audience of a ticket (assignee, group members,
-- watchers, dispatchers/admins), as an array.
CREATE OR REPLACE FUNCTION ticket_audience(p_ticket tickets)
RETURNS UUID[] LANGUAGE sql STABLE AS $$
  SELECT array_remove(
    ARRAY[p_ticket.assigned_to]
    || COALESCE((SELECT array_agg(member_id) FROM group_members
        WHERE group_id = p_ticket.assigned_group_id AND member_type = 'profile'), '{}'::uuid[])
    || COALESCE((SELECT array_agg(user_id) FROM ticket_watchers
        WHERE ticket_id = p_ticket.id), '{}'::uuid[])
    || COALESCE((SELECT array_agg(id) FROM profiles
        WHERE role IN ('admin', 'dispatcher') AND is_active), '{}'::uuid[]),
  NULL);
$$;

-- Tickets: created / assigned / status changed.
CREATE OR REPLACE FUNCTION trg_notify_ticket() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE actor UUID := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_to IS NOT NULL THEN
      PERFORM notify_users(NEW, 'ticket_assigned', NEW.title, ARRAY[NEW.assigned_to], actor);
      PERFORM notify_users(NEW, 'ticket_assigned', NEW.title,
        (SELECT array_agg(member_id) FROM group_members
          WHERE group_id = NEW.assigned_group_id AND member_type = 'profile'), actor);
    END IF;
    PERFORM notify_users(NEW, 'ticket_created', NEW.title,
      (SELECT array_agg(id) FROM profiles WHERE role IN ('admin', 'dispatcher') AND is_active), actor);
    RETURN NEW;
  END IF;
  -- UPDATE
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to AND NEW.assigned_to IS NOT NULL THEN
    PERFORM notify_users(NEW, 'ticket_assigned', NEW.title, ARRAY[NEW.assigned_to], actor);
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM notify_users(NEW, 'status_changed', OLD.status || ' → ' || NEW.status,
      array_cat(ARRAY[NEW.created_by], ticket_audience(NEW)), actor);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS notify_ticket ON tickets;
CREATE TRIGGER notify_ticket AFTER INSERT OR UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION trg_notify_ticket();

-- Comments: public comments also reach the ticket creator; internal
-- comments stay inside the staff audience (isolation by design).
CREATE OR REPLACE FUNCTION trg_notify_comment() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE tk tickets;
BEGIN
  SELECT * INTO tk FROM tickets WHERE id = NEW.ticket_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.is_internal THEN
    PERFORM notify_users(tk, 'comment_added', tk.title, ticket_audience(tk), NEW.author_id);
  ELSE
    PERFORM notify_users(tk, 'comment_added', tk.title,
      array_cat(ARRAY[tk.created_by], ticket_audience(tk)), NEW.author_id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS notify_comment ON ticket_comments;
CREATE TRIGGER notify_comment AFTER INSERT ON ticket_comments
  FOR EACH ROW EXECUTE FUNCTION trg_notify_comment();

-- ---------------------------------------------------------------------------
-- 6. Policy alignment for the v8 UI permissions
--    #18: workflow management opens to dispatchers (was admin-only).
--    #10/#17: dictionary keys in app_settings open to dispatchers; the
--    'trackers' key (and everything else) stays admin-only (#21 governed).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS wf_write ON workflow_states;
CREATE POLICY wf_write ON workflow_states
  FOR ALL USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() -> 'user_metadata' ->> 'role') IN ('admin', 'dispatcher')
  );
DROP POLICY IF EXISTS wft_write ON workflow_transitions;
CREATE POLICY wft_write ON workflow_transitions
  FOR ALL USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() -> 'user_metadata' ->> 'role') IN ('admin', 'dispatcher')
  );
DROP POLICY IF EXISTS settings_write ON app_settings;
CREATE POLICY settings_write ON app_settings
  FOR ALL
  USING (
    auth.role() = 'authenticated'
    AND ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
      OR ((auth.jwt() -> 'user_metadata' ->> 'role') = 'dispatcher'
          AND key IN ('dict_segments', 'dict_sources')))
  )
  WITH CHECK (
    auth.role() = 'authenticated'
    AND ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
      OR ((auth.jwt() -> 'user_metadata' ->> 'role') = 'dispatcher'
          AND key IN ('dict_segments', 'dict_sources')))
  );

-- ---------------------------------------------------------------------------
-- 7. profiles.role: allow the fixed 'tech_manager' role (#24), if a CHECK
--    constraint on the role column exists. No-op when unconstrained.
-- ---------------------------------------------------------------------------
DO $$
DECLARE c_name TEXT;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'profiles'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%customer%';
  IF c_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE profiles DROP CONSTRAINT ' || quote_ident(c_name);
    ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
      CHECK (role IN ('admin', 'dispatcher', 'pm', 'engineer', 'customer', 'tech_manager'));
  END IF;
END $$;
