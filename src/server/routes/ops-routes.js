import { readFile } from "node:fs/promises";

const demo = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  ownerPrincipalId: "22222222-2222-2222-2222-222222222223",
  devicePrincipalId: "66666666-6666-6666-6666-666666666661",
  customerId: "33333333-3333-3333-3333-333333333333",
  categoryLocationId: "77777777-7777-7777-7777-777777777773",
  deviceId: "77777777-7777-7777-7777-777777777776",
  machines: [
    { id: "55555555-5555-5555-5555-555555555501", fleetNumber: "RZR-101" },
    { id: "55555555-5555-5555-5555-555555555502", fleetNumber: "RZR-102" },
    { id: "55555555-5555-5555-5555-555555555503", fleetNumber: "MAV-201" },
  ],
};

export async function opsRoutes(app, { pool }) {
  app.get("/ops", async (_request, reply) => reply.type("text/html; charset=utf-8").send(
    await readFile(new URL("../public/ops.html", import.meta.url), "utf8")
  ));

  app.get("/ops/api/bootstrap", async (_request, reply) => {
    if (process.env.NODE_ENV === "production" && process.env.OPS_DEMO_BOOTSTRAP !== "true") {
      return reply.code(404).send({ error: "not_found" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const staffToken = (await client.query("SELECT app.issue_context_assertion($1,$2,'staff','owner',interval '15 minutes') AS token", [demo.tenantId, demo.ownerPrincipalId])).rows[0].token;
      const deviceToken = (await client.query("SELECT app.issue_context_assertion($1,$2,'device',NULL,interval '15 minutes') AS token", [demo.tenantId, demo.devicePrincipalId])).rows[0].token;
      await client.query("SELECT api.activate_request_context($1)", [staffToken]);
      const fleet = (await client.query(`
        SELECT m.machine_id, m.fleet_number, m.display_name, m.operational_state,
          latest.recorded_at AS last_seen_at, latest.fuel_pct,
          CASE WHEN EXISTS (SELECT 1 FROM app.trip t WHERE t.tenant_id=m.tenant_id AND t.machine_id=m.machine_id AND t.ended_at IS NULL) THEN 'in_use'
               WHEN m.operational_state='maintenance' THEN 'maintenance' ELSE 'ready' END AS status
        FROM app.machine m
        LEFT JOIN LATERAL (SELECT recorded_at,fuel_pct FROM app.telemetry_frame tf WHERE tf.tenant_id=m.tenant_id AND tf.machine_id=m.machine_id ORDER BY recorded_at DESC LIMIT 1) latest ON true
        WHERE m.tenant_id=app.current_context_tenant_id() AND m.machine_id = ANY($1::uuid[])
        ORDER BY m.fleet_number`, [demo.machines.map((machine) => machine.id)])).rows;
      await client.query("COMMIT");
      return { ...demo, staffToken, deviceToken, assertionExpiresInSeconds: 900, fleet };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  });
}
