import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { seedDemoData, DEMO_IDS } from "../scripts/seed-demo-data.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://mbinghamfamily@localhost:5432/talus_test";
let app;
let pool;
let tokens;

const staffHeaders = () => ({
  authorization: `Bearer ${tokens.staffToken}`,
  "x-tenant-id": DEMO_IDS.tenant,
  "x-actor-kind": "staff",
  "x-actor-id": DEMO_IDS.ownerPrincipal,
});

beforeAll(async () => {
  tokens = await seedDemoData();
  pool = new Pool({ connectionString: databaseUrl });
  app = await buildApp(pool);
  const telemetry = await app.inject({
    method: "POST",
    url: "/api/v1/telemetry/ingest",
    headers: {
      authorization: `Bearer ${tokens.deviceToken}`,
      "x-tenant-id": DEMO_IDS.tenant,
      "x-actor-kind": "device",
      "x-actor-id": DEMO_IDS.devicePrincipal,
    },
    payload: {
      deviceId: DEMO_IDS.device,
      machineId: DEMO_IDS.machine1,
      recordedAt: new Date().toISOString(),
      latitude: 37.1041,
      longitude: -113.5841,
      speedMph: 18,
      engineHours: 86,
      fuelLevelBp: 7600,
      batteryLevelBp: 9500,
      rawPayload: { source: "fleet-dashboard-test" },
    },
  });
  expect(telemetry.statusCode).toBe(201);
});

afterAll(async () => { await app.close(); await pool.end(); });

it("serves the public fleet console shell without an assertion header", async () => {
  const response = await app.inject({ method: "GET", url: "/fleet" });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("text/html");
  expect(response.body).toContain("LIVE FLEET");
  expect(response.body).toContain("leaflet");
  expect(response.body).toContain("/assets/js/fleet-app.js");

  const logo = await app.inject({ method: "GET", url: "/assets/talus-logo.png" });
  expect(logo.statusCode).toBe(200);
  expect(logo.headers["content-type"]).toContain("image/png");
});

it("returns tenant-scoped live fleet data and a telemetry history", async () => {
  const live = await app.inject({ method: "GET", url: "/api/v1/fleet/live", headers: staffHeaders() });
  expect(live.statusCode).toBe(200);
  expect(live.json().summary.total).toBeGreaterThanOrEqual(3);
  const vehicle = live.json().machines.find((machine) => machine.machine_id === DEMO_IDS.machine1);
  expect(vehicle).toMatchObject({ fleet_number: "RZR-101", latitude: expect.any(Number), longitude: expect.any(Number), fuel_pct: expect.any(Number) });

  const detail = await app.inject({ method: "GET", url: `/api/v1/fleet/machines/${DEMO_IDS.machine1}`, headers: staffHeaders() });
  expect(detail.statusCode).toBe(200);
  expect(detail.json().machine.machine_id).toBe(DEMO_IDS.machine1);
  expect(detail.json().telemetryHistory.length).toBeGreaterThan(0);
});

it("keeps fleet telemetry unavailable to a customer assertion", async () => {
  const response = await app.inject({
    method: "GET", url: "/api/v1/fleet/live",
    headers: {
      authorization: `Bearer ${tokens.customerToken}`,
      "x-tenant-id": DEMO_IDS.tenant,
      "x-actor-kind": "customer",
      "x-actor-id": DEMO_IDS.customerPrincipal,
      "x-customer-id": DEMO_IDS.customer,
    },
  });
  expect(response.statusCode).toBe(403);
});
