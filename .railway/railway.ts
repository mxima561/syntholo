import { defineRailway, github, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const syntholo = github("mxima561/syntholo", { branch: "codex/production-platform", checkSuites: false });

  const worker = service("worker", {
    source: syntholo,
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "apps/worker/Dockerfile" },
    start: "/usr/local/bin/node /app/runner.js",
    replicas: { "sfo": 1 },
    deploy: { restartPolicyMaxRetries: 3 },
    env: {
      DATABASE_URL: preserve(),
      RELEASE_SHA: preserve(),
      WORKER_CONCURRENCY: preserve(),
      WORKER_IDLE_DELAY_MS: preserve(),
    },
  });
  const migrate = service("migrate", {
    source: syntholo,
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "apps/api/Dockerfile.migrate" },
    start: "/usr/local/bin/node /app/migrate.js",
    replicas: { "sfo": 1 },
    deploy: { restartPolicyType: "NEVER" },
    env: {
      DATABASE_DIRECT_URL: preserve(),
      DATABASE_MIGRATION_TARGET: preserve(),
      RELEASE_SHA: preserve(),
    },
  });
  const api = service("api", {
    source: syntholo,
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "apps/api/Dockerfile" },
    start: "/usr/bin/env NODE_ENV=production /usr/local/bin/node /app/server.js",
    healthcheck: "/v1/health/ready",
    healthcheckTimeout: 120,
    replicas: { "sfo": 1 },
    deploy: { restartPolicyMaxRetries: 3 },
    env: {
      CLERK_AUDIENCE: preserve(),
      MEMBER_DATABASE_URL: preserve(),
      NODE_ENV: preserve(),
      RELEASE_SHA: preserve(),
      STAFF_DATABASE_URL: preserve(),
      STAFF_SESSION_ENCRYPTION_KEYS: preserve(),
      WEB_ORIGIN: preserve(),
    },
  });
  const cron = service("cron", {
    source: syntholo,
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "apps/worker/Dockerfile.cron" },
    start: "/usr/local/bin/node /app/cron.js",
    replicas: { "sfo": 1 },
    deploy: { cronSchedule: "0 * * * *", restartPolicyType: "NEVER" },
    env: {
      DATABASE_URL: preserve(),
      RELEASE_SHA: preserve(),
      WORKER_CONCURRENCY: preserve(),
      WORKER_IDLE_DELAY_MS: preserve(),
    },
  });

  return project("syntholo", {
    resources: [worker, migrate, api, cron],
  });
});
