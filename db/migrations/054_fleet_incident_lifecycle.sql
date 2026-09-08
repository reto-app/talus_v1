-- Adds a mutable incident-lifecycle layer on top of the immutable app.fleet_alert
-- event log. Raw telemetry-triggered alerts remain an append-only audit trail;
-- app.incident is the staff-facing aggregate that carries status, assignment,
-- and resolution so the alert rail can stop showing permanently-active history.
SET ROLE talus_fn;

CREATE TABLE app.incident (
  tenant_id uuid NOT NULL,
  incident_id uuid NOT NULL DEFAULT gen_random_uuid(),
  machine_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('new','acknowledged','in_progress','resolved')) DEFAULT 'new',
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  in_progress_at timestamptz,
  resolved_at timestamptz,
  assigned_principal_id uuid,
  resolution_reason text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, incident_id),
  FOREIGN KEY (tenant_id, machine_id) REFERENCES app.machine (tenant_id, machine_id),
  FOREIGN KEY (tenant_id, assigned_principal_id) REFERENCES app.principal (tenant_id, principal_id),
  CHECK (status <> 'resolved' OR (resolved_at IS NOT NULL AND resolution_reason IS NOT NULL))
);
CREATE INDEX incident_open_by_machine_idx ON app.incident (tenant_id, machine_id, status) WHERE status <> 'resolved';
CREATE INDEX incident_tenant_status_idx ON app.incident (tenant_id, status, opened_at DESC);

CREATE TABLE app.incident_alert (
  tenant_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  fleet_alert_id uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, incident_id, fleet_alert_id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES app.incident (tenant_id, incident_id),
  FOREIGN KEY (tenant_id, fleet_alert_id) REFERENCES app.fleet_alert (tenant_id, fleet_alert_id)
);

CREATE TABLE app.incident_status_event (
  tenant_id uuid NOT NULL,
  incident_status_event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL,
  from_status text CHECK (from_status IS NULL OR from_status IN ('new','acknowledged','in_progress','resolved')),
  to_status text NOT NULL CHECK (to_status IN ('new','acknowledged','in_progress','resolved')),
  actor_principal_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text,
  PRIMARY KEY (tenant_id, incident_status_event_id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES app.incident (tenant_id, incident_id),
  FOREIGN KEY (tenant_id, actor_principal_id) REFERENCES app.principal (tenant_id, principal_id)
);
CREATE TRIGGER incident_status_event_append BEFORE UPDATE OR DELETE ON app.incident_status_event FOR EACH ROW EXECUTE FUNCTION app.enforce_append_only();

CREATE TABLE app.incident_note (
  tenant_id uuid NOT NULL,
  incident_note_id uuid NOT NULL DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL,
  author_principal_id uuid NOT NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, incident_note_id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES app.incident (tenant_id, incident_id),
  FOREIGN KEY (tenant_id, author_principal_id) REFERENCES app.principal (tenant_id, principal_id)
);
CREATE TRIGGER incident_note_append BEFORE UPDATE OR DELETE ON app.incident_note FOR EACH ROW EXECUTE FUNCTION app.enforce_append_only();

-- Finds (or opens) the machine's current non-resolved incident, bumps its
-- severity if the new alert is worse, and links the contributing alert.
-- Internal helper: only ever called from trusted server-side ingest code.
CREATE OR REPLACE FUNCTION app.open_or_attach_incident(p_fleet_alert_id uuid, p_machine_id uuid, p_severity text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE
  t uuid := app.current_context_tenant_id();
  existing_id uuid;
  existing_severity text;
  sev_rank CONSTANT jsonb := '{"low":1,"medium":2,"high":3,"critical":4}'::jsonb;
BEGIN
  PERFORM app.require_context();
  SELECT incident_id, severity INTO existing_id, existing_severity
    FROM app.incident
   WHERE tenant_id = t AND machine_id = p_machine_id AND status <> 'resolved'
   ORDER BY opened_at DESC LIMIT 1;

  IF existing_id IS NULL THEN
    existing_id := gen_random_uuid();
    INSERT INTO app.incident (tenant_id, incident_id, machine_id, severity)
      VALUES (t, existing_id, p_machine_id, p_severity);
    INSERT INTO app.incident_status_event (tenant_id, incident_id, from_status, to_status, actor_principal_id)
      VALUES (t, existing_id, NULL, 'new', app.current_context_principal_id());
  ELSIF (sev_rank ->> p_severity)::int > (sev_rank ->> existing_severity)::int THEN
    UPDATE app.incident SET severity = p_severity, updated_at = clock_timestamp()
     WHERE tenant_id = t AND incident_id = existing_id;
  END IF;

  INSERT INTO app.incident_alert (tenant_id, incident_id, fleet_alert_id) VALUES (t, existing_id, p_fleet_alert_id)
    ON CONFLICT DO NOTHING;
  RETURN existing_id;
END; $$;

CREATE OR REPLACE FUNCTION app.acknowledge_incident(p_incident_id uuid, p_assign_to_principal_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE t uuid := app.current_context_tenant_id(); row app.incident%ROWTYPE; assignee uuid;
BEGIN
  PERFORM app.require_staff_role('staff');
  SELECT * INTO row FROM app.incident WHERE tenant_id = t AND incident_id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INCIDENT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF row.status NOT IN ('new','acknowledged') THEN RAISE EXCEPTION 'INCIDENT_STATE_INVALID' USING ERRCODE = 'P0001'; END IF;
  assignee := COALESCE(p_assign_to_principal_id, row.assigned_principal_id, app.current_context_principal_id());
  UPDATE app.incident SET status = 'acknowledged', acknowledged_at = COALESCE(acknowledged_at, clock_timestamp()),
         assigned_principal_id = assignee, updated_at = clock_timestamp()
   WHERE tenant_id = t AND incident_id = p_incident_id;
  INSERT INTO app.incident_status_event (tenant_id, incident_id, from_status, to_status, actor_principal_id)
    VALUES (t, p_incident_id, row.status, 'acknowledged', app.current_context_principal_id());
END; $$;

CREATE OR REPLACE FUNCTION app.start_incident_response(p_incident_id uuid, p_assign_to_principal_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE t uuid := app.current_context_tenant_id(); row app.incident%ROWTYPE; assignee uuid;
BEGIN
  PERFORM app.require_staff_role('staff');
  SELECT * INTO row FROM app.incident WHERE tenant_id = t AND incident_id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INCIDENT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF row.status NOT IN ('new','acknowledged','in_progress') THEN RAISE EXCEPTION 'INCIDENT_STATE_INVALID' USING ERRCODE = 'P0001'; END IF;
  assignee := COALESCE(p_assign_to_principal_id, row.assigned_principal_id, app.current_context_principal_id());
  UPDATE app.incident SET status = 'in_progress', in_progress_at = COALESCE(in_progress_at, clock_timestamp()),
         acknowledged_at = COALESCE(acknowledged_at, clock_timestamp()), assigned_principal_id = assignee, updated_at = clock_timestamp()
   WHERE tenant_id = t AND incident_id = p_incident_id;
  INSERT INTO app.incident_status_event (tenant_id, incident_id, from_status, to_status, actor_principal_id)
    VALUES (t, p_incident_id, row.status, 'in_progress', app.current_context_principal_id());
END; $$;

CREATE OR REPLACE FUNCTION app.resolve_incident(p_incident_id uuid, p_resolution_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE t uuid := app.current_context_tenant_id(); row app.incident%ROWTYPE;
BEGIN
  PERFORM app.require_staff_role('staff');
  IF length(btrim(COALESCE(p_resolution_reason,''))) = 0 THEN RAISE EXCEPTION 'INCIDENT_RESOLUTION_REASON_REQUIRED' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO row FROM app.incident WHERE tenant_id = t AND incident_id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INCIDENT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF row.status = 'resolved' THEN RAISE EXCEPTION 'INCIDENT_STATE_INVALID' USING ERRCODE = 'P0001'; END IF;
  UPDATE app.incident SET status = 'resolved', resolved_at = clock_timestamp(), resolution_reason = p_resolution_reason,
         assigned_principal_id = COALESCE(assigned_principal_id, app.current_context_principal_id()), updated_at = clock_timestamp()
   WHERE tenant_id = t AND incident_id = p_incident_id;
  INSERT INTO app.incident_status_event (tenant_id, incident_id, from_status, to_status, actor_principal_id, reason)
    VALUES (t, p_incident_id, row.status, 'resolved', app.current_context_principal_id(), p_resolution_reason);
END; $$;

CREATE OR REPLACE FUNCTION app.add_incident_note(p_incident_id uuid, p_body text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE t uuid := app.current_context_tenant_id(); note_id uuid := gen_random_uuid();
BEGIN
  PERFORM app.require_staff_role('staff');
  IF NOT EXISTS (SELECT 1 FROM app.incident WHERE tenant_id = t AND incident_id = p_incident_id) THEN
    RAISE EXCEPTION 'INCIDENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO app.incident_note (tenant_id, incident_note_id, incident_id, author_principal_id, body)
    VALUES (t, note_id, p_incident_id, app.current_context_principal_id(), p_body);
  RETURN note_id;
END; $$;

-- Wire automatic incident creation into the existing telemetry ingest path.
CREATE OR REPLACE FUNCTION app.ingest_telemetry_frame(p_id uuid,p_device uuid,p_at timestamptz,p_lat integer,p_lon integer,p_speed integer,p_fuel integer,p_hours bigint,p_raw jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=app,pg_catalog AS $$
DECLARE t uuid:=app.current_context_tenant_id();m uuid;v_alert_id uuid;
BEGIN
  PERFORM app.require_context('device');
  SELECT machine_id INTO m FROM app.device_installation WHERE tenant_id=t AND device_id=p_device AND removed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEVICE_NOT_BOUND' USING ERRCODE='P0001';END IF;
  INSERT INTO app.telemetry_frame VALUES(t,p_id,p_device,m,p_at,p_lat,p_lon,p_speed,p_fuel,p_hours,p_raw);
  IF EXISTS(SELECT 1 FROM app.operating_limit WHERE tenant_id=t AND active AND limit_kind='speed' AND limit_value<p_speed) THEN
    v_alert_id := gen_random_uuid();
    INSERT INTO app.fleet_alert VALUES(t,v_alert_id,m,'speeding','high',p_at,jsonb_build_object('speed_mph',p_speed));
    PERFORM app.open_or_attach_incident(v_alert_id, m, 'high');
  END IF;
  RETURN p_id;
END;$$;

DO $$ DECLARE x text;BEGIN FOREACH x IN ARRAY ARRAY['incident','incident_alert','incident_status_event','incident_note'] LOOP EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY;ALTER TABLE app.%I FORCE ROW LEVEL SECURITY;CREATE POLICY tenant_context_policy ON app.%I USING(tenant_id=app.current_context_tenant_id() AND app.context_is_valid()) WITH CHECK(tenant_id=app.current_context_tenant_id() AND app.context_is_valid())',x,x,x);END LOOP;END;$$;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.incident,app.incident_alert,app.incident_status_event,app.incident_note TO talus_fn;
REVOKE ALL ON app.incident,app.incident_alert,app.incident_status_event,app.incident_note FROM PUBLIC,talus_staff,talus_api,talus_device;

RESET ROLE;
