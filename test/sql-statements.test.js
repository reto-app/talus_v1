import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "../scripts/sql-statements.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("migration SQL statement splitter", () => {
  it("keeps complete dollar-quoted PL/pgSQL functions as single statements", async () => {
    const sql = await readFile(path.join(root, "db/migrations/002_m01_security_and_functions.sql"), "utf8");
    const statements = splitSqlStatements(sql);
    const onboard = statements.find((statement) => statement.includes("CREATE OR REPLACE FUNCTION app.onboard_tenant"));

    expect(onboard).toContain("RETURNING a.assertion_id INTO v_bootstrap_assertion");
    expect(onboard).toContain("END; $$;");
    expect(onboard).not.toContain("CREATE OR REPLACE FUNCTION api.begin_operation");
    expect(statements.at(-1)).toBe("RESET ROLE;");
  });
});
