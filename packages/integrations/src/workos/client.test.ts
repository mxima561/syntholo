import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({
  generate: vi.fn(),
  getAuthorizationUrl: vi.fn(),
  authenticateWithCode: vi.fn(),
  authenticateWithRefreshToken: vi.fn(),
  revokeSession: vi.fn(),
}));

vi.mock("removed", () => ({
  Cloudflare Access: class {
    readonly pkce = { generate: access.generate };
    readonly userManagement = {
      getAuthorizationUrl: access.getAuthorizationUrl,
      authenticateWithCode: access.authenticateWithCode,
      authenticateWithRefreshToken: access.authenticateWithRefreshToken,
      revokeSession: access.revokeSession,
    };
  },
}));

import { createAccessStaffClient } from "./client.js";

describe("createAccessStaffClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists the verifier for the exact state and S256 challenge sent to Cloudflare Access", async () => {
    access.generate.mockResolvedValue({
      codeVerifier: "locally-persisted-verifier",
      codeChallenge: "derived-s256-challenge",
    });
    access.getAuthorizationUrl.mockReturnValue(
      "https://api.access.test/authorize?state=state-from-attempt",
    );
    const client = createAccessStaffClient({
      apiKey: "sk_test_local",
      clientId: "client_staff",
    });

    await expect(
      client.createAuthorizationUrl({
        state: "state-from-attempt",
        clientId: "client_staff",
        organizationId: "org_staff",
        redirectUri: "https://app.syntholo.test/v1/auth/staff/callback",
        maxAge: 0,
      }),
    ).resolves.toEqual({
      url: "https://api.access.test/authorize?state=state-from-attempt",
      codeVerifier: "locally-persisted-verifier",
    });
    expect(access.getAuthorizationUrl).toHaveBeenCalledWith({
      provider: "authkit",
      clientId: "client_staff",
      organizationId: "org_staff",
      redirectUri: "https://app.syntholo.test/v1/auth/staff/callback",
      state: "state-from-attempt",
      codeChallenge: "derived-s256-challenge",
      codeChallengeMethod: "S256",
      maxAge: 0,
    });
  });

  it("maps code, refresh, and revocation through the current SDK shapes", async () => {
    access.authenticateWithCode.mockResolvedValue({
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
    access.authenticateWithRefreshToken.mockResolvedValue({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
    access.revokeSession.mockResolvedValue(undefined);
    const client = createAccessStaffClient({ apiKey: "sk_test", clientId: "client_staff" });

    await expect(
      client.authenticateWithCode({
        code: "one-time-code",
        codeVerifier: "pkce-verifier",
        clientId: "client_staff",
      }),
    ).resolves.toEqual({ accessToken: "access-1", refreshToken: "refresh-1" });
    await expect(
      client.authenticateWithRefreshToken({
        refreshToken: "refresh-1",
        clientId: "client_staff",
      }),
    ).resolves.toEqual({ accessToken: "access-2", refreshToken: "refresh-2" });
    await expect(client.revokeSession({ sessionId: "session-1" })).resolves.toBeUndefined();
  });
});
