-- Stage A of the operator-workflow rework:
--   * physical return no longer requires a completed inspection -- it only
--     requires an open trip, and ends that trip immediately. Inspection and
--     deposit reconciliation may remain outstanding afterward.
--   * inspection (and deposit) requirements become tenant-policy-driven
--     instead of hardcoded, reusing the existing (previously unused)
--     app.tenant_inspection_policy / app.tenant_payment_policy tables, with
--     a safe fallback to today's hardcoded behavior when a tenant has never
--     published a configuration (so nothing changes for such a tenant).
--   * app.booking_item can now progress returned -> closed, and
--     app.booking can close once every item reaches a terminal state.
SET ROLE talus_fn;

ALTER TABLE app.dispatch_record ALTER COLUMN outbound_inspection_id DROP NOT NULL;
ALTER TABLE app.return_record ALTER COLUMN inbound_inspection_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION app.inspection_policy_effective(OUT pre_checkout_required boolean, OUT post_return_required boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE t uuid := app.current_context_tenant_id();
BEGIN
  SELECT p.pre_checkout_required, p.post_return_required INTO pre_checkout_required, post_return_required
    FROM app.tenant_current_configuration cc
    JOIN app.tenant_configuration_version cv ON cv.tenant_id = cc.tenant_id AND cv.tenant_configuration_version_id = cc.tenant_configuration_version_id
    JOIN app.tenant_inspection_policy p ON p.tenant_id = cv.tenant_id AND p.tenant_inspection_policy_id = cv.tenant_inspection_policy_id
   WHERE cc.tenant_id = t;
  IF NOT FOUND THEN pre_checkout_required := true; post_return_required := true; END IF;
END; $$;

CREATE OR REPLACE FUNCTION app.deposit_required_effective() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE t uuid := app.current_context_tenant_id(); v_timing text;
BEGIN
  SELECT pp.payment_timing INTO v_timing
    FROM app.tenant_current_configuration cc
    JOIN app.tenant_configuration_version cv ON cv.tenant_id = cc.tenant_id AND cv.tenant_configuration_version_id = cc.tenant_configuration_version_id
    JOIN app.tenant_payment_policy pp ON pp.tenant_id = cv.tenant_id AND pp.tenant_payment_policy_id = cv.tenant_payment_policy_id
   WHERE cc.tenant_id = t;
  IF NOT FOUND THEN RETURN true; END IF;
  RETURN v_timing <> 'pay_in_full';
END; $$;

-- Dispatch: the pre-checkout inspection is required only when tenant policy
-- says so. A provided inspection is still always validated (must be real,
-- completed, and for this item/machine) and an unsafe result still
-- unconditionally blocks dispatch regardless of policy.
CREATE OR REPLACE FUNCTION app.dispatch_booking_item(
  p_item uuid, p_occupancy uuid, p_outbound uuid, p_at timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE
  t uuid := app.current_context_tenant_id();
  m uuid; tr uuid; co uuid; v_pre_required boolean; v_post_required boolean;
BEGIN
  PERFORM app.require_staff_role('staff');
  SELECT pre_checkout_required, post_return_required INTO v_pre_required, v_post_required FROM app.inspection_policy_effective();

  SELECT machine_id INTO m FROM app.machine_occupancy
   WHERE tenant_id = t AND machine_occupancy_id = p_occupancy
     AND booking_item_id = p_item AND occupancy_kind = 'rental' AND blocking
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DISPATCH_GATE_FAILED' USING ERRCODE = 'P0001'; END IF;

  IF p_outbound IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.inspection
      WHERE tenant_id = t AND inspection_id = p_outbound AND booking_item_id = p_item AND machine_id = m
        AND inspection_type = 'outbound' AND status = 'completed'
    ) THEN RAISE EXCEPTION 'DISPATCH_GATE_FAILED' USING ERRCODE = 'P0001'; END IF;
    IF EXISTS (SELECT 1 FROM app.inspection_item WHERE tenant_id = t AND inspection_id = p_outbound AND condition = 'fail') THEN
      RAISE EXCEPTION 'DISPATCH_BLOCKED_UNSAFE_INSPECTION' USING ERRCODE = 'P0001';
    END IF;
  ELSIF v_pre_required THEN
    RAISE EXCEPTION 'DISPATCH_GATE_FAILED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE app.booking_item SET state = 'checked_out'
   WHERE tenant_id = t AND booking_item_id = p_item AND state IN ('reserved', 'assigned', 'ready');
  IF NOT FOUND THEN RAISE EXCEPTION 'DISPATCH_STATE_INVALID' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO app.checkout_occurrence (tenant_id, checkout_occurrence_id, booking_item_id, machine_occupancy_id, checkout_ordinal, initiated_by_principal_id)
  VALUES (t, gen_random_uuid(), p_item, p_occupancy, 1, app.current_context_principal_id())
  RETURNING checkout_occurrence_id INTO co;

  SELECT app.open_core_trip(p_item, p_occupancy, co, p_at) INTO tr;

  INSERT INTO app.dispatch_record (tenant_id, dispatch_record_id, booking_item_id, trip_id, machine_id, dispatched_by, dispatched_at, outbound_inspection_id)
  VALUES (t, gen_random_uuid(), p_item, tr, m, app.current_context_principal_id(), p_at, p_outbound);
  PERFORM app.append_audit('booking_item.dispatched', 'booking_item', p_item);
  RETURN tr;
END; $$;

-- Return: physical return is unconditional and ends the trip as soon as it
-- is recorded -- it is NEVER gated on inspection completion, regardless of
-- tenant policy. Whether a post-return inspection is required before the
-- item can be *closed* is decided later, by app.close_booking_item. A
-- provided inspection id here is still always validated if given, since
-- staff may complete the inspection first and pass it along at return time.
CREATE OR REPLACE FUNCTION app.receive_booking_return(
  p_item uuid, p_trip uuid, p_inbound uuid DEFAULT NULL, p_at timestamptz DEFAULT clock_timestamp(),
  p_fuel bigint DEFAULT 0, p_mileage bigint DEFAULT 0
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE
  t uuid := app.current_context_tenant_id(); m uuid;
BEGIN
  PERFORM app.require_staff_role('staff');

  SELECT machine_id INTO m FROM app.trip WHERE tenant_id = t AND trip_id = p_trip AND booking_item_id = p_item AND ended_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_GATE_FAILED' USING ERRCODE = 'P0001'; END IF;

  IF p_inbound IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.inspection WHERE tenant_id = t AND inspection_id = p_inbound
        AND booking_item_id = p_item AND inspection_type = 'inbound' AND status = 'completed'
    ) THEN RAISE EXCEPTION 'RETURN_GATE_FAILED' USING ERRCODE = 'P0001'; END IF;
  END IF;

  PERFORM app.seal_core_trip(p_trip, p_at);
  UPDATE app.booking_item SET state = 'returned' WHERE tenant_id = t AND booking_item_id = p_item;
  UPDATE app.machine_occupancy SET blocking = false WHERE tenant_id = t AND booking_item_id = p_item AND occupancy_kind = 'rental';
  INSERT INTO app.return_record (tenant_id, return_record_id, booking_item_id, trip_id, machine_id, received_by, returned_at, inbound_inspection_id, ending_odometer_miles, ending_fuel_pct, fuel_charge_cents, excess_mileage_cents)
  VALUES (t, gen_random_uuid(), p_item, p_trip, m, app.current_context_principal_id(), p_at, p_inbound, NULL, NULL, p_fuel, p_mileage);
  PERFORM app.append_audit('booking_item.returned', 'booking_item', p_item);
  RETURN p_trip;
END; $$;

-- Closing an item requires it to be returned, requires the post-return
-- inspection to be completed if tenant policy requires one (this is the
-- point at which that requirement is actually enforced -- see
-- app.receive_booking_return, which never blocks on it), and requires any
-- deposit hold authorized for it to already be settled (an item with no
-- hold at all -- e.g. tenant policy did not require one -- is not blocked).
CREATE OR REPLACE FUNCTION app.close_booking_item(p_item uuid, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE
  t uuid := app.current_context_tenant_id();
  v_state text;
  v_post_required boolean;
  v_unsettled_hold boolean;
BEGIN
  PERFORM app.require_staff_role('staff');
  SELECT state INTO v_state FROM app.booking_item WHERE tenant_id = t AND booking_item_id = p_item FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_state <> 'returned' THEN RAISE EXCEPTION 'CLOSE_REQUIRES_RETURN' USING ERRCODE = 'P0001'; END IF;

  SELECT post_return_required INTO v_post_required FROM app.inspection_policy_effective();
  IF v_post_required AND NOT EXISTS (
    SELECT 1 FROM app.inspection WHERE tenant_id = t AND booking_item_id = p_item
      AND inspection_type = 'inbound' AND status = 'completed'
  ) THEN RAISE EXCEPTION 'CLOSE_REQUIRES_INSPECTION' USING ERRCODE = 'P0001'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM app.booking_item_deposit_hold h
     WHERE h.tenant_id = t AND h.booking_item_id = p_item
       AND NOT EXISTS (
         SELECT 1 FROM app.deposit_hold_settlement s
           JOIN app.trip tr ON tr.tenant_id = s.tenant_id AND tr.trip_id = s.trip_id
          WHERE s.tenant_id = t AND tr.booking_item_id = p_item AND s.hold_journal_entry_id = h.journal_entry_id
       )
  ) INTO v_unsettled_hold;
  IF v_unsettled_hold THEN RAISE EXCEPTION 'CLOSE_REQUIRES_SETTLEMENT' USING ERRCODE = 'P0001'; END IF;

  UPDATE app.booking_item SET state = 'closed' WHERE tenant_id = t AND booking_item_id = p_item;
  PERFORM app.append_audit('booking_item.closed', 'booking_item', p_item, NULL,
    jsonb_build_object('reason', p_reason));
END; $$;

-- Closes the overall booking once every item has reached a terminal state
-- (closed / cancelled / no_show), matching the existing
-- app.m02_validate_closed_booking guard trigger.
CREATE OR REPLACE FUNCTION app.close_booking(p_booking uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE t uuid := app.current_context_tenant_id(); v_blockers integer;
BEGIN
  PERFORM app.require_staff_role('staff');
  SELECT count(*) INTO v_blockers FROM app.booking_item bi
   WHERE bi.tenant_id = t AND bi.booking_id = p_booking AND bi.state NOT IN ('closed', 'cancelled', 'no_show');
  IF v_blockers > 0 THEN RAISE EXCEPTION 'CLOSE_REQUIRES_ALL_ITEMS_TERMINAL' USING ERRCODE = 'P0001'; END IF;

  UPDATE app.booking SET state = 'closed' WHERE tenant_id = t AND booking_id = p_booking AND state <> 'closed';
  IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  PERFORM app.append_audit('booking.closed', 'booking', p_booking);
END; $$;

RESET ROLE;
