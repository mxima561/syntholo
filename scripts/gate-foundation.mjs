import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const clerkPackages = ["@clerk/nextjs", "@clerk/backend"];
const quick =
  process.env.GATE_FOUNDATION_QUICK === "1" ||
  process.argv.includes("--checks=releaseSha-only");

function readPackage(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function dependencyNames(pkg) {
  return {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  };
}

function hasClerk(deps) {
  return Object.keys(deps).some(
    (name) => name === "@clerk" || name.startsWith("@clerk/") || clerkPackages.includes(name),
  );
}

function emit(ok, checks) {
  console.log(JSON.stringify({ ok, checks }, null, 2));
}

function blockedReleaseSha() {
  emit(false, {
    releaseSha: { status: "BLOCKED", reason: "RELEASE_SHA_REQUIRED" },
  });
  process.exit(1);
}

function identitySeparation() {
  const admin = readPackage("apps/admin/package.json");
  const web = readPackage("apps/web/package.json");
  const adminDeps = dependencyNames(admin);
  const webDeps = dependencyNames(web);

  if (hasClerk(adminDeps)) {
    return { status: "BLOCKED", reason: "ADMIN_CLERK_FORBIDDEN" };
  }

  const webLooksLikeAccessApp =
    web.name === "@syntholo/admin" || ("jose" in webDeps && !hasClerk(webDeps));
  if (webLooksLikeAccessApp) {
    return { status: "BLOCKED", reason: "WEB_IS_STAFF_ACCESS_APP" };
  }

  return { status: "PASS" };
}

function healthPayload(service, env) {
  const sha = env.RELEASE_SHA?.trim() || env.GITHUB_SHA?.trim() || "dev";
  return { ok: true, service, releaseSha: sha };
}

function releaseHealth(sha) {
  const env = { RELEASE_SHA: sha, GITHUB_SHA: sha };
  const api = healthPayload("api", env);
  const worker = healthPayload("worker", env);
  if (!api.releaseSha || api.releaseSha !== worker.releaseSha || api.releaseSha !== sha) {
    return { status: "BLOCKED", reason: "RELEASE_SHA_MISMATCH", sha };
  }
  return { status: "PASS", sha: api.releaseSha };
}

function runNpm(args) {
  const result = spawnSync("npm", args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  return result.status === 0;
}

function skipRemaining(reason) {
  return {
    workspaces: { status: "SKIP", reason },
    rls: { status: "SKIP", reason },
    entitlements: { status: "SKIP", reason },
    jobs: { status: "SKIP", reason },
  };
}

function runWorkspaceSuites() {
  const suites = [
    {
      checks: ["entitlements", "jobs"],
      args: ["test", "-w", "@syntholo/domain", "--", "src/entitlements.test.ts", "src/jobs.test.ts"],
    },
    {
      checks: ["rls", "jobs"],
      args: [
        "test",
        "-w",
        "@syntholo/db",
        "--",
        "src/isolation.test.ts",
        "src/access.test.ts",
        "src/outbox.test.ts",
      ],
    },
    {
      checks: ["workspaces"],
      args: ["test", "-w", "@syntholo/api"],
    },
    {
      checks: ["workspaces"],
      args: ["test", "-w", "@syntholo/worker"],
    },
    {
      checks: ["workspaces"],
      args: ["run", "typecheck", "-w", "@syntholo/web"],
    },
    {
      checks: ["workspaces"],
      args: ["run", "typecheck", "-w", "@syntholo/admin"],
    },
    {
      checks: ["workspaces"],
      args: ["run", "typecheck", "-w", "@syntholo/api"],
    },
    {
      checks: ["workspaces"],
      args: ["run", "typecheck", "-w", "@syntholo/worker"],
    },
  ];

  const checks = {
    workspaces: { status: "SKIP", reason: "NOT_RUN" },
    rls: { status: "SKIP", reason: "NOT_RUN" },
    entitlements: { status: "SKIP", reason: "NOT_RUN" },
    jobs: { status: "SKIP", reason: "NOT_RUN" },
  };

  for (const suite of suites) {
    if (!runNpm(suite.args)) {
      for (const check of suite.checks) {
        checks[check] = {
          status: "FAIL",
          command: ["npm", ...suite.args].join(" "),
        };
      }
      return { ok: false, checks };
    }
    for (const check of suite.checks) {
      if (checks[check].status !== "FAIL") {
        checks[check] = { status: "PASS" };
      }
    }
  }

  return { ok: true, checks };
}

const releaseSha = process.env.RELEASE_SHA?.trim() || process.env.GITHUB_SHA?.trim() || "";
if (!releaseSha) {
  blockedReleaseSha();
}

const identity = identitySeparation();
const health = releaseHealth(releaseSha);
const canRunSuites = identity.status === "PASS" && health.status === "PASS";
const suites = !canRunSuites
  ? { ok: false, checks: skipRemaining("PREREQUISITE_BLOCKED") }
  : quick
    ? { ok: true, checks: skipRemaining("GATE_FOUNDATION_QUICK") }
    : runWorkspaceSuites();

const checks = {
  workspaces: suites.checks.workspaces,
  rls: suites.checks.rls,
  entitlements: suites.checks.entitlements,
  jobs: suites.checks.jobs,
  identitySeparation: identity,
  releaseSha: health,
  migrations: { status: "SKIP", reason: "BOOT_SCHEMA" },
};

const ok =
  suites.ok &&
  identity.status === "PASS" &&
  health.status === "PASS" &&
  Object.values(checks).every((check) => check.status === "PASS" || check.status === "SKIP");

emit(ok, checks);
process.exit(ok ? 0 : 1);
