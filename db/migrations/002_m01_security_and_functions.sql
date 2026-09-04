SET ROLE talus_fn;

CREATE OR REPLACE FUNCTION app.current_context_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_context_principal_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.principal_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_context_caller_class()
RETURNS app.caller_class LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.caller_class', true), '')::app.caller_class
$$;

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
    SELECT 1 FROM app.request_context_assertion a
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

CREATE OR REPLACE FUNCTION app.require_context(required_class app.caller_class DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
BEGIN
  IF NOT app.context_is_valid() THEN
    RAISE EXCEPTION 'AUTHENTICATION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF required_class IS NOT NULL AND app.current_context_caller_class() <> required_class THEN
    RAISE EXCEPTION 'ACTION_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
END; $$;

CREATE OR REPLACE FUNCTION app.require_staff_role(required_role app.staff_role)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
DECLARE
  v_current_staff_role app.staff_role := NULLIF(current_setting('app.staff_role', true), '')::app.staff_role;
BEGIN
  PERFORM app.require_context('staff');
  IF v_current_staff_role IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM app.staff_membership m
       WHERE m.tenant_id = app.current_context_tenant_id()
         AND m.principal_id = app.current_context_principal_id()
         AND m.role = v_current_staff_role
         AND m.active_from <= clock_timestamp()
         AND (m.active_until IS NULL OR m.active_until > clock_timestamp())
     )
     OR (required_role = 'owner' AND v_current_staff_role <> 'owner')
     OR (required_role = 'manager' AND v_current_staff_role NOT IN ('owner', 'manager'))
     OR (required_role = 'staff' AND v_current_staff_role NOT IN ('owner', 'manager', 'staff'))
  THEN RAISE EXCEPTION 'ACTION_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
END; $$;

ALTER TABLE app.tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant FORCE ROW LEVEL SECURITY;
ALTER TABLE app.location ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.location FORCE ROW LEVEL SECURITY;
ALTER TABLE app.staff_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.staff_user FORCE ROW LEVEL SECURITY;
ALTER TABLE app.customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.customer FORCE ROW LEVEL SECURITY;
ALTER TABLE app.principal ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.principal FORCE ROW LEVEL SECURITY;
ALTER TABLE app.staff_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.staff_membership FORCE ROW LEVEL SECURITY;
ALTER TABLE app.access_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.access_session FORCE ROW LEVEL SECURITY;
ALTER TABLE app.audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_event FORCE ROW LEVEL SECURITY;
ALTER TABLE app.operation_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.operation_claim FORCE ROW LEVEL SECURITY;
ALTER TABLE app.job_lease ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.job_lease FORCE ROW LEVEL SECURITY;
ALTER TABLE app.request_context_assertion ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.request_context_assertion FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_context_policy ON app.tenant;
CREATE POLICY tenant_context_policy ON app.tenant
  USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid())
  WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid());

DROP POLICY IF EXISTS tenant_context_policy ON app.location;
CREATE POLICY tenant_context_policy ON app.location
  USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid())
  WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid());
DROP POLICY IF EXISTS tenant_context_policy ON app.staff_user;
CREATE POLICY tenant_context_policy ON app.staff_user
  USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid())
  WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid());
DROP POLICY IF EXISTS tenant_context_policy ON app.customer;
CREATE POLICY tenant_context_policy ON app.customer
  USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid())
  WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid());
DROP POLICY IF EXISTS tenant_context_policy ON app.principal;
CREATE POLICY tenant_context_policy ON app.principal
  USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid())
  WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid());
DROP POLICY IF EXISTS tenant_context_policy ON app.staff_membership;
CREATE POLICY tenant_context_policy ON app.staff_membership
  USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid())
  WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid());
DROP POLICY IF EXISTS tenant_context_policy ON app.access_session;
CREATE POLICY tenant_context_policy ON app.access_session
  USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid())
  WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid());
DROP POLICY IF EXISTS tenant_context_policy ON app.audit_event;
CREATE POLICY tenant_context_policy ON app.audit_event
  USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid())
  WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid());
DROP POLICY IF EXISTS tenant_context_policy ON app.operation_claim;
CREATE POLICY tenant_context_policy ON app.operation_claim
  USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid())
  WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid());
DROP POLICY IF EXISTS tenant_context_policy ON app.job_lease;
CREATE POLICY tenant_context_policy ON app.job_lease
  USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid())
  WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid());
DROP POLICY IF EXISTS private_assertion_policy ON app.request_context_assertion;
CREATE POLICY private_assertion_policy ON app.request_context_assertion
  USING (current_user = 'talus_fn') WITH CHECK (current_user = 'talus_fn');

CREATE OR REPLACE FUNCTION app.issue_context_assertion(
  p_tenant_id uuid, p_principal_id uuid, p_caller_class app.caller_class,
  p_staff_role app.staff_role, p_lifetime interval
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE v_token uuid := gen_random_uuid();
BEGIN
  IF p_lifetime <= interval '0 seconds' OR p_lifetime > interval '15 minutes' THEN
    RAISE EXCEPTION 'INVALID_ASSERTION_LIFETIME' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.request_context_assertion
    (tenant_id, principal_id, caller_class, asserted_staff_role, is_bootstrap, token_hash, expires_at)
  VALUES (p_tenant_id, p_principal_id, p_caller_class, p_staff_role, false, public.digest(v_token::text, 'sha256'), clock_timestamp() + p_lifetime);
  RETURN v_token;
END; $$;

CREATE OR REPLACE FUNCTION api.activate_request_context(p_token uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, api, pg_catalog AS $$
DECLARE v_assertion app.request_context_assertion%ROWTYPE;
BEGIN
  SELECT a.* INTO v_assertion FROM app.request_context_assertion AS a
   WHERE a.token_hash = public.digest(p_token::text, 'sha256') AND a.revoked_at IS NULL AND a.expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED' USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('app.context_assertion_id', v_assertion.assertion_id::text, true);
  PERFORM set_config('app.context_token', p_token::text, true);
  PERFORM set_config('app.tenant_id', v_assertion.tenant_id::text, true);
  PERFORM set_config('app.principal_id', v_assertion.principal_id::text, true);
  PERFORM set_config('app.caller_class', v_assertion.caller_class::text, true);
  PERFORM set_config('app.staff_role', COALESCE(v_assertion.asserted_staff_role::text, ''), true);
END; $$;

CREATE OR REPLACE FUNCTION app.append_audit(
  p_action text, p_resource_type text, p_resource_id uuid, p_operation_id uuid DEFAULT NULL,
  p_details jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE v_event_id uuid;
BEGIN
  PERFORM app.require_context();
  INSERT INTO app.audit_event AS ae (tenant_id, actor_principal_id, action, resource_type, resource_id, operation_id, details)
  VALUES (app.current_context_tenant_id(), app.current_context_principal_id(), p_action, p_resource_type, p_resource_id, p_operation_id, p_details)
  RETURNING ae.audit_event_id INTO v_event_id;
  RETURN v_event_id;
END; $$;

CREATE OR REPLACE FUNCTION app.onboard_tenant(
  p_tenant_id uuid, p_slug text, p_display_name text, p_staff_user_id uuid, p_owner_principal_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE v_bootstrap_token uuid := gen_random_uuid(); v_bootstrap_assertion uuid;
BEGIN
  INSERT INTO app.request_context_assertion AS a
    (tenant_id, principal_id, caller_class, asserted_staff_role, is_bootstrap, token_hash, expires_at)
  VALUES (p_tenant_id, p_owner_principal_id, 'staff', 'owner', true, public.digest(v_bootstrap_token::text, 'sha256'), clock_timestamp() + interval '1 minute')
  RETURNING a.assertion_id INTO v_bootstrap_assertion;
  PERFORM set_config('app.context_assertion_id', v_bootstrap_assertion::text, true);
  PERFORM set_config('app.context_token', v_bootstrap_token::text, true);
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  PERFORM set_config('app.principal_id', p_owner_principal_id::text, true);
  PERFORM set_config('app.caller_class', 'staff', true);
  PERFORM set_config('app.staff_role', 'owner', true);
  INSERT INTO app.tenant (tenant_id, slug, display_name) VALUES (p_tenant_id, p_slug, p_display_name);
  INSERT INTO app.staff_user (tenant_id, staff_user_id, display_name, email)
    VALUES (p_tenant_id, p_staff_user_id, 'Initial owner', lower(p_slug) || '@bootstrap.invalid');
  INSERT INTO app.principal (tenant_id, principal_id, caller_class, staff_user_id)
    VALUES (p_tenant_id, p_owner_principal_id, 'staff', p_staff_user_id);
  INSERT INTO app.staff_membership (tenant_id, staff_user_id, principal_id, role)
    VALUES (p_tenant_id, p_staff_user_id, p_owner_principal_id, 'owner');
  PERFORM app.append_audit('tenant.onboarded', 'tenant', p_tenant_id, NULL, jsonb_build_object('slug', p_slug));
  UPDATE app.request_context_assertion AS a SET revoked_at = clock_timestamp() WHERE a.assertion_id = v_bootstrap_assertion;
  RETURN p_tenant_id;
END; $$;

CREATE OR REPLACE FUNCTION api.begin_operation(p_idempotency_key text, p_semantic_hash text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, api, pg_catalog AS $$
DECLARE v_existing app.operation_claim%ROWTYPE;
BEGIN
  PERFORM app.require_context();
  INSERT INTO app.operation_claim (tenant_id, principal_id, idempotency_key, semantic_hash)
  VALUES (app.current_context_tenant_id(), app.current_context_principal_id(), p_idempotency_key, p_semantic_hash)
  ON CONFLICT (tenant_id, principal_id, idempotency_key) DO NOTHING;
  SELECT oc.* INTO v_existing FROM app.operation_claim AS oc
   WHERE oc.tenant_id = app.current_context_tenant_id() AND oc.principal_id = app.current_context_principal_id() AND oc.idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF v_existing.semantic_hash <> p_semantic_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = 'P0001'; END IF;
  RETURN v_existing.operation_id;
END; $$;

CREATE OR REPLACE FUNCTION api.create_customer(
  p_customer_id uuid, p_principal_id uuid, p_display_name text, p_email text,
  p_idempotency_key text, p_semantic_hash text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, api, pg_catalog AS $$
DECLARE v_operation_id uuid;
DECLARE v_status app.operation_status;
BEGIN
  PERFORM app.require_staff_role('staff');
  v_operation_id := api.begin_operation(p_idempotency_key, p_semantic_hash);
  SELECT oc.status INTO v_status FROM app.operation_claim AS oc
   WHERE oc.tenant_id = app.current_context_tenant_id() AND oc.operation_id = v_operation_id;
  IF v_status = 'succeeded' THEN
    RETURN (SELECT (oc.receipt->>'customer_id')::uuid FROM app.operation_claim AS oc
            WHERE oc.tenant_id = app.current_context_tenant_id() AND oc.operation_id = v_operation_id);
  END IF;
  INSERT INTO app.principal (tenant_id, principal_id, caller_class, customer_id)
    VALUES (app.current_context_tenant_id(), p_principal_id, 'customer', p_customer_id);
  INSERT INTO app.customer (tenant_id, customer_id, principal_id, display_name, email)
    VALUES (app.current_context_tenant_id(), p_customer_id, p_principal_id, p_display_name, lower(p_email));
  UPDATE app.operation_claim AS oc SET status = 'succeeded', receipt = jsonb_build_object('customer_id', p_customer_id), completed_at = clock_timestamp()
   WHERE oc.tenant_id = app.current_context_tenant_id() AND oc.operation_id = v_operation_id;
  PERFORM app.append_audit('customer.created', 'customer', p_customer_id, v_operation_id, jsonb_build_object('email', lower(p_email)));
  RETURN p_customer_id;
END; $$;

CREATE OR REPLACE FUNCTION api.create_staff_membership(
  p_staff_user_id uuid, p_principal_id uuid, p_role app.staff_role,
  p_idempotency_key text, p_semantic_hash text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, api, pg_catalog AS $$
DECLARE v_operation_id uuid;
DECLARE v_status app.operation_status;
BEGIN
  PERFORM app.require_staff_role('owner');
  IF NOT EXISTS (SELECT 1 FROM app.staff_user AS su WHERE su.tenant_id = app.current_context_tenant_id() AND su.staff_user_id = p_staff_user_id)
     OR NOT EXISTS (SELECT 1 FROM app.principal AS p WHERE p.tenant_id = app.current_context_tenant_id() AND p.principal_id = p_principal_id AND p.caller_class = 'staff')
  THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  v_operation_id := api.begin_operation(p_idempotency_key, p_semantic_hash);
  SELECT oc.status INTO v_status FROM app.operation_claim AS oc
   WHERE oc.tenant_id = app.current_context_tenant_id() AND oc.operation_id = v_operation_id;
  IF v_status = 'succeeded' THEN RETURN; END IF;
  INSERT INTO app.staff_membership (tenant_id, staff_user_id, principal_id, role)
  VALUES (app.current_context_tenant_id(), p_staff_user_id, p_principal_id, p_role);
  UPDATE app.operation_claim AS oc SET status = 'succeeded', receipt = jsonb_build_object('staff_user_id', p_staff_user_id), completed_at = clock_timestamp()
   WHERE oc.tenant_id = app.current_context_tenant_id() AND oc.operation_id = v_operation_id;
  PERFORM app.append_audit('staff_membership.created', 'staff_user', p_staff_user_id, v_operation_id);
END; $$;

CREATE OR REPLACE FUNCTION api.list_locations()
RETURNS SETOF app.location
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, api, pg_catalog AS $$
BEGIN
  IF NOT app.context_is_valid() OR app.current_context_caller_class() NOT IN ('staff', 'customer') THEN RETURN; END IF;
  IF app.current_context_caller_class() = 'staff' THEN PERFORM app.require_staff_role('staff'); END IF;
  RETURN QUERY SELECT l.* FROM app.location AS l ORDER BY l.display_name;
END;
$$;

CREATE OR REPLACE FUNCTION api.read_customer(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, api, pg_catalog AS $$
DECLARE result jsonb;
BEGIN
  IF NOT app.context_is_valid() THEN RETURN NULL; END IF;
  IF app.current_context_caller_class() = 'staff' THEN PERFORM app.require_staff_role('staff'); END IF;
  IF app.current_context_caller_class() = 'customer' AND NOT EXISTS (
    SELECT 1 FROM app.principal p WHERE p.tenant_id = app.current_context_tenant_id()
      AND p.principal_id = app.current_context_principal_id() AND p.customer_id = p_customer_id
  ) THEN RETURN NULL; END IF;
  IF app.current_context_caller_class() NOT IN ('staff', 'customer') THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('customer_id', c.customer_id, 'display_name', c.display_name, 'email', c.email) INTO result
  FROM app.customer c WHERE c.tenant_id = app.current_context_tenant_id() AND c.customer_id = p_customer_id;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION api.list_audit_events()
RETURNS SETOF app.audit_event
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, api, pg_catalog AS $$
BEGIN
  IF NOT app.context_is_valid() THEN RETURN; END IF;
  PERFORM app.require_staff_role('staff');
  RETURN QUERY SELECT ae.* FROM app.audit_event AS ae WHERE ae.tenant_id = app.current_context_tenant_id() ORDER BY ae.occurred_at;
END;
$$;

CREATE OR REPLACE FUNCTION app.create_worker_principal(p_tenant_id uuid, p_principal_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
BEGIN
  PERFORM app.require_staff_role('owner');
  IF p_tenant_id <> app.current_context_tenant_id() THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO app.principal (tenant_id, principal_id, caller_class) VALUES (p_tenant_id, p_principal_id, 'worker');
  PERFORM app.append_audit('principal.worker_created', 'principal', p_principal_id);
  RETURN p_principal_id;
END; $$;

CREATE OR REPLACE FUNCTION api.claim_job_lease(p_job_name text, p_resource_key text, p_lease_seconds integer)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, api, pg_catalog AS $$
DECLARE token bigint;
DECLARE lease_id uuid;
BEGIN
  PERFORM app.require_context('worker');
  IF p_lease_seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'INVALID_LEASE_DURATION' USING ERRCODE = '22023'; END IF;
  INSERT INTO app.job_lease AS jl (tenant_id, job_name, resource_key, fencing_token, leased_by_principal_id, lease_expires_at)
  VALUES (app.current_context_tenant_id(), p_job_name, p_resource_key, 1, app.current_context_principal_id(), clock_timestamp() + make_interval(secs => p_lease_seconds))
  ON CONFLICT (tenant_id, job_name, resource_key) DO UPDATE
    SET fencing_token = jl.fencing_token + 1,
        leased_by_principal_id = EXCLUDED.leased_by_principal_id,
        lease_expires_at = EXCLUDED.lease_expires_at,
        updated_at = clock_timestamp()
    WHERE jl.lease_expires_at <= clock_timestamp()
  RETURNING jl.fencing_token, jl.job_lease_id INTO token, lease_id;
  IF token IS NULL THEN RAISE EXCEPTION 'JOB_LEASE_HELD' USING ERRCODE = 'P0001'; END IF;
  PERFORM app.append_audit('job.lease_claimed', 'job_lease', lease_id, NULL, jsonb_build_object('job_name', p_job_name, 'resource_key', p_resource_key, 'fencing_token', token));
  RETURN token;
END; $$;

CREATE OR REPLACE FUNCTION api.complete_job_lease(p_job_name text, p_resource_key text, p_fencing_token bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, api, pg_catalog AS $$
DECLARE lease_id uuid;
BEGIN
  PERFORM app.require_context('worker');
  UPDATE app.job_lease AS jl SET lease_expires_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE jl.tenant_id = app.current_context_tenant_id() AND jl.job_name = p_job_name AND jl.resource_key = p_resource_key
     AND jl.fencing_token = p_fencing_token AND jl.leased_by_principal_id = app.current_context_principal_id() AND jl.lease_expires_at > clock_timestamp()
  RETURNING jl.job_lease_id INTO lease_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'STALE_JOB_FENCING_TOKEN' USING ERRCODE = 'P0001'; END IF;
  PERFORM app.append_audit('job.lease_completed', 'job_lease', lease_id, NULL, jsonb_build_object('job_name', p_job_name, 'resource_key', p_resource_key, 'fencing_token', p_fencing_token));
END; $$;

REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC, talus_api, talus_customer, talus_staff, talus_device;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM PUBLIC, talus_api, talus_customer, talus_staff, talus_device;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA api FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA api REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA api REVOKE ALL ON FUNCTIONS FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.activate_request_context(uuid), api.begin_operation(text, text),
  api.create_customer(uuid, uuid, text, text, text, text),
  api.create_staff_membership(uuid, uuid, app.staff_role, text, text),
  api.list_locations(), api.read_customer(uuid), api.list_audit_events(),
  api.claim_job_lease(text, text, integer), api.complete_job_lease(text, text, bigint)
TO talus_api;

RESET ROLE;
