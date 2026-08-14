import {
  CAPABILITIES,
  GRANT_STATUSES,
  HOLD_KINDS,
  type AccountHold,
  type EffectiveAccess,
  type EntitlementEvaluationInput,
  type EntitlementGrant,
  type GrantCapability,
  type SeatReservation,
} from "./types.js";
import { commercialInstant, oneYearAnniversaryUtc } from "./time.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const capabilitySet = new Set<string>(CAPABILITIES);
const holdSet = new Set<string>(HOLD_KINDS);
const statusSet = new Set<string>(GRANT_STATUSES);
const sourceKindSet = new Set(["purchase", "subscription", "administrative"]);
const offerSet = new Set([
  "guided_pilot",
  "self_paced",
  "operator_club_monthly",
  "operator_club_annual",
  "business_os",
]);

function invalid(): never {
  throw new Error("ENTITLEMENT_INPUT_INVALID");
}

function bundleInvalid(): never {
  throw new Error("ENTITLEMENT_BUNDLE_INVALID");
}

function isFiniteDate(value: unknown): value is Date {
  try {
    commercialInstant(value);
    return true;
  } catch {
    return false;
  }
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && new TextEncoder().encode(value).byteLength <= 255;
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}

function anniversaryUtcMilliseconds(value: Date): number {
  return oneYearAnniversaryUtc(value).getTime();
}

function registerId(value: string, ids: Set<string>): void {
  if (!uuidPattern.test(value) || ids.has(value)) invalid();
  ids.add(value);
}

function assertGrant(
  grant: EntitlementGrant,
  accountId: string,
  ids: Set<string>,
): void {
  registerId(grant.id, ids);
  if (
    grant.accountId !== accountId
    || !uuidPattern.test(grant.accountId)
    || !capabilitySet.has(grant.capability)
    || !statusSet.has(grant.status)
    || !sourceKindSet.has(grant.sourceKind)
    || !isBoundedText(grant.sourceId)
    || !isFiniteDate(grant.startsAt)
    || (grant.endsAt !== null && !isFiniteDate(grant.endsAt))
    || (grant.endsAt !== null && grant.endsAt.getTime() <= grant.startsAt.getTime())
    || (grant.status === "grace" && grant.endsAt === null)
    || (grant.status === "grace" && grant.sourceKind !== "subscription")
    || (grant.offerCode !== null && !offerSet.has(grant.offerCode))
    || (grant.academySourceId !== undefined
      && grant.academySourceId !== null
      && !isBoundedText(grant.academySourceId))
    || (grant.sourceCreatedAt !== undefined
      && !isFiniteDate(grant.sourceCreatedAt))
    || ((grant.sourceKind !== "subscription"
      || (grant.offerCode !== "operator_club_monthly"
        && grant.offerCode !== "operator_club_annual"))
      && grant.academySourceId !== undefined
      && grant.academySourceId !== null)
    || (grant.sourceKind === "subscription"
      && (grant.offerCode === "operator_club_monthly"
        || grant.offerCode === "operator_club_annual")
      && (!isBoundedText(grant.academySourceId)
        || !isFiniteDate(grant.sourceCreatedAt)))
    || (grant.sourceKind !== "administrative" && grant.offerCode === null)
    || (grant.capability === "business_os"
      && (grant.sourceKind !== "subscription"
        || grant.offerCode !== "business_os"
        || grant.endsAt === null))
  ) invalid();
}

function assertHold(
  hold: AccountHold,
  accountId: string,
  ids: Set<string>,
): void {
  registerId(hold.id, ids);
  if (
    hold.accountId !== accountId
    || !uuidPattern.test(hold.accountId)
    || !holdSet.has(hold.kind)
    || !isBoundedText(hold.sourceKind)
    || !isBoundedText(hold.sourceId)
    || !isFiniteDate(hold.createdAt)
    || (hold.releasedAt !== null && !isFiniteDate(hold.releasedAt))
    || (hold.releasedAt !== null
      && hold.releasedAt.getTime() < hold.createdAt.getTime())
  ) invalid();
}

function assertSeat(
  seat: SeatReservation,
  accountId: string,
  ids: Set<string>,
): void {
  registerId(seat.id, ids);
  if (
    seat.accountId !== accountId
    || !uuidPattern.test(seat.accountId)
    || ![1, 2, 3].includes(seat.slot)
    || !isBoundedText(seat.sourceId)
    || !["pending", "active", "expired", "revoked"].includes(seat.state)
    || (seat.membershipId !== null && !uuidPattern.test(seat.membershipId))
    || (seat.invitationId !== null && !uuidPattern.test(seat.invitationId))
    || (seat.expiresAt !== null && !isFiniteDate(seat.expiresAt))
  ) invalid();
  if (
    (seat.state === "pending"
      && (seat.membershipId !== null
        || seat.invitationId === null
        || seat.expiresAt === null))
    || (seat.state === "active"
      && (seat.membershipId === null
        || seat.expiresAt !== null))
    || (seat.state === "expired"
      && (seat.membershipId !== null
        || seat.invitationId === null
        || seat.expiresAt === null))
    || (seat.state === "revoked"
      && !(
        (seat.membershipId === null
          && seat.invitationId !== null
          && seat.expiresAt !== null)
        || (seat.membershipId !== null
          && seat.expiresAt === null)
      ))
  ) invalid();
}

function groupedProductGrants(
  grants: readonly EntitlementGrant[],
): Map<string, EntitlementGrant[]> {
  const groups = new Map<string, EntitlementGrant[]>();
  for (const grant of grants) {
    if (grant.sourceKind === "administrative") continue;
    const key = `${grant.accountId}\u0000${grant.sourceKind}\u0000${grant.sourceId}`;
    const group = groups.get(key) ?? [];
    group.push(grant);
    groups.set(key, group);
  }
  return groups;
}

function onePerCapability(
  group: readonly EntitlementGrant[],
  expected: readonly GrantCapability[],
): Readonly<Record<string, EntitlementGrant>> | null {
  if (group.length !== expected.length) return null;
  const byCapability: Record<string, EntitlementGrant> = {};
  for (const grant of group) {
    if (!expected.includes(grant.capability) || byCapability[grant.capability]) {
      return null;
    }
    byCapability[grant.capability] = grant;
  }
  return byCapability;
}

function sameProductIdentity(group: readonly EntitlementGrant[]): boolean {
  const first = group[0];
  return first !== undefined && group.every((grant) =>
    grant.accountId === first.accountId
    && grant.sourceKind === first.sourceKind
    && grant.sourceId === first.sourceId
    && grant.offerCode === first.offerCode
    && (grant.sourceCreatedAt?.getTime() ?? null)
      === (first.sourceCreatedAt?.getTime() ?? null),
  );
}

function isAcademyBundle(
  group: readonly EntitlementGrant[],
): boolean {
  const rows = onePerCapability(group, [
    "academy_course", "support", "circle_write",
  ]);
  if (!rows || !sameProductIdentity(group)) return false;
  const course = rows.academy_course!;
  const support = rows.support!;
  const circle = rows.circle_write!;
  const statusValid =
    (course.status === "active"
      && support.status === "active"
      && circle.status === "active")
    || (course.status === "active"
      && support.status === "expired"
      && circle.status === "expired")
    || (course.status === "refunded"
      && support.status === "refunded"
      && circle.status === "refunded")
    || (course.status === "revoked"
      && support.status === "revoked"
      && circle.status === "revoked");
  return statusValid
    && course.sourceKind === "purchase"
    && (course.offerCode === "guided_pilot" || course.offerCode === "self_paced")
    && sameInstant(course.startsAt, support.startsAt)
    && sameInstant(support.startsAt, circle.startsAt)
    && support.endsAt !== null
    && sameInstant(support.endsAt, circle.endsAt)
    && support.endsAt.getTime() === anniversaryUtcMilliseconds(course.startsAt)
    && course.endsAt === null;
}

function isClubBundle(group: readonly EntitlementGrant[]): boolean {
  const rows = onePerCapability(group, [
    "support", "circle_write", "operator_club",
  ]);
  if (!rows || !sameProductIdentity(group)) return false;
  const support = rows.support!;
  const circle = rows.circle_write!;
  const club = rows.operator_club!;
  return support.sourceKind === "subscription"
    && (support.offerCode === "operator_club_monthly"
      || support.offerCode === "operator_club_annual")
    && isBoundedText(support.academySourceId)
    && group.every((grant) => grant.academySourceId === support.academySourceId)
    && support.endsAt !== null
    && support.status === circle.status
    && circle.status === club.status
    && sameInstant(support.startsAt, circle.startsAt)
    && sameInstant(circle.startsAt, club.startsAt)
    && sameInstant(support.endsAt, circle.endsAt)
    && sameInstant(circle.endsAt, club.endsAt);
}

function isBusinessOsBundle(group: readonly EntitlementGrant[]): boolean {
  const rows = onePerCapability(group, ["business_os"]);
  const row = rows?.business_os;
  return row !== undefined
    && sameProductIdentity(group)
    && row.offerCode === "business_os"
    && row.sourceKind === "subscription"
    && row.endsAt !== null;
}

function assertProductBundles(grants: readonly EntitlementGrant[]): void {
  const groups = [...groupedProductGrants(grants).values()];
  for (const group of groups) {
    if (
      !isAcademyBundle(group)
      && !isClubBundle(group)
      && !isBusinessOsBundle(group)
    ) bundleInvalid();
  }
  const academies = groups.filter(isAcademyBundle);
  for (const group of groups.filter(isClubBundle)) {
    const clubStart = group[0]!.startsAt.getTime();
    const matches = academies.filter((academy) => {
      const support = academy.find(({ capability }) => capability === "support")!;
      const expectedStart = Math.max(
        support.endsAt?.getTime() ?? Number.NEGATIVE_INFINITY,
        group[0]!.sourceCreatedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
      );
      return academy[0]?.sourceId === group[0]?.academySourceId
        && clubStart === expectedStart;
    });
    if (matches.length !== 1) bundleInvalid();
  }
}

/**
 * Mirrors the defensive database uniqueness predicate. It deliberately does
 * not mean that the row is a valid bundle or can fund a new seat.
 */
export function occupiesAcademyPurchaseSlot(grant: EntitlementGrant): boolean {
  return grant.capability === "academy_course"
    && grant.sourceKind === "purchase"
    && (grant.offerCode === "self_paced" || grant.offerCode === "guided_pilot")
    && (grant.status === "active" || grant.status === "grace");
}

function assertOneAcademyPurchaseSlot(
  grants: readonly EntitlementGrant[],
): void {
  if (grants.filter(occupiesAcademyPurchaseSlot).length > 1) invalid();
}

function clubEligibleGrantIds(
  grants: readonly EntitlementGrant[],
  nowMs: number,
): ReadonlySet<string> {
  const groups = [...groupedProductGrants(grants).values()];
  const academies = groups.filter(isAcademyBundle);
  const allowedIds = new Set<string>();
  for (const club of groups.filter(isClubBundle)) {
    const parentSourceId = club[0]!.academySourceId;
    const parent = academies.find((academy) => academy[0]!.sourceId === parentSourceId);
    const course = parent?.find(({ capability }) => capability === "academy_course");
    if (course !== undefined && effective(course, nowMs)) {
      for (const grant of club) allowedIds.add(grant.id);
    }
  }
  return allowedIds;
}

function effective(grant: EntitlementGrant, nowMs: number): boolean {
  return (grant.status === "active" || grant.status === "grace")
    && grant.startsAt.getTime() <= nowMs
    && (grant.endsAt === null || nowMs < grant.endsAt.getTime());
}

function validateEvaluationInput(input: EntitlementEvaluationInput): void {
  if (!uuidPattern.test(input.accountId) || !isFiniteDate(input.now)) invalid();
  assertOneAcademyPurchaseSlot(input.grants);
  const ids = new Set<string>();
  const grantKeys = new Set<string>();
  const sourceIdentities = new Map<string, string>();
  for (const grant of input.grants) {
    assertGrant(grant, input.accountId, ids);
    const sourceKey = `${grant.sourceKind}\u0000${grant.sourceId}`;
    const grantKey = `${sourceKey}\u0000${grant.capability}`;
    if (grantKeys.has(grantKey)) invalid();
    grantKeys.add(grantKey);
    const sourceIdentity = `${grant.offerCode ?? ""}\u0000${grant.academySourceId ?? ""}`;
    const priorIdentity = sourceIdentities.get(sourceKey);
    if (priorIdentity !== undefined && priorIdentity !== sourceIdentity) invalid();
    sourceIdentities.set(sourceKey, sourceIdentity);
  }
  const holdKeys = new Set<string>();
  for (const hold of input.holds) {
    assertHold(hold, input.accountId, ids);
    const key = `${hold.sourceKind}\u0000${hold.sourceId}\u0000${hold.kind}`;
    if (holdKeys.has(key)) invalid();
    holdKeys.add(key);
  }
  const invitationIds = new Set<string>();
  for (const seat of input.seats) {
    assertSeat(seat, input.accountId, ids);
    if (seat.invitationId !== null) {
      if (invitationIds.has(seat.invitationId)) invalid();
      invitationIds.add(seat.invitationId);
    }
  }
  assertProductBundles(input.grants);
  const productGroups = [...groupedProductGrants(input.grants).values()];
  for (const seat of input.seats) {
    const matchingAcademy = productGroups.filter((group) =>
      group[0]?.sourceId === seat.sourceId && isAcademyBundle(group));
    if (matchingAcademy.length !== 1) invalid();
    if (seat.state === "pending" || seat.state === "active") {
      const course = matchingAcademy[0]!.find(({ capability }) =>
        capability === "academy_course")!;
      if (course.status !== "active" || course.endsAt !== null) invalid();
    }
  }
}

function academyCandidates(
  grants: readonly EntitlementGrant[],
  now: Date,
): EntitlementGrant[][] {
  if (!isFiniteDate(now)) invalid();
  if (grants.length === 0) return [];
  const accounts = new Set(grants.map(({ accountId }) => accountId));
  const ids = new Set<string>();
  if (accounts.size !== 1 || !uuidPattern.test(grants[0]!.accountId)) invalid();
  for (const grant of grants) assertGrant(grant, grants[0]!.accountId, ids);
  assertOneAcademyPurchaseSlot(grants);
  assertProductBundles(grants);
  const nowMs = now.getTime();
  return [...groupedProductGrants(grants).values()].filter((group) => {
    if (!isAcademyBundle(group)) return false;
    const course = group.find(({ capability }) => capability === "academy_course")!;
    return effective(course, nowMs);
  });
}

export function isQualifyingAcademySeatSource(
  grants: readonly EntitlementGrant[],
  sourceId: string,
): boolean {
  if (!isBoundedText(sourceId) || grants.length === 0) return false;
  try {
    const accounts = new Set(grants.map(({ accountId }) => accountId));
    if (accounts.size !== 1 || !uuidPattern.test(grants[0]!.accountId)) return false;
    const ids = new Set<string>();
    for (const grant of grants) assertGrant(grant, grants[0]!.accountId, ids);
    assertOneAcademyPurchaseSlot(grants);
    assertProductBundles(grants);
    const matching = [...groupedProductGrants(grants).values()].filter((group) =>
      group[0]?.sourceId === sourceId && isAcademyBundle(group));
    if (matching.length !== 1) return false;
    const course = matching[0]!.find(({ capability }) => capability === "academy_course")!;
    return course.status === "active" && course.endsAt === null;
  } catch {
    return false;
  }
}

export function qualifyingAcademyPurchase(
  grants: readonly EntitlementGrant[],
  now: Date,
): boolean {
  const candidates = academyCandidates(grants, now);
  if (candidates.length > 1) invalid();
  return candidates.length === 1;
}

export function includedSupportEndForQualifyingAcademyPurchase(
  grants: readonly EntitlementGrant[],
  now: Date,
): Date | null {
  const candidates = academyCandidates(grants, now);
  if (candidates.length > 1) invalid();
  const support = candidates[0]?.find(({ capability }) => capability === "support");
  return support?.endsAt === null || support?.endsAt === undefined
    ? null
    : new Date(support.endsAt);
}

function deepFreeze(result: EffectiveAccess): EffectiveAccess {
  Object.freeze(result.capabilities);
  Object.freeze(result.holds);
  for (const explanation of result.explanations) {
    Object.freeze(explanation.sourceGrantIds);
    Object.freeze(explanation);
  }
  Object.freeze(result.explanations);
  return Object.freeze(result);
}

export function evaluateEntitlements(
  input: EntitlementEvaluationInput,
): EffectiveAccess {
  validateEvaluationInput(input);
  const nowMs = input.now.getTime();
  const allowedClubGrantIds = clubEligibleGrantIds(input.grants, nowMs);
  const occupied = input.seats.filter((seat) =>
    seat.state === "active"
    || (seat.state === "pending" && seat.expiresAt!.getTime() > nowMs),
  );
  if (
    occupied.length > 3
    || new Set(occupied.map(({ slot }) => slot)).size !== occupied.length
    || new Set(occupied.filter(({ state }) => state === "active")
      .map(({ membershipId }) => membershipId)).size
      !== occupied.filter(({ state }) => state === "active").length
  ) invalid();

  const explanations = CAPABILITIES.map((capability) => Object.freeze({
    capability,
    sourceGrantIds: Object.freeze(input.grants
      .filter((grant) => grant.capability === capability
        && effective(grant, nowMs)
        && (grant.sourceKind !== "subscription"
          || (grant.offerCode !== "operator_club_monthly"
          && grant.offerCode !== "operator_club_annual"
          || allowedClubGrantIds.has(grant.id))))
      .map(({ id }) => id)
      .sort()),
  }));
  const capabilities = Object.fromEntries(explanations.map((explanation) => [
    explanation.capability,
    explanation.sourceGrantIds.length > 0,
  ])) as Record<GrantCapability, boolean>;
  const holds = HOLD_KINDS.filter((kind) =>
    input.holds.some((hold) => hold.kind === kind && hold.releasedAt === null),
  );

  return deepFreeze({
    accountId: input.accountId,
    capabilities,
    holds,
    seatLimit: 3,
    reservedSeats: occupied.length,
    explanations,
  });
}
