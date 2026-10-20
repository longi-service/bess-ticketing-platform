/* ============================================================================
 * migration_v6_1.sql — BESS ticketing platform v6.1: Massimo master-data
 * alignment + support groups
 *
 * Run manually in the Supabase dashboard SQL editor (project
 * qewxlbfmoumodkncrvny, Frankfurt). All statements are idempotent
 * (IF NOT EXISTS / guarded) so re-running is safe.
 *
 * Covers:
 *  1. spare_parts: location / target_stock / part_number / criticality /
 *     supplier (columns from Massimo's Montalto inventory sheet)
 *  2. contacts.group_name (Key People "Group" column)
 *  3. contact_projects.role — per-project role of a linked contact
 *     (e.g. Field Service Technician / Service Manager of a site)
 *  4. sites.default_group_id + sites.remote_owner_email (comma-separated
 *     list; remote_owner_id keeps the first mailbox as before)
 *  5. groups + group_members — support groups (profiles and/or contacts);
 *     tickets.assigned_group_id so a ticket can be routed to a group
 * ========================================================================== */

-- --------------------------------------------------------------------------
-- 0. prerequisites — self-contained (added 2026-10-20; this file must not
--    depend on migration_v6 having run: it defines what it uses).
-- --------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- --------------------------------------------------------------------------
-- 1. spare_parts — extra inventory columns
-- (guarded: the table may not exist in this production DB)
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'spare_parts'
  ) THEN
    ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS location     TEXT;
    ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS target_stock NUMERIC;
    ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS part_number  TEXT;
    ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS criticality  TEXT;
    ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS supplier     TEXT;
    CREATE INDEX IF NOT EXISTS idx_spare_parts_part_number
      ON spare_parts (part_number);
  ELSE
    RAISE NOTICE 'v6.1: spare_parts table not found — section 1 skipped';
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 2. contacts.group_name — free-form group label from Key People sheet
-- --------------------------------------------------------------------------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS group_name TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_group_name ON contacts (group_name);

-- --------------------------------------------------------------------------
-- 3. contact_projects.role — role of the contact AT that site
-- --------------------------------------------------------------------------
ALTER TABLE contact_projects ADD COLUMN IF NOT EXISTS role TEXT;

-- --------------------------------------------------------------------------
-- 5a. groups — support groups (created before sites/tickets FKs)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_groups_updated ON groups;
CREATE TRIGGER trg_groups_updated
  BEFORE UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS group_members (
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_type TEXT NOT NULL CHECK (member_type IN ('profile', 'contact')),
  member_id   UUID NOT NULL,
  role        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, member_type, member_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_member
  ON group_members (member_type, member_id);

-- --------------------------------------------------------------------------
-- 4. sites — default support group + remote owner email list
-- --------------------------------------------------------------------------
ALTER TABLE sites ADD COLUMN IF NOT EXISTS default_group_id UUID
  REFERENCES groups(id) ON DELETE SET NULL;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS remote_owner_email TEXT;

CREATE INDEX IF NOT EXISTS idx_sites_default_group ON sites (default_group_id);

-- --------------------------------------------------------------------------
-- 5b. tickets — group assignment
-- --------------------------------------------------------------------------
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_group_id UUID
  REFERENCES groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tickets_group ON tickets (assigned_group_id);

-- --------------------------------------------------------------------------
-- RLS — same pattern as v6 master data (authenticated read, staff write).
-- NOTE: verify against the existing policies in the dashboard.
-- --------------------------------------------------------------------------
ALTER TABLE groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS groups_read ON groups;
CREATE POLICY groups_read ON groups
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS groups_write ON groups;
CREATE POLICY groups_write ON groups
  FOR ALL USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() -> 'user_metadata' ->> 'role') IN ('admin', 'dispatcher', 'pm')
  );

DROP POLICY IF EXISTS group_members_read ON group_members;
CREATE POLICY group_members_read ON group_members
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS group_members_write ON group_members;
CREATE POLICY group_members_write ON group_members
  FOR ALL USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() -> 'user_metadata' ->> 'role') IN ('admin', 'dispatcher', 'pm')
  );
