-- Odometer readings on pre-rental inspections are hardware telemetry, not
-- staff-entered evidence. Keep historical readings intact, but allow an
-- outbound inspection to seal with no reading and no invented fallback.
SET ROLE talus_fn;

ALTER TABLE app.inspection DROP CONSTRAINT IF EXISTS inspection_odometer_reading_present_chk;
ALTER TABLE app.inspection ADD CONSTRAINT inspection_odometer_reading_present_chk
  CHECK (
    status <> 'completed'
    OR inspection_type = 'outbound'
    OR odometer_miles IS NOT NULL
    OR odometer_reading_unavailable_reason IS NOT NULL
  ) NOT VALID;

CREATE OR REPLACE FUNCTION app.complete_inspection(
  p_id uuid, p_fuel integer, p_odometer bigint,
  p_fuel_unavailable_reason text DEFAULT NULL,
  p_odometer_unavailable_reason text DEFAULT NULL,
  p_required_components text[] DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=app,pg_catalog AS $$
DECLARE
  t uuid := app.current_context_tenant_id();
  v_machine_id uuid;
  v_inspection_type text;
  v_missing text[];
  v_failed text[];
BEGIN
  PERFORM app.require_staff_role('staff');
  IF p_fuel IS NULL AND (p_fuel_unavailable_reason IS NULL OR length(btrim(p_fuel_unavailable_reason)) = 0) THEN
    RAISE EXCEPTION 'FUEL_READING_REQUIRED' USING ERRCODE='P0001';
  END IF;
  SELECT machine_id, inspection_type INTO v_machine_id, v_inspection_type FROM app.inspection
   WHERE tenant_id=t AND inspection_id=p_id AND status='draft' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSPECTION_NOT_COMPLETABLE' USING ERRCODE='P0001'; END IF;
  IF v_inspection_type = 'inbound' AND p_odometer IS NULL AND (p_odometer_unavailable_reason IS NULL OR length(btrim(p_odometer_unavailable_reason)) = 0) THEN
    RAISE EXCEPTION 'ODOMETER_READING_REQUIRED' USING ERRCODE='P0001';
  END IF;
  IF p_required_components IS NOT NULL AND array_length(p_required_components,1) > 0 THEN
    SELECT array_agg(component) INTO v_missing FROM unnest(p_required_components) AS component WHERE NOT EXISTS (
      SELECT 1 FROM app.inspection_item ii WHERE ii.tenant_id=t AND ii.inspection_id=p_id AND ii.component_name=component
    );
    IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'INSPECTION_CHECKLIST_INCOMPLETE' USING ERRCODE='P0001'; END IF;
  END IF;
  UPDATE app.inspection SET status='completed', completed_at=clock_timestamp(),
    completed_by_principal_id=app.current_context_principal_id(), fuel_pct=p_fuel, odometer_miles=p_odometer,
    fuel_reading_unavailable_reason=p_fuel_unavailable_reason,
    odometer_reading_unavailable_reason=CASE WHEN v_inspection_type='inbound' THEN p_odometer_unavailable_reason ELSE NULL END
   WHERE tenant_id=t AND inspection_id=p_id AND status='draft';
  SELECT array_agg(component_name) INTO v_failed FROM app.inspection_item WHERE tenant_id=t AND inspection_id=p_id AND condition='fail';
  IF v_failed IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.maintenance_block mb WHERE mb.tenant_id=t AND mb.machine_id=v_machine_id AND mb.status IN ('scheduled','in_progress')) THEN
    BEGIN
      PERFORM app.schedule_maintenance_block(gen_random_uuid(), v_machine_id, tstzrange(clock_timestamp(), NULL, '[)'), 'Auto-created: unsafe inspection outcome on ' || array_to_string(v_failed, ', '));
    EXCEPTION WHEN exclusion_violation THEN
      PERFORM app.append_audit('maintenance.hold_recommended', 'machine', v_machine_id, NULL, jsonb_build_object('reason', 'unsafe inspection outcome on ' || array_to_string(v_failed, ', '), 'inspection_id', p_id));
    END;
  END IF;
  PERFORM app.append_audit('inspection.completed','inspection',p_id);
  RETURN p_id;
END; $$;

RESET ROLE;
