-- Explicit runtime permissions for SECURITY DEFINER pricing operations.
GRANT USAGE ON SCHEMA app TO talus_fn;
GRANT SELECT, INSERT ON TABLE app.pricing_revision, app.price_line, app.promo_code, app.promo_redemption TO talus_fn;
REVOKE UPDATE, DELETE ON TABLE app.pricing_revision, app.price_line FROM PUBLIC, talus_fn, talus_api, talus_customer, talus_staff, talus_device;

DROP POLICY IF EXISTS tenant_context_policy ON app.pricing_revision;
DROP POLICY IF EXISTS tenant_context_policy ON app.price_line;
DROP POLICY IF EXISTS tenant_context_policy ON app.promo_code;
DROP POLICY IF EXISTS tenant_context_policy ON app.promo_redemption;
CREATE POLICY tenant_context_policy ON app.pricing_revision USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid()) WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid());
CREATE POLICY tenant_context_policy ON app.price_line USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid()) WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid());
CREATE POLICY tenant_context_policy ON app.promo_code USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid()) WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid());
CREATE POLICY tenant_context_policy ON app.promo_redemption USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid()) WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid());
