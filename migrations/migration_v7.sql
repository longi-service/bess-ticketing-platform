/* ============================================================================
 * migration_v7.sql — BESS ticketing platform v7: tracker system, configurable
 * workflow, master/sub-tickets, service-report enforcement, monthly
 * maintenance, custom fields.
 *
 * Run manually in the Supabase dashboard SQL editor AFTER migration_v6.sql.
 * All statements are idempotent.
 *
 * Covers requirement v7.7–v7.14 (email + mobile explicitly OUT of scope).
 * ========================================================================== */

-- --------------------------------------------------------------------------
-- 7/10. tickets — tracker, workflow key, parent (master/sub), custom values,
-- planned date (monthly maintenance scheduling)
-- --------------------------------------------------------------------------
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tracker TEXT NOT NULL DEFAULT 'support';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS workflow_key TEXT NOT NULL DEFAULT 'ci';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS parent_ticket_id UUID
  REFERENCES tickets(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS custom_values JSONB NOT NULL DEFAULT '{}';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS planned_date DATE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_tracker_chk') THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_tracker_chk
      CHECK (tracker IN ('support', 'maintenance', 'spare', 'quality'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_workflow_key_chk') THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_workflow_key_chk
      CHECK (workflow_key IN ('ci', 'utility'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_tickets_tracker ON tickets (tracker);
CREATE INDEX IF NOT EXISTS idx_tickets_parent  ON tickets (parent_ticket_id);

-- ticket_links — link type (related / subtask / approval)
ALTER TABLE ticket_links ADD COLUMN IF NOT EXISTS link_type TEXT NOT NULL DEFAULT 'related';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_links_type_chk') THEN
    ALTER TABLE ticket_links ADD CONSTRAINT ticket_links_type_chk
      CHECK (link_type IN ('related', 'subtask', 'approval'));
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 8. configurable workflow: states + transition matrix + seeds
-- C&I template mirrors the v5 status flow; Utility adds hq_approval.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_states (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_key TEXT NOT NULL,
  key          TEXT NOT NULL,
  name_en      TEXT NOT NULL,
  name_zh      TEXT NOT NULL,
  color_bg     TEXT NOT NULL DEFAULT '#f1f5f9',
  color_fg     TEXT NOT NULL DEFAULT '#475569',
  kind         TEXT NOT NULL DEFAULT 'normal',
  sort         INT  NOT NULL DEFAULT 0,
  UNIQUE (workflow_key, key)
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_states_key_chk') THEN
    ALTER TABLE workflow_states ADD CONSTRAINT workflow_states_key_chk
      CHECK (workflow_key IN ('ci', 'utility'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_states_kind_chk') THEN
    ALTER TABLE workflow_states ADD CONSTRAINT workflow_states_kind_chk
      CHECK (kind IN ('start', 'normal', 'end'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS workflow_transitions (
  workflow_key TEXT NOT NULL,
  from_key     TEXT NOT NULL,
  to_key       TEXT NOT NULL,
  PRIMARY KEY (workflow_key, from_key, to_key)
);

-- Seed: C&I template (v5 flow)
INSERT INTO workflow_states (workflow_key, key, name_en, name_zh, color_bg, color_fg, kind, sort) VALUES
  ('ci','open','Open','待处理','#dbeafe','#1d4ed8','start',10),
  ('ci','assigned','Assigned','已分派','#e0f2fe','#0369a1','normal',20),
  ('ci','in_progress','In progress','处理中','#fef3c7','#92400e','normal',30),
  ('ci','pending','Pending','挂起','#f3e8ff','#7e22ce','normal',40),
  ('ci','pending_customer','Pending customer','待客户确认','#ffedd5','#9a3412','normal',50),
  ('ci','resolved','Resolved','已解决','#dcfce7','#15803d','normal',60),
  ('ci','closed','Closed','已关闭','#e2e8f0','#334155','end',70)
ON CONFLICT (workflow_key, key) DO UPDATE SET
  name_en = EXCLUDED.name_en, name_zh = EXCLUDED.name_zh,
  color_bg = EXCLUDED.color_bg, color_fg = EXCLUDED.color_fg,
  kind = EXCLUDED.kind, sort = EXCLUDED.sort;

-- Seed: Utility template (adds hq_approval)
INSERT INTO workflow_states (workflow_key, key, name_en, name_zh, color_bg, color_fg, kind, sort) VALUES
  ('utility','open','Open','待处理','#dbeafe','#1d4ed8','start',10),
  ('utility','assigned','Assigned','已分派','#e0f2fe','#0369a1','normal',20),
  ('utility','in_progress','In progress','处理中','#fef3c7','#92400e','normal',30),
  ('utility','hq_approval','HQ approval','总部审批','#ede9fe','#6d28d9','normal',35),
  ('utility','pending','Pending','挂起','#f3e8ff','#7e22ce','normal',40),
  ('utility','pending_customer','Pending customer','待客户确认','#ffedd5','#9a3412','normal',50),
  ('utility','resolved','Resolved','已解决','#dcfce7','#15803d','normal',60),
  ('utility','closed','Closed','已关闭','#e2e8f0','#334155','end',70)
ON CONFLICT (workflow_key, key) DO UPDATE SET
  name_en = EXCLUDED.name_en, name_zh = EXCLUDED.name_zh,
  color_bg = EXCLUDED.color_bg, color_fg = EXCLUDED.color_fg,
  kind = EXCLUDED.kind, sort = EXCLUDED.sort;

-- Seed: C&I transitions (mirrors v5 TRANSITIONS)
INSERT INTO workflow_transitions (workflow_key, from_key, to_key) VALUES
  ('ci','open','assigned'),('ci','open','closed'),
  ('ci','assigned','in_progress'),('ci','assigned','open'),
  ('ci','in_progress','resolved'),('ci','in_progress','assigned'),
  ('ci','resolved','pending_customer'),('ci','resolved','in_progress'),('ci','resolved','closed'),
  ('ci','pending','in_progress'),('ci','pending','assigned'),
  ('ci','pending_customer','closed'),('ci','pending_customer','in_progress'),
  ('ci','closed','open')
ON CONFLICT DO NOTHING;

-- Seed: Utility transitions (adds hq_approval loop)
INSERT INTO workflow_transitions (workflow_key, from_key, to_key) VALUES
  ('utility','open','assigned'),('utility','open','closed'),
  ('utility','assigned','in_progress'),('utility','assigned','open'),
  ('utility','in_progress','resolved'),('utility','in_progress','assigned'),('utility','in_progress','hq_approval'),
  ('utility','hq_approval','in_progress'),('utility','hq_approval','resolved'),
  ('utility','resolved','pending_customer'),('utility','resolved','in_progress'),('utility','resolved','closed'),
  ('utility','pending','in_progress'),('utility','pending','assigned'),
  ('utility','pending_customer','closed'),('utility','pending_customer','in_progress'),
  ('utility','closed','open')
ON CONFLICT DO NOTHING;

-- --------------------------------------------------------------------------
-- 11. ticket_attachments — kind + meta (service report w/ signature)
-- --------------------------------------------------------------------------
ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'photo';
ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_attachments_kind_chk') THEN
    ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_kind_chk
      CHECK (kind IN ('photo', 'service_report', 'other'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_attachments_ticket_kind
  ON ticket_attachments (ticket_id, kind);

-- --------------------------------------------------------------------------
-- 14. custom_fields — 9 types, bound to trackers, simplified visibility
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_fields (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key              TEXT NOT NULL UNIQUE,
  label_en         TEXT NOT NULL,
  label_zh         TEXT NOT NULL,
  type             TEXT NOT NULL,
  options          JSONB NOT NULL DEFAULT '[]',
  trackers         TEXT[] NOT NULL DEFAULT '{}',
  required         BOOLEAN NOT NULL DEFAULT FALSE,
  visible_statuses TEXT[] NOT NULL DEFAULT '{}',
  sort             INT NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_fields_type_chk') THEN
    ALTER TABLE custom_fields ADD CONSTRAINT custom_fields_type_chk
      CHECK (type IN ('text','number','date','url','dropdown','checkbox','checklist','signature','textarea'));
  END IF;
END $$;

-- Seed: maintenance checklist + service signature (bound to maintenance tracker)
INSERT INTO custom_fields (key, label_en, label_zh, type, options, trackers, required, sort) VALUES
  ('mnt_checklist', 'Maintenance checklist', '维护检查项', 'checklist',
   '["Visual inspection","Electrical connections torque check","Thermal scan","Firmware version verified","Alarm log reviewed","Site cleaning"]',
   '{maintenance}', TRUE, 10),
  ('svc_signature', 'Customer signature', '客户签字', 'signature',
   '[]', '{support,maintenance,spare,quality}', FALSE, 90)
ON CONFLICT (key) DO UPDATE SET
  label_en = EXCLUDED.label_en, label_zh = EXCLUDED.label_zh,
  options = EXCLUDED.options, trackers = EXCLUDED.trackers;

-- --------------------------------------------------------------------------
-- RLS
-- --------------------------------------------------------------------------
ALTER TABLE workflow_states      ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_fields        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wf_read ON workflow_states;
CREATE POLICY wf_read ON workflow_states
  FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS wf_write ON workflow_states;
CREATE POLICY wf_write ON workflow_states
  FOR ALL USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
  );

DROP POLICY IF EXISTS wft_read ON workflow_transitions;
CREATE POLICY wft_read ON workflow_transitions
  FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS wft_write ON workflow_transitions;
CREATE POLICY wft_write ON workflow_transitions
  FOR ALL USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
  );

DROP POLICY IF EXISTS cf_read ON custom_fields;
CREATE POLICY cf_read ON custom_fields
  FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS cf_write ON custom_fields;
CREATE POLICY cf_write ON custom_fields
  FOR ALL USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() -> 'user_metadata' ->> 'role') IN ('admin', 'dispatcher')
  );
