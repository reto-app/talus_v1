GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.pricing_revision TO talus_fn;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.price_line TO talus_fn;
CREATE OR REPLACE FUNCTION app.enforce_append_only() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=app,pg_catalog AS $$ BEGIN RAISE EXCEPTION 'Table % is strictly append-only. Updates and deletes are prohibited.',TG_TABLE_NAME USING ERRCODE='55000'; END; $$;
DROP TRIGGER IF EXISTS trg_pricing_revision_append_only ON app.pricing_revision;
CREATE TRIGGER trg_pricing_revision_append_only BEFORE UPDATE OR DELETE ON app.pricing_revision FOR EACH ROW EXECUTE FUNCTION app.enforce_append_only();
DROP TRIGGER IF EXISTS trg_price_line_append_only ON app.price_line;
CREATE TRIGGER trg_price_line_append_only BEFORE UPDATE OR DELETE ON app.price_line FOR EACH ROW EXECUTE FUNCTION app.enforce_append_only();
REVOKE ALL ON TABLE app.pricing_revision FROM talus_staff,talus_api,talus_customer,PUBLIC;
REVOKE ALL ON TABLE app.price_line FROM talus_staff,talus_api,talus_customer,PUBLIC;
