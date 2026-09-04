/**
 * Execute work with transaction-local Talus identity settings.
 * Settings use SET LOCAL semantics and are discarded on commit or rollback.
 */
export async function withTenantTransaction(pool, context, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('talus.tenant_id', $1, true)", [context.tenantId]);
    await client.query("SELECT set_config('talus.actor_kind', $1, true)", [context.actorKind]);
    if (context.actorId) await client.query("SELECT set_config('talus.actor_id', $1, true)", [context.actorId]);
    if (context.customerId) await client.query("SELECT set_config('talus.customer_id', $1, true)", [context.customerId]);
    if (context.locationId) await client.query("SELECT set_config('talus.location_id', $1, true)", [context.locationId]);
    if (context.assertionToken) {
      await client.query("SELECT api.activate_request_context($1)", [context.assertionToken]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
