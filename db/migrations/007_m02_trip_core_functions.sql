-- M02: private, staff-authorized trip lifecycle primitives. Telemetry does
-- not create Trips; later telemetry modules may only request these operations.

SET ROLE talus_fn;

CREATE OR REPLACE FUNCTION app.open_core_trip(
  p_booking_item_id uuid,
  p_machine_occupancy_id uuid,
  p_checkout_occurrence_id uuid,
  p_started_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
DECLARE
  v_item app.booking_item%ROWTYPE;
  v_occupancy app.machine_occupancy%ROWTYPE;
  v_trip_id uuid;
BEGIN
  PERFORM app.require_staff_role('staff');

  SELECT bi.* INTO v_item
  FROM app.booking_item AS bi
  WHERE bi.tenant_id = app.current_context_tenant_id()
    AND bi.booking_item_id = p_booking_item_id
  FOR UPDATE;

  IF NOT FOUND OR v_item.state <> 'checked_out' THEN
    RAISE EXCEPTION 'TRIP_NOT_OPENABLE' USING ERRCODE = 'P0001';
  END IF;

  SELECT mo.* INTO v_occupancy
  FROM app.machine_occupancy AS mo
  WHERE mo.tenant_id = v_item.tenant_id
    AND mo.machine_occupancy_id = p_machine_occupancy_id
    AND mo.occupancy_kind = 'rental'
    AND mo.booking_item_id = v_item.booking_item_id
  FOR UPDATE;

  IF NOT FOUND
     OR NOT EXISTS (
       SELECT 1
       FROM app.checkout_occurrence AS co
       WHERE co.tenant_id = v_item.tenant_id
         AND co.checkout_occurrence_id = p_checkout_occurrence_id
         AND co.booking_item_id = v_item.booking_item_id
         AND co.machine_occupancy_id = v_occupancy.machine_occupancy_id
     )
  THEN
    RAISE EXCEPTION 'TRIP_NOT_OPENABLE' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO app.trip AS t (
    tenant_id, booking_item_id, machine_id, checkout_occurrence_id, started_at
  ) VALUES (
    v_item.tenant_id, v_item.booking_item_id, v_occupancy.machine_id,
    p_checkout_occurrence_id, p_started_at
  )
  RETURNING t.trip_id INTO v_trip_id;

  PERFORM app.append_audit(
    'trip.opened', 'trip', v_trip_id, NULL,
    jsonb_build_object('booking_item_id', v_item.booking_item_id, 'machine_id', v_occupancy.machine_id)
  );
  RETURN v_trip_id;
END;
$$;

CREATE OR REPLACE FUNCTION app.seal_core_trip(
  p_trip_id uuid,
  p_ended_at timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
DECLARE
  v_trip app.trip%ROWTYPE;
BEGIN
  PERFORM app.require_staff_role('staff');

  SELECT t.* INTO v_trip
  FROM app.trip AS t
  WHERE t.tenant_id = app.current_context_tenant_id()
    AND t.trip_id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND OR v_trip.ended_at IS NOT NULL OR p_ended_at <= v_trip.started_at THEN
    RAISE EXCEPTION 'TRIP_NOT_SEALABLE' USING ERRCODE = 'P0001';
  END IF;

  UPDATE app.trip AS t
  SET ended_at = p_ended_at
  WHERE t.tenant_id = v_trip.tenant_id AND t.trip_id = v_trip.trip_id;

  PERFORM app.append_audit('trip.sealed', 'trip', v_trip.trip_id);
END;
$$;

REVOKE ALL ON FUNCTION app.open_core_trip(uuid, uuid, uuid, timestamptz)
  FROM PUBLIC, talus_api, talus_customer, talus_staff, talus_device;
REVOKE ALL ON FUNCTION app.seal_core_trip(uuid, timestamptz)
  FROM PUBLIC, talus_api, talus_customer, talus_staff, talus_device;

RESET ROLE;
