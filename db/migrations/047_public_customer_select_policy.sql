DROP POLICY IF EXISTS public_fn_customer_select ON app.customer;
CREATE POLICY public_fn_customer_select ON app.customer FOR SELECT TO talus_public_fn
USING (tenant_id = NULLIF(current_setting('app.public_tenant_id', true), '')::uuid);
