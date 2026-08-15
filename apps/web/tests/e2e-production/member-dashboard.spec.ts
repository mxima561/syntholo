import { expect, test, type Page, type Route } from "@playwright/test";

const clerkFixture = `(() => {
  const user = { id: "clerk_browser_user", organizationMemberships: [] };
  const session = {
    id: "clerk_browser_session", status: "active", actor: null, factorVerificationAge: null,
    lastActiveToken: { jwt: { claims: { sid: "clerk_browser_session", sub: "clerk_browser_user" } } },
    getToken: async () => "production-browser-clerk-token"
  };
  const resources = { client: { id: "client_browser" }, session, user, organization: null };
  window.__internal_ClerkUICtor = function ClerkUI() {};
  window.Clerk = {
    loaded: true, status: "ready", client: resources.client, session, user, organization: null,
    telemetry: { record() {} }, __internal_lastEmittedResources: resources,
    addListener(listener, options) {
      if (!options || options.skipInitialEmit !== true) listener(resources);
      return () => {};
    },
    on(event, listener, options) {
      if (event === "status" && options && options.notify) listener("ready");
      return () => {};
    },
    off() {}
  };
})();`;

const accountId = "10000000-0000-4000-8000-000000000001";
const courseId = "10000000-0000-4000-8000-000000000010";
const courseVersionId = "10000000-0000-4000-8000-000000000011";
const enrollmentId = "10000000-0000-4000-8000-000000000012";
const stageId = "10000000-0000-4000-8000-000000000013";
const lessonId = "10000000-0000-4000-8000-000000000021";
const lessonVersionId = "10000000-0000-4000-8000-000000000022";
const nextLessonId = "10000000-0000-4000-8000-000000000023";
const availableAt = "2026-08-14T20:00:00.000Z";

const access = {
  accountId,
  capabilities: { academy_course: true, support: false, circle_write: false, operator_club: false, business_os: false },
  holds: [], seatLimit: 3, reservedSeats: 1,
  explanations: [
    { capability: "academy_course", sourceGrantIds: ["20000000-0000-4000-8000-000000000001"] },
    { capability: "support", sourceGrantIds: [] }, { capability: "circle_write", sourceGrantIds: [] },
    { capability: "operator_club", sourceGrantIds: [] }, { capability: "business_os", sourceGrantIds: [] },
  ],
};

const course = {
  schemaVersion: 1, enrollmentId,
  course: {
    id: courseId, versionId: courseVersionId, title: "Production Browser Academy",
    description: "A server-owned implementation course for this signed-in account.",
  },
  stages: [{
    id: stageId, title: "Map the system", order: 1,
    lessons: [{
      id: lessonId, lessonVersionId, order: 1, required: true, title: "Map the constraint",
      summary: "Name the bottleneck before changing the system.", durationSeconds: 600,
      releaseRule: { kind: "immediate" }, availability: "available", availableAt, progress: "not_started",
    }],
  }],
  progress: { completedRequired: 0, requiredTotal: 18, percent: 0 },
};

const dashboard = {
  schemaVersion: 2, generatedAt: "2026-08-14T20:00:00.123Z",
  account: { id: accountId, name: "Production Browser Account" }, access,
  experience: { state: "ready" }, learning: { state: "available", course },
  nextBestStep: { kind: "lesson", reason: "next_required_lesson", target: { courseId, lessonId } },
};

const lesson = {
  schemaVersion: 1, enrollmentId, courseVersionId, lessonId, lessonVersionId,
  title: "Map the constraint", summary: "Name the bottleneck before changing the system.", durationSeconds: 600,
  blocks: [{
    type: "action", blockId: "action-1", title: "Write the constraint statement",
    instructions: "Name the system, the bottleneck, and the evidence.",
  }],
  transcript: { schemaVersion: 1, blocks: [
    { blockId: "transcript-1", text: "Start with the customer promise." },
    { blockId: "transcript-2", text: "Then trace the work backwards." },
  ] },
  resources: [{
    id: "10000000-0000-4000-8000-000000000024", label: "Constraint worksheet",
    accessibleLabel: "Constraint worksheet download", delivery: "private_blob", mime: "application/pdf",
    byteSize: 2048, availability: "unavailable",
  }],
  progress: { revision: null, state: "not_started", lastPath: null, position: null },
  previousRequiredLessonId: null, nextRequiredLessonId: nextLessonId,
};

const degradedPlayback = {
  schemaVersion: 1, lessonVersionId, playbackStatus: "degraded", reason: "MUX_UNAVAILABLE",
  fallback: {
    title: lesson.title, summary: lesson.summary, blocks: lesson.blocks,
    transcript: lesson.transcript, resources: lesson.resources,
  },
};

async function installClerk(page: Page) {
  await page.route(/^https:\/\/(?!127\.0\.0\.1:3200\/).+/u, async (route) => {
    if (route.request().resourceType() !== "script") { await route.abort(); return; }
    await route.fulfill({ body: clerkFixture, contentType: "application/javascript; charset=utf-8", status: 200 });
  });
}

async function json(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  await route.fulfill({
    body: JSON.stringify(body),
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", ...headers },
    status,
  });
}

test.beforeEach(async ({ page }) => installClerk(page));

test("production Clerk bearer journey opens the pinned course, resumes transcript, and completes with the authoritative next lesson", async ({ page }) => {
  const requests: Array<{
    path: string;
    authorization?: string;
    body?: string | null;
    cookie?: string;
    dashboardVersion?: string;
    idempotencyKey?: string;
  }> = [];
  await page.route("**/v1/member/dashboard", (route) => json(route, dashboard, 200, {
    "syntholo-dashboard-version": "2", vary: "Authorization, Syntholo-Dashboard-Version",
  }));
  await page.route(`**/v1/member/lessons/${lessonId}`, (route) => json(route, lesson));
  await page.route(`**/v1/member/lessons/${lessonId}/playback`, (route) => json(route, degradedPlayback));
  await page.route(`**/v1/member/lessons/${lessonId}/resume`, (route) => json(route, {
    revision: 1, state: "in_progress", lastPath: "transcript", position: { blockId: "transcript-2" },
  }));
  await page.route(`**/v1/member/lessons/${lessonId}/complete`, (route) => json(route, {
    schemaVersion: 1,
    lessonCompletion: {
      id: "10000000-0000-4000-8000-000000000025", lessonVersionId, method: "transcript",
      completedAt: "2026-08-15T12:00:00.000Z",
    },
    courseCompletion: null, nextRequiredLessonId: nextLessonId,
  }));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/v1/member/")) return;
    requests.push({
      path: url.pathname, authorization: request.headers().authorization, body: request.postData(),
      cookie: request.headers().cookie,
      dashboardVersion: request.headers()["syntholo-dashboard-version"],
      idempotencyKey: request.headers()["idempotency-key"],
    });
  });

  await page.goto("/learn");
  await expect(page.getByRole("heading", { name: "Production Browser Account" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Production Browser Academy" })).toBeVisible();
  await page.getByRole("link", { name: "Open the full course map" }).click();
  await expect(page).toHaveURL(/\/learn\/course$/u);
  await page.getByRole("link", { name: /Map the constraint/u }).click();
  await expect(page).toHaveURL(new RegExp(`/learn/course/${lessonId}$`, "u"));
  await expect(page.getByRole("heading", { name: lesson.title })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Video is unavailable right now");
  await expect(page.getByRole("tab", { name: "Transcript" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".production-transcript article p", { hasText: "Start with the customer promise." })).toBeVisible();
  await page.getByRole("button", { name: /Save position at Then trace/u }).click();
  await page.getByRole("button", { name: "Mark lesson complete" }).click();
  await expect(page.getByRole("heading", { name: "Lesson completed" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Next lesson" })).toHaveAttribute("href", `/learn/course/${nextLessonId}`);
  await expect(page.getByText("Constraint worksheet")).toBeVisible();
  await expect(page.getByText("Download unavailable in this release")).toBeVisible();

  expect(requests.every((request) => request.authorization === "Bearer production-browser-clerk-token")).toBe(true);
  expect(requests.find((request) => request.path === "/v1/member/dashboard")).toMatchObject({
    cookie: undefined,
    dashboardVersion: "2",
  });
  expect(requests.find((request) => request.path.endsWith("/resume"))?.body).toBe(JSON.stringify({
    expectedVersion: 0, path: "transcript", position: { blockId: "transcript-2" },
  }));
  expect(requests.find((request) => request.path.endsWith("/complete"))).toMatchObject({
    body: JSON.stringify({ method: "transcript" }), idempotencyKey: expect.stringMatching(/^lesson-complete-/u),
  });
  await expect(page.locator("body")).not.toContainText(/Maria|Northstar|coach online/iu);
});

test("production direct locked lesson shows its release time without content or completion controls", async ({ page }) => {
  const lockedAt = "2026-08-22T12:00:00.000Z";
  await page.route(`**/v1/member/lessons/${lessonId}`, (route) => json(route, {
    error: {
      code: "LESSON_NOT_RELEASED", message: "Lesson not released",
      correlationId: "40000000-0000-4000-8000-000000000001", details: { availableAt: lockedAt },
    },
  }, 403));
  await page.route(`**/v1/member/lessons/${lessonId}/playback`, (route) => json(route, degradedPlayback));

  await page.goto(`/learn/course/${lessonId}`);
  await expect(page.getByRole("heading", { name: "This lesson is not released yet" })).toBeVisible();
  await expect(page.getByText(/Aug 22, 2026/u)).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to course map" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark lesson complete" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Transcript" })).toHaveCount(0);
});

test("production playback refresh removes lesson content when authorization can no longer be reconfirmed", async ({ page }) => {
  let playbackCalls = 0;
  await page.route(`**/v1/member/lessons/${lessonId}`, (route) => json(route, lesson));
  await page.route(`**/v1/member/lessons/${lessonId}/playback`, (route) => {
    playbackCalls += 1;
    if (playbackCalls > 1) return json(route, { error: { code: "COURSE_ACCESS_REQUIRED" } }, 403);
    return json(route, {
      schemaVersion: 1, lessonVersionId, playbackStatus: "ready",
      mux: {
        playbackId: "signed-playback-id", playbackToken: "signed-playback-token",
        issuedAt: "2026-08-15T12:00:00.000Z", refreshAfter: "2020-08-15T12:00:00.000Z",
        expiresAt: "2030-08-15T12:14:00.000Z",
      },
    });
  });

  await page.goto(`/learn/course/${lessonId}`);
  await expect(page.getByRole("heading", { name: "Access could not be reconfirmed" })).toBeVisible();
  await expect(page.getByRole("heading", { name: lesson.title })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Transcript" })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("signed-playback-token");
});
