# Accessibility audit: Syntholo platform

**Standard:** WCAG 2.1 AA  
**Date:** August 12, 2026
**Scope:** homepage, scorecard, pricing, member dashboard, lesson workspace, implementation plan, workflows, human support, community, Business OS, administrator overview, and provisioning

## Summary

The final automated scan reports **zero detectable WCAG 2.1 A/AA violations** across all 12 representative product surfaces in desktop Chromium. Mobile Chromium emulation exercises 13 public, member, support, community, Business OS, and admin routes at the 390px breakpoint.

The audit identified low contrast in subtle gray labels, coral text, coach avatars, paused-SLA labels, and refreshed metadata. The design system retains the bright Trusted Growth accents for decoration while using darker ink variants for text and identity badges. It also enforces the approved 11px meaningful-text floor and 15px body-copy floor on representative reading descriptions.

## Evidence

| Area | Result |
|---|---|
| Automated WCAG 2.1 A/AA scan | 12 representative desktop routes pass with no detectable violations |
| Keyboard scorecard response | Enter advances to the next question |
| Reduced motion | Global CSS removes animation, transitions, transforms, smooth scrolling, and nonessential reveals; the rendered dashboard illustration reports `animation-name: none`, `transition-duration: 0s`, and `transform: none` |
| Mobile reflow | 13 representative routes have no document-level horizontal overflow at 390px; wide tables and support thread lists remain internally scrollable |
| Primary mobile actions | The first visible semantic actions on the homepage, member dashboard, support inbox, and Business OS are each at least 44px tall |
| Meaningful text floor | Visible direct interface text on all 12 scan routes is at least 11px |
| Body-copy floor | Marketing, course, plan, workflows, support, community, Business OS, and admin overview descriptions are at least 15px |
| Visual regression | Five routes are reviewed at desktop and mobile sizes: homepage, member dashboard, lesson workspace, support inbox, and admin overview |
| Form labels | Scorecard, checkout, support, community, onboarding, and admin search controls have accessible names |
| Landmarks and headings | Automated scan found no landmark or heading-order violations |
| Focus visibility | Global three-pixel focus indicator is visible on links, buttons, and fields |

The ten committed image gates live in `tests/e2e/visual-regression.spec.ts-snapshots/`. The screenshot fixture disables motion, removes only the Next.js development indicator, and places the fixed mobile navigation in its reserved bottom clearance before capturing the full page.

## Color contrast

| Token/use | Final treatment | WCAG result |
|---|---|---|
| Muted text on white/canvas | `#62645F` | AA normal text |
| Coral text on light surfaces | `#9D3F2A` ink variant | AA normal text |
| Bright coral `#EF7D62` | Decorative dots, fills, and non-text accents | Preserves brand palette |
| Paused SLA text | `#5F4812` on warm neutral | AA normal text |
| Teal primary actions | White on `#0F6F70` | AA |
| Human coach avatars | White on coral ink variant | AA |

## Keyboard and screen-reader behavior

- Native links and buttons are used for navigation and actions.
- Question answers, workflow states, lesson completion, RSVPs, support replies, and onboarding checks work from the keyboard.
- Progress, form labels, disabled states, `aria-current`, `aria-expanded`, and descriptive action labels expose state without relying on color alone.
- Motion preference is honored globally.
- Dynamic support dates are formatted deterministically to avoid hydration changes in the accessibility tree.

## Remaining launch checks

Automated tests do not replace assistive-technology validation. Before public launch, complete one manual pass with VoiceOver/Safari and NVDA/Chrome, confirm real Mux player captions/transcripts, test checkout errors in live Stripe elements, and re-run the scan whenever vendor widgets or production content change.
