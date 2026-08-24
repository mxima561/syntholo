import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const exportEnvironment = {
  ...process.env,
  DATABASE_MIGRATION_TARGET: "test",
  TEST_DATABASE_URL: "postgres://test:test@localhost:55432/syntholo_test",
};

async function exportedSql(cwd: string): Promise<string> {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath === undefined) {
    throw new Error("NPM_EXEC_PATH_REQUIRED");
  }
  const result = await execFileAsync(
    process.execPath,
    [npmExecPath, "run", "db:schema:check"],
    {
    cwd,
    env: exportEnvironment,
    },
  );
  const sqlStart = result.stdout.indexOf("CREATE TABLE");
  expect(sqlStart).toBeGreaterThanOrEqual(0);
  return result.stdout.slice(sqlStart);
}

describe("Drizzle configuration paths", () => {
  it("exports the same foundation schema from package and repository roots", async () => {
    const workspaceSql = await exportedSql(packageRoot);
    const rootSql = await exportedSql(repositoryRoot);

    expect(rootSql).toBe(workspaceSql);
    expect(rootSql.match(/CREATE TABLE/g)).toHaveLength(99);
    await expect(access(`${repositoryRoot}/drizzle`)).rejects.toThrow();
  }, 15_000);
});
