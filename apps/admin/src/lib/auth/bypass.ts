export function assertProductionBypassDisabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === "production" && env.ADMIN_DEV_BYPASS_EMAIL) {
    throw new Error("ADMIN_DEV_BYPASS_EMAIL must not be set in a production build");
  }
}

export function resolveDevBypassEmail(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.NODE_ENV === "production") {
    throw new Error("Admin dev bypass is not reachable in a production build");
  }
  if (env.CF_ACCESS_AUD?.trim()) return undefined;
  const email = env.ADMIN_DEV_BYPASS_EMAIL?.trim();
  return email || undefined;
}
