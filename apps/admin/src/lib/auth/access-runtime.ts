export type AdminRuntime = "development" | "preview" | "production";

/**
 * Distinguishes local `next dev`, Vercel preview, and production.
 * Vercel preview builds use NODE_ENV=production, so NODE_ENV alone is not enough.
 */
export function adminRuntime(env: NodeJS.ProcessEnv = process.env): AdminRuntime {
  const vercel = env.VERCEL_ENV?.trim();
  if (vercel === "production") return "production";
  if (vercel === "preview") return "preview";
  if (vercel === "development") return "development";
  if (env.NODE_ENV === "production") return "production";
  return "development";
}

/**
 * Production always verifies Cloudflare Access (fail closed if AUD/team/token are missing).
 * Preview and local verify only when Access is explicitly configured.
 */
export function cloudflareAccessVerificationRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if (adminRuntime(env) === "production") return true;
  return Boolean(env.CF_ACCESS_AUD?.trim() && env.CF_ACCESS_TEAM_DOMAIN?.trim());
}
