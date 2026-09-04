import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://mbinghamfamily@localhost:5432/talus_test";

it("creates sealed inspections and an authorized hold through the HTTP lifecycle", async () => {
  const { stdout } = await run("node", ["scripts/smoke-test.js"], {
    cwd: process.cwd(), env: { ...process.env, TEST_DATABASE_URL: databaseUrl }, timeout: 30_000,
  });
  expect(stdout).toContain("✔ [5/9] Assigned machine RZR-101 to booking");
  expect(stdout).toContain("✔ [8/9] Vehicle returned, trip closed, occupancy clamped");
  expect(stdout).toContain("FULL TALUS FLEET OS LIFECYCLE VERIFIED (9/9 STEPS)");
});
