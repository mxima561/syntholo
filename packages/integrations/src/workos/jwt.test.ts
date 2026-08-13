import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createWorkosJwks,
  verifyWorkosAccessToken,
} from "./jwt.js";

const now = new Date("2026-08-13T12:00:00.000Z");
const issuer = "https://auth.syntholo.test";
const clientId = "client_syntholo_staff";
const organizationId = "org_syntholo_staff";
const nowSeconds = Math.floor(now.getTime() / 1_000);

let privateKey: CryptoKey;
let jwks: ReturnType<typeof createWorkosJwks>;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  const publicJwk = await exportJWK(keys.publicKey);
  jwks = createWorkosJwks({
    keys: [{ ...publicJwk, alg: "RS256", kid: "workos-test-key", use: "sig" }],
  });
});

async function token(
  patch: Record<string, unknown> = {},
  protectedHeader: { alg: "RS256"; kid: string } = {
    alg: "RS256",
    kid: "workos-test-key",
  },
): Promise<string> {
  const tokenIssuer =
    typeof patch.iss === "string" ? patch.iss : issuer;
  const claims = {
    sub: "user_staff_1",
    sid: "session_staff_1",
    jti: "token_staff_1",
    client_id: clientId,
    org_id: organizationId,
    role: "admin",
    roles: ["admin"],
    permissions: ["content:publish", "users:read"],
    iat: nowSeconds - 30,
    auth_time: nowSeconds - 120,
    exp: nowSeconds + 300,
    ...patch,
  };

  return new SignJWT(claims)
    .setProtectedHeader(protectedHeader)
    .setIssuer(tokenIssuer)
    .sign(privateKey);
}

const verification = () => ({
  jwks,
  issuer,
  clientId,
  organizationId,
  allowedRoles: ["coach", "admin"] as const,
  now,
});

describe("verifyWorkosAccessToken", () => {
  it("accepts the current client_id token shape without inventing an audience", async () => {
    const claims = await verifyWorkosAccessToken(await token(), verification());

    expect(claims).toEqual({
      workosUserId: "user_staff_1",
      workosSessionId: "session_staff_1",
      tokenId: "token_staff_1",
      clientId,
      organizationId,
      role: "admin",
      roles: ["admin"],
      permissions: ["content:publish", "users:read"],
      issuedAt: new Date((nowSeconds - 30) * 1_000),
      authenticatedAt: new Date((nowSeconds - 120) * 1_000),
      expiresAt: new Date((nowSeconds + 300) * 1_000),
    });
  });

  it.each([
    ["wrong issuer", { iss: "https://attacker.test" }],
    ["wrong client", { client_id: "client_attacker" }],
    ["wrong organization", { org_id: "org_attacker" }],
    ["expired", { exp: nowSeconds - 1 }],
    ["not yet valid", { nbf: nowSeconds + 30 }],
    ["impersonated", { act: { sub: "admin@attacker.test" } }],
    ["missing subject", { sub: undefined }],
    ["missing session", { sid: undefined }],
    ["missing token id", { jti: undefined }],
    ["missing issued-at", { iat: undefined }],
    ["missing authentication time", { auth_time: undefined }],
    ["future authentication", { auth_time: nowSeconds + 60 }],
    ["unknown role", { role: "member", roles: ["member"] }],
    ["role mismatch", { role: "admin", roles: ["coach"] }],
    ["hidden extra role", { role: "coach", roles: ["coach", "admin"] }],
    ["non-string permission", { permissions: ["content:publish", 7] }],
  ])("rejects %s claims with one safe error", async (_case, patch) => {
    await expect(
      verifyWorkosAccessToken(await token(patch), verification()),
    ).rejects.toThrow("WORKOS_TOKEN_INVALID");
  });

  it.each(["malformed", "a.b.c"])(
    "normalizes a %s token without reflecting it",
    async (value) => {
      await expect(
        verifyWorkosAccessToken(value, verification()),
      ).rejects.toThrow("WORKOS_TOKEN_INVALID");
      try {
        await verifyWorkosAccessToken(value, verification());
      } catch (error) {
        expect(String(error)).toBe("Error: WORKOS_TOKEN_INVALID");
        expect(String(error)).not.toContain(value);
      }
    },
  );

  it("rejects algorithm confusion before claim trust", async () => {
    const signed = await token();
    const [, payload, signature] = signed.split(".");
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", kid: "workos-test-key" }),
    ).toString("base64url");
    const confused = `${header}.${payload}.${signature}`;
    await expect(
      verifyWorkosAccessToken(confused, verification()),
    ).rejects.toThrow("WORKOS_TOKEN_INVALID");
  });
});
