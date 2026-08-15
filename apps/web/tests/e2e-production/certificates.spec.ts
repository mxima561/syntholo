import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const clerkFixture = `(() => {
  const user = { id: "certificate-browser-user", organizationMemberships: [] };
  const session = {
    id: "certificate-browser-session", status: "active", actor: null, factorVerificationAge: null,
    lastActiveToken: { jwt: { claims: { sid: "certificate-browser-session", sub: user.id } } },
    getToken: async () => "certificate-browser-token"
  };
  const resources = { client: { id: "certificate-browser-client" }, session, user, organization: null };
  window.__internal_ClerkUICtor = function ClerkUI() {};
  window.Clerk = {
    loaded: true, status: "ready", client: resources.client, session, user, organization: null,
    telemetry: { record() {} }, __internal_lastEmittedResources: resources,
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

const certificateId = "10000000-0000-4000-8000-000000000001";
const courseCompletionId = "10000000-0000-4000-8000-000000000002";
const correlationId = "10000000-0000-4000-8000-000000000003";

const issued = {
  id: certificateId,
  courseCompletionId,
  status: "issued",
  snapshotRenderable: true,
  recipientName: "Ada Lovelace",
  businessName: "Analytical Engines",
  courseTitle: "AI Operating System Academy",
  courseVersion: 1,
  completedAt: "2026-08-15T12:00:00.000Z",
  issuedAt: "2026-08-15T12:01:00.000Z",
  failureCode: null,
} as const;

const awaiting = {
  ...issued,
  status: "awaiting_recipient_name",
  recipientName: null,
  issuedAt: null,
} as const;

const pending = {
  ...issued,
  status: "pending",
  issuedAt: null,
} as const;

async function installClerk(page: Page) {
  await page.route(/^https:\/\/(?!127\.0\.0\.1:3200\/).+/u, async (route) => {
    if (route.request().resourceType() !== "script") { await route.abort(); return; }
    await route.fulfill({ body: clerkFixture, contentType: "application/javascript; charset=utf-8", status: 200 });
  });
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    body: JSON.stringify(body),
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-correlation-id": correlationId,
    },
    status,
  });
}

test("member confirms a canonical name, observes pending then issued, and downloads one private PDF", async ({ page }) => {
  await installClerk(page);
  let listReads = 0;
  const memberRequests: Array<{ path: string; method: string; authorization?: string; cookie?: string; body: string | null }> = [];
  await page.route(/\/v1\/member\/certificates(?:\/.*)?(?:\?.*)?$/u, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    memberRequests.push({
      path: url.pathname,
      method: request.method(),
      authorization: request.headers().authorization,
      cookie: request.headers().cookie,
      body: request.postData(),
    });
    if (url.pathname.endsWith("/download")) {
      await route.fulfill({
        body: "%PDF-private-browser-fixture",
        headers: {
          "cache-control": "private, no-store",
          "content-length": "28",
          "content-type": "application/pdf",
        },
        status: 200,
      });
      return;
    }
    listReads += 1;
    await json(route, { items: listReads === 1 ? [awaiting] : listReads === 2 ? [pending] : [issued], nextCursor: null });
  });
  await page.route("**/v1/member/certificate-recipient-name", async (route) => {
    const request = route.request();
    memberRequests.push({
      path: new URL(request.url()).pathname,
      method: request.method(),
      authorization: request.headers().authorization,
      cookie: request.headers().cookie,
      body: request.postData(),
    });
    if (request.method() === "PUT") {
      await json(route, {
        schemaVersion: 1,
        recipientName: { version: 1, displayName: "Ada Lovelace", confirmedAt: "2026-08-15T12:00:00.000Z" },
      });
      return;
    }
    await json(route, { schemaVersion: 1, recipientName: null });
  });

  await page.goto("/learn/settings/certificates");
  await expect(page.getByRole("heading", { name: "Certificate settings" })).toBeVisible();
  await expect(page.getByText("Name required")).toBeVisible();
  await page.getByLabel("Recipient name").fill(" Ada\u00a0Lovelace ");
  await page.getByRole("button", { name: "Confirm recipient name" }).click();
  await expect(page.getByText("Preparing")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Ready to download")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download private PDF" })).toHaveCount(1);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download private PDF" }).click();
  expect((await download).suggestedFilename()).toBe("syntholo-certificate-of-completion.pdf");
  await expect(page.getByText("Private certificate download started")).toBeVisible();

  const put = memberRequests.find((request) => request.method === "PUT")!;
  expect(put).toMatchObject({
    path: "/v1/member/certificate-recipient-name",
    authorization: "Bearer certificate-browser-token",
    cookie: undefined,
    body: JSON.stringify({ expectedVersion: 0, displayName: "Ada Lovelace" }),
  });
  expect(memberRequests.filter((request) => request.path.endsWith("/download"))).toHaveLength(1);
  expect(memberRequests.every((request) => request.authorization === "Bearer certificate-browser-token")).toBe(true);
  expect(memberRequests.every((request) => request.cookie === undefined)).toBe(true);
});

test("mobile certificate settings expose five 44px links without overflow or axe violations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installClerk(page);
  await page.route("**/v1/member/certificate-recipient-name", (route) => json(route, {
    schemaVersion: 1,
    recipientName: { version: 1, displayName: "Ada Lovelace", confirmedAt: "2026-08-15T12:00:00.000Z" },
  }));
  await page.route(/\/v1\/member\/certificates(?:\?.*)?$/u, (route) => json(route, { items: [issued], nextCursor: null }));

  await page.goto("/learn/settings/certificates");
  for (const name of ["Home", "Course", "Plan", "Workflows", "Certificates"]) {
    const link = page.getByRole("link", { name, exact: true });
    await expect(link).toBeVisible();
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.getByRole("link", { name: "Certificates", exact: true })).toHaveAttribute("aria-current", "page");
  const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("authorized staff records one honest pending delivery request without demo or destination claims", async ({ context, page }) => {
  await context.addCookies([{
    name: "__Host-syntholo_staff_session",
    value: "s".repeat(43),
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  }]);
  const deliveryRequests: Array<{ body: string | null; csrf?: string; key?: string }> = [];
  await page.route(`**/v1/staff/certificates/${certificateId}/deliveries`, async (route) => {
    const request = route.request();
    deliveryRequests.push({
      body: request.postData(),
      csrf: request.headers()["x-syntholo-csrf"],
      key: request.headers()["idempotency-key"],
    });
    await json(route, { status: "delivery_pending" }, 202);
  });

  await page.goto("/admin/certificates");
  await expect(page.getByRole("heading", { name: "Private certificate delivery" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Staff navigation" }).getByRole("link", { name: "Certificates" })).toHaveAttribute("aria-current", "page");
  await page.getByLabel("Certificate ID").fill(certificateId);
  await page.getByLabel("Recovery reason").fill("Customer requested private delivery recovery");
  await page.getByRole("button", { name: "Request delivery recovery" }).click();
  await expect(page.getByRole("status")).toContainText("Delivery pending");
  await expect(page.getByText("No email has been sent in this release.")).toBeVisible();
  expect(deliveryRequests).toEqual([{
    body: JSON.stringify({ reason: "Customer requested private delivery recovery" }),
    csrf: "1",
    key: expect.stringMatching(/^certificate-delivery-/u),
  }]);
  await expect(page.locator("body")).not.toContainText(/All systems normal|Live data|Tuesday, August 11, 2026|Northstar|coach online/iu);
  await expect(page.getByLabel(/email|destination/iu)).toHaveCount(0);
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
});
