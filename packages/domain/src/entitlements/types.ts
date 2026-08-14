export const CAPABILITIES = Object.freeze([
  "academy_course",
  "support",
  "circle_write",
  "operator_club",
  "business_os",
] as const);

export const HOLD_KINDS = Object.freeze([
  "commerce",
  "seat_changes",
  "business_os_activation",
] as const);

export const GRANT_STATUSES = Object.freeze([
  "active",
  "grace",
  "expired",
  "refunded",
  "revoked",
] as const);

export type GrantCapability = (typeof CAPABILITIES)[number];
export type HoldKind = (typeof HOLD_KINDS)[number];
export type GrantStatus = (typeof GRANT_STATUSES)[number];
export type GrantSourceKind = "purchase" | "subscription" | "administrative";
export type EntitlementOfferCode =
  | "guided_pilot"
  | "self_paced"
  | "operator_club_monthly"
  | "operator_club_annual"
  | "business_os";

export type EntitlementGrant = Readonly<{
  id: string;
  accountId: string;
  capability: GrantCapability;
  status: GrantStatus;
  sourceKind: GrantSourceKind;
  sourceId: string;
  offerCode: EntitlementOfferCode | null;
  /** Internal immutable pairing for Operator Club; null for other sources. */
  academySourceId?: string | null;
  /** Internal immutable source-registry creation time used for Club handoff. */
  sourceCreatedAt?: Date;
  startsAt: Date;
  endsAt: Date | null;
}>;

export type AccountHold = Readonly<{
  id: string;
  accountId: string;
  kind: HoldKind;
  sourceKind: string;
  sourceId: string;
  createdAt: Date;
  releasedAt: Date | null;
}>;

export type SeatReservation = Readonly<{
  id: string;
  accountId: string;
  slot: 1 | 2 | 3;
  sourceId: string;
  state: "pending" | "active" | "expired" | "revoked";
  membershipId: string | null;
  invitationId: string | null;
  expiresAt: Date | null;
}>;

export type EntitlementEvaluationInput = Readonly<{
  accountId: string;
  now: Date;
  grants: readonly EntitlementGrant[];
  holds: readonly AccountHold[];
  seats: readonly SeatReservation[];
}>;

export type EffectiveAccess = Readonly<{
  accountId: string;
  capabilities: Readonly<Record<GrantCapability, boolean>>;
  holds: readonly HoldKind[];
  seatLimit: 3;
  reservedSeats: number;
  explanations: readonly Readonly<{
    capability: GrantCapability;
    sourceGrantIds: readonly string[];
  }>[];
}>;
