# Content, Learning, and Certificates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace demo lesson data with a versioned admin publishing system, production learning/progress and shared-output persistence, Mux-backed accessible lessons, immutable completion achievements, and private unaccredited PDF certificates after all 18 required lessons.

**Architecture:** PostgreSQL stores courses, immutable published lesson versions, JSONB content blocks, member progress, shared artifacts, completion facts, and certificate records. Mux owns video/caption delivery; Vercel Blob owns private resource/certificate bytes. The API validates publication and progress, the worker generates certificates, and a signed readiness report is the only input that can unblock Academy payment availability.

**Tech Stack:** Fastify, Zod, Drizzle/PostgreSQL JSONB, Mux, Vercel Blob, `pdf-lib`, Resend jobs, Next.js App Router, React, Vitest, PostgreSQL integration tests, and Playwright.

## Global Constraints

- This plan starts after the foundation gate; commerce may proceed in parallel only through the shared `ContentLaunchReadiness` contract.
- Published lesson versions are immutable. Edits create drafts; publish supersedes/archives rather than mutating content already tied to progress.
- A publishable lesson requires title, summary, ready video, captions, transcript, duration, action, resources, accessibility approval, and required commercial disclosure.
- The paid Academy gate requires exactly 18 required published lessons for one approved course version and no placeholder markers.
- Transcript is an equivalent learning path; video watch percentage is not required for completion.
- Personal progress belongs to member + enrollment; implementation outputs belong to account and use optimistic concurrency.
- Completion is recorded once against the enrolled course version and cannot be revoked by later content publication.
- Certificate eligibility uses only the immutable completion fact. Tier, refund, dispute, support expiry, seat reassignment, and Business OS state are not inputs.
- Certificates are unaccredited PDFs with no public lookup, certificate ID, verification claim, or accreditation copy.
- Private asset access uses short-lived signed URLs after authorization; URLs are never written to analytics or audit payloads.

## Planned File Map

- `packages/contracts/src/content/**` — course, lesson block, publication, asset, learning, progress, artifact, completion, and certificate schemas.
- `packages/domain/src/content/**` — publication and course-version rules.
- `packages/domain/src/learning/**` — progress/completion state rules.
- `packages/database/src/schema/{content,learning,implementation}.ts` — production records.
- `packages/database/src/repositories/{content,learning,artifacts,certificates}.ts` — scoped data access.
- `packages/integrations/src/{mux,blob}/**` — provider ports/adapters.
- `apps/api/src/modules/{content,learning,implementation,certificates}/**` — use cases.
- `apps/api/src/routes/{member,staff,webhooks}/**` — lesson/admin/provider endpoints.
- `apps/worker/src/handlers/{content,certificates}/**` — processing and delivery.
- `apps/web/src/app/admin/content/**` — editor, preview, schedule, version history.
- `apps/web/src/app/learn/course/**` — member course and lesson workspace.

---

### Task 1: Define structured lesson blocks and course/version schemas

**Files:**
- Create: `packages/contracts/src/content/{blocks,courses,lessons}.ts`
- Create: `packages/contracts/src/content/blocks.test.ts`
- Create: `packages/database/src/schema/content.ts`
- Create: `packages/database/drizzle/0008_content.sql`
- Create: `packages/database/src/content.integration.test.ts`

**Interfaces:**
- Produces discriminated `LessonBlockSchema` variants: `rich_text`, `callout`, `action`, `resource_list`, `disclosure`, and `embed`.
- Produces course version states `draft | scheduled | published | archived` and lesson version states with the same lifecycle.
- Published rows reference immutable `lesson_version_id`; editable draft blocks live in JSONB validated by Zod before persistence.

- [ ] **Step 1: Write the block/schema RED tests**

```ts
it("rejects unknown or unsafe content blocks", () => {
  expect(() => LessonBlockSchema.parse({ type: "html", html: "<script>alert(1)</script>" })).toThrow();
});

it("requires one action block and one disclosure block", () => {
  expect(validateLessonDraft(draft({ blocks: [richText("Intro")] })).issues)
    .toEqual(expect.arrayContaining([expect.objectContaining({ code: "ACTION_REQUIRED" })]));
});
```

- [ ] **Step 2: Run RED**

Run `npm test -w @syntholo/contracts -- src/content/blocks.test.ts`.

Expected: schemas do not exist.

- [ ] **Step 3: Implement exact schemas and database constraints**

Use sanitized structured text rather than arbitrary HTML; resources store label, asset ID, and accessibility label. Constrain unique course-version lesson order and prevent published version updates with a database trigger.

```ts
export const LessonBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rich_text"), text: z.string().min(1).max(20_000) }),
  z.object({ type: z.literal("callout"), tone: z.enum(["info", "warning"]), text: z.string().min(1).max(2_000) }),
  z.object({ type: z.literal("action"), title: z.string().min(1), instructions: z.string().min(1) }),
  z.object({ type: z.literal("resource_list"), items: z.array(ResourceSchema).min(1) }),
  z.object({ type: z.literal("disclosure"), policyVersion: z.string().min(1), text: z.string().min(1) }),
  z.object({ type: z.literal("embed"), provider: z.enum(["mux"]), assetId: z.string().min(1) }),
]);
```

- [ ] **Step 4: Run GREEN and immutability integration tests**

Attempt to update a published version and expect a database exception; draft update must pass.

Run: `npm test -w @syntholo/contracts -- src/content/blocks.test.ts && npm run test:integration -w @syntholo/database -- content.integration.test.ts`

Expected: PASS; the published update fails with the expected immutability constraint and draft update succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat: model versioned Academy content"
```

### Task 2: Implement staff content draft, preview, schedule, publish, and archive APIs

**Files:**
- Create: `packages/domain/src/content/{validation,lifecycle}.ts`
- Create: `packages/domain/src/content/{validation,lifecycle}.test.ts`
- Create: `packages/database/src/repositories/content.ts`
- Create: `apps/api/src/modules/content/{create-draft,update-draft,preview,publish,archive}.ts`
- Create: `apps/api/src/routes/staff/content.ts`
- Create: `apps/api/src/modules/content/content.integration.test.ts`
- Create: `apps/worker/src/handlers/content/publish-scheduled.ts`
- Create: `apps/worker/src/handlers/content/publish-scheduled.integration.test.ts`

**Interfaces:**
- Produces admin-only `POST/PATCH /v1/staff/content/...` commands with `expectedVersion` optimistic concurrency.
- `publishLesson(command, actor)` returns immutable lesson version and emits `content.lesson_published.v1` in the same transaction.
- Publication requires recent auth, `content:publish` permission, and an audit reason.

- [ ] **Step 1: Write lifecycle and authorization RED tests**

Cover draft update, stale expected version, coach denial, missing publish permission, missing readiness field, schedule in past, publish, supersede, and attempted published edit.

```ts
it("returns all publication blockers", () => {
  expect(validateLessonForPublication(incompleteLesson()).map((issue) => issue.code)).toEqual([
    "VIDEO_NOT_READY", "CAPTIONS_REQUIRED", "TRANSCRIPT_REQUIRED", "ACTION_REQUIRED",
    "RESOURCE_REQUIRED", "ACCESSIBILITY_REVIEW_REQUIRED", "DISCLOSURE_REQUIRED",
  ]);
});

it("rejects a stale draft write", async () => {
  await expect(updateDraft(command({ expectedVersion: 1 }), depsWithCurrentVersion(2)))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/content && npm run test:integration -w @syntholo/api -- content.integration.test.ts`

Expected: FAIL because publication validation and lifecycle commands do not exist.

- [ ] **Step 3: Implement pure validation and lifecycle transitions**

Return stable issues such as `VIDEO_NOT_READY`, `CAPTIONS_REQUIRED`, `TRANSCRIPT_REQUIRED`, `ACTION_REQUIRED`, `RESOURCE_REQUIRED`, `ACCESSIBILITY_REVIEW_REQUIRED`, and `DISCLOSURE_REQUIRED`.

```ts
export function validateLessonForPublication(lesson: LessonDraft): readonly PublicationIssue[] {
  return [
    !lesson.videoReady && issue("VIDEO_NOT_READY"),
    !lesson.captionsAssetId && issue("CAPTIONS_REQUIRED"),
    !lesson.transcriptAssetId && issue("TRANSCRIPT_REQUIRED"),
    !lesson.blocks.some((block) => block.type === "action") && issue("ACTION_REQUIRED"),
    !lesson.blocks.some((block) => block.type === "resource_list") && issue("RESOURCE_REQUIRED"),
    !lesson.accessibilityApprovedAt && issue("ACCESSIBILITY_REVIEW_REQUIRED"),
    !lesson.blocks.some((block) => block.type === "disclosure") && issue("DISCLOSURE_REQUIRED"),
  ].filter(isPublicationIssue);
}
```

- [ ] **Step 4: Implement transactional commands and audit/outbox events**

Publishing copies validated draft data into a new immutable version, updates course-version ordering, records actor/reason, and emits an event; scheduling enqueues one idempotent publication job handled by `publish-scheduled.ts` under a stored authorizing admin decision.

```ts
export async function publishLesson(command: PublishLesson, deps: ContentDeps) {
  requirePermission(command.actor, "content:publish");
  requireRecentAuth(command.actor, 300);
  return deps.uow.transaction(async (tx) => {
    const draft = await tx.content.lockDraft(command.lessonId, command.expectedVersion);
    assertNoPublicationIssues(validateLessonForPublication(draft));
    const version = await tx.content.publishImmutableVersion(draft, command.actor.staffId);
    await tx.audit.append(lessonPublishedAudit(version, command.actor, command.reason));
    await tx.outbox.enqueue(lessonPublishedEvent(version));
    return version;
  });
}
```

- [ ] **Step 5: Run GREEN**

```bash
npm test -w @syntholo/domain -- src/content
npm run test:integration -w @syntholo/api -- content.integration.test.ts
npm run test:integration -w @syntholo/worker -- publish-scheduled.integration.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/api packages
git commit -m "feat: add audited lesson publishing"
```

### Task 3: Integrate Mux asset readiness, captions, transcripts, and signed playback

**Files:**
- Create: `packages/integrations/src/mux/{port,adapter}.ts`
- Create: `packages/contracts/src/content/assets.ts`
- Create: `packages/database/src/schema/content-assets.ts`
- Create: `packages/database/drizzle/0009_content_assets.sql`
- Create: `apps/api/src/routes/webhooks/mux.ts`
- Create: `apps/api/src/modules/content/process-mux-event.ts`
- Create: `apps/api/src/routes/member/lesson-playback.ts`
- Create: `apps/api/src/modules/content/mux.integration.test.ts`

**Interfaces:**
- Consumes raw signed Mux webhook and claims `(provider, event_id)` once.
- Maps asset states `waiting | preparing | ready | errored`; publication sees only internal readiness fields.
- Produces short-lived signed playback data only after member entitlement and enrollment checks.

- [ ] **Step 1: Write signature/replay/readiness RED tests**

Cover invalid signature, duplicate ready event, errored asset, ready video without captions, caption/transcript attachment, unauthorized playback, and transcript fallback.

```ts
it("does not make video-only content publishable", async () => {
  await processMuxEvent(muxReadyEvent("asset_1"), deps);
  const readiness = await content.getAssetReadiness("asset_1");
  expect(readiness).toMatchObject({ video: "ready", captions: "missing", transcript: "missing" });
});

it("denies playback without Academy access", async () => {
  await expect(getLessonPlayback(command(), depsWithAccess(false))).rejects.toMatchObject({ code: "COURSE_ACCESS_REQUIRED" });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/integrations -- mux && npm run test:integration -w @syntholo/api -- mux.integration.test.ts`

Expected: FAIL because signed Mux event processing and playback authorization do not exist.

- [ ] **Step 3: Implement Mux adapter and event mapping**

Store Mux asset/playback/text-track identifiers, never provider secrets. Transcript text is private lesson content and never enters logs, PostHog, or Sentry.

```ts
export function applyMuxEvent(asset: ContentAsset, event: MuxEvent): ContentAsset {
  switch (event.type) {
    case "video.asset.ready": return { ...asset, state: "ready", playbackId: event.playbackId };
    case "video.asset.errored": return { ...asset, state: "errored", safeErrorCode: "MUX_ASSET_ERRORED" };
    case "video.asset.track.ready": return attachTextTrack(asset, event.track);
    default: return asset;
  }
}
```

- [ ] **Step 4: Implement authorized signed playback**

The API verifies `academy_course`, active membership, and enrollment; returns signed playback token plus caption metadata. If Mux is degraded, return transcript/summary/action/resources with `playbackStatus: "degraded"`.

```ts
export async function getLessonPlayback(command: GetLessonPlayback, deps: PlaybackDeps): Promise<LessonPlaybackResponse> {
  const lesson = await deps.learning.authorizeLesson(command.actor, command.lessonId);
  if (lesson.asset.state !== "ready") return { playbackStatus: "degraded", transcript: lesson.transcript, summary: lesson.summary, action: lesson.action, resources: lesson.resources };
  return {
    playbackStatus: "ready",
    playbackToken: await deps.mux.signPlayback(lesson.asset.playbackId, { expiresInSeconds: 300 }),
    captions: lesson.asset.captions,
    transcript: lesson.transcript,
  };
}
```

- [ ] **Step 5: Run GREEN**

Run: `npm test -w @syntholo/integrations -- mux && npm run test:integration -w @syntholo/api -- mux.integration.test.ts`

Expected: PASS, including signature, replay, transcript fallback, and playback authorization.

- [ ] **Step 6: Commit**

```bash
git add apps packages
git commit -m "feat: add production lesson media"
```

### Task 4: Build the admin content editor and immutable preview

**Files:**
- Create: `apps/web/src/features/content-editor/{editor,block-editor,validation-panel,version-history}.tsx`
- Create: `apps/web/src/features/content-editor/editor.test.tsx`
- Modify: `apps/web/src/app/admin/content/page.tsx`
- Create: `apps/web/src/app/admin/content/[lessonId]/page.tsx`
- Create: `apps/web/src/app/admin/content/[lessonId]/preview/page.tsx`
- Create: `apps/web/tests/e2e/content-admin.spec.ts`

**Interfaces:**
- Consumes typed staff content routes; never imports database or vendor adapters.
- Produces explicit save-draft, preview, schedule, publish, archive, and version-history actions.
- Saves with `expectedVersion`; conflict response offers reload or copy-current-draft, never blind overwrite.

- [ ] **Step 1: Write editor RED component tests**

Test required-field issues, add/reorder blocks, save conflict, publish disabled with readiness issues, preview exact version, and successful publish confirmation requiring reason.

```tsx
it("blocks publication and announces readiness issues", async () => {
  render(<ContentEditor initialDraft={incompleteDraft()} api={fakeContentApi()} />);
  await userEvent.click(screen.getByRole("button", { name: "Publish" }));
  expect(screen.getByRole("status")).toHaveTextContent("Captions required");
  expect(screen.getByRole("button", { name: "Confirm publish" })).toBeDisabled();
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/web -- content-editor && npm run test:e2e -w @syntholo/web -- content-admin.spec.ts`

Expected: current admin content screen is demo-only.

- [ ] **Step 3: Implement focused editor components**

Use controlled structured inputs, autosave draft only after explicit first save, announce validation with `aria-live`, and show media/caption/transcript status separately.

```tsx
export function ValidationPanel({ issues }: { issues: readonly PublicationIssue[] }) {
  return (
    <section aria-labelledby="validation-title">
      <h2 id="validation-title">Publication readiness</h2>
      <ul aria-live="polite">{issues.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul>
    </section>
  );
}
```

- [ ] **Step 4: Add browser journey and run GREEN**

Create draft → add all required content → preview → publish → reopen → verify immutable history and new draft creation.

```ts
test("publishes an immutable lesson version", async ({ page }) => {
  await adminFixture.signIn(page, { permissions: ["content:publish"] });
  await page.goto("/admin/content/lesson-1");
  await contentFixture.fillPublishableLesson(page);
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByLabel("Reason").fill("Curriculum approval");
  await page.getByRole("button", { name: "Confirm publish" }).click();
  await expect(page.getByText("Published version 1")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit published version" })).toHaveCount(0);
});
```

Run: `npm test -w @syntholo/web -- content-editor && npm run test:e2e -w @syntholo/web -- content-admin.spec.ts`

Expected: PASS for the complete draft/preview/publish/version-history journey.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: add Academy content editor"
```

### Task 5: Implement member course access, lesson queries, and resume state

**Files:**
- Create: `packages/contracts/src/learning/{course,progress}.ts`
- Create: `packages/database/src/schema/learning.ts`
- Create: `packages/database/drizzle/0010_learning.sql`
- Create: `packages/database/src/repositories/learning.ts`
- Create: `apps/api/src/modules/learning/{get-course,get-lesson,save-resume}.ts`
- Create: `apps/api/src/routes/member/learning.ts`
- Create: `apps/api/src/modules/learning/learning.integration.test.ts`
- Modify: `apps/web/src/app/learn/course/page.tsx`
- Modify: `apps/web/src/app/learn/course/[lessonId]/page.tsx`

**Interfaces:**
- Produces member-scoped `GET /v1/member/courses/:courseId`, `GET /v1/member/lessons/:lessonId`, and idempotent `PUT /v1/member/lessons/:lessonId/resume`.
- Resume stores seconds and last learning path `video | transcript`; it does not imply completion.
- Lesson query returns the immutable version tied to enrollment, not the newest arbitrary draft.

- [ ] **Step 1: Write access/version/resume RED tests**

Cover no grant, wrong account, inactive membership, enrolled version, later published version, transcript path, resume monotonic timestamp, and idempotent replay.

```ts
it("loads the course version pinned to enrollment", async () => {
  const enrollment = await seedEnrollment({ courseVersionId: "version_1" });
  await publishCourseVersion("version_2");
  const course = await getCourse(command({ enrollmentId: enrollment.id }), deps);
  expect(course.versionId).toBe("version_1");
});

it("does not treat resume as completion", async () => {
  await saveResume(command({ seconds: 500, path: "transcript" }), deps);
  expect(await learning.countCompletions(memberId)).toBe(0);
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test:integration -w @syntholo/api -- learning.integration.test.ts && npm test -w @syntholo/web -- lesson-workspace`

Expected: FAIL because production lesson queries and resume persistence do not exist.

- [ ] **Step 3: Implement scoped queries and resume command**

Derive account/member from actor, evaluate entitlement, load enrollment course version, and return only published accessible content. Resume updates use command idempotency and do not accept account/member IDs from browser.

```ts
export async function getLesson(command: GetLesson, deps: LearningDeps) {
  const access = await deps.entitlements.forActor(command.actor);
  if (!access.capabilities.academy_course) throw new AppError("COURSE_ACCESS_REQUIRED", 403, "Course access required");
  return deps.learning.getPublishedLesson({
    accountId: command.actor.accountId,
    membershipId: command.actor.membershipId,
    lessonId: command.lessonId,
  });
}
```

- [ ] **Step 4: Replace demo repository reads in course UI**

Keep the approved lesson workspace, loading skeleton, transcript fallback, and local unsynced resume indicator during a database outage.

```tsx
export async function LessonPage({ params }: PageProps<"/learn/course/[lessonId]">) {
  const { lessonId } = await params;
  const lesson = await memberApi().getLesson(lessonId);
  return <LessonWorkspace lesson={lesson} playback={<LessonPlayback lessonId={lessonId} />} />;
}
```

- [ ] **Step 5: Run GREEN**

Run: `npm run test:integration -w @syntholo/api -- learning.integration.test.ts && npm test -w @syntholo/web -- lesson-workspace course && npm run test:e2e -w @syntholo/web -- content-learning.spec.ts`

Expected: PASS at desktop/mobile with the enrollment-pinned version and transcript fallback.

- [ ] **Step 6: Commit**

```bash
git add apps packages
git commit -m "feat: serve production Academy lessons"
```

### Task 6: Implement personal completion and immutable achievement facts

**Files:**
- Create: `packages/domain/src/learning/{progress,completion}.ts`
- Create: `packages/domain/src/learning/{progress,completion}.test.ts`
- Create: `apps/api/src/modules/learning/{complete-lesson,record-course-completion}.ts`
- Create: `apps/api/src/routes/member/progress.ts`
- Create: `apps/api/src/modules/learning/completion.integration.test.ts`
- Modify: `apps/web/src/features/course/progress.ts`

**Interfaces:**
- Produces idempotent `POST /v1/member/lessons/:lessonId/complete` with completion method `video | transcript | mixed`.
- Produces immutable `lesson_completion` and one `course_completion` per member/enrollment/course version.
- Emits exactly one `learning.course_completed.v1` when all 18 required lesson IDs in the enrolled version are complete.

- [ ] **Step 1: Write completion RED tests**

Test transcript-only completion, duplicate command, 17/18, 18/18, non-required bonus lesson, new lesson published later, two teammates independent completion, and refund/support expiry independence.

```ts
it("records completion from the transcript path", async () => {
  const result = await completeLesson(command({ method: "transcript" }), deps);
  expect(result.lessonCompletion.method).toBe("transcript");
});

it("emits course completion exactly at 18 required lessons", async () => {
  await seedRequiredCompletions(memberId, 17);
  await completeLesson(command({ lessonId: requiredLessonIds[17] }), deps);
  expect(await outbox.count("learning.course_completed.v1")).toBe(1);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/learning && npm run test:integration -w @syntholo/api -- completion.integration.test.ts`

Expected: FAIL because immutable lesson/course completion writes do not exist.

- [ ] **Step 3: Implement pure eligibility and transactional completion**

Count the required IDs stored on the immutable course version; do not count current published catalog size. Insert lesson completion with unique member/enrollment/version key, then insert course completion and outbox event with conflict-safe uniqueness.

```ts
export function isCourseComplete(requiredLessonIds: readonly string[], completedLessonIds: ReadonlySet<string>): boolean {
  return requiredLessonIds.length === 18 && requiredLessonIds.every((id) => completedLessonIds.has(id));
}

export async function completeLesson(command: CompleteLesson, deps: LearningDeps) {
  return deps.uow.transaction(async (tx) => {
    const completion = await tx.learning.insertLessonCompletionOnce(command);
    const snapshot = await tx.learning.getCompletionSnapshot(command.enrollmentId, command.actor.membershipId);
    if (isCourseComplete(snapshot.requiredLessonIds, new Set(snapshot.completedLessonIds))) {
      await tx.learning.insertCourseCompletionAndEventOnce(snapshot, tx.outbox);
    }
    return completion;
  });
}
```

- [ ] **Step 4: Wire member completion UI and run GREEN**

The action works from video or transcript path and returns the next lesson. The UI never computes certificate eligibility itself.

```tsx
export function CompleteLessonButton({ lessonId, method, api }: CompleteLessonButtonProps) {
  const [state, setState] = useState<CompletionState>({ status: "idle" });
  const complete = async () => setState({ status: "done", result: await api.completeLesson(lessonId, method, crypto.randomUUID()) });
  return <Button onClick={() => void complete()} disabled={state.status === "loading"}>Mark lesson complete</Button>;
}
```

Run: `npm test -w @syntholo/domain -- src/learning && npm run test:integration -w @syntholo/api -- completion.integration.test.ts && npm test -w @syntholo/web -- progress`

Expected: PASS with one course-completion event at 18/18 and none at 17/18.

- [ ] **Step 5: Commit**

```bash
git add apps packages
git commit -m "feat: record immutable Academy completion"
```

### Task 7: Persist account-shared outputs and artifact versions

**Files:**
- Create: `packages/contracts/src/implementation/artifacts.ts`
- Create: `packages/domain/src/implementation/versioning.ts`
- Create: `packages/domain/src/implementation/versioning.test.ts`
- Create: `packages/database/src/schema/implementation.ts`
- Create: `packages/database/drizzle/0011_implementation.sql`
- Create: `packages/database/src/repositories/artifacts.ts`
- Create: `apps/api/src/modules/implementation/{list,save-version}.ts`
- Create: `apps/api/src/routes/member/artifacts.ts`
- Create: `apps/api/src/modules/implementation/artifacts.integration.test.ts`
- Modify: `apps/web/src/app/learn/{plan,workflows}/page.tsx`

**Interfaces:**
- Artifact belongs to `accountId`; version records store immutable structured output and creator member ID.
- `saveArtifactVersion({ artifactId, expectedVersion, content, actor })` returns `409 VERSION_CONFLICT` on stale write.
- Review state is not changed here; the human-operations plan owns the review lock and points to an exact artifact version.

- [ ] **Step 1: Write shared-scope/conflict RED tests**

Owner saves v1; teammate sees v1; teammate saves v2; stale owner write fails; other account is denied; artifact history remains intact.

```ts
it("shares versions inside one account and rejects stale writes", async () => {
  const v1 = await saveArtifactVersion(command(owner, { expectedVersion: 0 }), deps);
  expect(await listArtifacts(command(teammate), deps)).toContainEqual(expect.objectContaining({ version: 1 }));
  await saveArtifactVersion(command(teammate, { expectedVersion: 1 }), deps);
  await expect(saveArtifactVersion(command(owner, { expectedVersion: 1 }), deps))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await artifacts.versionCount(v1.artifactId)).toBe(2);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/implementation && npm run test:integration -w @syntholo/api -- artifacts.integration.test.ts`

Expected: FAIL because account-shared artifact persistence does not exist.

- [ ] **Step 3: Implement account-scoped version repository and command**

Use an account/artifact transaction lock, increment version atomically, store structured content only, and append an audit event without output contents.

```ts
export async function saveArtifactVersion(command: SaveArtifactVersion, deps: ImplementationDeps) {
  return deps.uow.transaction(async (tx) => {
    const artifact = await tx.artifacts.lock(command.actor.accountId, command.artifactId);
    if (artifact.currentVersion !== command.expectedVersion) throw new AppError("VERSION_CONFLICT", 409, "Reload the latest version");
    const version = await tx.artifacts.insertVersion(artifact, command.content, command.actor.membershipId);
    await tx.audit.append(artifactVersionedAudit(version, command.actor));
    return version;
  });
}
```

- [ ] **Step 4: Replace implementation demo writes and run GREEN**

Show shared author/time/version, conflict recovery, and unsynced draft status. Do not send output text to analytics/errors.

```tsx
export function ArtifactSaveStatus({ state }: { state: ArtifactSaveState }) {
  if (state.kind === "conflict") return <Alert role="alert">A teammate saved a newer version. Reload it or copy your draft before continuing.</Alert>;
  if (state.kind === "unsynced") return <Alert role="status">Saved on this device only; not synced yet.</Alert>;
  return <p role="status">Version {state.version} saved</p>;
}
```

Run: `npm test -w @syntholo/domain -- src/implementation && npm run test:integration -w @syntholo/api -- artifacts.integration.test.ts && npm test -w @syntholo/web -- implementation`

Expected: PASS for shared account visibility, version conflict, and cross-account denial.

- [ ] **Step 5: Commit**

```bash
git add apps packages
git commit -m "feat: persist shared implementation artifacts"
```

### Task 8: Generate private unaccredited PDF certificates once

**Files:**
- Create: `packages/contracts/src/learning/certificates.ts`
- Create: `packages/database/src/schema/certificates.ts`
- Create: `packages/database/drizzle/0012_certificates.sql`
- Create: `packages/database/src/repositories/certificates.ts`
- Create: `packages/integrations/src/blob/private-files.ts`
- Create: `apps/worker/src/handlers/certificates/generate.ts`
- Create: `apps/worker/src/handlers/certificates/generate.test.ts`
- Create: `apps/api/src/routes/member/certificates.ts`
- Create: `apps/api/src/modules/certificates/certificates.integration.test.ts`
- Modify: `apps/worker/package.json`
- Modify: `packages/integrations/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes only `learning.course_completed.v1` plus immutable member/business/course/version/completion facts.
- Produces one certificate row and private PDF object per course completion; unique `course_completion_id` guarantees one issuance.
- Produces `GET /v1/member/certificates` and authorized short-lived download redirect; no public route exists.

- [ ] **Step 1: Write certificate independence RED tests**

Seed course completion and generate; then refund purchase, expire support, revoke seat, and degrade Business OS. Assert certificate record/object remain and the original member can receive the already issued file through the approved recovery process.

```ts
it("keeps the earned certificate through commercial changes", async () => {
  await generateCertificate(courseCompletedEvent, deps);
  await applyAcademyRefund(accountId);
  await expireSupport(accountId);
  await revokeSeat(memberId);
  await degradeBusinessOs(accountId);
  expect(await certificates.findByCompletion(courseCompletionId)).toMatchObject({ status: "issued" });
  expect(await blob.exists(certificateObjectKey(courseCompletionId))).toBe(true);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/worker -- certificates && npm run test:integration -w @syntholo/api -- certificates.integration.test.ts`

Expected: FAIL because certificate issuance and private download records do not exist.

- [ ] **Step 3: Implement PDF generation and private storage**

Generate with `pdf-lib`; include member name, business, course, course version, completion date, and explicit `Unaccredited certificate of completion`. Do not include “verified”, certificate ID, QR code, lookup URL, or accreditation language.

```bash
npm install pdf-lib -w @syntholo/worker
npm install @vercel/blob -w @syntholo/integrations
```

```ts
export async function renderCertificatePdf(fact: CourseCompletionFact): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([792, 612]);
  page.drawText("Unaccredited certificate of completion", { x: 96, y: 470, size: 24 });
  page.drawText(fact.memberName, { x: 96, y: 390, size: 20 });
  page.drawText(`${fact.businessName} · ${fact.courseName} · ${fact.courseVersion}`, { x: 96, y: 345, size: 12 });
  page.drawText(formatCertificateDate(fact.completedAt), { x: 96, y: 310, size: 12 });
  return pdf.save();
}
```

- [ ] **Step 4: Make the handler idempotent**

Claim handler/event delivery; if row/object already exist, return success. If upload succeeds but transaction fails, retry by deterministic private object key and upsert record without duplicating delivery.

- [ ] **Step 5: Add member listing/download and run GREEN**

Authorize active members normally; retain an audited staff-assisted delivery path for a refunded/removed member because the achievement persists even when app access does not.

```ts
export async function createCertificateDownload(command: CertificateDownload, deps: CertificateDeps) {
  const certificate = await deps.certificates.findForMember(command.certificateId, command.actor);
  return deps.blob.createSignedDownload(certificate.objectKey, { expiresInSeconds: 300 });
}

export async function redeliverCertificate(command: StaffCertificateDelivery, deps: CertificateDeps) {
  requirePermission(command.actor, "certificates:deliver");
  requireRecentAuth(command.actor, 300);
  await deps.audit.append(certificateRedeliveryAudit(command));
  return deps.notifications.enqueue(certificateDeliveryNotification(command));
}
```

Run: `npm test -w @syntholo/worker -- certificates && npm run test:integration -w @syntholo/api -- certificates.integration.test.ts && npm run test:e2e -w @syntholo/web -- certificates.spec.ts`

Expected: PASS with one private PDF and preserved record across commercial/access changes.

- [ ] **Step 6: Commit**

```bash
git add apps packages
git commit -m "feat: issue Academy completion certificates"
```

### Task 9: Implement the 18-lesson readiness report and hard payment block

**Files:**
- Create: `packages/domain/src/content/readiness.ts`
- Create: `packages/domain/src/content/readiness.test.ts`
- Create: `apps/api/src/modules/content/evaluate-launch-readiness.ts`
- Create: `apps/api/src/routes/staff/content-readiness.ts`
- Create: `apps/api/src/modules/content/readiness.integration.test.ts`
- Create: `infra/scripts/gate-content.mjs`
- Create: `apps/web/src/app/admin/content/readiness/page.tsx`
- Create: `docs/operations/curriculum-readiness.md`
- Modify: `apps/api/src/modules/commerce/create-checkout.ts`

**Interfaces:**
- Produces `ContentLaunchReadiness` consumed by commerce exactly as declared in its plan.
- Automated pass requires exactly 18 required lessons and every named publication field; human pass requires WorkOS admin recent auth, approver identity, reason, and immutable report hash.
- Any content change after approval invalidates the report hash and blocks new Academy Checkout until reapproved.

- [ ] **Step 1: Write gate RED cases**

Test 17 lessons, 19 required lessons, placeholder marker, missing captions/transcript/action/resource/disclosure/accessibility, Mux not ready, unapproved, valid 18, and content change after approval.

```ts
it.each([
  [courseFixture({ requiredLessonCount: 17 }), "REQUIRED_LESSON_COUNT"],
  [courseFixture({ requiredLessonCount: 19 }), "REQUIRED_LESSON_COUNT"],
  [courseFixture({ placeholderLesson: 3 }), "PLACEHOLDER_CONTENT"],
  [courseFixture({ missingTranscript: 5 }), "TRANSCRIPT_REQUIRED"],
  [courseFixture({ muxNotReady: 8 }), "VIDEO_NOT_READY"],
])("blocks an incomplete curriculum", (course, code) => {
  expect(evaluateContentReadiness(course).issues).toContainEqual(expect.objectContaining({ code }));
});

it("invalidates approval after a content change", () => {
  expect(isHumanApprovalCurrent({ approvedHash: "old", currentHash: "new" })).toBe(false);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @syntholo/domain -- src/content/readiness.test.ts && npm run test:integration -w @syntholo/api -- readiness.integration.test.ts`

Expected: FAIL because the readiness report and persisted approval gate do not exist.

- [ ] **Step 3: Implement deterministic report generation**

Sort lessons, hash canonical readiness inputs, store every issue by lesson/version, and expose a staff report. The gate never reads browser state or demo fixtures.

```ts
export function evaluateContentReadiness(course: PublishedCourseSnapshot): ContentReadinessReport {
  const lessons = [...course.requiredLessons].sort((a, b) => a.order - b.order);
  const issues = lessons.flatMap((lesson) => validateLessonForPublication(lesson).map((issue) => ({ lessonId: lesson.id, ...issue })));
  if (lessons.length !== 18) issues.unshift({ lessonId: null, code: "REQUIRED_LESSON_COUNT", message: "Exactly 18 required lessons are required" });
  if (lessons.some(hasPlaceholderMarker)) issues.push({ lessonId: null, code: "PLACEHOLDER_CONTENT", message: "Placeholder content remains" });
  return { requiredLessons: 18, readyLessons: lessons.length - new Set(issues.map((issue) => issue.lessonId).filter(Boolean)).size, issues, contentHash: sha256(canonicalJson(lessons)) };
}
```

```ts
export function toContentLaunchReadiness(report: ContentReadinessReport, approval: ContentApproval | null, evaluatedAt: Date): ContentLaunchReadiness {
  const automatedPassedAt = report.issues.length === 0 ? evaluatedAt.toISOString() : null;
  const humanApprovedAt = approval?.contentHash === report.contentHash ? approval.approvedAt.toISOString() : null;
  return {
    requiredLessons: 18,
    readyLessons: report.readyLessons,
    contentHash: report.contentHash,
    automatedPassedAt,
    humanApprovedAt,
    canSellAcademy: automatedPassedAt !== null && humanApprovedAt !== null,
  };
}
```

- [ ] **Step 4: Bind commerce availability to persisted approval**

At Checkout creation, query readiness in the same authorization operation. A client flag or stale cached public offer cannot bypass it.

- [ ] **Step 5: Run GREEN**

```bash
npm test -w @syntholo/domain -- readiness
npm run test:integration -w @syntholo/api -- readiness
npm run gate:content
```

Expected: before real lesson entry, the command returns `BLOCKED` with an exact per-lesson report; it must not be forced to pass with placeholders.

- [ ] **Step 6: Commit**

```bash
git add apps packages infra docs/operations
git commit -m "feat: enforce the Academy curriculum gate"
```

### Task 10: Complete production learning journeys and gate evidence

**Files:**
- Create: `apps/web/tests/e2e/content-learning.spec.ts`
- Create: `apps/web/tests/e2e/certificates.spec.ts`
- Create: `docs/operations/content-and-certificates.md`
- Modify: `infra/scripts/gate-content.mjs`

**Interfaces:**
- Produces end-to-end evidence for Flow 4 and Gate 3.
- Fixture-only course generation uses synthetic lessons and is rejected when `NODE_ENV=production`.

- [ ] **Step 1: Add failing end-to-end tests**

Admin draft/publish; member transcript completion; shared artifact conflict; 18-lesson completion; exactly one certificate; refund/expiry invariance; content-change gate invalidation.

```ts
test("18 transcript completions issue one durable certificate", async ({ page, workerFixture }) => {
  await memberFixture.signIn(page);
  for (const lessonId of requiredLessonIds) {
    await page.goto(`/learn/course/${lessonId}?path=transcript`);
    await page.getByRole("button", { name: "Mark lesson complete" }).click();
  }
  await workerFixture.drain("certificates");
  await page.goto("/learn/settings/certificates");
  await expect(page.getByText("Unaccredited certificate of completion")).toHaveCount(1);
});
```

- [ ] **Step 2: Run RED and close UI/API integration gaps**

Run: `npm run test:e2e -w @syntholo/web -- content-learning.spec.ts certificates.spec.ts`

Expected: FAIL until the browser journeys consume production content, completion, artifact, and certificate APIs.

Use the following final wiring contract; do not add a browser-side eligibility calculation:

```ts
export interface LearningApi {
  getLesson(lessonId: string): Promise<MemberLessonResponse>;
  completeLesson(lessonId: string, method: "video" | "transcript" | "mixed", idempotencyKey: string): Promise<LessonCompletionResponse>;
  listCertificates(): Promise<readonly CertificateSummary[]>;
}
```

- [ ] **Step 3: Run full verification**

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e -w @syntholo/web -- content-learning.spec.ts certificates.spec.ts
npm run gate:content
git diff --check
```

Expected: technical checks pass; readiness stays intentionally `BLOCKED` until the owner's 18 real lessons and human approval exist.

- [ ] **Step 4: Self-review**

Confirm no public certificate route/ID/verification copy, no achievement dependency on entitlements, no mutable published versions, no watch-percentage completion requirement, and no payment bypass.

- [ ] **Step 5: Commit**

```bash
git add apps packages infra docs/operations
git commit -m "test: verify content and certificate flows"
```
