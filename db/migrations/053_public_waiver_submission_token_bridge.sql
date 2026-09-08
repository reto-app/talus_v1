-- Establish the token scope before any protected token, policy, or waiver
-- access.  The update policy permits consuming only the matched token.
SET ROLE talus_fn;

DROP POLICY IF EXISTS public_token_hash_update ON app.customer_booking_access_token;
CREATE POLICY public_token_hash_update
  ON app.customer_booking_access_token
  FOR UPDATE TO talus_public_fn
  USING (
    encode(token_hash, 'hex') = NULLIF(current_setting('talus.public_token_hash', true), '')
    AND expires_at > clock_timestamp()
    AND used_at IS NULL
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.public_tenant_id', true), '')::uuid
    AND encode(token_hash, 'hex') = NULLIF(current_setting('talus.public_token_hash', true), '')
  );

DROP POLICY IF EXISTS tenant_waiver_policy_public_select ON app.tenant_waiver_policy;
CREATE POLICY tenant_waiver_policy_public_select
  ON app.tenant_waiver_policy
  FOR SELECT TO talus_public_fn
  USING (tenant_id = NULLIF(current_setting('app.public_tenant_id', true), '')::uuid);

GRANT CREATE ON SCHEMA app TO talus_public_fn;
RESET ROLE;
SET ROLE talus_public_fn;

CREATE OR REPLACE FUNCTION app.submit_public_waiver(
  p_token uuid,
  p_name text,
  p_signature text,
  p_ip inet
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
DECLARE
  v_hash text := encode(public.digest(p_token::text, 'sha256'), 'hex');
  access_token app.customer_booking_access_token%ROWTYPE;
  waiver_policy_id uuid;
  waiver_id uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('talus.public_token_hash', v_hash, true);

  SELECT token.*
    INTO access_token
    FROM app.customer_booking_access_token AS token
   WHERE encode(token.token_hash, 'hex') = v_hash
     AND token.expires_at > clock_timestamp()
     AND token.used_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WAIVER_ACCESS_INVALID' USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.public_tenant_id', access_token.tenant_id::text, true);
  PERFORM set_config('talus.public_catalog_tenant_id', access_token.tenant_id::text, true);

  SELECT policy.tenant_waiver_policy_id
    INTO waiver_policy_id
    FROM app.tenant_waiver_policy AS policy
   WHERE policy.tenant_id = access_token.tenant_id
   ORDER BY policy.version_number DESC
   LIMIT 1;

  IF waiver_policy_id IS NULL
     OR length(btrim(p_name)) = 0
     OR length(btrim(p_signature)) = 0 THEN
    RAISE EXCEPTION 'WAIVER_INPUT_INVALID' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO app.executed_waiver (
    tenant_id, executed_waiver_id, customer_id, booking_item_id,
    waiver_policy_version_id, signed_at, signer_name, signer_ip,
    signature_ref, agreement_hash
  ) VALUES (
    access_token.tenant_id, waiver_id, access_token.customer_id,
    access_token.booking_item_id, waiver_policy_id, clock_timestamp(),
    p_name, p_ip, p_signature,
    encode(public.digest(p_signature, 'sha256'), 'hex')
  );

  UPDATE app.customer_booking_access_token AS token
     SET used_at = clock_timestamp()
   WHERE token.tenant_id = access_token.tenant_id
     AND token.customer_booking_access_token_id = access_token.customer_booking_access_token_id;

  RETURN waiver_id;
END;
$$;

RESET ROLE;
SET ROLE talus_fn;
REVOKE CREATE ON SCHEMA app FROM talus_public_fn;
RESET ROLE;
