SET ROLE talus_fn;
CREATE OR REPLACE FUNCTION app.authorize_booking_deposit_hold(p_item uuid,p_amount bigint,p_reference text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=app,pg_catalog AS $$
DECLARE t uuid:=app.current_context_tenant_id(); cash_id uuid; held_id uuid; entry_id uuid:=gen_random_uuid(); existing_entry_id uuid;
BEGIN
  PERFORM app.require_staff_role('staff');
  SELECT journal_entry_id INTO existing_entry_id FROM app.booking_item_deposit_hold WHERE tenant_id=t AND booking_item_id=p_item;
  IF FOUND THEN RETURN existing_entry_id; END IF;
  IF p_amount<=0 OR NOT EXISTS(SELECT 1 FROM app.booking_item WHERE tenant_id=t AND booking_item_id=p_item) THEN RAISE EXCEPTION 'DEPOSIT_HOLD_INPUT_INVALID' USING ERRCODE='P0001'; END IF;
  SELECT ledger_account_id INTO cash_id FROM app.ledger_account WHERE tenant_id=t AND account_code='cash';
  SELECT ledger_account_id INTO held_id FROM app.ledger_account WHERE tenant_id=t AND account_code='deposits_held';
  IF cash_id IS NULL OR held_id IS NULL THEN RAISE EXCEPTION 'DEPOSIT_ACCOUNTS_NOT_CONFIGURED' USING ERRCODE='P0001'; END IF;
  SELECT app.record_deposit_hold(entry_id,p_reference,cash_id,held_id,p_amount) INTO entry_id;
  INSERT INTO app.booking_item_deposit_hold(tenant_id,booking_item_id,journal_entry_id,amount_cents) VALUES(t,p_item,entry_id,p_amount);
  PERFORM app.append_audit('booking_item.deposit_authorized','booking_item',p_item,NULL,jsonb_build_object('journal_entry_id',entry_id,'amount_cents',p_amount));
  RETURN entry_id;
END; $$;
RESET ROLE;
