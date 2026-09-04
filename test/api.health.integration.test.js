import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://mbinghamfamily@localhost:5432/talus_test";
let pool, app;

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl });
  app = await buildApp(pool);
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("health probes", () => {
  it("serves unauthenticated liveness without touching the database", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "live" });
    expect(response.json().uptimeSeconds).toEqual(expect.any(Number));
  });

  it("reports a ready database, context engine, pool, and outbox", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ready",
      checks: {
        database: { status: "pass", latencyMs: expect.any(Number) },
        contextEngine: { status: "pass" },
        connectionPool: { status: "pass", total: expect.any(Number), idle: expect.any(Number), waiting: expect.any(Number) },
        outbox: { status: "pass", pendingEvents: expect.any(Number) },
      },
    });
  });

  it("returns unhealthy when a critical database check fails", async () => {
    const unavailablePool = {
      totalCount: 0, idleCount: 0, waitingCount: 0,
      query: async () => { throw Object.assign(new Error("database unavailable"), { code: "ECONNREFUSED" }); },
    };
    const unavailableApp = await buildApp(unavailablePool);
    try {
      const response = await unavailableApp.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json().status).toBe("unhealthy");
      expect(response.json().checks.database.status).toBe("fail");
    } finally {
      await unavailableApp.close();
    }
  });
});
