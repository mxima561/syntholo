# Identity and session boundary

Syntholo keeps consumer and workforce identity separate. Clerk session JWTs
authenticate members; Clerk / Cloudflare Access authenticates staff. Neither issuer can
cross the other API surface, and provider claims never become internal account,
membership, or staff identifiers without an active PostgreSQL mapping.

## Browser topology

Each environment has one explicit `WEB_ORIGIN`. The browser calls relative
`/v1/**` paths, and Next.js applies a `beforeFiles` external rewrite to the
separately deployed Fastify `API_UPSTREAM_ORIGIN`. This facade preserves status,
body, `Location`, `Set-Cookie`, `Cookie`, and `Authorization` without enabling
credentialed CORS. Neither origin is inferred from forwarded request headers.

Production staff authority is one host-only
`__Host-syntholo_staff_session` cookie: `Secure`, `HttpOnly`, `SameSite=Lax`,
`Path=/`, no `Domain`. Local development uses the distinct non-Secure
`syntholo_local_staff_session`. Member requests carry exactly one Clerk bearer
and set `credentials: omit`; staff browser requests use the same origin and
never expose a Cloudflare Access token to JavaScript. Server-side web calls close over the
validated upstream and forward exactly one named, canonical opaque cookie.

## Member flow

Production member authentication is embedded at the canonical local routes
`/sign-in` and `/sign-up`. Clerk is configured with explicit path routing and
reciprocal local URLs so neither form sends the browser to a hosted Account
Portal. The production instance uses DNS mode at
`clerk.app.syntholo.com`; the required CNAME inventory is the exact set Clerk
returns. `accounts.app.syntholo.com` is not a launch dependency and must not be
created from an inferred target.

`/v1/member/**` parses one raw `Authorization: Bearer` value and rejects cookie-
only, malformed, duplicate, staff-cookie, and mixed credentials. Clerk
`authenticateRequest` is restricted to `session_token`, the configured audience,
and the exact authorized party; the adapter additionally requires a present,
exact `azp`. It receives a cookie-free `Request`. The verified Clerk `userId`
is passed to the fixed-search-path `member_actor_for_clerk_user` function, which
returns at most one active account/membership actor. Later member data access
still requires normal account-scoped transactions and RLS.

Owner-sensitive v1 operations require first-factor authentication within five
minutes. The API derives that instant only from Clerk v2's verified
`factorVerificationAge` (`fva`) and token `iat`: because `fva` is whole minutes,
it subtracts `(fva[0] + 1)` minutes from `iat`, then compares that fixed instant
with the current request time so elapsed token age is included. Missing,
malformed, fractional, or negative first-factor age fails recent auth closed;
a newly issued token does not reset the factor age.

The public `authenticatedAt: Date` field remains the cross-plan DTO, but every
real member/staff actor projection is registered with a private canonical
millisecond scalar. `requireRecentAuth` reads only that scalar, so `Date.setTime`
cannot upgrade authority; unregistered or unavailable freshness fails closed.

Until an owner-sensitive UI route lands, `403 RECENT_AUTH_REQUIRED` is the
explicit launch signal. That UI's member fetcher must acquire a bearer on every
invocation, translate only that code to Clerk's documented reverification hint
with `{ level: "first_factor", afterMinutes: 5 }`, and be wrapped by
`useReverification`. Clerk then opens its reverification UI and retries the
fetcher after success, producing a fresh token/factor age; cancellation remains
a denial. No Task 6 route pretends token renewal alone supplied reauthentication.

```tsx
const runOwnerRequest = useReverification(async () => {
  const response = await memberApi("/v1/owner-sensitive", mutationInit);
  const payload = await response.json();
  if (response.status === 403 && payload.error?.code === "RECENT_AUTH_REQUIRED") {
    return {
      clerk_error: {
        type: "forbidden",
        reason: "reverification-error",
        metadata: {
          reverification: { level: "first_factor", afterMinutes: 5 },
        },
      },
    };
  }
  if (!response.ok) throw new Error("OWNER_REQUEST_FAILED");
  return payload;
});
```

## Staff login and session flow

`GET /v1/staff/auth/sign-in` creates random OAuth state and browser nonce plus
PKCE S256. PostgreSQL stores only the state/nonce hashes and an AES-GCM encrypted
verifier, with a five-minute one-use deadline and allowlisted relative return
path. Reauthentication binds the attempt to the existing opaque-session hash and
requests Cloudflare Access `max_age=0`. The callback consumes the attempt atomically,
exchanges the code, validates the access JWT, resolves the active database staff
identity, and issues or rotates the session through narrow security-definer
state-transition functions. Sign-out winning a race fences the callback.

The browser receives only a random 32-byte base64url credential. PostgreSQL uses
its SHA-256 hash as the lookup key. Access and rotating refresh tokens are stored
as one bounded AES-256-GCM bundle with a fresh 12-byte IV, 16-byte tag, positive
key version, and AAD binding the lookup hash, staff identity, and Cloudflare Access session.
Rows are rejected for revocation or hard expiry before decryption.

Cloudflare Access JWT verification pins RS256, JWKS, issuer, `client_id`, organization,
`sub`, `sid`, `jti`, singleton role, permissions, `iat`, `auth_time`, expiry and
not-before, and rejects `act`. `client_id` is not treated as `aud`. Provider role,
permissions, identity, organization, and session must exactly match the stored
session and active database identity. Recent authentication is driven only by
`auth_time`; refresh advances tokens but cannot manufacture recent auth.

## Refresh, revocation, and cleanup

Refresh uses a short database lease plus version/id compare-and-swap. Completion
is accepted only for the current lease/version, before database-side lease,
session, and new-access-token expiry, and while `revoked_at IS NULL`. Concurrent
requests observe the committed generation. Cloudflare Access `invalid_grant` (including
the SDK's `.error` shape) is terminal and revokes locally; network, timeout,
408, 429, and 5xx failure is transient and never authorizes an expired token.
Sign-out clears the exact cookie and revokes locally before best-effort Cloudflare Access
revocation. Bounded worker-only cleanup deletes only terminal attempts and
expired/revoked sessions; runtime roles have no table `DELETE`.

The member and staff URLs are distinct login users. Startup recursively attests
that each is safe, has `current_user=session_user`, inherits exactly its expected
NOLOGIN capability with `INHERIT TRUE, SET FALSE, ADMIN FALSE`, and reaches no
other role. It independently resolves that exact capability OID/name and rejects
LOGIN or privileged flags, role/database settings, and direct or transitive
outbound authority on the capability itself. Staff secret-table writes occur
only through narrow fixed-search-path functions; the runtime has table `SELECT`
only.

## Key rotation

Key-ring entries are `version:base64url-key`, newest/active first, with unique
positive versions and exactly 32 decoded bytes. Rotation is two-phase:

1. Deploy a new active key while retaining every old decrypt key.
2. Allow sessions to refresh/re-encrypt or age out, verify no row references the
   old version, then remove the old key in a later deployment.

Removing an in-use key is a fail-closed logout, not a recovery mechanism.

## Production launch gates

Production remains blocked until evidence records:

- the exact canonical host, Cloudflare Access callback, embedded Clerk sign-in/sign-up
  paths, and allowed redirect URLs;
- the Clerk production instance, publishable/secret keys, audience, and exact
  authorized party;
- the Cloudflare Access production issuer, client, organization, singleton roles,
  permissions, MFA enforcement, and session policy;
- a staging access-token schema capture confirming `client_id`, `auth_time`, and
  the absence/presence of any real audience without recording token material;
- encryption-key ownership, secret-store placement, recovery, and rotation
  operator;
- deployed `/v1` proxy conformance for status, body, `Location`, `Set-Cookie`,
  `Cookie`, and `Authorization`;
- PostgreSQL runtime-login topology and capability attestation in the production
  database.
