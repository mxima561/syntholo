# Task 4 — Core member learning and implementation surfaces

## RED / GREEN evidence

- RED: `npm run test:e2e -- tests/e2e/visual-contracts.spec.ts`
  - Failed on the new core-member contract as intended: `.stage-intro p` rendered at `9px`, below the required `15px` floor (desktop and mobile).
- GREEN: `npm run test:e2e -- --project=desktop tests/e2e/visual-contracts.spec.ts -g 'core member'`
  - Passed: 1 test.
- GREEN: `npm run test:e2e -- --project=mobile tests/e2e/visual-contracts.spec.ts -g 'core member'`
  - Passed: 1 test.

The plan contract selects the Team enablement checklist before checking `.document-preview`, because the initial selected portfolio deliberately renders the workflow preview instead of a document preview.

## Delivered

- Raised course-map, lesson workspace, plan document, workflow, template, and settings typography to shared readable body/UI/meta tokens.
- Applied the two-column course, implementation, workflow, template, and settings layouts, including single-column behavior below 900px.
- Moved the plan review rail into the implementation workspace’s second column; the timeline remains full width.
- Added coral, teal, and gold workflow engine tints while retaining visible statuses.
- Replaced workflow and settings micro-actions with the shared 44px Button; used human semantic buttons for coaching requests.
- Kept existing lesson completion/transcript/resources, artifact state/review/autosave behavior, and workflow transitions unchanged.

## Files changed

- `src/app/learn/settings/page.tsx`
- `src/app/learn/settings/[section]/page.tsx`
- `src/features/course/lesson-workspace.tsx`
- `src/features/implementation/implementation-plan.tsx`
- `src/features/implementation/workflow-board.tsx`
- `src/styles/features.css`
- `src/styles/responsive.css`
- `tests/e2e/visual-contracts.spec.ts`

## Verification

- `npm test -- src/features/course src/features/implementation` — PASS (4 files, 8 tests)
- `npm run test:e2e -- tests/e2e/core-journeys.spec.ts tests/e2e/visual-contracts.spec.ts` — PASS (12 tests across desktop and mobile)
- `npm run typecheck` — PASS
- `npm run lint` — PASS
- `git diff --check` — PASS

## Concerns

None. The Playwright runner emits an environment warning about `NO_COLOR` and `FORCE_COLOR`; it is pre-existing command-environment noise and did not affect any results.
