import { cloudflareAccessVerificationRequired } from "./access-runtime";
import { accessCertsUrl, accessIssuer, getCachedRemoteJwks, readAccessToken, verifyAccessJwt } from "./access-jwt";

/**
 * Origin-level Cloudflare Access check. Reachability only — never identity.
 * Validates the Access JWT with the team JWKS, issuer, and application audience.
 */
export async function cloudflareAccessAllows(input: {
  header: string | null;
  cookie: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const env = input.env ?? process.env;
  if (!cloudflareAccessVerificationRequired(env)) return true;

  const token = readAccessToken({ header: input.header, cookie: input.cookie });
  const aud = env.CF_ACCESS_AUD?.trim();
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  if (!token || !aud || !teamDomain) return false;

  const verified = await verifyAccessJwt(token, {
    aud,
    issuer: accessIssuer(teamDomain),
    jwks: getCachedRemoteJwks(accessCertsUrl(teamDomain)),
  });
  return verified.ok;
}
