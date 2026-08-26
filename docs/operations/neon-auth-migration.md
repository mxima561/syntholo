# Neon Auth + Data API + RLS migration

This is the implementation report for moving Syntholo off Clerk for students and onto a single Neon Auth identity, with school membership + RLS for customers and Cloudflare Access + `platform_admins` for internal staff.

## Architecture

```
                         SYNTHOLO
              ┌──────────────────────────┐
              │                          │
              ▼                          ▼
      app.syntholo.com           admin.syntholo.com
              │                          │
              │                    Cloudflare Access
              │                          │
              │                          ▼
              └──────────────┐      apps/admin
                             │            │
                             ▼            ▼
                           Neon Auth
                              │
                           user_id
                              │
             ┌────────────────┴────────────────┐
             │                                 │
             ▼                                 ▼
      school_members / memberships      platform_admins
             │                                 │
  student / teacher /                  super_admin
     school_admin                      admin/support/finance
             │                                 │
             ▼                                 ▼
      Neon Data API                    Next.js server
             │                                 │
             ▼                                 ▼
          Postgres RLS              Privileged DB access
             │                                 │
             └────────────────┬────────────────┘
                              ▼
                         Neon Postgres
```

Clerk is removed from `apps/web`. `app_users.clerk_id` is retained until identity mapping is verified. Passwords do not migrate.

Customer CRUD that is safe under RLS goes through `@neondatabase/neon-js` and the Neon Data API. Billing, entitlements, purchases, invitations, staff, and webhooks stay on server-side `postgres.js`. There is no Data API GRANT on those tables.

School roles (`owner`, `school_admin`, `teacher`, `student`) never grant platform access. Internal roles live in `platform_admins` / `staff` and are checked in `requireStaff()` on every admin mutation.

Pinned Neon SDK versions (from the public `neondatabase/neon-js` source): `@neondatabase/auth@0.5.0-beta` and `@neondatabase/neon-js@0.7.0-beta`. Run `npm install` on a machine that can reach `registry.npmjs.org` so `package-lock.json` records those packages. This cloud agent environment could not reach the npm registry, so the lockfile is not updated here.

## Cloudflare Admin Protection

### 1. How `admin.syntholo.com` is handled

The internal console is the existing `apps/admin` Next.js app (port 3001), not `app.syntholo.com/admin`. Production should bind `admin.syntholo.com` to that Vercel project. The student app must not grow an `/admin` surface or take a `jose` Access dependency (the foundation gate forbids that split inversion).

### 2. How Cloudflare Access fits into the request flow

Access is reachability only. `proxy.ts` verifies the Access JWT on every admin path except `/api/health`. `/login` and `/api/auth` remain behind Access so the Neon login form is not on the public internet. After Access, `requireStaff()` still runs Access + Neon Auth + `platform_admins` for layouts and server actions.

### 3. How Neon Auth remains the canonical identity

The Access JWT is not stored and its email/`sub` are not used as `user_id`. After Access, Syntholo calls `getNeonAuthUser()` and looks up `staff.neon_user_id` / `platform_admins.user_id`. Missing Neon session → login. Missing platform row → 403.

### 4. How `platform_admins` authorization works after Access

Bind is email-match to a **pre-seeded** staff row, not auto-provision from Access. Capabilities:

- `super_admin` — all
- `admin` — content + support
- `support` — support only
- `finance` — billing only

Support cannot call `requireStaff("staff")`. School admins with Neon sessions and no platform row are forbidden.

### 5. Application-level Access verification

`apps/admin/src/lib/auth/access-jwt.ts` validates Cloudflare’s assertion with `jose`: remote JWKS, issuer = team domain, audience = AUD. Header `cf-access-jwt-assertion` is preferred; `CF_Authorization` is the fallback. Presence of a random header is not enough. Email is not required on the Access JWT (service tokens can pass the gate and still fail Neon / platform checks).

### 6. Cloudflare dashboard configuration (manual)

See [cloudflare-admin-access.md](./cloudflare-admin-access.md). Create a self-hosted Access application for `admin.syntholo.com` only, attach an allow policy (emails / domain / IdP / MFA), copy AUD + team domain into the **admin** Vercel project. Do not protect `app.syntholo.com`. Policy is not hard-coded in Next.js.

### 7. DNS changes (manual, not applied here)

Point `admin.syntholo.com` at the admin Vercel project through Cloudflare proxy so Access can run. Point `app.syntholo.com` at the web project without an Access application. This repo does not change production DNS.

### 8. Local / preview development

| Runtime | Access JWT | Neon Auth | `ADMIN_DEV_BYPASS_EMAIL` |
|---|---|---|---|
| `next dev` | Off unless `CF_ACCESS_AUD` + team domain are set | Required when configured | Allowed only here, and only to resolve a seeded staff row |
| Vercel preview | Same as local | Required when configured | Forbidden (build throws if set) |
| Production | Always on, fail closed | Required | Forbidden |

There is no production Access skip flag.

### 9. Security scenarios tested

| Case | Result |
|---|---|
| 1. Ordinary user / missing Access JWT on production admin origin | `cloudflareAccessAllows` false; `requireStaff` 403 before Neon lookup |
| 2. Access passes, user not in `platform_admins` | 403 |
| 3. `platform_admins` row exists, no Neon session | `AdminUnauthenticatedError` → `/login` |
| 4. School admin Neon session, no platform row | 403 |
| 5. Support role, super-admin-only capability | 403 |
| 6. Direct server action / `requireStaff` call | Every exported admin mutation calls `requireStaff`; Access + Neon + role run on each call |

Access JWT tests also cover wrong audience and valid tokens without a Cloudflare email claim.
