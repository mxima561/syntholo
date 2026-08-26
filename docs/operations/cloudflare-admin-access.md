# Cloudflare Access for the Syntholo admin origin

Cloudflare Access is an outer gate for `admin.syntholo.com` only. It answers: *is this person allowed to reach the internal admin application at all?*

It does **not** identify Syntholo users and it does **not** grant `platform_admins` roles.

```
admin.syntholo.com
        ↓
Cloudflare Access          ← reachability
        ↓
Neon Auth                  ← canonical identity (user_id)
        ↓
platform_admins / staff    ← authorization
        ↓
Next.js server action      ← privileged Postgres
```

Students, teachers, and school admins use `app.syntholo.com` with Neon Auth only. Do not put Access in front of that hostname.

This repository already ships a dedicated admin app (`apps/admin`, port 3001). That is the `admin.syntholo.com` surface. Do not merge it into `apps/web` and do not add Cloudflare Access or an `/admin` console to the student app.

## How admin.syntholo.com is handled

| Hostname | Vercel project | App | Auth |
|---|---|---|---|
| `www.syntholo.com` | `@syntholo/web` | Marketing | Public |
| `app.syntholo.com` | `@syntholo/web` | Students, teachers, school admins | Neon Auth |
| `admin.syntholo.com` | `@syntholo/admin` | Internal staff | Cloudflare Access, then Neon Auth, then `platform_admins` |

Admin routes live on the admin origin (`/`, `/customers`, `/content`, `/support`, `/staff`, `/commerce`, `/settings`, …). Ordinary users never see this navigation because they cannot reach this deployment.

## Request flow

1. Browser hits `admin.syntholo.com`.
2. Cloudflare Access challenges the visitor if there is no valid Access session (email allow-list, company domain, IdP group, MFA — configured in the Cloudflare dashboard, not in Next.js).
3. Cloudflare forwards the request with `Cf-Access-Jwt-Assertion` / `CF_Authorization`.
4. `apps/admin` `proxy.ts` and every `requireStaff()` call verify that JWT against the team JWKS, issuer, and application AUD.
5. If the visitor has no Neon Auth session, they are sent to `/login` (still behind Access).
6. After Neon Auth, Syntholo looks up `staff.neon_user_id` / `platform_admins.user_id`. Missing or suspended rows return 403.
7. Role capabilities (`super_admin`, `admin`, `support`, `finance`) are checked server-side before privileged SQL.

Passing Access never makes someone a super admin. A school `school_admin` with a valid Neon session still receives 403 unless they have a `platform_admins` row.

## Origin JWT verification

Implemented in `apps/admin/src/lib/auth/access-jwt.ts` using Cloudflare’s documented `jose` + JWKS pattern:

- Token from `cf-access-jwt-assertion`, falling back to the `CF_Authorization` cookie
- JWKS from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
- `iss` = team domain
- `aud` = Access application AUD tag

The JWT email / `sub` claims are **not** stored and are **not** used as Syntholo `user_id`. Identity after Access is Neon Auth only.

## Environment-aware Access

| Runtime | How it is detected | Access JWT |
|---|---|---|
| Local `next dev` | `NODE_ENV=development` (no `VERCEL_ENV`) | Skipped unless `CF_ACCESS_AUD` **and** `CF_ACCESS_TEAM_DOMAIN` are set |
| Vercel preview | `VERCEL_ENV=preview` | Same as local: skipped unless Access env is set |
| Production | `VERCEL_ENV=production`, or `NODE_ENV=production` without a preview/development `VERCEL_ENV` | **Always verified. Fail closed** if AUD, team domain, or token is missing |

`ADMIN_DEV_BYPASS_EMAIL` is local-only. Next.js config throws if it is set on preview or production builds. Bypass never grants a role; it only resolves an already-seeded `staff` row when Neon Auth is not configured locally.

`/api/health` is skipped at the Next.js proxy so uptime probes can hit the origin. Cloudflare Access still covers that path at the edge unless you add an Access bypass for it.

## Manual Cloudflare dashboard steps

Do this in Cloudflare Zero Trust. Nothing in the Next.js app encodes the allow policy.

1. Zero Trust → Access → Applications → Add an application → Self-hosted.
2. Application domain: `admin.syntholo.com` (path `/`, or the whole hostname).
3. Create an Access policy for internal Syntholo staff. Typical options:
   - Explicit approved emails
   - Company email domain
   - IdP groups
   - Cloudflare account members
   - Require MFA
4. Copy the application **AUD tag**.
5. Note the team domain: `https://<your-team>.cloudflareaccess.com`.
6. In the **admin** Vercel project (production), set:
   - `CF_ACCESS_AUD=<aud tag>`
   - `CF_ACCESS_TEAM_DOMAIN=https://<your-team>.cloudflareaccess.com`
7. Do **not** create an Access application for `app.syntholo.com` or `www.syntholo.com`.
8. Optional: Access bypass policy for `admin.syntholo.com/api/health` if monitors cannot complete an Access challenge.

Identity provider and MFA stay in Cloudflare. Changing who can *reach* admin does not change `platform_admins`.

## Manual DNS steps

Do **not** change production DNS from this repository. After you confirm the current registrar / Cloudflare / Vercel setup:

1. Create (or keep) a Vercel project for `apps/admin` and a separate project for `apps/web`.
2. Assign `admin.syntholo.com` only to the admin project.
3. Assign `app.syntholo.com` (and marketing hosts) only to the web project.
4. For Access to run, `admin.syntholo.com` must be proxied through Cloudflare (orange cloud) on a zone you control. Point the record at the hostname Vercel shows for that project (usually a CNAME).
5. Leave `app.syntholo.com` **without** an Access application. It may still be on Cloudflare DNS; that is not the same as Access.

If `syntholo.com` currently uses Vercel nameservers, moving `admin` behind Access means adding the zone (or a partial CNAME setup) to Cloudflare first. Confirm that before touching nameservers.

## Neon Auth after Access

Staff still sign in with Neon Auth on `/login`. Seed rows with `STAFF_BOOTSTRAP_EMAILS` + `npm run db:seed-staff`. The first matching Neon login binds `staff.neon_user_id` and `platform_admins.user_id`. Access membership does not insert those rows.
