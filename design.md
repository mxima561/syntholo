# Syntholo Product Design Specification

**Company:** Syntholo  
**Product:** AI Operating System Academy  
**Status:** Approved  
**Updated:** 2026-08-12
**Visual refresh:** [Approved Syntholo visual-refresh specification](docs/superpowers/specs/2026-08-12-visual-refresh-design.md)
**Production architecture:** [Production Launch PRD Addendum](docs/superpowers/specs/2026-08-12-production-launch-design.md)

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

The interface keeps the approved Trusted Growth identity and interprets Uxcel's learning-product hierarchy for Syntholo: quiet navigation, one dominant continuation task, a small recommendation area, and visible human help. It does not copy Uxcel's branding, illustrations, text, or component geometry.

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
- Page titles are 32–40px on desktop and 28–34px on mobile; section titles are 19–24px and card titles are 16–21px.
- Body copy is 15–17px, navigation and controls are 13–14px, and metadata is 11–12px. No meaningful interface text renders below 11px.
- Controls use 8–11px corners, content cards use 14–18px, and major shells use 20–24px.
- Spacing uses a 4px base scale with 16–24px card padding and 24–40px section gaps.
- Borders are thin, shadows are soft, and one dominant action appears per content region.

### Semantic actions

- Teal is the default primary action: start, resume, or save.
- Coral identifies an action involving a human, such as asking a coach or reading a coach reply.
- Gold with navy text marks milestones, calendar actions, and progress rewards.
- Navy provides high emphasis when teal is already active nearby; white or quiet treatments are secondary.
- Every button uses a 13–14px text label, a minimum 44px target, visible focus, and text that communicates its outcome. Color is never the only signal.

### Guided Command Center hierarchy

- Member home contains one Continue Learning card with one Resume lesson action and the original CSS learning illustration.
- At most two contextual recommendations follow the continuation task.
- The right rail contains exactly the focused support set: weekly priorities, human coach activity, and the next live session.
- From 900–1179px the right rail becomes a three-card row; below 900px it stacks. Below 768px the existing compact member navigation remains the only navigation implementation.
- Semantic color and learning progress carry the visual signature; surrounding surfaces remain quiet and restrained.

### Motion

- All interaction and ambient motion is CSS-only. Hover, focus, and press feedback lasts 180–260ms; cards lift no more than 3px and buttons no more than 2px.
- `prefers-reduced-motion: reduce` disables animation, transitions, transforms, smooth scrolling, and nonessential reveals globally.
- Status and selection remain understandable through visible text when motion is disabled.

### Accessibility

- WCAG 2.1 AA contrast.
- Keyboard-complete operation and visible focus.
- Captions and transcripts for every required video.
- Primary controls use at least 44px touch targets; dense admin table utilities preserve a 44px hit area.
- Screen-reader labels, reduced motion, and no color-only meaning.

## Content design

The course has six stages, 18 short lessons, and five shared outputs: readiness/opportunity map, team AI policy, three-workflow launch portfolio, team enablement checklist, and 90-day roadmap. Personal lesson progress is separate from shared business implementation.

### Certificates

Each member receives an unaccredited PDF certificate upon completing all 18 published lessons. No public verification lookup, no certificate ID system, and no accreditation claims in v1. Certificate issuance is driven by lesson-completion state, independent of purchase tier or support-window status.

Self-paced customers receive all stages immediately. Pilot stages are bundled into four weekly releases: Diagnose + Rules, Growth, Client + Management, and Launch + Roadmap.

Every lesson contains a 5–12 minute video, captions, transcript, summary, action, and relevant resources. Commercial recommendations are contextual, optional, and clearly labeled as affiliate or white-label relationships.

## Commercial experience

- Readiness Scorecard: free.
- Guided Pilot: $750, three seats.
- Self-Paced Course: $399, three seats, lifetime course access, 12 months support.
- Operator Club: $59/month or $590/year.
- Syntholo Business OS: $999 onboarding plus $199/month.

Course buyers keep lifetime access. After 12 months, community becomes read-only and active human support requires Operator Club. Operator Club is available only to existing Academy accounts; if selected before included support expires, billing and renewed support/community access begin at expiry. Business OS uses a separate branded HighLevel login and never blocks academy access.

### Refunds, disputes, and cancellations

Academy purchases have an unconditional seven-day refund window, subject to mandatory law. An approved full refund marks the purchase-sourced course, support, and community grants as refunded and releases its seats without deleting the account, lesson-progress history, previously issued certificates, or audit events. Operator Club cancellation takes effect at the end of the paid term. Failed recurring payments receive seven days of grace; day eight restricts the affected paid benefits without deleting customer data. Business OS onboarding is refundable until provisioning starts; cancellation of the monthly service never changes Academy access.

An open Stripe dispute creates an administrative hold that blocks new purchases, teammate invitations or replacements, and Business OS activation while preserving existing learning access until the dispute is resolved. A won dispute clears the hold. A lost dispute revokes only the grants sourced from the disputed transaction. Every request, decision, Stripe action, webhook, grant transition, and customer notice is idempotent and audited.

The unconditional seven-day Academy refund window must appear consistently on the Self-Paced sales page, Guided Pilot offer and approval email, public or private Academy checkout, and terms of service before payments are enabled. Checkout must show the policy beside the purchase action and link to the full terms. Operator Club and Business OS use their separate cancellation and refund disclosures. Legal counsel must approve the final customer-facing language before launch.

### Business OS activation standard

Business OS activation requires all seven checks to pass: lead capture, lead routing, calendar booking, inbound and outbound messaging, client onboarding, AI escalation to a human, and dashboard reporting activity. Each check stores its status, evidence, actor, and timestamp in Syntholo. Activation remains disabled until all seven pass. HighLevel remains separately authenticated and does not share sessions or mirrored customer data with Syntholo.

V1 post-activation monitoring is manual, not continuous. An operator re-runs and records all seven checks monthly for every active Business OS account and after any material HighLevel change or customer-reported incident. A failed check changes the Syntholo status to `degraded`, opens an operations incident, and notifies the customer without affecting Academy access. Revisit automated synthetic monitoring when the first of these triggers occurs: 25 active Business OS accounts, two customer-discovered degradations before the scheduled check within 90 days, or more than eight operator hours per month spent on re-verification. Any future automation must preserve HighLevel's separate authentication and must not mirror customer data into Syntholo.

## V1 exclusions

Automated AI coaching, native workflow builder, HighLevel SSO or mirrored data, mobile apps, gamification, multilingual content, local currencies, direct messaging, private coaching, and custom per-client Business OS builds.
