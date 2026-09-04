SET ROLE talus_fn;

CREATE TABLE app.booking_item_deposit_hold (
  tenant_id uuid NOT NULL,
  booking_item_id uuid NOT NULL,
  journal_entry_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, booking_item_id),
  UNIQUE (tenant_id, journal_entry_id),
  FOREIGN KEY (tenant_id, booking_item_id) REFERENCES app.booking_item(tenant_id, booking_item_id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES app.journal_entry(tenant_id, journal_entry_id)
);
CREATE TRIGGER booking_item_deposit_hold_append BEFORE UPDATE OR DELETE ON app.booking_item_deposit_hold FOR EACH ROW EXECUTE FUNCTION app.enforce_append_only();
ALTER TABLE app.booking_item_deposit_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.booking_item_deposit_hold FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_context_policy ON app.booking_item_deposit_hold USING(tenant_id=app.current_context_tenant_id() AND app.context_is_valid()) WITH CHECK(tenant_id=app.current_context_tenant_id() AND app.context_is_valid());

CREATE OR REPLACE FUNCTION app.authorize_booking_deposit_hold(p_item uuid,p_amount bigint,p_reference text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=app,pg_catalog AS $$
DECLARE t uuid:=app.current_context_tenant_id(); cash_id uuid; held_id uuid; entry_id uuid:=gen_random_uuid();
BEGIN
  PERFORM app.require_staff_role('staff');
  SELECT journal_entry_id INTO entry_id FROM app.booking_item_deposit_hold WHERE tenant_id=t AND booking_item_id=p_item;
  IF FOUND THEN RETURN entry_id; END IF;
  IF p_amount<=0 OR NOT EXISTS(SELECT 1 FROM app.booking_item WHERE tenant_id=t AND booking_item_id=p_item) THEN RAISE EXCEPTION 'DEPOSIT_HOLD_INPUT_INVALID' USING ERRCODE='P0001'; END IF;
  SELECT ledger_account_id INTO cash_id FROM app.ledger_account WHERE tenant_id=t AND account_code='cash';
  SELECT ledger_account_id INTO held_id FROM app.ledger_account WHERE tenant_id=t AND account_code='deposits_held';
  IF cash_id IS NULL OR held_id IS NULL THEN RAISE EXCEPTION 'DEPOSIT_ACCOUNTS_NOT_CONFIGURED' USING ERRCODE='P0001'; END IF;
  SELECT app.record_deposit_hold(entry_id,p_reference,cash_id,held_id,p_amount) INTO entry_id;
  INSERT INTO app.booking_item_deposit_hold(tenant_id,booking_item_id,journal_entry_id,amount_cents) VALUES(t,p_item,entry_id,p_amount);
  PERFORM app.append_audit('booking_item.deposit_authorized','booking_item',p_item,NULL,jsonb_build_object('journal_entry_id',entry_id,'amount_cents',p_amount));
  RETURN entry_id;
END; $$;

CREATE OR REPLACE FUNCTION app.create_completed_inspection(p_item uuid,p_machine uuid,p_trip uuid,p_type text,p_fuel integer,p_odometer bigint,p_notes text,p_items jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=app,pg_catalog AS $$
DECLARE t uuid:=app.current_context_tenant_id(); inspection_id uuid:=gen_random_uuid(); item jsonb;
BEGIN
  PERFORM app.require_staff_role('staff');
  IF p_type NOT IN ('outbound','inbound') OR p_items IS NULL OR jsonb_typeof(p_items)<>'array' THEN RAISE EXCEPTION 'INSPECTION_INPUT_INVALID' USING ERRCODE='P0001'; END IF;
  PERFORM app.start_inspection(inspection_id,p_item,p_trip,p_machine,p_type);
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO app.inspection_item(tenant_id,inspection_item_id,inspection_id,component_name,condition,notes)
    VALUES(t,gen_random_uuid(),inspection_id,item->>'item',CASE WHEN COALESCE((item->>'passed')::boolean,false) THEN 'pass' ELSE 'fail' END,COALESCE(item->>'notes',p_notes,''));
  END LOOP;
  PERFORM app.complete_inspection(inspection_id,p_fuel,p_odometer);
  RETURN inspection_id;
END; $$;

GRANT SELECT,INSERT,UPDATE,DELETE ON app.booking_item_deposit_hold TO talus_fn;
REVOKE ALL ON app.booking_item_deposit_hold FROM PUBLIC,talus_staff,talus_api,talus_customer;
REVOKE ALL ON FUNCTION app.authorize_booking_deposit_hold(uuid,bigint,text),app.create_completed_inspection(uuid,uuid,uuid,text,integer,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.authorize_booking_deposit_hold(uuid,bigint,text),app.create_completed_inspection(uuid,uuid,uuid,text,integer,bigint,text,jsonb) TO talus_staff,talus_api;
RESET ROLE;
