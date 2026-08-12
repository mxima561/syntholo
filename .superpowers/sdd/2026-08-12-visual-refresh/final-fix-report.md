# Final visual-refresh fix report

Base commit: `08ac015cc2c65005097d01563fbd868ccdcda2c4`

## Disposition

1. **Business OS intermediate-width overflow — fixed.**
   - Added a one-column `.business-os-layout` rule at the existing `max-width: 1179px` responsive tier.
   - Browser coverage sets 961px and 1020px viewports, asserts one computed grid column, and verifies `documentElement.scrollWidth <= clientWidth`.
   - RED: the 961px check found two grid columns. GREEN: both widths pass.

2. **Disabled shared buttons looked interactive — fixed.**
   - Added `.button:disabled` styling after variant rules: `not-allowed` cursor, 0.62 opacity, and no shadow. Disabled hover and active transforms are explicitly neutralized; disabled primary hover retains its base teal.
   - Browser coverage verifies the native disabled state and computed cursor, opacity, and hover transform for Support's `Send reply` and the admin `Activate Business OS` action.
   - RED: `Send reply` retained a `pointer` cursor. GREEN: both actions have a non-pointer cursor, opacity below 1, and `transform: none` while force-hovered.

3. **Implementation-plan coach action semantic variant — fixed.**
   - `Ask coach to review` now passes `variant="human"`.
   - Focused component test asserts its rendered `button-human` semantic class.
   - RED: it rendered as `button-primary`. GREEN: the focused test passes.

4. **Coach profile title size — fixed.**
   - Set `.coach-profile h2` to 18px, within the requested 16–21px card-title range.
   - Browser coverage reads the computed font size.
   - RED: the computed size was 14px. GREEN: the computed 18px value passes.

## Verification

- Focused component test: 1 passed.
- Focused desktop browser contracts: 3 passed.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test`: 22 files / 55 tests passed.
- `npm run build`: passed; 23 application routes generated.
- `npm run test:e2e`: 61 passed / 17 project-scoped skips.
- `git diff --check`: passed.

## Snapshot disposition

Only the support-inbox desktop and mobile baselines changed. Both were expected because the visible coach title changed from 14px to 18px and the empty reply action now visibly reads as disabled. The original comparisons differed by 922 desktop pixels and 842 mobile pixels (each 0.01%). Both regenerated snapshots were visually inspected and are balanced at desktop and mobile sizes. No other snapshot baseline changed.
