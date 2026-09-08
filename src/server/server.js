import { Pool } from "pg";
import { buildApp } from "./app.js";
import { installGracefulShutdown } from "./shutdown.js";

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL
  ?? (process.env.NODE_ENV === "test" ? process.env.TEST_DATABASE_URL : undefined);

async function assertSafeRuntimeDatabase(pool) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required outside NODE_ENV=test.");
  if (process.env.NODE_ENV === "test" || process.env.TALUS_DEMO_MODE === "true") return;
  const expectedRole = process.env.TALUS_DB_RUNTIME_ROLE ?? "talus_api";
  const { rows: [runtime] } = await pool.query(
    "SELECT current_user AS role_name, rolsuper FROM pg_roles WHERE rolname = current_user",
  );
  if (!runtime || runtime.rolsuper || runtime.role_name !== expectedRole) {
    throw new Error(`Unsafe database runtime role: expected non-superuser ${expectedRole}.`);
  }
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl });
  await assertSafeRuntimeDatabase(pool);
  const app = await buildApp(pool);
  installGracefulShutdown({ app, pool });
  await app.listen({ port: PORT, host: HOST });
  console.log(`🚀 Talus Fleet OS API listening on http://localhost:${PORT}`);
  console.log(`📖 Swagger UI available at http://localhost:${PORT}/docs/`);
  console.log(`🩺 Health check at http://localhost:${PORT}/health/ready`);
}

main().catch((error) => {
  console.error("Talus API startup failed", error);
  process.exit(1);
});
