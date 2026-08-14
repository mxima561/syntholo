import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";

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
const globallyForbiddenPackages = new Set([
  "mongodb",
]);
const webForbiddenServerPackages = new Set([
  "@clerk/backend",
  "@clerk/nextjs",
  "@mux/mux-node",
  "@vercel/blob",
  "@workos-inc/authkit-nextjs",
  "@workos-inc/node",
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
    const path = join(current, entry.name);
    const relativePath = normalized(root, path);
    if (entry.name === ".git") continue;
    if (
      entry.name === "node_modules"
      && !relativePath.startsWith("apps/web/.next/standalone/")
    ) continue;
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
  return globallyForbiddenPackages.has(name)
    || webForbiddenServerPackages.has(name)
    || highLevelPackage.test(name);
}

function isForbiddenPackageForService(specifier, service) {
  const name = packageNameFromSpecifier(specifier);
  return globallyForbiddenPackages.has(name)
    || highLevelPackage.test(name)
    || (service === "web" && webForbiddenServerPackages.has(name));
}

function tsconfigExtendsCandidates(configPath, specifier) {
  if (!specifier.startsWith(".")) return [];
  const base = join(dirname(configPath), specifier).split(sep).join("/");
  return [base, `${base}.json`, `${base}/tsconfig.json`];
}

async function loadPathAliases(repositoryRoot, files) {
  const fileByPath = new Map(files.map((file) => [normalized(repositoryRoot, file), file]));
  const configPaths = [...fileByPath.keys()].filter((path) =>
    /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/u.test(path)
  );
  const cache = new Map();
  const loadConfig = async (configPath, loading = new Set()) => {
    if (cache.has(configPath)) return cache.get(configPath);
    if (loading.has(configPath)) return [];
    const file = fileByPath.get(configPath);
    if (file === undefined) return [];
    const nextLoading = new Set(loading).add(configPath);
    try {
      const result = ts.parseConfigFileTextToJson(configPath, await readFile(file, "utf8"));
      if (result.error !== undefined) return [];
      const parsed = result.config ?? {};
      const extendedPath = typeof parsed.extends === "string"
        ? tsconfigExtendsCandidates(configPath, parsed.extends)
          .find((candidate) => fileByPath.has(candidate))
        : undefined;
      const inherited = extendedPath === undefined
        ? []
        : await loadConfig(extendedPath, nextLoading);
      const paths = parsed.compilerOptions?.paths;
      if (paths === undefined || paths === null || typeof paths !== "object") {
        cache.set(configPath, inherited);
        return inherited;
      }
      const configDirectory = dirname(configPath);
      const baseDirectory = typeof parsed.compilerOptions?.baseUrl === "string"
        ? join(configDirectory, parsed.compilerOptions.baseUrl).split(sep).join("/")
        : configDirectory;
      const own = [];
      for (const [pattern, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets)) continue;
        for (const target of targets) {
          own.push({
            pattern,
            target: join(baseDirectory, String(target)).split(sep).join("/"),
          });
        }
      }
      cache.set(configPath, own);
      return own;
    } catch {
      return [];
    }
  };
  const aliases = [];
  for (const configPath of configPaths) {
    const directory = dirname(configPath);
    for (const alias of await loadConfig(configPath)) aliases.push({ directory, ...alias });
  }
  return aliases;
}

function resolutionCandidates(base) {
  const candidates = [base];
  if (/\.[cm]?js$/u.test(base)) {
    const withoutJavaScript = base.replace(/\.[cm]?js$/u, "");
    candidates.push(...[".ts", ".tsx", ".mts", ".cts"].map((extension) => `${withoutJavaScript}${extension}`));
  } else {
    candidates.push(...[".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"].map((extension) => `${base}${extension}`));
  }
  candidates.push(...["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"].map((name) => `${base}/${name}`));
  return [...new Set(candidates)];
}

function resolveAlias(specifier, importer, aliases, files) {
  const applicable = aliases
    .filter(({ directory }) => directory === "." || importer.startsWith(`${directory}/`))
    .sort((left, right) => right.directory.length - left.directory.length);
  for (const alias of applicable) {
    const wildcard = alias.pattern.indexOf("*");
    const prefix = wildcard < 0 ? alias.pattern : alias.pattern.slice(0, wildcard);
    const suffix = wildcard < 0 ? "" : alias.pattern.slice(wildcard + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const capture = specifier.slice(prefix.length, specifier.length - suffix.length || undefined);
    const base = alias.target.replace("*", capture).replace(/^\.\//u, "");
    const resolvedPath = resolutionCandidates(base).find((candidate) => files.has(candidate));
    if (resolvedPath !== undefined) return resolvedPath;
  }
  return undefined;
}

function exportTarget(manifest, specifier) {
  const name = manifest.name;
  if (typeof name !== "string") return undefined;
  const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
  const exported = typeof manifest.exports === "string"
    ? (subpath === "." ? manifest.exports : undefined)
    : manifest.exports?.[subpath];
  if (typeof exported === "string") return exported;
  if (exported !== null && typeof exported === "object") {
    return exported.import ?? exported.default ?? exported.node;
  }
  return subpath === "." && typeof manifest.main === "string" ? manifest.main : undefined;
}

function resolveLocalImport(specifier, importer, aliases, files, workspaceManifests) {
  if (specifier.startsWith(".")) {
    return resolutionCandidates(join(dirname(importer), specifier).split(sep).join("/"))
      .find((candidate) => files.has(candidate));
  }
  const aliased = resolveAlias(specifier, importer, aliases, files);
  if (aliased !== undefined) return aliased;
  const manifest = workspaceManifests.get(packageNameFromSpecifier(specifier));
  if (manifest === undefined) return undefined;
  const target = exportTarget(manifest.value, specifier);
  if (typeof target !== "string") return undefined;
  const base = join(manifest.directory, target).split(sep).join("/");
  return resolutionCandidates(base).find((candidate) => files.has(candidate));
}

function productionEntries(files) {
  const entries = [];
  const fixed = [
    ["apps/api/src/server.ts", "api"],
    ["apps/worker/src/runner.ts", "worker"],
    ["apps/worker/src/cron.ts", "cron"],
    ["packages/database/src/migrate.ts", "migrate"],
    ["apps/web/next.config.ts", "web"],
    ["apps/web/src/proxy.ts", "web"],
    ["apps/web/src/instrumentation.ts", "web"],
    ["apps/web/src/middleware.ts", "web"],
  ];
  for (const [path, service] of fixed) {
    if (files.has(path)) entries.push({ path, service });
  }
  for (const path of files) {
    if (/^apps\/web\/src\/app\/(?:.+\/)?(?:default|error|global-error|layout|loading|not-found|page|route|template)\.[cm]?[jt]sx?$/u.test(path)) {
      entries.push({ path, service: "web" });
    }
    const builtMatch = /^(apps\/(api|web|worker)|packages\/[^/]+)\/(?:dist|\.next\/(?:server|standalone|static))(?:\/|$)/u.exec(path);
    const nextTrace = /^apps\/web\/\.next\/(?:server|standalone)\/.+\.nft\.json$/u.test(path);
    const standalonePackage = standalonePackageName(path);
    const forbiddenStandaloneFile = standalonePackage !== undefined
      && isForbiddenPackageForService(standalonePackage, "web")
      && (sourceExtension.test(path) || path.endsWith("/package.json"));
    if (
      nextTrace
      || forbiddenStandaloneFile
      || (builtMatch && sourceExtension.test(path) && !path.includes("/node_modules/"))
    ) {
      const service = builtMatch[2] === "web"
        ? "web"
        : path.endsWith("cron.js")
          ? "cron"
          : builtMatch[2] === "worker"
            ? "worker"
            : builtMatch[2] === "api"
              ? "api"
              : "package";
      entries.push({ path, service });
    }
  }
  return entries;
}

function standalonePackageName(path) {
  const match = /^apps\/web\/\.next\/standalone\/(?:.+\/)?node_modules\/(.+)$/u.exec(path);
  if (match === null) return undefined;
  const segments = match[1].split("/");
  if (segments[0]?.startsWith("@")) {
    return segments.length >= 2 ? segments.slice(0, 2).join("/") : undefined;
  }
  return segments[0];
}

function normalizedMetadataTarget(metadataPath, target) {
  const resolved = join(dirname(metadataPath), target).split(sep).join("/");
  return resolved === ".." || resolved.startsWith("../") ? undefined : resolved;
}

function addUnique(items, keys, item) {
  const key = JSON.stringify(item);
  if (!keys.has(key)) {
    keys.add(key);
    items.push(item);
  }
}

function productionDependencyNames(value, includePeers = true) {
  return [...new Set([
    ...Object.keys(value?.dependencies ?? {}),
    ...Object.keys(value?.optionalDependencies ?? {}),
    ...(includePeers ? Object.keys(value?.peerDependencies ?? {}) : []),
  ])];
}

function lockDependencyCandidates(importerPath, dependencyName) {
  const candidates = [];
  let current = importerPath;
  while (true) {
    if (current === "") {
      candidates.push(`node_modules/${dependencyName}`);
      break;
    }
    if (!current.endsWith("/node_modules") && current !== "node_modules") {
      candidates.push(`${current}/node_modules/${dependencyName}`);
    }
    const parent = dirname(current).split(sep).join("/");
    current = parent === "." ? "" : parent;
  }
  return [...new Set(candidates.filter((candidate) => candidate !== importerPath))];
}

function dereferenceLockPath(path, lockNodes) {
  const value = lockNodes.get(path);
  if (value?.link !== true || typeof value.resolved !== "string") return path;
  const resolved = value.resolved.replace(/^\.\//u, "").replace(/\/$/u, "");
  return lockNodes.has(resolved) ? resolved : path;
}

function resolveLockedDependency(importerPath, dependencyName, lockNodes, workspaceManifests) {
  const candidate = lockDependencyCandidates(importerPath, dependencyName)
    .find((path) => lockNodes.has(path));
  if (candidate !== undefined) return dereferenceLockPath(candidate, lockNodes);
  const workspacePath = workspaceManifests.get(dependencyName)?.directory;
  return workspacePath !== undefined && lockNodes.has(workspacePath) ? workspacePath : undefined;
}

export async function inspectProductionDependencyGraph(repositoryRoot) {
  const files = await walk(repositoryRoot);
  const normalizedFiles = new Set(files.map((file) => normalized(repositoryRoot, file)));
  const fileByPath = new Map(files.map((file) => [normalized(repositoryRoot, file), file]));
  const packages = new Set();
  const imports = [];
  const importKeys = new Set();
  const environmentKeys = new Set();
  const urls = new Set();
  const builtArtifacts = new Set();
  const lockfilePackages = new Set();
  const resolvedImports = [];
  const resolvedImportKeys = new Set();
  const policyViolations = [];
  const policyViolationKeys = new Set();
  const aliases = await loadPathAliases(repositoryRoot, files);
  const workspaceManifests = new Map();
  const manifestsByDirectory = new Map();
  for (const [path, file] of fileByPath) {
    if (!/^(?:apps|packages)\/[^/]+\/package\.json$/u.test(path)) continue;
    const value = JSON.parse(await readFile(file, "utf8"));
    const manifest = { directory: dirname(path), path, value };
    manifestsByDirectory.set(manifest.directory, manifest);
    if (typeof value.name === "string") workspaceManifests.set(value.name, manifest);
  }
  const lockPath = fileByPath.get("package-lock.json");
  const lock = lockPath === undefined
    ? { packages: {} }
    : JSON.parse(await readFile(lockPath, "utf8"));
  const lockNodes = new Map(Object.entries(lock.packages ?? {}));

  const manifestServices = [
    ["", "root"],
    ["apps/api", "api"],
    ["apps/web", "web"],
    ["apps/worker", "worker"],
    ["packages/database", "migrate"],
  ];
  for (const [directory, service] of manifestServices) {
    const root = directory === ""
      ? fileByPath.has("package.json")
        ? {
            directory: "",
            path: "package.json",
            value: JSON.parse(await readFile(fileByPath.get("package.json"), "utf8")),
          }
        : undefined
      : manifestsByDirectory.get(directory);
    if (root === undefined) continue;
    const lockRoot = lockNodes.get(directory);
    const queue = [...new Set([
      ...productionDependencyNames(root.value, false),
      ...productionDependencyNames(lockRoot),
    ])].map((name) => ({ importerPath: directory, name }));
    const seen = new Set();
    while (queue.length > 0) {
      const { importerPath, name } = queue.shift();
      const resolvedPath = resolveLockedDependency(
        importerPath,
        name,
        lockNodes,
        workspaceManifests,
      );
      const visitKey = resolvedPath ?? `${importerPath}:${name}:missing`;
      if (seen.has(visitKey)) continue;
      seen.add(visitKey);
      if (isForbiddenPackageForService(name, service)) {
        packages.add(name);
        addUnique(policyViolations, policyViolationKeys, {
          kind: "package", path: root.path, service, value: name,
        });
        if (resolvedPath !== undefined) {
          lockfilePackages.add(name);
          addUnique(policyViolations, policyViolationKeys, {
            kind: "lockfile", path: "package-lock.json", service, value: name,
          });
        }
      }
      if (resolvedPath === undefined) continue;
      const dependencyNode = lockNodes.get(resolvedPath);
      const workspace = workspaceManifests.get(name);
      const dependencies = new Set([
        ...productionDependencyNames(dependencyNode),
        ...(workspace?.directory === resolvedPath
          ? productionDependencyNames(workspace.value, false)
          : []),
      ]);
      queue.push(...[...dependencies].map((dependency) => ({
        importerPath: resolvedPath,
        name: dependency,
      })));
    }
  }

  const queue = productionEntries(normalizedFiles);
  const visited = new Set();
  while (queue.length > 0) {
    const { path, service } = queue.shift();
    const visitKey = `${service}:${path}`;
    if (visited.has(visitKey) || excludedSource.test(path)) continue;
    visited.add(visitKey);
    const file = fileByPath.get(path);
    if (file === undefined) continue;
    const contents = await readFile(file, "utf8").catch(() => "");
    const built = /\/(?:dist|\.next\/(?:server|standalone|static))(?:\/|$)/u.test(path);
    let builtViolation = false;
    const standalonePackage = standalonePackageName(path);
    if (
      standalonePackage !== undefined
      && isForbiddenPackageForService(standalonePackage, service)
    ) {
      packages.add(standalonePackage);
      addUnique(policyViolations, policyViolationKeys, {
        kind: "built", path, service, value: standalonePackage,
      });
      builtViolation = true;
    }
    if (path.endsWith(".nft.json")) {
      try {
        const trace = JSON.parse(contents);
        for (const specifier of Array.isArray(trace.files) ? trace.files : []) {
          if (typeof specifier !== "string") continue;
          const resolvedPath = normalizedMetadataTarget(path, specifier);
          if (resolvedPath === undefined) continue;
          addUnique(resolvedImports, resolvedImportKeys, {
            path, resolvedPath, service, specifier,
          });
          const tracedPackage = packageNameFromLockPath(resolvedPath);
          if (
            tracedPackage !== undefined
            && isForbiddenPackageForService(tracedPackage, service)
          ) {
            packages.add(tracedPackage);
            addUnique(policyViolations, policyViolationKeys, {
              kind: "built", path: resolvedPath, service, value: tracedPackage,
            });
            builtViolation = true;
          }
          if (normalizedFiles.has(resolvedPath)) queue.push({ path: resolvedPath, service });
        }
      } catch {
        // Malformed build metadata is attributed by the artifact/build check.
      }
    }
    for (const specifier of importsIn(contents)) {
      const resolvedPath = resolveLocalImport(
        specifier,
        path,
        aliases,
        normalizedFiles,
        workspaceManifests,
      );
      if (resolvedPath !== undefined) {
        addUnique(resolvedImports, resolvedImportKeys, {
          path, resolvedPath, service, specifier,
        });
        queue.push({ path: resolvedPath, service });
      } else if (isForbiddenPackageForService(specifier, service)) {
        const violation = { path, service, specifier };
        addUnique(imports, importKeys, violation);
        addUnique(policyViolations, policyViolationKeys, {
          kind: built ? "built" : "import",
          path,
          service,
          value: packageNameFromSpecifier(specifier),
        });
        builtViolation ||= built;
      }
    }
    if (built) {
      const candidates = new Set([
        ...globallyForbiddenPackages,
        ...(service === "web" ? webForbiddenServerPackages : []),
      ]);
      for (const name of candidates) {
        const marker = `node_modules/${name}`;
        if (contents.includes(marker)) {
          addUnique(policyViolations, policyViolationKeys, {
            kind: "built", path, service, value: name,
          });
          builtViolation = true;
        }
      }
      if (highLevelPackage.test(contents)) {
        addUnique(policyViolations, policyViolationKeys, {
          kind: "built", path, service, value: "highlevel",
        });
        builtViolation = true;
      }
    }
    for (const key of environmentKeysIn(contents)) {
      if (service === "web" && forbiddenEnvironmentKey.test(key)) {
        environmentKeys.add(key);
        addUnique(policyViolations, policyViolationKeys, {
          kind: "environment", path, service, value: key,
        });
        builtViolation ||= built;
      }
    }
    for (const url of urlsIn(contents)) {
      urls.add(url);
      addUnique(policyViolations, policyViolationKeys, {
        kind: "url", path, service, value: url,
      });
      builtViolation ||= built;
    }
    if (builtViolation) builtArtifacts.add(path);
  }

  return {
    builtArtifacts: [...builtArtifacts].sort(),
    environmentKeys: [...environmentKeys].sort(),
    imports: imports.sort((left, right) =>
      left.service.localeCompare(right.service)
        || left.path.localeCompare(right.path)
        || left.specifier.localeCompare(right.specifier)
    ),
    lockfilePackages: [...lockfilePackages].sort(),
    packages: [...packages].sort(),
    policyViolations: policyViolations.sort((left, right) =>
      left.service.localeCompare(right.service)
        || left.kind.localeCompare(right.kind)
        || left.path.localeCompare(right.path)
        || left.value.localeCompare(right.value)
    ),
    resolvedImports: resolvedImports.sort((left, right) =>
      left.service.localeCompare(right.service)
        || left.path.localeCompare(right.path)
        || left.specifier.localeCompare(right.specifier)
    ),
    urls: [...urls].sort(),
  };
}

export function productionDependencyPolicyPass(graph) {
  return Array.isArray(graph?.policyViolations) && graph.policyViolations.length === 0;
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
  const imagesValid = options.type !== "images" || (
    evidence?.environment === "ci"
    && JSON.stringify([...(evidence?.services ?? [])].sort())
      === JSON.stringify(["api", "cron", "migrate", "worker"])
  );
  const workerReadyAt = Date.parse(evidence?.workerReady?.createdAt ?? "");
  const workerReadyAge = options.now.getTime() - workerReadyAt;
  const workerReadyValid = evidence?.workerReady !== null
    && typeof evidence?.workerReady === "object"
    && !Array.isArray(evidence.workerReady)
    && JSON.stringify(Object.keys(evidence.workerReady).sort())
      === JSON.stringify(["createdAt", "releaseSha", "service", "status"])
    && evidence.workerReady.service === "worker"
    && evidence.workerReady.status === "ready"
    && evidence.workerReady.releaseSha === options.releaseSha
    && Number.isFinite(workerReadyAt)
    && workerReadyAge >= 0
    && workerReadyAge <= 24 * 60 * 60 * 1_000
    && workerReadyAt <= createdAt;
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
    && workerReadyValid
  );
  const valid = evidence?.version === 1
    && evidence?.type === options.type
    && evidence?.status === "PASS"
    && evidence?.releaseSha === options.releaseSha
    && /^[0-9a-f]{64}$/u.test(evidence?.artifactHash ?? "")
    && Number.isFinite(createdAt)
    && age >= 0
    && age <= 24 * 60 * 60 * 1_000
    && imagesValid
    && proxyValid;
  return valid
    ? { status: "PASS" }
    : { reason: "EVIDENCE_INVALID", status: "FAILED" };
}

const requiredCheckContracts = Object.freeze({
  ancestry: [{ path: "packages/testing/src/foundation-gate-policy.test.ts", titles: ["requires the exact named check catalog and valid evidence metadata"], syntax: { "requires the exact named check catalog and valid evidence metadata": ["FOUNDATION_CHECK_CATALOG", "validateFoundationReport"] } }],
  artifacts: [
    { path: "apps/web/src/lib/config/build.test.ts", titles: ["returns the exact immutable release for Next build metadata"], syntax: { "returns the exact immutable release for Next build metadata": ["parseWebBuildIdentity", "RELEASE_SHA"] } },
    { path: "apps/worker/src/runner.test.ts", titles: ["produces executable %s and fails startup closed"], syntax: { "produces executable %s and fails startup closed": ["access", "execFileAsync"] } },
  ],
  browser: [{ path: "apps/web/tests/e2e/proxy.spec.ts", titles: ["same-origin proxy preserves status, body, cookies, location, and auth headers"], syntax: { "same-origin proxy preserves status, body, cookies, location, and auth headers": ["fetch", "authorization", "set-cookie"] } }],
  dependencyPolicy: [{ path: "packages/testing/src/foundation-gate-policy.test.ts", titles: ["fails web production reachability through static, dynamic, alias, lockfile, and built server-adapter edges"], syntax: { "fails web production reachability through static, dynamic, alias, lockfile, and built server-adapter edges": ["inspectProductionDependencyGraph", "productionDependencyPolicyPass", "policyViolations"] } }],
  entitlements: [
    { path: "packages/database/src/entitlements.integration.test.ts", titles: ["serializes four teammate invitations behind the occupied owner slot"], syntax: { "serializes four teammate invitations behind the occupied owner slot": ["reservePendingSeat", "waitForAdvisoryKeyWaiters", "SEAT_CAPACITY_REACHED"] } },
    { path: "packages/domain/src/entitlements/evaluate.property.test.ts", titles: ["is permutation invariant across grants, holds, and seats including paid bundles"], syntax: { "is permutation invariant across grants, holds, and seats including paid bundles": ["property", "evaluateEntitlements", "permute"] } },
  ],
  identitySeparation: [
    { path: "apps/api/src/auth/auth.integration.test.ts", titles: ["maps one Clerk bearer through the active database identity"], syntax: { "maps one Clerk bearer through the active database identity": ["inject", "authorization", "authenticateRequest"] } },
    { path: "apps/api/src/auth/session-crypto.test.ts", titles: ["round-trips one bounded token bundle with versioned AAD"], syntax: { "round-trips one bounded token bundle with versioned AAD": ["createStaffSessionCrypto", "encryptTokenBundle", "decryptTokenBundle"] } },
  ],
  images: [{ path: "packages/testing/src/foundation-gate-policy.test.ts", titles: ["accepts an exact non-root SHA-bound runtime image"], syntax: { "accepts an exact non-root SHA-bound runtime image": ["validateImageMetadata", "org.opencontainers.image.revision"] } }],
  jobs: [{ path: "apps/worker/src/jobs.integration.test.ts", titles: ["claims each due job exactly once across two workers"], syntax: { "claims each due job exactly once across two workers": ["claim", "claimGeneration"] } }],
  migrations: [{ path: "packages/database/src/migrations.test.ts", titles: ["accepts only the exact ordered published journal and file hashes"], syntax: { "accepts only the exact ordered published journal and file hashes": ["assertPublishedMigrationInventory", "0007_runtime_contract"] } }],
  proxy: [{ path: "packages/testing/src/foundation-gate-policy.test.ts", titles: ["requires deployed proxy semantics and SHA-bound worker readiness"], syntax: { "requires deployed proxy semantics and SHA-bound worker readiness": ["validateExternalEvidence", "workerReady", "service"] } }],
  releaseSha: [{ path: "packages/testing/src/foundation-gate-policy.test.ts", titles: ["requires and matches the %s checkout SHA"], syntax: { "requires and matches the %s checkout SHA": ["evaluateProviderReleaseSha", "PROVIDER_COMMIT_SHA_MISMATCH"] } }],
  repository: [{ path: "packages/testing/src/foundation-gate-policy.test.ts", titles: ["rejects a tracked or untracked worktree before certification"], syntax: { "rejects a tracked or untracked worktree before certification": ["inspectRepositoryIdentity", "REPOSITORY_DIRTY"] } }],
  rls: [{ path: "packages/database/src/rls.integration.test.ts", titles: ["creates exactly four inert capability roles with no password, settings, or outbound membership"], syntax: { "creates exactly four inert capability roles with no password, settings, or outbound membership": ["rolbypassrls", "capabilityRoles"] } }],
  workspaces: [{ path: "packages/testing/src/foundation-gate-policy.test.ts", titles: ["requires the exact named check catalog and valid evidence metadata"], syntax: { "requires the exact named check catalog and valid evidence metadata": ["FOUNDATION_CHECK_CATALOG", "validateFoundationReport"] } }],
});

function registrationCallKind(expression, activeNames, skippedNames) {
  if (ts.isIdentifier(expression)) {
    if (activeNames.has(expression.text)) return "active";
    if (skippedNames.has(expression.text)) return "skipped";
    return undefined;
  }
  if (ts.isCallExpression(expression)) {
    return registrationCallKind(expression.expression, activeNames, skippedNames);
  }
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  const parent = registrationCallKind(expression.expression, activeNames, skippedNames);
  if (parent === undefined) return undefined;
  if (["skip", "todo"].includes(expression.name.text)) return "skipped";
  if (["runIf", "skipIf"].includes(expression.name.text)) return "conditional";
  return parent;
}

function testCallKind(expression) {
  return registrationCallKind(
    expression,
    new Set(["it", "test"]),
    new Set(["xit", "xtest"]),
  );
}

function suiteCallKind(expression) {
  return registrationCallKind(
    expression,
    new Set(["context", "describe", "suite"]),
    new Set(["xcontext", "xdescribe", "xsuite"]),
  );
}

function functionHandler(call) {
  return call.arguments.find((argument) =>
    ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
  );
}

const nodeAssertMethods = new Set([
  "deepEqual",
  "deepStrictEqual",
  "doesNotMatch",
  "doesNotReject",
  "doesNotThrow",
  "equal",
  "fail",
  "ifError",
  "match",
  "notDeepEqual",
  "notDeepStrictEqual",
  "notEqual",
  "notStrictEqual",
  "ok",
  "partialDeepStrictEqual",
  "rejects",
  "strictEqual",
  "throws",
]);

function nodeAssertBindings(source) {
  const functions = new Set();
  const namespaces = new Set();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !["node:assert", "node:assert/strict"].includes(statement.moduleSpecifier.text)
      || statement.importClause?.isTypeOnly === true
    ) continue;
    const importClause = statement.importClause;
    if (importClause?.name !== undefined) namespaces.add(importClause.name.text);
    const bindings = importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === "strict") namespaces.add(element.name.text);
      if (nodeAssertMethods.has(imported)) functions.add(element.name.text);
    }
  }
  return { functions, namespaces };
}

function isExpectMatcherCall(call, shadowedBindings) {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  let subject = call.expression.expression;
  while (
    ts.isPropertyAccessExpression(subject)
    && ["not", "rejects", "resolves"].includes(subject.name.text)
  ) {
    subject = subject.expression;
  }
  return ts.isCallExpression(subject)
    && ts.isIdentifier(subject.expression)
    && subject.expression.text === "expect"
    && !shadowedBindings.has("expect");
}

function isNodeAssertCall(call, bindings, shadowedBindings) {
  if (ts.isIdentifier(call.expression)) {
    return !shadowedBindings.has(call.expression.text)
      && (
        bindings.functions.has(call.expression.text)
        || bindings.namespaces.has(call.expression.text)
      );
  }
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const receiver = call.expression.expression;
  if (
    ts.isIdentifier(receiver)
    && !shadowedBindings.has(receiver.text)
    && bindings.namespaces.has(receiver.text)
    && nodeAssertMethods.has(call.expression.name.text)
  ) return true;
  return ts.isPropertyAccessExpression(receiver)
    && receiver.name.text === "strict"
    && ts.isIdentifier(receiver.expression)
    && !shadowedBindings.has(receiver.expression.text)
    && bindings.namespaces.has(receiver.expression.text)
    && nodeAssertMethods.has(call.expression.name.text);
}

function isAssertionCall(call, assertBindings, shadowedBindings) {
  if (
    isExpectMatcherCall(call, shadowedBindings)
    || isNodeAssertCall(call, assertBindings, shadowedBindings)
  ) return true;
  return ts.isPropertyAccessExpression(call.expression)
    && ts.isIdentifier(call.expression.expression)
    && call.expression.expression.text === "fc"
    && !shadowedBindings.has("fc")
    && call.expression.name.text === "assert";
}

function addBindingNames(name, bindings) {
  if (ts.isIdentifier(name)) {
    bindings.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) addBindingNames(element.name, bindings);
  }
}

function handlerLocalBindings(handler) {
  const bindings = new Set();
  if (ts.isFunctionExpression(handler) && handler.name !== undefined) {
    bindings.add(handler.name.text);
  }
  for (const parameter of handler.parameters) addBindingNames(parameter.name, bindings);
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node)) {
      if (node.name !== undefined) bindings.add(node.name.text);
      return;
    }
    if (ts.isFunctionLike(node)) return;
    if (
      ts.isClassDeclaration(node)
      || ts.isEnumDeclaration(node)
      || ts.isModuleDeclaration(node)
    ) {
      if (node.name !== undefined) bindings.add(node.name.text);
      return;
    }
    if (ts.isVariableDeclaration(node)) addBindingNames(node.name, bindings);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(handler.body, visit);
  return bindings;
}

function testHandlerEvidence(handler, assertBindings) {
  const evidenceTokens = new Set();
  let hasAssertion = false;
  const shadowedBindings = handlerLocalBindings(handler);
  const collectTokens = (node) => {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      evidenceTokens.add(node.text);
    }
    ts.forEachChild(node, collectTokens);
  };
  const visit = (node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      if (isAssertionCall(node, assertBindings, shadowedBindings)) hasAssertion = true;
      collectTokens(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(handler.body);
  return { evidenceTokens, hasAssertion };
}

function isConditionalRegistrationContainer(node) {
  return ts.isIfStatement(node)
    || ts.isConditionalExpression(node)
    || ts.isSwitchStatement(node)
    || ts.isForStatement(node)
    || ts.isForInStatement(node)
    || ts.isForOfStatement(node)
    || ts.isWhileStatement(node)
    || ts.isDoStatement(node)
    || ts.isTryStatement(node);
}

function isShortCircuitExpression(node) {
  return ts.isBinaryExpression(node) && [
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ].includes(node.operatorToken.kind);
}

export function validateExecutableTestCases(contents, requiredTitles, requiredSyntax = {}) {
  const source = ts.createSourceFile(
    "required-contract.test.ts",
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const assertBindings = nodeAssertBindings(source);
  const activeTests = new Map();
  const visitRegistrations = (node, state = "active") => {
    if (ts.isFunctionLike(node)) return;
    if (isShortCircuitExpression(node)) {
      visitRegistrations(node.left, state);
      visitRegistrations(node.right, state === "active" ? "conditional" : state);
      return;
    }
    if (isConditionalRegistrationContainer(node)) {
      ts.forEachChild(node, (child) =>
        visitRegistrations(child, state === "active" ? "conditional" : state)
      );
      return;
    }
    if (ts.isCallExpression(node)) {
      const suiteKind = suiteCallKind(node.expression);
      if (suiteKind !== undefined) {
        const handler = functionHandler(node);
        if (handler !== undefined) {
          const suiteState = suiteKind === "active" ? state : suiteKind;
          ts.forEachChild(handler.body, (child) => visitRegistrations(child, suiteState));
        }
        return;
      }
      const kind = testCallKind(node.expression);
      if (kind !== "active" || state !== "active") {
        if (kind !== undefined) return;
        ts.forEachChild(node, (child) => visitRegistrations(child, state));
        return;
      }
      const title = node.arguments[0];
      const handler = functionHandler(node);
      if (
        title !== undefined
        && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))
        && handler !== undefined
      ) {
        const tests = activeTests.get(title.text) ?? [];
        tests.push(testHandlerEvidence(handler, assertBindings));
        activeTests.set(title.text, tests);
      }
      return;
    }
    ts.forEachChild(node, (child) => visitRegistrations(child, state));
  };
  if (source.parseDiagnostics.length > 0) throw new Error("REQUIRED_CONTRACT_MISSING");
  ts.forEachChild(source, visitRegistrations);
  if (requiredTitles.some((title) => {
    const tests = activeTests.get(title) ?? [];
    return !tests.some(({ evidenceTokens, hasAssertion }) =>
      hasAssertion
      && (requiredSyntax[title] ?? []).every((token) => evidenceTokens.has(token))
    );
  })) {
    throw new Error("REQUIRED_CONTRACT_MISSING");
  }
}

function activeYamlRunBlocks(contents) {
  const lines = contents.split(/\r?\n/u);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^(\s*)run:\s*(?:(\||>-?)\s*|(.*))$/u.exec(line);
    if (match === null) continue;
    if (match[3]?.trim()) {
      blocks.push(match[3].trim());
      continue;
    }
    const indentation = match[1].length;
    const block = [];
    for (index += 1; index < lines.length; index += 1) {
      const candidate = lines[index];
      if (candidate.trim() === "") continue;
      const candidateIndentation = /^\s*/u.exec(candidate)?.[0].length ?? 0;
      if (candidateIndentation <= indentation) {
        index -= 1;
        break;
      }
      if (!candidate.trimStart().startsWith("#")) block.push(candidate.trim());
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

export async function validateCiEvidenceConfig(repositoryRoot) {
  try {
    const contents = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
    const blocks = activeYamlRunBlocks(contents);
    const logValidation = blocks.find((block) =>
      block.includes("node infra/scripts/assert-secret-free-log.mjs")
    );
    const imageEvidence = blocks.find((block) =>
      block.includes("node infra/scripts/emit-image-evidence.mjs")
    );
    if (
      logValidation === undefined
      || imageEvidence === undefined
      || !/>\s*migration-runtime\.log\s+2>&1/u.test(logValidation)
      || !/>\s*cron-runtime\.log\s+2>&1/u.test(logValidation)
      || !["api", "cron", "migrate", "worker"].every((service) =>
        new RegExp(`(?:^|\\s)${service}=[^\\s\\\\]+`, "u").test(logValidation)
      )
      || ![
        "api-valid-startup.log",
        "cron-runtime.log",
        "migration-runtime.log",
        "worker-runtime.log",
        "worker-graceful-drain.log",
      ].every((path) => imageEvidence.split(/\s+/u).includes(path))
    ) throw new Error("invalid");
  } catch {
    throw new Error("CI_EVIDENCE_CONFIG_INVALID");
  }
}

export async function validateRequiredContracts(repositoryRoot) {
  try {
    const checkIds = Object.keys(requiredCheckContracts).sort();
    if (JSON.stringify(checkIds) !== JSON.stringify([...FOUNDATION_CHECK_CATALOG].sort())) {
      throw new Error("catalog");
    }
    await Promise.all([
      validateCiEvidenceConfig(repositoryRoot),
      ...Object.values(requiredCheckContracts).flat().map(async (contract) => {
        const contents = await readFile(join(repositoryRoot, contract.path), "utf8");
        validateExecutableTestCases(contents, contract.titles, contract.syntax);
      }),
    ]);
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
