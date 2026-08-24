# Running the production platform locally

Runs `apps/web` + `apps/api` + `apps/worker` entirely on this machine against a
local Postgres, with zero calls to Vercel/Railway/Neon. Clerk, Cloudflare Access, and
Stripe remain SaaS (used here in dev/test mode) — there's no offline substitute
for them.

## One-time setup

1. **Postgres 17** (must match Neon's major version — see gotcha below):
   ```bash
   brew install postgresql@17
   brew services start postgresql@17
   export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
   ```
2. **Create the dev database and give your superuser role a password**
   (`createDatabase` in `packages/database/src/client.ts` requires a password
   in every connection URL):
   ```bash
   psql -d postgres -c "ALTER ROLE $(whoami) PASSWORD 'localdev';"
   psql -d postgres -c "CREATE DATABASE syntholo_dev;"
   ```
3. **Run migrations** — this creates the `syntholo_migrator` /
   `syntholo_member_api` / `syntholo_staff_api` / `syntholo_system_api` /
   `syntholo_worker` NOLOGIN capability roles as a side effect of
   `0002_roles_and_rls.sql` onward:
   ```bash
   cd packages/database
   DATABASE_MIGRATION_TARGET=test \
     TEST_DATABASE_URL="postgres://$(whoami):localdev@localhost:5432/syntholo_dev" \
     npm run db:migrate
   ```
4. **Create four LOGIN roles**, one per capability, and grant membership with
   the exact options the runtime attestation requires (`INHERIT TRUE, SET
   FALSE, ADMIN FALSE` — a plain `GRANT role TO role` on PG16+ defaults `SET
   TRUE`, which fails `assertDatabaseCapability`'s `membership_options_safe`
   check):
   ```sql
   -- run against syntholo_dev
   CREATE ROLE syntholo_local_member LOGIN PASSWORD 'localdev';
   CREATE ROLE syntholo_local_staff  LOGIN PASSWORD 'localdev';
   CREATE ROLE syntholo_local_system LOGIN PASSWORD 'localdev';
   CREATE ROLE syntholo_local_worker LOGIN PASSWORD 'localdev';

   GRANT syntholo_member_api TO syntholo_local_member WITH INHERIT TRUE;
   GRANT syntholo_member_api TO syntholo_local_member WITH SET FALSE;
   GRANT syntholo_member_api TO syntholo_local_member WITH ADMIN FALSE;
   -- repeat the three-statement pattern for staff/system/worker
   ```
5. **Env files** — create (not committed; already gitignored):
   - `apps/api/.env.local`
   - `apps/worker/.env.local`
   - `apps/web/.env.local`

   See the current machine's copies for the exact keys. Notably:
   - API needs `MEMBER_DATABASE_URL` / `STAFF_DATABASE_URL` /
     `SYSTEM_DATABASE_URL` as three **distinct** credentials (the config
     rejects any two being equal), each using its matching
     `syntholo_local_*` role above.
   - `STAFF_SESSION_ENCRYPTION_KEYS` (format `1:<43-char base64url of 32
     bytes>`) and `IMPLEMENTATION_CURSOR_SECRET` (>=32 bytes) can be any
     locally-generated random values — see `packages/api/src/auth/
     session-crypto.ts` for the exact format.
   - `CLERK_AUDIENCE` is just this app's own constant
     (`syntholo-member-api`, from `.env.example`) — not something to look up
     in the Clerk dashboard.
   - `REMOVED_ISSUER` is always `https://api.access.com/user_management/<your
     REMOVED_CLIENT_ID>`; `REMOVED_JWKS_URL` is always `https://api.access.com/
     sso/jwks/<your REMOVED_CLIENT_ID>`. Both are derived from the client ID,
     not separate dashboard values. (A bare `https://api.access.com` issuer —
     matching this repo's own test fixtures — does NOT match real Cloudflare Access
     tokens, which carry `iss` as the full `/user_management/<client_id>`
     path; `jose`'s issuer check fails closed with no detail surfaced past
     `REMOVED_TOKEN_INVALID` if you get this wrong.)
   - Stripe/Mux/Certificate-Blob are left disabled
     (`STRIPE_COMMERCE_ENABLED=false`, etc.) for the first run.

## Running

Each process needs `RELEASE_SHA` set to the checked-out commit and reads its
own `.env.local` (Next.js does this automatically for `apps/web`; API/worker
don't auto-load `.env` files, so source it first):

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

# terminal 1
cd apps/api && set -a && source .env.local && set +a \
  && RELEASE_SHA="$(git rev-parse HEAD)" npm run dev

# terminal 2
cd apps/worker && set -a && source .env.local && set +a \
  && RELEASE_SHA="$(git rev-parse HEAD)" npm run dev

# terminal 3 — do NOT export stray shell env vars first (see gotcha below)
RELEASE_SHA="$(git rev-parse HEAD)" npm run dev:web
```

Verify: `curl http://localhost:4000/v1/health/ready` should show all three
Postgres dependencies `"status":"ok"`. `curl http://localhost:3000/v1/health/live`
proves the web app's `/v1/**` rewrite proxy reaches the API.

## Gotchas hit while setting this up

- **Postgres version must be 17, not 16.** Migration `0011_learning.sql`'s
  `syntholo_content_readiness_v1()` attestation expects the capability role
  to hold the `MAINTAIN` table privilege as part of `GRANT ALL PRIVILEGES` —
  `MAINTAIN` was only added in Postgres 17. On PG16 this makes
  `table_acl_ready` / `learning_acl_ready` silently false and `/v1/health/ready`
  reports the three Postgres deps as `degraded` even though `createDatabase`
  and `assertDatabaseCapability` both succeed at startup.
- **Role membership must be granted with explicit `SET FALSE`.** Plain
  `GRANT capability TO login` on PG16+ defaults to `SET TRUE`, which fails
  `assertDatabaseCapability`'s strict membership-options check
  (`packages/database/src/client.ts`). Never use `ALTER ROLE ... SET ROLE
  <capability>` either — that sets `rolconfig` on the login role, which the
  same check also forbids (`rolconfig !== null`).
- **`APP_MODE=production` requires https origins** — `apps/web/src/lib/api/
  config.ts`'s `exactOrigin()` now exempts loopback hosts
  (`localhost`/`127.0.0.1`/`::1`) from that requirement so local dev against
  `http://localhost:3000` / `:4000` works; any real deployed origin is never
  loopback, so this doesn't loosen anything in production.
- **Web build/dev must run with a clean shell env.** `parseWebApiConfig`
  scans *all* of `process.env` for keys matching a forbidden-secret regex
  (`.*_KEY$`, `.*SECRET.*`, etc.) and throws `WEB_API_CONFIG_INVALID` if any
  match — a globally-exported `ANTHROPIC_API_KEY`/`GEMINI_API_KEY`/etc. in
  your shell profile will trip this. Run `npm run dev:web` from a shell that
  hasn't sourced API/worker `.env.local` files or other secret-bearing
  exports.
- `createDatabase` (`packages/database/src/client.ts`) rejects any connection
  URL without a password — Homebrew Postgres has no password on the default
  superuser role by default, so set one first.
