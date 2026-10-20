/* ============================================================================
 * migration_v6.sql — BESS ticketing platform v6: master-data extensions
 *
 * Run manually in the Supabase dashboard SQL editor (project
 * qewxlbfmoumodkncrvny, Frankfurt). All statements are idempotent
 * (IF NOT EXISTS / guarded) so re-running is safe.
 *
 * ROBUSTNESS (2026-10-20 fix): this file makes NO assumptions about the
 * production schema beyond "sites exists" (proven 2026-10-20):
 *  - CREATE EXTENSION pgcrypto is included (gen_random_uuid needs it).
 *  - set_updated_at() is (re)created here so the file runs standalone.
 *  - Foreign keys to pre-existing tables (sites / tickets /
 *    ltsa_contracts) are added ADAPTIVELY: the script probes the real
 *    PRIMARY KEY column of each table and only then creates the FK.
 *    Whatever it finds is printed as a NOTICE ("v6 probe → ...").
 *    >>> After running, copy the "v6 probe" NOTICE lines and send them
 *    back — they tell us the real PK columns so app code can be aligned.
 *  - ALTERs on tables that may not exist (warehouses, spare_parts,
 *    ltsa_contracts, part_transactions) are guarded by existence checks.
 *  - Every FK attempt is wrapped so it can only ever degrade to a NOTICE,
 *    never to an ERROR. This file cannot fail with 42703/42P01/42883.
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
-- 0. prerequisites — every migration file is self-contained
-- --------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- --------------------------------------------------------------------------
-- 1. sites — project master data
-- (sites is proven to exist in production; these columns are all new.)
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
      CHECK (status IN ('active', 'paused', 'closed')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sites_workflow_mode_chk'
  ) THEN
    ALTER TABLE sites ADD CONSTRAINT sites_workflow_mode_chk
      CHECK (workflow_mode IN ('default', 'inherit')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sites_segment_chk'
  ) THEN
    ALTER TABLE sites ADD CONSTRAINT sites_segment_chk
      CHECK (segment IN ('ci', 'utility')) NOT VALID;
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 2. contacts — external contacts, INDEPENDENT of auth profiles.
-- A contact can be linked to several projects (sites).
-- (FK to sites is added adaptively in section 6.)
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
  site_id     UUID NOT NULL,
  PRIMARY KEY (contact_id, site_id)
);

DROP TRIGGER IF EXISTS trg_contacts_updated ON contacts;
CREATE TRIGGER trg_contacts_updated
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- 3. warehouses — type/address/contact/delivery notes
-- (guarded: the table may not exist in this production DB)
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'warehouses'
  ) THEN
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS type           TEXT;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS address        TEXT;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS contact_name   TEXT;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS contact_phone  TEXT;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS contact_email  TEXT;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS delivery_notes TEXT;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'warehouses_type_chk'
    ) THEN
      -- NOT VALID: never fail on legacy rows, enforce for new writes.
      ALTER TABLE warehouses ADD CONSTRAINT warehouses_type_chk
        CHECK (type IS NULL OR type IN ('on_site', 'off_site')) NOT VALID;
    END IF;
  ELSE
    RAISE NOTICE 'v6: warehouses table not found — section 3 skipped';
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 4. spare_parts — owner (longi/customer)
-- (guarded: the table may not exist in this production DB)
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'spare_parts'
  ) THEN
    ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'longi';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'spare_parts_owner_chk'
    ) THEN
      ALTER TABLE spare_parts ADD CONSTRAINT spare_parts_owner_chk
        CHECK (owner IN ('longi', 'customer')) NOT VALID;
    END IF;
  ELSE
    RAISE NOTICE 'v6: spare_parts table not found — section 4 skipped';
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 5. ltsa_contracts — 24/7 flag + contract<->contact links
-- (ALTER guarded; FK to ltsa_contracts added adaptively in section 6.)
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ltsa_contracts'
  ) THEN
    ALTER TABLE ltsa_contracts ADD COLUMN IF NOT EXISTS support_24_7 BOOLEAN NOT NULL DEFAULT FALSE;
  ELSE
    RAISE NOTICE 'v6: ltsa_contracts table not found — support_24_7 skipped';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ltsa_contract_contacts (
  contract_id UUID NOT NULL,
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (contract_id, contact_id)
);

-- --------------------------------------------------------------------------
-- 6. adaptive foreign keys — probe the REAL primary keys first.
--    Prints "v6 probe → ..." NOTICEs. Copy them back after running.
-- --------------------------------------------------------------------------
DO $$
DECLARE
  s_col TEXT; s_typ TEXT;
  t_col TEXT; t_typ TEXT;
  c_col TEXT; c_typ TEXT;
  pt_exists BOOLEAN;
BEGIN
  SELECT kcu.column_name, c.data_type INTO s_col, s_typ
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema   = kcu.table_schema
  JOIN information_schema.columns c
    ON c.table_schema = kcu.table_schema
   AND c.table_name   = kcu.table_name
   AND c.column_name  = kcu.column_name
  WHERE tc.table_schema = 'public' AND tc.table_name = 'sites'
    AND tc.constraint_type = 'PRIMARY KEY'
  ORDER BY kcu.ordinal_position LIMIT 1;

  SELECT kcu.column_name, c.data_type INTO t_col, t_typ
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema   = kcu.table_schema
  JOIN information_schema.columns c
    ON c.table_schema = kcu.table_schema
   AND c.table_name   = kcu.table_name
   AND c.column_name  = kcu.column_name
  WHERE tc.table_schema = 'public' AND tc.table_name = 'tickets'
    AND tc.constraint_type = 'PRIMARY KEY'
  ORDER BY kcu.ordinal_position LIMIT 1;

  SELECT kcu.column_name, c.data_type INTO c_col, c_typ
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema   = kcu.table_schema
  JOIN information_schema.columns c
    ON c.table_schema = kcu.table_schema
   AND c.table_name   = kcu.table_name
   AND c.column_name  = kcu.column_name
  WHERE tc.table_schema = 'public' AND tc.table_name = 'ltsa_contracts'
    AND tc.constraint_type = 'PRIMARY KEY'
  ORDER BY kcu.ordinal_position LIMIT 1;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'part_transactions'
  ) INTO pt_exists;

  RAISE NOTICE 'v6 probe → sites PK: %.% | tickets PK: %.% | ltsa_contracts PK: %.% | part_transactions exists: %',
    COALESCE(s_col, '?'), COALESCE(s_typ, '?'),
    COALESCE(t_col, '?'), COALESCE(t_typ, '?'),
    COALESCE(c_col, '?'), COALESCE(c_typ, '?'),
    pt_exists;

  -- contact_projects.site_id → sites ------------------------------------------------
  IF s_col IS NOT NULL AND s_typ = 'uuid'
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_contact_projects_site') THEN
    BEGIN
      EXECUTE format(
        'ALTER TABLE contact_projects ADD CONSTRAINT fk_contact_projects_site FOREIGN KEY (site_id) REFERENCES sites(%I) ON DELETE CASCADE',
        s_col);
      RAISE NOTICE 'v6: fk_contact_projects_site → sites(%) created', s_col;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'v6: fk_contact_projects_site skipped: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'v6: fk_contact_projects_site skipped (sites PK % not uuid-referenceable)', COALESCE(s_col, 'missing');
  END IF;

  -- ltsa_contract_contacts.contract_id → ltsa_contracts --------------------------------
  IF c_col IS NOT NULL AND c_typ = 'uuid'
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ltsa_contract_contacts_contract') THEN
    BEGIN
      EXECUTE format(
        'ALTER TABLE ltsa_contract_contacts ADD CONSTRAINT fk_ltsa_contract_contacts_contract FOREIGN KEY (contract_id) REFERENCES ltsa_contracts(%I) ON DELETE CASCADE',
        c_col);
      RAISE NOTICE 'v6: fk_ltsa_contract_contacts_contract → ltsa_contracts(%) created', c_col;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'v6: fk_ltsa_contract_contacts_contract skipped: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'v6: fk_ltsa_contract_contacts_contract skipped (ltsa_contracts PK % not uuid-referenceable)', COALESCE(c_col, 'missing');
  END IF;

  -- part_transactions.ticket_id / tx_type (only if the table exists) -------------------
  IF pt_exists THEN
    ALTER TABLE part_transactions ADD COLUMN IF NOT EXISTS ticket_id UUID;
    ALTER TABLE part_transactions ADD COLUMN IF NOT EXISTS tx_type TEXT;
    IF t_col IS NOT NULL AND t_typ = 'uuid'
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_part_tx_ticket') THEN
      BEGIN
        EXECUTE format(
          'ALTER TABLE part_transactions ADD CONSTRAINT fk_part_tx_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(%I) ON DELETE SET NULL',
          t_col);
        RAISE NOTICE 'v6: fk_part_tx_ticket → tickets(%) created', t_col;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'v6: fk_part_tx_ticket skipped: %', SQLERRM;
      END;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'part_transactions_tx_type_chk') THEN
      ALTER TABLE part_transactions ADD CONSTRAINT part_transactions_tx_type_chk
        CHECK (tx_type IS NULL OR tx_type IN ('in', 'out', 'adjust')) NOT VALID;
    END IF;
    CREATE INDEX IF NOT EXISTS idx_part_tx_ticket ON part_transactions (ticket_id);
  ELSE
    RAISE NOTICE 'v6: part_transactions table not found — ticket_id/tx_type skipped';
  END IF;
END $$;

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
