/* ============================================================================
 * migration_v6.sql — BESS ticketing platform v6: master-data extensions
 *
 * Run manually in the Supabase dashboard SQL editor (project
 * qewxlbfmoumodkncrvny, Frankfurt). All statements are idempotent
 * (IF NOT EXISTS / guarded) so re-running is safe.
 *
 * Covers requirement v6.1–v6.5:
 *  1. sites: project fields (description/status/geo/workflow/segment)
 *  2. contacts: NEW external-contact table + contact_projects links
 *  3. warehouses: type/address/contact/delivery notes
 *  4. spare_parts: owner (longi/customer)
 *  5. part_transactions: ensure ticket_id + tx_type columns
 *  + ltsa_contracts: support_24_7 + contract<->contact links
 * ========================================================================== */

-- --------------------------------------------------------------------------
-- 1. sites — project master data
-- Hierarchy already exists via parent_site_id (EU Service → country → site).
-- --------------------------------------------------------------------------
ALTER TABLE sites ADD COLUMN IF NOT EXISTS description   TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'active';
ALTER TABLE sites ADD COLUMN IF NOT EXISTS latitude      DOUBLE PRECISION;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS longitude     DOUBLE PRECISION;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS workflow_mode TEXT NOT NULL DEFAULT 'default';
ALTER TABLE sites ADD COLUMN IF NOT EXISTS segment       TEXT NOT NULL DEFAULT 'ci';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sites_status_chk'
  ) THEN
    ALTER TABLE sites ADD CONSTRAINT sites_status_chk
      CHECK (status IN ('active', 'paused', 'closed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sites_workflow_mode_chk'
  ) THEN
    ALTER TABLE sites ADD CONSTRAINT sites_workflow_mode_chk
      CHECK (workflow_mode IN ('default', 'inherit'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sites_segment_chk'
  ) THEN
    ALTER TABLE sites ADD CONSTRAINT sites_segment_chk
      CHECK (segment IN ('ci', 'utility'));
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 2. contacts — external contacts, INDEPENDENT of auth profiles.
-- A contact can be linked to several projects (sites).
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name  TEXT NOT NULL,
  last_name   TEXT,
  company     TEXT,
  role        TEXT,
  phone       TEXT,
  email       TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contacts_email   ON contacts (email);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts (company);

CREATE TABLE IF NOT EXISTS contact_projects (
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  site_id     UUID NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
  PRIMARY KEY (contact_id, site_id)
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contacts_updated ON contacts;
CREATE TRIGGER trg_contacts_updated
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- 3. warehouses — type/address/contact/delivery notes
-- Hierarchy already exists via parent_warehouse_id (EU/Italy/plant).
-- --------------------------------------------------------------------------
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS type           TEXT;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS address        TEXT;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS contact_name   TEXT;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS contact_phone  TEXT;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS contact_email  TEXT;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS delivery_notes TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'warehouses_type_chk'
  ) THEN
    ALTER TABLE warehouses ADD CONSTRAINT warehouses_type_chk
      CHECK (type IS NULL OR type IN ('on_site', 'off_site'));
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 4. spare_parts — owner (LONGi-owned tools vs customer-owned stock)
-- --------------------------------------------------------------------------
ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'longi';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'spare_parts_owner_chk'
  ) THEN
    ALTER TABLE spare_parts ADD CONSTRAINT spare_parts_owner_chk
      CHECK (owner IN ('longi', 'customer'));
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 5. part_transactions — movement ledger columns (guarded; v2 may exist)
-- --------------------------------------------------------------------------
ALTER TABLE part_transactions ADD COLUMN IF NOT EXISTS ticket_id UUID
  REFERENCES tickets(id) ON DELETE SET NULL;
ALTER TABLE part_transactions ADD COLUMN IF NOT EXISTS tx_type TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'part_transactions_tx_type_chk'
  ) THEN
    ALTER TABLE part_transactions ADD CONSTRAINT part_transactions_tx_type_chk
      CHECK (tx_type IS NULL OR tx_type IN ('in', 'out', 'adjust'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_part_tx_ticket ON part_transactions (ticket_id);

-- --------------------------------------------------------------------------
-- ltsa_contracts — 24/7 flag + contract<->contact links
-- --------------------------------------------------------------------------
ALTER TABLE ltsa_contracts ADD COLUMN IF NOT EXISTS support_24_7 BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS ltsa_contract_contacts (
  contract_id UUID NOT NULL REFERENCES ltsa_contracts(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES contacts(id)       ON DELETE CASCADE,
  PRIMARY KEY (contract_id, contact_id)
);

-- --------------------------------------------------------------------------
-- RLS — master data is staff-managed. Customers must not see contacts.
-- NOTE: verify against the existing policies in the dashboard; these mirror
-- the v3–v5 pattern (authenticated read, staff write).
-- --------------------------------------------------------------------------
ALTER TABLE contacts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_projects       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ltsa_contract_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contacts_read ON contacts;
CREATE POLICY contacts_read ON contacts
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS contacts_write ON contacts;
CREATE POLICY contacts_write ON contacts
  FOR ALL USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() -> 'user_metadata' ->> 'role') IN ('admin', 'dispatcher', 'pm')
  );

DROP POLICY IF EXISTS contact_projects_rw ON contact_projects;
CREATE POLICY contact_projects_rw ON contact_projects
  FOR ALL USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS ltsa_contract_contacts_rw ON ltsa_contract_contacts;
CREATE POLICY ltsa_contract_contacts_rw ON ltsa_contract_contacts
  FOR ALL USING (auth.role() = 'authenticated');
