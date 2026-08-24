import type { Entitlement, EntitlementKind, EntitlementStatus } from "./types";

export type GrantCapability =
  | "academy_course"
  | "support"
  | "circle_write"
  | "operator_club"
  | "business_os";

export type GrantSource = "purchase" | "admin" | "demo";

export function grantCapabilityToKind(capability: GrantCapability): EntitlementKind {
  if (capability === "academy_course") return "course";
  if (capability === "circle_write") return "community_write";
  return capability;
}

export function canAccess(kind: EntitlementKind, entitlements: Entitlement[], now = new Date()) {
  return entitlements.some((entitlement) => {
    if (entitlement.kind !== kind) return false;
    if (entitlement.status !== "active" && entitlement.status !== "grace") return false;
    if (!entitlement.endsAt) return true;

    return new Date(entitlement.endsAt).getTime() > now.getTime();
  });
}

export function grantsToEntitlements(
  grants: ReadonlyArray<{
    id: string;
    capability: GrantCapability;
    status: EntitlementStatus;
    startsAt: Date | string;
    endsAt: Date | string | null;
  }>,
): Entitlement[] {
  return grants.map((grant) => ({
    id: grant.id,
    organizationId: "",
    kind: grantCapabilityToKind(grant.capability),
    status: grant.status,
    startsAt: typeof grant.startsAt === "string" ? grant.startsAt : grant.startsAt.toISOString(),
    endsAt: grant.endsAt ? (typeof grant.endsAt === "string" ? grant.endsAt : grant.endsAt.toISOString()) : null,
  }));
}

export function hasCapability(
  capability: GrantCapability,
  grants: ReadonlyArray<{
    id: string;
    capability: GrantCapability;
    status: EntitlementStatus;
    startsAt: Date | string;
    endsAt: Date | string | null;
  }>,
  now = new Date(),
) {
  return canAccess(grantCapabilityToKind(capability), grantsToEntitlements(grants), now);
}

