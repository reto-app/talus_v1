-- M01 corrective migration: avoid PostgreSQL's built-in current_role name.

SET ROLE talus_fn;

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
       SELECT 1
       FROM app.staff_membership AS m
       WHERE m.tenant_id = app.current_context_tenant_id()
         AND m.principal_id = app.current_context_principal_id()
         AND m.role = v_current_staff_role
         AND m.active_from <= clock_timestamp()
         AND (m.active_until IS NULL OR m.active_until > clock_timestamp())
     )
     OR (required_role = 'owner' AND v_current_staff_role <> 'owner')
     OR (required_role = 'manager' AND v_current_staff_role NOT IN ('owner', 'manager'))
     OR (required_role = 'staff' AND v_current_staff_role NOT IN ('owner', 'manager', 'staff'))
  THEN
    RAISE EXCEPTION 'ACTION_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
END; $$;

RESET ROLE;
