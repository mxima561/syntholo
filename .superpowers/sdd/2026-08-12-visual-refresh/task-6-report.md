# Task 6 — Calm, readable administration

## RED

- Added `admin remains dense but readable` to `tests/e2e/visual-contracts.spec.ts`.
- Ran `npm run test:e2e -- tests/e2e/visual-contracts.spec.ts` before implementation.
- The new assertion failed on desktop and mobile as intended: `.admin-page-head p` computed to `9px`, below the required `15px`.

## GREEN

- Refreshed the 220px administration shell with canvas/surface layers, navy headings, teal route state, restrained token-based status tints, and no illustration or ambient animation.
- Raised overview, table, content-editor, and provisioning type to the approved readable floors. Table primary text is `13px`; table/detail and label text are at least `12px`; body copy is `16px`.
- Preserved every existing route, metric, table, control, provisioning check, and link. The activation control remains disabled while four of seven checks are complete.
- Scoped responsive table overflow to `.admin-table`; mobile navigation and controls retain 44px targets.

## Verification

- `npm run test:e2e -- tests/e2e/core-journeys.spec.ts tests/e2e/visual-contracts.spec.ts` — PASS (19 passed, 1 expected desktop-only skip; desktop and mobile projects)
- `npm run typecheck` — PASS
- `npm run lint` — PASS
- `git diff --check` — PASS
