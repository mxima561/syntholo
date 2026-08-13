import type { Actor, MemberActor, StaffActor } from "@syntholo/domain";
import { AppError } from "../plugins/error-handler.js";

type AuthorizationRequirement =
  | { readonly role: MemberActor["role"] | StaffActor["role"] }
  | { readonly permission: string };

function authorizationError(code: "FORBIDDEN" | "RECENT_AUTH_REQUIRED", message: string): AppError {
  const error = new AppError(code, 403, message);
  error.message = code;
  return error;
}

export function authorize<T extends Actor>(actor: T, requirement: AuthorizationRequirement): T {
  const allowed =
    "role" in requirement
      ? actor.role === requirement.role
      : actor.kind === "staff" && actor.permissions.includes(requirement.permission);
  if (!allowed) throw authorizationError("FORBIDDEN", "Forbidden");
  return actor;
}

function frozenMember(actor: MemberActor): MemberActor {
  return Object.freeze({ ...actor, authenticatedAt: new Date(actor.authenticatedAt) });
}

function frozenStaff(actor: StaffActor): StaffActor {
  return Object.freeze({
    ...actor,
    permissions: Object.freeze([...actor.permissions]),
    authenticatedAt: new Date(actor.authenticatedAt),
  });
}

export function requireMember(actor: Actor): MemberActor {
  if (actor.kind !== "member") throw authorizationError("FORBIDDEN", "Forbidden");
  return frozenMember(actor);
}

export function requireCoach(actor: Actor): StaffActor & { role: "coach" } {
  if (actor.kind !== "staff" || actor.role !== "coach") {
    throw authorizationError("FORBIDDEN", "Forbidden");
  }
  return frozenStaff(actor) as StaffActor & { role: "coach" };
}

export function requireAdmin(actor: Actor): StaffActor & { role: "admin" } {
  if (actor.kind !== "staff" || actor.role !== "admin") {
    throw authorizationError("FORBIDDEN", "Forbidden");
  }
  return frozenStaff(actor) as StaffActor & { role: "admin" };
}

export function requireRecentAuth<T extends Actor>(
  actor: T,
  maximumAgeSeconds: number,
  now = new Date(),
): T {
  const authenticatedAt = actor.authenticatedAt;
  if (
    !Number.isSafeInteger(maximumAgeSeconds) ||
    maximumAgeSeconds < 0 ||
    !(authenticatedAt instanceof Date) ||
    !Number.isFinite(authenticatedAt.getTime()) ||
    authenticatedAt.getTime() > now.getTime() + 5_000 ||
    now.getTime() - authenticatedAt.getTime() > maximumAgeSeconds * 1_000
  ) {
    throw authorizationError("RECENT_AUTH_REQUIRED", "Recent authentication required");
  }
  return actor.kind === "member"
    ? (Object.freeze({
        ...frozenMember(actor),
        authenticatedAt: new Date(authenticatedAt),
      }) as T)
    : (Object.freeze({
        ...frozenStaff(actor),
        authenticatedAt: new Date(authenticatedAt),
      }) as T);
}
