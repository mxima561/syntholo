import { expect, test } from "@playwright/test";

test("public visitor can assess readiness and reach checkout", async ({ page }) => {
  await page.goto("/");
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
  await expect(page.getByRole("heading", { name: /good evening, maria/i })).toBeVisible();
  await page.getByRole("link", { name: /continue lesson/i }).click();
  await expect(page.getByRole("heading", { name: /respond, qualify, and route leads/i })).toBeVisible();
  await page.getByRole("button", { name: /mark lesson complete/i }).click();
  await expect(page.getByText(/lesson completed/i)).toBeVisible();
  await page.getByRole("link", { name: /ask a coach/i }).click();
  await page.getByLabel(/reply to naomi/i).fill("Please review our qualification fallback.");
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

test("administrator can inspect content and provisioning", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: /good morning, alex/i })).toBeVisible();
  await page.getByRole("link", { name: /course content/i }).click();
  await expect(page.getByRole("heading", { name: /course content/i })).toBeVisible();
  await page.goto("/admin/provisioning");
  await expect(page.getByText(/4 of 7 checks passed/i)).toBeVisible();
});
