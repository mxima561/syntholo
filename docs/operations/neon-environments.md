# Neon Auth, Data API, and environment mapping

Syntholo uses one Neon Auth project as the identity provider for every person: students, teachers, school admins, and Syntholo staff. PostgreSQL `platform_admins` is a separate authorization table. Cloudflare Access is an additional reachability gate for `admin.syntholo.com` only.

## Hostnames

| Hostname | App | Auth |
|---|---|---|
| `www.syntholo.com` / marketing routes on the web app | `@syntholo/web` | Public |
| `app.syntholo.com` | `@syntholo/web` | Neon Auth |
| `admin.syntholo.com` | `@syntholo/admin` | Cloudflare Access, then Neon Auth, then `platform_admins` |

Do not put Cloudflare Access in front of `app.syntholo.com`.

## Neon branches

Create separate Neon branches (or projects) for local, Vercel preview, and production. Each branch should have its own:

- `DATABASE_URL` (pooled, server-only)
- Neon Auth URL (`NEON_AUTH_BASE_URL` / `NEXT_PUBLIC_NEON_AUTH_URL`)
- Neon Data API URL (`NEXT_PUBLIC_NEON_DATA_API_URL`)
- `NEON_AUTH_COOKIE_SECRET` (server-only, 32+ characters)

Vercel Preview deployments should use a preview Neon branch, not production Auth or production Postgres.

## Public vs secret variables

Safe for the browser (`NEXT_PUBLIC_*`):

- `NEXT_PUBLIC_NEON_AUTH_URL`
- `NEXT_PUBLIC_NEON_DATA_API_URL`
- `NEXT_PUBLIC_NEON_AUTH_GOOGLE`

Server-only:

- `DATABASE_URL`
- `NEON_AUTH_COOKIE_SECRET`
- Stripe, Mux, Resend, Blob tokens
- `CF_ACCESS_AUD` / `CF_ACCESS_TEAM_DOMAIN` (admin origin)

## Clerk → Neon identity mapping

`app_users.clerk_id` is retained. First Neon Auth sign-in with the same email writes `app_users.neon_user_id` and an `identity_migrations` row. Do not drop `clerk_id` until that mapping is verified in production.

Passwords do not migrate. Existing customers sign in (or reset password) with Neon Auth using the same email.

## Local development

- Web: `npm run dev` on `:3000`. If Neon Auth is unset and `APP_MODE=demo`, the local demo student is used.
- Admin: `npm run dev:admin` on `:3001`. Cloudflare Access is skipped in local development and Vercel preview unless `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` are both set. Production always verifies Access (fail closed). Neon Auth is still required when configured. `ADMIN_DEV_BYPASS_EMAIL` may resolve a seeded `staff` row only in local development with Access env unset. It is rejected in preview and production.

See [Cloudflare admin protection](./cloudflare-admin-access.md) for the Access dashboard, DNS, and origin-JWT steps.
