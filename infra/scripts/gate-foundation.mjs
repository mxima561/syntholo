#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  evaluateReleaseSha,
  inspectProductionDependencyGraph,
  runIndependentChecks,
} from "./foundation-gate-lib.mjs";

const execFileAsync = promisify(execFile);
const checkNames = [
  "workspaces",
  "migrations",
  "rls",
  "identitySeparation",
  "jobs",
  "entitlements",
  "releaseSha",
  "artifacts",
  "browser",
  "dependencyPolicy",
  "images",
  "proxy",
  "repository",
  "ancestry",
];

function evidenceCheck(command, status, reason, artifact = command) {
  return {
    artifactHash: createHash("sha256").update(artifact).digest("hex"),
    command,
    durationMs: 0,
    ...(reason === undefined ? {} : { reason }),
    status,
  };
}

function fixtureReport() {
  if (process.env.NODE_ENV !== "test") throw new Error("TEST_FIXTURE_FORBIDDEN");
  const release = evaluateReleaseSha(
    process.env.RELEASE_SHA,
    process.env.FOUNDATION_GATE_HEAD_SHA ?? "",
  );
  const checks = Object.fromEntries(checkNames.map((name) => [
    name,
    evidenceCheck(`test fixture ${name}`, "PASS"),
  ]));
  checks.releaseSha = evidenceCheck(
    "compare RELEASE_SHA to fixture HEAD",
    release.status,
    release.reason,
  );
  checks.images = evidenceCheck(
    "collect Docker-capable CI evidence",
    "BLOCKED",
    "SEPARATE_CI_IMAGE_EVIDENCE_REQUIRED",
  );
  checks.proxy = evidenceCheck(
    "collect canonical deployed proxy evidence",
    "BLOCKED",
    "DEPLOYED_PROXY_EVIDENCE_REQUIRED",
  );
  checks.ancestry = evidenceCheck(
    "prove target-branch ancestry",
    "BLOCKED",
    "TARGET_ANCESTRY_EVIDENCE_REQUIRED",
  );
  const engineeringGate = release.status === "PASS" ? "PASS" : "BLOCKED";
  return {
    checks,
    engineeringGate,
    environment: "test",
    launchGate: "BLOCKED",
    releaseSha: release.status === "PASS" ? process.env.RELEASE_SHA : null,
    version: 1,
  };
}

async function command(
  name,
  args,
  environment = {},
  removeEnvironmentKeys = [],
  signal,
) {
  const childEnvironment = { ...process.env, ...environment };
  for (const key of removeEnvironmentKeys) delete childEnvironment[key];
  await execFileAsync(name, args, {
    cwd: process.cwd(),
    env: childEnvironment,
    maxBuffer: 16 * 1024 * 1024,
    signal,
  });
}

async function requiredContracts() {
  const paths = [
    "apps/api/src/auth/auth.integration.test.ts",
    "apps/api/src/auth/session-crypto.test.ts",
    "apps/web/src/lib/api/client.test.ts",
    "apps/worker/src/jobs.integration.test.ts",
    "packages/database/drizzle/0006_runtime_readiness.sql",
    "packages/database/src/entitlements.integration.test.ts",
    "packages/database/src/rls.integration.test.ts",
    "packages/domain/src/entitlements/evaluate.property.test.ts",
    "packages/testing/src/foundation-gate-policy.test.ts",
  ];
  await Promise.all(paths.map((path) => access(path)));
}

async function repositoryCheck(signal) {
  await command("git", ["diff", "--check"], {}, [], signal);
}

async function ancestryCheck(headSha) {
  const baseSha = process.env.FOUNDATION_BASE_SHA?.trim();
  if (baseSha === undefined || !/^[0-9a-f]{40}$/u.test(baseSha)) {
    return evidenceCheck(
      "git merge-base FOUNDATION_BASE_SHA HEAD && git diff --check base..HEAD",
      "BLOCKED",
      "TARGET_ANCESTRY_EVIDENCE_REQUIRED",
    );
  }
  const started = Date.now();
  try {
    const { stdout } = await execFileAsync("git", ["merge-base", baseSha, headSha]);
    const mergeBase = stdout.trim();
    if (mergeBase !== baseSha) throw new Error("BASE_NOT_ANCESTOR");
    await command("git", ["diff", "--check", `${baseSha}..${headSha}`]);
    return {
      ...evidenceCheck(
        "git merge-base FOUNDATION_BASE_SHA HEAD && git diff --check base..HEAD",
        "PASS",
        undefined,
        `${baseSha}:${headSha}`,
      ),
      durationMs: Date.now() - started,
    };
  } catch {
    return {
      ...evidenceCheck(
        "git merge-base FOUNDATION_BASE_SHA HEAD && git diff --check base..HEAD",
        "BLOCKED",
        "TARGET_ANCESTRY_INVALID",
        `${baseSha}:${headSha}`,
      ),
      durationMs: Date.now() - started,
    };
  }
}

async function expectArtifactStartupFailure(path, expectedStderr, signal) {
  try {
    await execFileAsync(process.execPath, [path], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      signal,
    });
    throw new Error("ARTIFACT_STARTUP_UNEXPECTED_PASS");
  } catch (error) {
    const failure = error;
    if (
      typeof failure?.code !== "number"
      || failure.code === 0
      || failure.stderr !== expectedStderr
    ) {
      throw new Error("ARTIFACT_STARTUP_CONTRACT_FAILED");
    }
  }
}

async function productionReport() {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
  });
  const headSha = stdout.trim();
  const release = evaluateReleaseSha(process.env.RELEASE_SHA, headSha);
  if (release.status !== "PASS") {
    return {
      checks: {
        releaseSha: evidenceCheck(
          "compare RELEASE_SHA to git rev-parse HEAD",
          release.status,
          release.reason,
        ),
      },
      createdAt: new Date().toISOString(),
      engineeringGate: "BLOCKED",
      environment: process.env.CI === "true" ? "ci" : "local",
      launchGate: "BLOCKED",
      releaseSha: null,
      version: 1,
    };
  }
  const releaseEnvironment = { RELEASE_SHA: process.env.RELEASE_SHA };
  const definitions = [
    { name: "workspaces", command: "required contracts + lint + typecheck + unit", timeoutMs: 900_000,
      run: async (signal) => requiredContracts().then(() => command("npm", ["run", "lint"], {}, [], signal)).then(() => command("npm", ["run", "typecheck"], {}, [], signal)).then(() => command("npm", ["test"], {}, [], signal)) },
    { name: "migrations", command: "npm run db:schema:check && database migration integration", timeoutMs: 600_000,
      run: async (signal) => command("npm", ["run", "db:schema:check"], {}, [], signal).then(() => command("npm", ["run", "test:integration", "-w", "@syntholo/database", "--", "src/schema/foundation.integration.test.ts"], {}, [], signal)) },
    { name: "rls", command: "database RLS integration", timeoutMs: 600_000,
      run: async (signal) => command("npm", ["run", "test:integration", "-w", "@syntholo/database", "--", "src/rls.integration.test.ts"], {}, [], signal) },
    { name: "identitySeparation", command: "identity/session/crypto suites", timeoutMs: 600_000,
      run: async (signal) => command("npm", ["test", "-w", "@syntholo/api", "--", "src/auth/auth.integration.test.ts", "src/auth/session-crypto.test.ts"], {}, [], signal).then(() => command("npm", ["run", "test:integration", "-w", "@syntholo/database", "--", "src/auth.integration.test.ts"], {}, [], signal)) },
    { name: "jobs", command: "worker unit and integration", timeoutMs: 600_000,
      run: async (signal) => command("npm", ["test", "-w", "@syntholo/worker"], {}, [], signal).then(() => command("npm", ["run", "test:integration", "-w", "@syntholo/worker"], {}, [], signal)).then(() => command("npm", ["run", "test:integration", "-w", "@syntholo/api"], {}, [], signal)).then(() => command("npm", ["run", "test:integration", "-w", "@syntholo/database", "--", "src/unit-of-work.integration.test.ts"], {}, [], signal)) },
    { name: "entitlements", command: "entitlement unit/property/races", timeoutMs: 900_000,
      run: async (signal) => command("npm", ["test", "-w", "@syntholo/domain", "--", "src/entitlements"], {}, [], signal).then(() => command("npm", ["run", "test:integration", "-w", "@syntholo/database", "--", "src/entitlements.integration.test.ts"], {}, [], signal)) },
    { name: "artifacts", command: "npm run build && node artifact syntax", timeoutMs: 900_000,
      run: async (signal) => command("npm", ["run", "build"], { ...releaseEnvironment, APP_MODE: "demo" }, ["TEST_DATABASE_URL", "DATABASE_URL", "DATABASE_DIRECT_URL", "DATABASE_POOLED_URL"], signal).then(() => command("npm", ["run", "build:migrate"], releaseEnvironment, ["TEST_DATABASE_URL", "DATABASE_URL", "DATABASE_DIRECT_URL", "DATABASE_POOLED_URL"], signal)).then(() => command(process.execPath, ["--check", "apps/api/dist/server.js"], {}, [], signal)).then(() => command(process.execPath, ["--check", "apps/worker/dist/runner.js"], {}, [], signal)).then(() => command(process.execPath, ["--check", "apps/worker/dist/cron.js"], {}, [], signal)).then(() => command(process.execPath, ["--check", "dist/migrate.js"], {}, [], signal)).then(() => expectArtifactStartupFailure("apps/api/dist/server.js", "API_STARTUP_FAILED\n", signal)).then(() => expectArtifactStartupFailure("apps/worker/dist/runner.js", "WORKER_STARTUP_FAILED\n", signal)).then(() => expectArtifactStartupFailure("apps/worker/dist/cron.js", "WORKER_STARTUP_FAILED\n", signal)).then(() => expectArtifactStartupFailure("dist/migrate.js", "MIGRATION_STARTUP_FAILED\n", signal)) },
    { name: "browser", command: "npm run test:e2e", timeoutMs: 900_000,
      run: async (signal) => command("npm", ["run", "test:e2e"], { ...releaseEnvironment, APP_MODE: "demo" }, ["TEST_DATABASE_URL", "DATABASE_URL", "DATABASE_DIRECT_URL", "DATABASE_POOLED_URL"], signal) },
    { name: "repository", command: "git diff --check", timeoutMs: 60_000,
      run: repositoryCheck },
  ];
  const checks = await runIndependentChecks(definitions);
  checks.releaseSha = evidenceCheck(
    "compare RELEASE_SHA to git rev-parse HEAD",
    "PASS",
    undefined,
    `${process.env.RELEASE_SHA}:${headSha}`,
  );

  const graph = await inspectProductionDependencyGraph(process.cwd());
  const forbiddenPackages = graph.packages.filter((name) =>
    /(?:^|[/@_-])(?:mongodb|gohighlevel|leadconnector|highlevel)(?:$|[/_-])/iu.test(name)
  );
  const policyPass = forbiddenPackages.length === 0
    && graph.imports.length === 0
    && graph.environmentKeys.length === 0
    && graph.urls.length === 0
    && graph.lockfilePackages.length === 0
    && graph.builtArtifacts.length === 0;
  checks.dependencyPolicy = evidenceCheck(
    "inspect manifests, imports, environment keys, URLs, lockfile, and built artifacts",
    policyPass ? "PASS" : "FAILED",
    policyPass ? undefined : "FORBIDDEN_PRODUCTION_DEPENDENCY",
    JSON.stringify(graph),
  );
  checks.images = evidenceCheck(
    "collect Docker-capable CI image, SBOM, and scan evidence",
    "BLOCKED",
    "SEPARATE_CI_IMAGE_EVIDENCE_REQUIRED",
  );
  checks.proxy = evidenceCheck(
    "collect canonical deployed proxy evidence",
    "BLOCKED",
    "DEPLOYED_PROXY_EVIDENCE_REQUIRED",
  );
  checks.ancestry = await ancestryCheck(headSha);

  const requiredChecks = Object.entries(checks).filter(([name]) =>
    !["ancestry", "images", "proxy"].includes(name)
  );
  const engineeringGate = requiredChecks.every(([, check]) => check.status === "PASS")
    ? "PASS"
    : "BLOCKED";
  return {
    checks,
    createdAt: new Date().toISOString(),
    engineeringGate,
    environment: process.env.CI === "true" ? "ci" : "local",
    launchGate: "BLOCKED",
    releaseSha: process.env.RELEASE_SHA,
    version: 1,
  };
}

const report = process.argv.includes("--test-fixture")
  ? fixtureReport()
  : await productionReport();
const serialized = `${JSON.stringify(report)}\n`;
if (!process.argv.includes("--test-fixture")) {
  await writeFile("foundation-gate.json", serialized, "utf8");
}
process.stdout.write(serialized);
process.exitCode = report.engineeringGate === "PASS" ? 0 : 1;
