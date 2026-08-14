import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

export const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const execFileAsync = promisify(execFile);

export const FOUNDATION_CHECK_CATALOG = Object.freeze([
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
]);

const launchOnlyChecks = new Set(["ancestry", "proxy"]);

const forbiddenEnvironmentKey = /^(?:(?:DATABASE_(?:DIRECT_|POOLED_)?URL|TEST_DATABASE_URL|(?:MEMBER|STAFF|SYSTEM|WORKER)_DATABASE_URL|WORKOS_.+|STRIPE_(?:SECRET|WEBHOOK).+|MUX_(?:TOKEN|SIGNING).+|RESEND_(?:API|SECRET).+|BLOB_(?:READ_WRITE|WRITE).+|HIGHLEVEL_.+)|.*(?:SECRET(?:_KEY)?|API_KEY|PRIVATE_KEY|WRITE_TOKEN))$/u;
const forbiddenUrl = /https?:\/\/(?:[^/]*\.)?(?:leadconnectorhq\.com|gohighlevel\.com)\/(?:api|v\d+|locations|contacts|oauth|sso|token)(?:[/?"'`]|$)/iu;
const forbiddenServerPackages = new Set([
  "@mux/mux-node",
  "@vercel/blob",
  "mongodb",
  "resend",
  "stripe",
]);
const highLevelPackage = /(?:^|[/@_-])(?:gohighlevel|leadconnector|highlevel)(?:$|[/_-])/iu;
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

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

export function isForbiddenServerPackage(specifier) {
  const name = packageNameFromSpecifier(specifier);
  return forbiddenServerPackages.has(name) || highLevelPackage.test(name);
}

async function loadPathAliases(repositoryRoot, files) {
  const aliases = [];
  for (const file of files.filter((candidate) => candidate.endsWith("tsconfig.json"))) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      const configDirectory = dirname(relative(repositoryRoot, file));
      for (const [pattern, targets] of Object.entries(parsed.compilerOptions?.paths ?? {})) {
        if (!Array.isArray(targets)) continue;
        for (const target of targets) {
          aliases.push({
            pattern,
            target: join(configDirectory, String(target)).split(sep).join("/"),
          });
        }
      }
    } catch {
      // Malformed TypeScript configuration is attributed by the compiler check.
    }
  }
  return aliases;
}

function resolveAlias(specifier, aliases, files) {
  for (const alias of aliases) {
    const wildcard = alias.pattern.indexOf("*");
    const prefix = wildcard < 0 ? alias.pattern : alias.pattern.slice(0, wildcard);
    const suffix = wildcard < 0 ? "" : alias.pattern.slice(wildcard + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const capture = specifier.slice(prefix.length, specifier.length - suffix.length || undefined);
    const base = alias.target.replace("*", capture).replace(/^\.\//u, "");
    const candidates = [base, ...[".ts", ".tsx", ".js", ".mjs", ".cjs"].map((extension) => `${base}${extension}`), ...["index.ts", "index.tsx", "index.js"].map((name) => `${base}/${name}`)];
    const resolvedPath = candidates.find((candidate) => files.has(candidate));
    if (resolvedPath !== undefined) return resolvedPath;
  }
  return undefined;
}

export async function inspectProductionDependencyGraph(repositoryRoot) {
  const files = await walk(repositoryRoot);
  const packages = new Set();
  const imports = [];
  const environmentKeys = new Set();
  const urls = new Set();
  const builtArtifacts = [];
  const lockfilePackages = new Set();
  const resolvedImports = [];
  const aliases = await loadPathAliases(repositoryRoot, files);
  const normalizedFiles = new Set(files.map((file) => normalized(repositoryRoot, file)));

  for (const file of files) {
    const path = normalized(repositoryRoot, file);
    if (path === "package-lock.json") {
      const lock = JSON.parse(await readFile(file, "utf8"));
      for (const lockPath of Object.keys(lock.packages ?? {})) {
        const name = packageNameFromLockPath(lockPath);
        if (name !== undefined && isForbiddenServerPackage(name)) {
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
      if (isForbiddenServerPackage(specifier)) imports.push({ path, specifier });
      const resolvedPath = resolveAlias(specifier, aliases, normalizedFiles);
      if (resolvedPath !== undefined) resolvedImports.push({ path, resolvedPath, specifier });
    }
    for (const key of environmentKeysIn(contents)) {
      if (productionWebPath && forbiddenEnvironmentKey.test(key)) {
        environmentKeys.add(key);
      }
    }
    for (const url of urlsIn(contents)) urls.add(url);
    if (
      built && (
        fileImports.some((specifier) => isForbiddenServerPackage(specifier))
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
    resolvedImports: resolvedImports.sort((left, right) =>
      left.path.localeCompare(right.path) || left.specifier.localeCompare(right.specifier)
    ),
    urls: [...urls].sort(),
  };
}

export function evaluateProviderReleaseSha(environment, provider) {
  const releaseSha = environment.RELEASE_SHA?.trim();
  if (!RELEASE_SHA_PATTERN.test(releaseSha ?? "")) {
    return { reason: "RELEASE_SHA_INVALID", status: "BLOCKED" };
  }
  const providerKey = provider === "railway"
    ? "RAILWAY_GIT_COMMIT_SHA"
    : provider === "vercel"
      ? "VERCEL_GIT_COMMIT_SHA"
      : provider === "github"
        ? "GITHUB_SHA"
        : undefined;
  if (providerKey === undefined) return { status: "PASS" };
  const providerSha = environment[providerKey]?.trim();
  if (!RELEASE_SHA_PATTERN.test(providerSha ?? "")) {
    return { reason: "PROVIDER_COMMIT_SHA_REQUIRED", status: "BLOCKED" };
  }
  if (providerSha !== releaseSha) {
    return { reason: "PROVIDER_COMMIT_SHA_MISMATCH", status: "BLOCKED" };
  }
  return { status: "PASS" };
}

export async function inspectRepositoryIdentity(repositoryRoot, expectedSha) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
  });
  const headSha = stdout.trim();
  if (!RELEASE_SHA_PATTERN.test(headSha) || headSha !== expectedSha) {
    return { headSha, reason: "RELEASE_SHA_HEAD_MISMATCH", status: "BLOCKED" };
  }
  const status = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repositoryRoot },
  );
  try {
    await execFileAsync("git", ["diff", "--check", "HEAD"], { cwd: repositoryRoot });
  } catch {
    return { headSha, reason: "REPOSITORY_DIFF_INVALID", status: "FAILED" };
  }
  if (status.stdout.trim() !== "") {
    return { headSha, reason: "REPOSITORY_DIRTY", status: "BLOCKED" };
  }
  return { headSha, status: "PASS" };
}

function parseTomlSections(contents) {
  const result = {};
  let section;
  for (const original of contents.split(/\r?\n/u)) {
    const line = original.replace(/\s+#.*$/u, "").trim();
    if (line === "" || line.startsWith("#") || line.startsWith('"$schema"')) continue;
    const sectionMatch = /^\[([A-Za-z]+)\]$/u.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      result[section] = {};
      continue;
    }
    const valueMatch = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.+)$/u.exec(line);
    if (!valueMatch || section === undefined) throw new Error("RAILWAY_CONFIG_INVALID");
    const raw = valueMatch[2].trim();
    let value;
    if (/^".*"$/u.test(raw)) value = JSON.parse(raw);
    else if (/^-?\d+(?:\.\d+)?$/u.test(raw)) value = Number(raw);
    else if (["true", "false"].includes(raw)) value = raw === "true";
    else throw new Error("RAILWAY_CONFIG_INVALID");
    result[section][valueMatch[1]] = value;
  }
  return result;
}

const railwayServiceContract = Object.freeze({
  api: { command: "/app/server.js", dockerfilePath: "apps/api/Dockerfile", restart: "ON_FAILURE" },
  cron: { command: "/app/cron.js", dockerfilePath: "apps/worker/Dockerfile.cron", restart: "NEVER" },
  migrate: { command: "/app/migrate.js", dockerfilePath: "apps/api/Dockerfile.migrate", restart: "NEVER" },
  worker: { command: "/app/runner.js", dockerfilePath: "apps/worker/Dockerfile", restart: "ON_FAILURE" },
});
const railwayBuildKeys = new Set(["builder", "watchPatterns", "buildCommand", "dockerfilePath", "nixpacksConfigPath", "nixpacksPlan", "nixpacksVersion", "railpackVersion"]);
const railwayDeployKeys = new Set(["startCommand", "preDeployCommand", "numReplicas", "healthcheckPath", "healthcheckTimeout", "sleepApplication", "runtime", "registryCredentials", "restartPolicyType", "restartPolicyMaxRetries", "cronSchedule", "region", "multiRegionConfig", "limitOverride", "requiredMountPath", "overlapSeconds", "drainingSeconds", "ipv6EgressEnabled"]);

export async function validateRailwayServiceConfigs(repositoryRoot, services = Object.keys(railwayServiceContract)) {
  const result = {};
  try {
    for (const service of services) {
      const contract = railwayServiceContract[service];
      if (contract === undefined) throw new Error("unknown service");
      const config = parseTomlSections(await readFile(join(repositoryRoot, `infra/railway/${service}.toml`), "utf8"));
      if (
        config.build?.builder !== "DOCKERFILE"
        || config.build?.dockerfilePath !== contract.dockerfilePath
        || config.deploy?.startCommand !== `/usr/local/bin/node ${contract.command}`
        || config.deploy?.restartPolicyType !== contract.restart
        || Object.keys(config.build ?? {}).some((key) => !railwayBuildKeys.has(key))
        || Object.keys(config.deploy ?? {}).some((key) => !railwayDeployKeys.has(key))
        || (service === "cron" && typeof config.deploy?.cronSchedule !== "string")
      ) throw new Error("contract");
      const dockerfile = await readFile(join(repositoryRoot, contract.dockerfilePath), "utf8");
      const commands = [...dockerfile.matchAll(/^CMD\s+\[([^\]]+)\]\s*$/gmu)];
      const finalCommand = commands.at(-1)?.[1]
        ?.split(",")
        .map((part) => JSON.parse(part.trim()));
      if (JSON.stringify(finalCommand) !== JSON.stringify([contract.command])) throw new Error("command");
      result[service] = { command: contract.command, dockerfilePath: contract.dockerfilePath };
    }
    return result;
  } catch {
    throw new Error("RAILWAY_CONFIG_INVALID");
  }
}

function stateFor(checks) {
  const statuses = Object.values(checks).map((check) => check.status);
  if (statuses.includes("FAILED")) return "FAILED";
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  return "PASS";
}

export function evaluateFoundationGate(checks) {
  const engineering = Object.fromEntries(
    Object.entries(checks).filter(([name]) => !launchOnlyChecks.has(name)),
  );
  const engineeringGate = stateFor(engineering);
  const launchGate = engineeringGate === "FAILED"
    ? "FAILED"
    : stateFor(checks);
  return { engineeringGate, launchGate };
}

export function foundationExitCode(report) {
  return report.engineeringGate === "PASS" ? 0 : 1;
}

function validCheck(check) {
  return check !== null
    && typeof check === "object"
    && ["PASS", "FAILED", "BLOCKED"].includes(check.status)
    && typeof check.command === "string"
    && check.command.length > 0
    && Number.isInteger(check.durationMs)
    && check.durationMs >= 0
    && /^[0-9a-f]{64}$/u.test(check.artifactHash)
    && (check.status === "PASS" ? check.reason === undefined : typeof check.reason === "string");
}

export function validateFoundationReport(report) {
  const names = Object.keys(report?.checks ?? {}).sort();
  const expected = [...FOUNDATION_CHECK_CATALOG].sort();
  const state = evaluateFoundationGate(report?.checks ?? {});
  if (
    report?.version !== 1
    || !["ci", "local"].includes(report.environment)
    || !RELEASE_SHA_PATTERN.test(report.releaseSha ?? "")
    || Number.isNaN(Date.parse(report.createdAt ?? ""))
    || JSON.stringify(names) !== JSON.stringify(expected)
    || !Object.values(report.checks).every(validCheck)
    || report.engineeringGate !== state.engineeringGate
    || report.launchGate !== state.launchGate
  ) throw new Error("FOUNDATION_REPORT_INVALID");
  return report;
}

export function validateExternalEvidence(evidence, options) {
  const createdAt = Date.parse(evidence?.createdAt ?? "");
  const age = options.now.getTime() - createdAt;
  const servicesValid = options.type !== "images"
    || JSON.stringify([...(evidence?.services ?? [])].sort())
      === JSON.stringify(["api", "cron", "migrate", "worker"]);
  const proxyValid = options.type !== "proxy" || (
    evidence?.environment === "production"
    && evidence?.host === options.host
    && evidence?.upstreamOrigin === options.upstreamOrigin
    && evidence?.statusCodePreserved === true
    && /^[0-9a-f]{64}$/u.test(evidence?.bodyHash ?? "")
    && evidence?.multipleSetCookiePreserved === true
    && evidence?.locationPreserved === true
    && evidence?.cookiePreserved === true
    && evidence?.authorizationPreserved === true
    && evidence?.workerReady?.status === "ready"
    && evidence?.workerReady?.releaseSha === options.releaseSha
  );
  const valid = evidence?.version === 1
    && evidence?.type === options.type
    && evidence?.status === "PASS"
    && evidence?.releaseSha === options.releaseSha
    && /^[0-9a-f]{64}$/u.test(evidence?.artifactHash ?? "")
    && Number.isFinite(createdAt)
    && age >= 0
    && age <= 24 * 60 * 60 * 1_000
    && servicesValid
    && proxyValid;
  return valid
    ? { status: "PASS" }
    : { reason: "EVIDENCE_INVALID", status: "FAILED" };
}

const requiredContracts = Object.freeze([
  [".github/workflows/ci.yml", ["npm run gate:foundation", "cron-image.cdx.json", "worker-ready.json", "assert-secret-free-log.mjs", "if-no-files-found: error"]],
  ["apps/api/Dockerfile.migrate", ["ARG RAILWAY_GIT_COMMIT_SHA", "CMD [\"/app/migrate.js\"]"]],
  ["apps/api/src/auth/auth.integration.test.ts", ["separate member and staff authentication"]],
  ["apps/api/src/auth/session-crypto.test.ts", ["round-trips one bounded token bundle"]],
  ["apps/web/src/lib/api/client.test.ts", ["same-origin staff client"]],
  ["apps/web/src/proxy.ts", ["canonicalRedirectTarget", "NextResponse.redirect(target, 308)"]],
  ["apps/worker/Dockerfile.cron", ["ARG RAILWAY_GIT_COMMIT_SHA", "CMD [\"/app/cron.js\"]"]],
  ["apps/worker/src/jobs.integration.test.ts", ["claims each due job exactly once across two workers"]],
  ["infra/scripts/gate-foundation.mjs", ["FOUNDATION_CHECK_CATALOG", "test:coverage", "FOUNDATION_IMAGE_EVIDENCE_PATH"]],
  ["packages/database/src/entitlements.integration.test.ts", ["serializes four teammate invitations"]],
  ["packages/database/src/migrations.test.ts", ["rejects a %s published migration inventory"]],
  ["packages/database/src/migrations.ts", ["PUBLISHED_MIGRATIONS", "assertPublishedMigrationInventory"]],
  ["packages/database/src/readiness.ts", ["REQUIRED_RUNTIME_OBJECTS", "migration_hashes", "required_objects"]],
  ["packages/database/src/rls.integration.test.ts", ["creates exactly four inert capability roles"]],
  ["packages/domain/src/entitlements/evaluate.property.test.ts", ["permutation invariant"]],
  ["packages/testing/src/foundation-gate-policy.test.ts", ["rejects a tracked or untracked worktree"]],
]);

export async function validateRequiredContracts(repositoryRoot) {
  try {
    await Promise.all(requiredContracts.map(async ([path, identifiers]) => {
      const contents = await readFile(join(repositoryRoot, path), "utf8");
      if (identifiers.some((identifier) => !contents.includes(identifier))) {
        throw new Error("identifier");
      }
    }));
  } catch {
    throw new Error("REQUIRED_CONTRACT_MISSING");
  }
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
