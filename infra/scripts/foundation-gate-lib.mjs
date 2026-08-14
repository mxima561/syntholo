import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/u;

const forbiddenEnvironmentKey = /^(?:(?:DATABASE_(?:DIRECT_|POOLED_)?URL|TEST_DATABASE_URL|(?:MEMBER|STAFF|SYSTEM|WORKER)_DATABASE_URL|WORKOS_.+|STRIPE_(?:SECRET|WEBHOOK).+|MUX_(?:TOKEN|SIGNING).+|RESEND_(?:API|SECRET).+|BLOB_(?:READ_WRITE|WRITE).+|HIGHLEVEL_.+)|.*(?:SECRET(?:_KEY)?|API_KEY|PRIVATE_KEY|WRITE_TOKEN))$/u;
const forbiddenUrl = /https?:\/\/(?:[^/]*\.)?(?:leadconnectorhq\.com|gohighlevel\.com)\/(?:api|v\d+|locations|contacts)(?:[/"'`]|$)/iu;
const forbiddenRuntimeImport = /(?:^|[/@_-])(?:mongodb|gohighlevel|leadconnector|highlevel)(?:$|[/_-])/iu;
const sourceExtension = /\.(?:c|m)?(?:j|t)sx?$/u;
const excludedSource = /(?:^|\/)(?:__tests__|tests?|fixtures?|docs?|\.superpowers)(?:\/|$)|\.(?:test|spec)\.[^.]+$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function walk(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function normalized(root, file) {
  return relative(root, file).split(sep).join("/");
}

function importsIn(contents) {
  const imports = [];
  const expressions = [
    /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]/gu,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gu,
    /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gu,
  ];
  for (const expression of expressions) {
    for (const match of contents.matchAll(expression)) imports.push(match[1]);
  }
  return [...new Set(imports.filter(Boolean))];
}

function environmentKeysIn(contents) {
  const keys = [];
  for (const match of contents.matchAll(/\bprocess\.env(?:\.([A-Z][A-Z0-9_]+)|\[["'`]([A-Z][A-Z0-9_]+)["'`]\])/gu)) {
    keys.push(match[1] ?? match[2]);
  }
  return [...new Set(keys.filter(Boolean))];
}

function urlsIn(contents) {
  return [...new Set(
    [...contents.matchAll(/https?:\/\/[^\s"'`)>,]+/gu)]
      .map((match) => match[0])
      .filter((url) => forbiddenUrl.test(url)),
  )];
}

function packageNameFromLockPath(path) {
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  if (index < 0) return undefined;
  const remainder = path.slice(index + marker.length);
  if (remainder.startsWith("@")) return remainder.split("/").slice(0, 2).join("/");
  return remainder.split("/")[0];
}

export async function inspectProductionDependencyGraph(repositoryRoot) {
  const files = await walk(repositoryRoot);
  const packages = new Set();
  const imports = [];
  const environmentKeys = new Set();
  const urls = new Set();
  const builtArtifacts = [];
  const lockfilePackages = new Set();

  for (const file of files) {
    const path = normalized(repositoryRoot, file);
    if (path === "package-lock.json") {
      const lock = JSON.parse(await readFile(file, "utf8"));
      for (const lockPath of Object.keys(lock.packages ?? {})) {
        const name = packageNameFromLockPath(lockPath);
        if (name !== undefined && forbiddenRuntimeImport.test(name)) {
          lockfilePackages.add(name);
        }
      }
      continue;
    }
    if (path === "package.json" || /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(path)) {
      const manifest = JSON.parse(await readFile(file, "utf8"));
      for (const name of Object.keys(manifest.dependencies ?? {})) packages.add(name);
      continue;
    }
    const built = /^(?:apps|packages)\/[^/]+\/(?:dist|\.next\/(?:server|standalone|static))(?:\/|$)/u.test(path);
    const productionWebPath = path.startsWith("apps/web/src/")
      || (path.startsWith("apps/web/") && built);
    if ((!sourceExtension.test(path) && !built) || (!built && excludedSource.test(path))) continue;
    const contents = await readFile(file, "utf8").catch(() => "");
    const fileImports = importsIn(contents);
    for (const specifier of fileImports) {
      if (forbiddenRuntimeImport.test(specifier)) imports.push({ path, specifier });
    }
    for (const key of environmentKeysIn(contents)) {
      if (productionWebPath && forbiddenEnvironmentKey.test(key)) {
        environmentKeys.add(key);
      }
    }
    for (const url of urlsIn(contents)) urls.add(url);
    if (
      built && (
        fileImports.some((specifier) => forbiddenRuntimeImport.test(specifier))
        || environmentKeysIn(contents).some((key) => forbiddenEnvironmentKey.test(key))
        || urlsIn(contents).length > 0
      )
    ) {
      builtArtifacts.push(path);
    }
  }

  return {
    builtArtifacts: builtArtifacts.sort(),
    environmentKeys: [...environmentKeys].sort(),
    imports: imports.sort((left, right) =>
      left.path.localeCompare(right.path) || left.specifier.localeCompare(right.specifier)
    ),
    lockfilePackages: [...lockfilePackages].sort(),
    packages: [...packages].sort(),
    urls: [...urls].sort(),
  };
}

export function evaluateReleaseSha(releaseSha, headSha) {
  if (releaseSha === undefined || releaseSha === "") {
    return { reason: "RELEASE_SHA_REQUIRED", status: "BLOCKED" };
  }
  if (!RELEASE_SHA_PATTERN.test(releaseSha)) {
    return { reason: "RELEASE_SHA_INVALID", status: "BLOCKED" };
  }
  if (!RELEASE_SHA_PATTERN.test(headSha) || releaseSha !== headSha) {
    return { reason: "RELEASE_SHA_HEAD_MISMATCH", status: "BLOCKED" };
  }
  return { status: "PASS" };
}

export async function runIndependentChecks(definitions) {
  const results = {};
  for (const definition of definitions) {
    const started = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, definition.timeoutMs);
    try {
      await Promise.race([
        definition.run(controller.signal),
        new Promise((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("CHECK_TIMEOUT")),
            { once: true },
          );
        }),
      ]);
      results[definition.name] = {
        artifactHash: sha256(`${definition.command}:PASS`),
        command: definition.command,
        durationMs: Date.now() - started,
        status: "PASS",
      };
    } catch {
      results[definition.name] = {
        artifactHash: sha256(`${definition.command}:FAILED`),
        command: definition.command,
        durationMs: Date.now() - started,
        reason: timedOut ? "CHECK_TIMEOUT" : "CHECK_FAILED",
        status: "FAILED",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
  return results;
}

export async function artifactHash(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("ARTIFACT_INVALID");
  return sha256(await readFile(path));
}

export function validateImageMetadata(metadata) {
  const commands = {
    api: ["/app/server.js"],
    cron: ["/app/cron.js"],
    migrate: ["/app/migrate.js"],
    worker: ["/app/runner.js"],
  };
  const expectedCommand = commands[metadata.service];
  const forbiddenFile = /(?:^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|node_modules(?:\/|$)|[^/]+\.(?:map|tsbuildinfo)|(?:test-results|playwright-report|coverage)(?:\/|$))/u;
  const invalid = expectedCommand === undefined
    || !RELEASE_SHA_PATTERN.test(metadata.releaseSha)
    || metadata.labels?.["org.opencontainers.image.revision"] !== metadata.releaseSha
    || !/^10001(?::10001)?$/u.test(metadata.user ?? "")
    || JSON.stringify(metadata.entrypoint) !== JSON.stringify(["/usr/local/bin/node"])
    || JSON.stringify(metadata.command) !== JSON.stringify(expectedCommand)
    || metadata.files.some((path) => forbiddenFile.test(path))
    || metadata.history.some((line) => /(?:^|[ /])\.git(?:[ /]|$)|(?:^|[ /])\.env(?:[. /]|$)/u.test(line));
  return invalid
    ? { reason: "IMAGE_CONTRACT_INVALID", status: "FAILED" }
    : { status: "PASS" };
}
