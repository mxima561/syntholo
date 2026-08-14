import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  FOUNDATION_CHECK_CATALOG,
  evaluateFoundationGate,
  evaluateProviderReleaseSha,
  foundationExitCode,
  inspectRepositoryIdentity,
  inspectProductionDependencyGraph,
  productionDependencyPolicyPass,
  runIndependentChecks,
  validateCiEvidenceConfig,
  validateExternalEvidence,
  validateExecutableTestCases,
  validateFoundationReport,
  validateImageMetadata,
  validateRailwayServiceConfigs,
  validateRequiredContracts,
} from "../../../infra/scripts/foundation-gate-lib.mjs";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../..", import.meta.url).pathname;
const secretFreeLogScript = new URL(
  "../../../infra/scripts/assert-secret-free-log.mjs",
  import.meta.url,
).pathname;
const releaseSha = "0123456789abcdef0123456789abcdef01234567";

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "syntholo-foundation-gate-"));
  temporaryRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

describe("production dependency policy", () => {
  it("fails web production reachability through static, dynamic, alias, lockfile, and built server-adapter edges", async () => {
    const root = await fixture({
      "apps/web/.next/server/app.js": "require('@clerk/backend')",
      "apps/web/package.json": JSON.stringify({
        dependencies: {
          "@syntholo/private": "0.1.0",
        },
      }),
      "apps/web/src/app/page.ts": [
        "import adapter from '@/adapter'",
        "void adapter",
        "void import('@private/dynamic')",
      ].join("\n"),
      "apps/web/src/adapter.ts": "export { default } from '@private/static'",
      "packages/private/package.json": JSON.stringify({
        name: "@syntholo/private",
        dependencies: { resend: "1.0.0" },
        exports: { ".": "./src/index.ts" },
      }),
      "packages/private/src/dynamic.ts": "export { default } from '@workos-inc/node'",
      "packages/private/src/index.ts": "export { default } from './static.js'",
      "packages/private/src/static.ts": "export { default } from 'stripe'",
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "apps/web": { dependencies: { "@syntholo/private": "0.1.0" } },
          "node_modules/@clerk/backend": { version: "1.0.0" },
          "node_modules/@syntholo/private": { link: true, resolved: "packages/private" },
          "node_modules/@workos-inc/node": { version: "1.0.0" },
          "node_modules/resend": { version: "1.0.0" },
          "node_modules/stripe": { version: "1.0.0" },
          "packages/private": {
            dependencies: { resend: "1.0.0" },
            name: "@syntholo/private",
            version: "0.1.0",
          },
        },
      }),
      "package.json": JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
      "apps/web/tsconfig.json": JSON.stringify({
        compilerOptions: {
          paths: {
            "@/*": ["./src/*"],
            "@private/*": ["../../packages/private/src/*"],
          },
        },
      }),
    });

    const graph = await inspectProductionDependencyGraph(root);

    expect(productionDependencyPolicyPass(graph)).toBe(false);
    expect(graph.policyViolations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "built", service: "web", value: "@clerk/backend" }),
      expect.objectContaining({ kind: "import", service: "web", value: "@workos-inc/node" }),
      expect.objectContaining({ kind: "import", service: "web", value: "stripe" }),
      expect.objectContaining({ kind: "lockfile", service: "web", value: "resend" }),
    ]));
    expect(graph.resolvedImports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "apps/web/src/app/page.ts",
        resolvedPath: "apps/web/src/adapter.ts",
        service: "web",
        specifier: "@/adapter",
      }),
      expect.objectContaining({
        path: "apps/web/src/app/page.ts",
        resolvedPath: "packages/private/src/dynamic.ts",
        service: "web",
        specifier: "@private/dynamic",
      }),
    ]));
  });

  it("allows privileged adapters in the API closure while keeping public browser SDKs web-scoped", async () => {
    const root = await fixture({
      "apps/api/package.json": JSON.stringify({
        dependencies: { "@syntholo/integrations": "0.1.0" },
      }),
      "apps/api/src/server.ts": "import '@syntholo/integrations'",
      "apps/web/.next/server/login.js": "export const login = 'https://gohighlevel.com/'",
      "apps/web/package.json": JSON.stringify({
        dependencies: {
          "@clerk/react": "1.0.0",
          "@mux/mux-player-react": "3.10.2",
          "@stripe/stripe-js": "7.9.0",
        },
      }),
      "apps/web/src/app/page.ts": "import '@clerk/react'; import '@mux/mux-player-react'; import '@stripe/stripe-js'",
      "apps/web/src/external-link.ts": "export const login = 'https://app.gohighlevel.com/'",
      "apps/web/src/policy.test.ts": "const bad = process.env.HIGHLEVEL_API_KEY",
      "packages/integrations/package.json": JSON.stringify({
        name: "@syntholo/integrations",
        dependencies: {
          "@clerk/backend": "1.0.0",
          "@mux/mux-node": "1.0.0",
          "@vercel/blob": "1.0.0",
          "@workos-inc/node": "1.0.0",
          resend: "1.0.0",
          stripe: "1.0.0",
        },
        exports: { ".": "./src/index.ts" },
      }),
      "packages/integrations/src/index.ts": [
        "export * from '@clerk/backend'",
        "export * from '@workos-inc/node'",
        "export * from 'stripe'",
        "export * from 'resend'",
        "export * from '@mux/mux-node'",
        "export * from '@vercel/blob'",
      ].join("\n"),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "apps/api": { dependencies: { "@syntholo/integrations": "0.1.0" } },
          "apps/web": { dependencies: { "@clerk/react": "1.0.0", "@mux/mux-player-react": "1.0.0", "@stripe/stripe-js": "1.0.0" } },
          "node_modules/@syntholo/integrations": { link: true, resolved: "packages/integrations" },
          "packages/integrations": {
            dependencies: {
              "@clerk/backend": "1.0.0", "@mux/mux-node": "1.0.0", "@vercel/blob": "1.0.0",
              "@workos-inc/node": "1.0.0", resend: "1.0.0", stripe: "1.0.0",
            },
            name: "@syntholo/integrations",
          },
        },
      }),
      "package.json": JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
    });

    const graph = await inspectProductionDependencyGraph(root);
    expect(productionDependencyPolicyPass(graph)).toBe(true);
    expect(graph.policyViolations).toEqual([]);
  });

  it("forbids MongoDB and HighLevel in every production service", async () => {
    const root = await fixture({
      "apps/api/package.json": JSON.stringify({ dependencies: { mongodb: "1.0.0" } }),
      "apps/api/src/server.ts": "import 'mongodb'; import '@gohighlevel/sdk'",
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "apps/api": { dependencies: { mongodb: "1.0.0" } },
          "node_modules/mongodb": { version: "1.0.0" },
        },
      }),
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
    });

    const graph = await inspectProductionDependencyGraph(root);
    expect(productionDependencyPolicyPass(graph)).toBe(false);
    expect(graph.policyViolations).toEqual(expect.arrayContaining([
      expect.objectContaining({ service: "api", value: "mongodb" }),
      expect.objectContaining({ service: "api", value: "@gohighlevel/sdk" }),
    ]));
  });

  it("inspects forbidden packages copied into the Next standalone runtime", async () => {
    const root = await fixture({
      "apps/web/.next/standalone/node_modules/@clerk/backend/index.js": "module.exports = {}",
      "apps/web/package.json": JSON.stringify({ name: "@syntholo/web" }),
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
    });

    const graph = await inspectProductionDependencyGraph(root);

    expect(productionDependencyPolicyPass(graph)).toBe(false);
    expect(graph.policyViolations).toContainEqual(expect.objectContaining({
      kind: "built",
      path: "apps/web/.next/standalone/node_modules/@clerk/backend/index.js",
      service: "web",
      value: "@clerk/backend",
    }));
  });

  it("follows Next NFT metadata using the web policy scope", async () => {
    const root = await fixture({
      "apps/web/.next/server/app.js.nft.json": JSON.stringify({
        version: 1,
        files: ["../../../../packages/private/dist/index.js"],
      }),
      "apps/web/package.json": JSON.stringify({ name: "@syntholo/web" }),
      "package.json": JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
      "packages/private/dist/index.js": "export { default } from 'stripe'",
      "packages/private/package.json": JSON.stringify({
        name: "@syntholo/private",
        exports: { ".": "./dist/index.js" },
      }),
    });

    const graph = await inspectProductionDependencyGraph(root);

    expect(productionDependencyPolicyPass(graph)).toBe(false);
    expect(graph.policyViolations).toContainEqual(expect.objectContaining({
      kind: "built",
      path: "packages/private/dist/index.js",
      service: "web",
      value: "stripe",
    }));
  });

  it("resolves aliases inherited from a base TypeScript configuration", async () => {
    const root = await fixture({
      "apps/web/package.json": JSON.stringify({ name: "@syntholo/web" }),
      "apps/web/src/app/page.ts": "import '@shared/server-adapter'",
      "apps/web/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.base.json" }),
      "package.json": JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
      "packages/shared/src/server-adapter.ts": "export { default } from '@workos-inc/node'",
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: {
          paths: { "@shared/*": ["packages/shared/src/*"] },
        },
      }),
    });

    const graph = await inspectProductionDependencyGraph(root);

    expect(productionDependencyPolicyPass(graph)).toBe(false);
    expect(graph.resolvedImports).toContainEqual(expect.objectContaining({
      path: "apps/web/src/app/page.ts",
      resolvedPath: "packages/shared/src/server-adapter.ts",
      service: "web",
      specifier: "@shared/server-adapter",
    }));
  });

  it("includes root optional dependencies in the production lock closure", async () => {
    const root = await fixture({
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { optionalDependencies: { mongodb: "1.0.0" } },
          "node_modules/mongodb": { version: "1.0.0" },
        },
      }),
      "package.json": JSON.stringify({ optionalDependencies: { mongodb: "1.0.0" } }),
    });

    const graph = await inspectProductionDependencyGraph(root);

    expect(productionDependencyPolicyPass(graph)).toBe(false);
    expect(graph.policyViolations).toContainEqual(expect.objectContaining({
      kind: "lockfile",
      service: "root",
      value: "mongodb",
    }));
  });

  it("includes lockfile peer dependencies in each service closure", async () => {
    const root = await fixture({
      "apps/web/package.json": JSON.stringify({ dependencies: { adapter: "1.0.0" } }),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "apps/web": { dependencies: { adapter: "1.0.0" } },
          "node_modules/adapter": { peerDependencies: { resend: "1.0.0" }, version: "1.0.0" },
          "node_modules/resend": { version: "1.0.0" },
        },
      }),
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
    });

    const graph = await inspectProductionDependencyGraph(root);

    expect(productionDependencyPolicyPass(graph)).toBe(false);
    expect(graph.policyViolations).toContainEqual(expect.objectContaining({
      kind: "lockfile",
      service: "web",
      value: "resend",
    }));
  });

  it("keeps versioned lock closures isolated by service", async () => {
    const root = await fixture({
      "apps/api/package.json": JSON.stringify({ dependencies: { adapter: "1.0.0" } }),
      "apps/web/package.json": JSON.stringify({ dependencies: { adapter: "2.0.0" } }),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "apps/api": { dependencies: { adapter: "1.0.0" } },
          "apps/web": { dependencies: { adapter: "2.0.0" } },
          "apps/web/node_modules/adapter": { version: "2.0.0" },
          "node_modules/adapter": { dependencies: { stripe: "1.0.0" }, version: "1.0.0" },
          "node_modules/stripe": { version: "1.0.0" },
        },
      }),
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
    });

    const graph = await inspectProductionDependencyGraph(root);

    expect(productionDependencyPolicyPass(graph)).toBe(true);
    expect(graph.policyViolations).toEqual([]);
  });
});

describe("release source identity", () => {
  it.each([
    ["railway", "RAILWAY_GIT_COMMIT_SHA"],
    ["vercel", "VERCEL_GIT_COMMIT_SHA"],
  ] as const)("requires and matches the %s checkout SHA", (provider, key) => {
    expect(evaluateProviderReleaseSha({ RELEASE_SHA: releaseSha }, provider))
      .toEqual({ reason: "PROVIDER_COMMIT_SHA_REQUIRED", status: "BLOCKED" });
    expect(evaluateProviderReleaseSha({
      RELEASE_SHA: releaseSha,
      [key]: "1123456789abcdef0123456789abcdef01234567",
    }, provider)).toEqual({
      reason: "PROVIDER_COMMIT_SHA_MISMATCH",
      status: "BLOCKED",
    });
    expect(evaluateProviderReleaseSha({ RELEASE_SHA: releaseSha, [key]: releaseSha }, provider))
      .toEqual({ status: "PASS" });
  });

  it("rejects a tracked or untracked worktree before certification", async () => {
    const root = await fixture({ "tracked.txt": "clean\n" });
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "gate@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Gate Test"], { cwd: root });
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();

    await expect(inspectRepositoryIdentity(root, head)).resolves.toMatchObject({
      headSha: head,
      status: "PASS",
    });
    await writeFile(join(root, "untracked.txt"), "dirty\n", "utf8");
    await expect(inspectRepositoryIdentity(root, head)).resolves.toEqual({
      headSha: head,
      reason: "REPOSITORY_DIRTY",
      status: "BLOCKED",
    });
    await rm(join(root, "untracked.txt"));
    await writeFile(join(root, "tracked.txt"), "tracked mutation\n", "utf8");
    await expect(inspectRepositoryIdentity(root, head)).resolves.toEqual({
      headSha: head,
      reason: "REPOSITORY_DIRTY",
      status: "BLOCKED",
    });
  });
});

describe("Railway service topology", () => {
  it("accepts the four provider-valid, one-purpose Dockerfile services", async () => {
    await expect(validateRailwayServiceConfigs(repositoryRoot)).resolves.toEqual({
      api: { command: "/app/server.js", dockerfilePath: "apps/api/Dockerfile" },
      cron: { command: "/app/cron.js", dockerfilePath: "apps/worker/Dockerfile.cron" },
      migrate: { command: "/app/migrate.js", dockerfilePath: "apps/api/Dockerfile.migrate" },
      worker: { command: "/app/runner.js", dockerfilePath: "apps/worker/Dockerfile" },
    });
  });

  it("rejects an unsupported Docker target and a missing default runtime command", async () => {
    const root = await fixture({
      "apps/api/Dockerfile": "FROM scratch\n",
      "infra/railway/api.toml": [
        "[build]",
        'builder = "DOCKERFILE"',
        'dockerfilePath = "apps/api/Dockerfile"',
        'dockerfileTarget = "runtime"',
        "[deploy]",
        'startCommand = "/usr/local/bin/node /app/server.js"',
        'restartPolicyType = "ON_FAILURE"',
      ].join("\n"),
    });
    await expect(validateRailwayServiceConfigs(root, ["api"]))
      .rejects.toThrow("RAILWAY_CONFIG_INVALID");
  });

  it("rejects an API image and Railway command without an explicit production mode", async () => {
    const root = await fixture({
      "apps/api/Dockerfile": [
        "FROM node:22",
        'ENTRYPOINT ["/usr/local/bin/node"]',
        'CMD ["/app/server.js"]',
      ].join("\n"),
      "infra/railway/api.toml": [
        "[build]",
        'builder = "DOCKERFILE"',
        'dockerfilePath = "apps/api/Dockerfile"',
        "[deploy]",
        'startCommand = "/usr/local/bin/node /app/server.js"',
        'restartPolicyType = "ON_FAILURE"',
      ].join("\n"),
    });
    await expect(validateRailwayServiceConfigs(root, ["api"]))
      .rejects.toThrow("RAILWAY_CONFIG_INVALID");
  });
});

describe("gate report trust boundary", () => {
  const pass = (command: string) => ({
    artifactHash: "a".repeat(64),
    command,
    durationMs: 1,
    status: "PASS" as const,
  });

  it("requires the exact named check catalog and valid evidence metadata", () => {
    const checks = Object.fromEntries(
      FOUNDATION_CHECK_CATALOG.map((name) => [name, pass(name)]),
    );
    const report = {
      checks,
      createdAt: new Date().toISOString(),
      engineeringGate: "PASS",
      environment: "local",
      launchGate: "PASS",
      releaseSha,
      schema: "syntholo.foundation-gate.v1",
      version: 1,
    };

    expect(validateFoundationReport(report)).toBe(report);
    expect(() => validateFoundationReport({ ...report, schema: undefined }))
      .toThrow("FOUNDATION_REPORT_INVALID");
    const incompleteChecks = Object.fromEntries(
      Object.entries(checks).filter(([name]) => name !== "jobs"),
    );
    expect(() => validateFoundationReport({ ...report, checks: incompleteChecks }))
      .toThrow("FOUNDATION_REPORT_INVALID");
    expect(() => validateFoundationReport({
      ...report,
      checks: { ...checks, jobs: { ...checks.jobs, artifactHash: "synthetic" } },
    })).toThrow("FOUNDATION_REPORT_INVALID");
  });

  it("distinguishes failed checks, unavailable engineering evidence, and launch-only evidence", () => {
    expect(evaluateFoundationGate({
      ancestry: pass("ancestry"),
      images: { ...pass("images"), reason: "IMAGE_EVIDENCE_UNAVAILABLE", status: "BLOCKED" },
      proxy: { ...pass("proxy"), reason: "PROXY_EVIDENCE_UNAVAILABLE", status: "BLOCKED" },
      repository: pass("repository"),
    })).toEqual({ engineeringGate: "BLOCKED", launchGate: "BLOCKED" });
    expect(evaluateFoundationGate({
      ancestry: pass("ancestry"),
      images: pass("images"),
      proxy: { ...pass("proxy"), reason: "PROXY_EVIDENCE_UNAVAILABLE", status: "BLOCKED" },
      repository: pass("repository"),
    })).toEqual({ engineeringGate: "PASS", launchGate: "BLOCKED" });
    expect(evaluateFoundationGate({
      ancestry: pass("ancestry"),
      images: pass("images"),
      proxy: pass("proxy"),
      repository: { ...pass("repository"), reason: "CHECK_FAILED", status: "FAILED" },
    })).toEqual({ engineeringGate: "FAILED", launchGate: "FAILED" });
    expect(foundationExitCode({ engineeringGate: "PASS" })).toBe(0);
    expect(foundationExitCode({ engineeringGate: "BLOCKED" })).toBe(1);
    expect(foundationExitCode({ engineeringGate: "FAILED" })).toBe(1);
  });

  it("rejects stale, wrong-SHA, or non-CI image evidence and accepts exact image coverage", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const evidence = {
      artifactHash: "b".repeat(64),
      createdAt: now.toISOString(),
      environment: "ci",
      releaseSha,
      schema: "syntholo.foundation-gate.v1",
      services: ["api", "cron", "migrate", "worker"],
      status: "PASS",
      type: "images",
      version: 1,
    };
    expect(validateExternalEvidence(evidence, {
      now,
      releaseSha,
      type: "images",
    })).toEqual({ status: "PASS" });
    expect(validateExternalEvidence({ ...evidence, schema: "foundation-gate.v1" }, {
      now,
      releaseSha,
      type: "images",
    })).toEqual({ reason: "EVIDENCE_INVALID", status: "FAILED" });
    expect(validateExternalEvidence({ ...evidence, releaseSha: "1".repeat(40) }, {
      now,
      releaseSha,
      type: "images",
    })).toEqual({ reason: "EVIDENCE_INVALID", status: "FAILED" });
    expect(validateExternalEvidence({ ...evidence, environment: "production" }, {
      now,
      releaseSha,
      type: "images",
    })).toEqual({ reason: "EVIDENCE_INVALID", status: "FAILED" });
    const missingEnvironment = Object.fromEntries(
      Object.entries(evidence).filter(([key]) => key !== "environment"),
    );
    expect(validateExternalEvidence(missingEnvironment, {
      now,
      releaseSha,
      type: "images",
    })).toEqual({ reason: "EVIDENCE_INVALID", status: "FAILED" });
  });

  it("requires deployed proxy semantics and SHA-bound worker readiness", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const common = {
      artifactHash: "c".repeat(64),
      authorizationPreserved: true,
      bodyHash: "d".repeat(64),
      cookiePreserved: true,
      createdAt: now.toISOString(),
      environment: "production",
      host: "https://app.syntholo.com",
      locationPreserved: true,
      multipleSetCookiePreserved: true,
      releaseSha,
      schema: "syntholo.foundation-gate.v1",
      status: "PASS",
      statusCodePreserved: true,
      type: "proxy",
      upstreamOrigin: "https://api.syntholo.com",
      version: 1,
      workerReady: {
        createdAt: "2026-08-14T11:59:00.000Z",
        releaseSha,
        service: "worker",
        status: "ready",
      },
    };
    const options = {
      host: "https://app.syntholo.com",
      now,
      releaseSha,
      type: "proxy" as const,
      upstreamOrigin: "https://api.syntholo.com",
    };
    expect(validateExternalEvidence(common, options)).toEqual({ status: "PASS" });
    expect(validateExternalEvidence({ ...common, workerReady: undefined }, options))
      .toEqual({ reason: "EVIDENCE_INVALID", status: "FAILED" });
    expect(validateExternalEvidence({
      ...common,
      workerReady: { ...common.workerReady, service: "api" },
    }, options)).toEqual({ reason: "EVIDENCE_INVALID", status: "FAILED" });
    expect(validateExternalEvidence({
      ...common,
      workerReady: { ...common.workerReady, createdAt: "not-a-time" },
    }, options)).toEqual({ reason: "EVIDENCE_INVALID", status: "FAILED" });
  });

  it("validates required test contracts by identifier and content", async () => {
    await expect(validateRequiredContracts(repositoryRoot)).resolves.toBeUndefined();
    const root = await fixture({
      "apps/api/src/auth/auth.integration.test.ts": "describe('unrelated', () => {})",
    });
    await expect(validateRequiredContracts(root)).rejects.toThrow("REQUIRED_CONTRACT_MISSING");
  });

  it.each([
    ["a comment", "// it('required contract', () => { expect(true).toBe(true) })"],
    ["a skipped test", "it.skip('required contract', () => { expect(true).toBe(true) })"],
    ["a todo test", "it.todo('required contract')"],
    ["an empty test", "it('required contract', () => {})"],
    ["a skipped suite", "describe.skip('suite', () => { it('required contract', () => { expect(runContract()).toBe(true) }) })"],
    ["a conditional suite", "describe.runIf(enabled)('suite', () => { it('required contract', () => { expect(runContract()).toBe(true) }) })"],
    ["a conditionally registered test", "if (enabled) { it('required contract', () => { expect(runContract()).toBe(true) }) }"],
    ["an && short-circuit registration", "enabled && it('required contract', () => { expect(runContract()).toBe(true) })"],
    ["an || short-circuit registration", "enabled || it('required contract', () => { expect(runContract()).toBe(true) })"],
    ["a ?? short-circuit registration", "enabled ?? it('required contract', () => { expect(runContract()).toBe(true) })"],
    ["an &&= logical-assignment registration", "enabled &&= it('required contract', () => { expect(runContract()).toBe(true) })"],
    ["an ||= logical-assignment registration", "enabled ||= it('required contract', () => { expect(runContract()).toBe(true) })"],
    ["a ??= logical-assignment registration", "enabled ??= it('required contract', () => { expect(runContract()).toBe(true) })"],
    ["an assertion-free behavior call", "it('required contract', () => { runContract() })"],
    ["a non-executing token reference", "it('required contract', () => { void runContract; expect(true).toBe(true) })"],
    ["an uncalled helper body", "it('required contract', () => { function fake() { expect(runContract()).toBe(true) }; expect(true).toBe(true) })"],
    ["an assert.log lookalike", "import assert from 'node:assert/strict'; it('required contract', () => { assert.log(runContract()) })"],
    ["an expect.soft lookalike", "it('required contract', () => { expect.soft(runContract()) })"],
    ["an expect.extend matcher definition", "it('required contract', () => { expect.extend({ toPass() { runContract(); return { pass: true, message: () => '' } } }) })"],
    ["a shadowed default assert binding", "import assert from 'node:assert/strict'; it('required contract', () => { const assert = () => {}; assert(runContract()) })"],
    ["a shadowed named equal binding", "import { equal } from 'node:assert/strict'; it('required contract', () => { const equal = () => {}; equal(runContract(), true) })"],
    ["a shadowed expect binding", "it('required contract', () => { const expect = () => ({ toBe() {} }); expect(runContract()).toBe(true) })"],
    ["a module-scope fake it binding", "import { expect } from 'vitest'; const it = (_title, handler) => handler(); it('required contract', () => { expect(runContract()).toBe(true) })"],
    ["a module-scope fake test import", "import { test, expect } from './fake-runner'; test('required contract', () => { expect(runContract()).toBe(true) })"],
    ["a module-scope fake describe binding", "import { it, expect } from 'vitest'; const describe = (_title, handler) => handler(); describe('suite', () => { it('required contract', () => { expect(runContract()).toBe(true) }) })"],
    ["a module-scope fake expect binding", "import { it } from 'vitest'; const expect = () => ({ toBe() {} }); it('required contract', () => { expect(runContract()).toBe(true) })"],
    ["a class static-block shadowed expect binding", "import { it, expect } from 'vitest'; it('required contract', () => { class Evidence { static { const expect = () => ({ toBe() {} }); expect(runContract()).toBe(true) } } })"],
    ["a class static-block shadowed default assert binding", "import assert from 'node:assert/strict'; import { it } from 'vitest'; it('required contract', () => { class Evidence { static { const assert = { equal() {} }; assert.equal(runContract(), true) } } })"],
    ["a class static-block shadowed named equal binding", "import { equal } from 'node:assert/strict'; import { it } from 'vitest'; it('required contract', () => { class Evidence { static { const equal = () => {}; equal(runContract(), true) } } })"],
    ["a nested static-block var binding", "import { it, expect } from 'vitest'; it('required contract', () => { class Evidence { static { { var expect = () => ({ toBe() {} }) } expect(runContract()).toBe(true) } } })"],
    ["a named class-expression assert binding", "import assert from 'node:assert/strict'; import { it } from 'vitest'; it('required contract', () => { const Evidence = class assert { static equal() {} static { assert.equal(runContract(), true) } }; void Evidence })"],
    ["an uninstantiated instance-field assertion", "import { it, expect } from 'vitest'; it('required contract', () => { class Evidence { value = expect(runContract()).toBe(true) }; expect(true).toBe(true) })"],
    ["a conditional assertion branch", "import { it, expect } from 'vitest'; it('required contract', () => { if (enabled) expect(runContract()).toBe(true); expect(true).toBe(true) })"],
    ["a short-circuit assertion branch", "import { it, expect } from 'vitest'; it('required contract', () => { enabled && expect(runContract()).toBe(true); expect(true).toBe(true) })"],
    ["an assertion hidden in an unproven callback", "import { it, expect } from 'vitest'; it('required contract', () => { execute(() => expect(runContract()).toBe(true)); expect(true).toBe(true) })"],
  ])("does not accept %s as an executable required contract", (_case, source) => {
    expect(() => validateExecutableTestCases(
      source,
      ["required contract"],
      { "required contract": ["runContract"] },
    ))
      .toThrow("REQUIRED_CONTRACT_MISSING");
  });

  it("accepts an executable non-skipped required test", () => {
    expect(() => validateExecutableTestCases(
      "import { expect, it } from 'vitest'; it('required contract', () => { expect(runContract()).toBe(true) })",
      ["required contract"],
      { "required contract": ["runContract"] },
    )).not.toThrow();
  });

  it("accepts an imported node:assert assertion invocation", () => {
    expect(() => validateExecutableTestCases(
      "import assert from 'node:assert/strict'; import { it } from 'vitest'; it('required contract', () => { assert.equal(runContract(), true) })",
      ["required contract"],
      { "required contract": ["runContract"] },
    )).not.toThrow();
  });

  it("accepts an imported named node:assert assertion invocation", () => {
    expect(() => validateExecutableTestCases(
      "import { equal } from 'node:assert/strict'; import { it } from 'vitest'; it('required contract', () => { equal(runContract(), true) })",
      ["required contract"],
      { "required contract": ["runContract"] },
    )).not.toThrow();
  });

  it("accepts imported aliases and an executable class static block", () => {
    expect(() => validateExecutableTestCases(
      "import { expect as verify, it as spec } from 'vitest'; spec('required contract', () => { class Evidence { static { verify(runContract()).toBe(true) } } })",
      ["required contract"],
      { "required contract": ["runContract"] },
    )).not.toThrow();
  });

  it("accepts an imported Playwright test and assertion", () => {
    expect(() => validateExecutableTestCases(
      "import { expect, test } from '@playwright/test'; test('required contract', () => { expect(runContract()).toBe(true) })",
      ["required contract"],
      { "required contract": ["runContract"] },
    )).not.toThrow();
  });

  it("requires structured syntax from the executable test body", () => {
    expect(() => validateExecutableTestCases(
      "import { expect, it } from 'vitest'; it('required contract', () => { expect(true).toBe(true) })",
      ["required contract"],
      { "required contract": ["runContract"] },
    )).toThrow("REQUIRED_CONTRACT_MISSING");
    expect(() => validateExecutableTestCases(
      "import { expect, it } from 'vitest'; it('required contract', () => { expect(runContract()).toBe(true) })",
      ["required contract"],
      { "required contract": ["runContract"] },
    )).not.toThrow();
  });
});

describe("independent check execution", () => {
  it("attributes a timeout and continues collecting independent results", async () => {
    const results = await runIndependentChecks([
      {
        command: "slow-check",
        name: "migrations",
        run: async (signal) => {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          );
          throw new Error("aborted secret detail");
        },
        timeoutMs: 5,
      },
      {
        command: "healthy-check",
        name: "jobs",
        run: async () => undefined,
        timeoutMs: 50,
      },
    ]);

    expect(results.migrations).toMatchObject({
      command: "slow-check",
      reason: "CHECK_TIMEOUT",
      status: "FAILED",
    });
    expect(results.jobs).toMatchObject({
      command: "healthy-check",
      status: "PASS",
    });
    expect(JSON.stringify(results)).not.toContain("secret detail");
  });
});

describe("container metadata policy", () => {
  it("binds all four runtime log classes into active CI validation and image evidence", async () => {
    await expect(validateCiEvidenceConfig(repositoryRoot)).resolves.toBeUndefined();
    const root = await fixture({
      ".github/workflows/ci.yml": [
        "jobs:",
        "  images:",
        "    steps:",
        "      # node infra/scripts/assert-secret-free-log.mjs api=a cron=c migrate=m worker=w",
        "      - run: echo missing-runtime-validation",
      ].join("\n"),
    });
    await expect(validateCiEvidenceConfig(root))
      .rejects.toThrow("CI_EVIDENCE_CONFIG_INVALID");
  });

  it("requires secret-free runtime logs from API, migration, worker, and cron", async () => {
    const root = await fixture({
      "api.log": "api ready\n",
      "cron.log": "cron complete\n",
      "migrate.log": "migration complete\n",
      "worker.log": "worker ready\n",
    });
    await expect(execFileAsync(process.execPath, [
      secretFreeLogScript,
      `api=${join(root, "api.log")}`,
      `worker=${join(root, "worker.log")}`,
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("SECRET_FREE_LOG_COVERAGE_INVALID"),
    });
    await expect(execFileAsync(process.execPath, [
      secretFreeLogScript,
      `api=${join(root, "api.log")}`,
      `cron=${join(root, "cron.log")}`,
      `migrate=${join(root, "migrate.log")}`,
      `worker=${join(root, "worker.log")}`,
    ])).resolves.toMatchObject({ stdout: "" });
  });

  it("rejects a secret exposed by migration or cron runtime logs", async () => {
    const root = await fixture({
      "api.log": "api ready\n",
      "cron.log": "cron complete\n",
      "migrate.log": "postgres://secret\n",
      "worker.log": "worker ready\n",
    });
    await expect(execFileAsync(process.execPath, [
      secretFreeLogScript,
      `api=${join(root, "api.log")}`,
      `cron=${join(root, "cron.log")}`,
      `migrate=${join(root, "migrate.log")}`,
      `worker=${join(root, "worker.log")}`,
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("STARTUP_LOG_SECRET_EXPOSURE"),
    });
  });

  it("accepts an exact non-root SHA-bound runtime image", () => {
    expect(validateImageMetadata({
      command: ["/app/server.js"],
      entrypoint: ["/usr/local/bin/node"],
      files: ["app/server.js", "usr/local/bin/node"],
      history: ["COPY server.js /app/server.js"],
      labels: { "org.opencontainers.image.revision": "0123456789abcdef0123456789abcdef01234567" },
      releaseSha: "0123456789abcdef0123456789abcdef01234567",
      service: "api",
      user: "10001:10001",
    })).toEqual({ status: "PASS" });
  });

  it.each([
    ["cron", "/app/cron.js"],
    ["migrate", "/app/migrate.js"],
    ["worker", "/app/runner.js"],
  ] as const)("accepts the exact %s one-purpose process", (service, command) => {
    expect(validateImageMetadata({
      command: [command],
      entrypoint: ["/usr/local/bin/node"],
      files: [command],
      history: [`COPY ${command} ${command}`],
      labels: { "org.opencontainers.image.revision": "0123456789abcdef0123456789abcdef01234567" },
      releaseSha: "0123456789abcdef0123456789abcdef01234567",
      service,
      user: "10001:10001",
    })).toEqual({ status: "PASS" });
  });

  it.each([
    { user: "root" },
    { command: ["/app/cron.js"] },
    { files: ["app/server.js", "app/.env"] },
    { history: ["COPY .git /app/.git"] },
    { labels: { "org.opencontainers.image.revision": "wrong" } },
  ])("blocks unsafe runtime image metadata %#", (patch) => {
    expect(validateImageMetadata({
      command: ["/app/server.js"],
      entrypoint: ["/usr/local/bin/node"],
      files: ["app/server.js"],
      history: ["COPY server.js /app/server.js"],
      labels: { "org.opencontainers.image.revision": "0123456789abcdef0123456789abcdef01234567" },
      releaseSha: "0123456789abcdef0123456789abcdef01234567",
      service: "api",
      user: "10001:10001",
      ...patch,
    })).toEqual({ reason: "IMAGE_CONTRACT_INVALID", status: "FAILED" });
  });
});
