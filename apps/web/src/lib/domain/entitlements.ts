import type { Entitlement, EntitlementKind } from "./types";

export function canAccess(kind: EntitlementKind, entitlements: Entitlement[], now = new Date()) {
  return entitlements.some((entitlement) => {
    if (entitlement.kind !== kind) return false;
    if (entitlement.status !== "active" && entitlement.status !== "grace") return false;
    if (!entitlement.endsAt) return true;

    return new Date(entitlement.endsAt).getTime() > now.getTime();
  });
}

