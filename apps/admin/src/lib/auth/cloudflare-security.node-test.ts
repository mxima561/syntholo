import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from "jose";
import { adminRuntime, cloudflareAccessVerificationRequired } from "./access-runtime.ts";
import { accessIssuer, readAccessToken, verifyAccessJwt } from "./access-jwt.ts";
import { authorizeStaffRow } from "./authorize-staff.ts";
import {
  hasPlatformCapability,
  schoolRoleGrantsPlatformAccess,
} from "../../../../../packages/db/src/permissions.ts";

describe("Cloudflare Access runtime", () => {
  it("treats Vercel preview as preview despite NODE_ENV=production", () => {
    assert.equal(adminRuntime({ VERCEL_ENV: "preview", NODE_ENV: "production" }), "preview");
  });

  it("always verifies Access in production", () => {
    assert.equal(
      cloudflareAccessVerificationRequired({ NODE_ENV: "production", VERCEL_ENV: "production" }),
      true,
    );
  });

  it("skips Access on preview when AUD is unset", () => {
    assert.equal(
      cloudflareAccessVerificationRequired({ NODE_ENV: "production", VERCEL_ENV: "preview" }),
      false,
    );
  });

  it("verifies Access on preview when AUD and team domain are set", () => {
    assert.equal(
      cloudflareAccessVerificationRequired({
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
        CF_ACCESS_AUD: "aud-tag",
        CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      }),
      true,
    );
  });
});

describe("Access JWT verification", () => {
  async function signedToken(claims: Record<string, unknown>, audience = "aud-tag") {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test";
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://team.cloudflareaccess.com")
      .setAudience(audience)
      .setExpirationTime("2h")
      .sign(privateKey);
    return { token, jwks: createLocalJWKSet({ keys: [jwk] }) };
  }

  it("prefers the assertion header", () => {
    assert.equal(readAccessToken({ header: "header-token", cookie: "cookie-token" }), "header-token");
  });

  it("accepts a valid Access JWT without using Cloudflare email as identity", async () => {
    const { token, jwks } = await signedToken({ common_name: "service-token" });
    assert.deepEqual(
      await verifyAccessJwt(token, { aud: "aud-tag", issuer: "https://team.cloudflareaccess.com", jwks }),
      { ok: true },
    );
  });

  it("rejects a JWT with the wrong audience", async () => {
    const { token, jwks } = await signedToken({ email: "ops@syntholo.com" }, "other-aud");
    assert.deepEqual(
      await verifyAccessJwt(token, { aud: "aud-tag", issuer: "https://team.cloudflareaccess.com", jwks }),
      { ok: false },
    );
  });

  it("normalizes the team domain issuer", () => {
    assert.equal(accessIssuer("team.cloudflareaccess.com"), "https://team.cloudflareaccess.com");
  });
});

describe("platform authorization is independent of Access and school roles", () => {
  it("never treats school_admin as platform access", () => {
    assert.equal(schoolRoleGrantsPlatformAccess("school_admin"), false);
    assert.equal(schoolRoleGrantsPlatformAccess("owner"), false);
  });

  it("rejects support from super-admin staff capability", () => {
    assert.equal(hasPlatformCapability("support", "staff"), false);
    assert.equal(hasPlatformCapability("super_admin", "staff"), true);
  });

  it("rejects a missing or suspended staff row", () => {
    assert.equal(authorizeStaffRow(null), false);
    assert.equal(
      authorizeStaffRow({
        id: "s1",
        publicId: "STF-S1",
        email: "ops@syntholo.com",
        role: "admin",
        status: "suspended",
        neonUserId: "neon_ops",
        createdAt: new Date(),
        lastSeenAt: null,
      }),
      false,
    );
  });
});

describe("dev bypass is local-only", () => {
  it("gates bypass on adminRuntime development only", () => {
    const source = readFileSync(new URL("./bypass.ts", import.meta.url), "utf8");
    assert.match(source, /adminRuntime\(env\) !== "development"/);
    assert.match(source, /ADMIN_DEV_BYPASS_EMAIL must not be set outside local development/);
  });
});

describe("admin mutations independently call requireStaff", () => {
  it("every exported server action goes through staffOrForbidden or requireStaff", () => {
    const source = readFileSync(new URL("../../app/actions.ts", import.meta.url), "utf8");
    const exports = [...source.matchAll(/^export async function (\w+)/gm)].map((match) => match[1]);
    assert.ok(exports.length > 5);
    for (const name of exports) {
      const start = source.indexOf(`export async function ${name}`);
      const next = source.indexOf("export async function ", start + 1);
      const body = next === -1 ? source.slice(start) : source.slice(start, next);
      assert.match(body, /staffOrForbidden\(|requireStaff\(/, name);
    }
  });
});

describe("requireStaff keeps Access, Neon, and platform_admins as separate layers", () => {
  it("requireStaff always asserts Access before resolving Neon identity", () => {
    const source = readFileSync(new URL("./staff.ts", import.meta.url), "utf8");
    const requireIdx = source.indexOf("export async function requireStaff");
    const body = source.slice(requireIdx, requireIdx + 800);
    assert.match(body, /assertCloudflareAccess\(\)/);
    assert.match(body, /resolvePlatformStaff\(\)/);
    assert.match(body, /authorizeStaffRow/);
    assert.ok(body.indexOf("assertCloudflareAccess") < body.indexOf("resolvePlatformStaff"));
    assert.match(source, /throw new AdminUnauthenticatedError/);
    assert.doesNotMatch(source, /payload\.email/);
  });
});
