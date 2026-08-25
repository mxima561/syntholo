import { ACADEMY_SEAT_LIMIT } from "./seats";
import type { Entitlement, EntitlementKind, EntitlementStatus } from "./types";

export type GrantCapability =
  | "academy_course"
  | "support"
  | "circle_write"
  | "operator_club"
  | "business_os";

export type GrantSource = "purchase" | "admin" | "demo";

export type GrantStatus = EntitlementStatus;

export type HoldKind = "commerce" | "seat_changes" | "business_os_activation";

export const GRANT_CAPABILITIES = [
  "academy_course",
  "support",
  "circle_write",
  "operator_club",
  "business_os",
] as const satisfies readonly GrantCapability[];

export const HOLD_KINDS = ["commerce", "seat_changes", "business_os_activation"] as const satisfies readonly HoldKind[];

export type EntitlementGrant = Readonly<{
  id: string;
  capability: GrantCapability;
  status: GrantStatus;
  startsAt: Date | string;
  endsAt: Date | string | null;
}>;

export type AccountHold = Readonly<{
  kind: HoldKind;
  active: boolean;
}>;

export type SeatReservation = Readonly<{
  status: "reserved" | "released" | "expired";
}>;

export type AccessExplanation = Readonly<{
  capability: GrantCapability;
  sourceGrantIds: readonly string[];
}>;

export type EffectiveAccess = Readonly<{
  accountId: string;
  capabilities: Readonly<Record<GrantCapability, boolean>>;
  holds: readonly HoldKind[];
  seatLimit: 3;
  reservedSeats: number;
  explanations: readonly AccessExplanation[];
}>;

export type EntitlementEvaluationInput = {
  accountId: string;
  now: Date;
  grants: readonly EntitlementGrant[];
  holds: readonly AccountHold[];
  seats: readonly SeatReservation[];
};

const CAPABILITY_LABELS: Record<GrantCapability, string> = {
  academy_course: "Academy access",
  support: "Support",
  circle_write: "Community posting",
  operator_club: "Operator Club",
  business_os: "Business OS",
};

const HOLD_MESSAGES: Record<HoldKind, string> = {
  commerce: "Commerce for this account is on hold.",
  seat_changes: "Seat changes are on hold for this account.",
  business_os_activation: "Business OS activation is on hold for this account.",
};

function timestamp(value: Date | string) {
  return (value instanceof Date ? value : new Date(value)).getTime();
}

function isReserved(seat: SeatReservation) {
  return seat.status === "reserved";
}

function isUsableGrant(grant: EntitlementGrant, now: Date) {
  if (grant.status !== "active" && grant.status !== "grace") return false;
  if (timestamp(grant.startsAt) > now.getTime()) return false;
  if (grant.endsAt && timestamp(grant.endsAt) <= now.getTime()) return false;
  return true;
}

export function reservedSeatsFromCount(count: number): SeatReservation[] {
  const reserved = Math.max(0, count);
  return Array.from({ length: reserved }, () => ({ status: "reserved" as const }));
}

export function holdsForOpenDispute(): readonly HoldKind[] {
  return HOLD_KINDS;
}

export function grantCapabilityToKind(capability: GrantCapability): EntitlementKind {
  if (capability === "academy_course") return "course";
  if (capability === "circle_write") return "community_write";
  return capability;
}

export function entitlementKindToCapability(kind: EntitlementKind): GrantCapability {
  if (kind === "course") return "academy_course";
  if (kind === "community_write") return "circle_write";
  return kind;
}

export function evaluateEntitlements(input: EntitlementEvaluationInput): EffectiveAccess {
  const usable = input.grants.filter((grant) => isUsableGrant(grant, input.now));
  const sources = (capability: GrantCapability) =>
    usable
      .filter((grant) => grant.capability === capability)
      .map((grant) => grant.id)
      .sort();

  const capabilities = Object.fromEntries(
    GRANT_CAPABILITIES.map((capability) => [capability, sources(capability).length > 0]),
  ) as Record<GrantCapability, boolean>;

  const activeHolds = new Set(input.holds.filter((hold) => hold.active).map((hold) => hold.kind));

  return Object.freeze({
    accountId: input.accountId,
    capabilities: Object.freeze(capabilities),
    holds: HOLD_KINDS.filter((kind) => activeHolds.has(kind)),
    seatLimit: ACADEMY_SEAT_LIMIT,
    reservedSeats: input.seats.filter(isReserved).length,
    explanations: GRANT_CAPABILITIES.map((capability) => ({
      capability,
      sourceGrantIds: sources(capability),
    })),
  });
}

export function canAccess(kind: EntitlementKind, entitlements: Entitlement[], now = new Date()) {
  const access = evaluateEntitlements({
    accountId: entitlements[0]?.organizationId ?? "",
    now,
    grants: entitlements.map((entitlement) => ({
      id: entitlement.id,
      capability: entitlementKindToCapability(entitlement.kind),
      status: entitlement.status,
      startsAt: entitlement.startsAt,
      endsAt: entitlement.endsAt,
    })),
    holds: [],
    seats: [],
  });
  return access.capabilities[entitlementKindToCapability(kind)];
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
  return evaluateEntitlements({
    accountId: "",
    now,
    grants,
    holds: [],
    seats: [],
  }).capabilities[capability];
}

export function assertCapability(access: EffectiveAccess, capability: GrantCapability) {
  if (!access.capabilities[capability]) {
    throw new Error(`${CAPABILITY_LABELS[capability]} is not included on this account.`);
  }
}

export function assertHoldClear(access: EffectiveAccess, kind: HoldKind) {
  if (access.holds.includes(kind)) {
    throw new Error(HOLD_MESSAGES[kind]);
  }
}
