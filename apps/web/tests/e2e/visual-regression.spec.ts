import { expect, test } from "@playwright/test";

// Member and admin surfaces are behind real authentication and render
// non-deterministic access states when signed out, so they no longer have a
// stable visual baseline. Only anonymous marketing pages are captured here.
const pages = [
  ["homepage", "/"],
] as const;

for (const [name, path] of pages) {
  test(`${name} visual baseline`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(path);
    await page.locator('script[data-nextjs-dev-overlay="true"]').evaluate((element) => element.remove());
    if (testInfo.project.name === "mobile") {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    }
    await expect(page).toHaveScreenshot(`${name}.png`, {
      animations: "disabled",
      fullPage: true,
    });
  });
}
