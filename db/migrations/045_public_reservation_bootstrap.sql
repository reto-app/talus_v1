GRANT talus_public_fn TO talus_fn;
SET ROLE talus_fn;
CREATE OR REPLACE FUNCTION app.create_public_reservation(p_tenant_id uuid,p_customer uuid,p_category_location uuid,p_start timestamptz,p_end timestamptz) RETURNS TABLE(booking_id uuid,booking_item_id uuid,access_token uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=app,pg_catalog AS $$ BEGIN PERFORM set_config('talus.public_reservation_active','true',true);PERFORM set_config('talus.public_catalog_tenant_id',p_tenant_id::text,true);PERFORM set_config('app.public_tenant_id',p_tenant_id::text,true);IF NOT EXISTS(SELECT 1 FROM app.category_location WHERE tenant_id=p_tenant_id AND category_location_id=p_category_location AND active) THEN RAISE EXCEPTION 'PUBLIC_RESERVATION_UNAUTHORIZED' USING ERRCODE='P0001';END IF;RETURN QUERY SELECT * FROM app.create_public_reservation(p_customer,p_category_location,p_start,p_end);END;$$;
ALTER FUNCTION app.create_public_reservation(uuid,uuid,uuid,timestamptz,timestamptz) OWNER TO talus_public_fn;
REVOKE ALL ON FUNCTION app.create_public_reservation(uuid,uuid,uuid,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_public_reservation(uuid,uuid,uuid,timestamptz,timestamptz) TO talus_api;
RESET ROLE;
