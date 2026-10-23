-- =====================================================================
-- BESS Ticketing Platform — migration v8.1
-- Open tracker creation to dispatchers (2026-10-23 decision): the
-- frontend permission tracker.manage now includes 'dispatcher'; the
-- app_settings write policy must accept the 'trackers' key from
-- dispatchers too, or their saves are rejected by RLS.
-- Run AFTER migration_v8.sql. Idempotent.
-- =====================================================================

DROP POLICY IF EXISTS settings_write ON app_settings;
CREATE POLICY settings_write ON app_settings
  FOR ALL
  USING (
    auth.role() = 'authenticated'
    AND ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
      OR ((auth.jwt() -> 'user_metadata' ->> 'role') = 'dispatcher'
          AND key IN ('dict_segments', 'dict_sources', 'trackers')))
  )
  WITH CHECK (
    auth.role() = 'authenticated'
    AND ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
      OR ((auth.jwt() -> 'user_metadata' ->> 'role') = 'dispatcher'
          AND key IN ('dict_segments', 'dict_sources', 'trackers')))
  );
