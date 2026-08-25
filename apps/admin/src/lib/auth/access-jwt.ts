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
): Promise<{ ok: true } | { ok: false }> {
  try {
    await jwtVerify(token, options.jwks, {
      issuer: options.issuer,
      audience: options.aud,
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function accessIssuer(teamDomain: string): string {
  const trimmed = teamDomain.trim().replace(/\/$/, "");
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) return trimmed;
  return `https://${trimmed}`;
}

export function accessCertsUrl(teamDomain: string): string {
  return `${accessIssuer(teamDomain)}/cdn-cgi/access/certs`;
}
