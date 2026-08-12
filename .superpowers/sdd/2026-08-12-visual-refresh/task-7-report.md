# Task 7 report: responsive, motion, accessibility, and visual regression

**Branch:** `codex/visual-refresh`

**Starting commit:** `e1c0afe4d98645f0da69db69883f099dbe50c661`

**Date:** August 12, 2026

## Outcome

Task 7 is complete. The refreshed public, member, support, community, Business OS, and admin surfaces now have exact responsive contracts at 1179px, 899px, and 767px; a global reduced-motion contract; expanded accessibility, type, overflow, touch-target, composition, and visual-regression coverage; and ten reviewed screenshot baselines.

The implementation preserves the existing desktop/mobile Playwright projects, routes, demo behavior, and single member/admin navigation mechanisms. The Trusted Growth identity remains fixed: semantic teal, coral, gold, and navy carry meaning while surrounding surfaces stay quiet. The original CSS learning illustration remains the dashboard's visual signature.

## TDD evidence

The expanded contracts were written and observed failing before implementation:

- At 1179px the dashboard still rendered two columns.
- Representative page descriptions and multiple member-shell labels rendered below the approved 11px or 15px floors.
- Reduced motion left a dashboard illustration transform in place.
- Business OS measured 431px of document width in a 390px viewport.
- Axe reported contrast defects in subtle metadata, paused-SLA text, community text, and identity treatments.
- At the exact 767px edge the member navigation remained sticky instead of using the existing fixed mobile mechanism.
- Independent baseline review found the 1280x720 member sidebar identity ending at 731.78px and the selected support status overflowing its 112px desktop / 93px mobile boxes with 163px of content.

The corresponding focused GREEN runs passed after adding exact breakpoint rules, scoped contrast refinements, readable type floors, Business OS reflow, the global reduced-motion rule, compact sidebar spacing, and a readable wrapped support status. The final full verification is recorded below.

## Accessibility and layout contracts

- Twelve representative desktop routes pass automated WCAG 2.1 A/AA scans with zero detectable violations: `/`, `/scorecard`, `/pricing`, `/learn`, `/learn/course/growth-2`, `/learn/plan`, `/learn/workflows`, `/learn/support`, `/learn/community`, `/learn/business-os`, `/admin`, and `/admin/provisioning`.
- Thirteen mobile routes have `scrollWidth <= innerWidth + 1` at 390px: `/`, `/scorecard`, `/learn`, `/learn/course`, `/learn/course/growth-2`, `/learn/plan`, `/learn/workflows`, `/learn/support`, `/learn/community`, `/learn/business-os`, `/admin`, `/admin/customers`, and `/admin/provisioning`.
- The first visible semantic action on the homepage, member dashboard, support inbox, and Business OS is at least 44px high.
- No visible meaningful direct interface text on the twelve representative scan routes renders below 11px.
- Description/body copy is at least 15px on marketing, course, plan, workflows, support, community, Business OS, and admin overview surfaces.
- Member home contains exactly one Continue Learning card, two recommendation cards, and three right-rail cards.
- At 1179px the dashboard main/rail layout becomes one column and the rail becomes three columns; at 899px the rail and recommendation grids become one column; at 767px member/admin shells and the continue card become one column and the existing mobile navigation mechanisms activate.
- At 1280x720 the complete desktop member identity stays inside the sticky sidebar viewport.
- With `prefers-reduced-motion: reduce`, rendered dashboard artwork reports `animation-name: none`, `transition-duration: 0s`, and `transform: none`; CSS also disables smooth scrolling globally.

## Visual baselines

All ten baselines were captured with reduced motion at 1280px desktop and 390px mobile, then inspected at original resolution for hierarchy, clipping, overlap, whitespace, density, and accidental template artifacts:

- `tests/e2e/visual-regression.spec.ts-snapshots/homepage-desktop-darwin.png`
- `tests/e2e/visual-regression.spec.ts-snapshots/homepage-mobile-darwin.png`
- `tests/e2e/visual-regression.spec.ts-snapshots/member-dashboard-desktop-darwin.png`
- `tests/e2e/visual-regression.spec.ts-snapshots/member-dashboard-mobile-darwin.png`
- `tests/e2e/visual-regression.spec.ts-snapshots/course-workspace-desktop-darwin.png`
- `tests/e2e/visual-regression.spec.ts-snapshots/course-workspace-mobile-darwin.png`
- `tests/e2e/visual-regression.spec.ts-snapshots/support-inbox-desktop-darwin.png`
- `tests/e2e/visual-regression.spec.ts-snapshots/support-inbox-mobile-darwin.png`
- `tests/e2e/visual-regression.spec.ts-snapshots/admin-overview-desktop-darwin.png`
- `tests/e2e/visual-regression.spec.ts-snapshots/admin-overview-mobile-darwin.png`

Initial baselines contained the black Next.js development indicator over product content. The screenshot fixture now removes only `script[data-nextjs-dev-overlay="true"]` before capture; no real application content is hidden. The final images contain no dev indicator and no accidental generic/template decoration.

The mobile fixed member navigation is captured after scrolling to the document bottom, where the application's existing 86px clearance reserves its intended position and leaves every content action reachable. The support conversation rail is intentionally an internal horizontal scroller: at 390px it measures 356px client width and 595px scroll width while the document remains exactly 390px wide. The initial selected thread's complete status is now visible; its preview is deliberately line-clamped within the scrollable card. This is accepted as the existing discoverable rail interaction, not document overflow. The mobile admin navigation likewise remains the existing horizontal scroller with 44px targets and `min-width: max-content`; the viewport-edge glimpse of the next item signals additional destinations while every full label is reachable by horizontal scroll. This is accepted rather than adding a second nav or crowding all sections into 390px.

Final review found no inaccessible clipping, content/navigation overlap, root overflow, unbalanced whitespace, or density regression. Desktop sidebar identity and support-status truncation found during review were fixed before the final baselines.

## Verification

| Gate | Result |
|---|---|
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS: 21 files, 54/54 tests; the original 48 remain covered |
| `npm run build` | PASS: Next.js 16.3.0 production build; 23 static pages generated |
| `npm run test:e2e` | PASS: 58 passed, 16 intentionally skipped |
| Desktop Playwright | 35 passed, 2 skipped |
| Mobile Playwright | 23 passed, 14 skipped |
| Screenshot comparisons | 10 passed |
| `git diff --check` | PASS |

### Production route inventory

Static: `/`, `/_not-found`, `/admin`, `/admin/content`, `/admin/provisioning`, `/claim`, `/learn`, `/learn/business-os`, `/learn/community`, `/learn/course`, `/learn/live`, `/learn/plan`, `/learn/settings`, `/learn/support`, `/learn/templates`, `/learn/workflows`, `/pricing`, `/privacy`, `/scorecard`, `/terms`.

Dynamic/server-rendered: `/admin/[section]`, `/api/health`, `/api/webhooks/stripe`, `/checkout/[offer]`, `/learn/course/[lessonId]`, `/learn/settings/[section]`.

The route inventory is unchanged from the approved application surface.

## Remaining launch work

No Task 7 implementation blocker remains. The standing launch checks are manual VoiceOver/Safari and NVDA/Chrome passes, real Mux captions/transcripts, live Stripe error behavior, and renewed scans after production vendor widgets or content change.
