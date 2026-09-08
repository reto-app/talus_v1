-- app.authenticate_staff() must look up a tenant by slug, then a staff_user
-- by email, then a staff_membership row, all BEFORE any tenant context
-- exists (that lookup is what produces the very first token). Their existing
-- tenant_context_policy (app.context_is_valid()) correctly governs every
-- other access path and is left untouched; this migration adds a second,
-- purely additive permissive SELECT policy (Postgres OR-combines permissive
-- policies) that only ever matches when the executing role is talus_fn --
-- i.e. only from inside a trusted SECURITY DEFINER function such as
-- app.authenticate_staff(), never from a directly-connected session role.
SET ROLE talus_fn;

CREATE POLICY staff_login_bootstrap_policy ON app.tenant
  FOR SELECT USING (current_user = 'talus_fn');
CREATE POLICY staff_login_bootstrap_policy ON app.staff_user
  FOR SELECT USING (current_user = 'talus_fn');
CREATE POLICY staff_login_bootstrap_policy ON app.staff_membership
  FOR SELECT USING (current_user = 'talus_fn');

RESET ROLE;
