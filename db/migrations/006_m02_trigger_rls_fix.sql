-- M02 corrective migration: structural triggers must execute under the
-- invoking transaction identity so forced RLS sees the parent state.

SET ROLE talus_fn;

CREATE OR REPLACE FUNCTION app.m02_lock_item_parent()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = app, pg_catalog AS $$
DECLARE v_booking_id uuid := COALESCE(NEW.booking_id, OLD.booking_id); v_state text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.booking_id <> OLD.booking_id THEN RAISE EXCEPTION 'BOOKING_ITEM_REPARENT_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
  SELECT b.state INTO v_state FROM app.booking AS b WHERE b.tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND b.booking_id = v_booking_id FOR UPDATE;
  IF v_state IN ('closed', 'cancelled', 'no_show') THEN RAISE EXCEPTION 'TERMINAL_BOOKING_MUTATION_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'BOOKING_ITEM_DELETE_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
  UPDATE app.booking AS b SET item_set_revision = b.item_set_revision + 1 WHERE b.tenant_id = NEW.tenant_id AND b.booking_id = NEW.booking_id;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION app.m02_validate_closed_booking()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = app, pg_catalog AS $$
DECLARE v_tenant_id uuid := COALESCE(NEW.tenant_id, OLD.tenant_id); v_booking_id uuid := COALESCE(NEW.booking_id, OLD.booking_id); v_state text;
BEGIN
  SELECT b.state INTO v_state FROM app.booking AS b WHERE b.tenant_id = v_tenant_id AND b.booking_id = v_booking_id;
  IF v_state = 'closed' AND (
    NOT EXISTS (SELECT 1 FROM app.booking_item AS bi WHERE bi.tenant_id = v_tenant_id AND bi.booking_id = v_booking_id)
    OR EXISTS (SELECT 1 FROM app.booking_item AS bi WHERE bi.tenant_id = v_tenant_id AND bi.booking_id = v_booking_id AND bi.state NOT IN ('closed', 'cancelled', 'no_show'))
  ) THEN RAISE EXCEPTION 'BOOKING_CLOSE_BLOCKED' USING ERRCODE = 'P0001'; END IF;
  RETURN NULL;
END; $$;

CREATE OR REPLACE FUNCTION app.m02_terms_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = app, pg_catalog AS $$
BEGIN RAISE EXCEPTION 'TERMS_REVISION_IMMUTABLE' USING ERRCODE = 'P0001'; END; $$;

RESET ROLE;
