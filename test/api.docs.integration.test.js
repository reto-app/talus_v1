import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://mbinghamfamily@localhost:5432/talus_test";
let pool, app;

beforeAll(async () => { pool = new Pool({ connectionString: databaseUrl }); app = await buildApp(pool); });
afterAll(async () => { await app.close(); await pool.end(); });

it("serves unauthenticated Swagger UI and its OpenAPI document", async () => {
  const ui = await app.inject({ method: "GET", url: "/docs/" });
  expect(ui.statusCode).toBe(200);
  expect(ui.headers["content-type"]).toContain("text/html");
  const document = await app.inject({ method: "GET", url: "/docs/json" });
  expect(document.statusCode).toBe(200);
  expect(document.json()).toMatchObject({ openapi: expect.any(String), info: { title: "Talus API" } });
  expect(document.json().paths).toHaveProperty("/api/v1/quotes");
  expect(document.json().paths).toHaveProperty("/health/live");
});
