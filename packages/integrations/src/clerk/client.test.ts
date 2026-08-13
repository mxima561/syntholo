import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateRequest = vi.hoisted(() => vi.fn());

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(() => ({ authenticateRequest })),
}));

import { createClerkSessionAuthenticator } from "./client.js";

describe("createClerkSessionAuthenticator", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pins the current backend SDK to session tokens, audience, and authorized party", async () => {
    authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => ({
        userId: "user_member_1",
        factorVerificationAge: [1, -1],
        sessionClaims: {
          azp: "https://app.syntholo.test",
          iat: 1_786_622_400,
        },
      }),
    });
    const authenticator = createClerkSessionAuthenticator({
      secretKey: "sk_test_local",
      publishableKey: "pk_test_local",
    });
    const request = new Request("https://api.internal.test/v1/member/whoami", {
      headers: { authorization: "Bearer local-jwt" },
    });

    await expect(
      authenticator.authenticateRequest(request, {
        acceptsToken: "session_token",
        audience: "syntholo-api",
        authorizedParties: ["https://app.syntholo.test"],
      }),
    ).resolves.toEqual({
      userId: "user_member_1",
      authorizedParty: "https://app.syntholo.test",
      firstFactorVerifiedAt: new Date("2026-08-13T11:58:00.000Z"),
    });
    expect(authenticateRequest).toHaveBeenCalledWith(request, {
      acceptsToken: "session_token",
      audience: "syntholo-api",
      authorizedParties: ["https://app.syntholo.test"],
    });
  });

  it.each([
    ["fresh", [0, -1], "2026-08-13T11:59:00.000Z"],
    ["stale", [30, -1], "2026-08-13T11:29:00.000Z"],
  ])(
    "conservatively derives %s first-factor freshness from the verified v2 factor age",
    async (_case, factorVerificationAge, expected) => {
      authenticateRequest.mockResolvedValue({
        isAuthenticated: true,
        toAuth: () => ({
          userId: "user_member_1",
          factorVerificationAge,
          sessionClaims: {
            azp: "https://app.syntholo.test",
            iat: 1_786_622_400,
            v: 2,
            fva: factorVerificationAge,
          },
        }),
      });
      const authenticator = createClerkSessionAuthenticator({
        secretKey: "sk_test_local",
        publishableKey: "pk_test_local",
      });

      await expect(
        authenticator.authenticateRequest(new Request("https://api.internal.test"), {
          acceptsToken: "session_token",
          audience: "syntholo-api",
          authorizedParties: ["https://app.syntholo.test"],
        }),
      ).resolves.toMatchObject({
        firstFactorVerifiedAt: new Date(expected),
      });
    },
  );

  it.each([
    ["missing", null],
    ["short tuple", [0]],
    ["non-integer", [0.5, -1]],
    ["non-numeric", ["0", -1]],
    ["negative first factor", [-1, -1]],
    ["invalid second factor", [0, -2]],
  ])(
    "fails recent authentication closed for %s factor verification age",
    async (_case, factorVerificationAge) => {
      authenticateRequest.mockResolvedValue({
        isAuthenticated: true,
        toAuth: () => ({
          userId: "user_member_1",
          factorVerificationAge,
          sessionClaims: {
            azp: "https://app.syntholo.test",
            iat: 1_786_622_400,
            v: 2,
            fva: factorVerificationAge,
          },
        }),
      });
      const authenticator = createClerkSessionAuthenticator({
        secretKey: "sk_test_local",
        publishableKey: "pk_test_local",
      });

      await expect(
        authenticator.authenticateRequest(new Request("https://api.internal.test"), {
          acceptsToken: "session_token",
          audience: "syntholo-api",
          authorizedParties: ["https://app.syntholo.test"],
        }),
      ).resolves.toMatchObject({
        userId: "user_member_1",
        firstFactorVerifiedAt: null,
      });
    },
  );

  it("does not let a freshly renewed token hide stale first-factor verification", async () => {
    authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => ({
        userId: "user_member_1",
        factorVerificationAge: [31, -1],
        sessionClaims: {
          azp: "https://app.syntholo.test",
          iat: 1_786_622_400,
          v: 2,
          fva: [31, -1],
        },
      }),
    });
    const authenticator = createClerkSessionAuthenticator({
      secretKey: "sk_test_local",
      publishableKey: "pk_test_local",
    });

    await expect(
      authenticator.authenticateRequest(new Request("https://api.internal.test"), {
        acceptsToken: "session_token",
        audience: "syntholo-api",
        authorizedParties: ["https://app.syntholo.test"],
      }),
    ).resolves.toMatchObject({
      firstFactorVerifiedAt: new Date("2026-08-13T11:28:00.000Z"),
    });
  });

  it.each([
    ["unauthenticated", { isAuthenticated: false }],
    [
      "missing azp",
      {
        isAuthenticated: true,
        toAuth: () => ({
          userId: "user_member_1",
          sessionClaims: { iat: 1_786_622_400 },
        }),
      },
    ],
    [
      "unexpected azp",
      {
        isAuthenticated: true,
        toAuth: () => ({
          userId: "user_member_1",
          sessionClaims: { azp: "https://attacker.test", iat: 1_786_622_400 },
        }),
      },
    ],
  ])("rejects a %s SDK result", async (_case, state) => {
    authenticateRequest.mockResolvedValue(state);
    const authenticator = createClerkSessionAuthenticator({
      secretKey: "sk_test_local",
      publishableKey: "pk_test_local",
    });
    await expect(
      authenticator.authenticateRequest(new Request("https://api.internal.test"), {
        acceptsToken: "session_token",
        audience: "syntholo-api",
        authorizedParties: ["https://app.syntholo.test"],
      }),
    ).resolves.toBeNull();
  });
});
