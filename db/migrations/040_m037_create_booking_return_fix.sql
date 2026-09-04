-- Qualify the output expression to avoid collisions between PL/pgSQL OUT
-- parameters and local identifiers in the booking workflow.
SET ROLE talus_fn;

CREATE OR REPLACE FUNCTION app.create_booking(
  p_customer_id uuid, p_category_location_id uuid,
  p_start_time timestamptz, p_end_time timestamptz
) RETURNS TABLE (
  booking_id uuid, booking_item_id uuid,
  booking_terms_revision_id uuid, item_terms_revision_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, public
AS $$
DECLARE
  t uuid := app.current_context_tenant_id();
  v_booking_id uuid := gen_random_uuid();
  v_item_id uuid := gen_random_uuid();
  v_booking_terms_id uuid := gen_random_uuid();
  v_item_terms_id uuid := gen_random_uuid();
  v_location_id uuid;
BEGIN
  PERFORM app.require_staff_role('staff');
  IF p_end_time <= p_start_time OR NOT EXISTS (
    SELECT 1 FROM app.customer AS c WHERE c.tenant_id = t AND c.customer_id = p_customer_id
  ) THEN RAISE EXCEPTION 'BOOKING_INPUT_INVALID' USING ERRCODE = 'P0001'; END IF;
  SELECT cl.location_id INTO v_location_id FROM app.category_location AS cl
  WHERE cl.tenant_id = t AND cl.category_location_id = p_category_location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO app.booking (tenant_id,booking_id,booking_reference,pickup_location_id,return_location_id,state)
  VALUES (t,v_booking_id,'API-'||substr(v_booking_id::text,1,8),v_location_id,v_location_id,'draft');
  INSERT INTO app.booking_terms_revision (tenant_id,booking_terms_revision_id,booking_id,revision_number)
  VALUES (t,v_booking_terms_id,v_booking_id,1);
  INSERT INTO app.booking_item (tenant_id,booking_item_id,booking_id,item_number,state)
  VALUES (t,v_item_id,v_booking_id,1,'reserved');
  INSERT INTO app.booking_item_terms_revision (
    tenant_id,booking_item_terms_revision_id,booking_item_id,booking_id,booking_terms_revision_id,
    category_location_id,revision_number,scheduled_start_at,scheduled_end_at,chargeable_day_count
  ) VALUES (
    t,v_item_terms_id,v_item_id,v_booking_id,v_booking_terms_id,p_category_location_id,1,
    p_start_time,p_end_time,GREATEST(1,(p_end_time::date-p_start_time::date))
  );
  UPDATE app.booking_item AS bi SET current_terms_revision_id = v_item_terms_id
  WHERE bi.tenant_id = t AND bi.booking_item_id = v_item_id;
  PERFORM app.append_audit('booking.created','booking',v_booking_id);
  RETURN QUERY SELECT v_booking_id, v_item_id, v_booking_terms_id, v_item_terms_id;
END;
$$;

RESET ROLE;
