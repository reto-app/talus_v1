import { DomainError } from "./operations-service.js";

const SQL_ERROR_CODES = {
  INVALID_CREDENTIALS: 401,
  STAFF_ACCESS_REVOKED: 403,
  INVALID_SESSION_LIFETIME: 422,
};

function mapAuthError(error) {
  const code = error.message?.match(/^([A-Z_]+)$/)?.[1];
  return code && SQL_ERROR_CODES[code] ? new DomainError(code, SQL_ERROR_CODES[code]) : null;
}

export async function loginStaffWorkflow(pool, { tenantSlug, email, password }) {
  if (!tenantSlug || !email || !password) throw new DomainError("LOGIN_INPUT_INVALID", 422);
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM app.authenticate_staff($1,$2,$3)",
      [tenantSlug, email, password],
    );
    const row = result.rows[0];
    return {
      token: row.token,
      tenantId: row.tenant_id,
      tenantDisplayName: row.tenant_display_name,
      principalId: row.principal_id,
      staffRole: row.staff_role,
      displayName: row.display_name,
      mustChangePassword: row.must_change_password,
      expiresAt: row.expires_at,
    };
  } catch (error) {
    throw mapAuthError(error) ?? error;
  } finally {
    client.release();
  }
}

export async function refreshStaffSessionWorkflow(client) {
  const result = await client.query("SELECT * FROM app.refresh_staff_session()");
  const row = result.rows[0];
  return { token: row.token, expiresAt: row.expires_at };
}

export async function logoutStaffSessionWorkflow(client) {
  await client.query("SELECT app.logout_staff_session()");
  return { loggedOut: true };
}
