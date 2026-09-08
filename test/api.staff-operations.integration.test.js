import crypto from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://mbinghamfamily@localhost:5432/talus_test";
const id = () => crypto.randomUUID();
let pool, app, tenantId, ownerId, customerId, customerPrincipalId, categoryLocationId, machineId, staffToken, otherToken, otherTenantId, staffBookingItemId;
const headers = (token = staffToken) => ({ authorization: `Bearer ${token}`, "x-tenant-id": tenantId, "x-actor-kind": "staff" });

async function staff(fn) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); await client.query("SELECT api.activate_request_context($1)", [staffToken]); const value = await fn(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl });
  tenantId = id(); ownerId = id(); customerId = id(); customerPrincipalId = id();
  const locationId = id(), categoryId = id(); categoryLocationId = id(); machineId = id();
  await pool.query("SELECT app.onboard_tenant($1,$2,'Staff Operations',$3,$4)", [tenantId, `staff-${tenantId.slice(0, 8)}`, id(), ownerId]);
  staffToken = (await pool.query("SELECT app.issue_context_assertion($1,$2,'staff','owner',interval '15 min') token", [tenantId, ownerId])).rows[0].token;
  await staff(async (client) => {
    await client.query("SELECT api.create_customer($1,$2,'Staff Test Customer',$3,$4,$5)", [customerId, customerPrincipalId, `staff-${tenantId.slice(0, 8)}@example.test`, `customer:${id()}`, crypto.createHash("sha256").update("staff-customer").digest("hex")]);
    await client.query("INSERT INTO app.tenant_waiver_policy(tenant_id,tenant_waiver_policy_id,version_number,signing_mode) VALUES(app.current_context_tenant_id(),$1,1,'individual')", [id()]);
  });
  await pool.query("INSERT INTO app.location VALUES($1,$2,'Staff Yard','America/Denver',clock_timestamp())", [tenantId, locationId]);
  await pool.query("INSERT INTO app.rental_category(tenant_id,rental_category_id,display_name) VALUES($1,$2,'Staff Category')", [tenantId, categoryId]);
  await pool.query("INSERT INTO app.category_location VALUES($1,$2,$3,$4,true,clock_timestamp())", [tenantId, categoryLocationId, categoryId, locationId]);
  await pool.query("INSERT INTO app.machine(tenant_id,machine_id,category_location_id,display_name,operational_state,fleet_number) VALUES($1,$2,$3,'Staff Machine','in_service','STAFF-101')", [tenantId, machineId, categoryLocationId]);
  await staff(async (client) => {
    const productId = id();
    await client.query("SELECT app.create_rental_product($1,$2,'staff-product','Staff Rental','')", [productId, categoryLocationId]);
    const product = { rental_product_id: productId };
    await client.query("SELECT app.update_product_rate($1,$2,'2030-01-01',35000)", [id(), product.rental_product_id]);
  });
  for (const [code, type] of [["cash", "asset"], ["deposits_held", "liability"], ["revenue", "revenue"], ["deposit_clearing", "asset"]]) await pool.query("INSERT INTO app.ledger_account VALUES($1,$2,$3,$4)", [tenantId, id(), code, type]);
  otherTenantId = id(); const otherOwner = id();
  await pool.query("SELECT app.onboard_tenant($1,$2,'Other',$3,$4)", [otherTenantId, `other-${otherTenantId.slice(0, 8)}`, id(), otherOwner]);
  otherToken = (await pool.query("SELECT app.issue_context_assertion($1,$2,'staff','owner',interval '15 min') token", [otherTenantId, otherOwner])).rows[0].token;
  app = await buildApp(pool);
});
afterAll(async () => { await app.close(); await pool.end(); });

it("runs the staff board lifecycle and enforces every dispatch prerequisite", async () => {
  const booking = await app.inject({ method: "POST", url: "/api/v1/bookings", headers: headers(), payload: { categoryLocationId, customerId, rentalPeriod: { start: "2040-06-01T10:00:00Z", end: "2040-06-02T10:00:00Z" } } });
  expect(booking.statusCode).toBe(201); const bookingItemId = booking.json().booking_item_id; staffBookingItemId = bookingItemId;
  await staff((client) => client.query("INSERT INTO app.booking_driver(tenant_id,booking_item_id,customer_id,is_primary) VALUES(app.current_context_tenant_id(),$1,$2,true)", [bookingItemId, customerId]));
  expect((await app.inject({ method: "POST", url: "/api/v1/operations/assign", headers: headers(), payload: { bookingItemId, machineId } })).statusCode).toBe(200);

  let dispatch = await app.inject({ method: "POST", url: "/api/v1/operations/dispatch", headers: headers(), payload: { bookingItemId, dispatchedAt: "2040-06-01T10:00:00Z" } });
  expect(dispatch.statusCode).toBe(422); expect(dispatch.json()).toMatchObject({ code: "DISPATCH_GATE_INCOMPLETE", details: { missingRequirements: expect.arrayContaining(["signed_waiver", "deposit_hold", "outbound_inspection"]) } });
  const board = await app.inject({ method: "GET", url: "/api/v1/operations/dispatch-board?date=2040-06-01", headers: headers() });
  expect(board.statusCode).toBe(200); expect(board.json().items.some((item) => item.booking_item_id === bookingItemId)).toBe(true);
  const machines = await app.inject({ method: "GET", url: `/api/v1/operations/machines?categoryLocationId=${categoryLocationId}&start=2040-06-03T10:00:00Z&end=2040-06-04T10:00:00Z`, headers: headers() });
  expect(machines.statusCode).toBe(200); expect(machines.json().machines[0].machine_id).toBe(machineId);

  expect((await app.inject({ method: "POST", url: `/api/v1/bookings/${bookingItemId}/waivers`, headers: headers(), payload: { customerId, signerName: "Staff Customer", signatureRef: `sig:${id()}`, signerIp: "127.0.0.1" } })).statusCode).toBe(201);
  const hold = await app.inject({ method: "POST", url: `/api/v1/bookings/${bookingItemId}/deposit-hold`, headers: headers(), payload: { amountCents: 100000, paymentReference: `hold:${id()}` } });
  expect(hold.statusCode).toBe(200);
  const outbound = await app.inject({ method: "POST", url: "/api/v1/inspections", headers: headers(), payload: { bookingItemId, machineId, type: "outbound", fuelLevelPct: 100, odometerMiles: 1200, notes: "baseline", checkItems: [{ item: "tires", outcome: "pass" }, { item: "brakes", outcome: "pass" }, { item: "body_panels", outcome: "pass" }, { item: "safety_gear", outcome: "pass" }] } });
  expect(outbound.statusCode).toBe(201);
  dispatch = await app.inject({ method: "POST", url: "/api/v1/operations/dispatch", headers: headers(), payload: { bookingItemId, outboundInspectionId: outbound.json().inspectionId, dispatchedAt: "2040-06-01T10:00:00Z" } });
  expect(dispatch.statusCode).toBe(200);
  const inbound = await app.inject({ method: "POST", url: "/api/v1/inspections", headers: headers(), payload: { bookingItemId, machineId, type: "inbound", fuelLevelPct: 90, odometerMiles: 1225, notes: "return", checkItems: [{ item: "tires", outcome: "pass" }, { item: "brakes", outcome: "pass" }, { item: "body_panels", outcome: "pass" }, { item: "safety_gear", outcome: "pass" }] } });
  expect(inbound.statusCode).toBe(201);
  expect((await app.inject({ method: "POST", url: "/api/v1/operations/return", headers: headers(), payload: { bookingItemId, inboundInspectionId: inbound.json().inspectionId, returnedAt: "2040-06-02T10:00:00Z", fuelChargeCents: 0, excessMileageCents: 0 } })).statusCode).toBe(200);
  const summary = await app.inject({ method: "GET", url: `/api/v1/operations/booking-items/${bookingItemId}/return-summary`, headers: headers() });
  expect(summary.statusCode).toBe(200); expect(summary.json()).toMatchObject({ hold_journal_entry_id: hold.json().transactionId, outbound_odometer_miles: "1200", inbound_odometer_miles: "1225" });
  expect((await app.inject({ method: "POST", url: "/api/v1/operations/settle", headers: headers(), payload: { bookingItemId, holdJournalEntryId: hold.json().transactionId, capturedCents: 0, releasedCents: 100000, excessReceivableCents: 0 } })).statusCode).toBe(200);
});

it("fails closed when another tenant requests a staff booking item", async () => {
  const response = await app.inject({ method: "GET", url: `/api/v1/operations/booking-items/${staffBookingItemId}`, headers: { authorization: `Bearer ${otherToken}`, "x-tenant-id": otherTenantId, "x-actor-kind": "staff" } });
  expect(response.statusCode).toBe(404); expect(response.json().code).toBe("BOOKING_ITEM_NOT_FOUND");
});
