/* ============================================================================
 * migration_v6_2.sql — BESS ticketing platform v6.2: email notifications
 * (item 15 — SENDING only; inbound auto-ticketing stays out of scope).
 *
 * Run manually in the Supabase dashboard SQL editor (project
 * qewxlbfmoumodkncrvny, Frankfurt), AFTER migration_v6 and migration_v6_1.
 * All statements are idempotent (IF NOT EXISTS / guarded / ON CONFLICT)
 * so re-running is safe.
 *
 * Covers:
 *  1. app_settings — tiny key/value store (customer-mail global switch,
 *     email master kill switch)
 *  2. email_templates — key/lang/subject/body_html, seeded EN+ZH for the
 *     6 notification events (template variables are {{name}} placeholders)
 *  3. email_log — per-recipient send log written by the send-email
 *     Edge Function
 *  4. notification_preferences — per-user per-event opt-out
 * ========================================================================== */

-- --------------------------------------------------------------------------
-- 1. app_settings — tiny key/value store
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_app_settings_updated ON app_settings;
CREATE TRIGGER trg_app_settings_updated
  BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO app_settings (key, value)
VALUES
  ('customer_email_notifications', 'false'),  -- admin switch: mail customer-ROLE users
  ('email_enabled', 'true')                   -- master kill switch for notifications
ON CONFLICT (key) DO NOTHING;

-- --------------------------------------------------------------------------
-- 2. email_templates — key/lang/subject/body_html
--    Variables: {{ticket_no}} {{ticket_title}} {{site_name}} {{actor_name}}
--    {{status}} {{priority}} {{comment}} {{sla_deadline}} {{app_url}}
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key        TEXT NOT NULL,                       -- EMAIL_EVENTS keys
  lang       TEXT NOT NULL DEFAULT 'en',           -- 'en' | 'zh'
  subject    TEXT NOT NULL,
  body_html  TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key, lang)
);

DROP TRIGGER IF EXISTS trg_email_templates_updated ON email_templates;
CREATE TRIGGER trg_email_templates_updated
  BEFORE UPDATE ON email_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/* Seed templates: insert, update if the key/lang pair already exists. */
INSERT INTO email_templates (key, lang, subject, body_html) VALUES
-- ticket_created -----------------------------------------------------------
('ticket_created', 'en',
 '[{{ticket_no}}] New ticket: {{ticket_title}}',
 '<p>Hello,</p>' ||
 '<p>A new ticket <b>{{ticket_no}}</b> has been created by {{actor_name}}.</p>' ||
 '<ul><li>Site: {{site_name}}</li><li>Priority: {{priority}}</li></ul>' ||
 '<p><b>{{ticket_title}}</b></p>' ||
 '<p><a href="{{app_url}}">Open the ticket</a></p>' ||
 '<p style="color:#888;font-size:12px">This is an automated message from the LONGi BESS Service Desk.</p>'),
('ticket_created', 'zh',
 '[{{ticket_no}}] 新工单：{{ticket_title}}',
 '<p>您好，</p>' ||
 '<p>{{actor_name}} 新建了一张工单 <b>{{ticket_no}}</b>。</p>' ||
 '<ul><li>电站：{{site_name}}</li><li>优先级：{{priority}}</li></ul>' ||
 '<p><b>{{ticket_title}}</b></p>' ||
 '<p><a href="{{app_url}}">查看工单</a></p>' ||
 '<p style="color:#888;font-size:12px">本邮件由 LONGi BESS 售后服务工单平台自动发送。</p>'),
-- ticket_assigned ----------------------------------------------------------
('ticket_assigned', 'en',
 '[{{ticket_no}}] Assigned to you: {{ticket_title}}',
 '<p>Hello,</p>' ||
 '<p>Ticket <b>{{ticket_no}}</b> has been assigned by {{actor_name}}.</p>' ||
 '<p><b>{{ticket_title}}</b><br>Site: {{site_name}}</p>' ||
 '<p><a href="{{app_url}}">Open the ticket</a></p>' ||
 '<p style="color:#888;font-size:12px">This is an automated message from the LONGi BESS Service Desk.</p>'),
('ticket_assigned', 'zh',
 '[{{ticket_no}}] 已指派给您：{{ticket_title}}',
 '<p>您好，</p>' ||
 '<p>{{actor_name}} 将工单 <b>{{ticket_no}}</b> 指派给了您。</p>' ||
 '<p><b>{{ticket_title}}</b><br>电站：{{site_name}}</p>' ||
 '<p><a href="{{app_url}}">查看工单</a></p>' ||
 '<p style="color:#888;font-size:12px">本邮件由 LONGi BESS 售后服务工单平台自动发送。</p>'),
-- status_changed -----------------------------------------------------------
('status_changed', 'en',
 '[{{ticket_no}}] Status changed: {{status}}',
 '<p>Hello,</p>' ||
 '<p>Ticket <b>{{ticket_no}}</b> changed status to <b>{{status}}</b> (by {{actor_name}}).</p>' ||
 '<p><b>{{ticket_title}}</b></p>' ||
 '<p><a href="{{app_url}}">Open the ticket</a></p>' ||
 '<p style="color:#888;font-size:12px">This is an automated message from the LONGi BESS Service Desk.</p>'),
('status_changed', 'zh',
 '[{{ticket_no}}] 状态变更：{{status}}',
 '<p>您好，</p>' ||
 '<p>工单 <b>{{ticket_no}}</b> 状态变更为 <b>{{status}}</b>（操作人：{{actor_name}}）。</p>' ||
 '<p><b>{{ticket_title}}</b></p>' ||
 '<p><a href="{{app_url}}">查看工单</a></p>' ||
 '<p style="color:#888;font-size:12px">本邮件由 LONGi BESS 售后服务工单平台自动发送。</p>'),
-- comment_added ------------------------------------------------------------
('comment_added', 'en',
 '[{{ticket_no}}] New comment on {{ticket_title}}',
 '<p>Hello,</p>' ||
 '<p>{{actor_name}} commented on ticket <b>{{ticket_no}}</b>:</p>' ||
 '<blockquote style="border-left:3px solid #0a7;padding-left:8px">{{comment}}</blockquote>' ||
 '<p><a href="{{app_url}}">Open the ticket</a></p>' ||
 '<p style="color:#888;font-size:12px">This is an automated message from the LONGi BESS Service Desk.</p>'),
('comment_added', 'zh',
 '[{{ticket_no}}] 工单新评论：{{ticket_title}}',
 '<p>您好，</p>' ||
 '<p>{{actor_name}} 在工单 <b>{{ticket_no}}</b> 中发表了评论：</p>' ||
 '<blockquote style="border-left:3px solid #0a7;padding-left:8px">{{comment}}</blockquote>' ||
 '<p><a href="{{app_url}}">查看工单</a></p>' ||
 '<p style="color:#888;font-size:12px">本邮件由 LONGi BESS 售后服务工单平台自动发送。</p>'),
-- sla_warning --------------------------------------------------------------
('sla_warning', 'en',
 '[{{ticket_no}}] SLA warning: {{sla_deadline}}',
 '<p>Hello,</p>' ||
 '<p>Ticket <b>{{ticket_no}}</b> ({{site_name}}) is approaching its SLA deadline:</p>' ||
 '<p><b>{{ticket_title}}</b><br>Deadline: {{sla_deadline}}</p>' ||
 '<p><a href="{{app_url}}">Open the ticket</a></p>' ||
 '<p style="color:#888;font-size:12px">This is an automated message from the LONGi BESS Service Desk.</p>'),
('sla_warning', 'zh',
 '[{{ticket_no}}] SLA 预警：{{sla_deadline}}',
 '<p>您好，</p>' ||
 '<p>工单 <b>{{ticket_no}}</b>（{{site_name}}）即将超过 SLA 时限：</p>' ||
 '<p><b>{{ticket_title}}</b><br>截止时间：{{sla_deadline}}</p>' ||
 '<p><a href="{{app_url}}">查看工单</a></p>' ||
 '<p style="color:#888;font-size:12px">本邮件由 LONGi BESS 售后服务工单平台自动发送。</p>'),
-- sla_breach ----------------------------------------------------------------
('sla_breach', 'en',
 '[{{ticket_no}}] SLA BREACHED: {{ticket_title}}',
 '<p>Hello,</p>' ||
 '<p><b style="color:#c00">Ticket {{ticket_no}} ({{site_name}}) has breached its SLA.</b></p>' ||
 '<p><b>{{ticket_title}}</b><br>Reported by: {{actor_name}}</p>' ||
 '<p><a href="{{app_url}}">Open the ticket</a></p>' ||
 '<p style="color:#888;font-size:12px">This is an automated message from the LONGi BESS Service Desk.</p>'),
('sla_breach', 'zh',
 '[{{ticket_no}}] SLA 逾期：{{ticket_title}}',
 '<p>您好，</p>' ||
 '<p><b style="color:#c00">工单 {{ticket_no}}（{{site_name}}）已超过 SLA 时限。</b></p>' ||
 '<p><b>{{ticket_title}}</b><br>处理人：{{actor_name}}</p>' ||
 '<p><a href="{{app_url}}">查看工单</a></p>' ||
 '<p style="color:#888;font-size:12px">本邮件由 LONGi BESS 售后服务工单平台自动发送。</p>')
ON CONFLICT (key, lang) DO UPDATE
  SET subject = EXCLUDED.subject,
      body_html = EXCLUDED.body_html,
      updated_at = now();

-- --------------------------------------------------------------------------
-- 3. email_log — per-recipient send log (written by the Edge Function)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  UUID,                                  -- FK intentionally omitted
  event_key  TEXT,
  recipient  TEXT NOT NULL,
  subject    TEXT,
  status     TEXT NOT NULL DEFAULT 'sent'
             CHECK (status IN ('sent', 'failed')),
  error      TEXT,
  created_by UUID,                                  -- auth user who triggered
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_log_ticket  ON email_log (ticket_id);
CREATE INDEX IF NOT EXISTS idx_email_log_sent    ON email_log (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_log_status  ON email_log (status);

-- --------------------------------------------------------------------------
-- 4. notification_preferences — per-user per-event opt-out
--    (absent row = enabled, same as the app-side default)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id   UUID NOT NULL,
  event_key TEXT NOT NULL,
  enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_notif_prefs_user ON notification_preferences (user_id);

-- --------------------------------------------------------------------------
-- RLS — same pattern as v6/v6_1/v7 (authenticated read, admin write;
-- NOTE: verify against the existing policies in the dashboard).
-- --------------------------------------------------------------------------
ALTER TABLE app_settings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_templates          ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_log                ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

-- app_settings
DROP POLICY IF EXISTS settings_read ON app_settings;
CREATE POLICY settings_read ON app_settings
  FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS settings_write ON app_settings;
CREATE POLICY settings_write ON app_settings
  FOR ALL USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
  );

-- email_templates
DROP POLICY IF EXISTS et_read ON email_templates;
CREATE POLICY et_read ON email_templates
  FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS et_write ON email_templates;
CREATE POLICY et_write ON email_templates
  FOR ALL USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
  );

-- email_log: inserts by any authenticated caller (the Edge Function runs
-- with the caller's JWT); reads restricted to admin/dispatcher.
DROP POLICY IF EXISTS elog_insert ON email_log;
CREATE POLICY elog_insert ON email_log
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');
DROP POLICY IF EXISTS elog_read ON email_log;
CREATE POLICY elog_read ON email_log
  FOR SELECT USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() -> 'user_metadata' ->> 'role') IN ('admin', 'dispatcher')
  );

-- notification_preferences: users manage their own rows; admins read all.
DROP POLICY IF EXISTS np_read ON notification_preferences;
CREATE POLICY np_read ON notification_preferences
  FOR SELECT USING (
    auth.role() = 'authenticated'
    AND (auth.uid() = user_id
         OR (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin')
  );
DROP POLICY IF EXISTS np_write ON notification_preferences;
CREATE POLICY np_write ON notification_preferences
  FOR ALL USING (
    auth.role() = 'authenticated'
    AND (auth.uid() = user_id
         OR (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin')
  );
