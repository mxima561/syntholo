# Accessibility audit: Syntholo platform

**Standard:** WCAG 2.1 AA  
**Date:** August 11, 2026  
**Scope:** public homepage, scorecard, member dashboard, human support, Business OS, and administrator overview

## Summary

The final automated scan reports **zero detectable WCAG 2.1 A/AA violations** across all six representative product surfaces in desktop Chromium. The same component system is exercised at the mobile breakpoint with WebKit.

The audit initially identified low contrast in subtle gray labels, coral text, coach avatars, and paused-SLA labels. The design system now retains the bright Trusted Growth accents for decoration while using darker ink variants for text and identity badges.

## Evidence

| Area | Result |
|---|---|
| Automated WCAG 2.1 A/AA scan | 6 representative pages pass with no detectable violations |
| Keyboard scorecard response | Enter advances to the next question |
| Reduced motion | Meaningful transitions collapse to 0.01 ms |
| Mobile reflow | Core public, member, support, and admin pages have no document-level horizontal overflow at 390 px |
| Primary mobile action | Scorecard call to action is at least 44 px tall |
| Form labels | Scorecard, checkout, support, community, onboarding, and admin search controls have accessible names |
| Landmarks and headings | Automated scan found no landmark or heading-order violations |
| Focus visibility | Global three-pixel focus indicator is visible on links, buttons, and fields |

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
