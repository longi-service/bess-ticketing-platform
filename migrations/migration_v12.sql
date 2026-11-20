-- migration_v12.sql — M9-06：备件审批子单 + 暂扣模型
-- 根因：R4 缺陷 10 — 领用备件后不自动派生审批子单；现行 issue_spare_part
-- 领用时直接扣库存，审批是事后行为，账实之间没有“已领未审”的中间态。
-- 改动：
--   1) stock_levels 加 reserved_qty（暂扣量，默认 0）：领用时暂扣，可用量 =
--      qty - reserved_qty；审批通过后实扣；驳回/取消/退回时释放。
--   2) part_transactions 加 reservation_status（reserved/finalized/released/
--      returned，NULL = 旧数据/非暂扣行）：领用行在暂扣期间为 reserved。
--   3) tickets 加 source_transaction_id（指向派生来源的 part_transactions.id）
--      + 部分唯一索引：同一笔领用只派生一张审批子单。
--   4) issue_spare_part 改为暂扣语义：校验可用量，reserved_qty 增加、qty 不变。
--   5) 新增 finalize_part_reservation（审批通过实扣，幂等）与
--      release_part_reservation（驳回/取消释放，幂等）。
--   6) return_spare_part 适配：暂扣中的领用退回时释放暂扣（qty 不变）；
--      已实扣/旧数据的领用退回时恢复 qty（原行为）。
-- 历史数据：已领用的库存已实扣，reserved_qty 从 0 起，不做历史数据迁移。
-- 注意：v11 调拨 RPC 校验的是在手库存 qty（不含暂扣）；v12 上线后，调拨仍
-- 可能把已暂扣的备件调走，此时审批实扣会以明确的“Insufficient on-hand
-- stock”报错并保持暂扣（不静默错账），调拨侧后续应改为校验可用量。
-- 执行方式：由用户在 Supabase SQL Editor 整批执行（一个事务，一次写对）。
-- 执行后验证：
--   1) SELECT reserved_qty FROM stock_levels LIMIT 1; 应有列且全为 0；
--   2) SELECT source_transaction_id FROM tickets LIMIT 1; 应有列且全为 NULL；
--   3) 领用 1 件（SP-0002，MTL-WH01 现有 8 件）：qty 仍为 8，reserved_qty 变为 1，
--      part_transactions 新增一行 qty_delta=-1、reservation_status='reserved'；
--   4) finalize_part_reservation(<上步 txn id>)：qty 变为 7，reserved_qty 变为 0，
--      状态变为 'finalized'；再调一次应无变化（幂等）；
--   5) 另领 1 件后 release_part_reservation(<txn id>)：qty 仍为 7，reserved_qty
--      变为 0，状态变为 'released'；
--   6) 前端领用后应自动生成审批子单（tracker=spare、workflow_key=utility）。

-- 1. 暂扣量列
ALTER TABLE public.stock_levels
  ADD COLUMN IF NOT EXISTS reserved_qty numeric NOT NULL DEFAULT 0
  CHECK (reserved_qty >= 0);

-- 2. 暂扣状态列（NULL = 旧数据或非暂扣行）
ALTER TABLE public.part_transactions
  ADD COLUMN IF NOT EXISTS reservation_status text
  CHECK (reservation_status IS NULL
      OR reservation_status IN ('reserved', 'finalized', 'released', 'returned'));

-- 3. 审批子单溯源列 + 防重（同一笔领用只派生一张子单）
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS source_transaction_id uuid
  REFERENCES public.part_transactions(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tickets_source_transaction_id_uidx
  ON public.tickets (source_transaction_id)
  WHERE source_transaction_id IS NOT NULL;

-- 4. issue_spare_part：暂扣语义（校验可用量；reserved_qty 增加，qty 不变）
CREATE OR REPLACE FUNCTION public.issue_spare_part(p_ticket_id uuid, p_part_id uuid, p_qty numeric, p_warehouse_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor    uuid := auth.uid();
  v_site     uuid;
  v_wh       uuid;
  v_wh_site  uuid;
  v_qty      numeric;
  v_reserved numeric;
  v_txn_id   uuid;
BEGIN
  -- 1. Quantity must be a positive number.
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'Quantity must be a positive number';
  END IF;

  -- 2. Caller must be signed in.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 3. Caller must see the ticket (active user + v1 visibility rule).
  --    A missing ticket is not visible, so this also rejects bad ids.
  IF NOT public.ticket_visible(p_ticket_id) THEN
    RAISE EXCEPTION 'Ticket not visible or not found';
  END IF;

  SELECT site_id INTO v_site FROM public.tickets WHERE id = p_ticket_id;

  -- 4. Resolve the warehouse. An explicit id must belong to the ticket's
  --    site; otherwise fall back to the site's first warehouse.
  IF p_warehouse_id IS NOT NULL THEN
    SELECT site_id INTO v_wh_site FROM public.warehouses WHERE id = p_warehouse_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Warehouse not found';
    END IF;
    IF v_wh_site IS DISTINCT FROM v_site THEN
      RAISE EXCEPTION 'Warehouse is not linked to this ticket''s site';
    END IF;
    v_wh := p_warehouse_id;
  ELSE
    SELECT id INTO v_wh
      FROM public.warehouses
     WHERE site_id = v_site
     ORDER BY created_at, id
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No warehouse linked to this ticket''s site';
    END IF;
  END IF;

  -- 5. Lock the stock row; a missing row counts as 0 available.
  --    v12 (M9-06): available = on hand - reserved, not on hand alone.
  SELECT qty, reserved_qty INTO v_qty, v_reserved
    FROM public.stock_levels
   WHERE warehouse_id = v_wh AND part_id = p_part_id
   FOR UPDATE;
  IF NOT FOUND THEN
    v_qty := 0;
    v_reserved := 0;
  END IF;
  IF (v_qty - v_reserved) < p_qty THEN
    RAISE EXCEPTION 'Insufficient stock: have %, need %', (v_qty - v_reserved), p_qty;
  END IF;

  -- 6. Reserve + ledger row, atomically (any failure rolls back).
  --    v12 (M9-06): qty is untouched until the approval finalizes it.
  UPDATE public.stock_levels
     SET reserved_qty = reserved_qty + p_qty
   WHERE warehouse_id = v_wh AND part_id = p_part_id;

  INSERT INTO public.part_transactions
    (warehouse_id, part_id, qty_delta, ticket_id, actor_id, reservation_status)
  VALUES (v_wh, p_part_id, -p_qty, p_ticket_id, v_actor, 'reserved')
  RETURNING id INTO v_txn_id;

  RETURN v_txn_id;
END;
$function$;

-- 5a. finalize_part_reservation：审批通过 → 实扣（幂等）。
--   'reserved' → qty 与 reserved_qty 各减 n；'released'（驳回后重开又批准）
--   → 只减 qty（暂扣已在驳回时释放），可用量不足时报错；'finalized' /
--   旧数据（NULL）→ 无操作；'returned'（备件已退回）→ 报错，审批子单应
--   改走驳回而不是批准。
CREATE OR REPLACE FUNCTION public.finalize_part_reservation(p_transaction_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor    uuid := auth.uid();
  v_txn      public.part_transactions%ROWTYPE;
  v_qty      numeric;
  v_reserved numeric;
  v_n        numeric;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_txn
    FROM public.part_transactions
   WHERE id = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;

  IF v_txn.qty_delta >= 0 THEN
    RAISE EXCEPTION 'Only issue transactions (negative qty_delta) can be finalized';
  END IF;

  -- Idempotent: already finalized, or a pre-v12 issue (already deducted).
  IF v_txn.reservation_status = 'finalized' OR v_txn.reservation_status IS NULL THEN
    RETURN p_transaction_id;
  END IF;

  IF v_txn.reservation_status = 'returned' THEN
    RAISE EXCEPTION 'Part was already returned; the issue cannot be finalized';
  END IF;

  IF v_txn.ticket_id IS NOT NULL
     AND NOT public.ticket_visible(v_txn.ticket_id) THEN
    RAISE EXCEPTION 'Ticket not visible or not found';
  END IF;

  v_n := -v_txn.qty_delta;

  SELECT qty, reserved_qty INTO v_qty, v_reserved
    FROM public.stock_levels
   WHERE warehouse_id = v_txn.warehouse_id AND part_id = v_txn.part_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stock row not found';
  END IF;

  IF v_txn.reservation_status = 'reserved' THEN
    IF v_qty < v_n THEN
      RAISE EXCEPTION 'Insufficient on-hand stock to finalize: have %, need %', v_qty, v_n;
    END IF;
    UPDATE public.stock_levels
       SET qty = qty - v_n, reserved_qty = reserved_qty - v_n
     WHERE warehouse_id = v_txn.warehouse_id AND part_id = v_txn.part_id;
  ELSIF v_txn.reservation_status = 'released' THEN
    -- Re-approved after a rejection: the hold was already released, so
    -- only deduct on hand, and only when enough is still available.
    IF (v_qty - v_reserved) < v_n THEN
      RAISE EXCEPTION 'Insufficient stock: have %, need %', (v_qty - v_reserved), v_n;
    END IF;
    UPDATE public.stock_levels
       SET qty = qty - v_n
     WHERE warehouse_id = v_txn.warehouse_id AND part_id = v_txn.part_id;
  END IF;

  UPDATE public.part_transactions
     SET reservation_status = 'finalized'
   WHERE id = p_transaction_id;

  RETURN p_transaction_id;
END;
$function$;

-- 5b. release_part_reservation：驳回/取消 → 释放暂扣（幂等）。
--   'reserved' → reserved_qty 减 n；其余状态（已实扣/已释放/已退回/
--   旧数据）→ 无操作：已实扣的驳回不影响库存（见设计文档 §6.6）。
CREATE OR REPLACE FUNCTION public.release_part_reservation(p_transaction_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_txn   public.part_transactions%ROWTYPE;
  v_n     numeric;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_txn
    FROM public.part_transactions
   WHERE id = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;

  IF v_txn.qty_delta >= 0 THEN
    RAISE EXCEPTION 'Only issue transactions (negative qty_delta) can be released';
  END IF;

  IF v_txn.reservation_status <> 'reserved' THEN
    -- Already finalized / released / returned, or a pre-v12 issue:
    -- nothing to release.
    RETURN p_transaction_id;
  END IF;

  IF v_txn.ticket_id IS NOT NULL
     AND NOT public.ticket_visible(v_txn.ticket_id) THEN
    RAISE EXCEPTION 'Ticket not visible or not found';
  END IF;

  v_n := -v_txn.qty_delta;

  UPDATE public.stock_levels
     SET reserved_qty = reserved_qty - v_n
   WHERE warehouse_id = v_txn.warehouse_id AND part_id = v_txn.part_id;

  UPDATE public.part_transactions
     SET reservation_status = 'released'
   WHERE id = p_transaction_id;

  RETURN p_transaction_id;
END;
$function$;

-- 6. return_spare_part：适配暂扣模型。
--   'reserved' → 释放暂扣（qty 不变），状态记为 'returned'；
--   'released' → 驳回时已恢复库存，再退回属重复，报错；
--   'returned' → 已退回过，报错；'finalized' / 旧数据（NULL）→ 原行为（qty 恢复）。
CREATE OR REPLACE FUNCTION public.return_spare_part(p_transaction_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor    uuid := auth.uid();
  v_old      public.part_transactions%ROWTYPE;
  v_new_id   uuid;
  v_reserved numeric;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_old
    FROM public.part_transactions
   WHERE id = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;

  IF v_old.qty_delta >= 0 THEN
    RAISE EXCEPTION 'Only issue transactions (negative qty_delta) can be returned';
  END IF;

  IF v_old.ticket_id IS NOT NULL
     AND NOT public.ticket_visible(v_old.ticket_id) THEN
    RAISE EXCEPTION 'Ticket not visible or not found';
  END IF;

  IF v_old.reservation_status = 'released' THEN
    RAISE EXCEPTION 'Issue was already released when its approval was rejected; stock was restored then';
  END IF;

  IF v_old.reservation_status = 'returned' THEN
    RAISE EXCEPTION 'Issue was already returned';
  END IF;

  IF v_old.reservation_status = 'reserved' THEN
    -- Only reserved: release the hold (on-hand qty untouched).
    SELECT reserved_qty INTO v_reserved
      FROM public.stock_levels
     WHERE warehouse_id = v_old.warehouse_id AND part_id = v_old.part_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Stock row not found';
    END IF;
    UPDATE public.stock_levels
       SET reserved_qty = reserved_qty - (-v_old.qty_delta)
     WHERE warehouse_id = v_old.warehouse_id AND part_id = v_old.part_id;
    UPDATE public.part_transactions
       SET reservation_status = 'returned'
     WHERE id = p_transaction_id;
  ELSE
    -- Finalized or pre-v12 issue: restore on-hand stock (original behavior).
    INSERT INTO public.stock_levels (warehouse_id, part_id, qty)
    VALUES (v_old.warehouse_id, v_old.part_id, -v_old.qty_delta)
    ON CONFLICT (warehouse_id, part_id)
    DO UPDATE SET qty = public.stock_levels.qty + EXCLUDED.qty;
  END IF;

  INSERT INTO public.part_transactions
    (warehouse_id, part_id, qty_delta, ticket_id, actor_id, note)
  VALUES (v_old.warehouse_id, v_old.part_id, -v_old.qty_delta,
          v_old.ticket_id, v_actor, 'return of ' || p_transaction_id::text)
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$function$;

-- 8. 调拨审批改为校验可用量（v11/v12 衔接修补）
-- v11 的 approve_transfer 只校验在手库存 qty；v12 加了 reserved_qty 后，
-- 若不改，调拨会把已暂扣的备件调走，随后审批实扣以 'Insufficient on-hand
-- stock' 报错（不静默错账，但单子会卡住）。v11 单独执行时无暂扣、校验 qty
-- 是对的；v12 执行后改为校验可用量 qty - reserved_qty，只调未暂扣的部分。
CREATE OR REPLACE FUNCTION public.approve_transfer(p_transfer_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_tr public.transfers%ROWTYPE;
  v_stock numeric;
  v_to_code text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.requester_is_active() THEN
    RAISE EXCEPTION 'Account is not active';
  END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF COALESCE(v_role, '') NOT IN ('admin', 'dispatcher') THEN
    RAISE EXCEPTION 'Only a dispatcher or admin can approve a transfer';
  END IF;
  SELECT * INTO v_tr FROM public.transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer not found';
  END IF;
  IF v_tr.status <> 'pending' THEN
    RAISE EXCEPTION 'Transfer is not awaiting approval (status: %)', v_tr.status;
  END IF;
  -- Lock the source stock row; a missing row counts as 0.
  -- Available stock = on-hand minus reserved (v12): never move reserved parts.
  SELECT qty - COALESCE(reserved_qty, 0) INTO v_stock FROM public.stock_levels
   WHERE warehouse_id = v_tr.from_warehouse_id AND part_id = v_tr.part_id
   FOR UPDATE;
  IF NOT FOUND THEN
    v_stock := 0;
  END IF;
  IF v_stock < v_tr.qty THEN
    RAISE EXCEPTION 'Insufficient stock: have %, need %', v_stock, v_tr.qty;
  END IF;
  UPDATE public.stock_levels SET qty = qty - v_tr.qty
   WHERE warehouse_id = v_tr.from_warehouse_id AND part_id = v_tr.part_id;
  SELECT code INTO v_to_code FROM public.warehouses WHERE id = v_tr.to_warehouse_id;
  INSERT INTO public.part_transactions
    (warehouse_id, part_id, qty_delta, ticket_id, actor_id, tx_type, transfer_id, note)
  VALUES (v_tr.from_warehouse_id, v_tr.part_id, -v_tr.qty, NULL, v_actor,
          'out', v_tr.id, 'Transfer to ' || COALESCE(v_to_code, ''));
  UPDATE public.transfers
     SET status = 'approved', approved_by = v_actor, approved_at = now()
   WHERE id = v_tr.id;
  RETURN v_tr.id;
END;
$$;

NOTIFY pgrst, 'reload schema';
