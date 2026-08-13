import { beforeEach, describe, expect, it, vi } from "vitest";

const workos = vi.hoisted(() => ({
  generate: vi.fn(),
  getAuthorizationUrl: vi.fn(),
  authenticateWithCode: vi.fn(),
  authenticateWithRefreshToken: vi.fn(),
  revokeSession: vi.fn(),
}));

vi.mock("@workos-inc/node", () => ({
  WorkOS: class {
    readonly pkce = { generate: workos.generate };
    readonly userManagement = {
      getAuthorizationUrl: workos.getAuthorizationUrl,
      authenticateWithCode: workos.authenticateWithCode,
      authenticateWithRefreshToken: workos.authenticateWithRefreshToken,
      revokeSession: workos.revokeSession,
    };
  },
}));

import { createWorkosStaffClient } from "./client.js";

describe("createWorkosStaffClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists the verifier for the exact state and S256 challenge sent to WorkOS", async () => {
    workos.generate.mockResolvedValue({
      codeVerifier: "locally-persisted-verifier",
      codeChallenge: "derived-s256-challenge",
    });
    workos.getAuthorizationUrl.mockReturnValue(
      "https://api.workos.test/authorize?state=state-from-attempt",
    );
    const client = createWorkosStaffClient({
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
      url: "https://api.workos.test/authorize?state=state-from-attempt",
      codeVerifier: "locally-persisted-verifier",
    });
    expect(workos.getAuthorizationUrl).toHaveBeenCalledWith({
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
    workos.authenticateWithCode.mockResolvedValue({
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
    workos.authenticateWithRefreshToken.mockResolvedValue({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
    workos.revokeSession.mockResolvedValue(undefined);
    const client = createWorkosStaffClient({ apiKey: "sk_test", clientId: "client_staff" });

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
