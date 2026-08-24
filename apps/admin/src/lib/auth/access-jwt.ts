import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

const JWKS_TTL_MS = 60 * 60 * 1000;

type CachedJwks = { url: string; jwks: JWTVerifyGetKey; fetchedAt: number };

let cachedJwks: CachedJwks | undefined;

export function getCachedRemoteJwks(certsUrl: string, now = Date.now()): JWTVerifyGetKey {
  if (cachedJwks && cachedJwks.url === certsUrl && now - cachedJwks.fetchedAt < JWKS_TTL_MS) {
    return cachedJwks.jwks;
  }
  const jwks = createRemoteJWKSet(new URL(certsUrl));
  cachedJwks = { url: certsUrl, jwks, fetchedAt: now };
  return jwks;
}

export function resetJwksCache() {
  cachedJwks = undefined;
}

export function readAccessToken(input: { header: string | null; cookie: string | null }): string | null {
  const header = input.header?.trim();
  if (header) return header;
  const cookie = input.cookie?.trim();
  return cookie || null;
}

export async function verifyAccessJwt(
  token: string,
  options: { aud: string; issuer: string; jwks: JWTVerifyGetKey },
): Promise<{ ok: true; email: string } | { ok: false }> {
  try {
    const { payload } = await jwtVerify(token, options.jwks, {
      issuer: options.issuer,
      audience: options.aud,
    });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email) return { ok: false };
    return { ok: true, email };
  } catch {
    return { ok: false };
  }
}

export function accessIssuer(teamDomain: string): string {
  return teamDomain.replace(/\/$/, "");
}

export function accessCertsUrl(teamDomain: string): string {
  return `${accessIssuer(teamDomain)}/cdn-cgi/access/certs`;
}
