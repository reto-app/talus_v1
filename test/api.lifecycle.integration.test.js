import crypto from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://mbinghamfamily@localhost:5432/talus_test";
let pool, app, tenantId, ownerId, customerId, customerPrincipalId, locationId, categoryLocationId, machineId;
let staffToken, customerToken, deviceToken, deviceId;

const id = () => crypto.randomUUID();
const headers = (token, actorKind) => ({
  authorization: `Bearer ${token}`,
  "x-tenant-id": tenantId,
  "x-actor-kind": actorKind,
});

async function asStaff(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT api.activate_request_context($1)", [staffToken]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createHold(amountCents = 1_000) {
  return asStaff(async (client) => {
    const accounts = Object.fromEntries((await client.query(
      "SELECT account_code, ledger_account_id FROM app.ledger_account WHERE account_code IN ('cash','deposits_held')"
    )).rows.map((row) => [row.account_code, row.ledger_account_id]));
    return (await client.query(
      "SELECT app.record_deposit_hold($1,$2,$3,$4,$5) AS journal_entry_id",
      [id(), `hold:${id()}`, accounts.cash, accounts.deposits_held, amountCents]
    )).rows[0].journal_entry_id;
  });
}

async function createBookingAndReturn({ start = "2035-01-01T10:00:00Z", end = "2035-01-03T10:00:00Z" } = {}) {
  const booking = await app.inject({
    method: "POST", url: "/api/v1/bookings", headers: headers(staffToken, "staff"),
    payload: { categoryLocationId, rentalPeriod: { start, end }, customerId },
  });
  if (booking.statusCode !== 201) throw new Error(`booking failed: ${booking.statusCode} ${booking.body}`);
  const { booking_item_id: bookingItemId } = booking.json();

  await asStaff((client) => client.query(
    "INSERT INTO app.booking_driver(tenant_id,booking_item_id,customer_id,is_primary) VALUES(app.current_context_tenant_id(),$1,$2,true)",
    [bookingItemId, customerId]
  ));
  const waiver = await app.inject({
    method: "POST", url: `/api/v1/bookings/${bookingItemId}/waivers`, headers: headers(staffToken, "staff"),
    payload: { customerId, signerName: "Lifecycle Driver", signatureRef: `sig:${id()}`, signerIp: "127.0.0.1" },
  });
  expect(waiver.statusCode).toBe(201);

  const assignment = await app.inject({
    method: "POST", url: "/api/v1/operations/assign", headers: headers(staffToken, "staff"),
    payload: { bookingItemId, machineId },
  });
  expect(assignment.statusCode).toBe(200);

  const deposit = await app.inject({
    method: "POST", url: `/api/v1/bookings/${bookingItemId}/deposit-hold`, headers: headers(staffToken, "staff"),
    payload: { amountCents: 1_000, paymentReference: `hold:${id()}` },
  });
  expect(deposit.statusCode).toBe(200);
  const holdJournalEntryId = deposit.json().transactionId;

  const outboundInspectionId = id();
  await asStaff(async (client) => {
    await client.query("SELECT app.start_inspection($1,$2,NULL,$3,'outbound')", [outboundInspectionId, bookingItemId, machineId]);
    await client.query("SELECT app.complete_inspection($1,75,100)", [outboundInspectionId]);
  });
  const dispatch = await app.inject({
    method: "POST", url: "/api/v1/operations/dispatch", headers: headers(staffToken, "staff"),
    payload: { bookingItemId, outboundInspectionId, dispatchedAt: start },
  });
  expect(dispatch.statusCode).toBe(200);
  const tripId = dispatch.json().trip_id;

  const inboundInspectionId = id();
  await asStaff(async (client) => {
    await client.query("SELECT app.start_inspection($1,$2,$3,$4,'inbound')", [inboundInspectionId, bookingItemId, tripId, machineId]);
    await client.query("SELECT app.complete_inspection($1,70,125)", [inboundInspectionId]);
  });
  const returned = await app.inject({
    method: "POST", url: "/api/v1/operations/return", headers: headers(staffToken, "staff"),
    payload: { bookingItemId, inboundInspectionId, returnedAt: end, fuelChargeCents: 100, excessMileageCents: 50 },
  });
  expect(returned.statusCode).toBe(200);
  return { bookingItemId, tripId, holdJournalEntryId };
}

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl });
  tenantId = id(); ownerId = id(); customerId = id(); customerPrincipalId = id();
  locationId = id(); const categoryId = id(); categoryLocationId = id(); machineId = id(); deviceId = id();
  await pool.query("SELECT app.onboard_tenant($1,$2,'Lifecycle',$3,$4)", [tenantId, `life-${tenantId.slice(0, 8)}`, id(), ownerId]);
  staffToken = (await pool.query("SELECT app.issue_context_assertion($1,$2,'staff','owner',interval '15 minutes') AS token", [tenantId, ownerId])).rows[0].token;
  await asStaff(async (client) => {
    await client.query("SELECT api.create_customer($1,$2,'Lifecycle Customer',$3,$4,$5)", [customerId, customerPrincipalId, `customer-${tenantId.slice(0, 8)}@example.test`, `customer:${id()}`, "lifecycle-customer"]);
  });
  customerToken = (await pool.query("SELECT app.issue_context_assertion($1,$2,'customer',NULL,interval '15 minutes') AS token", [tenantId, customerPrincipalId])).rows[0].token;
  await pool.query("INSERT INTO app.location VALUES($1,$2,'Lifecycle location','America/Denver',clock_timestamp())", [tenantId, locationId]);
  await pool.query("INSERT INTO app.rental_category(tenant_id,rental_category_id,display_name) VALUES($1,$2,'Lifecycle category')", [tenantId, categoryId]);
  await pool.query("INSERT INTO app.category_location VALUES($1,$2,$3,$4,true,clock_timestamp())", [tenantId, categoryLocationId, categoryId, locationId]);
  await pool.query("INSERT INTO app.machine(tenant_id,machine_id,category_location_id,display_name,operational_state) VALUES($1,$2,$3,'Lifecycle machine','in_service')", [tenantId, machineId, categoryLocationId]);
  const productId = id();
  await asStaff(async (client) => {
    await client.query("SELECT app.create_rental_product($1,$2,'lifecycle','Lifecycle rental','')", [productId, categoryLocationId]);
    await client.query("SELECT app.update_product_rate($1,$2,'2030-01-01',500)", [id(), productId]);
  });
  await asStaff((client) => client.query(
    "INSERT INTO app.tenant_waiver_policy(tenant_id,tenant_waiver_policy_id,version_number,signing_mode) VALUES(app.current_context_tenant_id(),$1,1,'individual')",
    [id()]
  ));
  for (const [accountCode, accountType] of [["cash","asset"],["deposits_held","liability"],["revenue","revenue"],["deposit_clearing","asset"]]) {
    await pool.query("INSERT INTO app.ledger_account VALUES($1,$2,$3,$4)", [tenantId, id(), accountCode, accountType]);
  }
  const devicePrincipalId = id(); const modelId = id();
  await pool.query("INSERT INTO app.principal(tenant_id,principal_id,caller_class) VALUES($1,$2,'device')", [tenantId, devicePrincipalId]);
  await pool.query("INSERT INTO app.device_model VALUES($1,$2,'Talus','T1',true)", [tenantId, modelId]);
  await pool.query("INSERT INTO app.device VALUES($1,$2,$3,'lifecycle-device',true,NULL)", [tenantId, deviceId, modelId]);
  await pool.query("INSERT INTO app.device_installation VALUES($1,$2,$3,$4,clock_timestamp(),NULL,$5)", [tenantId, id(), deviceId, machineId, ownerId]);
  deviceToken = (await pool.query("SELECT app.issue_context_assertion($1,$2,'device',NULL,interval '15 minutes') AS token", [tenantId, devicePrincipalId])).rows[0].token;
  app = await buildApp(pool);
});

afterAll(async () => { await app.close(); await pool.end(); });

describe("Tier 3 lifecycle perimeter", () => {
  it("runs quote through telemetry, return, and balanced partial settlement", async () => {
    const quote = await app.inject({ method: "POST", url: "/api/v1/quotes", headers: headers(staffToken, "staff"), payload: { categoryLocationId, rentalPeriod: { start: "2035-01-01T10:00:00Z", end: "2035-01-03T10:00:00Z" } } });
    expect(quote.statusCode).toBe(200);
    expect(quote.json().totalCents).toBe("1000");
    const { bookingItemId, tripId, holdJournalEntryId } = await createBookingAndReturn();
    const telemetry = await app.inject({ method: "POST", url: "/api/v1/telemetry/ingest", headers: headers(deviceToken, "device"), payload: { deviceId, machineId, recordedAt: "2035-01-01T12:00:00Z", latitude: 40.7608, longitude: -111.891, speedMph: 25, engineHours: 85, fuelLevelBp: 7500, rawPayload: { source: "lifecycle" } } });
    expect(telemetry.statusCode).toBe(201);
    const frame = await asStaff((client) => client.query("SELECT latitude_microdegrees,fuel_pct FROM app.telemetry_frame WHERE machine_id=$1 ORDER BY recorded_at DESC LIMIT 1", [machineId]));
    expect(frame.rows[0]).toMatchObject({ latitude_microdegrees: 40760800, fuel_pct: 75 });
    const settlement = await app.inject({ method: "POST", url: "/api/v1/operations/settle", headers: headers(staffToken, "staff"), payload: { bookingItemId, holdJournalEntryId, capturedCents: 250, releasedCents: 750, excessReceivableCents: 0, externalRef: `settle:${id()}` } });
    expect(settlement.statusCode).toBe(200);
    const balance = await asStaff((client) => client.query("SELECT COALESCE(sum(CASE direction WHEN 'debit' THEN amount_cents ELSE -amount_cents END),0)::bigint AS balance FROM app.ledger_posting"));
    expect(balance.rows[0].balance).toBe("0");
    const trip = await asStaff((client) => client.query("SELECT ended_at FROM app.trip WHERE trip_id=$1", [tripId]));
    expect(trip.rows[0].ended_at).toBeTruthy();
  });

  it("serializes competing settlement requests", async () => {
    const { bookingItemId, holdJournalEntryId } = await createBookingAndReturn({ start: "2035-02-01T10:00:00Z", end: "2035-02-03T10:00:00Z" });
    const payload = { bookingItemId, holdJournalEntryId, capturedCents: 100, releasedCents: 900, excessReceivableCents: 0 };
    const responses = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/api/v1/operations/settle", headers: headers(staffToken, "staff"), payload })));
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(responses.find((response) => response.statusCode === 409)?.json().code).toBe("DEPOSIT_ALREADY_SETTLED");
  });

  it("enforces lifecycle, amount, device, and caller guards", async () => {
    const booking = await app.inject({ method: "POST", url: "/api/v1/bookings", headers: headers(staffToken, "staff"), payload: { categoryLocationId, rentalPeriod: { start: "2036-01-01T10:00:00Z", end: "2036-01-02T10:00:00Z" }, customerId } });
    const bookingItemId = booking.json().booking_item_id;
    const notReturned = await app.inject({ method: "POST", url: "/api/v1/operations/settle", headers: headers(staffToken, "staff"), payload: { bookingItemId, holdJournalEntryId: id(), capturedCents: 0, releasedCents: 0, excessReceivableCents: 0 } });
    expect(notReturned.statusCode).toBe(409); expect(notReturned.json().code).toBe("TRIP_NOT_RETURNED");
    const returned = await createBookingAndReturn({ start: "2036-02-01T10:00:00Z", end: "2036-02-03T10:00:00Z" });
    const holdJournalEntryId = returned.holdJournalEntryId;
    const excessive = await app.inject({ method: "POST", url: "/api/v1/operations/settle", headers: headers(staffToken, "staff"), payload: { bookingItemId: returned.bookingItemId, holdJournalEntryId, capturedCents: 1001, releasedCents: 0, excessReceivableCents: 1 } });
    expect(excessive.statusCode).toBe(422); expect(excessive.json().code).toBe("SETTLEMENT_EXCEEDS_HOLD");
    const mismatched = await app.inject({ method: "POST", url: "/api/v1/telemetry/ingest", headers: headers(deviceToken, "device"), payload: { deviceId, machineId: id(), recordedAt: "2036-01-01T12:00:00Z", latitude: 0, longitude: 0, speedMph: 0, engineHours: 1, fuelLevelBp: 100 } });
    expect(mismatched.statusCode).toBe(422); expect(mismatched.json().code).toBe("DEVICE_MACHINE_MISMATCH");
    for (const url of ["/api/v1/operations/assign", "/api/v1/operations/dispatch", "/api/v1/operations/return", "/api/v1/operations/settle", "/api/v1/telemetry/ingest"]) {
      const response = await app.inject({ method: "POST", url, headers: headers(customerToken, "customer"), payload: {} });
      expect(response.statusCode).toBe(403);
    }
  });
});
