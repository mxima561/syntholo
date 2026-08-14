import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FOUNDATION_CHECK_CATALOG } from "../../../infra/scripts/foundation-gate-lib.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const gateScript = fileURLToPath(
  new URL("../../../infra/scripts/gate-foundation.mjs", import.meta.url),
);
const releaseSha = "0123456789abcdef0123456789abcdef01234567";

type GateResult = Readonly<{
  exitCode: number;
  json: {
    checks: Record<string, { reason?: string; status: string }>;
    engineeringGate: string;
    launchGate: string;
    releaseSha: string | null;
    version: number;
  };
}>;

async function runGate(
  environment: Readonly<Record<string, string>>,
): Promise<GateResult> {
  try {
    const result = await execFileAsync(
      process.execPath,
      [gateScript],
      {
        cwd: repositoryRoot,
        env: {
          PATH: process.env.PATH,
          ...environment,
        },
      },
    );
    return { exitCode: 0, json: JSON.parse(result.stdout) as GateResult["json"] };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      json: JSON.parse(failure.stdout ?? "") as GateResult["json"],
    };
  }
}

describe("foundation gate report", () => {
  it("blocks without an immutable release identity", async () => {
    const result = await runGate({
      FOUNDATION_GATE_HEAD_SHA: releaseSha,
      RELEASE_SHA: "",
    });

    expect(result.exitCode).toBe(1);
    expect(result.json.checks.releaseSha).toMatchObject({
      reason: "RELEASE_SHA_REQUIRED",
      status: "BLOCKED",
    });
    expect(Object.keys(result.json.checks).sort()).toEqual(
      [...FOUNDATION_CHECK_CATALOG].sort(),
    );
  });

  it.each([
    ["malformed", "ABC"],
    ["HEAD-mismatched", "1123456789abcdef0123456789abcdef01234567"],
  ])("blocks a %s release identity", async (_case, candidate) => {
    const result = await runGate({
      FOUNDATION_GATE_HEAD_SHA: releaseSha,
      RELEASE_SHA: candidate,
    });

    expect(result.exitCode).toBe(1);
    expect(result.json.checks.releaseSha.status).toBe("BLOCKED");
  });

  it("does not expose a test-only all-PASS report path", async () => {
    await expect(execFileAsync(process.execPath, [gateScript, "--test-fixture"], {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        FOUNDATION_GATE_HEAD_SHA: releaseSha,
        RELEASE_SHA: releaseSha,
      },
    })).rejects.toMatchObject({ code: 1 });
  });
});
