-- Policies must be defined by the table owner; the public function remains
-- owned by the constrained non-login execution role.
SET ROLE talus_fn;
DROP POLICY IF EXISTS public_token_hash_select ON app.customer_booking_access_token;
CREATE POLICY public_token_hash_select ON app.customer_booking_access_token FOR SELECT TO talus_public_fn USING(encode(token_hash,'hex')=NULLIF(current_setting('talus.public_token_hash',true),'') AND expires_at>clock_timestamp() AND used_at IS NULL);
RESET ROLE;
SET ROLE talus_public_fn;
CREATE OR REPLACE FUNCTION app.public_waiver_context(p_token uuid) RETURNS TABLE(booking_item_id uuid,customer_name text,vehicle_name text,waiver_text text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=app,pg_catalog AS $$ DECLARE v_hash text:=encode(public.digest(p_token::text,'sha256'),'hex');v_tenant uuid;BEGIN PERFORM set_config('talus.public_token_hash',v_hash,true);SELECT tenant_id INTO v_tenant FROM app.customer_booking_access_token LIMIT 1;IF v_tenant IS NULL THEN RAISE EXCEPTION 'WAIVER_ACCESS_INVALID' USING ERRCODE='P0001';END IF;PERFORM set_config('app.public_tenant_id',v_tenant::text,true);PERFORM set_config('talus.public_catalog_tenant_id',v_tenant::text,true);RETURN QUERY SELECT a.booking_item_id,c.display_name,COALESCE(p.display_name,'Side-by-Side'),'Standard Powersports Liability & Damage Waiver v1.0' FROM app.customer_booking_access_token a JOIN app.customer c ON c.tenant_id=a.tenant_id AND c.customer_id=a.customer_id JOIN app.booking_item_terms_revision it ON it.tenant_id=a.tenant_id AND it.booking_item_id=a.booking_item_id JOIN app.rental_product p ON p.tenant_id=it.tenant_id AND p.category_location_id=it.category_location_id ORDER BY it.revision_number DESC LIMIT 1;END;$$;
RESET ROLE;
