-- M01: Foundation and API perimeter. This migration intentionally contains no
-- booking, inventory, pricing, payment, or other later-module structures.

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'talus_migrator', 'talus_fn', 'talus_api', 'talus_customer',
    'talus_staff', 'talus_device'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I %s NOINHERIT',
        role_name,
        CASE WHEN role_name IN ('talus_migrator', 'talus_api') THEN 'LOGIN' ELSE 'NOLOGIN' END
      );
    END IF;
  END LOOP;
END; $$;

-- talus_migrator may assume the function-owner role for application-schema
-- migrations. The public pool role is deliberately not a member of talus_fn.
GRANT talus_fn TO talus_migrator;
ALTER ROLE talus_api SET search_path = api, pg_catalog;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION talus_fn;
CREATE SCHEMA IF NOT EXISTS api AUTHORIZATION talus_fn;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT USAGE ON SCHEMA api TO talus_api;

SET ROLE talus_fn;

CREATE DOMAIN app.cents AS bigint CHECK (VALUE >= 0);
CREATE DOMAIN app.basis_points AS integer CHECK (VALUE BETWEEN 0 AND 10000);
CREATE TYPE app.caller_class AS ENUM ('staff', 'customer', 'device', 'worker');
CREATE TYPE app.staff_role AS ENUM ('owner', 'manager', 'staff');
CREATE TYPE app.operation_status AS ENUM ('in_progress', 'succeeded', 'rejected', 'pending');

CREATE TABLE app.tenant (
  tenant_id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz
);

CREATE TABLE app.location (
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  timezone_name text NOT NULL CHECK (length(timezone_name) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, location_id),
  FOREIGN KEY (tenant_id) REFERENCES app.tenant (tenant_id) ON DELETE RESTRICT
);

CREATE TABLE app.staff_user (
  tenant_id uuid NOT NULL,
  staff_user_id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  email text NOT NULL CHECK (email = lower(email) AND length(email) <= 320),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz,
  PRIMARY KEY (tenant_id, staff_user_id),
  UNIQUE (tenant_id, email),
  FOREIGN KEY (tenant_id) REFERENCES app.tenant (tenant_id) ON DELETE RESTRICT
);

CREATE TABLE app.customer (
  tenant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  email text NOT NULL CHECK (email = lower(email) AND length(email) <= 320),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz,
  PRIMARY KEY (tenant_id, customer_id),
  UNIQUE (tenant_id, principal_id),
  UNIQUE (tenant_id, email),
  FOREIGN KEY (tenant_id) REFERENCES app.tenant (tenant_id) ON DELETE RESTRICT
);

CREATE TABLE app.principal (
  tenant_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  caller_class app.caller_class NOT NULL,
  staff_user_id uuid,
  customer_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, principal_id),
  FOREIGN KEY (tenant_id) REFERENCES app.tenant (tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, staff_user_id) REFERENCES app.staff_user (tenant_id, staff_user_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES app.customer (tenant_id, customer_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (caller_class = 'staff' AND staff_user_id IS NOT NULL AND customer_id IS NULL)
    OR (caller_class = 'customer' AND customer_id IS NOT NULL AND staff_user_id IS NULL)
    OR (caller_class IN ('device', 'worker') AND staff_user_id IS NULL AND customer_id IS NULL)
  )
);

ALTER TABLE app.customer
  ADD CONSTRAINT customer_principal_same_tenant_fk
  FOREIGN KEY (tenant_id, principal_id) REFERENCES app.principal (tenant_id, principal_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.staff_membership (
  tenant_id uuid NOT NULL,
  staff_user_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  role app.staff_role NOT NULL,
  active_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  active_until timestamptz,
  PRIMARY KEY (tenant_id, staff_user_id, principal_id),
  FOREIGN KEY (tenant_id, staff_user_id) REFERENCES app.staff_user (tenant_id, staff_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, principal_id) REFERENCES app.principal (tenant_id, principal_id) ON DELETE RESTRICT,
  CHECK (active_until IS NULL OR active_until > active_from)
);

CREATE TABLE app.access_session (
  tenant_id uuid NOT NULL,
  access_session_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, access_session_id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES app.principal (tenant_id, principal_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at)
);

CREATE TABLE app.request_context_assertion (
  assertion_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  caller_class app.caller_class NOT NULL,
  asserted_staff_role app.staff_role,
  is_bootstrap boolean NOT NULL DEFAULT false,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((caller_class = 'staff') = (asserted_staff_role IS NOT NULL)),
  CHECK (expires_at > created_at)
);

CREATE TABLE app.audit_event (
  tenant_id uuid NOT NULL,
  audit_event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_principal_id uuid,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{2,127}$'),
  resource_type text NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9_]{1,63}$'),
  resource_id uuid NOT NULL,
  operation_id uuid,
  request_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  PRIMARY KEY (tenant_id, audit_event_id),
  FOREIGN KEY (tenant_id) REFERENCES app.tenant (tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_principal_id) REFERENCES app.principal (tenant_id, principal_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, operation_id, action, resource_type, resource_id)
);

CREATE TABLE app.operation_claim (
  tenant_id uuid NOT NULL,
  operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  semantic_hash text NOT NULL CHECK (length(semantic_hash) BETWEEN 16 AND 256),
  status app.operation_status NOT NULL DEFAULT 'in_progress',
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, operation_id),
  UNIQUE (tenant_id, principal_id, idempotency_key),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES app.principal (tenant_id, principal_id) ON DELETE RESTRICT,
  CHECK ((status IN ('succeeded', 'rejected')) = (completed_at IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'rejected')) = (receipt IS NOT NULL))
);

CREATE TABLE app.job_lease (
  tenant_id uuid NOT NULL,
  job_lease_id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_name text NOT NULL CHECK (job_name ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  resource_key text NOT NULL CHECK (length(resource_key) BETWEEN 1 AND 512),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  leased_by_principal_id uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, job_name, resource_key),
  UNIQUE (tenant_id, job_lease_id),
  FOREIGN KEY (tenant_id, leased_by_principal_id) REFERENCES app.principal (tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE INDEX audit_event_tenant_resource_idx ON app.audit_event (tenant_id, resource_type, resource_id, occurred_at DESC);
CREATE INDEX operation_claim_tenant_key_idx ON app.operation_claim (tenant_id, principal_id, idempotency_key);
CREATE UNIQUE INDEX location_tenant_display_name_uq ON app.location (tenant_id, lower(display_name));

RESET ROLE;
