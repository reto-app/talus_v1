import crypto from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://mbinghamfamily@localhost:5432/talus_test";
const id = () => crypto.randomUUID();
const PASSING_CHECKLIST = [{ item: "tires", outcome: "pass" }, { item: "brakes", outcome: "pass" }, { item: "body_panels", outcome: "pass" }, { item: "safety_gear", outcome: "pass" }];

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
  await pool.query("SELECT app.onboard_tenant($1,$2,'Return Close Suite',$3,$4)", [tenantId, `retclose-${tenantId.slice(0, 8)}`, id(), ownerId]);
  staffToken = (await pool.query("SELECT app.issue_context_assertion($1,$2,'staff','owner',interval '15 min') token", [tenantId, ownerId])).rows[0].token;
  await staff((client) => client.query(
    "SELECT api.create_customer($1,$2,'Return Close Customer',$3,$4,$5)",
    [customerId, id(), `retclose-${tenantId.slice(0, 8)}@example.test`, `customer:${id()}`, "return-close-customer"],
  ));
  await pool.query("INSERT INTO app.location VALUES($1,$2,'Return Close Yard','America/Denver',clock_timestamp())", [tenantId, locationId]);
  await pool.query("INSERT INTO app.rental_category(tenant_id,rental_category_id,display_name) VALUES($1,$2,'Return Close Category')", [tenantId, categoryId]);
  await pool.query("INSERT INTO app.category_location VALUES($1,$2,$3,$4,true,clock_timestamp())", [tenantId, categoryLocationId, categoryId, locationId]);
  for (const [code, type] of [["cash", "asset"], ["deposits_held", "liability"], ["revenue", "revenue"], ["deposit_clearing", "asset"]]) {
    await pool.query("INSERT INTO app.ledger_account VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [tenantId, id(), code, type]);
  }
  await pool.query("INSERT INTO app.tenant_waiver_policy(tenant_id,tenant_waiver_policy_id,version_number,signing_mode) VALUES($1,$2,1,'individual') ON CONFLICT DO NOTHING", [tenantId, id()]);
  app = await buildApp(pool);
});
afterAll(async () => { await app.close(); await pool.end(); });

async function makeMachine(fleetNumber) {
  const machineId = id();
  await pool.query(
    "INSERT INTO app.machine(tenant_id,machine_id,category_location_id,display_name,operational_state,fleet_number) VALUES($1,$2,$3,$4,'in_service',$5)",
    [tenantId, machineId, categoryLocationId, `Return Close Machine ${machineId.slice(0, 6)}`, fleetNumber],
  );
  return machineId;
}

async function bookAndDispatch({ start, end, machineId, depositCents = 50000 }) {
  const booking = await app.inject({ method: "POST", url: "/api/v1/bookings", headers: headers(), payload: { categoryLocationId, customerId, rentalPeriod: { start, end } } });
  const bookingItemId = booking.json().booking_item_id;
  await pool.query("INSERT INTO app.booking_driver(tenant_id,booking_item_id,customer_id,is_primary) VALUES($1,$2,$3,true)", [tenantId, bookingItemId, customerId]);
  await app.inject({ method: "POST", url: "/api/v1/operations/assign", headers: headers(), payload: { bookingItemId, machineId } });
  await app.inject({ method: "POST", url: `/api/v1/bookings/${bookingItemId}/waivers`, headers: headers(), payload: { customerId, signerName: "Return Close Customer", signatureRef: `sig:${id()}`, signerIp: "127.0.0.1" } });
  let holdTransactionId = null;
  if (depositCents > 0) {
    const hold = await app.inject({ method: "POST", url: `/api/v1/bookings/${bookingItemId}/deposit-hold`, headers: headers(), payload: { amountCents: depositCents, paymentReference: `hold:${id()}` } });
    holdTransactionId = hold.json().transactionId;
  }
  const outbound = await app.inject({ method: "POST", url: "/api/v1/inspections", headers: headers(), payload: { bookingItemId, machineId, type: "outbound", fuelLevelPct: 100, odometerMiles: 10, checkItems: PASSING_CHECKLIST } });
  const dispatch = await app.inject({ method: "POST", url: "/api/v1/operations/dispatch", headers: headers(), payload: { bookingItemId, outboundInspectionId: outbound.json().inspectionId, dispatchedAt: start } });
  expect(dispatch.statusCode).toBe(200);
  return { bookingId: booking.json().booking_id, bookingItemId, tripId: dispatch.json().trip_id, holdTransactionId };
}

it("physical return is always immediate and unconditional -- even for an unconfigured tenant, which still requires the post-return inspection before the item can be closed", async () => {
  const machineId = await makeMachine("RC-101");
  const { bookingItemId, tripId } = await bookAndDispatch({ start: "2042-01-01T10:00:00Z", end: "2042-01-02T10:00:00Z", machineId });

  // No inspection id was supplied at all, yet return still succeeds --
  // app.receive_booking_return never gates on inspection completion.
  const returned = await app.inject({ method: "POST", url: "/api/v1/operations/return", headers: headers(), payload: { bookingItemId, returnedAt: "2042-01-02T10:00:00Z" } });
  expect(returned.statusCode).toBe(200);

  const tripRow = await pool.query("SELECT ended_at FROM app.trip WHERE trip_id=$1", [tripId]);
  expect(tripRow.rows[0].ended_at).toBeTruthy();
  const itemRow = await pool.query("SELECT state FROM app.booking_item WHERE booking_item_id=$1", [bookingItemId]);
  expect(itemRow.rows[0].state).toBe("returned");

  // The requirement itself hasn't gone away for an unconfigured tenant --
  // it now applies at close time instead of blocking the return.
  const closeBeforeInspection = await app.inject({ method: "POST", url: `/api/v1/operations/booking-items/${bookingItemId}/close`, headers: headers(), payload: {} });
  expect(closeBeforeInspection.statusCode).toBe(409);
  expect(closeBeforeInspection.json().code).toBe("CLOSE_REQUIRES_INSPECTION");

  // Completing the inspection clears that blocker -- the remaining,
  // separately-tracked blocker (deposit settlement) then takes over.
  const inbound = await app.inject({ method: "POST", url: "/api/v1/inspections", headers: headers(), payload: { bookingItemId, machineId, type: "inbound", fuelLevelPct: 90, odometerMiles: 40, checkItems: PASSING_CHECKLIST } });
  expect(inbound.statusCode).toBe(201);
  const closeBeforeSettle = await app.inject({ method: "POST", url: `/api/v1/operations/booking-items/${bookingItemId}/close`, headers: headers(), payload: {} });
  expect(closeBeforeSettle.statusCode).toBe(409);
  expect(closeBeforeSettle.json().code).toBe("CLOSE_REQUIRES_SETTLEMENT");
});

it("records physical return, ending the trip, even though inspection and settlement remain outstanding -- and keeps returned distinct from closed", async () => {
  // Publish a tenant configuration where the post-return inspection is not required.
  const policyId = id();
  await pool.query("INSERT INTO app.tenant_inspection_policy(tenant_id,tenant_inspection_policy_id,version_number,pre_checkout_required,post_return_required) VALUES($1,$2,1,true,false)", [tenantId, policyId]);
  const bookingPolicyId = id();
  await pool.query("INSERT INTO app.tenant_booking_policy(tenant_id,tenant_booking_policy_id,version_number,timezone_name,booking_window_days,minimum_advance_minutes,assignment_lead_minutes,calendar_day_convention) VALUES($1,$2,1,'America/Denver',90,0,60,'pickup_date_inclusive')", [tenantId, bookingPolicyId]);
  const waiverPolicyRow = await pool.query("SELECT tenant_waiver_policy_id FROM app.tenant_waiver_policy WHERE tenant_id=$1 ORDER BY version_number DESC LIMIT 1", [tenantId]);
  const pricingPolicyId = id();
  await pool.query("INSERT INTO app.tenant_pricing_policy(tenant_id,tenant_pricing_policy_id,version_number,multi_day_discount_basis_points,rounding_rule_version,allocation_rule_version,tax_mode) VALUES($1,$2,1,0,'v1','v1','unconfigured')", [tenantId, pricingPolicyId]);
  const paymentPolicyId = id();
  await pool.query("INSERT INTO app.tenant_payment_policy(tenant_id,tenant_payment_policy_id,version_number,payment_timing,platform_fee_mode,cancellation_terms) VALUES($1,$2,1,'split_deposit','unconfigured','{}')", [tenantId, paymentPolicyId]);
  const telemetryPolicyId = id();
  await pool.query("INSERT INTO app.tenant_telemetry_policy(tenant_id,tenant_telemetry_policy_id,version_number,raw_retention_days,freshness_threshold_seconds,clock_tolerance_seconds) VALUES($1,$2,1,30,300,30)", [tenantId, telemetryPolicyId]);
  const smsConfigId = id();
  await pool.query("INSERT INTO app.tenant_sms_config(tenant_id,tenant_sms_config_id,version_number,enabled,sender_reference) VALUES($1,$2,1,false,'unset')", [tenantId, smsConfigId]);
  await staff((client) => client.query(
    "SELECT app.publish_configuration_version($1,1,$2,$3,$4,$5,$6,$7,$8)",
    [id(), bookingPolicyId, waiverPolicyRow.rows[0].tenant_waiver_policy_id, policyId, pricingPolicyId, paymentPolicyId, telemetryPolicyId, smsConfigId],
  ));

  const machineId = await makeMachine("RC-102");
  const { bookingItemId, tripId } = await bookAndDispatch({ start: "2042-01-03T10:00:00Z", end: "2042-01-04T10:00:00Z", machineId });

  const returned = await app.inject({ method: "POST", url: "/api/v1/operations/return", headers: headers(), payload: { bookingItemId, returnedAt: "2042-01-04T10:00:00Z" } });
  expect(returned.statusCode).toBe(200);

  const tripRow = await pool.query("SELECT ended_at FROM app.trip WHERE trip_id=$1", [tripId]);
  expect(tripRow.rows[0].ended_at).toBeTruthy();

  const itemRow = await pool.query("SELECT state FROM app.booking_item WHERE booking_item_id=$1", [bookingItemId]);
  expect(itemRow.rows[0].state).toBe("returned");
  expect(itemRow.rows[0].state).not.toBe("closed");

  // Returning frees the machine occupancy's `blocking` flag so it can be
  // reassigned elsewhere, but the dispatch board must still show which
  // machine this item was on -- it should come from the trip, not the
  // (now non-blocking) occupancy.
  const board = await app.inject({ method: "GET", url: `/api/v1/operations/dispatch-board?date=2042-01-03`, headers: headers() });
  const row = board.json().items.find((r) => r.booking_item_id === bookingItemId);
  expect(row.machine_id).toBeTruthy();
  expect(row.fleet_number).toBe("RC-102");
});

it("blocks closing an item until it is returned, and until its deposit hold is settled -- then allows close", async () => {
  const machineId = await makeMachine("RC-103");
  const { bookingItemId } = await bookAndDispatch({ start: "2042-02-01T10:00:00Z", end: "2042-02-02T10:00:00Z", machineId });

  const closeBeforeReturn = await app.inject({ method: "POST", url: `/api/v1/operations/booking-items/${bookingItemId}/close`, headers: headers(), payload: {} });
  expect(closeBeforeReturn.statusCode).toBe(409);
  expect(closeBeforeReturn.json().code).toBe("CLOSE_REQUIRES_RETURN");

  const inbound = await app.inject({ method: "POST", url: "/api/v1/inspections", headers: headers(), payload: { bookingItemId, machineId, type: "inbound", fuelLevelPct: 90, odometerMiles: 40, checkItems: PASSING_CHECKLIST } });
  await app.inject({ method: "POST", url: "/api/v1/operations/return", headers: headers(), payload: { bookingItemId, inboundInspectionId: inbound.json().inspectionId, returnedAt: "2042-02-02T10:00:00Z" } });

  const closeBeforeSettle = await app.inject({ method: "POST", url: `/api/v1/operations/booking-items/${bookingItemId}/close`, headers: headers(), payload: {} });
  expect(closeBeforeSettle.statusCode).toBe(409);
  expect(closeBeforeSettle.json().code).toBe("CLOSE_REQUIRES_SETTLEMENT");

  const settle = await app.inject({ method: "POST", url: "/api/v1/operations/settle", headers: headers(), payload: { bookingItemId, damageChargeCents: 0 } });
  expect(settle.statusCode).toBe(200);

  const close = await app.inject({ method: "POST", url: `/api/v1/operations/booking-items/${bookingItemId}/close`, headers: headers(), payload: { reason: "Trip complete" } });
  expect(close.statusCode).toBe(200);
  const itemRow = await pool.query("SELECT state FROM app.booking_item WHERE booking_item_id=$1", [bookingItemId]);
  expect(itemRow.rows[0].state).toBe("closed");
});

it("supports a three-item booking with mixed states, and only allows closing the overall booking once every item reaches a terminal state", async () => {
  const start = "2042-03-01T10:00:00Z", end = "2042-03-02T10:00:00Z";
  const { bookingId, bookingItemId: item1 } = await bookAndDispatch({ start, end, machineId: await makeMachine("RC-201") });

  // Add two more items to the SAME booking directly (multi-item booking
  // creation is not yet exposed through the public API -- see stage 9 --
  // but each item must already behave fully independently once it exists).
  const termsRevisionRow = await pool.query(
    "SELECT booking_terms_revision_id FROM app.booking_item_terms_revision WHERE booking_item_id=$1", [item1],
  );
  const bookingTermsRevisionId = termsRevisionRow.rows[0].booking_terms_revision_id;

  async function addItem(itemNumber, machineId) {
    const bookingItemId = id();
    const termsId = id();
    await pool.query("INSERT INTO app.booking_item(tenant_id,booking_item_id,booking_id,item_number,state) VALUES($1,$2,$3,$4,'reserved')", [tenantId, bookingItemId, bookingId, itemNumber]);
    await pool.query(
      "INSERT INTO app.booking_item_terms_revision(tenant_id,booking_item_terms_revision_id,booking_item_id,booking_id,booking_terms_revision_id,category_location_id,revision_number,scheduled_start_at,scheduled_end_at,chargeable_day_count) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,1)",
      [tenantId, termsId, bookingItemId, bookingId, bookingTermsRevisionId, categoryLocationId, start, end],
    );
    await pool.query("UPDATE app.booking_item SET current_terms_revision_id=$1 WHERE tenant_id=$2 AND booking_item_id=$3", [termsId, tenantId, bookingItemId]);
    await pool.query("INSERT INTO app.booking_driver(tenant_id,booking_item_id,customer_id,is_primary) VALUES($1,$2,$3,true)", [tenantId, bookingItemId, customerId]);
    await app.inject({ method: "POST", url: "/api/v1/operations/assign", headers: headers(), payload: { bookingItemId, machineId } });
    await app.inject({ method: "POST", url: `/api/v1/bookings/${bookingItemId}/waivers`, headers: headers(), payload: { customerId, signerName: "Return Close Customer", signatureRef: `sig:${id()}`, signerIp: "127.0.0.1" } });
    return bookingItemId;
  }
  const item2 = await addItem(2, await makeMachine("RC-202"));
  const item3 = await addItem(3, await makeMachine("RC-203"));

  // Item 1: dispatched already (from bookAndDispatch). Return it now.
  const inbound1 = await app.inject({ method: "POST", url: "/api/v1/inspections", headers: headers(), payload: { bookingItemId: item1, machineId: (await pool.query("SELECT machine_id FROM app.trip WHERE booking_item_id=$1 AND ended_at IS NULL", [item1])).rows[0].machine_id, type: "inbound", fuelLevelPct: 90, odometerMiles: 40, checkItems: PASSING_CHECKLIST } });
  await app.inject({ method: "POST", url: "/api/v1/operations/return", headers: headers(), payload: { bookingItemId: item1, inboundInspectionId: inbound1.json().inspectionId, returnedAt: end } });
  const settle1 = await app.inject({ method: "POST", url: "/api/v1/operations/settle", headers: headers(), payload: { bookingItemId: item1 } });
  expect(settle1.statusCode).toBe(200);
  const close1 = await app.inject({ method: "POST", url: `/api/v1/operations/booking-items/${item1}/close`, headers: headers(), payload: {} });
  expect(close1.statusCode).toBe(200);

  // Items 2 and 3 remain out (never dispatched even). A mid-state board read
  // must show all three items as independently tracked under one booking.
  const board = await app.inject({ method: "GET", url: `/api/v1/operations/dispatch-board?date=2042-03-01`, headers: headers() });
  const rowsForBooking = board.json().items.filter((row) => row.booking_id === bookingId);
  expect(rowsForBooking.map((row) => row.booking_item_id).sort()).toEqual([item1, item2, item3].sort());
  expect(rowsForBooking.find((row) => row.booking_item_id === item1).booking_item_state).toBe("closed");
  expect(rowsForBooking.find((row) => row.booking_item_id === item2).booking_item_state).toBe("reserved");

  // Booking cannot close while items 2 and 3 are still open.
  const closeBookingEarly = await app.inject({ method: "POST", url: `/api/v1/operations/bookings/${bookingId}/close`, headers: headers() });
  expect(closeBookingEarly.statusCode).toBe(409);
  expect(closeBookingEarly.json().code).toBe("CLOSE_REQUIRES_ALL_ITEMS_TERMINAL");

  // Cancel items 2 and 3 directly (no cancellation endpoint exists yet) so
  // every item reaches a terminal state, then the booking can close.
  await staff((client) => client.query("UPDATE app.booking_item SET state='cancelled' WHERE tenant_id=$1 AND booking_item_id IN ($2,$3)", [tenantId, item2, item3]));
  const closeBookingFinal = await app.inject({ method: "POST", url: `/api/v1/operations/bookings/${bookingId}/close`, headers: headers() });
  expect(closeBookingFinal.statusCode).toBe(200);
  const bookingRow = await pool.query("SELECT state FROM app.booking WHERE booking_id=$1", [bookingId]);
  expect(bookingRow.rows[0].state).toBe("closed");
});
