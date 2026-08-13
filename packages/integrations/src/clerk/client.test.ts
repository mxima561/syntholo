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
      authenticatedAt: new Date("2026-08-13T12:00:00.000Z"),
    });
    expect(authenticateRequest).toHaveBeenCalledWith(request, {
      acceptsToken: "session_token",
      audience: "syntholo-api",
      authorizedParties: ["https://app.syntholo.test"],
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
