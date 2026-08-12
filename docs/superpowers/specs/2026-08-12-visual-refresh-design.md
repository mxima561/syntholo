# Syntholo Visual Refresh Design

**Status:** Approved design
**Date:** 2026-08-12
**Scope:** Public marketing, member learning platform, and admin presentation layer

## 1. Purpose

Refresh Syntholo so it feels easier to read, less crowded, more colorful, and more interactive without changing the approved product behavior. The current implementation is functionally complete, but many member and admin labels are 6–10px, several pages show too many equal-weight panels, most surfaces are white, and motion is limited to small hover effects.

The refresh keeps the existing Trusted Growth identity and adopts the information hierarchy seen in Uxcel's learning dashboard: quiet navigation, one dominant continue-learning card, a small recommendation area, and a focused right rail. The implementation must interpret that hierarchy for Syntholo rather than copy Uxcel's branding or components.

Reference screens:

- [Uxcel learner dashboard](https://mobbin.com/screens/68933767-f763-41a5-94ed-967cadaac831)
- [Uxcel course-progress dashboard](https://mobbin.com/screens/e2def7c6-f7a3-4d84-81f7-6eae55ac7f07)

## 2. Goals

- Make every primary task readable without zooming or leaning into the screen.
- Reduce the number of simultaneously competing panels and actions.
- Preserve Syntholo's light, trustworthy palette while concentrating color in actions, illustrations, progress, and status surfaces.
- Make the member dashboard feel like a focused learning product rather than a dense operating console.
- Add restrained interaction feedback and motion without distracting from course content.
- Apply improvements consistently through reusable tokens and components.
- Preserve all existing routes, domain behavior, demo data, and integration boundaries.

## 3. Non-goals

- No product-flow, navigation, entitlement, course, support, community, or admin behavior changes.
- No new AI coach or automated support experience.
- No dark, brown, beige, or sand-led rebrand.
- No wholesale component rewrite when an existing component can be restyled safely.
- No new animation framework. Implement approved motion with CSS.
- No copying Uxcel illustrations, icons, text, brand colors, or exact component geometry.

## 4. Visual direction

### 4.1 Palette

Keep the approved Trusted Growth tokens:

| Token | Value | Refreshed use |
|---|---:|---|
| Canvas | `#F8F8F6` | Primary page background |
| Surface | `#FFFFFF` | Navigation, cards, inputs, and raised panels |
| Ink | `#181818` | General text |
| Muted | `#777773` | Secondary text that passes contrast requirements |
| Border | `#E8E8E4` | Quiet separation |
| Navy | `#102A35` | Headings, high-emphasis surfaces, and high-emphasis actions |
| Teal | `#0F6F70` | Default primary actions, progress, and active navigation |
| Coral | `#EF7D62` | Human-support actions and warm highlights |
| Gold | `#D5A943` | Milestones, live events, and progress rewards |
| Success | `#2A9D73` | Completed and healthy states |
| Danger | `#B9473F` | Destructive and failed states |

White remains available but cannot be the only visible surface. Use pale teal, coral, and gold tints for illustration fields, human-support panels, milestones, progress, and selected states. Avoid dark warm canvases.

### 4.2 Typography

Continue using Manrope for headings and Inter for body/interface copy.

| Use | Desktop size | Mobile size | Notes |
|---|---:|---:|---|
| Page title | 32–40px | 28–34px | Tight Manrope tracking |
| Section title | 19–24px | 18–22px | One clear hierarchy level |
| Card title | 16–21px | 16–19px | No miniature card headings |
| Body copy | 15–17px | 15–16px | Default reading text |
| Navigation/control | 13–14px | 14px | Touch-friendly and readable |
| Metadata | 11–12px | 11–12px | Reserved for dates, durations, and compact status |

No meaningful interface text may render below 11px. Legal fine print may use 11px only when it remains WCAG-compliant and is not required to complete a task.

### 4.3 Geometry and spacing

- Keep the 4px spacing base but use 16–24px internal card padding and 24–40px page-section gaps.
- Controls use 8–11px corners; content cards use 14–18px; major shells use 20–24px.
- Use thin borders and soft shadows. Shadows may communicate hover or hierarchy, not decorate every card.
- Avoid more than four equal-weight cards in one desktop row. Prefer two-card recommendation grids.
- Use one dominant action per content region.

### 4.4 Buttons

All buttons use readable 13–14px labels and a minimum 44px target, except dense admin table utilities, which may use a 40px visual height while preserving a 44px hit area.

- **Teal:** default primary action, such as Start scorecard, Resume lesson, or Save.
- **Coral:** explicitly human actions, such as Ask a coach or Read coach reply.
- **Gold with navy text:** milestones and calendar/progress actions.
- **Navy:** high-emphasis continuation or confirmation where teal is already used nearby.
- **White/quiet:** secondary navigation and low-emphasis actions.

Color cannot be the only signal. Every button needs a clear text label, focus state, hover state, pressed state, and disabled state.

## 5. Member dashboard structure

The member dashboard follows this desktop hierarchy:

1. Quiet left sidebar with grouped navigation and a compact identity block.
2. Top bar with a prominent Browse lessons and templates link plus no more than two compact status chips.
3. Main column with welcome copy, one Continue Learning card, and up to two recommendations.
4. Right rail with no more than three cards: weekly priorities, human coach activity, and the next live session.

### Continue Learning card

- Use a colorful abstract Syntholo illustration built from original CSS shapes or project-owned assets.
- Show stage, lesson title, one-sentence description, progress, and one Resume Lesson action.
- Do not show workflow diagrams, multiple metrics, and secondary actions inside this card.

### Recommendations

- Show at most two contextual recommendations.
- Each card contains one tinted illustration field, a short label, title, one-sentence description, and one action.
- Recommendations must be based on existing demo/domain data; no new recommendation engine is in scope.

### Right rail

- Weekly priorities show up to three compact checklist rows.
- Human coach activity uses a coral tint and names the real coach.
- The next session uses a teal tint with a gold calendar action.
- The rail moves below the main column at tablet sizes and becomes a single stack on mobile.

## 6. Other surfaces

### 6.1 Public marketing

- Preserve the existing page narrative and Trusted Growth palette.
- Increase small proof, outcome, program, and footer text to the new type scale.
- Reduce tightly packed micro-labels and decorative dashboard detail.
- Use teal, coral, gold, and navy buttons according to their semantic roles.
- Use tinted section backgrounds or illustration fields to break up long white sections.
- Keep one primary acquisition action per section.

### 6.2 Member interior pages

- Apply the same type scale, spacing, button roles, and tinted surface rules.
- Course maps, workflows, plans, support, community, live sessions, settings, and Business OS keep their existing functionality.
- Replace miniature multi-column layouts with progressive disclosure, tabs, stacked groups, or fewer visible items when needed.
- Preserve transcripts, files, statuses, and operational detail, but move secondary metadata below the primary title instead of compressing it beside the title.

### 6.3 Administration

- Use the improved typography, spacing, focus, and responsive behavior.
- Keep admin calmer than marketing/member pages: white and canvas surfaces with navy/teal structure and restrained status tints.
- Do not use playful course illustrations in administration.
- Tables may remain information-dense, but row text must be at least 13px and labels at least 12px.
- Admin motion is limited to hover/focus feedback, panel transitions, and progress/status changes.

## 7. Component and stylesheet architecture

The existing `src/app/globals.css` is large and mixes foundation, marketing, member, feature, responsive, and admin rules. The refresh will split it into focused style layers imported by the application root:

- `src/styles/tokens.css` — color, typography, spacing, radius, shadow, and motion tokens.
- `src/styles/base.css` — reset, body, links, focus, reduced motion, and shared layout primitives.
- `src/styles/marketing.css` — public acquisition pages.
- `src/styles/member.css` — member shell and shared member-page patterns.
- `src/styles/features.css` — course, plan, workflow, support, live, community, and Business OS feature styles.
- `src/styles/admin.css` — admin shell, tables, content, and provisioning.
- `src/styles/responsive.css` — shared breakpoint behavior when a rule spans multiple surfaces.

Create or extract these reusable React components where existing markup is duplicated or oversized:

- `DashboardContinueCard`
- `DashboardRecommendationCard`
- `DashboardRightRail`
- `SectionHeader`
- Expanded `Button` variants for semantic color roles
- `IllustrationPanel` for original CSS illustrations

Components consume existing domain/demo data. The refresh does not introduce new persistence, API calls, or client state. Existing server/client boundaries remain in place.

## 8. Motion and interaction

Motion is restrained product feedback:

- 180–260ms hover, focus, and press transitions.
- Cards may lift up to 3px on pointer hover.
- Buttons move up to 2px on hover and compress slightly on press.
- Progress bars and rings animate once when entering the view.
- The homepage and member dashboard use a short one-time opacity/vertical reveal for their major content groups. Interior member pages and admin pages do not use section reveals.
- One slow ambient illustration animation is allowed per major view; it must not sit behind reading text or compete with the primary action.
- Navigation hover and active-state colors transition for 180ms. Route changes do not add page-transition animation or delay navigation.
- Loading states use quiet skeletons or progress indicators; avoid indefinite decorative motion.

`prefers-reduced-motion: reduce` disables ambient movement, transforms, scroll behavior, and nonessential reveals. Essential state changes remain immediate and understandable.

## 9. Responsive behavior

- At widths of 1180px and above, the desktop sidebar and two-column dashboard remain visible.
- From 768px through 1179px, the right rail moves below the main column. It uses a three-card row from 900px through 1179px and a single stack below 900px.
- Below 768px, navigation uses the existing compact/mobile mechanism, all content becomes one column, and cards use 16–20px padding.
- Below 768px, the Browse lessons and templates link collapses to a labeled icon action and remains keyboard-accessible.
- No horizontal page overflow is allowed from tables, support inboxes, cards, or illustrations.
- Primary controls remain at least 44px tall on touch devices.

## 10. States and error handling

Loading, empty, disabled, restricted, error, success, and offline/degraded states use the same refreshed type and component hierarchy.

- Empty states provide one explanation and one next action.
- Errors preserve user-entered content where applicable and show a recovery action.
- Disabled buttons explain the unmet condition nearby when it is not self-evident.
- Vendor failures remain isolated to their feature, as defined by the existing architecture.
- Color never carries status alone; pair every status tint with a visible text label. Preserve an existing status icon when the component already uses one.

## 11. Verification

Preserve the existing green baseline: lint, TypeScript, 48 unit tests, production build, and browser journeys.

Add or update verification for:

- Dashboard Continue Learning, recommendation, and right-rail content.
- Semantic button variants and accessible names.
- Desktop, tablet, and mobile responsive layouts.
- No horizontal overflow on public, member, support, course, workflow, and admin pages.
- Automated WCAG scans on representative routes.
- Keyboard navigation and visible focus through sidebar, dashboard, cards, and primary actions.
- Reduced-motion behavior for ambient illustrations, reveals, progress, cards, and buttons.
- Visual screenshots for the homepage, member dashboard, course workspace, support inbox, and admin overview at desktop and mobile widths.

## 12. Acceptance criteria

- No meaningful interface text below 11px; body reading text is at least 15px.
- Member home visibly prioritizes one Continue Learning card, at most two recommendations, and at most three right-rail cards.
- Public and member pages use the original Trusted Growth palette with colorful semantic buttons and tinted surfaces.
- Admin uses the calmer Trusted Growth variation.
- Existing product flows and route behavior remain unchanged.
- All interaction motion honors reduced-motion preferences.
- Lint, typecheck, unit tests, production build, Playwright journeys, accessibility scans, and visual checks pass.
