import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const clerkFixture = `(() => {
  const listeners = new Set();
  const clerk = {
    loaded: true, status: "ready", telemetry: { record() {} },
    addListener(listener, options) {
      listeners.add(listener);
      if (!options || options.skipInitialEmit !== true) listener(clerk.__internal_lastEmittedResources);
      return () => listeners.delete(listener);
    },
    on(event, listener, options) {
      if (event === "status" && options && options.notify) listener("ready");
      return () => {};
    },
    off() {}
  };
  function setSession(id, token) {
    const user = { id: "user-" + id, organizationMemberships: [] };
    const session = {
      id, status: "active", actor: null, factorVerificationAge: null,
      lastActiveToken: { jwt: { claims: { sid: id, sub: user.id } } },
      getToken: async () => token
    };
    const resources = { client: { id: "client-browser" }, session, user, organization: null };
    Object.assign(clerk, { client: resources.client, session, user, organization: null, __internal_lastEmittedResources: resources });
    listeners.forEach((listener) => listener(resources));
  }
  window.__internal_ClerkUICtor = function ClerkUI() {};
  window.Clerk = clerk;
  window.__syntholoSetSession = setSession;
  setSession("session-a", "token-a");
})();`;

const correlationId = "40000000-0000-4000-8000-000000000001";
const kinds = ["readiness_map", "ai_policy", "workflow_portfolio", "enablement_checklist", "roadmap"] as const;
type Summary = Readonly<{
  id: string;
  kind: (typeof kinds)[number];
  title: string;
  currentVersion: number;
  currentState: "draft" | "final" | null;
  currentVersionId: string | null;
  updatedAt: string | null;
  authorLabel: "You" | "A teammate" | null;
}>;
const summaries: Summary[] = kinds.map((kind, index) => ({
  id: `30000000-0000-4000-8000-00000000000${index + 1}`,
  kind,
  title: ["Readiness map", "AI policy", "Workflow portfolio", "Enablement checklist", "90-day roadmap"][index]!,
  currentVersion: 0,
  currentState: null,
  currentVersionId: null,
  updatedAt: null,
  authorLabel: null,
}));
const emptyContent = {
  readiness_map: { kind: "readiness_map", priorities: [], notes: "" },
  ai_policy: { kind: "ai_policy", purpose: "", approvedUses: [], prohibitedUses: [], humanReviewRules: [] },
  workflow_portfolio: { kind: "workflow_portfolio", workflows: [] },
  enablement_checklist: { kind: "enablement_checklist", owner: "", items: [] },
  roadmap: { kind: "roadmap", objective: "", milestones: [] },
} as const;

function list(items = summaries) {
  return {
    schemaVersion: 1,
    items,
    nextCursor: null,
    implementationCompletion: { completed: false, completedAt: null },
  };
}

function readinessSummary(version = 1): Summary {
  return {
    ...summaries[0]!,
    currentVersion: version,
    currentState: "draft" as const,
    currentVersionId: `50000000-0000-4000-8000-00000000000${version}`,
    updatedAt: "2026-08-15T12:00:00.000Z",
    authorLabel: "You" as const,
  };
}

function currentReadiness(notes: string, version = 1) {
  return {
    ...readinessSummary(version),
    content: { ...emptyContent.readiness_map, notes },
  };
}

function savedReadiness(notes: string, version = 1) {
  const current = currentReadiness(notes, version);
  const { content, ...artifact } = current;
  return {
    schemaVersion: 1,
    artifact,
    version: {
      id: artifact.currentVersionId,
      version,
      state: "draft",
      contentHash: "a".repeat(64),
      createdAt: artifact.updatedAt,
      authorLabel: "You",
    },
    content,
    implementationCompletion: { completed: false, completedAt: null },
  };
}

async function json(route: Route, body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  await route.fulfill({
    body: JSON.stringify(body),
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-correlation-id": correlationId,
      ...extraHeaders,
    },
    status,
  });
}

async function installClerk(page: Page) {
  await page.route(/^https:\/\/(?!127\.0\.0\.1:3200\/).+/u, async (route) => {
    if (route.request().resourceType() !== "script") { await route.abort(); return; }
    await route.fulfill({ body: clerkFixture, contentType: "application/javascript; charset=utf-8", status: 200 });
  });
}

function detailFor(id: string, notes?: string) {
  const artifact = summaries.find((item) => item.id === id)!;
  if (artifact.kind === "readiness_map" && notes !== undefined) {
    const current = currentReadiness(notes);
    const { content, ...currentArtifact } = current;
    return { schemaVersion: 1, artifact: currentArtifact, content };
  }
  return { schemaVersion: 1, artifact, content: null };
}

test.beforeEach(async ({ page }) => installClerk(page));

test("production artifact autosave retries the byte-identical bearer request without cookies", async ({ page }) => {
  const posts: Array<{ body: string | null; key?: string; authorization?: string; cookie?: string }> = [];
  let postCount = 0;
  await page.route(/\/v1\/member\/artifacts(?:\/.*)?(?:\?.*)?$/u, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      postCount += 1;
      posts.push({
        body: request.postData(),
        key: request.headers()["idempotency-key"],
        authorization: request.headers().authorization,
        cookie: request.headers().cookie,
      });
      if (postCount === 1) { await route.abort("connectionclosed"); return; }
      await json(route, savedReadiness("Browser exact retry"), 201);
      return;
    }
    if (path === "/v1/member/artifacts") { await json(route, list()); return; }
    await json(route, detailFor(path.split("/").at(-1)!));
  });

  await page.goto("/learn/plan");
  await page.getByLabel("Notes").fill("Browser exact retry");
  await page.getByRole("button", { name: "Retry exact save" }).click();
  await expect(page.getByRole("status", { name: "" }).last()).toContainText("All changes saved");

  expect(posts).toHaveLength(2);
  expect(posts[1]!.body).toBe(posts[0]!.body);
  expect(posts[1]!.key).toBe(posts[0]!.key);
  expect(posts[0]).toMatchObject({ authorization: "Bearer token-a", cookie: undefined });
  expect(JSON.parse(posts[0]!.body!)).toMatchObject({
    expectedVersion: 0,
    state: "draft",
    content: { kind: "readiness_map", notes: "Browser exact retry" },
  });
});

test("production conflict preserves the draft, renders the fresh teammate comparison, and stays sticky", async ({ page }) => {
  let detailReads = 0;
  let postCount = 0;
  await page.route(/\/v1\/member\/artifacts(?:\/.*)?$/u, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      postCount += 1;
      await json(route, { error: { code: "VERSION_CONFLICT", message: "Changed", correlationId } }, 409);
      return;
    }
    if (path === "/v1/member/artifacts") { await json(route, list()); return; }
    detailReads += 1;
    await json(route, detailFor(path.split("/").at(-1)!, detailReads > 1 ? "Teammate latest" : undefined));
  });

  await page.goto("/learn/plan");
  await page.getByLabel("Notes").fill("My unsynced browser draft");
  const conflictAlert = page.getByRole("alert").filter({ hasText: "changed in another session" });
  await expect(conflictAlert).toBeVisible();
  await expect(page.getByRole("region", { name: "Conflict comparison" })).toContainText("Teammate latest");
  await expect(page.getByLabel("Notes")).toHaveValue("My unsynced browser draft");
  await page.getByLabel("Notes").fill("Still sticky and unsynced");
  await page.waitForTimeout(750);
  expect(postCount).toBe(1);
  await expect(conflictAlert).toBeVisible();
});

test("late artifact GET and POST results from an old Clerk session cannot enter the new session", async ({ page }) => {
  let oldDetailRoute: Route | undefined;
  let releaseOldDetail: (() => void) | undefined;
  let oldPostRoute: Route | undefined;
  let releaseOldPost: (() => void) | undefined;
  await page.route(/\/v1\/member\/artifacts(?:\/.*)?$/u, async (route) => {
    const request = route.request();
    const authorization = request.headers().authorization;
    const path = new URL(request.url()).pathname;
    const token = authorization?.replace("Bearer ", "") ?? "";
    if (request.method() === "POST" && token === "token-b") {
      oldPostRoute = route;
      await new Promise<void>((resolve) => { releaseOldPost = resolve; });
      await json(route, savedReadiness("Session B pending", 2), 201);
      return;
    }
    if (path === "/v1/member/artifacts") {
      if (token === "token-a") { await json(route, list()); return; }
      await json(route, list([readinessSummary(), ...summaries.slice(1)]));
      return;
    }
    const id = path.split("/").at(-1)!;
    if (token === "token-a" && id === summaries[1]!.id) {
      oldDetailRoute = route;
      await new Promise<void>((resolve) => { releaseOldDetail = resolve; });
      await json(route, { schemaVersion: 1, artifact: summaries[1], content: { ...emptyContent.ai_policy, purpose: "Old session secret" } });
      return;
    }
    await json(route, detailFor(id, token === "token-b" ? "Session B content" : token === "token-c" ? "Session C content" : undefined));
  });

  await page.goto("/learn/plan");
  await page.getByRole("tab", { name: /AI policy/iu }).click();
  await expect.poll(() => oldDetailRoute !== undefined).toBe(true);
  await page.evaluate(() => (window as unknown as { __syntholoSetSession(id: string, token: string): void })
    .__syntholoSetSession("session-b", "token-b"));
  await expect(page.getByLabel("Notes")).toHaveValue("Session B content");
  releaseOldDetail!();
  await expect(page.getByText("Old session secret")).toHaveCount(0);

  await page.getByLabel("Notes").fill("Session B pending");
  await expect.poll(() => oldPostRoute !== undefined).toBe(true);
  await page.evaluate(() => (window as unknown as { __syntholoSetSession(id: string, token: string): void })
    .__syntholoSetSession("session-c", "token-c"));
  await expect(page.getByLabel("Notes")).toHaveValue("Session C content");
  releaseOldPost!();
  await expect(page.getByLabel("Notes")).toHaveValue("Session C content");
  await expect(page.getByText("Session B pending")).toHaveCount(0);
});

test("mobile production implementation shell has four 44px links, no overflow, and no axe violations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/\/v1\/member\/artifacts(?:\/.*)?$/u, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/member/artifacts") { await json(route, list()); return; }
    await json(route, detailFor(path.split("/").at(-1)!));
  });
  await page.goto("/learn/plan");
  await expect(page.getByRole("heading", { name: "Your implementation plan" })).toBeVisible();
  for (const name of ["Home", "Course", "Plan", "Workflows"]) {
    const link = page.getByRole("link", { name, exact: true });
    await expect(link).toBeVisible();
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
});
