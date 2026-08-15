import { expect, test } from "@playwright/test";

const clerkFixture = `(() => {
  const user = { id: "clerk_browser_user", organizationMemberships: [] };
  const session = {
    id: "clerk_browser_session",
    status: "active",
    actor: null,
    factorVerificationAge: null,
    lastActiveToken: {
      jwt: {
        claims: {
          sid: "clerk_browser_session",
          sub: "clerk_browser_user"
        }
      }
    },
    getToken: async () => "production-browser-clerk-token"
  };
  const resources = { client: { id: "client_browser" }, session, user, organization: null };
  window.__internal_ClerkUICtor = function ClerkUI() {};
  window.Clerk = {
    loaded: true,
    status: "ready",
    client: resources.client,
    session,
    user,
    organization: null,
    telemetry: { record() {} },
    __internal_lastEmittedResources: resources,
    addListener(listener, options) {
      if (!options || options.skipInitialEmit !== true) listener(resources);
      return () => {};
    },
    on(event, listener, options) {
      if (event === "status" && options && options.notify) listener("ready");
      return () => {};
    },
    off() {}
  };
})();`;

const dashboard = {
  schemaVersion: 1,
  generatedAt: "2026-08-14T20:00:00.123Z",
  account: {
    id: "10000000-0000-4000-8000-000000000001",
    name: "Production Browser Account",
  },
  access: {
    accountId: "10000000-0000-4000-8000-000000000001",
    capabilities: {
      academy_course: true,
      support: false,
      circle_write: false,
      operator_club: false,
      business_os: false,
    },
    holds: [],
    seatLimit: 3,
    reservedSeats: 1,
    explanations: [
      { capability: "academy_course", sourceGrantIds: ["20000000-0000-4000-8000-000000000001"] },
      { capability: "support", sourceGrantIds: [] },
      { capability: "circle_write", sourceGrantIds: [] },
      { capability: "operator_club", sourceGrantIds: [] },
      { capability: "business_os", sourceGrantIds: [] },
    ],
  },
  experience: { state: "partial" },
  projections: {
    learning: { state: "unavailable", reason: "module_not_implemented" },
    support: { state: "unavailable", reason: "module_not_implemented" },
    sessions: { state: "unavailable", reason: "module_not_implemented" },
    implementation: { state: "unavailable", reason: "module_not_implemented" },
    recommendations: { state: "unavailable", reason: "module_not_implemented" },
  },
  nextBestStep: {
    kind: "unavailable",
    blockedBy: "support",
    reason: "module_not_implemented",
    target: "retry",
  },
};

test("production /learn uses the Clerk bearer boundary and renders only the real dashboard response", async ({ page }) => {
  let dashboardRequest: Readonly<{
    authorization: string | undefined;
    cookie: string | undefined;
    version: string | undefined;
  }> | undefined;
  await page.route(/^https:\/\/(?!127\.0\.0\.1:3200\/).+/u, async (route) => {
    if (route.request().resourceType() !== "script") {
      await route.abort();
      return;
    }
    await route.fulfill({
      body: clerkFixture,
      contentType: "application/javascript; charset=utf-8",
      status: 200,
    });
  });
  await page.route("**/v1/member/dashboard", async (route) => {
    await route.fulfill({
      body: JSON.stringify(dashboard),
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "syntholo-dashboard-version": "1",
        vary: "Authorization, Syntholo-Dashboard-Version",
      },
      status: 200,
    });
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/member/dashboard") {
      dashboardRequest = {
        authorization: request.headers().authorization,
        cookie: request.headers().cookie,
        version: request.headers()["syntholo-dashboard-version"],
      };
    }
  });

  await page.goto("/learn");

  await expect(page.getByRole("heading", { name: "Production Browser Account" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dashboard data is still coming online" })).toBeVisible();
  expect(dashboardRequest).toEqual({
    authorization: "Bearer production-browser-clerk-token",
    cookie: undefined,
    version: "1",
  });
  await expect(page.locator("body")).not.toContainText(/Maria|Northstar|coach online/iu);
});
