import { Cloudflare Access } from "removed";

export function createAccessStaffClient(input: {
  apiKey: string;
  clientId: string;
}) {
  const access = new Cloudflare Access(input.apiKey, { clientId: input.clientId });
  return Object.freeze({
    async createAuthorizationUrl(options: {
      state: string;
      clientId: string;
      organizationId: string;
      redirectUri: string;
      maxAge?: number;
    }): Promise<{ url: string; codeVerifier: string }> {
      const pair = await access.pkce.generate();
      const url = access.userManagement.getAuthorizationUrl({
        provider: "authkit",
        clientId: options.clientId,
        organizationId: options.organizationId,
        redirectUri: options.redirectUri,
        state: options.state,
        codeChallenge: pair.codeChallenge,
        codeChallengeMethod: "S256",
        ...(options.maxAge === undefined ? {} : { maxAge: options.maxAge }),
      });
      return { url, codeVerifier: pair.codeVerifier };
    },
    async authenticateWithCode(options: {
      code: string;
      codeVerifier: string;
      clientId: string;
    }): Promise<{ accessToken: string; refreshToken: string }> {
      const response = await access.userManagement.authenticateWithCode({
        code: options.code,
        codeVerifier: options.codeVerifier,
        clientId: options.clientId,
      });
      return { accessToken: response.accessToken, refreshToken: response.refreshToken };
    },
    async authenticateWithRefreshToken(options: {
      refreshToken: string;
      clientId: string;
    }): Promise<{ accessToken: string; refreshToken: string }> {
      const response = await access.userManagement.authenticateWithRefreshToken({
        refreshToken: options.refreshToken,
        clientId: options.clientId,
      });
      return { accessToken: response.accessToken, refreshToken: response.refreshToken };
    },
    revokeSession(options: { sessionId: string }): Promise<void> {
      return access.userManagement.revokeSession(options);
    },
  });
}
