import type { MemberActor } from "@syntholo/domain";
import type { FastifyRequest } from "fastify";
import { AppError } from "../plugins/error-handler.js";
import type { AuthRouteDependencies } from "./types.js";
import { projectMemberActor } from "./authorize.js";

function unauthenticated(): never {
  throw new AppError("UNAUTHENTICATED", 401, "Authentication required");
}

function rawHeaderValues(request: FastifyRequest, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.raw.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function containsStaffCookie(request: FastifyRequest): boolean {
  const cookies = rawHeaderValues(request, "cookie");
  return cookies.some((header) =>
    /(?:^|;\s*)(?:__Host-syntholo_staff_session|syntholo_local_staff_session)=/u.test(
      header,
    ),
  );
}

export async function authenticateMember(
  request: FastifyRequest,
  dependencies: AuthRouteDependencies["member"],
): Promise<MemberActor> {
  const authorizationValues = rawHeaderValues(request, "authorization");
  if (
    authorizationValues.length !== 1 ||
    containsStaffCookie(request) ||
    !/^Bearer [A-Za-z0-9._~-]+$/u.test(authorizationValues[0] ?? "")
  ) {
    unauthenticated();
  }
  const authorization = authorizationValues[0] as string;
  const providerRequest = new Request(
    new URL(request.raw.url ?? "/", dependencies.webOrigin),
    { headers: { authorization }, method: request.method },
  );
  let providerIdentity: Awaited<
    ReturnType<typeof dependencies.clerk.authenticateRequest>
  >;
  try {
    providerIdentity = await dependencies.clerk.authenticateRequest(
      providerRequest,
      {
        acceptsToken: "session_token",
        audience: dependencies.audience,
        authorizedParties: dependencies.authorizedParties,
      },
    );
  } catch {
    unauthenticated();
  }
  if (
    !providerIdentity ||
    providerIdentity.userId.length === 0 ||
    !dependencies.authorizedParties.includes(providerIdentity.authorizedParty)
  ) {
    unauthenticated();
  }
  const databaseActor = await dependencies.identities.findMemberActorByClerkUserId(
    providerIdentity.userId,
  );
  if (!databaseActor || databaseActor.clerkUserId !== providerIdentity.userId) {
    unauthenticated();
  }
  return projectMemberActor(
    databaseActor,
    providerIdentity.firstFactorVerifiedAt,
  );
}
