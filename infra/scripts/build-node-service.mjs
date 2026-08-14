#!/usr/bin/env node
import { build } from "esbuild";
import { cp, rm } from "node:fs/promises";
import { evaluateProviderReleaseSha } from "./foundation-gate-lib.mjs";

const releaseSha = process.env.RELEASE_SHA?.trim();
if (releaseSha === undefined || !/^[0-9a-f]{40}$/u.test(releaseSha)) {
  throw new Error("RELEASE_SHA_INVALID");
}
const configuredProvider = process.env.SYNTHOLO_BUILD_PROVIDER?.trim();
const provider = configuredProvider === "railway"
  ? "railway"
  : process.env.GITHUB_SHA !== undefined
    ? "github"
    : undefined;
if (
  configuredProvider !== undefined
  && configuredProvider !== ""
  && configuredProvider !== "railway"
) {
  throw new Error("BUILD_PROVIDER_INVALID");
}
if (provider !== undefined && evaluateProviderReleaseSha(process.env, provider).status !== "PASS") {
  throw new Error("RELEASE_SHA_HEAD_MISMATCH");
}

const service = process.argv[2];
if (service === "api" && process.env.NODE_ENV !== "production") {
  throw new Error("API_BUILD_MODE_INVALID");
}
const configuration = service === "api"
  ? { entryPoints: ["src/server.ts"], outfile: "dist/server.js" }
  : service === "worker"
    ? { entryPoints: ["src/runner.ts", "src/cron.ts"], outdir: "dist" }
    : service === "migrate"
      ? {
          entryPoints: ["packages/database/src/migrate.ts"],
          outfile: "dist/migrate.js",
        }
    : undefined;

if (configuration === undefined) throw new Error("BUILD_SERVICE_INVALID");

await build({
  ...configuration,
  banner: {
    js: "import { createRequire as __syntholoCreateRequire } from 'node:module'; const require = __syntholoCreateRequire(import.meta.url);",
  },
  bundle: true,
  define: {
    __SYNTHOLO_RELEASE_SHA__: JSON.stringify(releaseSha),
  },
  format: "esm",
  legalComments: "none",
  minifySyntax: true,
  platform: "node",
  sourcemap: false,
  target: "node22.22.2",
});

if (service === "migrate") {
  await rm("dist/drizzle", { force: true, recursive: true });
  await cp("packages/database/drizzle", "dist/drizzle", { recursive: true });
}
