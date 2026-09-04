SET ROLE talus_fn;
CREATE OR REPLACE FUNCTION app.transition_machine_state(p_machine_id uuid,p_new_state text,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=app,pg_catalog AS $$
DECLARE t uuid:=app.current_context_tenant_id(); m app.machine%ROWTYPE;
BEGIN
  PERFORM app.require_staff_role('manager');
  SELECT * INTO m FROM app.machine WHERE tenant_id=t AND machine_id=p_machine_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF p_new_state NOT IN ('in_service','maintenance','offline','retired') OR p_new_state=m.operational_state THEN RAISE EXCEPTION 'INVALID_MACHINE_STATE_TRANSITION' USING ERRCODE='P0001'; END IF;
  UPDATE app.machine SET operational_state=p_new_state WHERE tenant_id=t AND machine_id=p_machine_id;
  INSERT INTO app.machine_state_change(tenant_id,machine_state_change_id,machine_id,previous_operational_state,new_operational_state,reason,actor_principal_id) VALUES(t,gen_random_uuid(),p_machine_id,m.operational_state,p_new_state,p_reason,app.current_context_principal_id());
  PERFORM app.append_audit('fleet.machine_state_changed','machine',p_machine_id,NULL,jsonb_build_object('from',m.operational_state,'to',p_new_state));
END; $$;
REVOKE ALL ON FUNCTION app.transition_machine_state(uuid,text,text) FROM PUBLIC,talus_api,talus_customer,talus_staff,talus_device;
RESET ROLE;
