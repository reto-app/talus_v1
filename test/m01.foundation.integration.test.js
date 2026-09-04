import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/talus_test";
let admin;
let pool;
let tenantA;
let tenantB;
let ownerA;
let ownerB;
let staffA;
let staffB;
let customerA;
let customerB;
let customerPrincipalA;
let deviceA;

async function asRole(role, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function issueContext({ tenantId, principalId, callerClass, staffRole = null }) {
  const { rows } = await admin.query(
    "SELECT app.issue_context_assertion($1, $2, $3, $4, interval '10 minutes') AS token",
    [tenantId, principalId, callerClass, staffRole],
  );
  return rows[0].token;
}

async function apiWithContext(context, callback) {
  const token = await issueContext(context);
  return asRole("talus_api", async (client) => {
    await client.query("SELECT api.activate_request_context($1)", [token]);
    return callback(client);
  });
}

beforeAll(async () => {
  admin = new Pool({ connectionString: databaseUrl });
  pool = new Pool({ connectionString: databaseUrl });
  let prerequisite;
  try {
    prerequisite = await admin.query("SELECT to_regclass('app.tenant') AS tenant_table");
  } catch (error) {
    const cause = error.message || error.code || String(error);
    throw new Error(
      `Could not connect to TEST_DATABASE_URL (${databaseUrl}). Start local PostgreSQL, create talus_test, and run npm run db:migrate:test. Original error: ${cause}`,
    );
  }
  if (!prerequisite.rows[0].tenant_table) {
    throw new Error("M01 migrations are missing. Run `npm run db:migrate:test` before `npm test`.");
  }

  tenantA = crypto.randomUUID(); tenantB = crypto.randomUUID();
  ownerA = crypto.randomUUID(); ownerB = crypto.randomUUID();
  staffA = crypto.randomUUID(); staffB = crypto.randomUUID();
  const runId = crypto.randomUUID().slice(0, 8);
  await admin.query("SELECT app.onboard_tenant($1, $2, $3, $4, $5)", [tenantA, `alpha-${runId}`, "Alpha Rentals", staffA, ownerA]);
  await admin.query("SELECT app.onboard_tenant($1, $2, $3, $4, $5)", [tenantB, `bravo-${runId}`, "Bravo Rentals", staffB, ownerB]);
  await admin.query("INSERT INTO app.location (tenant_id, location_id, display_name, timezone_name) VALUES ($1, $2, 'Alpha Yard', 'America/Denver'), ($3, $4, 'Bravo Yard', 'America/Denver')", [tenantA, crypto.randomUUID(), tenantB, crypto.randomUUID()]);

  customerA = crypto.randomUUID(); customerB = crypto.randomUUID();
  customerPrincipalA = crypto.randomUUID(); deviceA = crypto.randomUUID();
  await apiWithContext({ tenantId: tenantA, principalId: ownerA, callerClass: "staff", staffRole: "owner" }, (client) =>
    client.query("SELECT api.create_customer($1, $2, $3, $4, $5, $6)", [customerA, customerPrincipalA, "A Customer", "a@example.test", "customer-a", "aaaaaaaaaaaaaaaa"]));
  await apiWithContext({ tenantId: tenantB, principalId: ownerB, callerClass: "staff", staffRole: "owner" }, (client) =>
    client.query("SELECT api.create_customer($1, $2, $3, $4, $5, $6)", [customerB, crypto.randomUUID(), "B Customer", "b@example.test", "customer-b", "bbbbbbbbbbbbbbbb"]));
  await admin.query("INSERT INTO app.principal (tenant_id, principal_id, caller_class) VALUES ($1, $2, 'device')", [tenantA, deviceA]);
}, 120000);

afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

describe("M01 foundation and API perimeter", () => {
  it("fails closed without an activated tenant context", async () => {
    await asRole("talus_api", async (client) => {
      const locations = await client.query("SELECT * FROM api.list_locations()");
      expect(locations.rows).toEqual([]);
      await expect(client.query("SELECT api.create_customer($1, $2, $3, $4, $5, $6)", [crypto.randomUUID(), crypto.randomUUID(), "No Context", "none@example.test", "none", "nnnnnnnnnnnnnnnn"]))
        .rejects.toThrow(/AUTHENTICATION_REQUIRED/);
    });
  });

  it("binds the verified context to its tenant and caller class", async () => {
    const token = await issueContext({ tenantId: tenantA, principalId: ownerA, callerClass: "staff", staffRole: "owner" });
    await asRole("talus_api", async (client) => {
      await client.query("SELECT api.activate_request_context($1)", [token]);
      expect((await client.query("SELECT * FROM api.list_locations()")).rows).toHaveLength(1);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
      expect((await client.query("SELECT * FROM api.list_locations()")).rows).toEqual([]);
      await expect(client.query("SELECT api.create_customer($1, $2, $3, $4, $5, $6)", [crypto.randomUUID(), crypto.randomUUID(), "Forged", "forged@example.test", "forged-key", "ffffffffffffffff"]))
        .rejects.toThrow(/AUTHENTICATION_REQUIRED/);
    });
  });

  it("returns not-found semantics across tenants and rejects cross-tenant writes", async () => {
    await apiWithContext({ tenantId: tenantA, principalId: ownerA, callerClass: "staff", staffRole: "owner" }, async (client) => {
      const hidden = await client.query("SELECT api.read_customer($1) AS customer", [customerB]);
      expect(hidden.rows[0].customer).toBeNull();
      await expect(client.query("SELECT api.create_staff_membership($1, $2, 'staff', $3, $4)", [staffB, ownerA, "cross-tenant-membership", "cross-hash"]))
        .rejects.toThrow(/RESOURCE_NOT_FOUND/);
    });
  });

  it("keeps customer and device caller classes within their explicit scope", async () => {
    await apiWithContext({ tenantId: tenantA, principalId: customerPrincipalA, callerClass: "customer" }, async (client) => {
      expect((await client.query("SELECT api.read_customer($1) AS customer", [customerA])).rows[0].customer).not.toBeNull();
      expect((await client.query("SELECT api.read_customer($1) AS customer", [customerB])).rows[0].customer).toBeNull();
    });
    await apiWithContext({ tenantId: tenantA, principalId: deviceA, callerClass: "device" }, async (client) => {
      expect((await client.query("SELECT * FROM api.list_locations()")).rows).toEqual([]);
      expect((await client.query("SELECT api.read_customer($1) AS customer", [customerA])).rows[0].customer).toBeNull();
    });
  });

  it("gives talus_api zero direct table mutation privileges", async () => {
    const privilege = await admin.query("SELECT has_table_privilege('talus_api', 'app.customer', 'INSERT, UPDATE, DELETE') AS can_mutate");
    expect(privilege.rows[0].can_mutate).toBe(false);
    await asRole("talus_api", async (client) => {
      await expect(client.query("INSERT INTO app.customer (tenant_id, customer_id, principal_id, display_name, email) VALUES ($1, $2, $3, 'Direct', 'direct@example.test')", [tenantA, crypto.randomUUID(), crypto.randomUUID()]))
        .rejects.toThrow(/permission denied/);
    });
    await asRole("talus_api", async (client) => {
      await expect(client.query("SELECT app.append_audit('test.private', 'tenant', $1)", [tenantA]))
        .rejects.toThrow(/permission denied/);
    });
  });

  it("commits domain mutation and audit together, and rollback removes both", async () => {
    const id = crypto.randomUUID();
    const principal = crypto.randomUUID();
    const token = await issueContext({ tenantId: tenantA, principalId: ownerA, callerClass: "staff", staffRole: "owner" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE talus_api");
      await client.query("SELECT api.activate_request_context($1)", [token]);
      await client.query("SELECT api.create_customer($1, $2, $3, $4, $5, $6)", [id, principal, "Rolled Back", "rollback@example.test", "rollback-customer", "rrrrrrrrrrrrrrrr"]);
      const audit = await client.query("SELECT count(*)::int AS count FROM api.list_audit_events() WHERE resource_id = $1", [id]);
      expect(audit.rows[0].count).toBe(1);
      await client.query("ROLLBACK");
    } finally { client.release(); }
    const customer = await admin.query("SELECT count(*)::int AS count FROM app.customer WHERE tenant_id = $1 AND customer_id = $2", [tenantA, id]);
    const audit = await admin.query("SELECT count(*)::int AS count FROM app.audit_event WHERE tenant_id = $1 AND resource_id = $2", [tenantA, id]);
    expect(customer.rows[0].count).toBe(0);
    expect(audit.rows[0].count).toBe(0);
  });

  it("rejects an idempotency-key replay whose semantic hash changed", async () => {
    await apiWithContext({ tenantId: tenantA, principalId: ownerA, callerClass: "staff", staffRole: "owner" }, async (client) => {
      await client.query("SELECT api.begin_operation($1, $2) AS operation_id", ["same-key", "1111111111111111"]);
      await expect(client.query("SELECT api.begin_operation($1, $2)", ["same-key", "2222222222222222"]))
        .rejects.toThrow(/IDEMPOTENCY_KEY_REUSED/);
    });
  });

  it("fences stale workers after a lease is replaced", async () => {
    const worker = crypto.randomUUID();
    const ownerToken = await issueContext({ tenantId: tenantA, principalId: ownerA, callerClass: "staff", staffRole: "owner" });
    await asRole("talus_fn", async (client) => {
      await client.query("SELECT api.activate_request_context($1)", [ownerToken]);
      await client.query("SELECT app.create_worker_principal($1, $2)", [tenantA, worker]);
    });
    const context = { tenantId: tenantA, principalId: worker, callerClass: "worker" };
    const first = await apiWithContext(context, async (client) => (await client.query("SELECT api.claim_job_lease('assignment', 'location:1', 1) AS token")).rows[0].token);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await apiWithContext(context, async (client) => (await client.query("SELECT api.claim_job_lease('assignment', 'location:1', 1) AS token")).rows[0].token);
    expect(BigInt(second)).toBeGreaterThan(BigInt(first));
    await apiWithContext(context, async (client) => {
      await expect(client.query("SELECT api.complete_job_lease('assignment', 'location:1', $1)", [first]))
        .rejects.toThrow(/STALE_JOB_FENCING_TOKEN/);
    });
    await apiWithContext(context, async (client) => {
      await expect(client.query("SELECT api.complete_job_lease('assignment', 'location:1', $1)", [second])).resolves.toBeDefined();
    });
  });

  it("keeps all M01 stored values out of floating-point column types", async () => {
    const result = await admin.query(`
      SELECT a.attname
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = 'app' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
        AND t.typname IN ('float4', 'float8')
    `);
    expect(result.rows).toEqual([]);
  });
});
