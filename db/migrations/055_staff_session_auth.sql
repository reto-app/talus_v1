-- Real staff credential + session issuance, replacing reliance on the demo
-- bootstrap route for ordinary production use. Password verification happens
-- inside Postgres (pgcrypto blowfish hashing) using the same
-- app.request_context_assertion token mechanism the rest of the system
-- already trusts, so no parallel auth system is introduced.
SET ROLE talus_fn;

CREATE TABLE app.staff_credential (
  tenant_id uuid NOT NULL,
  staff_user_id uuid NOT NULL,
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, staff_user_id),
  FOREIGN KEY (tenant_id, staff_user_id) REFERENCES app.staff_user (tenant_id, staff_user_id)
);
ALTER TABLE app.staff_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.staff_credential FORCE ROW LEVEL SECURITY;
-- Mirrors app.request_context_assertion's private_assertion_policy: this
-- table must be readable by app.authenticate_staff() BEFORE any tenant
-- context exists (that is the whole point of logging in), so its policy is
-- keyed on the executing role (always talus_fn, via SECURITY DEFINER) rather
-- than app.context_is_valid(). No other role is ever granted access to it.
CREATE POLICY staff_credential_owner_policy ON app.staff_credential
  USING (current_user = 'talus_fn') WITH CHECK (current_user = 'talus_fn');
GRANT SELECT, INSERT, UPDATE, DELETE ON app.staff_credential TO talus_fn;
REVOKE ALL ON app.staff_credential FROM PUBLIC, talus_staff, talus_api, talus_device;

CREATE OR REPLACE FUNCTION app.set_staff_password(p_staff_user_id uuid, p_new_password text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public, pg_catalog AS $$
DECLARE t uuid := app.current_context_tenant_id();
BEGIN
  PERFORM app.require_staff_role('manager');
  IF length(p_new_password) < 10 THEN RAISE EXCEPTION 'PASSWORD_TOO_SHORT' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.staff_user WHERE tenant_id = t AND staff_user_id = p_staff_user_id) THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO app.staff_credential (tenant_id, staff_user_id, password_hash)
    VALUES (t, p_staff_user_id, crypt(p_new_password, gen_salt('bf')))
  ON CONFLICT (tenant_id, staff_user_id)
    DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change_password = false, updated_at = clock_timestamp();
END; $$;

-- Authenticates by tenant slug + email + password and mints a session token.
-- This is the only place a raw password is ever compared; the digest that
-- backs app.request_context_assertion is unaffected. Session lifetime is
-- capped well above app.issue_context_assertion's 15-minute assertion
-- lifetime so a staff member is not forced to re-authenticate mid-shift.
CREATE OR REPLACE FUNCTION app.authenticate_staff(p_tenant_slug text, p_email text, p_password text, p_lifetime interval DEFAULT interval '12 hours')
RETURNS TABLE (token uuid, tenant_id uuid, tenant_display_name text, principal_id uuid, staff_user_id uuid, staff_role app.staff_role, display_name text, must_change_password boolean, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public, pg_catalog AS $$
DECLARE
  v_tenant app.tenant%ROWTYPE;
  v_staff_user app.staff_user%ROWTYPE;
  v_credential app.staff_credential%ROWTYPE;
  v_membership app.staff_membership%ROWTYPE;
  v_token uuid := gen_random_uuid();
  v_expires_at timestamptz;
BEGIN
  IF p_lifetime <= interval '0 seconds' OR p_lifetime > interval '12 hours' THEN
    RAISE EXCEPTION 'INVALID_SESSION_LIFETIME' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_tenant FROM app.tenant t WHERE t.slug = lower(btrim(p_tenant_slug)) AND t.retired_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_CREDENTIALS' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_staff_user FROM app.staff_user su
   WHERE su.tenant_id = v_tenant.tenant_id AND su.email = lower(btrim(p_email)) AND su.retired_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_CREDENTIALS' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_credential FROM app.staff_credential sc
   WHERE sc.tenant_id = v_tenant.tenant_id AND sc.staff_user_id = v_staff_user.staff_user_id;
  IF NOT FOUND OR v_credential.password_hash <> crypt(p_password, v_credential.password_hash) THEN
    RAISE EXCEPTION 'INVALID_CREDENTIALS' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_membership FROM app.staff_membership m
   WHERE m.tenant_id = v_tenant.tenant_id AND m.staff_user_id = v_staff_user.staff_user_id
     AND m.active_from <= clock_timestamp() AND (m.active_until IS NULL OR m.active_until > clock_timestamp())
   ORDER BY CASE m.role WHEN 'owner' THEN 3 WHEN 'manager' THEN 2 ELSE 1 END DESC
   LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_ACCESS_REVOKED' USING ERRCODE = 'P0001'; END IF;

  v_expires_at := clock_timestamp() + p_lifetime;
  INSERT INTO app.request_context_assertion (tenant_id, principal_id, caller_class, asserted_staff_role, is_bootstrap, token_hash, expires_at)
  VALUES (v_tenant.tenant_id, v_membership.principal_id, 'staff', v_membership.role, false, digest(v_token::text, 'sha256'), v_expires_at);

  RETURN QUERY SELECT v_token, v_tenant.tenant_id, v_tenant.display_name, v_membership.principal_id, v_staff_user.staff_user_id,
    v_membership.role, v_staff_user.display_name, v_credential.must_change_password, v_expires_at;
END; $$;

-- Sliding renewal: requires an already-active, still-valid context (checked
-- by api.activate_request_context before this runs) and mints a fresh token
-- for the same principal so a long shift does not require re-entering a
-- password every 15 minutes, while the DB-side assertion lifetime stays capped.
CREATE OR REPLACE FUNCTION app.refresh_staff_session(p_lifetime interval DEFAULT interval '12 hours')
RETURNS TABLE (token uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, public, pg_catalog AS $$
DECLARE t uuid; p uuid; v_token uuid := gen_random_uuid(); v_expires_at timestamptz; v_role app.staff_role;
BEGIN
  PERFORM app.require_staff_role('staff');
  IF p_lifetime <= interval '0 seconds' OR p_lifetime > interval '12 hours' THEN
    RAISE EXCEPTION 'INVALID_SESSION_LIFETIME' USING ERRCODE = '22023';
  END IF;
  t := app.current_context_tenant_id();
  p := app.current_context_principal_id();
  v_role := NULLIF(current_setting('app.staff_role', true), '')::app.staff_role;
  v_expires_at := clock_timestamp() + p_lifetime;
  INSERT INTO app.request_context_assertion (tenant_id, principal_id, caller_class, asserted_staff_role, is_bootstrap, token_hash, expires_at)
  VALUES (t, p, 'staff', v_role, false, digest(v_token::text, 'sha256'), v_expires_at);
  RETURN QUERY SELECT v_token, v_expires_at;
END; $$;

CREATE OR REPLACE FUNCTION app.logout_staff_session()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE v_assertion_id uuid := NULLIF(current_setting('app.context_assertion_id', true), '')::uuid;
BEGIN
  PERFORM app.require_context('staff');
  UPDATE app.request_context_assertion SET revoked_at = clock_timestamp()
   WHERE assertion_id = v_assertion_id AND revoked_at IS NULL;
END; $$;

GRANT EXECUTE ON FUNCTION app.authenticate_staff(text, text, text, interval) TO talus_api;
GRANT EXECUTE ON FUNCTION app.refresh_staff_session(interval) TO talus_api;
GRANT EXECUTE ON FUNCTION app.logout_staff_session() TO talus_api;

RESET ROLE;
