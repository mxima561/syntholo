import type { GrantCapability } from "../entitlements";

export const OFFER_CODES = [
  "scorecard",
  "guided_pilot",
  "self_paced",
  "operator_club_monthly",
  "operator_club_annual",
  "business_os",
] as const;

export type OfferCode = (typeof OFFER_CODES)[number];

export type OfferState = "draft" | "waitlist" | "enabled" | "paused";

export type OfferKind = "lead" | "payment" | "subscription";

export type Offer = Readonly<{
  code: OfferCode;
  slug: string;
  name: string;
  state: OfferState;
  kind: OfferKind;
  displayAmount: string | null;
  amount: number | null;
  currency: "usd";
  interval?: "month" | "year";
  stripePriceId: string | null;
  startsAt: Date | null;
}>;

export const ACADEMY_OFFER_CODES = ["self_paced", "guided_pilot"] as const satisfies readonly OfferCode[];
export const OPERATOR_CLUB_OFFER_CODES = ["operator_club_monthly", "operator_club_annual"] as const satisfies readonly OfferCode[];

const OFFER_CAPABILITIES: Record<OfferCode, readonly GrantCapability[]> = {
  scorecard: [],
  self_paced: ["academy_course", "support", "circle_write"],
  guided_pilot: ["academy_course", "support", "circle_write"],
  operator_club_monthly: ["operator_club", "support", "circle_write"],
  operator_club_annual: ["operator_club", "support", "circle_write"],
  business_os: ["business_os"],
};

export const offersByCode: Record<OfferCode, Offer> = {
  scorecard: {
    code: "scorecard",
    slug: "scorecard",
    name: "AI Readiness Scorecard",
    state: "enabled",
    kind: "lead",
    displayAmount: null,
    amount: null,
    currency: "usd",
    stripePriceId: null,
    startsAt: null,
  },
  self_paced: {
    code: "self_paced",
    slug: "self-paced",
    name: "AI Operating System Academy",
    state: "enabled",
    kind: "payment",
    displayAmount: "$399.00",
    amount: 39_900,
    currency: "usd",
    stripePriceId: "price_self_paced",
    startsAt: null,
  },
  guided_pilot: {
    code: "guided_pilot",
    slug: "guided-pilot",
    name: "Guided Pilot",
    state: "enabled",
    kind: "payment",
    displayAmount: "$750.00",
    amount: 75_000,
    currency: "usd",
    stripePriceId: "price_guided_pilot",
    startsAt: null,
  },
  operator_club_monthly: {
    code: "operator_club_monthly",
    slug: "operator-club",
    name: "Operator Club",
    state: "enabled",
    kind: "subscription",
    displayAmount: "$59.00 / month",
    amount: 5_900,
    currency: "usd",
    interval: "month",
    stripePriceId: "price_operator_club_monthly",
    startsAt: null,
  },
  operator_club_annual: {
    code: "operator_club_annual",
    slug: "operator-club-annual",
    name: "Operator Club Annual",
    state: "draft",
    kind: "subscription",
    displayAmount: "$590.00 / year",
    amount: 59_000,
    currency: "usd",
    interval: "year",
    stripePriceId: "price_operator_club_annual",
    startsAt: null,
  },
  business_os: {
    code: "business_os",
    slug: "business-os",
    name: "Syntholo Business OS",
    state: "enabled",
    kind: "payment",
    displayAmount: "$999.00 today",
    amount: 99_900,
    currency: "usd",
    stripePriceId: "price_business_os",
    startsAt: null,
  },
};

const SLUG_TO_CODE: Record<string, OfferCode> = Object.fromEntries(
  Object.values(offersByCode).map((offer) => [offer.slug, offer.code]),
) as Record<string, OfferCode>;

export function isOfferCode(value: string): value is OfferCode {
  return value in offersByCode;
}

export function isAcademyOffer(code: OfferCode): boolean {
  return (ACADEMY_OFFER_CODES as readonly string[]).includes(code);
}

export function isOperatorClubOffer(code: OfferCode): boolean {
  return (OPERATOR_CLUB_OFFER_CODES as readonly string[]).includes(code);
}

export function capabilitiesCreatedBy(code: OfferCode): readonly GrantCapability[] {
  return OFFER_CAPABILITIES[code];
}

export function offerFromSlug(slug: string): Offer | null {
  const code = SLUG_TO_CODE[slug];
  return code ? offersByCode[code] : null;
}

export function toPublicOfferDisplay(offer: Offer, availability: { available: boolean; reasonCode: string | null; startsAt: Date | null }) {
  return {
    code: offer.code,
    slug: offer.slug,
    name: offer.name,
    kind: offer.kind,
    state: offer.state,
    displayAmount: offer.displayAmount,
    available: availability.available,
    reasonCode: availability.reasonCode,
    startsAt: availability.startsAt ? availability.startsAt.toISOString() : null,
  };
}
