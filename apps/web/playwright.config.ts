import { execFileSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

const releaseSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: new URL("../..", import.meta.url),
  encoding: "utf8",
}).trim();

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: process.env.CI === "true" ? /visual-regression\.spec\.ts/u : undefined,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["junit", { outputFile: "test-results/playwright-junit.xml" }],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node ../../infra/scripts/proxy-fixture-server.mjs",
      url: "http://127.0.0.1:4100/v1/proxy-evidence",
      reuseExistingServer: process.env.CI !== "true",
      timeout: 30_000,
    },
    {
      command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
      env: {
        ...process.env,
        API_UPSTREAM_ORIGIN: "http://127.0.0.1:4100",
        APP_MODE: "demo",
        RELEASE_SHA: releaseSha,
        WEB_ORIGIN: "http://127.0.0.1:3100",
      },
      url: "http://127.0.0.1:3100",
      reuseExistingServer: process.env.CI !== "true",
      timeout: 120_000,
    },
  ],
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"] } },
  ],
});
