/* ============================================================================
 * seed_test_data.sql — TEST DATA ONLY (run in Supabase SQL Editor)
 *
 * Creates:
 *   - 10 test sites      (codes TEST-*, fixed UUIDs 10000000-...)
 *   - 10 LTSA contracts  (one per test site, varied SLA hours)
 *   - 10 test engineers  (login accounts, fixed UUIDs 20000000-...)
 *       emails:    test.eng01@bess-test.example.com ... test.eng10@...
 *       password:  Test@2026!   (same for all — test only, delete after use)
 *       role:      engineer, project_scope empty = sees ALL sites (easy testing)
 * Idempotent: re-running skips what already exists.
 * Cleanup block is at the bottom (commented out — run it when done testing).
 * ========================================================================== */

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- --------------------------------------------------------------------------
-- 1. test sites
-- --------------------------------------------------------------------------
INSERT INTO sites (id, code, name, country, city, address, latitude, longitude,
                   parent_site_id, segment, workflow_mode, status, description)
VALUES
 ('10000000-0000-4000-8000-000000000001','TEST-IT-01','Montalto Test Plant','IT','Montalto di Castro','SS Castrense km 1',42.37994,11.55256,NULL,'utility','default','active','TEST site - utility, parent of TEST-IT-02'),
 ('10000000-0000-4000-8000-000000000002','TEST-IT-02','Rome C&I Test','IT','Rome','Via Appia 100',41.90280,12.49640,'10000000-0000-4000-8000-000000000001','ci','inherit','active','TEST site - inherits workflow from TEST-IT-01'),
 ('10000000-0000-4000-8000-000000000003','TEST-DE-01','Berlin C&I Test','DE','Berlin','Warschauer Str. 1',52.52000,13.40500,NULL,'ci','default','active','TEST site'),
 ('10000000-0000-4000-8000-000000000004','TEST-DE-02','Munich Utility Test','DE','Munich','Leopoldstr. 5',48.13715,11.57612,NULL,'utility','default','active','TEST site'),
 ('10000000-0000-4000-8000-000000000005','TEST-ES-01','Madrid Test','ES','Madrid','Gran Via 20',40.41680,-3.70380,NULL,'ci','default','active','TEST site'),
 ('10000000-0000-4000-8000-000000000006','TEST-FR-01','Lyon Utility Test','FR','Lyon','Rue de la Republique 3',45.76404,4.83566,NULL,'utility','default','active','TEST site'),
 ('10000000-0000-4000-8000-000000000007','TEST-NL-01','Rotterdam Test','NL','Rotterdam','Coolsingel 8',51.92442,4.47773,NULL,'ci','default','active','TEST site'),
 ('10000000-0000-4000-8000-000000000008','TEST-PL-01','Warsaw Utility Test','PL','Warsaw','Marszalkowska 10',52.22968,21.01223,NULL,'utility','default','paused','TEST site - paused status'),
 ('10000000-0000-4000-8000-000000000009','TEST-IT-03','Sicily Test','IT','Catania','Via Etnea 15',37.50210,15.08720,NULL,'ci','default','active','TEST site'),
 ('10000000-0000-4000-8000-00000000000a','TEST-GB-01','London Test','GB','London','Baker Street 221',51.52370,-0.15850,NULL,'ci','default','active','TEST site')
ON CONFLICT (code) DO NOTHING;

-- --------------------------------------------------------------------------
-- 2. LTSA contracts for the test sites (PK = site_id)
-- --------------------------------------------------------------------------
INSERT INTO ltsa_contracts (site_id, response_hours, onsite_hours, resolve_hours,
                            availability_pct, coverage, phone_enabled, onsite_enabled,
                            support_24_7, valid_from, valid_to)
VALUES
 ('10000000-0000-4000-8000-000000000001', 4, 48, 120, 98, '24/7',  TRUE, TRUE, TRUE,  '2026-01-01', '2030-12-31'),
 ('10000000-0000-4000-8000-000000000002', 2, 24,  72, 97, '24/7',  TRUE, TRUE, TRUE,  '2026-01-01', '2030-12-31'),
 ('10000000-0000-4000-8000-000000000003', 8, 48, 168, 96, 'business', TRUE, TRUE, FALSE, '2026-01-01', '2030-12-31'),
 ('10000000-0000-4000-8000-000000000004', 4, 24,  96, 98, '24/7',  TRUE, TRUE, TRUE,  '2026-01-01', '2030-12-31'),
 ('10000000-0000-4000-8000-000000000005', 8, 72, 240, 95, 'business', TRUE, TRUE, FALSE, '2026-01-01', '2030-12-31'),
 ('10000000-0000-4000-8000-000000000006', 4, 48, 120, 97, '24/7',  TRUE, TRUE, TRUE,  '2026-01-01', '2030-12-31'),
 ('10000000-0000-4000-8000-000000000007', 2, 24,  48, 98, '24/7',  TRUE, TRUE, TRUE,  '2026-01-01', '2030-12-31'),
 ('10000000-0000-4000-8000-000000000008', 4, 48, 120, 96, 'business', TRUE, TRUE, FALSE, '2026-01-01', '2030-12-31'),
 ('10000000-0000-4000-8000-000000000009', 8, 48, 168, 96, 'business', TRUE, TRUE, FALSE, '2026-01-01', '2030-12-31'),
 ('10000000-0000-4000-8000-00000000000a', 4, 24,  96, 97, '24/7',  TRUE, TRUE, TRUE,  '2026-01-01', '2030-12-31')
ON CONFLICT (site_id) DO NOTHING;

-- --------------------------------------------------------------------------
-- 3. test engineers (auth users + identities + profiles)
-- --------------------------------------------------------------------------
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('20000000-0000-4000-8000-000000000001','test.eng01@bess-test.example.com','Test Engineer 01','IT','BESS O&M, PCS','professional'),
      ('20000000-0000-4000-8000-000000000002','test.eng02@bess-test.example.com','Test Engineer 02','IT','Field service, Battery','associate'),
      ('20000000-0000-4000-8000-000000000003','test.eng03@bess-test.example.com','Test Engineer 03','DE','BESS O&M','associate'),
      ('20000000-0000-4000-8000-000000000004','test.eng04@bess-test.example.com','Test Engineer 04','DE','HV, Switchgear','professional'),
      ('20000000-0000-4000-8000-000000000005','test.eng05@bess-test.example.com','Test Engineer 05','ES','Field service','associate'),
      ('20000000-0000-4000-8000-000000000006','test.eng06@bess-test.example.com','Test Engineer 06','FR','BESS O&M, EMS','associate'),
      ('20000000-0000-4000-8000-000000000007','test.eng07@bess-test.example.com','Test Engineer 07','NL','Commissioning','associate'),
      ('20000000-0000-4000-8000-000000000008','test.eng08@bess-test.example.com','Test Engineer 08','PL','Field service, HVAC','associate'),
      ('20000000-0000-4000-8000-000000000009','test.eng09@bess-test.example.com','Test Engineer 09','IT','Remote support, SCADA','professional'),
      ('20000000-0000-4000-8000-00000000000a','test.eng10@bess-test.example.com','Test Engineer 10','GB','BESS O&M','associate')
    ) AS t(uid, email, dname, country, skills, cert)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = rec.email) THEN
      INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
                              email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                              created_at, updated_at)
      VALUES ('00000000-0000-0000-0000-000000000000', rec.uid::uuid, 'authenticated',
              'authenticated', rec.email, crypt('Test@2026!', gen_salt('bf')),
              now(),
              '{"provider":"email","providers":["email"]}'::jsonb,
              jsonb_build_object('role', 'engineer',
                                 'display_name', rec.dname,
                                 'language', 'en'),
              now(), now());

      INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider,
                                   last_sign_in_at, created_at, updated_at)
      VALUES (rec.uid::uuid, rec.uid::uuid, rec.email,
              jsonb_build_object('sub', rec.uid, 'email', rec.email,
                                 'email_verified', true),
              'email', now(), now(), now());
    END IF;

    INSERT INTO profiles (id, email, display_name, role, country, skills,
                          cert_level, language, is_active)
    VALUES (rec.uid::uuid, rec.email, rec.dname, 'engineer', rec.country,
            rec.skills, rec.cert, 'en', TRUE)
    ON CONFLICT (id) DO UPDATE
      SET role = 'engineer', display_name = EXCLUDED.display_name,
          country = EXCLUDED.country, skills = EXCLUDED.skills,
          cert_level = EXCLUDED.cert_level, is_active = TRUE;
  END LOOP;

  RAISE NOTICE 'test seed done: 10 sites / 10 contracts / 10 engineers';
END $$;

/* ============================================================================
 * CLEANUP — when testing is over, run this block to remove ALL test data.
 * (Delete test tickets first if you created any on the test sites.)
 * ==========================================================================
DELETE FROM tickets            WHERE site_id IN (SELECT id FROM sites WHERE code LIKE 'TEST-%');
DELETE FROM ltsa_contracts     WHERE site_id IN (SELECT id FROM sites WHERE code LIKE 'TEST-%');
DELETE FROM contact_projects   WHERE site_id IN (SELECT id FROM sites WHERE code LIKE 'TEST-%');
DELETE FROM sites              WHERE code LIKE 'TEST-%';
DELETE FROM profiles           WHERE email LIKE 'test.eng%@bess-test.example.com';
DELETE FROM auth.identities    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE 'test.eng%@bess-test.example.com');
DELETE FROM auth.users         WHERE email LIKE 'test.eng%@bess-test.example.com';
 * ========================================================================== */
