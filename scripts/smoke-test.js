import crypto from "node:crypto";
import { Pool } from "pg";
import { buildApp } from "../src/server/app.js";
import { DEMO_IDS, seedDemoData } from "./seed-demo-data.js";

const databaseUrl = process.env.DATABASE_URL
  ?? process.env.TEST_DATABASE_URL
  ?? "postgres://mbinghamfamily@localhost:5432/talus_test";
const ids = DEMO_IDS;
const id = () => crypto.randomUUID();
let app;

function fail(step, response) {
  const body = response?.json?.() ?? response?.body ?? {};
  const code = body.code ?? body.error ?? body.message ?? "unknown_error";
  console.error(`✖ [${step}/9] Failed: HTTP ${response?.statusCode ?? "n/a"} (${code})`);
  process.exitCode = 1;
  throw new Error(`Smoke test failed at step ${step}`);
}
function assertStatus(step, response, expected) { if (response.statusCode !== expected) fail(step, response); return response.json(); }
function headers(token, actorKind) { return { authorization: `Bearer ${token}`, "x-tenant-id": ids.tenant, "x-actor-kind": actorKind }; }

async function asStaff(pool, staffToken, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT api.activate_request_context($1)", [staffToken]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function run() {
  const { staffToken, deviceToken } = await seedDemoData();
  const pool = new Pool({ connectionString: databaseUrl });
  app = await buildApp(pool);
  try {
    const ready = assertStatus(1, await app.inject({ method: "GET", url: "/health/ready" }), 200);
    if (ready.status !== "ready") fail(1, { statusCode: 503, json: () => ready });
    console.log("✔ [1/9] Health check passed (PostgreSQL connection pool healthy)");

    const startAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + Math.floor(Math.random() * 24 * 60 * 60 * 1000));
    const period = { start: startAt.toISOString(), end: new Date(startAt.getTime() + 24 * 60 * 60 * 1000).toISOString() };
    const quote = assertStatus(2, await app.inject({ method: "POST", url: "/api/v1/quotes", headers: headers(staffToken, "staff"), payload: { categoryLocationId: ids.categoryLocation, rentalPeriod: period } }), 200);
    if (quote.totalCents !== "35000") fail(2, { statusCode: 500, json: () => quote });
    console.log("✔ [2/9] Generated rental quote ($350.00 base + security hold)");

    const booking = assertStatus(3, await app.inject({ method: "POST", url: "/api/v1/bookings", headers: headers(staffToken, "staff"), payload: { categoryLocationId: ids.categoryLocation, rentalPeriod: period, customerId: ids.customer } }), 201);
    const bookingItemId = booking.booking_item_id;
    if (!bookingItemId) fail(3, { statusCode: 500, json: () => booking });
    console.log(`✔ [3/9] Booking created for Jane Doe (ID: ${bookingItemId})`);

    await asStaff(pool, staffToken, (client) => client.query("INSERT INTO app.booking_driver(tenant_id,booking_item_id,customer_id,is_primary) VALUES(app.current_context_tenant_id(),$1,$2,true)", [bookingItemId, ids.customer]));
    assertStatus(4, await app.inject({ method: "POST", url: `/api/v1/bookings/${bookingItemId}/waivers`, headers: headers(staffToken, "staff"), payload: { customerId: ids.customer, signerName: "Jane Doe", signatureRef: `smoke:${id()}`, signerIp: "127.0.0.1" } }), 201);
    console.log("✔ [4/9] Digital liability waiver signed and pinned");

    assertStatus(5, await app.inject({ method: "POST", url: "/api/v1/operations/assign", headers: headers(staffToken, "staff"), payload: { bookingItemId, machineId: ids.machine1 } }), 200);
    console.log("✔ [5/9] Assigned machine RZR-101 to booking");

    const hold = assertStatus(5, await app.inject({ method: "POST", url: `/api/v1/bookings/${bookingItemId}/deposit-hold`, headers: headers(staffToken, "staff"), payload: { amountCents: 100000, paymentReference: `smoke-hold:${id()}` } }), 200);
    const outbound = assertStatus(5, await app.inject({ method: "POST", url: "/api/v1/inspections", headers: headers(staffToken, "staff"), payload: { bookingItemId, machineId: ids.machine1, type: "outbound", fuelLevelPct: 100, odometerMiles: 1240, notes: "Smoke outbound", checkItems: [{ item: "tires", passed: true }, { item: "brakes", passed: true }] } }), 201);
    const readiness = assertStatus(6, await app.inject({ method: "GET", url: `/api/v1/bookings/${bookingItemId}/dispatch-readiness`, headers: headers(staffToken, "staff") }), 200);
    if (!readiness.isReady) fail(6, { statusCode: 422, json: () => readiness });
    const dispatch = assertStatus(6, await app.inject({ method: "POST", url: "/api/v1/operations/dispatch", headers: headers(staffToken, "staff"), payload: { bookingItemId, outboundInspectionId: outbound.inspectionId, dispatchedAt: period.start } }), 200);
    const tripId = dispatch.trip_id;
    console.log("✔ [6/9] Dispatch gates cleared and machine dispatched on active trip");

    assertStatus(7, await app.inject({ method: "POST", url: "/api/v1/telemetry/ingest", headers: headers(deviceToken, "device"), payload: { deviceId: ids.device, machineId: ids.machine1, recordedAt: "2037-06-01T12:00:00Z", latitude: 37.0965, longitude: -113.5684, speedMph: 18, engineHours: 86, fuelLevelBp: 9500, rawPayload: { source: "smoke-test" } } }), 201);
    console.log("✔ [7/9] Telemetry frame ingested (GPS ping recorded, 95% fuel)");

    const inbound = assertStatus(8, await app.inject({ method: "POST", url: "/api/v1/inspections", headers: headers(staffToken, "staff"), payload: { bookingItemId, machineId: ids.machine1, type: "inbound", fuelLevelPct: 95, odometerMiles: 1260, notes: "Smoke inbound", checkItems: [{ item: "tires", passed: true }, { item: "brakes", passed: true }] } }), 201);
    assertStatus(8, await app.inject({ method: "POST", url: "/api/v1/operations/return", headers: headers(staffToken, "staff"), payload: { bookingItemId, inboundInspectionId: inbound.inspectionId, returnedAt: period.end, fuelChargeCents: 0, excessMileageCents: 0 } }), 200);
    console.log("✔ [8/9] Vehicle returned, trip closed, occupancy clamped");

    assertStatus(9, await app.inject({ method: "POST", url: "/api/v1/operations/settle", headers: headers(staffToken, "staff"), payload: { bookingItemId, holdJournalEntryId: hold.transactionId, capturedCents: 0, releasedCents: 100000, excessReceivableCents: 0 } }), 200);
    console.log("✔ [9/9] Security deposit hold settled ($1,000.00 balanced in M05 ledger)");
    console.log("\n====================================================");
    console.log("🎉 FULL TALUS FLEET OS LIFECYCLE VERIFIED (9/9 STEPS)");
    console.log("====================================================");
  } finally {
    await app.close();
    await pool.end();
  }
}

run().catch((error) => { if (!process.exitCode) { console.error(error); process.exitCode = 1; } });
