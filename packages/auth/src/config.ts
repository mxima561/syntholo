export function isNeonAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.NEON_AUTH_BASE_URL?.trim() && env.NEON_AUTH_COOKIE_SECRET?.trim());
}

export function neonAuthBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.NEON_AUTH_BASE_URL?.trim() || "";
}

export function neonAuthCookieSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.NEON_AUTH_COOKIE_SECRET?.trim() || "";
}

/** Browser-safe Auth URL. Same host Neon documents as NEON_AUTH_URL / Auth URL. */
export function neonPublicAuthUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.NEXT_PUBLIC_NEON_AUTH_URL?.trim() || env.NEON_AUTH_BASE_URL?.trim() || "";
}

/** Browser-safe Data API URL. Never include database credentials. */
export function neonDataApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.NEXT_PUBLIC_NEON_DATA_API_URL?.trim() || "";
}

export function neonGoogleAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEXT_PUBLIC_NEON_AUTH_GOOGLE === "true";
}

export function isNeonDataApiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(neonPublicAuthUrl(env) && neonDataApiUrl(env));
}
