import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { seedDemoData, DEMO_IDS } from "../scripts/seed-demo-data.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://mbinghamfamily@localhost:5432/talus_test";
let pool, app;
beforeAll(async () => { process.env.TALUS_DEMO_MODE = "true"; await seedDemoData(); pool = new Pool({ connectionString: databaseUrl }); app = await buildApp(pool); });
afterAll(async () => { await app.close(); await pool.end(); });
it("serves the operations console with persistent staff navigation", async () => {
  const response = await app.inject({ method: "GET", url: "/ops" });
  expect(response.statusCode).toBe(200); expect(response.headers["content-type"]).toContain("text/html"); expect(response.body).toContain("DISPATCH BOARD");
  expect(response.body).toContain("/assets/js/ops-app.js");
});
it("bootstraps a development demo session and fleet", async () => {
  const response = await app.inject({ method: "GET", url: "/ops/api/bootstrap" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ tenantId: DEMO_IDS.tenant, staffToken: expect.any(String), deviceToken: expect.any(String), machines: expect.any(Array) });
  expect(response.json().fleet).toHaveLength(3);
});
it("does not issue demo tokens unless isolated demo mode is explicit", async () => {
  const previous = process.env.TALUS_DEMO_MODE;
  delete process.env.TALUS_DEMO_MODE;
  const response = await app.inject({ method: "GET", url: "/ops/api/bootstrap" });
  process.env.TALUS_DEMO_MODE = previous;
  expect(response.statusCode).toBe(404);
});
