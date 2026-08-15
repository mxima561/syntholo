import { execFileSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

const releaseSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: new URL("../..", import.meta.url),
  encoding: "utf8",
}).trim();

export default defineConfig({
  testDir: "./tests/e2e-production",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "https://127.0.0.1:3200",
    extraHTTPHeaders: {
      "x-forwarded-host": "127.0.0.1:3200",
      "x-forwarded-proto": "https",
    },
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: {
      args: ["--no-proxy-server"],
    },
  },
  webServer: {
      command: "node ../../infra/scripts/production-browser-web-server.mjs",
      env: {
        ...process.env,
        API_UPSTREAM_ORIGIN: "https://api.syntholo.test",
        APP_MODE: "production",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsudGVzdCQ=",
        NEXT_PUBLIC_SYNTHOLO_DASHBOARD_VERSION: "2",
        RELEASE_SHA: releaseSha,
        VERCEL_ENV: "production",
        VERCEL: "1",
        VERCEL_GIT_COMMIT_SHA: releaseSha,
        WEB_ORIGIN: "https://127.0.0.1:3200",
      },
      port: 3200,
      reuseExistingServer: false,
      timeout: 120_000,
  },
});
