REVOKE ALL ON TABLE app.pricing_revision FROM PUBLIC;
REVOKE ALL ON TABLE app.price_line FROM PUBLIC;
GRANT SELECT (tenant_id, pricing_revision_id) ON TABLE app.pricing_revision TO talus_staff, talus_api;
DROP POLICY IF EXISTS pricing_revision_tenant_select ON app.pricing_revision;
CREATE POLICY pricing_revision_tenant_select ON app.pricing_revision FOR SELECT TO talus_staff, talus_api, talus_fn USING (tenant_id = app.talus_setting_uuid('talus.tenant_id'));
REVOKE INSERT, UPDATE, DELETE ON TABLE app.pricing_revision, app.price_line FROM talus_staff, talus_api, talus_customer, talus_staff, talus_device;
