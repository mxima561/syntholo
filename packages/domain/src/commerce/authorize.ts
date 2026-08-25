import { evaluateOfferAvailability, type OfferContext } from "./availability";
import {
  academyCurriculumOverrideEnabled,
  CheckoutAuthorizationError,
  type CheckoutEnv,
  type PilotAuthorization,
} from "./checkout";
import type { Offer } from "./offers";

export function assertPilotAuthorization(offer: Offer, authorization: PilotAuthorization | null, now: Date) {
  if (offer.code !== "guided_pilot") return;
  if (!authorization || authorization.status === "missing") {
    throw new CheckoutAuthorizationError("AUTHORIZATION_REQUIRED");
  }
  if (authorization.offerCode !== offer.code || authorization.status === "wrong_offer") {
    throw new CheckoutAuthorizationError("WRONG_OFFER");
  }
  if (authorization.status === "consumed") {
    throw new CheckoutAuthorizationError("AUTHORIZATION_REPLAYED");
  }
  if (
    authorization.status === "expired" ||
    (authorization.expiresAt !== null && authorization.expiresAt.getTime() <= now.getTime())
  ) {
    throw new CheckoutAuthorizationError("AUTHORIZATION_EXPIRED");
  }
  if (authorization.status !== "valid") {
    throw new CheckoutAuthorizationError("AUTHORIZATION_REQUIRED");
  }
}

export function assertCheckoutAuthorized(input: {
  offer: Offer;
  context: OfferContext;
  env?: CheckoutEnv;
  now?: Date;
  pilotAuthorization?: PilotAuthorization | null;
}): void {
  const now = input.now ?? new Date();
  const availability = evaluateOfferAvailability(input.offer, input.context);
  if (!availability.available) {
    const override =
      availability.reasonCode === "CURRICULUM_GATE_BLOCKED" && academyCurriculumOverrideEnabled(input.env ?? {});
    if (!override) {
      throw new CheckoutAuthorizationError(availability.reasonCode ?? "OFFER_UNAVAILABLE");
    }
  }
  if (input.offer.kind === "lead") {
    throw new CheckoutAuthorizationError("OFFER_NOT_CHECKOUT");
  }
  assertPilotAuthorization(input.offer, input.pilotAuthorization ?? null, now);
}
