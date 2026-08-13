import { createClerkClient } from "@clerk/backend";

const FACTOR_AGE_GRANULARITY_MILLISECONDS = 60_000;

function conservativeFirstFactorVerificationTime(
  issuedAtMilliseconds: number,
  value: unknown,
): Date | null {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((age) => Number.isSafeInteger(age) && Number(age) >= -1) ||
    Number(value[0]) < 0
  ) {
    return null;
  }
  const firstFactorAge = Number(value[0]);
  const conservativeAgeMilliseconds =
    (firstFactorAge + 1) * FACTOR_AGE_GRANULARITY_MILLISECONDS;
  const timestamp = issuedAtMilliseconds - conservativeAgeMilliseconds;
  return Number.isSafeInteger(conservativeAgeMilliseconds) &&
    Number.isFinite(new Date(timestamp).getTime())
    ? new Date(timestamp)
    : null;
}

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
      firstFactorVerifiedAt: Date | null;
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
        // fva is whole minutes old at token issuance. Subtract one additional
        // minute for its unknown fractional part; comparing this fixed instant
        // with request time also includes all elapsed token age.
        firstFactorVerifiedAt: conservativeFirstFactorVerificationTime(
          issuedAtMilliseconds,
          auth.factorVerificationAge,
        ),
      };
    },
  });
}
