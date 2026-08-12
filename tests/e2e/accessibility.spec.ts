import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const pages = ["/", "/scorecard", "/learn", "/learn/support", "/learn/business-os", "/admin"];

for (const path of pages) {
  test(`WCAG 2.1 AA scan has no detectable violations on ${path}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "One engine is sufficient for deterministic automated scans.");
    await page.goto(path);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const summary = results.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    }));
    expect(summary).toEqual([]);
  });
}

test("scorecard can be answered with the keyboard", async ({ page }) => {
  await page.goto("/scorecard");
  const answer = page.getByRole("button", { name: /some practices exist/i });
  await answer.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Question 2 of 20")).toBeVisible();
});

test("reduced-motion preference removes meaningful transitions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const duration = await page.getByRole("link", { name: "Take the free scorecard" }).first().evaluate((element) => getComputedStyle(element).transitionDuration);
  const durationMs = duration.endsWith("ms") ? Number.parseFloat(duration) : Number.parseFloat(duration) * 1_000;
  expect(durationMs).toBeLessThanOrEqual(0.01);
});

test("mobile pages avoid horizontal overflow and preserve primary touch targets", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile viewport check.");
  for (const path of ["/", "/learn", "/learn/support", "/admin"]) {
    await page.goto(path);
    const sizes = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
    expect(sizes.documentWidth, `${path} overflows horizontally`).toBeLessThanOrEqual(sizes.viewportWidth + 1);
  }
  await page.goto("/");
  const box = await page.getByRole("link", { name: "Take the free scorecard" }).first().boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});
