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
