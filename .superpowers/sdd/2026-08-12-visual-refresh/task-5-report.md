# Task 5 — Human support, community, live, and Business OS surfaces

## RED / GREEN evidence

- RED: `npm run test:e2e -- tests/e2e/visual-contracts.spec.ts`
  - Failed as intended on the new human/community contract: `.message-stream article p` rendered at `9px`, below the required `15px` floor on desktop and mobile.
- GREEN: the same visual-contract command passed after the Task 5 changes (8 tests across desktop and mobile).

## Delivered

- Reworked support into a 280px thread rail and conversation panel with the named human coach profile spanning below, while preserving thread selection, replies, attachments, statuses, SLA copy, and coach identity.
- Applied coral to support actions, including Send reply; raised conversation, attachment, and support-standard text to shared body/UI/meta scales with 44px controls.
- Reworked community into 220px spaces plus feed and moved the rail below; retained post composer, spaces, reactions, reporting, and real-name context with readable post/meta/action typography.
- Made each live session a spacious single-row card with teal date treatment and gold calendar/reservation actions; retained RSVP, recordings, timezone formatting, attendee count, and host data.
- Raised Business OS overview, disclosure, checklist, and provisioning typography; kept the optional white-label HighLevel and recurring-charge disclosure visible. Setup is teal, provisioning milestones gold, and no Business OS state behavior changed.

## Files changed

- `src/features/support/support-inbox.tsx`
- `src/features/live/live-schedule.tsx`
- `src/features/business-os/business-os-onboarding.tsx`
- `src/styles/features.css`
- `src/styles/responsive.css`
- `tests/e2e/visual-contracts.spec.ts`

## Verification

- `npm test -- src/features/support src/features/community src/features/live src/features/business-os` — PASS (6 files, 10 tests)
- `npm run test:e2e -- tests/e2e/core-journeys.spec.ts tests/e2e/visual-contracts.spec.ts` — PASS (16 tests across desktop and mobile)
- `npm run typecheck` — PASS
- `npm run lint` — PASS
- `git diff --check` — PASS

## Review and concerns

Self-review found one coach-profile grid auto-placement issue; it was corrected by assigning its identity, specialties, and support-standard rows explicitly before the final verification run.

No remaining Task 5 concerns. The Playwright runner continues to emit the pre-existing `NO_COLOR`/`FORCE_COLOR` environment warning without affecting results.

## Fix round 1 — mobile support layout and human-action contrast

### Dispositions

- Fixed the mobile coach profile by assigning the avatar, name, role, details, and human-support standard to explicit grid rows below 720px. The coach profile remains visible and its desktop layout is unchanged.
- Retained the exact coral human-action background and changed shared `.button-human` text/icons to navy `#102A35`, which provides the required normal-text contrast while preserving disabled button behavior.

### RED / GREEN evidence

- RED: `npm run test:e2e -- tests/e2e/visual-contracts.spec.ts`
  - The new Send Reply color assertion received white rather than `rgb(16, 42, 53)` on desktop and mobile.
  - The new mobile geometry contract found the coach details began at `1412.48px` while the avatar/role content extended to `1654.88px`, proving an overlap.
- GREEN: the same visual-contract command passed after the scoped CSS changes (9 passed, 1 intentional desktop skip for the mobile-only contract).

### Fix-round verification

- `npm test -- src/features/support src/features/community src/features/live src/features/business-os` — PASS (6 files, 10 tests)
- `npm run test:e2e -- tests/e2e/core-journeys.spec.ts tests/e2e/visual-contracts.spec.ts` — PASS (17 passed across desktop and mobile; 1 intentional desktop skip)
- `npm run typecheck` — PASS
- `npm run lint` — PASS when run after Playwright, which avoids Playwright's transient `test-results` cleanup race
- `git diff --check` — PASS
