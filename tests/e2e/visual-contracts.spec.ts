import { expect, test } from "@playwright/test";

async function fontSize(locator: import("@playwright/test").Locator) {
  return locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
}

async function padding(locator: import("@playwright/test").Locator) {
  return locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingTop));
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
  await expect(page.getByRole("button", { name: /send reply/i })).toHaveCSS(
    "background-color",
    "rgb(239, 125, 98)",
  );

  await page.goto("/learn/community");
  expect(await fontSize(page.locator(".community-post > p").first())).toBeGreaterThanOrEqual(15);
});
