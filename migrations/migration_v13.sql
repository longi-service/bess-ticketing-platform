-- =====================================================================
-- migration_v13 — 调拨取消（M9-03 补：待审批 / 已批准未出库可取消）
-- 用户 2026-11-20 拍板：加取消功能，申请人直接取消。
--
-- 回滚逻辑（关键：批准时库存怎么动，取消就怎么还）：
--   待审批（pending）：库存还没动、台账还没记，只改状态。
--   已批准（approved）：批准时源仓在手数已扣掉数量，并记了一笔
--     调拨出台账（part_transactions 'out'，-qty）；取消时把数加回
--     源仓，再记一笔等量调拨入台账（'in'，+qty）冲销，两笔相抵为 0，
--     台账可审计；单子变 cancelled。
--   已出库（dispatched）及以后不能取消——货已在途，只能走反向调拨。
-- 谁能取消：申请人（requested_by）或 admin。审批人（dispatcher）不能
--   取消别人的调拨；申请人自己取消不需要审批。
-- =====================================================================

-- 1. transfers 加取消人 / 取消时间（与 approved_by / approved_at 同型）。
ALTER TABLE public.transfers
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

-- 2. 状态枚举加 'cancelled'。
ALTER TABLE public.transfers DROP CONSTRAINT IF EXISTS transfers_status_check;
ALTER TABLE public.transfers ADD CONSTRAINT transfers_status_check
  CHECK (status IN ('pending', 'approved', 'dispatched', 'received', 'rejected', 'cancelled'));

-- 3. cancel_transfer — 取消一笔待审批或已批准的调拨。
CREATE OR REPLACE FUNCTION public.cancel_transfer(p_transfer_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_tr public.transfers%ROWTYPE;
  v_from_code text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.requester_is_active() THEN
    RAISE EXCEPTION 'Account is not active';
  END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  SELECT * INTO v_tr FROM public.transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer not found';
  END IF;
  -- 只有申请人或 admin 能取消。
  IF v_tr.requested_by IS DISTINCT FROM v_actor AND COALESCE(v_role, '') <> 'admin' THEN
    RAISE EXCEPTION 'Only the requester or an admin can cancel a transfer';
  END IF;
  IF v_tr.status NOT IN ('pending', 'approved') THEN
    RAISE EXCEPTION 'Transfer cannot be cancelled (status: %)', v_tr.status;
  END IF;
  IF v_tr.status = 'approved' THEN
    -- 批准时扣掉的数加回源仓；记一笔等量调拨入冲销批准时的出台账。
    UPDATE public.stock_levels SET qty = qty + v_tr.qty
     WHERE warehouse_id = v_tr.from_warehouse_id AND part_id = v_tr.part_id;
    SELECT code INTO v_from_code FROM public.warehouses WHERE id = v_tr.from_warehouse_id;
    INSERT INTO public.part_transactions
      (warehouse_id, part_id, qty_delta, ticket_id, actor_id, tx_type, transfer_id, note)
    VALUES (v_tr.from_warehouse_id, v_tr.part_id, v_tr.qty, NULL, v_actor,
            'in', v_tr.id, 'Transfer cancelled');
  END IF;
  UPDATE public.transfers
     SET status = 'cancelled', cancelled_by = v_actor, cancelled_at = now()
   WHERE id = v_tr.id;
  RETURN v_tr.id;
END;
$$;

NOTIFY pgrst, 'reload schema';
