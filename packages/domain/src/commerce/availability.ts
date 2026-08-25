import { evaluateEntitlements, type EffectiveAccess } from "../entitlements";
import type { ContentLaunchReadiness } from "../content/readiness";
import { isAcademyOffer, isOperatorClubOffer, OFFER_CODES, offersByCode, toPublicOfferDisplay, type Offer } from "./offers";

export type OfferAvailability = Readonly<{
  available: boolean;
  reasonCode: string | null;
  startsAt: Date | null;
}>;

export type OfferContext = Readonly<{
  content: ContentLaunchReadiness;
  access: EffectiveAccess;
  businessOsReady: boolean;
}>;

export function guestAccess(accountId = ""): EffectiveAccess {
  return evaluateEntitlements({
    accountId,
    now: new Date(0),
    grants: [],
    holds: [],
    seats: [],
  });
}

function blocked(reasonCode: string, startsAt: Date | null = null): OfferAvailability {
  return { available: false, reasonCode, startsAt };
}

export function evaluateOfferAvailability(offer: Offer, context: OfferContext): OfferAvailability {
  if (offer.state === "waitlist") return blocked("OFFER_WAITLIST", offer.startsAt);
  if (offer.state !== "enabled") return blocked("OFFER_DISABLED");
  if (context.access.holds.includes("commerce")) return blocked("COMMERCE_HOLD");
  const canSellAcademy =
    context.content.canSellAcademy &&
    context.content.automatedPassedAt !== null &&
    context.content.humanApprovedAt !== null;
  if (isAcademyOffer(offer.code) && !canSellAcademy) {
    return blocked("CURRICULUM_GATE_BLOCKED");
  }
  if (isOperatorClubOffer(offer.code) && !context.access.capabilities.academy_course) {
    return blocked("ACADEMY_REQUIRED");
  }
  if (offer.code === "business_os" && !context.businessOsReady) {
    return blocked("BUSINESS_OS_NOT_READY");
  }
  return { available: true, reasonCode: null, startsAt: null };
}

export function listPublicOffers(context: OfferContext) {
  return OFFER_CODES.map((code) => {
    const offer = offersByCode[code];
    return toPublicOfferDisplay(offer, evaluateOfferAvailability(offer, context));
  });
}
