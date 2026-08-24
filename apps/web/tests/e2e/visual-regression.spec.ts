import { expect, test } from "@playwright/test";

const pages = [
  ["homepage", "/"],
  ["member-dashboard", "/learn"],
  ["course-workspace", "/learn/course/growth-2"],
  ["support-inbox", "/learn/support"],
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
