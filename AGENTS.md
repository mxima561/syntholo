<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Syntholo auth rules

- Neon Auth is the canonical identity for every person (students, teachers, school admins, and staff).
- Cloudflare Access is an outer gate for `apps/admin` / admin.syntholo.com only. Never treat Access as identity.
- Authorize customers via `memberships` and Postgres RLS. Authorize staff via `platform_admins` / `staff` after a verified Neon session.
- Never add Clerk. Never read identity from an unverified header.
- Every admin mutation re-checks role from the `staff` table and writes an audit row.
- Do not persist student PII or auth secrets in Neon Auth metadata or application tables.

