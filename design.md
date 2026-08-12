# Syntholo Product Design Specification

**Company:** Syntholo  
**Product:** AI Operating System Academy  
**Status:** Approved  
**Updated:** 2026-08-11

## Product promise

In 30 days, a professional-services business establishes safe AI rules, launches three useful workflows, trains its team, and leaves with a 90-day roadmap. The experience is an implementation program with visible human help—not a passive video library and not an automated AI coach.

## Experience architecture

The responsive product has four surfaces:

1. **Public:** marketing, curriculum, scorecard, pricing, legal pages, and checkout entry.
2. **Member:** guided command center, course, shared artifacts, sessions, human support, community, billing, and Business OS link.
3. **Coach:** round-robin support queue, artifact feedback, session tools, and moderation.
4. **Admin:** structured content editor, cohorts, customers, purchases, entitlements, recommendations, analytics, and Business OS provisioning.

The member home is the approved **Guided Command Center**. It gives one action primary emphasis using this precedence: access issue, coach response awaiting the customer, session within 48 hours, next lesson, incomplete required artifact, received feedback, then optional community or commercial recommendation.

## Human-support model

- Pilot businesses receive four weekly Zoom sessions.
- Self-paced businesses receive two repeated office-hours sessions monthly, covering Americas-friendly and Europe/Asia-friendly times.
- The owner and two teammates share one coach inbox.
- Coaches provide the first substantive reply within two Syntholo business days.
- Artifact feedback is provided on request, with one active artifact review per business.
- There is no automated AI coach in v1.

## Visual system: Trusted Growth

The interface takes inspiration from Magnific's generous whitespace, restrained surfaces, clear navigation, and product-grade hierarchy without copying its brand.

### Personality

Premium, calm, human, optimistic, direct, and credible. Avoid corporate-gray monotony, science-fiction motifs, robots, glowing brains, and unexplained technical jargon.

### Color tokens

| Token | Value | Usage |
|---|---|---|
| Canvas | `#F8F8F6` | Page background |
| Surface | `#FFFFFF` | Cards, panels, navigation |
| Ink | `#181818` | Primary text |
| Muted | `#777773` | Secondary text |
| Border | `#E8E8E4` | Dividers and card outlines |
| Navy | `#102A35` | Hero surfaces and dark emphasis |
| Teal | `#0F6F70` | Primary actions and active navigation |
| Coral | `#EF7D62` | Highlights and human moments |
| Gold | `#D5A943` | Milestones and premium details |
| Success | `#2A9D73` | Completed and healthy states |
| Danger | `#B9473F` | Destructive and failed states |

### Typography and geometry

- Manrope for headings; Inter for body and interface copy.
- Headings use tight tracking and strong weight; body copy stays short and plain.
- Controls use 8px corners, cards 12–16px, and application shells 22px.
- Spacing uses a 4px base scale.
- Borders are thin, shadows are soft, and one primary action appears per screen.
- Motion lasts 150–220ms and honors reduced-motion preferences.

### Accessibility

- WCAG 2.1 AA contrast.
- Keyboard-complete operation and visible focus.
- Captions and transcripts for every required video.
- 44px touch targets where practical.
- Screen-reader labels, reduced motion, and no color-only meaning.

## Content design

The course has six stages, 18 short lessons, and five shared outputs: readiness/opportunity map, team AI policy, three-workflow launch portfolio, team enablement checklist, and 90-day roadmap. Personal lesson progress is separate from shared business implementation.

Self-paced customers receive all stages immediately. Pilot stages are bundled into four weekly releases: Diagnose + Rules, Growth, Client + Management, and Launch + Roadmap.

Every lesson contains a 5–12 minute video, captions, transcript, summary, action, and relevant resources. Commercial recommendations are contextual, optional, and clearly labeled as affiliate or white-label relationships.

## Commercial experience

- Readiness Scorecard: free.
- Guided Pilot: $750, three seats.
- Self-Paced Course: $399, three seats, lifetime course access, 12 months support.
- Operator Club: $59/month or $590/year.
- Syntholo Business OS: $999 onboarding plus $199/month.

Course buyers keep lifetime access. After 12 months, community becomes read-only and active human support requires Operator Club. Business OS uses a separate branded HighLevel login and never blocks academy access.

## V1 exclusions

Automated AI coaching, native workflow builder, HighLevel SSO or mirrored data, mobile apps, gamification, certificates, multilingual content, local currencies, direct messaging, private coaching, and custom per-client Business OS builds.

