import { Pool } from "pg";
import { buildApp } from "./app.js";
import { installGracefulShutdown } from "./shutdown.js";

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL
  ?? process.env.TEST_DATABASE_URL
  ?? "postgres://mbinghamfamily@localhost:5432/talus_test";

async function main() {
  const pool = new Pool({ connectionString: databaseUrl });
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
