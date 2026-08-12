# Task 3 — Public marketing and acquisition refresh

## Status

Complete on `codex/visual-refresh`.

## RED evidence

- Added homepage semantic-action assertions in `src/app/page.test.tsx`; the existing markup already passed them.
- Added `tests/e2e/visual-contracts.spec.ts`; it failed on both desktop and mobile because `.outcome-card p` computed to `13px` (required minimum: `15px`).
- Added the returned-answer state test in `src/features/scorecard/scorecard-client.test.tsx`; it failed because the chosen option had neither `aria-pressed="true"` nor a visible `Selected` label.

Commands and observed RED results:

```text
npm test -- src/app/page.test.tsx src/features/scorecard/scorecard-client.test.tsx
PASS before the selected-answer test; then FAIL as expected on aria-pressed.

npm run test:e2e -- tests/e2e/visual-contracts.spec.ts
FAIL on desktop and mobile: .outcome-card p was 13px.
```

## GREEN implementation

- Simplified the homepage blueprint by removing duplicate miniature status text; scorecard acquisition actions are teal and the program action remains navy.
- Applied public typography, card-density, semantic tint, padding, and 180–240ms interaction rules in `src/styles/marketing.css` for homepage, scorecard, pricing, checkout, claim, and legal surfaces.
- Kept checkout and claim visibly labeled as demos.
- Made returned scorecard answers expose `aria-pressed`, a teal selected state, and a visible `Selected` label without changing score calculation, progression, report gating, or back navigation.
- Added desktop/mobile Playwright visual contracts for public body typography and teal primary acquisition action.

## Files

- `src/app/page.tsx`
- `src/app/page.test.tsx`
- `src/app/claim/page.tsx`
- `src/features/scorecard/scorecard-client.tsx`
- `src/features/scorecard/scorecard-client.test.tsx`
- `src/styles/marketing.css`
- `tests/e2e/visual-contracts.spec.ts`

## Verification

```text
npm test -- src/app/page.test.tsx src/features/scorecard
PASS — 3 files, 13 tests

npm run test:e2e -- tests/e2e/core-journeys.spec.ts tests/e2e/visual-contracts.spec.ts
PASS — 10 tests across desktop and mobile

npm run typecheck
PASS

npm run lint
PASS

git diff --check
PASS
```

## Self-review

- Reviewed the exact diff after final verification.
- Confirmed only Task 3 public/acquisition files and this task report are included.
- Confirmed no route, scoring, report gate, checkout request, legal body content, or integration contract changed.

## Concerns

None. Playwright emitted the environment's existing `NO_COLOR`/`FORCE_COLOR` warning while all tests passed.
