-- Dispatch is one atomic state transition: establish the checkout occurrence,
-- transition the item, then open the trip.  Any later failure rolls all three
-- actions back with the enclosing function transaction.
SET ROLE talus_fn;

CREATE OR REPLACE FUNCTION app.dispatch_booking_item(
  p_item uuid,
  p_occupancy uuid,
  p_outbound uuid,
  p_at timestamptz DEFAULT clock_timestamp()
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
DECLARE
  t uuid := app.current_context_tenant_id();
  m uuid;
  tr uuid;
  co uuid;
BEGIN
  PERFORM app.require_staff_role('staff');

  SELECT machine_id INTO m
  FROM app.machine_occupancy
  WHERE tenant_id = t AND machine_occupancy_id = p_occupancy
    AND booking_item_id = p_item AND occupancy_kind = 'rental' AND blocking
  FOR UPDATE;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM app.inspection
    WHERE tenant_id = t AND inspection_id = p_outbound
      AND booking_item_id = p_item AND machine_id = m
      AND inspection_type = 'outbound' AND status = 'completed'
  ) THEN
    RAISE EXCEPTION 'DISPATCH_GATE_FAILED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE app.booking_item
  SET state = 'checked_out'
  WHERE tenant_id = t AND booking_item_id = p_item
    AND state IN ('reserved', 'assigned', 'ready');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DISPATCH_STATE_INVALID' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO app.checkout_occurrence (
    tenant_id, checkout_occurrence_id, booking_item_id, machine_occupancy_id,
    checkout_ordinal, initiated_by_principal_id
  ) VALUES (
    t, gen_random_uuid(), p_item, p_occupancy, 1, app.current_context_principal_id()
  ) RETURNING checkout_occurrence_id INTO co;

  SELECT app.open_core_trip(p_item, p_occupancy, co, p_at) INTO tr;

  INSERT INTO app.dispatch_record (
    tenant_id, dispatch_record_id, booking_item_id, trip_id, machine_id,
    dispatched_by, dispatched_at, outbound_inspection_id
  ) VALUES (
    t, gen_random_uuid(), p_item, tr, m, app.current_context_principal_id(), p_at, p_outbound
  );
  PERFORM app.append_audit('booking_item.dispatched', 'booking_item', p_item);
  RETURN tr;
END;
$$;

RESET ROLE;
