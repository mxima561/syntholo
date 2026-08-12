# Syntholo demo and production runbook

## 1. Operating modes

### Demo

`APP_MODE=demo` is the safe default. It renders the complete Northstar Advisory journey with deterministic records and in-browser interaction. Vendor clients are lazy: opening the site, running tests, and building do not contact third parties. Checkout is clearly labeled as a preview and makes no charge.

### Production

`APP_MODE=production` fails configuration validation unless the core identity, database, payment, video, email, analytics, and file credentials are all present. HighLevel stays optional until Business OS is sold. `/api/health` reports which adapters are configured without exposing credentials.

## 2. Launch sequence

1. Create separate vendor projects for staging and production.
2. Store secrets in the deployment platform; never commit `.env.local`.
3. Configure WorkOS callback/logout URLs and organization membership rules.
4. Create Stripe products/prices for Self-Paced, Operator Club, and Business OS setup/monthly billing.
5. Register Stripe’s webhook URL at `https://<domain>/api/webhooks/stripe` and subscribe only to checkout, payment, subscription, invoice, dispute, and refund events the entitlement service uses.
6. Create MongoDB indexes for organization scoping, unique identity IDs, lesson progress, artifact version, support SLA, and unique webhook provider/event ID.
7. Configure Mux signed playback, Vercel Blob private downloads, Resend SPF/DKIM/DMARC, and PostHog data residency.
8. Create Zoom sessions in the approved regions and paste host/join metadata into the session editor.
9. Run the complete quality suite and staging smoke tests.
10. Enable production mode, verify `/api/health`, process one low-value real payment, refund it, and confirm entitlement reversal.

## 3. Acquisition and access process

1. Visitor completes 20 scorecard questions.
2. Syntholo calculates five dimension scores, an overall readiness band, three priorities, and one recommended workflow.
3. Visitor supplies contact details and explicit educational-email consent to unlock the full report.
4. Stripe Checkout collects payment and sends a signed webhook.
5. Webhook signature is verified and event ID is atomically claimed in MongoDB. Replays return success without applying fulfillment twice.
6. Fulfillment creates the purchase, organization, three-seat entitlement, account-claim token, and receipt email.
7. WorkOS claims the account and binds the identity to exactly one customer organization.
8. Refunds/revocations update entitlements through the same idempotent event path.

Operations response: a payment may never create duplicate seats or duplicate renewal records. A vendor outage is retried from the durable receipt/job record and must not block learning or support.

## 4. Learning and implementation process

The command center chooses one action in this order: access issue, coach response waiting on the customer, session inside 48 hours, next lesson, incomplete artifact, coach feedback, then community.

Personal lesson progress is stored by member. The five implementation outputs are shared by organization and preserve version history. Program completion requires all 18 lessons, all five outputs finalized, and one Growth, Client, and Management workflow live.

Conflicting artifact edits should preserve both versions, show who changed the document, and require an owner to choose or merge. “Ask coach to review” creates a private support thread with the exact artifact version attached.

## 5. Human support process

1. New questions enter the shared customer inbox and route round-robin to an available coach.
2. The substantive-response target is two U.S. business days.
3. Operations receives a warning in the final eight business hours.
4. The clock pauses in `waiting_on_customer` and resumes on the customer reply.
5. Private attachments accept PDF, DOCX, XLSX, CSV, PNG, and JPG up to 25 MB after malware scanning.
6. A coach resolves the thread only when the question or requested artifact review is complete.

Never represent an automated assistant as the customer’s coach. V1 support is explicitly human.

## 6. Live sessions and community

Self-Paced and Operator Club receive two repeated monthly office hours: Americas and Europe/Asia. RSVP displays the member’s local time, enforces capacity/waitlist, provides a calendar file, sends 24-hour and one-hour reminders, and exposes the join action 15 minutes before start. Publish edited teaching/Q&A recordings within two business days.

Community uses real name, role, and business. Posts publish immediately and can be reported, hidden, restored, locked, or removed. Every moderation action creates an audit event. Expired support changes community write access to read-only while lifetime course access continues.

## 7. Business OS provisioning

The offer must always disclose that Syntholo configures and supports a white-label HighLevel workspace and that usage charges may be separate.

1. Collect $999 setup and begin $199/month billing under the displayed renewal terms.
2. Customer completes brand/business, pipeline, calendar, messaging registration, and assistant-scope sections.
3. Five-business-day provisioning starts only when the questionnaire is 100% complete.
4. External verification or missing customer access pauses the clock with a visible reason.
5. Operator configures the approved snapshot and records internal notes.
6. Activation stays disabled until lead capture, routing, booking, messages, onboarding, AI escalation, and dashboard activity all pass.
7. Customer receives activation email and an external-login action.
8. Cancellation warns about lost access, exports approved data, and preserves billing/audit records.

## 8. Security and privacy controls

- Enforce organization scope in every repository query, not only the UI.
- Keep coach/admin roles separate; coaches cannot manage billing or entitlements.
- Use private object storage, signed short-lived downloads, upload type/size validation, and malware scanning.
- Encrypt vendor secrets at rest and rotate on staff or vendor incidents.
- Log role, entitlement, refund, publication, moderation, and provisioning changes with actor and timestamp.
- Avoid client names or confidential material in analytics properties.
- Back up MongoDB and test restore at least quarterly.

## 9. Incident and support readiness

| Incident | Immediate action | Customer impact rule |
|---|---|---|
| Stripe webhook backlog | Pause manual fulfillment, inspect receipt IDs, replay signed events | Never fulfill the same event twice |
| WorkOS unavailable | Keep public/course content cached; show access status | Do not bypass authorization |
| MongoDB unavailable | Enter read-only/degraded mode and queue safe writes | Do not write to demo data |
| Mux unavailable | Show transcript/resources and retry playback | Learning remains useful |
| Email unavailable | Preserve notification jobs and retry | Account/security notices take priority |
| HighLevel unavailable | Keep Academy/support available and show Business OS status | Optional software cannot block course access |

## 10. Release checklist

- Legal counsel approves privacy, terms, refund, affiliate, and white-label disclosures.
- Cross-organization authorization tests pass for member, coach, and admin roles.
- Payment, refund, replay, expiration, and entitlement transitions pass.
- Keyboard, automated WCAG, contrast, 200% zoom, reduced-motion, mobile, and desktop checks pass.
- Two coaches are trained; escalation and incident owners are assigned.
- Four pilot calls or two monthly office-hour variants are scheduled.
- HighLevel snapshot and seven-check activation runbook are approved.
- Analytics events exclude confidential customer content.
- Restore, incident, cancellation/export, and customer support drills are complete.
