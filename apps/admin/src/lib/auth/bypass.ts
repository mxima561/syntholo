import { adminRuntime } from "./access-runtime";

export function assertProductionBypassDisabled(env: NodeJS.ProcessEnv = process.env) {
  if (adminRuntime(env) !== "development" && env.ADMIN_DEV_BYPASS_EMAIL) {
    throw new Error("ADMIN_DEV_BYPASS_EMAIL must not be set outside local development");
  }
}

export function resolveDevBypassEmail(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (adminRuntime(env) !== "development") {
    throw new Error("Admin dev bypass is not reachable outside local development");
  }
  if (env.CF_ACCESS_AUD?.trim()) return undefined;
  const email = env.ADMIN_DEV_BYPASS_EMAIL?.trim();
  return email || undefined;
}
