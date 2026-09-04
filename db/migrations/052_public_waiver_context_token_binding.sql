-- The context function must use the validated token row in its result query,
-- rather than any token visible for the now-scoped tenant.
SET ROLE talus_public_fn;

CREATE OR REPLACE FUNCTION app.public_waiver_context(p_token uuid)
RETURNS TABLE (
  booking_item_id uuid,
  customer_name text,
  vehicle_name text,
  waiver_text text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
DECLARE
  v_hash text := encode(public.digest(p_token::text, 'sha256'), 'hex');
  v_tenant uuid;
BEGIN
  PERFORM set_config('talus.public_token_hash', v_hash, true);

  SELECT token.tenant_id
    INTO v_tenant
    FROM app.customer_booking_access_token AS token
   WHERE encode(token.token_hash, 'hex') = v_hash
     AND token.expires_at > clock_timestamp()
     AND token.used_at IS NULL;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'WAIVER_ACCESS_INVALID' USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.public_tenant_id', v_tenant::text, true);
  PERFORM set_config('talus.public_catalog_tenant_id', v_tenant::text, true);

  RETURN QUERY
  SELECT token.booking_item_id,
         customer.display_name,
         COALESCE(product.display_name, 'Side-by-Side'),
         'Standard Powersports Liability & Damage Waiver v1.0'
    FROM app.customer_booking_access_token AS token
    JOIN app.customer AS customer
      ON customer.tenant_id = token.tenant_id
     AND customer.customer_id = token.customer_id
    JOIN app.booking_item_terms_revision AS item_terms
      ON item_terms.tenant_id = token.tenant_id
     AND item_terms.booking_item_id = token.booking_item_id
    JOIN app.rental_product AS product
      ON product.tenant_id = item_terms.tenant_id
     AND product.category_location_id = item_terms.category_location_id
   WHERE encode(token.token_hash, 'hex') = v_hash
     AND token.expires_at > clock_timestamp()
     AND token.used_at IS NULL
   ORDER BY item_terms.revision_number DESC
   LIMIT 1;
END;
$$;

RESET ROLE;
