# Task 8 brief — Issue private personal completion certificates once

Read this first; it is the exact bounded task contract.

## Context

- Baseline commit: `6e4ff831bb0f76622d00953a8b01664b545ec4af`.
- Binding plan: `docs/superpowers/plans/2026-08-13-content-learning-certificates.md`, Task 8, interpreted by this plan workspace's `progress.md` Task 8 rulings and the contracts below.
- Published upstream migrations are immutable through `0012_implementation.sql`.
- Frozen `0012` SHA-256: `dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9`.
- Frozen upstream handshake: `packages/database/src/schema/implementation-handshake.json`; it requires `implementationCompletionIsAuthority: false` and `certificateEligibilityEvent: learning.course_completed.v1`.
- This task owns exactly `0013_certificates.sql` and associated contract/domain/database/integration/API/worker/web/docs/gate changes.
- No Commerce migration/provider composition, Resend delivery, public certificate lookup/ID/QR, privacy deletion/pseudonymization, push, deploy, or production provider mutation.

## Required authority

1. Certificate eligibility is only the personal immutable 0011 chain `learning.course_completed.v1` -> `certificate_prerequisites` -> exact `course_completions` tuple. No 0012 implementation artifact, workflow, or implementation completion may gate, create, revoke, rename, or otherwise affect a certificate.
2. A certificate uses a member-confirmed recipient display name. Never infer it from email, account name, Clerk/WorkOS fields, provider metadata, or demo data.
3. Recipient names are immutable, actor-bound versions with one optimistic current head per exact `(account_id,membership_id)`. Confirmation requires an active membership whose `member_identity_id` equals the authenticated actor. A completed member without a confirmed name is honestly `awaiting_recipient_name`.
4. One certificate record exists per personal `course_completion_id` and per exact prerequisite. It snapshots the business name, published course title/version, UTC completion time, renderer version, and the exact personal account/membership/enrollment/course/version tuple.
5. Recipient name/version may be absent at candidate creation. The only permitted snapshot mutation is a one-time bind from null to the exact confirmed current name version; after binding it is immutable.
6. One immutable private PDF file exists per certificate. Object key is exactly `certificates/v1/{accountId}/{courseCompletionId}.pdf`; MIME is `application/pdf`; store byte length, SHA-256, ETag, renderer version, and stored time. Never store a provider URL or signed URL.
7. Certificate and file survive refund, dispute, subscription changes, entitlement/access/seat revocation, support expiry, Circle change, Business OS degradation, later course publication, and every 0012 implementation state. V1 privacy deletion/pseudonymization is reserved for 0029.
8. A staff recovery request is an immutable, audited, receipt-bound fact with honest state `delivery_pending`. It accepts a reason only, never a destination override, and performs no email delivery. Migration 0027 will consume its frozen handshake.

## Recipient-name canonicalization and command hashing

- Canonical algorithm version is exactly `certificate-recipient-name.v1`.
- Ingress accepts a noncanonical but valid string of at most 256 Unicode scalar values and 1,024 UTF-8 bytes. Replace each maximal run of `HT | LF | VT | FF | CR | SPACE | U+0085 | U+00A0 | U+1680 | U+2000..U+200A | U+2028 | U+2029 | U+202F | U+205F | U+3000` with one ASCII space, trim leading/trailing ASCII space, then normalize the result to Unicode NFC. Store, hash, render, and return only that canonical result; the raw input is never persisted/audited/logged.
- Reject empty canonical output; more than 120 Unicode scalar values; more than 480 UTF-8 bytes; invalid/unpaired UTF-16 input; remaining C0/C1 controls including DEL; bidi controls `U+061C | U+200E | U+200F | U+202A..U+202E | U+2066..U+2069`; and Unicode noncharacters `U+FDD0..U+FDEF` or any scalar ending `FFFE`/`FFFF`.
- Every remaining scalar must have a nonzero glyph in at least one member of the exact ordered certificate font set: first `unifont-15.0.04.ttf`, then `unifont_upper-15.0.04.ttf`. A generated, committed `certificate-font-repertoire.v1` manifest freezes both ordered font asset names and SHA-256 values, `OFL.txt` SHA-256, `ATTRIBUTION.md` SHA-256, the sorted nonoverlapping union of supported code-point ranges, and its own canonical-manifest SHA-256. The first font in manifest order containing a nonzero glyph is authoritative for rendering; no other font may be consulted. Scalars absent from that exact union are rejected during name confirmation, never later in the worker. Browser-safe contracts, domain, PostgreSQL, and renderer must all consume/attest the same manifest semantics; PostgreSQL embeds/attests the exact union ranges in a closed helper and readiness hash.
- `content_hash` is lowercase SHA-256 of the exact UTF-8 bytes of `certificate-recipient-name.v1\n` followed by the canonical display name.
- TypeScript, PostgreSQL, browser input, receipt code, and PDF renderer use the same checked parity vectors, including acceptance/convergence of composed/decomposed and whitespace-equivalent supported names, every whitespace class, supported Latin/CJK/Arabic/Devanagari/Hebrew/astral fixtures present in the manifest union, selected manifest-missing scalar fixtures, controls, bidi controls, noncharacters, raw 256/257 scalars and 1,024/1,025 bytes, and canonical 120/121 scalars and 480/481 bytes. The same key with canonically equivalent raw input is an exact replay; a different canonical result is changed intent.
- Member PUT receipt scope is the exact derived `(account_id,membership_id)`, not merely the provider actor ID. The canonical request hash is lowercase SHA-256 over canonical JSON for `{ routeVersion: "certificate-recipient-name.v1", accountId, membershipId, expectedVersion, displayName: canonicalName }` with server-derived IDs. Same actor/key/body in another membership/account must not replay or suppress the command.
- Staff delivery receipt hash includes the server-derived `certificateId` as well as canonical reason: `{ routeVersion: "certificate-delivery.v1", certificateId, reason }`. A key reused for another certificate is a changed intent conflict, never a replay.

## Database model and closed transitions

Create exact Drizzle/SQL parity for:

- `certificate_recipient_name_versions`
  - immutable composite ownership `(id,account_id,membership_id)` and unique positive `(account_id,membership_id,version)`;
  - canonical Unicode display name, content hash, actor identity, source receipt, correlation, confirmed time;
  - unique source command receipt and no email/provider/account-name columns.
- `certificate_recipient_name_heads`
  - one row per `(account_id,membership_id)`;
  - exact optimistic `current_version/current_version_id` composite FK to the immutable version;
  - closed monotonic transition only; no delete.
- `certificate_records`
  - unique `course_completion_id` and unique `certificate_prerequisite_id`;
  - exact composite FKs to the 0011 prerequisite/completion tuple;
  - status exactly `awaiting_recipient_name | pending | failed | issued`;
  - immutable personal/business/course/completion snapshots and renderer version;
  - nullable recipient-name owner/version/snapshot fields with one-time null->confirmed bind only;
  - `failure_code` is null outside `failed` and otherwise one of the exact public-safe codes `snapshot_not_renderable | render_failed | storage_failed`;
  - closed transition edges are exactly `awaiting_recipient_name -> pending`, `awaiting_recipient_name -> failed`, `pending -> issued`, `pending -> failed`, and the controlled retry below; an exact replay is unchanged. `failed -> pending` is allowed only for `storage_failed`, through the closed worker retry command, when the deterministic object is absent or exactly reconciled. `snapshot_not_renderable` and `render_failed` are terminal and cannot be retried.
- `certificate_files`
  - one immutable row per certificate and course completion;
  - exact owner tuple; deterministic object key check; private access check; PDF MIME; positive bounded byte length; lowercase SHA-256; nonblank ETag; stored time;
  - insertion and matching replay only through the fenced worker finalizer.
- `certificate_delivery_requests`
  - immutable certificate/account/membership/staff/reason/source-receipt/correlation/created tuple;
  - status is exactly `delivery_pending`;
  - unique receipt, no destination/email/provider-message fields.

All customer-owned tables have immutable `account_id`, exact composite ownership, enabled+forced RLS, migrator-only raw DML, no PUBLIC authority, and narrow SECURITY DEFINER functions with fixed search paths. Member/staff/worker receive only exact function authority. Raw prerequisite/completion reads remain closed to new roles.

## Issuance and job flow

1. Keep `learning.certificate_prerequisite_record` as the sole consumer of `learning.course_completed.v1`. Its handler must finish both the immutable 0011 prerequisite record and idempotent 0013 candidate staging before completing the event-handler receipt.
2. Candidate staging cross-binds the event, prerequisite, course completion, membership, enrollment, course, and published course version. It snapshots business/course/version/completion facts and returns recorded/duplicate; wrong provenance is terminal.
3. Candidate staging evaluates the immutable business-name and course-title snapshots with the exact renderer input rules and frozen font-repertoire union. The business-name snapshot must satisfy the already-published canonical account-name rule (including its 255-byte bound). The course-title snapshot must be nonempty, already NFC, contain at most 255 Unicode scalars and 1,020 UTF-8 bytes, contain none of the C0/C1, DEL, bidi-control, surrogate, or noncharacter scalars forbidden for certificate names, and have a nonzero glyph for every scalar in the frozen font union. Neither snapshot is normalized, stripped, transliterated, or substituted at certificate time. Completion without a confirmed name remains `awaiting_recipient_name` and produces no direct certificate job even when either snapshot is not renderable.
4. Name confirmation binds every waiting record for that exact account/membership once. If both immutable snapshots are renderable, the record becomes `pending`; otherwise it becomes terminal `failed` with safe code `snapshot_not_renderable`, performs no provider work, and is not retry-authorized. The same rule applies when a candidate is staged after the name already exists. A bounded worker promoter also backfills historical prerequisites/candidates and enqueues only name-bound `pending` records after the new worker is deployed.
5. Do not enqueue direct certificate jobs inside the migration; an older worker must never dead-letter an unknown job type.
6. Direct job type is exactly `learning.course_completed.certificate.v1`; idempotency key is exactly `certificate:{courseCompletionId}`. Register the exact handler/registry/input schema and use independent durable job/handler receipts.
7. Generation verifies the complete live job fence before provider work and again before finalize. It renders deterministically, uploads privately with no overwrite/random suffix, then finalizes one exact file.
8. If upload succeeded but acknowledgement/finalize is ambiguous, read the deterministic object and compare actual bytes/hash/length/ETag before reconciling. Matching bytes continue idempotently; mismatched bytes are a permanent consistency incident and are never overwritten.
9. Terminal deterministic/provider-integrity errors become `failed`; dependency/network/timeout errors remain retryable. Unknown/programmer/config errors stay visible and do not masquerade as a successful or degraded issuance.
10. A `storage_failed` record may be recovered only by the bounded certificate-capable worker recovery pump. The pump selects an exact `dead_letter` direct certificate job and its exact terminal attempt receipt, rerenders the immutable certificate inputs, and immediately reads the deterministic private object before calling the closed retry command. The observation is exactly either `absent` with the expected PDF byte length and SHA-256 and null ETag, or `matching` with the same expected byte length/SHA-256 and the observed canonical strong ETag. Any provider-shape, pathname, MIME, length, hash, or object mismatch is a permanent consistency incident, appends one safe generation-scoped `certificate_storage_retry_rejected` audit fact, remains failed/dead-letter, and is suppressed from later automatic scans; a dependency/timeout observation appends nothing and remains eligible.
11. Recovery authority is scoped to the exact `(job_id, attempt, claim_generation)` dead-letter fact. The SQL command derives account, source event, correlation, and job provenance under locks; hardcodes safe system actor `certificate-recovery.v1`; preserves the job's attempt count; clears only claim/terminal fields; and requeues that same job identity for its next attempt/generation. It appends exactly one `certificate_storage_retry_authorized` audit fact for that failed generation containing only `jobId`, `attempt`, `claimGeneration`, `objectState`, expected `byteLength`/`sha256`, and optional observed `etag`. An exact same-action/same-body replay returns `duplicate`; a different observation/body or opposite decision on the same tuple returns safe `prior_decision`. Both create no second audit/requeue, and the pump treats `prior_decision` as a settled concurrent decision. A later `storage_failed` generation may be recovered once while `attempts < max_attempts`; exhaustion at five attempts is terminal, preventing an automatic recovery loop.
12. Rollout is two phase: apply `0013`; deploy the entire new worker fleet with certificate capability inactive so old/unsuffixed workers cannot claim direct certificate jobs; then activate the private Blob configuration and certificate-capable worker suffix fleet-wide; only after that enable recipient-name confirmation/API enqueue. Certificate-enabled workers must validate the exact Blob environment/store binding and renderer font/license/attribution/manifest authority before reporting ready or running promoter/recovery pumps.

## PDF and private Blob boundary

- Pin exactly `pdf-lib@1.17.1`, `@pdf-lib/fontkit@1.1.1`, and `@vercel/blob@2.8.0` in the owning workspaces/lockfile. Do not add Resend.
- Bundle the exact ordered two-font set, its `OFL.txt`, its `ATTRIBUTION.md`, and the generated cmap-union repertoire manifest. Freeze and test all five SHA-256 values: both fonts, license, attribution, and canonical manifest. Use only those fonts, in manifest order, for every user/provider-derived string and assert each scalar has a nonzero glyph before rendering; no fallback to `.notdef`, built-in fonts, system fonts, or process-dependent substitution.
- PDF copy is limited to: `Syntholo`; `Unaccredited certificate of completion`; confirmed recipient-name snapshot; course-title snapshot; business-name snapshot; course version; UTC completion date.
- Do not render/store a public or printable certificate ID, QR code, lookup/verification URL, seal, `verified`, `certified`, accreditation, grades, scores, support/purchase tier, or implementation state.
- Fix metadata, object ordering, dates, and renderer inputs so repeated identical input produces byte-identical PDF SHA-256. Tests must include Unicode and forbidden-copy scans.
- Blob configuration is server-only and fail-closed when enabled. Separate staging/production stores/tokens and attest the expected private origin/store context.
- Upload uses private access, the exact deterministic path, `addRandomSuffix:false`, `allowOverwrite:false`, explicit token and AbortSignal/deadline.
- Private Vercel Blob has no anonymous presigned-GET contract. The authenticated member download route server-fetches the exact private object with `@vercel/blob` `get()` and streams the verified PDF response. Never return the Blob `url`, `downloadUrl`, token, or an app/provider signed query URL.

## API routes and contracts

Append the missing name route and replace the outdated certificate-download `303` row in `docs/architecture/http-route-contract.md` with the authenticated streamed-`200` contract below. The Task 8 brief supersedes that technically impossible 303 wording; register exactly these certificate routes and no public equivalent:

- `GET /v1/member/certificate-recipient-name`
  - active actor-bound membership; no body/query/HEAD; no-store;
  - returns strict schema version and current confirmed version/name or null.
- `PUT /v1/member/certificate-recipient-name`
  - active actor-bound membership; authorization before receipt replay;
  - required idempotency key; exact body `{ expectedVersion, displayName }`; optimistic conflict 409; first/replay 200;
  - receipt binds principal/method/exact route/key/request hash for 30 days.
- `GET /v1/member/certificates`
  - active actor-bound membership only, independent of current entitlement/access;
  - default 25/max 100 signed opaque cursor bound to actor/account/membership/route/limit;
  - collection is exactly `{ items, nextCursor }`; statuses are `awaiting_recipient_name | pending | failed | issued`.
  - every item includes `snapshotRenderable`. When true, `businessName` and `courseTitle` are the exact safe renderable snapshots. When false, both fields are exactly null and the raw immutable DB snapshots must not enter any response, error, audit, outbox, log, analytics, or client state. `snapshotRenderable:false` is valid only for `awaiting_recipient_name` with null failure/name, or `failed` with a confirmed recipient name and exact failure code `snapshot_not_renderable`; it is impossible for `pending`, `issued`, `render_failed`, or `storage_failed`. The UI uses static generic copy such as `Course title unavailable` and never reconstructs or guesses the hidden snapshots.
- `GET /v1/member/certificates/:certificateId/download`
  - active actor-bound earning membership and issued file only; teammates/cross-account/unknown/unissued collapse 404;
  - server-fetches the exact private object and returns `200` streamed `application/pdf`, exact `Content-Length`, safe attachment filename, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and no Blob/provider URL in any header/body/log/audit/analytics/Sentry;
  - stream acquisition and transfer are bounded/cancellable; object key/hash/length/MIME/ETag are reconciled to the immutable file row before response. A mismatch fails closed and records a consistency incident; never overwrite.
- `POST /v1/staff/certificates/:certificateId/deliveries`
  - WorkOS admin, permission `certificates:deliver`, R5 and CSRF;
  - required idempotency key; exact body `{ reason }`; authorization before replay;
  - under the same locked command transaction, require the target certificate to be `issued` and its one immutable exact file row to exist; unknown, awaiting, pending, failed, cross-account, or file-missing targets collapse to safe 404 and create no receipt/request/audit fact;
  - first/replay `202 { status: "delivery_pending" }`; no destination override and no provider send.

Reject GET bodies, unknown query/body keys, malformed cursors/IDs/keys, wrong content type, and implicit HEAD. All responses/errors are strict, correlation-bearing, no-store, and vary on Authorization where applicable. No certificate/name/content/provider URL appears in audit error details or logs beyond the explicitly safe snapshots in the certificate record.

## Production UI

- Add a real production certificate settings surface under `/learn/settings/certificates` using browser-safe certificate contracts only; demo imports remain dynamic-only in explicit demo mode.
- Show confirmed-name setup/edit with optimistic version, awaiting-name candidates, pending/failed/issued states, one issued certificate per completion, and a private download action only for `issued`.
- The UI must say `Unaccredited certificate of completion`; never show a certificate number, verification/accreditation claim, QR, public share/lookup, or delivery-success claim.
- Session-key all name/list/download state and mutation intents to Clerk session/account; immediately hide old content and reject late GET/PUT/list/download results on switch/sign-out or validated access loss.
- Idempotent retry reuses the exact serialized name body/key. Conflicts keep the unsynced name in memory for explicit copy/reload; nothing enters local/session storage, URL, cookies, analytics, Sentry, or console.
- Add keyboard, 44px, live-region, mobile/no-overflow, axe, and production artifact/demo/secret proof.

## Migration, readiness, and handshakes

- Re-read the journal before editing. `0013` must be journal index `12` with a unique timestamp strictly greater than `1786856400000`; update exact Drizzle hash, `PUBLISHED_MIGRATIONS`, reset/schema/ACL inventories, and all exact fixtures only after SQL freezes.
- Add `syntholo_certificates_readiness_v1()` and runtime checking; preserve and attest 0011/0012 hashes and prior readiness contracts.
- Attest exact tables/columns/PK/FK/unique/check/index/trigger/RLS/policies/ACLs/functions/owners/prosecdef/provolatile/proconfig/PUBLIC denial, receipt route bindings, one-time name binding, one record/file/job/object, and seed/promoter/finalizer authority.
- Explicitly attest the absence of any certificate FK/function/query dependency on 0012 implementation tables and on Commerce/entitlement/support/Circle/Business OS state.
- Commit a SHA-bound 0013 handshake containing migration tuple/hash; exact 0011 prerequisite/completion tuple; frozen 0012 hash/non-authority assertion; name head/version keys; certificate/file/delivery keys; job type/key; deterministic Blob path; API routes/statuses; and the exact 0027 delivery-request consumer shape.
- The published migration journal contains exactly 13 ordered rows after apply and rerun.

## TDD and required evidence

- Capture focused RED before production edits.
- Contracts/domain: name canonicalization, exact statuses/routes, unknown rejection, PDF input/copy, eligibility independence, object/job keys, safe errors.
- Real PG: blank/prior/repeat/populated 0012->0013; exact 13-row journal/hash; actual member/staff/worker logins; unset/half-scope/cross-account/cross-member/teammate denial; name replay/conflict/in-flight/race; event replay/race; name-before-completion and completion-before-name; promoter replay; immutability and hostile FK/ACL/readiness drift.
- Independence: refund, dispute, subscription/grace, entitlement/access/seat revocation, support expiry, Circle change, Business OS degradation, later course version, and every 0012 implementation state leave certificate/file/name snapshot unchanged.
- Worker/provider: live fence, duplicate/racing jobs, deterministic Unicode PDF hash, private upload exact call, upload-before-finalize and finalize-before-ack recovery, matching-object reconciliation, mismatched-object permanent incident, abort/deadline/lease poisoning.
- API: exact route/body/query/HEAD/content-type, membership-scoped auth before replay, cross-account/cross-target same-key tests, signed cursor, 404 collapse, R5/CSRF/permission, streamed-PDF headers/body/hash and aborted-transfer behavior, no secret/provider URL leakage.
- Blob: anonymous provider denial, authenticated server `get()` success, missing/mismatched object failure, wrong path/origin/store denial, staging/production isolation. Use only disposable provider state if an authorized provider test is available; otherwise keep the provider gate explicitly pending rather than claiming it.
- Web/E2E: name confirmation, awaiting->pending->issued, one private download, conflict/retry, account switch/late responses, mobile/keyboard/axe, no demo/public-share/secret leakage, honest staff `delivery_pending`.
- Run affected/full lint/typecheck/unit, production builds/artifact scans, dependency/secret policy, disposable Neon migration/readiness/full DB, production Playwright, `git diff --check`.

## Report and commit contract

Write `.superpowers/sdd/2026-08-13-content-learning-certificates/task-8-report.md`. Include RED/GREEN evidence, migration hash/handshake, Neon/provider evidence, UI/browser results, changed files, decisions, explicit pending external gates, and concerns. Force-add the ignored brief/report. Commit locally only when all available gates are green and formally reviewed. No push/deploy/provider production mutation. Return only status, commit SHA, one-line gates, and concerns.
