import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/talus_test";
let admin; let pool; let tenantId; let ownerPrincipalId; let locationId; let categoryLocationId; let primaryMachineId;

async function asRole(role, callback) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); await client.query(`SET LOCAL ROLE ${role}`); const result = await callback(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
async function issueOwnerContext() {
  const { rows } = await admin.query("SELECT app.issue_context_assertion($1, $2, 'staff', 'owner', interval '10 minutes') AS token", [tenantId, ownerPrincipalId]);
  return rows[0].token;
}
async function coreAsOwner(callback) {
  const token = await issueOwnerContext();
  return asRole("talus_fn", async (client) => {
    await client.query("SELECT api.activate_request_context($1)", [token]);
    return callback(client);
  });
}
async function createBookingItem({ state = "reserved", startAt = "2030-01-10T10:00:00Z", endAt = "2030-01-12T10:00:00Z" } = {}) {
  const bookingId = crypto.randomUUID(); const bookingTermsId = crypto.randomUUID(); const itemId = crypto.randomUUID(); const itemTermsId = crypto.randomUUID();
  await admin.query("INSERT INTO app.booking (tenant_id, booking_id, booking_reference, pickup_location_id, return_location_id, state) VALUES ($1, $2, $3, $4, $4, 'draft')", [tenantId, bookingId, `M02-${crypto.randomUUID().slice(0, 8)}`, locationId]);
  await admin.query("INSERT INTO app.booking_terms_revision (tenant_id, booking_terms_revision_id, booking_id, revision_number) VALUES ($1, $2, $3, 1)", [tenantId, bookingTermsId, bookingId]);
  await admin.query("INSERT INTO app.booking_item (tenant_id, booking_item_id, booking_id, item_number, state) VALUES ($1, $2, $3, 1, $4)", [tenantId, itemId, bookingId, state]);
  await admin.query("INSERT INTO app.booking_item_terms_revision (tenant_id, booking_item_terms_revision_id, booking_item_id, booking_id, booking_terms_revision_id, category_location_id, revision_number, scheduled_start_at, scheduled_end_at, chargeable_day_count) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, 2)", [tenantId, itemTermsId, itemId, bookingId, bookingTermsId, categoryLocationId, startAt, endAt]);
  await admin.query("UPDATE app.booking_item SET current_terms_revision_id = $1 WHERE tenant_id = $2 AND booking_item_id = $3", [itemTermsId, tenantId, itemId]);
  return { bookingId, itemId, itemTermsId };
}

beforeAll(async () => {
  admin = new Pool({ connectionString: databaseUrl }); pool = new Pool({ connectionString: databaseUrl });
  const prerequisite = await admin.query("SELECT to_regclass('app.booking') AS booking_table");
  if (!prerequisite.rows[0].booking_table) throw new Error("M02 migrations are missing. Run `npm run db:migrate:test` before `npm test`.");
  tenantId = crypto.randomUUID(); ownerPrincipalId = crypto.randomUUID(); const ownerStaffUserId = crypto.randomUUID(); const runId = crypto.randomUUID().slice(0, 8);
  await admin.query("SELECT app.onboard_tenant($1, $2, 'M02 Core', $3, $4)", [tenantId, `m02-${runId}`, ownerStaffUserId, ownerPrincipalId]);
  locationId = crypto.randomUUID(); const categoryId = crypto.randomUUID(); categoryLocationId = crypto.randomUUID(); primaryMachineId = crypto.randomUUID();
  await admin.query("INSERT INTO app.location (tenant_id, location_id, display_name, timezone_name) VALUES ($1, $2, 'Core Yard', 'America/Denver')", [tenantId, locationId]);
  await admin.query("INSERT INTO app.rental_category (tenant_id, rental_category_id, display_name) VALUES ($1, $2, 'Core UTV')", [tenantId, categoryId]);
  await admin.query("INSERT INTO app.category_location (tenant_id, category_location_id, rental_category_id, location_id) VALUES ($1, $2, $3, $4)", [tenantId, categoryLocationId, categoryId, locationId]);
  await admin.query("INSERT INTO app.machine (tenant_id, machine_id, category_location_id, display_name, operational_state) VALUES ($1, $2, $3, 'Core Machine 1', 'in_service')", [tenantId, primaryMachineId, categoryLocationId]);
}, 30_000);
afterAll(async () => { await pool?.end(); await admin?.end(); });

describe("M02 Booking Core", () => {
  it("serializes two normal claims competing for the last category unit", async () => {
    const first = await createBookingItem(); const second = await createBookingItem(); const firstToken = await issueOwnerContext(); const secondToken = await issueOwnerContext();
    const firstClient = await pool.connect(); const secondClient = await pool.connect();
    try {
      await firstClient.query("BEGIN"); await firstClient.query("SET LOCAL ROLE talus_fn"); await firstClient.query("SELECT api.activate_request_context($1)", [firstToken]); await firstClient.query("SELECT app.accept_core_commitment($1, 'committed')", [first.itemId]);
      const secondAttempt = (async () => { await secondClient.query("BEGIN"); await secondClient.query("SET LOCAL ROLE talus_fn"); await secondClient.query("SELECT api.activate_request_context($1)", [secondToken]); return secondClient.query("SELECT app.accept_core_commitment($1, 'committed')", [second.itemId]); })();
      await new Promise((resolve) => setTimeout(resolve, 100)); await firstClient.query("COMMIT"); await expect(secondAttempt).rejects.toThrow(/CAPACITY_EXCEEDED/); await secondClient.query("ROLLBACK");
    } finally { firstClient.release(); secondClient.release(); }
  });

  it("reports zero for fragmented machine capacity across a whole interval", async () => {
    const machineTwo = crypto.randomUUID();
    await admin.query("INSERT INTO app.machine (tenant_id, machine_id, category_location_id, display_name, operational_state) VALUES ($1, $2, $3, $4, 'in_service')", [tenantId, machineTwo, categoryLocationId, `Core Machine ${crypto.randomUUID().slice(0, 6)}`]);
    await admin.query("INSERT INTO app.machine_occupancy (tenant_id, machine_id, occupancy_kind, maintenance_reference_id, occupancy_range) VALUES ($1, $2, 'maintenance', $3, tstzrange('2031-01-10T10:00:00Z', '2031-01-11T10:00:00Z', '[)')), ($1, $4, 'maintenance', $5, tstzrange('2031-01-11T10:00:00Z', '2031-01-12T10:00:00Z', '[)'))", [tenantId, primaryMachineId, crypto.randomUUID(), machineTwo, crypto.randomUUID()]);
    const availability = await admin.query("SELECT app.read_core_availability($1, $2, '2031-01-10T10:00:00Z', '2031-01-12T10:00:00Z') AS available", [tenantId, categoryLocationId]);
    expect(availability.rows[0].available).toBe(0);
  });

  it("rejects rental and maintenance overlap while allowing adjacent occupancy", async () => {
    const item = await createBookingItem({ startAt: "2032-01-10T10:00:00Z", endAt: "2032-01-12T10:00:00Z" }); const machineId = crypto.randomUUID();
    await admin.query("INSERT INTO app.machine (tenant_id, machine_id, category_location_id, display_name, operational_state) VALUES ($1, $2, $3, $4, 'in_service')", [tenantId, machineId, categoryLocationId, `Overlap Machine ${crypto.randomUUID().slice(0, 6)}`]);
    await admin.query("INSERT INTO app.machine_occupancy (tenant_id, machine_id, booking_item_id, booking_item_terms_revision_id, occupancy_kind, occupancy_range) VALUES ($1, $2, $3, $4, 'rental', tstzrange('2032-01-10T10:00:00Z', '2032-01-11T10:00:00Z', '[)'))", [tenantId, machineId, item.itemId, item.itemTermsId]);
    await expect(admin.query("INSERT INTO app.machine_occupancy (tenant_id, machine_id, occupancy_kind, maintenance_reference_id, occupancy_range) VALUES ($1, $2, 'maintenance', $3, tstzrange('2032-01-10T12:00:00Z', '2032-01-11T12:00:00Z', '[)'))", [tenantId, machineId, crypto.randomUUID()])).rejects.toThrow(/machine_occupancy_blocking_exclusion/);
    await expect(admin.query("INSERT INTO app.machine_occupancy (tenant_id, machine_id, occupancy_kind, maintenance_reference_id, occupancy_range) VALUES ($1, $2, 'maintenance', $3, tstzrange('2032-01-11T10:00:00Z', '2032-01-12T10:00:00Z', '[)'))", [tenantId, machineId, crypto.randomUUID()])).resolves.toBeDefined();
  });

  it("rejects a booking close while any constituent item is nonterminal", async () => {
    const item = await createBookingItem(); const client = await admin.connect();
    try { await client.query("BEGIN"); await client.query("UPDATE app.booking SET state = 'closed' WHERE tenant_id = $1 AND booking_id = $2", [tenantId, item.bookingId]); await expect(client.query("COMMIT")).rejects.toThrow(/BOOKING_CLOSE_BLOCKED/); }
    finally { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
  });

  it("rejects adding an item beneath a terminal booking and preserves terms revisions", async () => {
    const item = await createBookingItem({ state: "closed" });
    await admin.query("UPDATE app.booking SET state = 'closed' WHERE tenant_id = $1 AND booking_id = $2", [tenantId, item.bookingId]);
    await expect(admin.query("INSERT INTO app.booking_item (tenant_id, booking_item_id, booking_id, item_number, state) VALUES ($1, $2, $3, 2, 'reserved')", [tenantId, crypto.randomUUID(), item.bookingId])).rejects.toThrow(/TERMINAL_BOOKING_MUTATION_FORBIDDEN/);
    await expect(admin.query("UPDATE app.booking_item_terms_revision SET scheduled_end_at = scheduled_end_at + interval '1 hour' WHERE tenant_id = $1 AND booking_item_terms_revision_id = $2", [tenantId, item.itemTermsId])).rejects.toThrow(/TERMS_REVISION_IMMUTABLE/);
  });

  it("keeps private Core operations unavailable to customer-facing pool roles", async () => {
    const privilege = await admin.query("SELECT has_function_privilege('talus_api', 'app.core_close_booking(uuid)', 'EXECUTE') AS can_execute"); expect(privilege.rows[0].can_execute).toBe(false);
    await asRole("talus_api", (client) => expect(client.query("SELECT app.core_close_booking($1)", [crypto.randomUUID()])).rejects.toThrow(/permission denied/));
  });

  it("opens and seals a Trip only through the private staff Core operation", async () => {
    const item = await createBookingItem({ state: "checked_out", startAt: "2033-01-10T10:00:00Z", endAt: "2033-01-12T10:00:00Z" }); const machineId = crypto.randomUUID(); const occupancyId = crypto.randomUUID(); const occurrenceId = crypto.randomUUID();
    await admin.query("INSERT INTO app.machine (tenant_id, machine_id, category_location_id, display_name, operational_state) VALUES ($1, $2, $3, $4, 'in_service')", [tenantId, machineId, categoryLocationId, `Trip Machine ${crypto.randomUUID().slice(0, 6)}`]);
    await admin.query("INSERT INTO app.machine_occupancy (tenant_id, machine_occupancy_id, machine_id, booking_item_id, booking_item_terms_revision_id, occupancy_kind, occupancy_range) VALUES ($1, $2, $3, $4, $5, 'rental', tstzrange('2033-01-10T10:00:00Z', '2033-01-12T10:00:00Z', '[)'))", [tenantId, occupancyId, machineId, item.itemId, item.itemTermsId]);
    await admin.query("INSERT INTO app.checkout_occurrence (tenant_id, checkout_occurrence_id, booking_item_id, machine_occupancy_id, checkout_ordinal, initiated_by_principal_id) VALUES ($1, $2, $3, $4, 1, $5)", [tenantId, occurrenceId, item.itemId, occupancyId, ownerPrincipalId]);
    const tripId = await coreAsOwner(async (client) => (await client.query("SELECT app.open_core_trip($1, $2, $3, $4) AS trip_id", [item.itemId, occupancyId, occurrenceId, "2033-01-10T10:15:00Z"])).rows[0].trip_id);
    await coreAsOwner((client) => client.query("SELECT app.seal_core_trip($1, $2)", [tripId, "2033-01-12T10:15:00Z"]));
    const trip = await admin.query("SELECT started_at, ended_at FROM app.trip WHERE tenant_id = $1 AND trip_id = $2", [tenantId, tripId]);
    expect(trip.rows[0].ended_at).not.toBeNull();
    const simulated = await admin.query("SELECT to_regprocedure('app.open_trip_from_motion(uuid)') AS operation");
    expect(simulated.rows[0].operation).toBeNull();
  });
});
