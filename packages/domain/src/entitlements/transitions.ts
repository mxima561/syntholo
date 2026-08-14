import type { EntitlementGrant, GrantStatus } from "./types.js";
export { addExactly168Hours, oneYearAnniversaryUtc } from "./time.js";

export type GrantTransitionReason = "payment_failure" | "recovery" | "terminal";

const allowed = new Set([
  "active:grace:payment_failure",
  "active:expired:terminal",
  "active:refunded:terminal",
  "active:revoked:terminal",
  "grace:active:recovery",
  "grace:expired:terminal",
  "grace:refunded:terminal",
  "grace:revoked:terminal",
  "expired:refunded:terminal",
  "expired:revoked:terminal",
]);

export function transitionGrant(
  grant: EntitlementGrant,
  to: GrantStatus,
  reason: GrantTransitionReason,
): EntitlementGrant {
  if (!allowed.has(`${grant.status}:${to}:${reason}`)
    || ((grant.status === "grace" || to === "grace")
      && (grant.sourceKind !== "subscription"
      || grant.endsAt === null))) {
    throw new Error("GRANT_TRANSITION_INVALID");
  }
  return Object.freeze({ ...grant, status: to });
}
