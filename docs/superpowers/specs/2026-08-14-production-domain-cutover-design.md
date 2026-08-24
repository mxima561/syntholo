# Syntholo Production Domain Cutover

**Status:** Implemented and production-verified
**Date:** 2026-08-14
**Canonical web origin:** `https://app.syntholo.com`

## Purpose

Move the production web and identity boundaries from the temporary
`syntholo.vercel.app` hostname to the owned `app.syntholo.com` hostname. The
cutover must preserve the existing release identity, least-privilege secret
boundaries, and same-origin `/v1` API topology.

## Architecture

- Vercel serves the web application at `app.syntholo.com` and permanently
  redirects every non-canonical production alias to that origin.
- The browser continues to call relative `/v1` paths. Vercel rewrites those
  paths to the existing Railway API origin; the Railway origin is not exposed
  as the browser's canonical API URL.
- Railway API and Cloudflare Access use `https://app.syntholo.com` for allowed-origin,
  callback, cookie, and redirect decisions.
- Clerk uses DNS mode for the production primary domain. The Clerk secret
  remains only in Railway API. Vercel receives only the public Clerk key.
- GoDaddy remains the authoritative DNS provider. `app.syntholo.com` points to
  Vercel, while the four Clerk-provided CNAME records point the Frontend API,
  DKIM, and mail hostnames to Clerk. Clerk did not require or return an Account
  Portal CNAME for this instance, so no `accounts.app.syntholo.com` record is
  inferred.
- Member authentication is embedded in the web application. Clerk path routing
  and cross-form links are fixed to the local `/sign-in` and `/sign-up` routes;
  launch does not depend on the hosted Clerk Account Portal.
- The apex `syntholo.com` remains unchanged by this cutover.

## Cutover sequence

1. Verify `app.syntholo.com` is attached to the Vercel project and has valid
   DNS and TLS.
2. Provision only the exact Clerk DNS records returned for
   `app.syntholo.com`.
3. Run Clerk's DNS verification, then change the primary domain from the
   temporary Vercel hostname to `app.syntholo.com` and disable proxy mode.
4. Update Vercel and Railway `WEB_ORIGIN` values and the Cloudflare Access redirect URI.
5. Redeploy the web and API from the accepted Git SHA without changing the
   release identity.
6. Verify canonical redirects, health/readiness, Clerk JWKS and member sign-in,
   Cloudflare Access staff sign-in/callback, secure host-only cookies, and exact release
   SHA on public endpoints.

## Failure and rollback

- Do not switch Clerk or Cloudflare Access before their required DNS/redirect records are
  accepted.
- A failed verification leaves the current service deployment running; no
  application secret is copied to Vercel.
- If the new hostname fails after cutover, restore the previous provider
  origin values and deployment aliases while retaining the DNS records for
  investigation. Do not rotate or expose credentials as part of rollback.

## Acceptance criteria

- `https://app.syntholo.com` returns the production web application directly,
  not a redirect to `*.vercel.app`.
- Vercel aliases redirect to `https://app.syntholo.com` with path and query
  preserved.
- Web and Railway readiness responses report the accepted release SHA.
- Clerk production JWKS is reachable through its verified DNS hostname, the
  member sign-in UI loads without proxy or DNS errors, and sign-in/sign-up
  navigation remains on the two embedded local routes.
- Cloudflare Access sign-in uses the exact `app.syntholo.com` callback and preserves the
  `Secure`, `HttpOnly`, host-only staff cookie contract.
- Vercel contains no Clerk secret or other backend credential.
- The tracked worktree is clean and matches the pushed branch after any code or
  documentation changes.
