-- migration_v10.sql — R4 缺陷 2：自定义 Tracker 建单被拒
-- 根因：tickets_tracker_chk 是写死的 CHECK，只允许 support/maintenance/spare/quality
-- 四个内置值，界面新建的任何 Tracker（Massimo 的 SMA、测试 Tracker）建单都被拒。
-- 改动：删掉写死 CHECK，改用触发器按 app_settings（key='trackers'）里注册的
-- Tracker 键校验。内置 4 个永远放行；已注册的键（无论是否停用，老单要保留）
-- 放行；未注册的键拒绝。
-- 执行方式：由用户在 Supabase SQL Editor 整批执行（一个事务，一次写对）。
-- 执行后验证：
--   1) 用 SMA Tracker 建一张测试单，应成功（workflow_key 按 Tracker 绑定或项目业务线回落）；
--   2) INSERT INTO tickets (tracker) VALUES ('no_such_tracker') 应报错 unknown tracker；
--   3) 现有工单不受影响（执行前已核对：无非内置 Tracker 的工单）。

ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_tracker_chk;

CREATE OR REPLACE FUNCTION public.validate_ticket_tracker()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tracker IS NULL THEN
    RETURN NEW;
  END IF;
  -- 内置 4 个永远放行（即使 app_settings 缺失也不锁死）。
  IF NEW.tracker = ANY (ARRAY['support', 'maintenance', 'spare', 'quality']) THEN
    RETURN NEW;
  END IF;
  -- 已注册的 Tracker 键放行（无论是否停用：停用后老单仍要保留其 tracker 值）。
  IF EXISTS (
    SELECT 1
    FROM public.app_settings s
    WHERE s.key = 'trackers'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(s.value) AS t
        WHERE t ->> 'key' = NEW.tracker
      )
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'unknown tracker: %', NEW.tracker;
END;
$$;

DROP TRIGGER IF EXISTS trg_tickets_tracker_chk ON public.tickets;
CREATE TRIGGER trg_tickets_tracker_chk
BEFORE INSERT OR UPDATE OF tracker ON public.tickets
FOR EACH ROW EXECUTE FUNCTION public.validate_ticket_tracker();

NOTIFY pgrst, 'reload schema';
