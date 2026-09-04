import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/talus_test";
let admin; let pool;
let tenantA; let tenantB; let ownerA; let managerA; let staffA; let ownerB;
let locationA; let categoryA; let categoryLocationA;

async function asFn(token, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE talus_fn");
    await client.query("SELECT api.activate_request_context($1)", [token]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function issueContext(tenantId, principalId, role) {
  const { rows } = await admin.query(
    "SELECT app.issue_context_assertion($1, $2, 'staff', $3, interval '10 minutes') AS token",
    [tenantId, principalId, role],
  );
  return rows[0].token;
}

async function asPrincipal(tenantId, principalId, role, callback) {
  return asFn(await issueContext(tenantId, principalId, role), callback);
}

async function createTenant(slug) {
  const tenantId = crypto.randomUUID(); const staffUserId = crypto.randomUUID(); const principalId = crypto.randomUUID();
  await admin.query("SELECT app.onboard_tenant($1, $2, $3, $4, $5)", [tenantId, slug, `${slug} Tenant`, staffUserId, principalId]);
  return { tenantId, principalId };
}

async function createBookingWithSnapshots(configurationVersionId, rateId) {
  const bookingId = crypto.randomUUID(); const bookingTermsId = crypto.randomUUID(); const itemId = crypto.randomUUID(); const itemTermsId = crypto.randomUUID();
  await admin.query("INSERT INTO app.booking (tenant_id, booking_id, booking_reference, pickup_location_id, return_location_id, state) VALUES ($1, $2, $3, $4, $4, 'draft')", [tenantA, bookingId, `M03-${crypto.randomUUID().slice(0, 8)}`, locationA]);
  await admin.query("INSERT INTO app.booking_terms_revision (tenant_id, booking_terms_revision_id, booking_id, revision_number, tenant_configuration_version_id) VALUES ($1, $2, $3, 1, $4)", [tenantA, bookingTermsId, bookingId, configurationVersionId]);
  await admin.query("INSERT INTO app.booking_item (tenant_id, booking_item_id, booking_id, item_number, state) VALUES ($1, $2, $3, 1, 'checked_out')", [tenantA, itemId, bookingId]);
  await admin.query("INSERT INTO app.booking_item_terms_revision (tenant_id, booking_item_terms_revision_id, booking_item_id, booking_id, booking_terms_revision_id, category_location_id, revision_number, scheduled_start_at, scheduled_end_at, chargeable_day_count, product_rate_id) VALUES ($1, $2, $3, $4, $5, $6, 1, '2034-01-10T10:00:00Z', '2034-01-12T10:00:00Z', 2, $7)", [tenantA, itemTermsId, itemId, bookingId, bookingTermsId, categoryLocationA, rateId]);
  await admin.query("UPDATE app.booking_item SET current_terms_revision_id = $1 WHERE tenant_id = $2 AND booking_item_id = $3", [itemTermsId, tenantA, itemId]);
  return { bookingId, bookingTermsId, itemId, itemTermsId };
}

beforeAll(async () => {
  admin = new Pool({ connectionString: databaseUrl }); pool = new Pool({ connectionString: databaseUrl });
  const prerequisite = await admin.query("SELECT to_regclass('app.tenant_booking_policy') AS policy_table");
  if (!prerequisite.rows[0].policy_table) throw new Error("M03 migrations are missing. Run `npm run db:migrate:test` before `npm test`.");

  const run = crypto.randomUUID().slice(0, 8);
  ({ tenantId: tenantA, principalId: ownerA } = await createTenant(`m03a-${run}`));
  ({ tenantId: tenantB, principalId: ownerB } = await createTenant(`m03b-${run}`));
  const managerUser = crypto.randomUUID(); managerA = crypto.randomUUID(); const staffUser = crypto.randomUUID(); staffA = crypto.randomUUID();
  await admin.query("INSERT INTO app.staff_user (tenant_id, staff_user_id, display_name, email) VALUES ($1, $2, 'Manager A', $3), ($1, $4, 'Staff A', $5)", [tenantA, managerUser, `manager-${run}@example.test`, staffUser, `staff-${run}@example.test`]);
  await admin.query("INSERT INTO app.principal (tenant_id, principal_id, caller_class, staff_user_id) VALUES ($1, $2, 'staff', $3), ($1, $4, 'staff', $5)", [tenantA, managerA, managerUser, staffA, staffUser]);
  await admin.query("INSERT INTO app.staff_membership (tenant_id, staff_user_id, principal_id, role) VALUES ($1, $2, $3, 'manager'), ($1, $4, $5, 'staff')", [tenantA, managerUser, managerA, staffUser, staffA]);
  locationA = crypto.randomUUID(); categoryA = crypto.randomUUID(); categoryLocationA = crypto.randomUUID();
  await admin.query("INSERT INTO app.location (tenant_id, location_id, display_name, timezone_name) VALUES ($1, $2, 'M03 Yard', 'America/Denver')", [tenantA, locationA]);
  await admin.query("INSERT INTO app.rental_category (tenant_id, rental_category_id, display_name) VALUES ($1, $2, 'M03 UTV')", [tenantA, categoryA]);
  await admin.query("INSERT INTO app.category_location (tenant_id, category_location_id, rental_category_id, location_id) VALUES ($1, $2, $3, $4)", [tenantA, categoryLocationA, categoryA, locationA]);
}, 30_000);
afterAll(async () => { await pool?.end(); await admin?.end(); });

describe("M03 tenant configuration, catalog, and fleet", () => {
  it("isolates catalog and configuration writes between tenant managers", async () => {
    const productId = crypto.randomUUID();
    await asPrincipal(tenantA, managerA, "manager", (client) => client.query("SELECT app.create_rental_product($1, $2, $3, $4, $5)", [productId, categoryLocationA, "m03-utv", "M03 UTV Rental", "Tenant A product"]));
    const visibleToA = await asPrincipal(tenantA, managerA, "manager", (client) => client.query("SELECT rental_product_id FROM app.rental_product WHERE tenant_id = $1", [tenantA]));
    expect(visibleToA.rowCount).toBeGreaterThan(0);
    const invisibleToB = await asPrincipal(tenantB, ownerB, "owner", (client) => client.query("SELECT rental_product_id FROM app.rental_product WHERE tenant_id = $1", [tenantA]));
    expect(invisibleToB.rowCount).toBe(0);
    await expect(asPrincipal(tenantB, ownerB, "owner", (client) => client.query("SELECT app.update_product_rate($1, $2, $3, $4)", [crypto.randomUUID(), productId, "2034-01-01T00:00:00Z", "12000"]))).rejects.toThrow(/RESOURCE_NOT_FOUND/);
  });

  it("allows only managers or owners to publish configuration and rate versions", async () => {
    const bookingPolicyId = crypto.randomUUID(); const waiverPolicyId = crypto.randomUUID(); const inspectionPolicyId = crypto.randomUUID(); const pricingPolicyId = crypto.randomUUID(); const paymentPolicyId = crypto.randomUUID(); const telemetryPolicyId = crypto.randomUUID(); const smsConfigId = crypto.randomUUID();
    await admin.query("INSERT INTO app.tenant_booking_policy (tenant_id, tenant_booking_policy_id, version_number, timezone_name, booking_window_days, minimum_advance_minutes, assignment_lead_minutes, calendar_day_convention) VALUES ($1, $2, 1, 'America/Denver', 365, 60, 1440, 'pickup_date_inclusive')", [tenantA, bookingPolicyId]);
    await admin.query("INSERT INTO app.tenant_waiver_policy (tenant_id, tenant_waiver_policy_id, version_number, signing_mode, required_fields) VALUES ($1, $2, 1, 'individual', '{}'::jsonb)", [tenantA, waiverPolicyId]);
    await admin.query("INSERT INTO app.tenant_inspection_policy (tenant_id, tenant_inspection_policy_id, version_number, pre_checkout_required, post_return_required) VALUES ($1, $2, 1, false, false)", [tenantA, inspectionPolicyId]);
    await admin.query("INSERT INTO app.tenant_pricing_policy (tenant_id, tenant_pricing_policy_id, version_number, multi_day_discount_basis_points, rounding_rule_version, allocation_rule_version, tax_mode) VALUES ($1, $2, 1, 0, 'v1', 'v1', 'unconfigured')", [tenantA, pricingPolicyId]);
    await admin.query("INSERT INTO app.tenant_payment_policy (tenant_id, tenant_payment_policy_id, version_number, payment_timing, platform_fee_mode, cancellation_terms) VALUES ($1, $2, 1, 'pay_in_full', 'unconfigured', '{}'::jsonb)", [tenantA, paymentPolicyId]);
    await admin.query("INSERT INTO app.tenant_telemetry_policy (tenant_id, tenant_telemetry_policy_id, version_number, raw_retention_days, freshness_threshold_seconds, clock_tolerance_seconds) VALUES ($1, $2, 1, 90, 300, 300)", [tenantA, telemetryPolicyId]);
    await admin.query("INSERT INTO app.tenant_sms_config (tenant_id, tenant_sms_config_id, version_number, enabled, sender_reference) VALUES ($1, $2, 1, false, 'none')", [tenantA, smsConfigId]);
    const configId = crypto.randomUUID(); const publishArgs = [configId, 1, bookingPolicyId, waiverPolicyId, inspectionPolicyId, pricingPolicyId, paymentPolicyId, telemetryPolicyId, smsConfigId];
    await expect(asPrincipal(tenantA, staffA, "staff", (client) => client.query("SELECT app.publish_configuration_version($1, $2, $3, $4, $5, $6, $7, $8, $9)", publishArgs))).rejects.toThrow(/ACTION_FORBIDDEN/);
    await asPrincipal(tenantA, managerA, "manager", (client) => client.query("SELECT app.publish_configuration_version($1, $2, $3, $4, $5, $6, $7, $8, $9)", publishArgs));
    const productId = crypto.randomUUID(); await asPrincipal(tenantA, managerA, "manager", (client) => client.query("SELECT app.create_rental_product($1, $2, $3, $4, $5)", [productId, categoryLocationA, `rate-${crypto.randomUUID().slice(0, 6)}`, "Rate Product", ""]));
    await expect(asPrincipal(tenantA, staffA, "staff", (client) => client.query("SELECT app.update_product_rate($1, $2, $3, $4)", [crypto.randomUUID(), productId, "2034-01-01T00:00:00Z", "12000"]))).rejects.toThrow(/ACTION_FORBIDDEN/);
  });

  it("preserves booking and trip policy/rate snapshots after later publication", async () => {
    const policy = await admin.query("SELECT tenant_booking_policy_id, tenant_waiver_policy_id, tenant_inspection_policy_id, tenant_pricing_policy_id, tenant_payment_policy_id, tenant_telemetry_policy_id, tenant_sms_config_id FROM app.tenant_configuration_version WHERE tenant_id = $1 ORDER BY version_number DESC LIMIT 1", [tenantA]);
    const productId = crypto.randomUUID(); const rateOneId = crypto.randomUUID();
    await asPrincipal(tenantA, managerA, "manager", (client) => client.query("SELECT app.create_rental_product($1, $2, $3, $4, $5)", [productId, categoryLocationA, `snapshot-${crypto.randomUUID().slice(0, 6)}`, "Snapshot Product", ""]));
    await asPrincipal(tenantA, managerA, "manager", (client) => client.query("SELECT app.update_product_rate($1, $2, $3, $4)", [rateOneId, productId, "2034-01-01T00:00:00Z", "11000"]));
    const configOne = policy.rows[0]; const configurationVersionId = (await admin.query("SELECT tenant_configuration_version_id FROM app.tenant_configuration_version WHERE tenant_id = $1 ORDER BY version_number DESC LIMIT 1", [tenantA])).rows[0].tenant_configuration_version_id;
    const historical = await createBookingWithSnapshots(configurationVersionId, rateOneId);
    const machineId = crypto.randomUUID(); const occupancyId = crypto.randomUUID(); const occurrenceId = crypto.randomUUID();
    await asPrincipal(tenantA, managerA, "manager", (client) => client.query("SELECT app.register_machine($1, $2, $3, $4)", [machineId, categoryLocationA, `fleet-${crypto.randomUUID().slice(0, 6)}`, "Snapshot Machine"]));
    await admin.query("INSERT INTO app.machine_occupancy (tenant_id, machine_occupancy_id, machine_id, booking_item_id, booking_item_terms_revision_id, occupancy_kind, occupancy_range) VALUES ($1, $2, $3, $4, $5, 'rental', tstzrange('2034-01-10T10:00:00Z', '2034-01-12T10:00:00Z', '[)'))", [tenantA, occupancyId, machineId, historical.itemId, historical.itemTermsId]);
    await admin.query("INSERT INTO app.checkout_occurrence (tenant_id, checkout_occurrence_id, booking_item_id, machine_occupancy_id, checkout_ordinal, initiated_by_principal_id) VALUES ($1, $2, $3, $4, 1, $5)", [tenantA, occurrenceId, historical.itemId, occupancyId, ownerA]);
    const tripId = await asPrincipal(tenantA, managerA, "manager", async (client) => (await client.query("SELECT app.open_core_trip($1, $2, $3, '2034-01-10T10:30:00Z') AS trip_id", [historical.itemId, occupancyId, occurrenceId])).rows[0].trip_id);
    const rateTwoId = crypto.randomUUID(); await asPrincipal(tenantA, managerA, "manager", (client) => client.query("SELECT app.update_product_rate($1, $2, $3, $4)", [rateTwoId, productId, "2034-02-01T00:00:00Z", "13000"]));
    const configTwoId = crypto.randomUUID(); await asPrincipal(tenantA, managerA, "manager", (client) => client.query("SELECT app.publish_configuration_version($1, $2, $3, $4, $5, $6, $7, $8, $9)", [configTwoId, 2, configOne.tenant_booking_policy_id, configOne.tenant_waiver_policy_id, configOne.tenant_inspection_policy_id, configOne.tenant_pricing_policy_id, configOne.tenant_payment_policy_id, configOne.tenant_telemetry_policy_id, configOne.tenant_sms_config_id]));
    const snapshots = await admin.query("SELECT bt.tenant_configuration_version_id, it.product_rate_id, t.tenant_configuration_version_id AS trip_configuration_version_id, t.product_rate_id AS trip_rate_id FROM app.booking_terms_revision bt JOIN app.booking_item_terms_revision it ON it.tenant_id = bt.tenant_id AND it.booking_terms_revision_id = bt.booking_terms_revision_id JOIN app.trip t ON t.tenant_id = it.tenant_id AND t.booking_item_id = it.booking_item_id WHERE bt.tenant_id = $1 AND bt.booking_terms_revision_id = $2 AND t.trip_id = $3", [tenantA, historical.bookingTermsId, tripId]);
    expect(snapshots.rows[0]).toMatchObject({ tenant_configuration_version_id: configurationVersionId, product_rate_id: rateOneId, trip_configuration_version_id: configurationVersionId, trip_rate_id: rateOneId });
  });

  it("blocks fleet assignment while a physical transfer is active", async () => {
    const destinationLocation = crypto.randomUUID(); const destinationCategoryLocation = crypto.randomUUID(); const machineId = crypto.randomUUID(); const transferId = crypto.randomUUID();
    await admin.query("INSERT INTO app.location (tenant_id, location_id, display_name, timezone_name) VALUES ($1, $2, $3, 'America/Denver')", [tenantA, destinationLocation, `Destination ${crypto.randomUUID().slice(0, 6)}`]);
    await admin.query("INSERT INTO app.category_location (tenant_id, category_location_id, rental_category_id, location_id) VALUES ($1, $2, $3, $4)", [tenantA, destinationCategoryLocation, categoryA, destinationLocation]);
    await asPrincipal(tenantA, managerA, "manager", (client) => client.query("SELECT app.register_machine($1, $2, $3, $4)", [machineId, categoryLocationA, `transfer-${crypto.randomUUID().slice(0, 6)}`, "Transfer Machine"]));
    await asPrincipal(tenantA, managerA, "manager", (client) => client.query("SELECT app.initiate_machine_transfer($1, $2, $3, '2035-01-01T00:00:00Z', 'Move for service')", [transferId, machineId, destinationCategoryLocation]));
    const blocking = await admin.query("SELECT occupancy_kind, blocking FROM app.machine_occupancy WHERE tenant_id = $1 AND machine_id = $2 AND machine_transfer_id = $3", [tenantA, machineId, transferId]);
    expect(blocking.rows[0]).toMatchObject({ occupancy_kind: "transfer", blocking: true });
    await expect(admin.query("INSERT INTO app.machine_occupancy (tenant_id, machine_id, occupancy_kind, maintenance_reference_id, occupancy_range) VALUES ($1, $2, 'maintenance', $3, tstzrange(clock_timestamp(), '2034-12-31T00:00:00Z', '[)'))", [tenantA, machineId, crypto.randomUUID()])).rejects.toThrow(/machine_occupancy_blocking_exclusion|range lower bound/);
  });

  it("maintains non-overlapping device installation history", async () => {
    const modelId = crypto.randomUUID(); const deviceId = crypto.randomUUID(); const firstMachine = crypto.randomUUID(); const secondMachine = crypto.randomUUID();
    await admin.query("INSERT INTO app.device_model (tenant_id, device_model_id, manufacturer, model_code) VALUES ($1, $2, 'Telemetry Co', $3)", [tenantA, modelId, `model-${crypto.randomUUID().slice(0, 6)}`]);
    await admin.query("INSERT INTO app.device (tenant_id, device_id, device_model_id, hardware_serial, active) VALUES ($1, $2, $3, $4, true)", [tenantA, deviceId, modelId, `serial-${crypto.randomUUID().slice(0, 8)}`]);
    await asPrincipal(tenantA, managerA, "manager", (client) => client.query("SELECT app.register_machine($1, $2, $3, $4)", [firstMachine, categoryLocationA, `device-a-${crypto.randomUUID().slice(0, 6)}`, "Device Machine A"]));
    await asPrincipal(tenantA, managerA, "manager", (client) => client.query("SELECT app.register_machine($1, $2, $3, $4)", [secondMachine, categoryLocationA, `device-b-${crypto.randomUUID().slice(0, 6)}`, "Device Machine B"]));
    await asPrincipal(tenantA, managerA, "manager", (client) => client.query("SELECT app.bind_device_to_machine($1, $2, '2036-01-01T00:00:00Z')", [deviceId, firstMachine]));
    await asPrincipal(tenantA, managerA, "manager", (client) => client.query("SELECT app.bind_device_to_machine($1, $2, '2036-02-01T00:00:00Z')", [deviceId, secondMachine]));
    const history = await admin.query("SELECT machine_id, installed_at, removed_at FROM app.device_installation WHERE tenant_id = $1 AND device_id = $2 ORDER BY installed_at", [tenantA, deviceId]);
    expect(history.rows).toHaveLength(2); expect(history.rows[0].removed_at).not.toBeNull(); expect(history.rows[1].removed_at).toBeNull();
    await expect(admin.query("INSERT INTO app.device_installation (tenant_id, device_installation_id, device_id, machine_id, installed_at, bound_by_principal_id) VALUES ($1, $2, $3, $4, '2036-01-15T00:00:00Z', $5)", [tenantA, crypto.randomUUID(), deviceId, firstMachine, ownerA])).rejects.toThrow(/device_installation_device_overlap/);
  });
});
