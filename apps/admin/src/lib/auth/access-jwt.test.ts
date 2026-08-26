import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";
import { accessIssuer, readAccessToken, verifyAccessJwt } from "./access-jwt";

async function signedToken(claims: Record<string, unknown>, audience = "aud-tag", issuer = "https://team.cloudflareaccess.com") {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test";
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime("2h")
    .sign(privateKey);
  return { token, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

describe("readAccessToken", () => {
  it("prefers the Access assertion header over the cookie", () => {
    expect(readAccessToken({ header: "header-token", cookie: "cookie-token" })).toBe("header-token");
  });

  it("falls back to the CF_Authorization cookie", () => {
    expect(readAccessToken({ header: null, cookie: "cookie-token" })).toBe("cookie-token");
  });

  it("returns null when both are missing", () => {
    expect(readAccessToken({ header: " ", cookie: null })).toBeNull();
  });
});

describe("verifyAccessJwt", () => {
  it("accepts a JWT signed for the Access application audience", async () => {
    const { token, jwks } = await signedToken({ email: "ops@syntholo.com" });
    await expect(
      verifyAccessJwt(token, { aud: "aud-tag", issuer: "https://team.cloudflareaccess.com", jwks }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects a forged token with the wrong audience", async () => {
    const { token, jwks } = await signedToken({ email: "ops@syntholo.com" }, "other-aud");
    await expect(
      verifyAccessJwt(token, { aud: "aud-tag", issuer: "https://team.cloudflareaccess.com", jwks }),
    ).resolves.toEqual({ ok: false });
  });

  it("does not require a Cloudflare email claim (identity is Neon Auth)", async () => {
    const { token, jwks } = await signedToken({ common_name: "service-token" });
    await expect(
      verifyAccessJwt(token, { aud: "aud-tag", issuer: "https://team.cloudflareaccess.com", jwks }),
    ).resolves.toEqual({ ok: true });
  });
});

describe("accessIssuer", () => {
  it("normalizes a team hostname to an https issuer", () => {
    expect(accessIssuer("team.cloudflareaccess.com")).toBe("https://team.cloudflareaccess.com");
    expect(accessIssuer("https://team.cloudflareaccess.com/")).toBe("https://team.cloudflareaccess.com");
  });
});
