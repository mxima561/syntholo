<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Syntholo auth rules

- Neon Auth is the canonical identity for students, teachers, and school admins in this app.
- Do not persist passwords, session tokens, or auth secrets in application tables.
- Never add staff identity, Cloudflare Access, or an `/admin` surface to this app. Platform operators use `apps/admin`.
