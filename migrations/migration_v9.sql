-- =====================================================================
-- BESS Ticketing Platform — migration v9 (feedback #25, 2026-10-23)
-- Per-project tracker availability.
--
-- A project with NO rows in project_trackers offers every active
-- tracker (the pre-v9 behavior). Rows restrict the new-ticket tracker
-- dropdown for that project. The mapping is configured on the
-- project's Settings tab (tracker.manage = admin / dispatcher).
-- =====================================================================

CREATE TABLE IF NOT EXISTS project_trackers (
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  tracker_key text NOT NULL,
  PRIMARY KEY (site_id, tracker_key)
);

ALTER TABLE project_trackers ENABLE ROW LEVEL SECURITY;

-- Any signed-in user may read the mapping (the new-ticket form needs
-- it, including customer accounts creating tickets for their project).
DROP POLICY IF EXISTS pt_read ON project_trackers;
CREATE POLICY pt_read ON project_trackers
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- Writes follow the platform role in the JWT user_metadata.
DROP POLICY IF EXISTS pt_write ON project_trackers;
CREATE POLICY pt_write ON project_trackers
  FOR ALL
  USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() -> 'user_metadata' ->> 'role') IN ('admin', 'dispatcher')
  )
  WITH CHECK (
    auth.role() = 'authenticated'
    AND (auth.jwt() -> 'user_metadata' ->> 'role') IN ('admin', 'dispatcher')
  );

NOTIFY pgrst, 'reload schema';
