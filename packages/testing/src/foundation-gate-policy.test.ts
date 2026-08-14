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
  runIndependentChecks,
  validateExternalEvidence,
  validateFoundationReport,
  validateImageMetadata,
  validateRailwayServiceConfigs,
  validateRequiredContracts,
} from "../../../infra/scripts/foundation-gate-lib.mjs";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../..", import.meta.url).pathname;
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
  it("finds every forbidden server adapter plus static, dynamic, resolved alias, environment, URL, lockfile, and built edges", async () => {
    const root = await fixture({
      "apps/web/.next/server/app.js": [
        "require('resend')",
        "fetch('https://services.leadconnectorhq.com/oauth/token')",
      ].join("\n"),
      "apps/web/package.json": JSON.stringify({
        dependencies: {
          "@gohighlevel/sdk": "1.0.0",
          "@mux/mux-node": "1.0.0",
          "@vercel/blob": "1.0.0",
          mongodb: "1.0.0",
          resend: "1.0.0",
          stripe: "1.0.0",
        },
      }),
      "apps/web/src/highlevel.ts": "import client from '@gohighlevel/sdk'",
      "apps/web/src/alias.ts": "import adapter from '@private/adapter'",
      "apps/web/src/dynamic.ts": "const db = import('mongodb')",
      "apps/web/src/env.ts": "process.env.HIGHLEVEL_API_KEY",
      "apps/web/src/secret.ts": "process.env.CLERK_SECRET_KEY",
      "apps/web/src/static.ts": "import { MongoClient } from 'mongodb'",
      "packages/private/src/adapter.ts": "export { default } from 'stripe'",
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/@vercel/blob": { version: "1.0.0" },
          "node_modules/mongodb": { version: "1.0.0" },
          "node_modules/resend": { version: "1.0.0" },
        },
      }),
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
      "apps/web/tsconfig.json": JSON.stringify({
        compilerOptions: {
          paths: { "@private/*": ["../../packages/private/src/*"] },
        },
      }),
    });

    const graph = await inspectProductionDependencyGraph(root);

    expect(graph.packages).toContain("mongodb");
    expect(graph.packages).toContain("@gohighlevel/sdk");
    expect(graph.packages).toEqual(expect.arrayContaining([
      "@mux/mux-node",
      "@vercel/blob",
      "resend",
      "stripe",
    ]));
    expect(graph.imports.map(({ specifier }) => specifier)).toEqual(
      expect.arrayContaining(["@gohighlevel/sdk", "mongodb", "resend", "stripe"]),
    );
    expect(graph.resolvedImports).toContainEqual({
      path: "apps/web/src/alias.ts",
      resolvedPath: "packages/private/src/adapter.ts",
      specifier: "@private/adapter",
    });
    expect(graph.environmentKeys).toEqual(
      expect.arrayContaining(["CLERK_SECRET_KEY", "HIGHLEVEL_API_KEY"]),
    );
    expect(graph.urls).toContain(
      "https://services.leadconnectorhq.com/oauth/token",
    );
    expect(graph.builtArtifacts).toHaveLength(1);
    expect(graph.lockfilePackages).toContain("mongodb");
  });

  it("allows tests, docs, public browser SDKs, and approved external login links", async () => {
    const root = await fixture({
      "README.md": "Historical MongoDB migration notes and HIGHLEVEL_API_KEY fixture.",
      "apps/web/package.json": JSON.stringify({
        dependencies: {
          "@mux/mux-player-react": "3.10.2",
          "@stripe/stripe-js": "7.9.0",
          "posthog-js": "1.268.7",
        },
      }),
      "apps/web/src/external-link.ts": "export const login = 'https://app.gohighlevel.com/'",
      "apps/web/src/policy.test.ts": "const bad = process.env.HIGHLEVEL_API_KEY",
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
    });

    await expect(inspectProductionDependencyGraph(root)).resolves.toEqual({
      builtArtifacts: [],
      environmentKeys: [],
      imports: [],
      lockfilePackages: [],
      packages: ["@mux/mux-player-react", "@stripe/stripe-js", "posthog-js"],
      resolvedImports: [],
      urls: [],
    });
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
      version: 1,
    };

    expect(validateFoundationReport(report)).toBe(report);
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

  it("rejects stale or wrong-SHA deployed evidence and accepts exact image coverage", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const evidence = {
      artifactHash: "b".repeat(64),
      createdAt: now.toISOString(),
      environment: "ci",
      releaseSha,
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
    expect(validateExternalEvidence({ ...evidence, releaseSha: "1".repeat(40) }, {
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
      status: "PASS",
      statusCodePreserved: true,
      type: "proxy",
      upstreamOrigin: "https://api.syntholo.com",
      version: 1,
      workerReady: { releaseSha, status: "ready" },
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
  });

  it("validates required test contracts by identifier and content", async () => {
    await expect(validateRequiredContracts(repositoryRoot)).resolves.toBeUndefined();
    const root = await fixture({
      "apps/api/src/auth/auth.integration.test.ts": "describe('unrelated', () => {})",
    });
    await expect(validateRequiredContracts(root)).rejects.toThrow("REQUIRED_CONTRACT_MISSING");
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
