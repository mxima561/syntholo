import {
  trustedActorAuthenticationTime,
  type Actor,
  type MemberActor,
  type StaffActor,
} from "@syntholo/domain";
import { registerTrustedActorAuthentication } from
  "../../../../packages/domain/src/identity/authentication.js";
import { AppError } from "../plugins/error-handler.js";

type AuthorizationRequirement =
  | { readonly role: MemberActor["role"] | StaffActor["role"] }
  | { readonly permission: string };

function authorizationError(
  code: "FORBIDDEN" | "RECENT_AUTH_REQUIRED",
  message: string,
): AppError {
  const error = new AppError(code, 403, message);
  error.message = code;
  return error;
}

export function authorize<T extends Actor>(
  actor: T,
  requirement: AuthorizationRequirement,
): T {
  const allowed =
    "role" in requirement
      ? actor.role === requirement.role
      : actor.kind === "staff" &&
        actor.permissions.includes(requirement.permission);
  if (!allowed) throw authorizationError("FORBIDDEN", "Forbidden");
  return actor;
}

function canonicalAuthenticationTime(actor: Actor): number | null {
  return trustedActorAuthenticationTime(actor);
}

function publicAuthenticationDate(timestamp: number | null): Date {
  return new Date(timestamp ?? 0);
}

export function projectMemberActor(
  actor: MemberActor,
  authenticatedAt: Date | null,
): MemberActor {
  const timestamp =
    authenticatedAt instanceof Date && Number.isFinite(authenticatedAt.getTime())
      ? authenticatedAt.getTime()
      : null;
  const projection = Object.freeze({
    ...actor,
    authenticatedAt: publicAuthenticationDate(timestamp),
  });
  return registerTrustedActorAuthentication(
    projection,
    timestamp === null ? null : new Date(timestamp),
  );
}

export function projectStaffActor(
  actor: StaffActor,
  authenticatedAt: Date | null,
): StaffActor {
  const timestamp =
    authenticatedAt instanceof Date && Number.isFinite(authenticatedAt.getTime())
      ? authenticatedAt.getTime()
      : null;
  const projection = Object.freeze({
    ...actor,
    permissions: Object.freeze([...actor.permissions]),
    authenticatedAt: publicAuthenticationDate(timestamp),
  });
  return registerTrustedActorAuthentication(
    projection,
    timestamp === null ? null : new Date(timestamp),
  );
}

export function requireMember(actor: Actor): MemberActor {
  if (actor.kind !== "member") throw authorizationError("FORBIDDEN", "Forbidden");
  const timestamp = canonicalAuthenticationTime(actor);
  return projectMemberActor(actor, timestamp === null ? null : new Date(timestamp));
}

export function requireCoach(actor: Actor): StaffActor & { role: "coach" } {
  if (actor.kind !== "staff" || actor.role !== "coach") {
    throw authorizationError("FORBIDDEN", "Forbidden");
  }
  const timestamp = canonicalAuthenticationTime(actor);
  return projectStaffActor(
    actor,
    timestamp === null ? null : new Date(timestamp),
  ) as StaffActor & { role: "coach" };
}

export function requireAdmin(actor: Actor): StaffActor & { role: "admin" } {
  if (actor.kind !== "staff" || actor.role !== "admin") {
    throw authorizationError("FORBIDDEN", "Forbidden");
  }
  const timestamp = canonicalAuthenticationTime(actor);
  return projectStaffActor(
    actor,
    timestamp === null ? null : new Date(timestamp),
  ) as StaffActor & { role: "admin" };
}

export function requireRecentAuth<T extends Actor>(
  actor: T,
  maximumAgeSeconds: number,
  now = new Date(),
): T {
  const authenticatedAt = canonicalAuthenticationTime(actor);
  const currentTime = now instanceof Date ? now.getTime() : Number.NaN;
  const maximumAgeMilliseconds = maximumAgeSeconds * 1_000;
  if (
    !Number.isSafeInteger(maximumAgeSeconds) ||
    maximumAgeSeconds < 0 ||
    !Number.isSafeInteger(maximumAgeMilliseconds) ||
    !Number.isFinite(currentTime) ||
    authenticatedAt === null ||
    authenticatedAt > currentTime + 5_000 ||
    currentTime - authenticatedAt > maximumAgeMilliseconds
  ) {
    throw authorizationError(
      "RECENT_AUTH_REQUIRED",
      "Recent authentication required",
    );
  }
  return actor.kind === "member"
    ? (projectMemberActor(actor, new Date(authenticatedAt)) as T)
    : (projectStaffActor(actor, new Date(authenticatedAt)) as T);
}
