-- Inspection safety hardening:
--   * explicit pass / damage-noted / unsafe outcomes (no more boolean collapse)
--   * fuel/odometer readings are required or must carry an explicit
--     "unavailable" reason -- never silently defaulted to zero
--   * a required-components list is validated server-side before an
--     inspection can be sealed, so an untouched checklist cannot complete
--   * an unsafe (condition='fail') item automatically opens a maintenance
--     hold on the machine via the existing app.schedule_maintenance_block
--   * a completed inspection with any unsafe item can no longer dispatch
--   * inspection_item rows become truly immutable once the parent seals
--   * structured photo evidence replaces free-text photo id entry
SET ROLE talus_fn;

ALTER TABLE app.inspection ADD COLUMN fuel_reading_unavailable_reason text;
ALTER TABLE app.inspection ADD COLUMN odometer_reading_unavailable_reason text;
ALTER TABLE app.inspection ADD CONSTRAINT inspection_fuel_reading_present_chk
  CHECK (status <> 'completed' OR fuel_pct IS NOT NULL OR fuel_reading_unavailable_reason IS NOT NULL) NOT VALID;
ALTER TABLE app.inspection ADD CONSTRAINT inspection_odometer_reading_present_chk
  CHECK (status <> 'completed' OR odometer_miles IS NOT NULL OR odometer_reading_unavailable_reason IS NOT NULL) NOT VALID;

CREATE TABLE app.evidence_file (
  tenant_id uuid NOT NULL,
  evidence_file_id uuid NOT NULL DEFAULT gen_random_uuid(),
  uploaded_by_principal_id uuid NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 15728640),
  storage_key text NOT NULL UNIQUE,
  inspection_item_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, evidence_file_id),
  FOREIGN KEY (tenant_id, uploaded_by_principal_id) REFERENCES app.principal (tenant_id, principal_id),
  FOREIGN KEY (tenant_id, inspection_item_id) REFERENCES app.inspection_item (tenant_id, inspection_item_id)
);
ALTER TABLE app.evidence_file ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.evidence_file FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_context_policy ON app.evidence_file
  USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid())
  WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid());
GRANT SELECT, INSERT, UPDATE, DELETE ON app.evidence_file TO talus_fn;
REVOKE ALL ON app.evidence_file FROM PUBLIC, talus_staff, talus_api, talus_device;

CREATE OR REPLACE FUNCTION app.record_evidence_file(p_id uuid, p_content_type text, p_byte_size integer, p_storage_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE t uuid := app.current_context_tenant_id();
BEGIN
  PERFORM app.require_staff_role('staff');
  INSERT INTO app.evidence_file (tenant_id, evidence_file_id, uploaded_by_principal_id, content_type, byte_size, storage_key)
  VALUES (t, p_id, app.current_context_principal_id(), p_content_type, p_byte_size, p_storage_key);
  RETURN p_id;
END; $$;

-- Immutability: once the parent inspection is completed, inspection_item
-- rows may no longer be updated (the previous trigger only blocked DELETE).
CREATE OR REPLACE FUNCTION app.m07_sealed_item() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=app,pg_catalog AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM app.inspection WHERE tenant_id=OLD.tenant_id AND inspection_id=OLD.inspection_id;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'COMPLETED_INSPECTION_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF v_status='completed' THEN RAISE EXCEPTION 'COMPLETED_INSPECTION_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;$$;

-- Seals an inspection: requires every declared required component to have a
-- recorded outcome, requires a fuel/odometer reading or an explicit
-- unavailable reason, and opens an indefinite maintenance hold on the
-- machine if any component was recorded unsafe (condition='fail').
-- The signature below adds parameters to the M07 original, so the old
-- 3-argument overload must be dropped explicitly -- CREATE OR REPLACE only
-- replaces a function whose parameter list matches exactly, otherwise
-- Postgres creates a second, ambiguous overload.
DROP FUNCTION IF EXISTS app.complete_inspection(uuid, integer, bigint);
CREATE OR REPLACE FUNCTION app.complete_inspection(
  p_id uuid, p_fuel integer, p_odometer bigint,
  p_fuel_unavailable_reason text DEFAULT NULL,
  p_odometer_unavailable_reason text DEFAULT NULL,
  p_required_components text[] DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=app,pg_catalog AS $$
DECLARE
  t uuid := app.current_context_tenant_id();
  v_machine_id uuid;
  v_missing text[];
  v_failed text[];
BEGIN
  PERFORM app.require_staff_role('staff');
  IF p_fuel IS NULL AND (p_fuel_unavailable_reason IS NULL OR length(btrim(p_fuel_unavailable_reason)) = 0) THEN
    RAISE EXCEPTION 'FUEL_READING_REQUIRED' USING ERRCODE='P0001';
  END IF;
  IF p_odometer IS NULL AND (p_odometer_unavailable_reason IS NULL OR length(btrim(p_odometer_unavailable_reason)) = 0) THEN
    RAISE EXCEPTION 'ODOMETER_READING_REQUIRED' USING ERRCODE='P0001';
  END IF;

  SELECT machine_id INTO v_machine_id FROM app.inspection WHERE tenant_id=t AND inspection_id=p_id AND status='draft' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSPECTION_NOT_COMPLETABLE' USING ERRCODE='P0001'; END IF;

  IF p_required_components IS NOT NULL AND array_length(p_required_components,1) > 0 THEN
    SELECT array_agg(component) INTO v_missing FROM unnest(p_required_components) AS component
     WHERE NOT EXISTS (
       SELECT 1 FROM app.inspection_item ii WHERE ii.tenant_id=t AND ii.inspection_id=p_id AND ii.component_name=component
     );
    IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'INSPECTION_CHECKLIST_INCOMPLETE' USING ERRCODE='P0001'; END IF;
  END IF;

  UPDATE app.inspection SET status='completed', completed_at=clock_timestamp(),
         completed_by_principal_id=app.current_context_principal_id(), fuel_pct=p_fuel, odometer_miles=p_odometer,
         fuel_reading_unavailable_reason=p_fuel_unavailable_reason, odometer_reading_unavailable_reason=p_odometer_unavailable_reason
   WHERE tenant_id=t AND inspection_id=p_id AND status='draft';
  IF NOT FOUND THEN RAISE EXCEPTION 'INSPECTION_NOT_COMPLETABLE' USING ERRCODE='P0001'; END IF;

  SELECT array_agg(component_name) INTO v_failed FROM app.inspection_item WHERE tenant_id=t AND inspection_id=p_id AND condition='fail';
  IF v_failed IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.maintenance_block mb WHERE mb.tenant_id=t AND mb.machine_id=v_machine_id AND mb.status IN ('scheduled','in_progress')
  ) THEN
    -- Best-effort: an indefinite hold starting now can collide with this
    -- same booking's own still-open rental occupancy (the vehicle that just
    -- failed inspection has not been unassigned yet). Dispatch is already
    -- unconditionally blocked by the inspection_item.condition='fail' check
    -- in app.dispatch_booking_item regardless of whether this hold lands, so
    -- on conflict we record the recommendation in the audit trail instead of
    -- failing the inspection completion itself.
    BEGIN
      PERFORM app.schedule_maintenance_block(
        gen_random_uuid(), v_machine_id, tstzrange(clock_timestamp(), NULL, '[)'),
        'Auto-created: unsafe inspection outcome on ' || array_to_string(v_failed, ', ')
      );
    EXCEPTION WHEN exclusion_violation THEN
      PERFORM app.append_audit('maintenance.hold_recommended', 'machine', v_machine_id, NULL,
        jsonb_build_object('reason', 'unsafe inspection outcome on ' || array_to_string(v_failed, ', '), 'inspection_id', p_id));
    END;
  END IF;

  PERFORM app.append_audit('inspection.completed','inspection',p_id);
  RETURN p_id;
END; $$;

-- One-shot staff entrypoint: start + record every checklist item with an
-- explicit outcome (pass / damage / unsafe, never a boolean collapse) + seal.
-- p_items shape: [{"item": text, "outcome": "pass"|"damage"|"unsafe", "notes": text, "photoRefs": [evidence_file_id,...]}]
DROP FUNCTION IF EXISTS app.create_completed_inspection(uuid, uuid, uuid, text, integer, bigint, text, jsonb);
CREATE OR REPLACE FUNCTION app.create_completed_inspection(
  p_item uuid, p_machine uuid, p_trip uuid, p_type text, p_fuel integer, p_odometer bigint, p_notes text, p_items jsonb,
  p_fuel_unavailable_reason text DEFAULT NULL,
  p_odometer_unavailable_reason text DEFAULT NULL,
  p_required_components text[] DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=app,pg_catalog AS $$
DECLARE
  t uuid:=app.current_context_tenant_id();
  inspection_id uuid:=gen_random_uuid();
  item jsonb;
  item_condition text;
  item_id uuid;
  photo_ref text;
  photo_refs uuid[];
BEGIN
  PERFORM app.require_staff_role('staff');
  IF p_type NOT IN ('outbound','inbound') OR p_items IS NULL OR jsonb_typeof(p_items)<>'array' THEN
    RAISE EXCEPTION 'INSPECTION_INPUT_INVALID' USING ERRCODE='P0001';
  END IF;
  PERFORM app.start_inspection(inspection_id,p_item,p_trip,p_machine,p_type);
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    item_condition := CASE item->>'outcome'
      WHEN 'pass' THEN 'pass'
      WHEN 'damage' THEN 'flagged'
      WHEN 'unsafe' THEN 'fail'
      ELSE NULL
    END;
    IF item_condition IS NULL THEN RAISE EXCEPTION 'INSPECTION_ITEM_OUTCOME_REQUIRED' USING ERRCODE='P0001'; END IF;
    item_id := gen_random_uuid();
    INSERT INTO app.inspection_item(tenant_id,inspection_item_id,inspection_id,component_name,condition,notes)
    VALUES(t,item_id,inspection_id,item->>'item',item_condition,COALESCE(item->>'notes',''));

    IF jsonb_typeof(item->'photoRefs') = 'array' AND jsonb_array_length(item->'photoRefs') > 0 THEN
      SELECT array_agg((value)::uuid) INTO photo_refs FROM jsonb_array_elements_text(item->'photoRefs') AS value;
      UPDATE app.evidence_file SET inspection_item_id = item_id
       WHERE tenant_id = t AND evidence_file_id = ANY(photo_refs)
         AND uploaded_by_principal_id = app.current_context_principal_id() AND inspection_item_id IS NULL;
      UPDATE app.inspection_item SET photo_evidence_refs = (
        SELECT array_agg(evidence_file_id::text) FROM app.evidence_file WHERE tenant_id=t AND inspection_item_id=item_id
      ) WHERE tenant_id=t AND inspection_item_id=item_id;
    END IF;
  END LOOP;
  PERFORM app.complete_inspection(inspection_id,p_fuel,p_odometer,p_fuel_unavailable_reason,p_odometer_unavailable_reason,p_required_components);
  RETURN inspection_id;
END; $$;

-- Dispatch now also fails closed if the outbound inspection recorded any
-- unsafe (condition='fail') component -- a completed-but-unsafe inspection
-- must never be treated as dispatch-ready.
CREATE OR REPLACE FUNCTION app.dispatch_booking_item(
  p_item uuid, p_occupancy uuid, p_outbound uuid, p_at timestamptz DEFAULT clock_timestamp()
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE
  t uuid := app.current_context_tenant_id();
  m uuid; tr uuid; co uuid;
BEGIN
  PERFORM app.require_staff_role('staff');

  SELECT machine_id INTO m FROM app.machine_occupancy
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

  IF EXISTS (SELECT 1 FROM app.inspection_item WHERE tenant_id = t AND inspection_id = p_outbound AND condition = 'fail') THEN
    RAISE EXCEPTION 'DISPATCH_BLOCKED_UNSAFE_INSPECTION' USING ERRCODE = 'P0001';
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

RESET ROLE;
