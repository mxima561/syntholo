import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const pages = [
  "/",
  "/scorecard",
  "/pricing",
  "/learn",
  "/learn/course/growth-2",
  "/learn/plan",
  "/learn/workflows",
  "/learn/support",
  "/learn/community",
  "/learn/business-os",
];

const responsivePages = [
  "/",
  "/scorecard",
  "/learn",
  "/learn/course",
  "/learn/course/growth-2",
  "/learn/plan",
  "/learn/workflows",
  "/learn/support",
  "/learn/community",
  "/learn/business-os",
];

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

test("representative pages keep meaningful interface text at or above 11px", async ({ page }) => {
  for (const path of pages) {
    await page.goto(path);
    const undersizedText = await page.locator("body *").evaluateAll((elements) =>
      elements.flatMap((element) => {
        const directText = [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(" ");
        const style = getComputedStyle(element);
        const isVisible = style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
        const size = Number.parseFloat(style.fontSize);

        if (!directText || !isVisible || size === 0 || size >= 11) return [];

        return [{
          element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${[...element.classList].map((name) => `.${name}`).join("")}`,
          size,
          text: directText.slice(0, 80),
        }];
      }),
    );

    expect(undersizedText, `${path} renders meaningful interface text below 11px`).toEqual([]);
  }
});

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
  for (const path of responsivePages) {
    await page.goto(path);
    const sizes = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
    expect(sizes.documentWidth, `${path} overflows horizontally`).toBeLessThanOrEqual(sizes.viewportWidth + 1);
  }

  for (const path of ["/", "/learn", "/learn/support", "/learn/business-os"]) {
    await page.goto(path);
    const primaryAction = page.locator(".button:visible").first();
    await expect(primaryAction, `${path} should expose a visible primary action`).toBeVisible();
    const box = await primaryAction.boundingBox();
    expect(box?.height ?? 0, `${path} primary action is shorter than 44px`).toBeGreaterThanOrEqual(44);
  }
});
