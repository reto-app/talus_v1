-- M01 corrective migration: context validation reads only the private assertion
-- table. Reading app.principal here would recurse through that table's forced
-- RLS policy, which itself invokes app.context_is_valid().

SET ROLE talus_fn;

CREATE OR REPLACE FUNCTION app.context_is_valid()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
DECLARE
  v_token text := current_setting('app.context_token', true);
  v_assertion_id uuid := NULLIF(current_setting('app.context_assertion_id', true), '')::uuid;
BEGIN
  IF v_token IS NULL OR v_assertion_id IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1
    FROM app.request_context_assertion AS a
    WHERE a.assertion_id = v_assertion_id
      AND a.token_hash = public.digest(v_token, 'sha256')
      AND a.expires_at > clock_timestamp()
      AND a.revoked_at IS NULL
      AND a.tenant_id = app.current_context_tenant_id()
      AND a.principal_id = app.current_context_principal_id()
      AND a.caller_class = app.current_context_caller_class()
      AND COALESCE(a.asserted_staff_role::text, '') = COALESCE(current_setting('app.staff_role', true), '')
  );
END; $$;

RESET ROLE;
