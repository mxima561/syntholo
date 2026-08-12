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
