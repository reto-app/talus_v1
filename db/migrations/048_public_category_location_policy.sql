GRANT SELECT ON app.category_location TO talus_public_fn;
DROP POLICY IF EXISTS category_location_public_select ON app.category_location;
CREATE POLICY category_location_public_select ON app.category_location FOR SELECT TO talus_public_fn
USING (tenant_id = NULLIF(current_setting('talus.public_catalog_tenant_id', true), '')::uuid OR current_setting('talus.public_reservation_active', true) = 'true');
