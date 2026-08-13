import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const drizzleKit = fileURLToPath(
  new URL("../../../node_modules/.bin/drizzle-kit", import.meta.url),
);
const exportEnvironment = {
  ...process.env,
  DATABASE_MIGRATION_TARGET: "test",
  TEST_DATABASE_URL: "postgres://test:test@localhost:55432/syntholo_test",
};

async function exportedSql(cwd: string, config: string): Promise<string> {
  const result = await execFileAsync(drizzleKit, ["export", "--config", config], {
    cwd,
    env: exportEnvironment,
  });
  const sqlStart = result.stdout.indexOf("CREATE TABLE");
  expect(sqlStart).toBeGreaterThanOrEqual(0);
  return result.stdout.slice(sqlStart);
}

async function rootScriptSql(): Promise<string> {
  const result = await execFileAsync("npm", ["run", "db:schema:check"], {
    cwd: repositoryRoot,
    env: exportEnvironment,
  });
  const sqlStart = result.stdout.indexOf("CREATE TABLE");
  expect(sqlStart).toBeGreaterThanOrEqual(0);
  return result.stdout.slice(sqlStart);
}

describe("Drizzle configuration paths", () => {
  it("exports the same foundation schema from package and repository roots", async () => {
    const workspaceSql = await exportedSql(packageRoot, "drizzle.config.ts");
    const rootSql = await exportedSql(
      repositoryRoot,
      "packages/database/drizzle.config.ts",
    );
    const checkedSql = await rootScriptSql();

    expect(rootSql).toBe(workspaceSql);
    expect(checkedSql).toContain(rootSql);
    expect(rootSql.match(/CREATE TABLE/g)).toHaveLength(8);
    await expect(access(`${repositoryRoot}/drizzle`)).rejects.toThrow();
  }, 15_000);
});
