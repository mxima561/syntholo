# Demo and production modes

## Demo

`APP_MODE=demo` renders the deterministic product experience. It does not turn
demo state into production state and it does not enable privileged provider
connections. Browser API calls remain relative `/v1/**` calls through the fixed
same-origin proxy.

Every process still requires `RELEASE_SHA` to be the exact 40-character Git SHA
used to build the artifact. For local work:

```bash
export RELEASE_SHA="$(git rev-parse HEAD)"
npm run dev:web
```

## Production

`APP_MODE=production` is only a configuration mode. A launch additionally needs
the foundation engineering gate, Docker evidence, provider configuration,
deployed proxy evidence, branch protection, common Git ancestry, and named
operational owners.

The web service accepts only canonical web/API origins, the Clerk publishable
key, and optional public PostHog settings. It rejects database URLs and WorkOS,
Stripe server, Mux signing, Resend, Blob write, and HighLevel credentials even
when a forbidden value is blank. HighLevel remains an isolated external
customer login destination; Syntholo has no credential, API client, SSO, mirror,
or data pipe to it.

Use [foundation-deploy.md](foundation-deploy.md) for the exact release order,
process ownership, health semantics, evidence requirements, and rollback path.
