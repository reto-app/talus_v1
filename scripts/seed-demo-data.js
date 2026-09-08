import { Pool } from "pg";

const DEMO_TENANT_SLUG = "red-rock-powersports";
const DEMO_STAFF_EMAIL = "jordan@redrockpowersports.example";
const DEMO_STAFF_PASSWORD = "TalusYard!2394";

const ids = {
  tenant: "11111111-1111-1111-1111-111111111111",
  staffUser: "22222222-2222-2222-2222-222222222222",
  customer: "33333333-3333-3333-3333-333333333333",
  modelRzr: "44444444-4444-4444-4444-444444444441",
  modelCanAm: "44444444-4444-4444-4444-444444444442",
  machine1: "55555555-5555-5555-5555-555555555501",
  machine2: "55555555-5555-5555-5555-555555555502",
  machine3: "55555555-5555-5555-5555-555555555503",
  ownerPrincipal: "22222222-2222-2222-2222-222222222223",
  customerPrincipal: "33333333-3333-3333-3333-333333333334",
  devicePrincipal: "66666666-6666-6666-6666-666666666661",
  location: "77777777-7777-7777-7777-777777777771",
  category: "77777777-7777-7777-7777-777777777772",
  categoryLocation: "77777777-7777-7777-7777-777777777773",
  waiverPolicy: "77777777-7777-7777-7777-777777777774",
  deviceModel: "77777777-7777-7777-7777-777777777775",
  device: "77777777-7777-7777-7777-777777777776",
  installation: "77777777-7777-7777-7777-777777777777",
  cashAccount: "88888888-8888-8888-8888-888888888881",
  depositsHeldAccount: "88888888-8888-8888-8888-888888888882",
  revenueAccount: "88888888-8888-8888-8888-888888888883",
  clearingAccount: "88888888-8888-8888-8888-888888888884",
  receivableAccount: "88888888-8888-8888-8888-888888888885",
};

const databaseUrl = process.env.DATABASE_URL
  ?? process.env.TEST_DATABASE_URL
  ?? "postgres://mbinghamfamily@localhost:5432/talus_test";

export async function seedDemoData() {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    const tenant = await client.query("SELECT 1 FROM app.tenant WHERE tenant_id=$1", [ids.tenant]);
    if (!tenant.rowCount) {
      await client.query("SELECT app.onboard_tenant($1,$2,$3,$4,$5)", [
        ids.tenant, DEMO_TENANT_SLUG, "Red Rock Powersports", ids.staffUser, ids.ownerPrincipal,
      ]);
    }

    const staffToken = (await client.query(
      "SELECT app.issue_context_assertion($1,$2,'staff','owner',interval '15 minutes') AS token",
      [ids.tenant, ids.ownerPrincipal],
    )).rows[0].token;
    await client.query("SELECT api.activate_request_context($1)", [staffToken]);

    await client.query(
      "INSERT INTO app.principal(tenant_id,principal_id,caller_class,customer_id) VALUES($1,$2,'customer',$3) ON CONFLICT DO NOTHING",
      [ids.tenant, ids.customerPrincipal, ids.customer],
    );
    await client.query(
      "INSERT INTO app.customer(tenant_id,customer_id,principal_id,display_name,email) VALUES($1,$2,$3,'Jane Doe','jane.doe@example.com') ON CONFLICT DO NOTHING",
      [ids.tenant, ids.customer, ids.customerPrincipal],
    );
    await client.query(
      "INSERT INTO app.customer_profile(tenant_id,customer_profile_id,customer_id,email,full_name,phone) VALUES($1,$2,$3,'jane.doe@example.com','Jane Doe','+18015550199') ON CONFLICT DO NOTHING",
      [ids.tenant, "33333333-3333-3333-3333-333333333335", ids.customer],
    );

    await client.query("INSERT INTO app.location VALUES($1,$2,'Red Rock Trailhead','America/Denver',clock_timestamp()) ON CONFLICT DO NOTHING", [ids.tenant, ids.location]);
    await client.query("INSERT INTO app.rental_category(tenant_id,rental_category_id,display_name) VALUES($1,$2,'Side-by-Side') ON CONFLICT DO NOTHING", [ids.tenant, ids.category]);
    await client.query("INSERT INTO app.category_location VALUES($1,$2,$3,$4,true,clock_timestamp()) ON CONFLICT DO NOTHING", [ids.tenant, ids.categoryLocation, ids.category, ids.location]);
    await client.query("INSERT INTO app.tenant_waiver_policy(tenant_id,tenant_waiver_policy_id,version_number,signing_mode) VALUES($1,$2,1,'individual') ON CONFLICT DO NOTHING", [ids.tenant, ids.waiverPolicy]);

    for (const [accountId, code, type] of [
      [ids.cashAccount, "cash", "asset"], [ids.depositsHeldAccount, "deposits_held", "liability"],
      [ids.revenueAccount, "revenue", "revenue"], [ids.clearingAccount, "deposit_clearing", "asset"],
      [ids.receivableAccount, "accounts_receivable", "asset"],
    ]) await client.query("INSERT INTO app.ledger_account VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [ids.tenant, accountId, code, type]);

    for (const [productId, rateId, code, name, capacity] of [
      [ids.modelRzr, "44444444-4444-4444-4444-444444444449", "polaris-rzr-xp-1000", "Polaris RZR XP 1000", 4],
      [ids.modelCanAm, "44444444-4444-4444-4444-444444444450", "canam-maverick-x3", "Can-Am Maverick X3 Turbo", 2],
    ]) {
      await client.query("INSERT INTO app.rental_product(tenant_id,rental_product_id,category_location_id,product_code,display_name,description) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [ids.tenant, productId, ids.categoryLocation, code, name, `Side-by-Side; capacity ${capacity}`]);
      await client.query("INSERT INTO app.product_rate(tenant_id,product_rate_id,rental_product_id,version_number,effective_at,daily_rate_cents) VALUES($1,$2,$3,1,'2020-01-01T00:00:00Z',35000) ON CONFLICT DO NOTHING", [ids.tenant, rateId, productId]);
    }
    for (const [ruleId, code, value] of [
      ["99999999-9999-9999-9999-999999999991", "security_deposit_cents", { amount_cents: 100000 }],
      ["99999999-9999-9999-9999-999999999992", "fuel_replenishment_cents_per_gallon", { amount_cents: 800 }],
      ["99999999-9999-9999-9999-999999999993", "excess_mileage_cents_per_mile", { amount_cents: 250 }],
    ]) await client.query("INSERT INTO app.booking_rule(tenant_id,booking_rule_id,rental_product_id,rule_code,rule_value) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [ids.tenant, ruleId, ids.modelRzr, code, value]);

    for (const [machineId, fleet, vin, model] of [
      [ids.machine1, "RZR-101", "4XARZ1000DEMO01", "Polaris RZR XP 1000"],
      [ids.machine2, "RZR-102", "4XARZ1000DEMO02", "Polaris RZR XP 1000"],
      [ids.machine3, "MAV-201", "3JBCM2000DEMO01", "Can-Am Maverick X3 Turbo"],
    ]) await client.query("INSERT INTO app.machine(tenant_id,machine_id,category_location_id,display_name,operational_state,fleet_number) VALUES($1,$2,$3,$4,'in_service',$5) ON CONFLICT DO NOTHING", [ids.tenant, machineId, ids.categoryLocation, `${fleet} — ${model} (VIN ${vin})`, fleet]);

    await client.query("INSERT INTO app.principal(tenant_id,principal_id,caller_class) VALUES($1,$2,'device') ON CONFLICT DO NOTHING", [ids.tenant, ids.devicePrincipal]);
    await client.query("INSERT INTO app.device_model VALUES($1,$2,'Talus','TLX-1',true) ON CONFLICT DO NOTHING", [ids.tenant, ids.deviceModel]);
    await client.query("INSERT INTO app.device VALUES($1,$2,$3,'TLX-HARDWARE-001',true,NULL) ON CONFLICT DO NOTHING", [ids.tenant, ids.device, ids.deviceModel]);
    await client.query("INSERT INTO app.device_installation VALUES($1,$2,$3,$4,clock_timestamp(),NULL,$5) ON CONFLICT DO NOTHING", [ids.tenant, ids.installation, ids.device, ids.machine1, ids.ownerPrincipal]);

    const customerToken = (await client.query("SELECT app.issue_context_assertion($1,$2,'customer',NULL,interval '15 minutes') AS token", [ids.tenant, ids.customerPrincipal])).rows[0].token;
    const deviceToken = (await client.query("SELECT app.issue_context_assertion($1,$2,'device',NULL,interval '15 minutes') AS token", [ids.tenant, ids.devicePrincipal])).rows[0].token;

    await client.query(
      "UPDATE app.staff_user SET display_name='Jordan Ruiz', email=$2 WHERE tenant_id=$1 AND staff_user_id=$3",
      [ids.tenant, DEMO_STAFF_EMAIL, ids.staffUser],
    );
    await client.query("SELECT app.set_staff_password($1,$2)", [ids.staffUser, DEMO_STAFF_PASSWORD]);

    await client.query("COMMIT");
    return { staffToken, customerToken, deviceToken };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) seedDemoData().then(({ staffToken, customerToken, deviceToken }) => {
  console.log("\nTalus demo data is ready. Context assertions expire after 15 minutes.\n");
  console.log("Staff sign-in (POST /auth/login):");
  console.log(JSON.stringify({ tenantSlug: DEMO_TENANT_SLUG, email: DEMO_STAFF_EMAIL, password: DEMO_STAFF_PASSWORD }, null, 2));
  console.log(`\nStaff token (role: talus_staff): ${staffToken}`);
  console.log(`Customer token (role: talus_customer): ${customerToken}`);
  console.log(`Device token (role: talus_device): ${deviceToken}\n`);
  console.log("Stable IDs:");
  console.log(`tenant_id: ${ids.tenant}`);
  console.log(`customer_id: ${ids.customer}`);
  console.log(`machine_model_id (Polaris catalog product): ${ids.modelRzr}`);
  console.log(`machine_id (RZR-101): ${ids.machine1}\n`);
  console.log("POST /api/v1/quotes");
  console.log(JSON.stringify({ categoryLocationId: ids.categoryLocation, rentalPeriod: { start: "2035-06-01T10:00:00Z", end: "2035-06-03T10:00:00Z" } }, null, 2));
  console.log("\nPOST /api/v1/bookings");
  console.log(JSON.stringify({ categoryLocationId: ids.categoryLocation, rentalPeriod: { start: "2035-06-01T10:00:00Z", end: "2035-06-03T10:00:00Z" }, customerId: ids.customer }, null, 2));
  console.log("\nPOST /api/v1/operations/assign");
  console.log(JSON.stringify({ bookingItemId: "<booking_item_id returned by booking>", machineId: ids.machine1 }, null, 2));
}).catch((error) => { console.error("Demo seed failed", error); process.exit(1); });

export { ids as DEMO_IDS, DEMO_TENANT_SLUG, DEMO_STAFF_EMAIL, DEMO_STAFF_PASSWORD };
