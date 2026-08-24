import { getRuntimeEnv } from "@/lib/config/env";

export function getWorkOsConfig() {
  const config = getRuntimeEnv().workos;
  if (!config) throw new Error("WorkOS is not configured. Demo identity is active.");
  return config;
}
