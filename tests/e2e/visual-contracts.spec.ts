import { expect, test } from "@playwright/test";

async function fontSize(locator: import("@playwright/test").Locator) {
  return locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
}

async function padding(locator: import("@playwright/test").Locator) {
  return locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingTop));
}

async function gridColumnCount(locator: import("@playwright/test").Locator) {
  return locator.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/).length);
}

test("public pages use readable type and semantic color", async ({ page }) => {
  await page.goto("/");
  expect(await fontSize(page.locator(".hero-lede"))).toBeGreaterThanOrEqual(15);
  expect(await fontSize(page.locator(".outcome-card p").first())).toBeGreaterThanOrEqual(15);
  await expect(page.getByRole("link", { name: /take the free scorecard/i }).first()).toHaveCSS(
    "background-color",
    "rgb(15, 111, 112)",
  );

  await page.goto("/scorecard");
  expect(await fontSize(page.locator(".question-card > p"))).toBeGreaterThanOrEqual(15);

  await page.goto("/pricing");
  const pricingCardPadding = await padding(page.locator(".pricing-card").first());
  expect(pricingCardPadding).toBeGreaterThanOrEqual(16);
  expect(pricingCardPadding).toBeLessThanOrEqual(24);

  await page.goto("/checkout/operator-club");
  expect(await fontSize(page.locator(".checkout-disclosure"))).toBeGreaterThanOrEqual(15);
});

test("core member workspaces keep body and controls readable", async ({ page }) => {
  await page.goto("/learn/course");
  expect(await fontSize(page.locator(".stage-intro p").first())).toBeGreaterThanOrEqual(15);
  expect(await fontSize(page.locator(".stage-lessons strong").first())).toBeGreaterThanOrEqual(13);

  await page.goto("/learn/plan");
  await page.getByRole("button", { name: /team enablement checklist/i }).click();
  expect(await fontSize(page.locator(".document-preview p").first())).toBeGreaterThanOrEqual(15);

  await page.goto("/learn/workflows");
  expect(await fontSize(page.locator(".workflow-card > p").first())).toBeGreaterThanOrEqual(15);
});

test("core member metadata and card titles meet the refreshed type scale", async ({ page }) => {
  await page.goto("/learn/course/growth-2");
  const lessonActionLabel = await fontSize(page.locator(".lesson-action-card .micro-label"));
  expect(lessonActionLabel).toBeGreaterThanOrEqual(11);
  expect(lessonActionLabel).toBeLessThanOrEqual(12);
  const lessonActionTitle = await fontSize(page.locator(".lesson-action-card h2"));
  expect(lessonActionTitle).toBeGreaterThanOrEqual(16);
  expect(lessonActionTitle).toBeLessThanOrEqual(21);

  await page.goto("/learn/plan");
  const artifactLabel = await fontSize(page.locator(".artifact-nav > .micro-label"));
  expect(artifactLabel).toBeGreaterThanOrEqual(11);
  expect(artifactLabel).toBeLessThanOrEqual(12);
  const reviewTitle = await fontSize(page.locator(".review-rail h2"));
  expect(reviewTitle).toBeGreaterThanOrEqual(16);
  expect(reviewTitle).toBeLessThanOrEqual(21);

  await page.goto("/learn/workflows");
  const workflowStatus = await fontSize(page.locator(".workflow-card .status-pill").first());
  expect(workflowStatus).toBeGreaterThanOrEqual(11);
  expect(workflowStatus).toBeLessThanOrEqual(12);
});

test("human and community surfaces use readable conversation text", async ({ page }) => {
  await page.goto("/learn/support");
  expect(await fontSize(page.locator(".message-stream article p").first())).toBeGreaterThanOrEqual(15);
  const threadStatus = await page.locator(".thread-list > button.active .status-pill").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(threadStatus.scrollWidth).toBeLessThanOrEqual(threadStatus.clientWidth);
  await expect(page.getByRole("button", { name: /send reply/i })).toHaveCSS(
    "background-color",
    "rgb(239, 125, 98)",
  );
  await expect(page.getByRole("button", { name: /send reply/i })).toHaveCSS(
    "color",
    "rgb(16, 42, 53)",
  );

  await page.goto("/learn/community");
  expect(await fontSize(page.locator(".community-post > p").first())).toBeGreaterThanOrEqual(15);
});

test("mobile coach profile keeps its identity and support details in separate rows", async ({ page }) => {
  test.skip(test.info().project.name !== "mobile", "This layout contract applies below 720px.");

  await page.goto("/learn/support");
  const [avatar, name, role, details, standard] = await Promise.all([
    page.locator(".coach-profile > .coach-avatar").boundingBox(),
    page.getByRole("heading", { name: "Naomi Reed" }).boundingBox(),
    page.locator(".coach-profile > p").boundingBox(),
    page.locator(".coach-profile dl").boundingBox(),
    page.locator(".support-standard").boundingBox(),
  ]);

  if (!avatar || !name || !role || !details || !standard) {
    throw new Error("Expected the mobile coach profile elements to be visible.");
  }

  expect(avatar.x + avatar.width).toBeLessThanOrEqual(name.x);
  expect(name.y + name.height).toBeLessThanOrEqual(role.y);
  expect(Math.max(avatar.y + avatar.height, role.y + role.height)).toBeLessThanOrEqual(details.y);
  expect(details.y + details.height).toBeLessThanOrEqual(standard.y);
});

test("admin remains dense but readable", async ({ page }) => {
  await page.goto("/admin");
  expect(await fontSize(page.locator(".admin-page-head p"))).toBeGreaterThanOrEqual(15);
  expect(await fontSize(page.locator(".admin-metric-grid small").first())).toBeGreaterThanOrEqual(12);
  const adminBadgeSize = await fontSize(page.locator(".admin-sidebar .brand i"));
  expect(adminBadgeSize).toBeGreaterThanOrEqual(12);
  expect(adminBadgeSize).toBeLessThanOrEqual(14);

  await page.goto("/admin/customers");
  expect(await fontSize(page.locator(".admin-table strong").first())).toBeGreaterThanOrEqual(13);
});

test("admin provisioning statuses use the readable label floor", async ({ page }) => {
  await page.goto("/admin/provisioning");
  const provisioningStatusSize = await fontSize(page.locator(".provisioning-queue > aside:first-child .status-pill").first());
  expect(provisioningStatusSize).toBeGreaterThanOrEqual(12);
  expect(provisioningStatusSize).toBeLessThanOrEqual(14);
});

test("reading descriptions use the approved body-copy floor", async ({ page }) => {
  const descriptions = [
    ["/", ".hero-lede"],
    ["/learn/course", ".page-intro p"],
    ["/learn/plan", ".page-intro p"],
    ["/learn/workflows", ".page-intro p"],
    ["/learn/support", ".page-intro p"],
    ["/learn/community", ".page-intro p"],
    ["/learn/business-os", ".page-intro p"],
    ["/admin", ".admin-page-head p"],
  ] as const;

  for (const [path, selector] of descriptions) {
    await page.goto(path);
    expect(await fontSize(page.locator(selector).first()), `${path} description is below 15px`).toBeGreaterThanOrEqual(15);
  }
});

test("member home preserves the focused one-two-three composition", async ({ page }) => {
  await page.goto("/learn");
  await expect(page.locator(".dashboard-continue-card")).toHaveCount(1);
  await expect(page.locator(".dashboard-recommendation")).toHaveCount(2);
  await expect(page.locator(".dashboard-right-rail > .dashboard-rail-card")).toHaveCount(3);
});

test("desktop member sidebar keeps the account identity within the viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "The member sidebar becomes bottom navigation on mobile.");

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/learn");
  const identity = await page.locator(".member-identity").boundingBox();
  if (!identity) throw new Error("Expected the member identity to be visible.");
  expect(identity.y + identity.height).toBeLessThanOrEqual(720);
});

test("dashboard and application shells follow the approved responsive breakpoints", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Viewport contract is exercised once with explicit widths.");

  await page.setViewportSize({ width: 1179, height: 900 });
  await page.goto("/learn");
  expect(await gridColumnCount(page.locator(".dashboard-layout"))).toBe(1);
  expect(await gridColumnCount(page.locator(".dashboard-right-rail"))).toBe(3);

  await page.setViewportSize({ width: 899, height: 900 });
  await page.goto("/learn");
  expect(await gridColumnCount(page.locator(".dashboard-right-rail"))).toBe(1);
  expect(await gridColumnCount(page.locator(".dashboard-recommendations"))).toBe(1);

  await page.setViewportSize({ width: 767, height: 900 });
  await page.goto("/learn");
  expect(await gridColumnCount(page.locator(".member-shell"))).toBe(1);
  expect(await gridColumnCount(page.locator(".dashboard-continue-card"))).toBe(1);
  await expect(page.locator(".member-sidebar")).toHaveCSS("position", "fixed");
  expect(Math.round((await page.locator(".member-sidebar").boundingBox())?.height ?? 0)).toBe(58);
  expect(Math.round((await page.locator(".member-page").boundingBox())?.width ?? 0)).toBe(735);

  await page.goto("/admin");
  expect(await gridColumnCount(page.locator(".admin-shell"))).toBe(1);
  await expect(page.locator(".admin-sidebar")).toHaveCSS("position", "static");
  await expect(page.locator(".admin-sidebar nav")).toHaveCSS("display", "flex");
  expect(Math.round((await page.locator(".admin-page").boundingBox())?.width ?? 0)).toBe(735);
});

test("reduced motion removes transforms and animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/learn");
  const motion = await page.locator(".dashboard-illustration-block").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      animation: style.animationName,
      transition: style.transitionDuration,
      transform: style.transform,
    };
  });
  expect(motion.animation).toBe("none");
  expect(motion.transform).toBe("none");
  expect(motion.transition).toBe("0s");
});
