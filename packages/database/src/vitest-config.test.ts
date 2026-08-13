import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function listedFiles(cwd: string, config: string): Promise<string[]> {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath === undefined) {
    throw new Error("NPM_EXEC_PATH_REQUIRED");
  }
  const result = await execFileAsync(
    process.execPath,
    [npmExecPath, "exec", "--", "vitest", "list", "--filesOnly", "--config", config],
    { cwd },
  );
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((file) => resolve(cwd, file))
    .sort();
}

describe("Vitest configuration paths", () => {
  it.each([
    ["unit", "vitest.config.ts", "packages/database/vitest.config.ts"],
    [
      "integration",
      "vitest.integration.config.ts",
      "packages/database/vitest.integration.config.ts",
    ],
  ])("selects the same %s files from package and repository roots", async (
    _suite,
    workspaceConfig,
    rootConfig,
  ) => {
    const workspaceFiles = await listedFiles(packageRoot, workspaceConfig);
    const rootFiles = await listedFiles(repositoryRoot, rootConfig);

    expect(workspaceFiles.length).toBeGreaterThan(0);
    expect(rootFiles).toEqual(workspaceFiles);
  }, 15_000);
});
