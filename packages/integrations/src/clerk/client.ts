import { createClerkClient } from "@clerk/backend";

export function createClerkSessionAuthenticator(input: {
  secretKey: string;
  publishableKey: string;
}) {
  const client = createClerkClient({
    secretKey: input.secretKey,
    publishableKey: input.publishableKey,
  });
  return Object.freeze({
    async authenticateRequest(
      request: Request,
      options: {
        acceptsToken: "session_token";
        audience: string;
        authorizedParties: readonly string[];
      },
    ): Promise<{
      userId: string;
      authenticatedAt: Date;
      authorizedParty: string;
    } | null> {
      const state = await client.authenticateRequest(request, {
        acceptsToken: options.acceptsToken,
        audience: options.audience,
        authorizedParties: [...options.authorizedParties],
      });
      if (!state.isAuthenticated) return null;
      const auth = state.toAuth();
      const claims = auth.sessionClaims as Record<string, unknown>;
      const authorizedParty = claims.azp;
      const issuedAt = claims.iat;
      const issuedAtMilliseconds = Number(issuedAt) * 1_000;
      if (
        typeof auth.userId !== "string" ||
        typeof authorizedParty !== "string" ||
        !options.authorizedParties.includes(authorizedParty) ||
        !Number.isSafeInteger(issuedAt) ||
        Number(issuedAt) < 0 ||
        !Number.isFinite(new Date(issuedAtMilliseconds).getTime())
      ) {
        return null;
      }
      return {
        userId: auth.userId,
        authorizedParty,
        authenticatedAt: new Date(issuedAtMilliseconds),
      };
    },
  });
}
