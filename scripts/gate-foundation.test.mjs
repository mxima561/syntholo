import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const script = path.join(root, "scripts", "gate-foundation.mjs");

function runGate(overrides) {
  const env = { ...process.env, GATE_FOUNDATION_QUICK: "1", ...overrides };
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  let json;
  try {
    json = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(
      `gate-foundation did not print JSON\nstatus=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}\n${error}`,
    );
  }
  return { status: result.status, json };
}

test("blocks the foundation gate without release identity", () => {
  const result = runGate({ RELEASE_SHA: "", GITHUB_SHA: "" });
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.checks.releaseSha, {
    status: "BLOCKED",
    reason: "RELEASE_SHA_REQUIRED",
  });
});

test("reports every foundation check in quick mode", () => {
  const result = runGate({ RELEASE_SHA: "test", GITHUB_SHA: "" });
  assert.equal(result.status, 0);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.checks.releaseSha.status, "PASS");
  assert.equal(result.json.checks.releaseSha.sha, "test");
  assert.equal(result.json.checks.identitySeparation.status, "PASS");
  assert.deepEqual(result.json.checks.migrations, { status: "SKIP", reason: "BOOT_SCHEMA" });
  for (const key of [
    "workspaces",
    "migrations",
    "rls",
    "identitySeparation",
    "jobs",
    "entitlements",
    "releaseSha",
  ]) {
    assert.ok(result.json.checks[key], `missing check ${key}`);
  }
});

test("accepts GITHUB_SHA when RELEASE_SHA is blank", () => {
  const result = runGate({ RELEASE_SHA: "", GITHUB_SHA: "github_sha_test" });
  assert.equal(result.status, 0);
  assert.equal(result.json.checks.releaseSha.status, "PASS");
  assert.equal(result.json.checks.releaseSha.sha, "github_sha_test");
});
