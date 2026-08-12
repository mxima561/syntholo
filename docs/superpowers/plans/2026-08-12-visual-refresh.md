# Syntholo Visual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh every Syntholo surface with readable typography, lower information density, semantic color, restrained motion, and the approved Uxcel-inspired member-dashboard hierarchy while preserving all current behavior.

**Architecture:** Split the 967-line global stylesheet into ordered, responsibility-based style layers and expand the existing UI primitives instead of replacing the application. Extract the member dashboard into focused server-rendered components that consume the existing deterministic repository, then migrate marketing, member, human/community, and admin surfaces onto the same tokens. Preserve current App Router server/client boundaries and verify visual contracts with Vitest, Testing Library, Playwright, axe, and committed screenshot baselines.

**Tech Stack:** Next.js 16.3 App Router, React 19.2, TypeScript 5.9, Tailwind CSS 4, CSS custom properties and keyframes, Lucide React, Vitest, Testing Library, Playwright, and axe-core.

## Global Constraints

- Keep Trusted Growth colors: canvas `#F8F8F6`, surface `#FFFFFF`, ink `#181818`, muted `#777773`, border `#E8E8E4`, navy `#102A35`, teal `#0F6F70`, coral `#EF7D62`, gold `#D5A943`, success `#2A9D73`, and danger `#B9473F`.
- Use Manrope for headings and Inter for body/interface copy.
- Body reading text is 15–17px; navigation and controls are 13–14px; metadata is 11–12px; no meaningful interface text is below 11px.
- Buttons have 13–14px labels and a minimum 44px target; admin table utilities may render at 40px only with a 44px hit area.
- Teal means default primary action, coral means human support, gold with navy text means milestone/calendar/progress, navy means high emphasis, and white/quiet means secondary action.
- Keep one dominant action per content region and no more than four equal-weight cards in a desktop row.
- Member home contains one Continue Learning card, no more than two recommendations, and no more than three right-rail cards.
- Public and member pages receive the full color treatment; admin uses a calmer navy/teal/neutral variation without playful illustrations.
- Use CSS for all motion; do not add an animation dependency.
- Hover/focus/press transitions last 180–260ms; cards lift at most 3px and buttons at most 2px.
- `prefers-reduced-motion: reduce` removes ambient motion, transforms, scroll animation, and section reveals.
- Preserve all existing routes, domain behavior, demo data, integration contracts, accessibility behavior, and production boundaries.
- Do not add site-wide search. The top bar uses a Browse lessons and templates link to existing content.
- Read the relevant Next.js 16 guide in `node_modules/next/dist/docs/` before changing App Router files, as required by `AGENTS.md`.

## Planned File Map

### New style layers

- `src/styles/tokens.css` — color, typography, spacing, radius, shadow, z-index, and motion tokens.
- `src/styles/base.css` — reset, body, focus, reduced motion, shared brand, button, card, progress, and utility rules.
- `src/styles/marketing.css` — homepage, scorecard, pricing, checkout, claim, legal, and public footer rules.
- `src/styles/member.css` — member shell, dashboard structure, shared page headings, and shared member cards.
- `src/styles/features.css` — course, plan, workflow, templates, settings, support, live, community, and Business OS rules.
- `src/styles/admin.css` — admin shell, overview, table, content editor, and provisioning rules.
- `src/styles/responsive.css` — exact 1180px, 900px, and 768px responsive contracts.

### New dashboard units

- `src/features/dashboard/dashboard-illustration.tsx` — decorative original Syntholo course artwork with `aria-hidden`.
- `src/features/dashboard/dashboard-continue-card.tsx` — one dominant lesson continuation card.
- `src/features/dashboard/dashboard-recommendation-card.tsx` — one reusable contextual recommendation.
- `src/features/dashboard/dashboard-right-rail.tsx` — priorities, human coach activity, and next session.
- `src/features/dashboard/member-dashboard.tsx` — composes the approved dashboard hierarchy.
- `src/features/dashboard/member-dashboard.test.tsx` — dashboard content and link contract.

### New quality files

- `src/styles/tokens.test.ts` — exact token and minimum-type-scale contract.
- `tests/e2e/visual-contracts.spec.ts` — computed typography, density, color, motion, and overflow contracts.
- `tests/e2e/visual-regression.spec.ts` — committed desktop/mobile screenshot baselines.

---

### Task 1: Style layers and semantic action primitives

**Files:**
- Create: `src/styles/tokens.css`
- Create: `src/styles/base.css`
- Create: `src/styles/marketing.css`
- Create: `src/styles/member.css`
- Create: `src/styles/features.css`
- Create: `src/styles/admin.css`
- Create: `src/styles/responsive.css`
- Create: `src/styles/tokens.test.ts`
- Modify: `src/app/globals.css:1-967`
- Modify: `src/components/ui/button.tsx:1-35`
- Modify: `src/components/ui/button.test.tsx:1-13`

**Interfaces:**
- Produces: CSS tokens `--canvas`, `--surface`, `--ink`, `--muted`, `--border`, `--navy`, `--teal`, `--coral`, `--gold`, `--success`, `--danger`, `--text-body`, `--text-ui`, `--text-meta`, `--motion-fast`, and `--motion-standard`.
- Produces: `ButtonVariant = "primary" | "secondary" | "dark" | "quiet" | "human" | "milestone"`.
- Preserves: existing `Button` default variant, sizes, typed Next.js routes, CSS selector names, and cascade behavior.

- [ ] **Step 1: Write failing token and button-variant tests**

Add `src/styles/tokens.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

describe("visual refresh tokens", () => {
  it("locks the approved Trusted Growth palette and readable type floor", () => {
    expect(css).toContain("--canvas: #f8f8f6");
    expect(css).toContain("--teal: #0f6f70");
    expect(css).toContain("--coral: #ef7d62");
    expect(css).toContain("--gold: #d5a943");
    expect(css).toContain("--text-body: 1rem");
    expect(css).toContain("--text-ui: 0.875rem");
    expect(css).toContain("--text-meta: 0.75rem");
  });
});
```

Extend `src/components/ui/button.test.tsx`:

```tsx
it("maps human and milestone actions to semantic classes", () => {
  render(
    <>
      <Button variant="human">Ask a coach</Button>
      <Button variant="milestone">Add to calendar</Button>
    </>,
  );

  expect(screen.getByRole("button", { name: "Ask a coach" })).toHaveClass("button-human");
  expect(screen.getByRole("button", { name: "Add to calendar" })).toHaveClass("button-milestone");
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
npm test -- src/styles/tokens.test.ts src/components/ui/button.test.tsx
```

Expected: FAIL because `tokens.css` and the new `Button` variants do not exist.

- [ ] **Step 3: Create the exact shared token layer**

Create `src/styles/tokens.css` with this foundation:

```css
:root {
  --canvas: #f8f8f6;
  --surface: #ffffff;
  --ink: #181818;
  --muted: #777773;
  --border: #e8e8e4;
  --navy: #102a35;
  --teal: #0f6f70;
  --teal-dark: #0a5658;
  --coral: #ef7d62;
  --gold: #d5a943;
  --success: #2a9d73;
  --danger: #b9473f;
  --teal-tint: #e6f3ef;
  --coral-tint: #fdefeb;
  --gold-tint: #f8f0da;
  --text-body: 1rem;
  --text-ui: 0.875rem;
  --text-meta: 0.75rem;
  --radius-control: 0.625rem;
  --radius-card: 1rem;
  --radius-shell: 1.375rem;
  --motion-fast: 180ms;
  --motion-standard: 240ms;
  --shadow-card: 0 12px 32px rgba(16, 42, 53, 0.08);
  --shadow-raised: 0 18px 48px rgba(16, 42, 53, 0.12);
  --font-heading: var(--font-manrope), system-ui, sans-serif;
  --font-body: var(--font-inter), system-ui, sans-serif;
}
```

- [ ] **Step 4: Expand the Button interface and base styles**

Update the variant type in `src/components/ui/button.tsx`:

```ts
export type ButtonVariant =
  | "primary"
  | "secondary"
  | "dark"
  | "quiet"
  | "human"
  | "milestone";
```

Keep `variant = "primary"` and construct `button-${variant}` as today. Add the exact semantic rules to `src/styles/base.css`:

```css
.button {
  min-height: 44px;
  padding-inline: 18px;
  border: 0;
  border-radius: var(--radius-control);
  font: 750 var(--text-ui)/1 var(--font-heading);
  transition:
    transform var(--motion-fast) ease,
    box-shadow var(--motion-fast) ease,
    background-color var(--motion-fast) ease,
    border-color var(--motion-fast) ease;
}
.button:hover { transform: translateY(-2px); }
.button:active { transform: translateY(1px) scale(0.99); }
.button-primary { background: var(--teal); color: white; }
.button-human { background: var(--coral); color: white; }
.button-milestone { background: var(--gold); color: var(--navy); }
.button-dark { background: var(--navy); color: white; }
.button-secondary { border: 1px solid var(--border); background: white; color: var(--navy); }
.button-quiet { background: transparent; color: var(--ink); }
```

- [ ] **Step 5: Split the existing stylesheet without changing selector behavior**

Replace `src/app/globals.css` with ordered imports:

```css
@import "tailwindcss";
@import "../styles/tokens.css";
@import "../styles/base.css";
@import "../styles/marketing.css";
@import "../styles/member.css";
@import "../styles/features.css";
@import "../styles/admin.css";
@import "../styles/responsive.css";
```

Move the existing rules by responsibility while preserving their order inside each destination:

- Base reset, brand, button, card, progress, focus, and reduced-motion rules → `base.css`.
- Homepage, scorecard, pricing, checkout, claim, legal, and footer rules → `marketing.css`.
- Member shell, topbar, page intro, dashboard, and shared member layout rules → `member.css`.
- Settings through Business OS feature rules → `features.css`.
- Admin shell through provisioning rules → `admin.css`.
- All current `@media` rules → `responsive.css`, then replace them with the approved 1180px, 900px, and 768px contracts in later tasks.

- [ ] **Step 6: Run foundation verification**

Run:

```bash
npm test -- src/styles/tokens.test.ts src/components/ui/button.test.tsx
npm run typecheck
npm run lint
npm run build
```

Expected: all commands PASS and the build lists the same routes as the baseline.

- [ ] **Step 7: Commit the foundation**

```bash
git add src/app/globals.css src/styles src/components/ui/button.tsx src/components/ui/button.test.tsx
git commit -m "refactor: establish Syntholo visual system"
```

---

### Task 2: Approved member shell and dashboard hierarchy

**Files:**
- Create: `src/features/dashboard/dashboard-illustration.tsx`
- Create: `src/features/dashboard/dashboard-continue-card.tsx`
- Create: `src/features/dashboard/dashboard-recommendation-card.tsx`
- Create: `src/features/dashboard/dashboard-right-rail.tsx`
- Create: `src/features/dashboard/member-dashboard.tsx`
- Create: `src/features/dashboard/member-dashboard.test.tsx`
- Modify: `src/lib/demo/repository.ts:15-37`
- Modify: `src/components/member-shell.tsx:1-76`
- Modify: `src/app/learn/page.tsx:1-56`
- Modify: `src/styles/member.css`
- Modify: `src/styles/responsive.css`
- Modify: `tests/e2e/core-journeys.spec.ts:22-33`

**Interfaces:**
- Produces: `export type DashboardView = ReturnType<typeof getDashboard>` from `src/lib/demo/repository.ts`.
- Produces: `MemberDashboard({ dashboard }: { dashboard: DashboardView })`.
- Produces: `DashboardContinueCard`, `DashboardRecommendationCard`, and `DashboardRightRail` with typed props local to the dashboard feature.
- Consumes: existing `dashboard.nextAction`, `dashboard.nextLesson`, artifacts, support threads, session, organization, and member data.

- [ ] **Step 1: Extend the demo repository test for the lesson used by the dashboard**

Update `src/lib/demo/repository.test.ts` with:

```ts
it("returns the active lesson required by the member dashboard", () => {
  const dashboard = getDashboard("member-maria");

  expect(dashboard.nextLesson.id).toBe("growth-2");
  expect(dashboard.nextLesson.title).toBe("Respond, qualify, and route leads");
  expect(dashboard.nextAction.href).toBe("/learn/course/growth-2");
});
```

- [ ] **Step 2: Write the failing dashboard composition test**

Create `src/features/dashboard/member-dashboard.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getDashboard } from "@/lib/demo/repository";
import { MemberDashboard } from "./member-dashboard";

describe("MemberDashboard", () => {
  it("prioritizes one lesson, two recommendations, and the human right rail", () => {
    render(<MemberDashboard dashboard={getDashboard("member-maria")} />);

    expect(screen.getByRole("heading", { name: /keep building your business os/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /resume lesson/i })).toHaveAttribute("href", "/learn/course/growth-2");
    expect(screen.getAllByTestId("dashboard-recommendation")).toHaveLength(2);
    expect(screen.getByText(/naomi replied/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /browse lessons and templates/i })).toHaveAttribute("href", "/learn/course");
  });
});
```

- [ ] **Step 3: Run the dashboard tests and verify they fail**

Run:

```bash
npm test -- src/lib/demo/repository.test.ts src/features/dashboard/member-dashboard.test.tsx
```

Expected: FAIL because `nextLesson` and the dashboard components do not exist.

- [ ] **Step 4: Add the dashboard lesson and exported view type**

Update `getDashboard` in `src/lib/demo/repository.ts`:

```ts
const nextLessonProgress = demoProgress.find(
  (progress) => progress.memberId === member.id && progress.status === "in_progress",
);
const nextLesson =
  allLessons.find((lesson) => lesson.id === nextLessonProgress?.lessonId) ?? allLessons[0];

return {
  // existing fields
  nextLesson,
  nextAction: getNextAction({ nextLessonId: nextLesson.id }),
};
```

After the function, export:

```ts
export type DashboardView = ReturnType<typeof getDashboard>;
```

- [ ] **Step 5: Implement the focused dashboard components**

Use server-compatible components with no new client state. The continue-card interface is:

```tsx
type DashboardContinueCardProps = {
  href: DashboardView["nextAction"]["href"];
  lesson: DashboardView["nextLesson"];
  progressPercent: number;
};

export function DashboardContinueCard({ href, lesson, progressPercent }: DashboardContinueCardProps) {
  return (
    <article className="dashboard-continue-card">
      <DashboardIllustration />
      <div className="dashboard-continue-copy">
        <span className="meta-label">Stage 3 · Growth engine</span>
        <h2>{lesson.title}</h2>
        <p>{lesson.summary}</p>
        <Progress label="Program completion" showValue value={progressPercent} />
        <Button href={href}>Resume lesson</Button>
      </div>
    </article>
  );
}
```

The illustration must be `aria-hidden="true"` and use three original colored CSS blocks. The recommendation component must include `data-testid="dashboard-recommendation"`. Derive exactly two recommendations with this deterministic model inside `member-dashboard.tsx`:

```tsx
const policy = dashboard.artifacts.find((artifact) => artifact.kind === "ai_policy")!;
const workflowPortfolio = dashboard.artifacts.find(
  (artifact) => artifact.kind === "workflow_portfolio",
)!;
const nextWorkflow = workflowPortfolio.workflows!.find((workflow) => workflow.status !== "live")!;

const recommendations = [
  {
    label: "Coach feedback",
    title: policy.title,
    description: "Review Naomi's two notes before your next team meeting.",
    href: `/learn/plan?artifact=${policy.id}` as `/learn/plan?artifact=${string}`,
    actionLabel: "Open workspace",
    tone: "coral" as const,
  },
  {
    label: "Workflow",
    title: nextWorkflow.name,
    description: `${nextWorkflow.target}. Complete the next test before launch.`,
    href: "/learn/workflows" as const,
    actionLabel: "Review workflow",
    tone: "gold" as const,
  },
];
```

The right rail renders exactly three cards: weekly priorities derived from `dashboard.nextLesson.actionLabel`, the AI policy title, and the non-live workflow name; the newest coach reply from `dashboard.supportThreads[0]`; and `dashboard.upcomingSession`.

- [ ] **Step 6: Replace the member page with the composed dashboard**

Reduce `src/app/learn/page.tsx` to:

```tsx
import { MemberDashboard } from "@/features/dashboard/member-dashboard";
import { getDashboard } from "@/lib/demo/repository";

export default function LearnDashboardPage() {
  return <MemberDashboard dashboard={getDashboard("member-maria")} />;
}
```

Update `MemberShell` so its topbar contains a visible link named `Browse lessons and templates` to `/learn/course`, plus no more than two status chips. Preserve grouped navigation, active-route state, member identity, and mobile branding.

- [ ] **Step 7: Implement the approved member/dashboard CSS contract**

In `member.css`, implement:

```css
.member-shell { grid-template-columns: 190px minmax(0, 1fr); background: var(--canvas); }
.member-sidebar { background: #fafaf8; border-right: 1px solid var(--border); }
.member-content > main { background: var(--surface); }
.dashboard-layout { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 26px; }
.dashboard-continue-card { display: grid; grid-template-columns: 215px minmax(0, 1fr); gap: 24px; }
.dashboard-recommendations { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.dashboard-right-rail { display: grid; gap: 14px; align-content: start; }
```

Use 33–40px page headings, 19–24px section headings, 16–21px card headings, 15–17px body text, 13–14px controls/navigation, and 11–12px metadata. Add tinted illustration, coach, and session surfaces plus the approved hover/progress motion.

- [ ] **Step 8: Update and run the member journey**

Change the heading assertion in `tests/e2e/core-journeys.spec.ts` from `Good evening, Maria` to `Keep building your business OS`, while preserving the lesson-completion and coach-reply journey.

Run:

```bash
npm test -- src/lib/demo/repository.test.ts src/features/dashboard/member-dashboard.test.tsx
npm run test:e2e -- tests/e2e/core-journeys.spec.ts
npm run typecheck
npm run lint
```

Expected: all commands PASS.

- [ ] **Step 9: Commit the member dashboard**

```bash
git add src/app/learn/page.tsx src/components/member-shell.tsx src/features/dashboard src/lib/demo/repository.ts src/lib/demo/repository.test.ts src/styles/member.css src/styles/responsive.css tests/e2e/core-journeys.spec.ts
git commit -m "feat: refresh member dashboard hierarchy"
```

---

### Task 3: Public marketing and acquisition refresh

**Files:**
- Modify: `src/app/page.tsx:31-184`
- Modify: `src/app/page.test.tsx:1-18`
- Modify: `src/app/scorecard/page.tsx`
- Modify: `src/features/scorecard/scorecard-client.tsx`
- Modify: `src/app/pricing/page.tsx`
- Modify: `src/app/checkout/[offer]/page.tsx`
- Modify: `src/app/claim/page.tsx`
- Modify: `src/app/privacy/page.tsx`
- Modify: `src/app/terms/page.tsx`
- Modify: `src/styles/marketing.css`
- Create: `tests/e2e/visual-contracts.spec.ts`

**Interfaces:**
- Consumes: Task 1 semantic `Button` variants and shared typography tokens.
- Produces: stable public classes `marketing-page`, `hero-lede`, `outcome-card`, `question-card`, `pricing-card`, and `legal-page` with the approved type floor.
- Preserves: homepage copy, scorecard scoring/gating, pricing, checkout preview, claim flow, and legal content.

- [ ] **Step 1: Extend the homepage unit test for semantic actions**

Add to `src/app/page.test.tsx`:

```tsx
expect(screen.getByRole("link", { name: /see program options/i })).toHaveClass("button-dark");
expect(screen.getAllByRole("link", { name: /take the free scorecard/i })[0]).toHaveClass("button-primary");
```

- [ ] **Step 2: Write the failing public visual contract**

Create `tests/e2e/visual-contracts.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

async function fontSize(locator: import("@playwright/test").Locator) {
  return locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
}

test("public pages use readable type and semantic color", async ({ page }) => {
  await page.goto("/");
  expect(await fontSize(page.locator(".hero-lede"))).toBeGreaterThanOrEqual(15);
  expect(await fontSize(page.locator(".outcome-card p").first())).toBeGreaterThanOrEqual(15);
  await expect(page.getByRole("link", { name: /take the free scorecard/i }).first()).toHaveCSS(
    "background-color",
    "rgb(15, 111, 112)",
  );

  await page.goto("/scorecard");
  expect(await fontSize(page.locator(".question-card > p"))).toBeGreaterThanOrEqual(15);
});
```

- [ ] **Step 3: Run the public tests and verify the visual contract fails**

Run:

```bash
npm test -- src/app/page.test.tsx src/features/scorecard/scorecard-client.test.tsx
npm run test:e2e -- tests/e2e/visual-contracts.spec.ts
```

Expected: unit tests remain green except for any new class assertion; Playwright FAILS because current public body text is 9–14px.

- [ ] **Step 4: Simplify and recolor the homepage**

Keep the existing sections and copy. Remove miniature decorative labels from the blueprint when the same meaning is already present in a heading. Apply these contracts in `marketing.css`:

```css
.hero-lede,
.split-heading > p,
.outcome-card p,
.program-copy p,
.final-cta p { font-size: clamp(0.9375rem, 1.2vw, 1.0625rem); }
.outcome-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; border: 0; }
.outcome-card { border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface); }
.outcome-card:nth-child(1) { background: var(--coral-tint); }
.outcome-card:nth-child(2) { background: var(--teal-tint); }
.outcome-card:nth-child(3) { background: var(--gold-tint); }
```

Keep the scorecard action teal, program action navy, and human-support highlight coral.

- [ ] **Step 5: Apply the type and density contract to acquisition pages**

Update scorecard, pricing, checkout, claim, privacy, and terms styles so:

- Body copy is at least 15px.
- Form labels and controls are at least 14px.
- Metadata is 11–12px.
- Question options and pricing cards use 16–24px padding.
- Selected scorecard options use teal tint plus a visible selected label/icon.
- Checkout/claim remain clearly labeled demo experiences.
- Pricing cards show one primary action each and use tint only for featured/status regions.

- [ ] **Step 6: Run public verification**

Run:

```bash
npm test -- src/app/page.test.tsx src/features/scorecard
npm run test:e2e -- tests/e2e/core-journeys.spec.ts tests/e2e/visual-contracts.spec.ts
npm run typecheck
npm run lint
```

Expected: all commands PASS.

- [ ] **Step 7: Commit the public refresh**

```bash
git add src/app/page.tsx src/app/page.test.tsx src/app/scorecard src/app/pricing src/app/checkout src/app/claim src/app/privacy src/app/terms src/features/scorecard src/styles/marketing.css tests/e2e/visual-contracts.spec.ts
git commit -m "feat: refresh public Syntholo experience"
```

---

### Task 4: Core member learning and implementation surfaces

**Files:**
- Modify: `src/app/learn/course/page.tsx`
- Modify: `src/app/learn/course/[lessonId]/page.tsx`
- Modify: `src/features/course/lesson-workspace.tsx`
- Modify: `src/app/learn/plan/page.tsx`
- Modify: `src/features/implementation/implementation-plan.tsx`
- Modify: `src/app/learn/workflows/page.tsx`
- Modify: `src/features/implementation/workflow-board.tsx`
- Modify: `src/app/learn/templates/page.tsx`
- Modify: `src/app/learn/settings/page.tsx`
- Modify: `src/app/learn/settings/[section]/page.tsx`
- Modify: `src/styles/features.css`
- Modify: `src/styles/responsive.css`
- Modify: `tests/e2e/visual-contracts.spec.ts`

**Interfaces:**
- Consumes: Task 1 tokens/buttons and Task 2 member shell/page-heading hierarchy.
- Preserves: lesson completion, transcript/resources, artifact selection and review, workflow status transitions, templates, and settings navigation.
- Produces: readable `.course-stage`, `.lesson-main`, `.implementation-workspace`, `.workflow-card`, `.template-grid`, and `.settings-grid` contracts.

- [ ] **Step 1: Add failing computed-type contracts for core member pages**

Append to `tests/e2e/visual-contracts.spec.ts`:

```ts
test("core member workspaces keep body and controls readable", async ({ page }) => {
  await page.goto("/learn/course");
  expect(await fontSize(page.locator(".stage-intro p").first())).toBeGreaterThanOrEqual(15);
  expect(await fontSize(page.locator(".stage-lessons strong").first())).toBeGreaterThanOrEqual(13);

  await page.goto("/learn/plan");
  expect(await fontSize(page.locator(".document-preview p").first())).toBeGreaterThanOrEqual(15);

  await page.goto("/learn/workflows");
  expect(await fontSize(page.locator(".workflow-card > p").first())).toBeGreaterThanOrEqual(15);
});
```

- [ ] **Step 2: Run the member contracts and verify they fail**

Run:

```bash
npm run test:e2e -- tests/e2e/visual-contracts.spec.ts
```

Expected: FAIL because the current course, plan, and workflow body text is 7–10px.

- [ ] **Step 3: Refresh the course map and lesson workspace**

Apply these layout rules in `features.css`:

```css
.course-stage { grid-template-columns: minmax(240px, 0.38fr) minmax(0, 1fr); }
.stage-intro p,
.stage-lessons p,
.lesson-heading p,
.lesson-action-card p,
.transcript-copy { font-size: var(--text-body); }
.stage-lessons strong,
.lesson-resource-row strong,
.transcript-toggle { font-size: var(--text-ui); }
.lesson-main { border-radius: var(--radius-card); box-shadow: var(--shadow-card); }
```

Keep all 18 lessons, statuses, transcript content, actions, and resources. Do not add or remove course behavior.

- [ ] **Step 4: Reduce the implementation-plan layout from three packed columns to two**

Use:

```css
.implementation-workspace {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  gap: 18px;
}
.review-rail { grid-column: 2; }
.artifact-nav strong,
.artifact-actions,
.review-rail label { font-size: var(--text-ui); }
.document-preview p,
.document-preview li,
.review-rail > p { font-size: var(--text-body); }
```

Preserve artifact switching, version information, review requests, and autosave/conflict messaging.

- [ ] **Step 5: Refresh workflows, templates, and settings**

- Use a two-column workflow grid at widths of 900px and above; use one column below 900px.
- Increase workflow title to 18–21px, body to 15–16px, controls to 13–14px, and metadata to 11–12px.
- Use coral, teal, and gold tints by engine; retain visible status labels.
- Keep templates/settings at two columns on desktop and one below 900px.
- Replace text-only micro-actions with the shared Button or a 44px link/button target.

- [ ] **Step 6: Run existing feature and visual tests**

Run:

```bash
npm test -- src/features/course src/features/implementation
npm run test:e2e -- tests/e2e/core-journeys.spec.ts tests/e2e/visual-contracts.spec.ts
npm run typecheck
npm run lint
```

Expected: all commands PASS.

- [ ] **Step 7: Commit the core member refresh**

```bash
git add src/app/learn/course src/app/learn/plan src/app/learn/workflows src/app/learn/templates src/app/learn/settings src/features/course src/features/implementation src/styles/features.css src/styles/responsive.css tests/e2e/visual-contracts.spec.ts
git commit -m "feat: simplify member learning workspaces"
```

---

### Task 5: Human support, community, live, and Business OS surfaces

**Files:**
- Modify: `src/app/learn/support/page.tsx`
- Modify: `src/features/support/support-inbox.tsx`
- Modify: `src/app/learn/community/page.tsx`
- Modify: `src/features/community/community-feed.tsx`
- Modify: `src/app/learn/live/page.tsx`
- Modify: `src/features/live/live-schedule.tsx`
- Modify: `src/app/learn/business-os/page.tsx`
- Modify: `src/features/business-os/business-os-onboarding.tsx`
- Modify: `src/styles/features.css`
- Modify: `src/styles/responsive.css`
- Modify: `tests/e2e/visual-contracts.spec.ts`

**Interfaces:**
- Consumes: semantic coral `Button` for human support and gold `Button` for live/milestone actions.
- Preserves: support thread selection/replies, SLA display, community posting/reactions/spaces, live RSVP/recordings, and Business OS onboarding/provisioning.
- Produces: lower-density two-column support and community layouts with readable conversation and post text.

- [ ] **Step 1: Add failing visual contracts for human/community surfaces**

Append:

```ts
test("human and community surfaces use readable conversation text", async ({ page }) => {
  await page.goto("/learn/support");
  expect(await fontSize(page.locator(".message-stream article p").first())).toBeGreaterThanOrEqual(15);
  await expect(page.getByRole("button", { name: /send reply/i })).toHaveCSS(
    "background-color",
    "rgb(239, 125, 98)",
  );

  await page.goto("/learn/community");
  expect(await fontSize(page.locator(".community-post > p").first())).toBeGreaterThanOrEqual(15);
});
```

- [ ] **Step 2: Run the contract and verify it fails**

Run:

```bash
npm run test:e2e -- tests/e2e/visual-contracts.spec.ts
```

Expected: FAIL because support/community body text is currently 7–9px and the reply action is teal.

- [ ] **Step 3: Simplify support to a two-column conversation layout**

Use:

```css
.support-inbox { grid-template-columns: 280px minmax(0, 1fr); }
.coach-profile { grid-column: 1 / -1; display: grid; grid-template-columns: auto 1fr auto; }
.message-stream article p,
.support-standard p { font-size: var(--text-body); }
.thread-list > button strong,
.message-stream article strong,
.reply-composer label { font-size: var(--text-ui); }
```

Change the Send Reply action to `variant="human"`. Keep attachments, thread statuses, coach identity, and SLA text intact.

- [ ] **Step 4: Simplify community and live sessions**

- Use a two-column community layout: 220px spaces plus one main feed; place the community rail below the feed.
- Use 15–16px post bodies, 13–14px author/actions, and 11–12px dates/status.
- Keep the create-post form and reactions unchanged.
- Use one spacious live-session card per row, a teal-tinted date field, and `variant="milestone"` for calendar actions.
- Retain RSVP, recording, timezone, capacity, and waitlist state.

- [ ] **Step 5: Refresh Business OS without increasing sales pressure**

- Keep the optional/white-label disclosures visible.
- Increase overview and checklist body copy to 15–16px and controls to 13–14px.
- Use teal for setup progress, gold for provisioning milestones, coral only for blocked/waiting states, and navy for final activation emphasis.
- Preserve every onboarding checkbox and provisioning transition.

- [ ] **Step 6: Run human-layer tests and journeys**

Run:

```bash
npm test -- src/features/support src/features/community src/features/live src/features/business-os
npm run test:e2e -- tests/e2e/core-journeys.spec.ts tests/e2e/visual-contracts.spec.ts
npm run typecheck
npm run lint
```

Expected: all commands PASS.

- [ ] **Step 7: Commit the human/community refresh**

```bash
git add src/app/learn/support src/app/learn/community src/app/learn/live src/app/learn/business-os src/features/support src/features/community src/features/live src/features/business-os src/styles/features.css src/styles/responsive.css tests/e2e/visual-contracts.spec.ts
git commit -m "feat: clarify human learning surfaces"
```

---

### Task 6: Calm, readable administration

**Files:**
- Modify: `src/components/admin-shell.tsx:1-18`
- Modify: `src/app/admin/page.tsx:1-19`
- Modify: `src/app/admin/[section]/page.tsx`
- Modify: `src/app/admin/content/page.tsx`
- Modify: `src/app/admin/provisioning/page.tsx`
- Modify: `src/styles/admin.css`
- Modify: `src/styles/responsive.css`
- Modify: `tests/e2e/visual-contracts.spec.ts`

**Interfaces:**
- Consumes: shared tokens, focus behavior, and Button primitives.
- Preserves: all admin routes, metrics, tables, content controls, provisioning checks, and links.
- Produces: 13px minimum table rows, 12px minimum labels, restrained status tints, and no playful illustrations.

- [ ] **Step 1: Add a failing admin visual contract**

Append:

```ts
test("admin remains dense but readable", async ({ page }) => {
  await page.goto("/admin");
  expect(await fontSize(page.locator(".admin-page-head p"))).toBeGreaterThanOrEqual(15);
  expect(await fontSize(page.locator(".admin-metric-grid small").first())).toBeGreaterThanOrEqual(12);

  await page.goto("/admin/customers");
  expect(await fontSize(page.locator(".admin-table strong").first())).toBeGreaterThanOrEqual(13);
});
```

- [ ] **Step 2: Run the admin contract and verify it fails**

Run:

```bash
npm run test:e2e -- tests/e2e/visual-contracts.spec.ts
```

Expected: FAIL because current admin descriptions, labels, and table rows are 7–10px.

- [ ] **Step 3: Refresh the admin shell and overview**

Use:

```css
.admin-shell { grid-template-columns: 220px minmax(0, 1fr); background: var(--canvas); }
.admin-sidebar { background: var(--surface); border-right: 1px solid var(--border); }
.admin-page-head h1 { font-size: clamp(2rem, 3vw, 2.5rem); }
.admin-page-head p { font-size: var(--text-body); }
.admin-metric-grid small { font-size: var(--text-meta); }
.admin-metric-grid strong { font-size: 1.75rem; }
```

Use white/canvas surfaces, navy headings, teal active navigation, and restrained success/warning/error tints. Do not add illustrations or ambient motion.

- [ ] **Step 4: Refresh tables, content, and provisioning**

- Make table row primary text at least 13px and detail text at least 12px.
- Maintain responsive overflow within the table container, never on the page root.
- Increase content-editor and provisioning labels to 12–14px and body copy to 15px.
- Keep existing status text next to every tint.
- Keep activation disabled until all seven checks pass.
- Use only hover/focus feedback, panel transitions, and progress/status animation.

- [ ] **Step 5: Run admin and quality checks**

Run:

```bash
npm run test:e2e -- tests/e2e/core-journeys.spec.ts tests/e2e/visual-contracts.spec.ts
npm run typecheck
npm run lint
```

Expected: all commands PASS.

- [ ] **Step 6: Commit the admin refresh**

```bash
git add src/components/admin-shell.tsx src/app/admin src/styles/admin.css src/styles/responsive.css tests/e2e/visual-contracts.spec.ts
git commit -m "feat: improve admin readability"
```

---

### Task 7: Responsive, motion, accessibility, and visual-regression gates

**Files:**
- Modify: `src/styles/base.css`
- Modify: `src/styles/member.css`
- Modify: `src/styles/features.css`
- Modify: `src/styles/admin.css`
- Modify: `src/styles/responsive.css`
- Modify: `tests/e2e/accessibility.spec.ts:4-45`
- Modify: `tests/e2e/visual-contracts.spec.ts`
- Create: `tests/e2e/visual-regression.spec.ts`
- Create: `tests/e2e/visual-regression.spec.ts-snapshots/*.png`
- Modify: `design.md`
- Modify: `docs/quality/accessibility-audit.md`

**Interfaces:**
- Consumes: all refreshed surfaces from Tasks 1–6.
- Produces: exact responsive breakpoints, reduced-motion guarantees, committed screenshot baselines, and updated visual documentation.
- Preserves: existing desktop/mobile Playwright projects and all axe routes.

- [ ] **Step 1: Expand overflow and touch-target coverage**

Update the axe route array in `tests/e2e/accessibility.spec.ts` to:

```ts
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
  "/admin",
  "/admin/provisioning",
];
```

Keep axe scans on the desktop project for deterministic results. Update the mobile overflow loop to cover:

```ts
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
  "/admin",
  "/admin/customers",
  "/admin/provisioning",
];
```

For every route, assert `scrollWidth <= innerWidth + 1`. Check the first visible primary action on `/`, `/learn`, `/learn/support`, and `/learn/business-os` is at least 44px high.

- [ ] **Step 2: Add the failing full motion contract**

Append to `tests/e2e/visual-contracts.spec.ts`:

```ts
test("reduced motion removes transforms and animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/learn");
  const motion = await page.locator(".dashboard-course-art").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      animation: style.animationName,
      transition: style.transitionDuration,
      transform: style.transform,
    };
  });
  expect(motion.animation).toBe("none");
  expect(motion.transform).toBe("none");
  expect(motion.transition).toBe("0s");
});
```

- [ ] **Step 3: Implement exact responsive rules**

In `responsive.css`:

```css
@media (max-width: 1179px) {
  .dashboard-layout { grid-template-columns: 1fr; }
  .dashboard-right-rail { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 899px) {
  .dashboard-right-rail,
  .dashboard-recommendations,
  .workflow-grid,
  .template-grid,
  .settings-grid { grid-template-columns: 1fr; }
  .implementation-workspace { grid-template-columns: 1fr; }
  .review-rail { grid-column: 1; }
}
@media (max-width: 767px) {
  .member-shell,
  .admin-shell { grid-template-columns: 1fr; }
  .dashboard-continue-card { grid-template-columns: 1fr; }
  .member-page,
  .admin-page { width: min(100% - 32px, 100%); }
}
```

Use the existing mobile navigation mechanism; do not create a second navigation implementation.

- [ ] **Step 4: Implement the global reduced-motion contract**

In `base.css`:

```css
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    transform: none !important;
  }
}
```

Ensure every status and selection still has visible text when animation is removed.

- [ ] **Step 5: Add stable visual-regression screenshots**

Create `tests/e2e/visual-regression.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

const pages = [
  ["homepage", "/"],
  ["member-dashboard", "/learn"],
  ["course-workspace", "/learn/course/growth-2"],
  ["support-inbox", "/learn/support"],
  ["admin-overview", "/admin"],
] as const;

for (const [name, path] of pages) {
  test(`${name} visual baseline`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(path);
    await expect(page).toHaveScreenshot(`${name}.png`, {
      animations: "disabled",
      fullPage: true,
    });
  });
}
```

Generate and inspect baselines:

```bash
npm run test:e2e -- tests/e2e/visual-regression.spec.ts --update-snapshots
```

Expected: ten reviewed images, one desktop and one mobile baseline for each route.

- [ ] **Step 6: Update design and accessibility documentation**

Update `design.md` to point to `docs/superpowers/specs/2026-08-12-visual-refresh-design.md` and replace the old small-type guidance with the approved type scale, semantic buttons, Uxcel-inspired hierarchy, and CSS-only motion rules. Update `docs/quality/accessibility-audit.md` with the new representative routes, screenshot gates, type floor, and reduced-motion test.

- [ ] **Step 7: Run the complete verification suite**

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
git diff --check
```

Expected:

- Lint PASS.
- TypeScript PASS.
- All unit tests PASS, including the original 48.
- Next.js production build PASS with the same route inventory.
- All desktop/mobile journeys, visual contracts, accessibility checks, overflow checks, and screenshot comparisons PASS.
- `git diff --check` reports no whitespace errors.

- [ ] **Step 8: Commit final quality gates and documentation**

```bash
git add src/styles tests/e2e design.md docs/quality/accessibility-audit.md
git commit -m "test: verify Syntholo visual refresh"
```

---

## Completion Evidence

Before calling the refresh complete, record:

- Final unit-test count and pass count.
- Final Playwright desktop/mobile pass and skip counts.
- Production build result and route inventory.
- Paths to the ten committed visual baselines.
- Confirmation that no meaningful interface text is below 11px on the representative routes.
- Confirmation that body copy is at least 15px on marketing, course, plan, workflows, support, community, Business OS, and admin overview descriptions.
- Confirmation that member home contains one Continue Learning card, two recommendations, and three right-rail cards.
- Confirmation that reduced motion removes ambient transforms and animations.
