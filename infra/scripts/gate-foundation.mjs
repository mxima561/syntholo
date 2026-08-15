#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  FOUNDATION_CHECK_CATALOG,
  FOUNDATION_EVIDENCE_SCHEMA,
  evaluateFoundationGate,
  evaluateReleaseSha,
  foundationExitCode,
  inspectRepositoryIdentity,
  inspectProductionDependencyGraph,
  productionDependencyPolicyPass,
  runIndependentChecks,
  validateExternalEvidence,
  validateFoundationReport,
  validateRailwayServiceConfigs,
  validateRequiredContracts,
} from "./foundation-gate-lib.mjs";

const execFileAsync = promisify(execFile);
function evidenceCheck(command, status, reason, artifact = command) {
  return {
    artifactHash: createHash("sha256").update(artifact).digest("hex"),
    command,
    durationMs: 0,
    ...(reason === undefined ? {} : { reason }),
    status,
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

function unavailableChecks(reason, releaseCheck, repositoryCheck) {
  const checks = Object.fromEntries(FOUNDATION_CHECK_CATALOG.map((name) => [
    name,
    evidenceCheck(`unavailable ${name}`, "BLOCKED", reason),
  ]));
  checks.releaseSha = releaseCheck;
  checks.repository = repositoryCheck;
  return checks;
}

function reportFor(checks, releaseSha) {
  const state = evaluateFoundationGate(checks);
  return {
    checks,
    createdAt: new Date().toISOString(),
    ...state,
    environment: process.env.CI === "true" ? "ci" : "local",
    releaseSha,
    schema: FOUNDATION_EVIDENCE_SCHEMA,
    version: 1,
  };
}

async function externalEvidenceCheck(path, type, releaseSha, host, upstreamOrigin) {
  const commandName = type === "images"
    ? "validate SHA-bound API/migration/worker/cron image evidence"
    : "validate deployed canonical proxy evidence";
  if (path === undefined || path.trim() === "") {
    return evidenceCheck(
      commandName,
      "BLOCKED",
      type === "images" ? "IMAGE_EVIDENCE_UNAVAILABLE" : "PROXY_EVIDENCE_UNAVAILABLE",
    );
  }
  try {
    const raw = await readFile(path, "utf8");
    const evidence = JSON.parse(raw);
    const result = validateExternalEvidence(evidence, {
      host,
      now: new Date(),
      releaseSha,
      type,
      upstreamOrigin,
    });
    return evidenceCheck(
      commandName,
      result.status,
      result.reason,
      raw,
    );
  } catch {
    return evidenceCheck(commandName, "FAILED", "EVIDENCE_INVALID");
  }
}

async function productionReport() {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
  });
  const headSha = stdout.trim();
  const release = evaluateReleaseSha(process.env.RELEASE_SHA, headSha);
  if (release.status !== "PASS") {
    const releaseCheck = evidenceCheck(
      "compare RELEASE_SHA to git rev-parse HEAD",
      release.status,
      release.reason,
    );
    return reportFor(
      unavailableChecks(
        "RELEASE_IDENTITY_UNAVAILABLE",
        releaseCheck,
        evidenceCheck("git status --porcelain", "BLOCKED", "RELEASE_IDENTITY_UNAVAILABLE"),
      ),
      null,
    );
  }
  const repositoryIdentity = await inspectRepositoryIdentity(process.cwd(), headSha);
  const initialRepositoryCheck = evidenceCheck(
    "git status --porcelain --untracked-files=all && git diff --check HEAD",
    repositoryIdentity.status,
    repositoryIdentity.reason,
    `${headSha}:${repositoryIdentity.status}`,
  );
  if (repositoryIdentity.status !== "PASS") {
    return reportFor(
      unavailableChecks("CLEAN_SOURCE_REQUIRED", evidenceCheck(
        "compare RELEASE_SHA to git rev-parse HEAD",
        "PASS",
        undefined,
        `${process.env.RELEASE_SHA}:${headSha}`,
      ), initialRepositoryCheck),
      process.env.RELEASE_SHA,
    );
  }
  const releaseEnvironment = {
    NODE_ENV: "production",
    RELEASE_SHA: process.env.RELEASE_SHA,
  };
  const productionWebEnvironment = {
    ...releaseEnvironment,
    API_UPSTREAM_ORIGIN: "https://api.production-build.invalid",
    APP_MODE: "production",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_production_build_contract",
    WEB_ORIGIN: "https://web.production-build.invalid",
  };
  const definitions = [
    { name: "workspaces", command: "required contracts + lint + typecheck + unit", timeoutMs: 900_000,
      run: async (signal) => validateRequiredContracts(process.cwd()).then(() => command("npm", ["run", "lint"], {}, [], signal)).then(() => command("npm", ["run", "typecheck"], {}, [], signal)).then(() => command("npm", ["run", "test:coverage"], {}, [], signal)) },
    { name: "browser", command: "demo + production member Playwright journeys", timeoutMs: 900_000,
      run: async (signal) => command("npm", ["run", "test:e2e"], { ...releaseEnvironment, APP_MODE: "demo" }, ["TEST_DATABASE_URL", "DATABASE_URL", "DATABASE_DIRECT_URL", "DATABASE_POOLED_URL"], signal).then(() => command("npm", ["run", "test:e2e:production", "-w", "@syntholo/web"], releaseEnvironment, ["TEST_DATABASE_URL", "DATABASE_URL", "DATABASE_DIRECT_URL", "DATABASE_POOLED_URL"], signal)) },
    { name: "artifacts", command: "production build + dashboard graph + node artifact syntax", timeoutMs: 900_000,
      run: async (signal) => validateRailwayServiceConfigs(process.cwd()).then(() => command("npm", ["run", "build"], productionWebEnvironment, ["TEST_DATABASE_URL", "DATABASE_URL", "DATABASE_DIRECT_URL", "DATABASE_POOLED_URL"], signal)).then(() => command("npm", ["run", "test:production-artifacts", "-w", "@syntholo/web"], productionWebEnvironment, ["TEST_DATABASE_URL", "DATABASE_URL", "DATABASE_DIRECT_URL", "DATABASE_POOLED_URL"], signal)).then(() => command("npm", ["run", "build:migrate"], releaseEnvironment, ["TEST_DATABASE_URL", "DATABASE_URL", "DATABASE_DIRECT_URL", "DATABASE_POOLED_URL"], signal)).then(() => command(process.execPath, ["--check", "apps/api/dist/server.js"], {}, [], signal)).then(() => command(process.execPath, ["--check", "apps/worker/dist/runner.js"], {}, [], signal)).then(() => command(process.execPath, ["--check", "apps/worker/dist/cron.js"], {}, [], signal)).then(() => command(process.execPath, ["--check", "dist/migrate.js"], {}, [], signal)).then(() => expectArtifactStartupFailure("apps/api/dist/server.js", "API_STARTUP_FAILED\n", signal)).then(() => expectArtifactStartupFailure("apps/worker/dist/runner.js", "WORKER_STARTUP_FAILED\n", signal)).then(() => expectArtifactStartupFailure("apps/worker/dist/cron.js", "WORKER_STARTUP_FAILED\n", signal)).then(() => expectArtifactStartupFailure("dist/migrate.js", "MIGRATION_STARTUP_FAILED\n", signal)) },
  ];
  const databaseDefinitions = [
    { name: "migrations", command: "exact migration inventory + schema + database migration integration", timeoutMs: 600_000,
      run: async (signal) => command("npm", ["run", "db:schema:check"], {}, [], signal).then(() => command("npm", ["run", "test:integration", "-w", "@syntholo/database", "--", "src/schema/foundation.integration.test.ts"], {}, [], signal)) },
    { name: "rls", command: "database RLS + member deadline integration", timeoutMs: 600_000,
      run: async (signal) => command("npm", ["run", "test:integration", "-w", "@syntholo/database", "--", "src/rls.integration.test.ts", "src/member-read-deadlines.integration.test.ts"], {}, [], signal) },
    { name: "identitySeparation", command: "identity/session/crypto suites", timeoutMs: 600_000,
      run: async (signal) => command("npm", ["test", "-w", "@syntholo/api", "--", "src/auth/auth.integration.test.ts", "src/auth/session-crypto.test.ts"], {}, [], signal).then(() => command("npm", ["run", "test:integration", "-w", "@syntholo/database", "--", "src/auth.integration.test.ts"], {}, [], signal)) },
    { name: "jobs", command: "worker unit and integration", timeoutMs: 600_000,
      run: async (signal) => command("npm", ["test", "-w", "@syntholo/worker"], {}, [], signal).then(() => command("npm", ["run", "test:integration", "-w", "@syntholo/worker"], {}, [], signal)).then(() => command("npm", ["run", "test:integration", "-w", "@syntholo/api"], {}, [], signal)).then(() => command("npm", ["run", "test:integration", "-w", "@syntholo/database", "--", "src/unit-of-work.integration.test.ts"], {}, [], signal)) },
    { name: "entitlements", command: "entitlement unit/property/races", timeoutMs: 900_000,
      run: async (signal) => command("npm", ["test", "-w", "@syntholo/domain", "--", "src/entitlements"], {}, [], signal).then(() => command("npm", ["run", "test:integration", "-w", "@syntholo/database", "--", "src/entitlements.integration.test.ts"], {}, [], signal)) },
  ];
  const databaseAvailable = process.env.TEST_DATABASE_URL?.trim() !== "" && process.env.TEST_DATABASE_URL !== undefined;
  if (databaseAvailable) definitions.push(...databaseDefinitions);
  const checks = await runIndependentChecks(definitions);
  if (!databaseAvailable) {
    const status = process.env.CI === "true" ? "FAILED" : "BLOCKED";
    const reason = process.env.CI === "true"
      ? "TEST_DATABASE_CONFIGURATION_MISSING"
      : "TEST_DATABASE_UNAVAILABLE";
    for (const definition of databaseDefinitions) {
      checks[definition.name] = evidenceCheck(definition.command, status, reason);
    }
  }
  checks.releaseSha = evidenceCheck(
    "compare RELEASE_SHA to git rev-parse HEAD",
    "PASS",
    undefined,
    `${process.env.RELEASE_SHA}:${headSha}`,
  );

  const graph = await inspectProductionDependencyGraph(process.cwd());
  const policyPass = productionDependencyPolicyPass(graph);
  checks.dependencyPolicy = evidenceCheck(
    "inspect manifests, imports, environment keys, URLs, lockfile, and built artifacts",
    policyPass ? "PASS" : "FAILED",
    policyPass ? undefined : "FORBIDDEN_PRODUCTION_DEPENDENCY",
    JSON.stringify(graph),
  );
  checks.images = await externalEvidenceCheck(
    process.env.FOUNDATION_IMAGE_EVIDENCE_PATH,
    "images",
    process.env.RELEASE_SHA,
  );
  checks.proxy = await externalEvidenceCheck(
    process.env.FOUNDATION_PROXY_EVIDENCE_PATH,
    "proxy",
    process.env.RELEASE_SHA,
    process.env.WEB_ORIGIN,
    process.env.API_UPSTREAM_ORIGIN,
  );
  checks.ancestry = await ancestryCheck(headSha);
  const finalRepositoryIdentity = await inspectRepositoryIdentity(process.cwd(), headSha);
  checks.repository = evidenceCheck(
    "git status --porcelain --untracked-files=all && git diff --check HEAD",
    finalRepositoryIdentity.status,
    finalRepositoryIdentity.reason,
    `${headSha}:${finalRepositoryIdentity.status}`,
  );
  return validateFoundationReport(reportFor(checks, process.env.RELEASE_SHA));
}

if (process.argv.includes("--test-fixture")) {
  process.stderr.write("TEST_FIXTURE_FORBIDDEN\n");
  process.exitCode = 1;
} else {
  const report = await productionReport();
  const serialized = `${JSON.stringify(report)}\n`;
  await writeFile("foundation-gate.json", serialized, "utf8");
  process.stdout.write(serialized);
  process.exitCode = foundationExitCode(report);
}
