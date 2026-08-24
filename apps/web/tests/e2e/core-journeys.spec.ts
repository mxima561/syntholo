import { expect, test } from "@playwright/test";

test("public visitor can assess readiness and reach checkout", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /explore the 30-day plan/i })).toHaveCSS("color", "rgb(16, 42, 53)");
  await expect(page.getByRole("heading", { name: /put ai to work across your business/i })).toBeVisible();
  await page.getByRole("link", { name: "Take the free scorecard" }).first().click();
  for (let question = 1; question <= 20; question += 1) {
    await expect(page.getByText(`Question ${question} of 20`)).toBeVisible();
    await page.getByRole("button", { name: /some practices exist/i }).click();
  }
  await page.getByLabel(/first name/i).fill("Maria");
  await page.getByLabel(/work email/i).fill("maria@northstar.example");
  await page.getByLabel(/business name/i).fill("Northstar Advisory");
  await page.getByLabel(/country/i).selectOption("United States");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /unlock my full report/i }).click();
  await expect(page.getByRole("heading", { name: /you are in the building stage/i })).toBeVisible();
  await page.getByRole("link", { name: /see the academy/i }).click();
  await expect(page.getByRole("heading", { name: /start with the academy/i })).toBeVisible();
});

test("member can complete a lesson and ask a human coach", async ({ page }) => {
  await page.goto("/learn");
  await expect(page.getByRole("heading", { name: /keep building your business os/i })).toBeVisible();
  const browseLessons = page.getByLabel("Browse lessons and templates");
  await expect(browseLessons).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await expect(browseLessons).toHaveCSS("min-height", "44px");
  }
  await page.goto("/learn/course/growth-2");
  await expect(page.getByRole("heading", { name: /respond, qualify, and route leads/i })).toBeVisible();
  const complete = page.getByRole("button", { name: /mark lesson complete/i });
  if (await complete.isVisible()) {
    await complete.click();
    await expect(page.getByText(/lesson completed/i)).toBeVisible();
  }
  await page.getByRole("link", { name: /ask a coach/i }).click();
  await page.getByRole("textbox", { name: /reply body/i }).fill("Please review our qualification fallback.");
  await page.getByRole("button", { name: /send reply/i }).click();
  await expect(page.getByText("Please review our qualification fallback.").last()).toBeVisible();
});

test("Business OS onboarding reaches provisioning", async ({ page }) => {
  await page.goto("/learn/business-os");
  await page.getByRole("checkbox", { name: /calendar and availability/i }).check();
  await page.getByRole("checkbox", { name: /messaging registration/i }).check();
  await page.getByRole("button", { name: /submit for provisioning/i }).click();
  await expect(page.getByText(/provisioning has started/i)).toBeVisible();
});

test("public student path stays on the marketing origin", async ({ page }) => {
  const routes: Array<[string, RegExp]> = [
    ["/", /put ai to work across your business/i],
    ["/pricing", /start with the academy/i],
    ["/checkout/operator-club", /operator club/i],
    ["/claim", /demo purchase confirmed/i],
    ["/signin", /sign-in needs clerk/i],
    ["/privacy", /privacy at syntholo/i],
    ["/terms", /terms of service/i],
  ];

  for (const [path, heading] of routes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  }

  await page.goto("/scorecard");
  await expect(page.getByText("Question 1 of 20")).toBeVisible();

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: /not part of your workspace/i })).toBeVisible();
});

test("student can open every member workspace", async ({ page }) => {
  const routes: Array<[string, RegExp]> = [
    ["/learn", /keep building your business os/i],
    ["/learn/course", /ai operating system academy/i],
    ["/learn/course/growth-2", /respond, qualify, and route leads/i],
    ["/learn/plan", /30-day build plan/i],
    ["/learn/workflows", /your business workflows/i],
    ["/learn/templates", /templates/i],
    ["/learn/community", /learn with people doing the work/i],
    ["/learn/live", /live sessions/i],
    ["/learn/support", /your human support inbox/i],
    ["/learn/business-os", /business os/i],
    ["/learn/settings", /settings|account|billing/i],
  ];

  for (const [path, heading] of routes) {
    await page.goto(path);
    await expect(page.locator(".member-shell")).toBeVisible();
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  }
});

