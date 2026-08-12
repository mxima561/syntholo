import { expect, test } from "@playwright/test";

async function fontSize(locator: import("@playwright/test").Locator) {
  return locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
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
});
