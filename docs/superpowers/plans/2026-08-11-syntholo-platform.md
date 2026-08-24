# Syntholo Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build a polished, responsive Syntholo platform that demonstrates every approved public, member, coach, administrator, and Business OS workflow end to end, with vendor adapters ready for production credentials.

**Architecture:** Use a Next.js App Router application organized into feature modules. Domain behavior lives in typed, framework-independent services with Vitest coverage; server components render the default experience and client components handle interactive demo flows. Production integrations sit behind adapters so the app runs locally with deterministic demo data and switches to Cloudflare Access, MongoDB, Stripe, Mux, Resend, PostHog, and HighLevel when configured.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, Vitest, Testing Library, Playwright, Zod, Lucide React, MongoDB driver, Clerk / Cloudflare Access, Stripe, Mux Player, Resend, PostHog, Vercel Blob.

## Global Constraints

- Brand is Syntholo; flagship product is AI Operating System Academy.
- Trusted Growth colors are canvas `#F8F8F6`, surface `#FFFFFF`, ink `#181818`, navy `#102A35`, teal `#0F6F70`, coral `#EF7D62`, and gold `#D5A943`.
- Use Manrope headings and Inter body text.
- No automated AI coach in v1; instructional help is explicitly human.
- One customer business has one owner and two teammate seats.
- Customer identities belong to one customer organization.
- Personal lesson progress and shared business implementation remain separate.
- Self-paced unlocks all lessons; pilot uses four weekly releases.
- All interactive UI meets WCAG 2.1 AA and honors reduced motion.
- Vendor failures cannot block unrelated product areas.

---

### Task 1: Application foundation and design system

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `vitest.config.ts`
- Create: `src/app/layout.tsx`, `src/app/globals.css`, `src/app/page.tsx`
- Create: `src/components/ui/button.tsx`, `src/components/ui/card.tsx`, `src/components/ui/progress.tsx`
- Test: `src/components/ui/button.test.tsx`

**Interfaces:**
- Produces: `Button`, `Card`, `Progress`, CSS design tokens, and global application metadata.

- [x] **Step 1: Write a failing render test**

```tsx
it("renders a primary action", () => {
  render(<Button>Continue lesson</Button>);
  expect(screen.getByRole("button", { name: "Continue lesson" })).toHaveClass("button-primary");
});
```

- [x] **Step 2: Run `npm test -- button.test.tsx` and verify it fails because the component does not exist.**
- [x] **Step 3: Implement typed UI primitives and exact Trusted Growth CSS tokens.**
- [x] **Step 4: Run the unit test, typecheck, and lint; expect all to pass.**
- [x] **Step 5: Commit `feat: scaffold Syntholo design system`.**

### Task 2: Domain model and deterministic demo repository

**Files:**
- Create: `src/lib/domain/types.ts`, `src/lib/domain/course.ts`, `src/lib/domain/entitlements.ts`, `src/lib/domain/next-action.ts`
- Create: `src/lib/demo/data.ts`, `src/lib/demo/repository.ts`
- Test: `src/lib/domain/next-action.test.ts`, `src/lib/domain/entitlements.test.ts`

**Interfaces:**
- Produces: `Organization`, `Member`, `Course`, `LessonProgress`, `Artifact`, `Entitlement`, `SupportThread`, `LiveSession`, `CommunityPost`, `SoftwareAccount`.
- Produces: `getNextAction(input: NextActionInput): NextAction` and `canAccess(kind, entitlements, now): boolean`.

- [x] **Step 1: Test access expiration and next-action precedence.**

```ts
expect(getNextAction({ accessIssue: true, waitingOnCustomer: true, nextLessonId: "l1" }).kind).toBe("access_issue");
expect(canAccess("community_write", [{ kind: "community_write", status: "expired" }], now)).toBe(false);
```

- [x] **Step 2: Run the tests and verify missing exports fail.**
- [x] **Step 3: Implement exact union types, precedence rules, and immutable demo repository selectors.**
- [x] **Step 4: Run all domain tests and typecheck.**
- [x] **Step 5: Commit `feat: add Syntholo domain model`.**

### Task 3: Public marketing and readiness scorecard

**Files:**
- Create: `src/app/(marketing)/page.tsx`, `src/app/(marketing)/scorecard/page.tsx`, `src/app/(marketing)/pricing/page.tsx`
- Create: `src/features/scorecard/questions.ts`, `src/features/scorecard/scoring.ts`, `src/features/scorecard/scorecard-client.tsx`
- Create: `src/components/marketing/site-header.tsx`, `src/components/marketing/site-footer.tsx`
- Test: `src/features/scorecard/scoring.test.ts`, `tests/e2e/scorecard.spec.ts`

**Interfaces:**
- Consumes: design primitives.
- Produces: `calculateScore(answers): ScorecardResult` with five dimensions, 0–100 score, band, priorities, and recommended workflow.

- [x] **Step 1: Test all-zero, midpoint, and maximum scoring plus band boundaries.**
- [x] **Step 2: Verify the score test fails.**
- [x] **Step 3: Implement the 20-question deterministic assessment and gated full report.**
- [x] **Step 4: Implement polished homepage and pricing content with contextual disclosures.**
- [x] **Step 5: Run unit and Playwright scorecard journeys.**
- [x] **Step 6: Commit `feat: add public acquisition experience`.**

### Task 4: Member shell, command center, and course workspace

**Files:**
- Create: `src/app/(member)/learn/layout.tsx`, `src/app/(member)/learn/page.tsx`, `src/app/(member)/learn/course/page.tsx`
- Create: `src/app/(member)/learn/course/[lessonId]/page.tsx`
- Create: `src/components/member/sidebar.tsx`, `src/components/member/next-step-card.tsx`, `src/components/member/business-engines.tsx`
- Create: `src/features/course/course-map.tsx`, `src/features/course/lesson-workspace.tsx`, `src/features/course/progress-store.tsx`
- Test: `src/features/course/progress-store.test.tsx`, `tests/e2e/member-course.spec.ts`

**Interfaces:**
- Consumes: repository selectors and `getNextAction`.
- Produces: `markLessonComplete`, `setVideoPosition`, and responsive member navigation.

- [x] **Step 1: Test independent member progress and preserved completion.**
- [x] **Step 2: Verify the test fails.**
- [x] **Step 3: Build the Magnific-inspired Guided Command Center with real course data.**
- [x] **Step 4: Build the six-stage course map and accessible lesson workspace.**
- [x] **Step 5: Run unit, accessibility, and course E2E tests.**
- [x] **Step 6: Commit `feat: build member learning experience`.**

### Task 5: Shared implementation artifacts

**Files:**
- Create: `src/app/(member)/learn/workflows/page.tsx`, `src/app/(member)/learn/plan/page.tsx`
- Create: `src/features/artifacts/artifact-editor.tsx`, `src/features/artifacts/workflow-card.tsx`, `src/features/artifacts/completion.ts`
- Test: `src/features/artifacts/completion.test.ts`, `tests/e2e/artifacts.spec.ts`

**Interfaces:**
- Produces: `calculateProgramCompletion(progress, artifacts)` and version-aware artifact editor commands.

- [x] **Step 1: Test that 18 lessons, five outputs, and three live workflows are required.**
- [x] **Step 2: Verify the test fails.**
- [x] **Step 3: Implement shared output dashboards and three workflow launch records.**
- [x] **Step 4: Implement conflict messaging and request-review actions in the demo repository.**
- [x] **Step 5: Run tests and responsive visual checks.**
- [x] **Step 6: Commit `feat: add shared implementation workspace`.**

### Task 6: Human support, live sessions, and community

**Files:**
- Create: `src/app/(member)/learn/support/page.tsx`, `src/app/(member)/learn/live/page.tsx`, `src/app/(member)/learn/community/page.tsx`
- Create: `src/features/support/support-inbox.tsx`, `src/features/support/sla.ts`
- Create: `src/features/live/session-list.tsx`, `src/features/community/community-feed.tsx`
- Test: `src/features/support/sla.test.ts`, `tests/e2e/human-support.spec.ts`

**Interfaces:**
- Produces: `calculateSlaDue(createdAt, calendar): Date`, support status transitions, RSVP state, and moderation actions.

- [x] **Step 1: Test weekend-aware two-business-day SLA and pause behavior.**
- [x] **Step 2: Verify the test fails.**
- [x] **Step 3: Implement the explicitly human shared inbox and coach identity.**
- [x] **Step 4: Implement timezone-aware Zoom sessions and real-name community surfaces.**
- [x] **Step 5: Run support and moderation E2E tests.**
- [x] **Step 6: Commit `feat: add human learning layer`.**

### Task 7: Business OS and administration

**Files:**
- Create: `src/app/(member)/learn/business-os/page.tsx`
- Create: `src/app/admin/page.tsx`, `src/app/admin/content/page.tsx`, `src/app/admin/provisioning/page.tsx`
- Create: `src/features/business-os/provisioning.ts`, `src/features/business-os/provisioning-board.tsx`
- Create: `src/features/admin/admin-dashboard.tsx`, `src/features/admin/content-editor.tsx`
- Test: `src/features/business-os/provisioning.test.ts`, `tests/e2e/admin.spec.ts`

**Interfaces:**
- Produces: validated Business OS transitions and P0 admin views.

- [x] **Step 1: Test allowed provisioning transitions and the five-business-day due date.**
- [x] **Step 2: Verify the test fails.**
- [x] **Step 3: Implement the disclosed Business OS offer, onboarding checklist, and external-login state.**
- [x] **Step 4: Implement admin overview, content status, support SLA, community reports, and provisioning board.**
- [x] **Step 5: Run unit and role-boundary E2E tests.**
- [x] **Step 6: Commit `feat: add operations and Business OS`.**

### Task 8: Production integration contracts

**Files:**
- Create: `src/lib/config/env.ts`, `src/lib/integrations/contracts.ts`
- Create: `src/lib/integrations/mongodb.ts`, `src/lib/integrations/access.ts`, `src/lib/integrations/stripe.ts`, `src/lib/integrations/mux.ts`, `src/lib/integrations/resend.ts`, `src/lib/integrations/posthog.ts`
- Create: `src/app/api/health/route.ts`, `src/app/api/webhooks/stripe/route.ts`
- Test: `src/lib/config/env.test.ts`, `src/app/api/webhooks/stripe/route.test.ts`

**Interfaces:**
- Produces: strict optional environment parsing, adapter interfaces, signature-verifying webhook entrypoint, and demo fallback.

- [x] **Step 1: Test missing optional demo credentials and invalid partial production configuration.**
- [x] **Step 2: Verify invalid configuration test fails.**
- [x] **Step 3: Implement lazy vendor adapters so build never contacts external services.**
- [x] **Step 4: Implement idempotent webhook receipt contract and health response.**
- [x] **Step 5: Run API tests and production build without secrets.**
- [x] **Step 6: Commit `feat: add production integration boundaries`.**

### Task 9: Verification and handoff

**Files:**
- Create: `README.md`, `.env.example`, `docs/operations/demo-and-production.md`
- Modify: all failing files discovered by checks.

**Interfaces:**
- Produces: reproducible local setup and a verified deployment checklist.

- [x] **Step 1: Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.**
- [x] **Step 2: Run Playwright journeys at desktop and mobile widths.**
- [x] **Step 3: Check keyboard focus, contrast, reduced motion, and empty/error states.**
- [x] **Step 4: Document demo mode, production credentials, vendor webhooks, and deployment steps.**
- [x] **Step 5: Commit `chore: verify and document Syntholo platform`.**

