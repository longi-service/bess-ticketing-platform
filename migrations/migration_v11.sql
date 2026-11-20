-- =====================================================================
-- BESS Ticketing Platform — migration v11 (M9-03 cross-warehouse
-- transfer, user-approved 2026-11-20)
--
-- Flow: request → approve → dispatch (upload proof) → confirm receipt
-- → closed. Rejection closes from pending.
-- In-transit model: approval deducts the source stock and writes the
-- source 'out' ledger row; receipt credits the destination stock and
-- writes the destination 'in' ledger row. Stock is never double
-- counted and never lost while in transit.
-- Rules (user-approved): approval first (no stock moves before
-- approval); cross-project and parent/child transfers allowed; no
-- ticket link; below min_qty only warns (never blocks); initiator =
-- PM (own project) + admin; approver = dispatcher + admin.
-- Delivery proof (uploaded at dispatch): courier = packing photos +
-- tracking number; self carry = handover photos. Photos live in a
-- dedicated private bucket 'transfer-photos' — the ticket-photos
-- bucket is ticket-scoped (photo_ticket_id) and cannot hold them.
--
-- Execute: paste the whole file into the Supabase SQL Editor and run.
-- It is one transaction: any error rolls everything back.
--
-- Verify after running (SQL Editor, read-only checks):
--   1) SELECT to_regclass('public.transfers');  → transfers
--   2) SELECT proname FROM pg_proc WHERE proname LIKE '%transfer%'
--      ORDER BY 1;
--      → approve_transfer, create_transfer, dispatch_transfer,
--        receive_transfer, reject_transfer, transfer_pm_in_scope
--   3) SELECT id, name, public FROM storage.buckets
--      WHERE id = 'transfer-photos';  → one row, public = false
--   4) Negative test (changes no data):
--      SELECT public.create_transfer(
--        '00000000-0000-0000-0000-000000000000', 1,
--        '00000000-0000-0000-0000-000000000000',
--        '00000000-0000-0000-0000-000000000000');
--      → ERROR: Part not found
--   5) UI test (creates real data — use the R3 test project):
--      request a transfer on R3-UTIL-01, approve it as dispatcher or
--      admin, dispatch it with a photo, confirm receipt; the two
--      part_transactions rows must share one transfer_id and the stock
--      must move source → destination.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. transfers table
--    status: pending (awaiting approval) → approved (source deducted,
--    awaiting dispatch) → dispatched (proof uploaded, in transit) →
--    received (destination credited, closed); rejected (from pending).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.transfers (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  part_id uuid NOT NULL REFERENCES public.spare_parts(id) ON DELETE CASCADE,
  qty numeric NOT NULL CHECK (qty > 0),
  from_warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  to_warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'dispatched', 'received', 'rejected')),
  delivery_method text
    CHECK (delivery_method IS NULL OR delivery_method IN ('courier', 'self_carry')),
  tracking_no text,
  photo_paths text[] NOT NULL DEFAULT '{}',
  note text,
  reject_reason text,
  requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  dispatched_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  received_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  dispatched_at timestamptz,
  received_at timestamptz,
  CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE INDEX IF NOT EXISTS transfers_status_created_idx
  ON public.transfers (status, created_at DESC);

-- ---------------------------------------------------------------------
-- 2. part_transactions.transfer_id — links the two ledger rows of one
--    transfer (source 'out' + destination 'in').
-- ---------------------------------------------------------------------
ALTER TABLE public.part_transactions
  ADD COLUMN IF NOT EXISTS transfer_id uuid REFERENCES public.transfers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS part_transactions_transfer_idx
  ON public.part_transactions (transfer_id);

-- ---------------------------------------------------------------------
-- 3. RLS — staff read-only; all writes go through the SECURITY DEFINER
--    RPCs below (they bypass RLS and enforce the role/scope rules).
-- ---------------------------------------------------------------------
ALTER TABLE public.transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS v11_transfers_select ON public.transfers;
CREATE POLICY v11_transfers_select ON public.transfers
  FOR SELECT
  USING (public.requester_is_active() AND (public.my_role() <> 'customer'));

-- ---------------------------------------------------------------------
-- 4. transfer-photos bucket (private) + policies.
--    Policies mirror the staff-only rule of the transfers table; the
--    dispatch RPC additionally checks that every photo path belongs
--    to the transfer being dispatched.
-- ---------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('transfer-photos', 'transfer-photos', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS v11_transfer_photos_insert ON storage.objects;
CREATE POLICY v11_transfer_photos_insert ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'transfer-photos'
    AND public.requester_is_active()
    AND (public.my_role() <> 'customer')
  );

DROP POLICY IF EXISTS v11_transfer_photos_select ON storage.objects;
CREATE POLICY v11_transfer_photos_select ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'transfer-photos'
    AND public.requester_is_active()
    AND (public.my_role() <> 'customer')
  );

DROP POLICY IF EXISTS v11_transfer_photos_delete ON storage.objects;
CREATE POLICY v11_transfer_photos_delete ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'transfer-photos'
    AND public.requester_is_active()
    AND (public.my_role() <> 'customer')
  );

-- ---------------------------------------------------------------------
-- 5. Scope helper — is the caller a PM whose project_scope covers this
--    site? Empty or NULL scope means all sites (same rule as the ticket
--    visibility logic for PMs). Admin/dispatcher are handled by the
--    callers; this helper only answers the PM question.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transfer_pm_in_scope(p_site_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'pm'
      AND (project_scope IS NULL
           OR project_scope = '{}'::uuid[]
           OR p_site_id = ANY(project_scope))
  )
$$;

-- ---------------------------------------------------------------------
-- 6. RPCs (all SECURITY DEFINER; each call is one transaction).
-- ---------------------------------------------------------------------

-- 6a. create_transfer — file a transfer request (no stock moves yet).
CREATE OR REPLACE FUNCTION public.create_transfer(
  p_part_id uuid,
  p_qty numeric,
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid,
  p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_from_site uuid;
  v_stock numeric;
  v_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.requester_is_active() THEN
    RAISE EXCEPTION 'Account is not active';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'Quantity must be a positive number';
  END IF;
  IF p_qty <> TRUNC(p_qty) THEN
    RAISE EXCEPTION 'Quantity must be a whole number';
  END IF;
  IF p_from_warehouse_id IS NULL OR p_to_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'Both warehouses are required';
  END IF;
  IF p_from_warehouse_id = p_to_warehouse_id THEN
    RAISE EXCEPTION 'Source and destination warehouses must differ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.spare_parts WHERE id = p_part_id) THEN
    RAISE EXCEPTION 'Part not found';
  END IF;
  SELECT site_id INTO v_from_site FROM public.warehouses WHERE id = p_from_warehouse_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source warehouse not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.warehouses WHERE id = p_to_warehouse_id) THEN
    RAISE EXCEPTION 'Destination warehouse not found';
  END IF;
  -- Initiator: admin anywhere; PM only for the source warehouse's project.
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF v_role = 'admin' THEN
    NULL;
  ELSIF v_role = 'pm' AND public.transfer_pm_in_scope(v_from_site) THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Only a project manager (own project) or admin can request a transfer';
  END IF;
  -- Fail fast: the source must cover the quantity now (re-checked at approval).
  SELECT qty INTO v_stock FROM public.stock_levels
   WHERE warehouse_id = p_from_warehouse_id AND part_id = p_part_id;
  IF NOT FOUND THEN
    v_stock := 0;
  END IF;
  IF v_stock < p_qty THEN
    RAISE EXCEPTION 'Insufficient stock: have %, need %', v_stock, p_qty;
  END IF;
  INSERT INTO public.transfers
    (part_id, qty, from_warehouse_id, to_warehouse_id, note, requested_by)
  VALUES (p_part_id, p_qty, p_from_warehouse_id, p_to_warehouse_id,
          NULLIF(TRIM(p_note), ''), v_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- 6b. approve_transfer — approval deducts the source stock (in-transit).
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
  SELECT qty INTO v_stock FROM public.stock_levels
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

-- 6c. reject_transfer — rejection closes the request, no stock moves.
CREATE OR REPLACE FUNCTION public.reject_transfer(p_transfer_id uuid, p_note text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_tr public.transfers%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.requester_is_active() THEN
    RAISE EXCEPTION 'Account is not active';
  END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  IF COALESCE(v_role, '') NOT IN ('admin', 'dispatcher') THEN
    RAISE EXCEPTION 'Only a dispatcher or admin can reject a transfer';
  END IF;
  SELECT * INTO v_tr FROM public.transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer not found';
  END IF;
  IF v_tr.status <> 'pending' THEN
    RAISE EXCEPTION 'Transfer is not awaiting approval (status: %)', v_tr.status;
  END IF;
  UPDATE public.transfers
     SET status = 'rejected', approved_by = v_actor, approved_at = now(),
         reject_reason = NULLIF(TRIM(p_note), '')
   WHERE id = v_tr.id;
  RETURN v_tr.id;
END;
$$;

-- 6d. dispatch_transfer — physical dispatch with proof. Courier needs a
--     tracking number + at least one photo; self carry needs at least
--     one photo. No stock moves here (the source was deducted at
--     approval); photo paths must belong to this transfer.
CREATE OR REPLACE FUNCTION public.dispatch_transfer(
  p_transfer_id uuid,
  p_delivery_method text,
  p_tracking_no text DEFAULT NULL,
  p_photo_paths text[] DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_tr public.transfers%ROWTYPE;
  v_from_site uuid;
  v_nphotos integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.requester_is_active() THEN
    RAISE EXCEPTION 'Account is not active';
  END IF;
  IF p_delivery_method NOT IN ('courier', 'self_carry') THEN
    RAISE EXCEPTION 'Delivery method must be courier or self_carry';
  END IF;
  SELECT * INTO v_tr FROM public.transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer not found';
  END IF;
  IF v_tr.status <> 'approved' THEN
    RAISE EXCEPTION 'Transfer is not approved and awaiting dispatch (status: %)', v_tr.status;
  END IF;
  -- Dispatcher: admin, dispatcher, or the source project's PM.
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  SELECT site_id INTO v_from_site FROM public.warehouses WHERE id = v_tr.from_warehouse_id;
  IF v_role = 'admin' OR v_role = 'dispatcher' THEN
    NULL;
  ELSIF v_role = 'pm' AND public.transfer_pm_in_scope(v_from_site) THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Only the source project manager, a dispatcher or admin can dispatch a transfer';
  END IF;
  -- Proof: courier needs a tracking number + at least one photo;
  -- self carry needs at least one photo.
  v_nphotos := COALESCE(array_length(p_photo_paths, 1), 0);
  IF p_delivery_method = 'courier' AND NULLIF(TRIM(p_tracking_no), '') IS NULL THEN
    RAISE EXCEPTION 'A tracking number is required for courier delivery';
  END IF;
  IF v_nphotos < 1 THEN
    RAISE EXCEPTION 'At least one proof photo is required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_photo_paths) AS p
    WHERE p IS NULL OR p NOT LIKE v_tr.id::text || '/%'
  ) THEN
    RAISE EXCEPTION 'Photo paths must belong to this transfer';
  END IF;
  UPDATE public.transfers
     SET delivery_method = p_delivery_method,
         tracking_no = CASE WHEN p_delivery_method = 'courier'
                            THEN NULLIF(TRIM(p_tracking_no), '') ELSE NULL END,
         photo_paths = p_photo_paths,
         status = 'dispatched', dispatched_by = v_actor, dispatched_at = now()
   WHERE id = v_tr.id;
  RETURN v_tr.id;
END;
$$;

-- 6e. receive_transfer — destination confirms receipt: destination stock
--     is credited and the destination 'in' ledger row is written.
CREATE OR REPLACE FUNCTION public.receive_transfer(p_transfer_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_tr public.transfers%ROWTYPE;
  v_to_site uuid;
  v_from_code text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.requester_is_active() THEN
    RAISE EXCEPTION 'Account is not active';
  END IF;
  SELECT * INTO v_tr FROM public.transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer not found';
  END IF;
  IF v_tr.status <> 'dispatched' THEN
    RAISE EXCEPTION 'Transfer is not dispatched and awaiting receipt (status: %)', v_tr.status;
  END IF;
  -- Receiver: admin, dispatcher, or the destination project's PM.
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;
  SELECT site_id INTO v_to_site FROM public.warehouses WHERE id = v_tr.to_warehouse_id;
  IF v_role = 'admin' OR v_role = 'dispatcher' THEN
    NULL;
  ELSIF v_role = 'pm' AND public.transfer_pm_in_scope(v_to_site) THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Only the destination project manager, a dispatcher or admin can confirm receipt';
  END IF;
  -- Credit the destination stock (upsert; the (warehouse_id, part_id)
  -- primary key serialises concurrent receipts for the same part).
  INSERT INTO public.stock_levels (warehouse_id, part_id, qty)
  VALUES (v_tr.to_warehouse_id, v_tr.part_id, v_tr.qty)
  ON CONFLICT (warehouse_id, part_id)
  DO UPDATE SET qty = stock_levels.qty + EXCLUDED.qty;
  SELECT code INTO v_from_code FROM public.warehouses WHERE id = v_tr.from_warehouse_id;
  INSERT INTO public.part_transactions
    (warehouse_id, part_id, qty_delta, ticket_id, actor_id, tx_type, transfer_id, note)
  VALUES (v_tr.to_warehouse_id, v_tr.part_id, v_tr.qty, NULL, v_actor,
          'in', v_tr.id, 'Transfer from ' || COALESCE(v_from_code, ''));
  UPDATE public.transfers
     SET status = 'received', received_by = v_actor, received_at = now()
   WHERE id = v_tr.id;
  RETURN v_tr.id;
END;
$$;

-- The frontend calls these RPCs with the user's JWT.
GRANT EXECUTE ON FUNCTION public.create_transfer(uuid, numeric, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_transfer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_transfer(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_transfer(uuid, text, text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_transfer(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
