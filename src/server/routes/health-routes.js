const withTimeout = (work, milliseconds = 2_000) => Promise.race([
  Promise.resolve().then(work),
  new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("check timed out"), { code: "CHECK_TIMEOUT" })), milliseconds)),
]);

const failed = (error) => ({ status: "fail", reason: error?.code === "CHECK_TIMEOUT" ? "timeout" : "unavailable" });

export async function healthRoutes(app, { pool, readiness }) {
  app.get("/health/live", async () => ({ status: "live", uptimeSeconds: Math.floor(process.uptime()) }));

  app.get("/health/ready", async (_request, reply) => {
    if (readiness.isShuttingDown) return reply.code(503).send({ status: "unhealthy", reason: "shutting_down" });
    const started = performance.now();
    const [database, contextEngine, outbox] = await Promise.all([
      withTimeout(async () => {
        await pool.query("SELECT 1 AS ok");
        return { status: "pass", latencyMs: Math.round(performance.now() - started) };
      }).catch(failed),
      withTimeout(async () => {
        // An invalid token must reach the context engine and fail with its
        // expected authentication response; no synthetic assertion is created.
        try { await pool.query("SELECT api.activate_request_context(NULL::uuid)"); }
        catch (error) { if (error.code === "P0001") return { status: "pass" }; throw error; }
        throw new Error("context engine accepted an invalid token");
      }).catch(failed),
      withTimeout(async () => {
        const result = await pool.query("SELECT count(*)::integer AS pending_count FROM app.communication_outbox WHERE status='queued' AND (send_after IS NULL OR send_after <= clock_timestamp())");
        return { status: "pass", pendingEvents: result.rows[0].pending_count };
      }).catch(failed),
    ]);
    const connectionPool = {
      status: pool.waitingCount > 5 ? "degraded" : "pass",
      total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount,
    };
    const checks = { database, contextEngine, connectionPool, outbox };
    const unhealthy = [database, contextEngine, outbox].some((check) => check.status === "fail");
    return reply.code(unhealthy ? 503 : 200).send({
      status: unhealthy ? "unhealthy" : "ready",
      timestamp: new Date().toISOString(), checks,
    });
  });
}
