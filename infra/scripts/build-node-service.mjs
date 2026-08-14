#!/usr/bin/env node
import { build } from "esbuild";

const releaseSha = process.env.RELEASE_SHA?.trim();
if (releaseSha === undefined || !/^[0-9a-f]{40}$/u.test(releaseSha)) {
  throw new Error("RELEASE_SHA_INVALID");
}
if (process.env.GITHUB_SHA !== undefined && process.env.GITHUB_SHA !== releaseSha) {
  throw new Error("RELEASE_SHA_HEAD_MISMATCH");
}

const service = process.argv[2];
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
