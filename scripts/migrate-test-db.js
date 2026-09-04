import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { splitSqlStatements } from "./sql-statements.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/talus_test";
const migrationDirectory = path.join(root, "db", "migrations");
const client = new Client({ connectionString: databaseUrl });

let connected = false;
try {
  await client.connect();
  connected = true;
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.talus_schema_migration (
      migration_name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);

  const migrations = (await readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const migrationName of migrations) {
    const applied = await client.query(
      "SELECT 1 FROM public.talus_schema_migration WHERE migration_name = $1",
      [migrationName],
    );
    if (applied.rowCount > 0) continue;

    const migrationSql = await readFile(path.join(migrationDirectory, migrationName), "utf8");
    const statements = splitSqlStatements(migrationSql);
    await client.query("BEGIN");
    try {
      for (const [statementIndex, statement] of statements.entries()) {
        try {
          await client.query(statement);
        } catch (error) {
          const summary = statement.split("\n").find((line) => line.trim() && !line.trim().startsWith("--"))?.trim() ?? "<empty statement>";
          throw new Error(`${migrationName}, statement ${statementIndex + 1} (${summary}): ${error.message || error.code || String(error)}`);
        }
      }
      await client.query(
        "INSERT INTO public.talus_schema_migration (migration_name) VALUES ($1)",
        [migrationName],
      );
      await client.query("COMMIT");
      console.log(`Applied ${migrationName}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} catch (error) {
  const cause = error.message || error.code || String(error);
  if (connected) console.error(`Migration failed for TEST_DATABASE_URL (${databaseUrl}). ${cause}`);
  else console.error(`Could not connect to TEST_DATABASE_URL (${databaseUrl}). Start local PostgreSQL, create talus_test, and verify the URL before migrating. Original error: ${cause}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
