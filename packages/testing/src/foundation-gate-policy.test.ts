import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectProductionDependencyGraph,
  runIndependentChecks,
  validateImageMetadata,
} from "../../../infra/scripts/foundation-gate-lib.mjs";

const temporaryRoots: string[] = [];

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
  it("finds forbidden manifest, static, dynamic, aliased, environment, URL, lockfile, and built edges", async () => {
    const root = await fixture({
      "apps/web/dist/server.js": "fetch('https://services.leadconnectorhq.com/api/contacts')",
      "apps/web/package.json": JSON.stringify({
        dependencies: { "@gohighlevel/sdk": "1.0.0", mongodb: "1.0.0" },
      }),
      "apps/web/src/highlevel.ts": "import client from '@gohighlevel/sdk'",
      "apps/web/src/alias.ts": "import db from '@runtime/mongodb'",
      "apps/web/src/dynamic.ts": "const db = import('mongodb')",
      "apps/web/src/env.ts": "process.env.HIGHLEVEL_API_KEY",
      "apps/web/src/secret.ts": "process.env.CLERK_SECRET_KEY",
      "apps/web/src/static.ts": "import { MongoClient } from 'mongodb'",
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/mongodb": { version: "1.0.0" } },
      }),
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
    });

    const graph = await inspectProductionDependencyGraph(root);

    expect(graph.packages).toContain("mongodb");
    expect(graph.packages).toContain("@gohighlevel/sdk");
    expect(graph.imports.map(({ specifier }) => specifier)).toEqual(
      expect.arrayContaining(["@gohighlevel/sdk", "@runtime/mongodb", "mongodb"]),
    );
    expect(graph.environmentKeys).toEqual(
      expect.arrayContaining(["CLERK_SECRET_KEY", "HIGHLEVEL_API_KEY"]),
    );
    expect(graph.urls).toContain(
      "https://services.leadconnectorhq.com/api/contacts",
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
      urls: [],
    });
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
