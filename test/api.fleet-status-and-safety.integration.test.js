import crypto from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://mbinghamfamily@localhost:5432/talus_test";
const id = () => crypto.randomUUID();
let pool, app, tenantId, ownerId, customerId, categoryLocationId, locationId, staffToken;
const headers = () => ({ authorization: `Bearer ${staffToken}`, "x-tenant-id": tenantId, "x-actor-kind": "staff" });

async function staff(fn) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); await client.query("SELECT api.activate_request_context($1)", [staffToken]); const value = await fn(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl });
  tenantId = id(); ownerId = id(); customerId = id();
  locationId = id(); const categoryId = id(); categoryLocationId = id();
  await pool.query("SELECT app.onboard_tenant($1,$2,'Fleet Status Suite',$3,$4)", [tenantId, `fleetstatus-${tenantId.slice(0, 8)}`, id(), ownerId]);
  staffToken = (await pool.query("SELECT app.issue_context_assertion($1,$2,'staff','owner',interval '15 min') token", [tenantId, ownerId])).rows[0].token;
  await staff((client) => client.query(
    "SELECT api.create_customer($1,$2,'Fleet Status Customer',$3,$4,$5)",
    [customerId, id(), `fleetstatus-${tenantId.slice(0, 8)}@example.test`, `customer:${id()}`, "fleet-status-customer"],
  ));
  await pool.query("INSERT INTO app.location VALUES($1,$2,'Status Yard','America/Denver',clock_timestamp())", [tenantId, locationId]);
  await pool.query("INSERT INTO app.rental_category(tenant_id,rental_category_id,display_name) VALUES($1,$2,'Status Category')", [tenantId, categoryId]);
  await pool.query("INSERT INTO app.category_location VALUES($1,$2,$3,$4,true,clock_timestamp())", [tenantId, categoryLocationId, categoryId, locationId]);
  app = await buildApp(pool);
});
afterAll(async () => { await app.close(); await pool.end(); });

async function makeMachine() {
  const machineId = id();
  await pool.query(
    "INSERT INTO app.machine(tenant_id,machine_id,category_location_id,display_name,operational_state,fleet_number) VALUES($1,$2,$3,$4,'in_service',$5)",
    [tenantId, machineId, categoryLocationId, `Status Machine ${machineId.slice(0, 6)}`, `SM-${machineId.slice(0, 4)}`],
  );
  return machineId;
}

const PASSING_CHECKLIST = [{ item: "tires", outcome: "pass" }, { item: "brakes", outcome: "pass" }, { item: "body_panels", outcome: "pass" }, { item: "safety_gear", outcome: "pass" }];

async function ensureLedgerAccounts() {
  for (const [code, type] of [["cash", "asset"], ["deposits_held", "liability"], ["revenue", "revenue"], ["deposit_clearing", "asset"]]) {
    await pool.query("INSERT INTO app.ledger_account VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [tenantId, id(), code, type]);
  }
}
async function ensureWaiverPolicy() {
  await pool.query("INSERT INTO app.tenant_waiver_policy(tenant_id,tenant_waiver_policy_id,version_number,signing_mode) VALUES($1,$2,1,'individual') ON CONFLICT DO NOTHING", [tenantId, id()]);
}

// Drives a booking all the way to an active trip through the real HTTP API
// (assign -> waiver -> deposit -> outbound inspection -> dispatch) so tests
// that need a genuinely on-rent machine don't have to hand-construct the
// occupancy/trip/checkout_occurrence foreign-key chain themselves.
async function dispatchFreshBooking({ start, end, machineId, depositCents = 50000 }) {
  await ensureWaiverPolicy();
  const booking = await app.inject({ method: "POST", url: "/api/v1/bookings", headers: headers(), payload: { categoryLocationId, customerId, rentalPeriod: { start, end } } });
  const bookingItemId = booking.json().booking_item_id;
  await pool.query("INSERT INTO app.booking_driver(tenant_id,booking_item_id,customer_id,is_primary) VALUES($1,$2,$3,true)", [tenantId, bookingItemId, customerId]);
  await app.inject({ method: "POST", url: "/api/v1/operations/assign", headers: headers(), payload: { bookingItemId, machineId } });
  await app.inject({ method: "POST", url: `/api/v1/bookings/${bookingItemId}/waivers`, headers: headers(), payload: { customerId, signerName: "Status Customer", signatureRef: `sig:${id()}`, signerIp: "127.0.0.1" } });
  let holdTransactionId = null;
  if (depositCents > 0) {
    await ensureLedgerAccounts();
    const hold = await app.inject({ method: "POST", url: `/api/v1/bookings/${bookingItemId}/deposit-hold`, headers: headers(), payload: { amountCents: depositCents, paymentReference: `hold:${id()}` } });
    holdTransactionId = hold.json().transactionId;
  }
  const outbound = await app.inject({ method: "POST", url: "/api/v1/inspections", headers: headers(), payload: { bookingItemId, machineId, type: "outbound", fuelLevelPct: 100, odometerMiles: 10, checkItems: PASSING_CHECKLIST } });
  const dispatch = await app.inject({ method: "POST", url: "/api/v1/operations/dispatch", headers: headers(), payload: { bookingItemId, outboundInspectionId: outbound.json().inspectionId, dispatchedAt: start } });
  return { bookingItemId, tripId: dispatch.json().trip_id, holdTransactionId };
}

async function openIncident(machineId, severity = "high") {
  return staff(async (client) => {
    const alertId = id();
    await client.query(
      "INSERT INTO app.fleet_alert VALUES(app.current_context_tenant_id(),$1,$2,'speeding',$3,clock_timestamp(),'{}'::jsonb)",
      [alertId, machineId, severity],
    );
    const incidentId = (await client.query("SELECT app.open_or_attach_incident($1,$2,$3) id", [alertId, machineId, severity])).rows[0].id;
    return incidentId;
  });
}

it("keeps an on-rent vehicle counted as on-rent even with a critical incident, and connectivity/incident stay independent", async () => {
  const machineId = await makeMachine();
  await dispatchFreshBooking({ start: "2041-02-01T10:00:00Z", end: "2041-02-02T10:00:00Z", machineId });
  await openIncident(machineId, "critical");

  const live = await app.inject({ method: "GET", url: "/api/v1/fleet/live", headers: headers() });
  expect(live.statusCode).toBe(200);
  const machine = live.json().machines.find((m) => m.machine_id === machineId);
  expect(machine.rental_state).toBe("on_rent");
  expect(machine.highest_open_incident_severity).toBe("critical");
  expect(machine.connectivity_state).toBe("never_reported"); // no telemetry frame was ever ingested
  expect(live.json().summary.onTrip).toBeGreaterThanOrEqual(1);
  expect(live.json().summary.needsAttention).toBeGreaterThanOrEqual(1);
});

it("stops a resolved incident from driving the current marker, and lets maintenance coexist with an open critical incident", async () => {
  const machineId = await makeMachine();
  const incidentId = await openIncident(machineId, "high");
  await staff((client) => client.query("SELECT app.resolve_incident($1,$2)", [incidentId, "False alarm, confirmed safe."]));

  let live = await app.inject({ method: "GET", url: "/api/v1/fleet/live", headers: headers() });
  let machine = live.json().machines.find((m) => m.machine_id === machineId);
  expect(machine.highest_open_incident_severity).toBeNull();

  // Now put the SAME machine into maintenance and open a fresh critical incident.
  await staff((client) => client.query("SELECT app.transition_machine_state($1,'maintenance','scheduled service')", [machineId]));
  await openIncident(machineId, "critical");
  live = await app.inject({ method: "GET", url: "/api/v1/fleet/live", headers: headers() });
  machine = live.json().machines.find((m) => m.machine_id === machineId);
  expect(machine.service_state).toBe("maintenance");
  expect(machine.highest_open_incident_severity).toBe("critical"); // maintenance must not hide the incident
});

it("eliminates duplicate dispatch-board rows when a category/location has more than one active product", async () => {
  for (const code of ["dup-a", "dup-b"]) {
    const productId = id();
    await staff(async (client) => {
      await client.query("SELECT app.create_rental_product($1,$2,$3,$4,'')", [productId, categoryLocationId, code, `Product ${code}`]);
      await client.query("SELECT app.update_product_rate($1,$2,'2030-01-01',10000)", [id(), productId]);
    });
  }
  const booking = await app.inject({
    method: "POST", url: "/api/v1/bookings", headers: headers(),
    payload: { categoryLocationId, customerId, rentalPeriod: { start: "2041-03-01T10:00:00Z", end: "2041-03-02T10:00:00Z" } },
  });
  expect(booking.statusCode).toBe(201);
  const board = await app.inject({ method: "GET", url: "/api/v1/operations/dispatch-board?date=2041-03-01", headers: headers() });
  expect(board.statusCode).toBe(200);
  const matches = board.json().items.filter((item) => item.booking_item_id === booking.json().booking_item_id);
  expect(matches).toHaveLength(1);
});

it("surfaces a multi-day booking on its return date even though pickup was on an earlier day", async () => {
  const booking = await app.inject({
    method: "POST", url: "/api/v1/bookings", headers: headers(),
    payload: { categoryLocationId, customerId, rentalPeriod: { start: "2041-04-01T10:00:00Z", end: "2041-04-05T10:00:00Z" } },
  });
  expect(booking.statusCode).toBe(201);
  const bookingItemId = booking.json().booking_item_id;

  const pickupDayBoard = await app.inject({ method: "GET", url: "/api/v1/operations/dispatch-board?date=2041-04-01", headers: headers() });
  expect(pickupDayBoard.json().items.some((i) => i.booking_item_id === bookingItemId)).toBe(true);

  const midTripBoard = await app.inject({ method: "GET", url: "/api/v1/operations/dispatch-board?date=2041-04-03", headers: headers() });
  expect(midTripBoard.json().items.some((i) => i.booking_item_id === bookingItemId)).toBe(false);

  const returnDayBoard = await app.inject({ method: "GET", url: "/api/v1/operations/dispatch-board?date=2041-04-05", headers: headers() });
  const returnRow = returnDayBoard.json().items.find((i) => i.booking_item_id === bookingItemId);
  expect(returnRow).toBeTruthy();
  expect(returnRow.dispatch_bucket).toBe("pickup"); // not yet dispatched, so it is still a pending pickup, not a return
});

it("cannot complete an untouched inspection, and blocks dispatch on an unsafe outcome", async () => {
  await ensureWaiverPolicy();
  await ensureLedgerAccounts();
  const machineId = await makeMachine();
  const booking = await app.inject({ method: "POST", url: "/api/v1/bookings", headers: headers(), payload: { categoryLocationId, customerId, rentalPeriod: { start: "2041-05-01T10:00:00Z", end: "2041-05-02T10:00:00Z" } } });
  const bookingItemId = booking.json().booking_item_id;
  await pool.query("INSERT INTO app.booking_driver(tenant_id,booking_item_id,customer_id,is_primary) VALUES($1,$2,$3,true)", [tenantId, bookingItemId, customerId]);
  const assign = await app.inject({ method: "POST", url: "/api/v1/operations/assign", headers: headers(), payload: { bookingItemId, machineId } });
  expect(assign.statusCode).toBe(200);
  await app.inject({ method: "POST", url: `/api/v1/bookings/${bookingItemId}/waivers`, headers: headers(), payload: { customerId, signerName: "Status Customer", signatureRef: `sig:${id()}`, signerIp: "127.0.0.1" } });
  await app.inject({ method: "POST", url: `/api/v1/bookings/${bookingItemId}/deposit-hold`, headers: headers(), payload: { amountCents: 50000, paymentReference: `hold:${id()}` } });

  const untouched = await app.inject({
    method: "POST", url: "/api/v1/inspections", headers: headers(),
    payload: { bookingItemId, machineId, type: "outbound", fuelLevelPct: 100, odometerMiles: 10, checkItems: [{ item: "tires", outcome: "pass" }] },
  });
  expect(untouched.statusCode).toBe(422);
  expect(untouched.json().code).toBe("INSPECTION_CHECKLIST_INCOMPLETE");

  const unsafe = await app.inject({
    method: "POST", url: "/api/v1/inspections", headers: headers(),
    payload: {
      bookingItemId, machineId, type: "outbound", fuelLevelPct: 100, odometerMiles: 10,
      checkItems: [{ item: "tires", outcome: "unsafe", notes: "worn tread" }, { item: "brakes", outcome: "pass" }, { item: "body_panels", outcome: "pass" }, { item: "safety_gear", outcome: "pass" }],
    },
  });
  expect(unsafe.statusCode).toBe(201);

  // An unsafe outbound inspection makes the dispatch gate itself report
  // not-ready (surfaced distinctly as outbound_inspection_unsafe so the UI
  // can show "blocked, needs service" instead of a generic checklist item),
  // and the dispatch attempt is rejected before ever reaching the machine.
  const detail = await app.inject({ method: "GET", url: `/api/v1/operations/booking-items/${bookingItemId}`, headers: headers() });
  expect(detail.json().gate).toMatchObject({ isReady: false, outbound_inspection_ready: false, outbound_inspection_unsafe: true });

  const dispatch = await app.inject({ method: "POST", url: "/api/v1/operations/dispatch", headers: headers(), payload: { bookingItemId, outboundInspectionId: unsafe.json().inspectionId, dispatchedAt: "2041-05-01T10:00:00Z" } });
  expect(dispatch.statusCode).toBe(422);
  expect(dispatch.json().code).toBe("DISPATCH_GATE_INCOMPLETE");
  expect(dispatch.json().details.missingRequirements).toContain("outbound_inspection");
});

it("requires either a reading or an explicit unavailable reason for fuel and odometer", async () => {
  const machineId = await makeMachine();
  const booking = await app.inject({ method: "POST", url: "/api/v1/bookings", headers: headers(), payload: { categoryLocationId, customerId, rentalPeriod: { start: "2041-06-01T10:00:00Z", end: "2041-06-02T10:00:00Z" } } });
  const bookingItemId = booking.json().booking_item_id;
  await app.inject({ method: "POST", url: "/api/v1/operations/assign", headers: headers(), payload: { bookingItemId, machineId } });

  const missingReading = await app.inject({
    method: "POST", url: "/api/v1/inspections", headers: headers(),
    payload: { bookingItemId, machineId, type: "outbound", fuelLevelPct: null, odometerMiles: 10, checkItems: [{ item: "tires", outcome: "pass" }, { item: "brakes", outcome: "pass" }, { item: "body_panels", outcome: "pass" }, { item: "safety_gear", outcome: "pass" }] },
  });
  expect(missingReading.statusCode).toBe(422);
  expect(missingReading.json().code).toBe("FUEL_READING_REQUIRED");

  const withReason = await app.inject({
    method: "POST", url: "/api/v1/inspections", headers: headers(),
    payload: {
      bookingItemId, machineId, type: "outbound", fuelLevelPct: null, odometerMiles: 10, fuelUnavailableReason: "Gauge not visible in low light",
      checkItems: [{ item: "tires", outcome: "pass" }, { item: "brakes", outcome: "pass" }, { item: "body_panels", outcome: "pass" }, { item: "safety_gear", outcome: "pass" }],
    },
  });
  expect(withReason.statusCode).toBe(201);
});

it("allows a pre-rental inspection without a manual odometer or unavailable reason", async () => {
  const machineId = await makeMachine();
  const booking = await app.inject({ method: "POST", url: "/api/v1/bookings", headers: headers(), payload: { categoryLocationId, customerId, rentalPeriod: { start: "2041-06-10T10:00:00Z", end: "2041-06-11T10:00:00Z" } } });
  const bookingItemId = booking.json().booking_item_id;
  await app.inject({ method: "POST", url: "/api/v1/operations/assign", headers: headers(), payload: { bookingItemId, machineId } });

  const inspection = await app.inject({
    method: "POST", url: "/api/v1/inspections", headers: headers(),
    payload: { bookingItemId, machineId, type: "outbound", fuelLevelPct: 100, checkItems: PASSING_CHECKLIST },
  });
  expect(inspection.statusCode).toBe(201);
  const row = (await pool.query("SELECT odometer_miles, odometer_reading_unavailable_reason FROM app.inspection WHERE inspection_id=$1", [inspection.json().inspectionId])).rows[0];
  expect(row).toEqual({ odometer_miles: null, odometer_reading_unavailable_reason: null });
});

it("never lets one booking's settlement touch a different booking's deposit hold (hold is looked up server-side, never client-supplied)", async () => {
  // The dispatch gate requires a deposit hold before a machine can even be
  // dispatched, so "returned with no hold at all" cannot occur through the
  // normal flow -- that gate is itself the safety property. The sharper,
  // reachable risk is cross-booking contamination: settle() takes only a
  // bookingItemId and resolves its OWN hold server-side, so run two
  // independent bookings through to settlement and confirm each is settled
  // strictly against its own $-amount hold.
  const machineA = await makeMachine(); const machineB = await makeMachine();
  const bookingA = await dispatchFreshBooking({ start: "2041-09-01T10:00:00Z", end: "2041-09-02T10:00:00Z", machineId: machineA, depositCents: 30000 });
  const bookingB = await dispatchFreshBooking({ start: "2041-09-03T10:00:00Z", end: "2041-09-04T10:00:00Z", machineId: machineB, depositCents: 70000 });

  for (const { bookingItemId, machineId } of [{ ...bookingA, machineId: machineA }, { ...bookingB, machineId: machineB }]) {
    const inbound = await app.inject({ method: "POST", url: "/api/v1/inspections", headers: headers(), payload: { bookingItemId, machineId, type: "inbound", fuelLevelPct: 90, odometerMiles: 40, checkItems: PASSING_CHECKLIST } });
    await app.inject({ method: "POST", url: "/api/v1/operations/return", headers: headers(), payload: { bookingItemId, inboundInspectionId: inbound.json().inspectionId, returnedAt: "2041-09-04T10:00:00Z" } });
  }

  const settleA = await app.inject({ method: "POST", url: "/api/v1/operations/settle", headers: headers(), payload: { bookingItemId: bookingA.bookingItemId, damageChargeCents: 5000 } });
  const settleB = await app.inject({ method: "POST", url: "/api/v1/operations/settle", headers: headers(), payload: { bookingItemId: bookingB.bookingItemId, damageChargeCents: 5000 } });
  expect(settleA.statusCode).toBe(200); expect(settleB.statusCode).toBe(200);
  // Each settlement is scoped to its own $300/$700 hold -- neither leaks into the other's released amount.
  expect(settleA.json()).toMatchObject({ capturedCents: 5000, releasedCents: 25000 });
  expect(settleB.json()).toMatchObject({ capturedCents: 5000, releasedCents: 65000 });
});

it("settlement always fully allocates the hold, and a charge below the hold releases the remainder", async () => {
  const machineId = await makeMachine();
  const { bookingItemId } = await dispatchFreshBooking({ start: "2041-08-01T10:00:00Z", end: "2041-08-02T10:00:00Z", machineId, depositCents: 50000 });
  const inbound = await app.inject({ method: "POST", url: "/api/v1/inspections", headers: headers(), payload: { bookingItemId, machineId, type: "inbound", fuelLevelPct: 90, odometerMiles: 40, checkItems: PASSING_CHECKLIST } });
  await app.inject({ method: "POST", url: "/api/v1/operations/return", headers: headers(), payload: { bookingItemId, inboundInspectionId: inbound.json().inspectionId, returnedAt: "2041-08-02T10:00:00Z" } });

  const settle = await app.inject({ method: "POST", url: "/api/v1/operations/settle", headers: headers(), payload: { bookingItemId, damageChargeCents: 12000 } });
  expect(settle.statusCode).toBe(200);
  const body = settle.json();
  expect(body.capturedCents + body.releasedCents).toBe(50000); // fully allocated, no accidental unallocated balance
  expect(body.capturedCents).toBe(12000);
  expect(body.releasedCents).toBe(38000);

  // Retrying the identical settlement (e.g. after a dropped response) must
  // succeed idempotently rather than erroring the caller out.
  const retry = await app.inject({ method: "POST", url: "/api/v1/operations/settle", headers: headers(), payload: { bookingItemId, damageChargeCents: 12000 } });
  expect(retry.statusCode).toBe(200);
  expect(retry.json()).toMatchObject({ alreadySettled: true, capturedCents: 12000, releasedCents: 38000 });
});
