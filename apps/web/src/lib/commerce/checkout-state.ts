import {
  assertCheckoutAuthorized,
  CheckoutAuthorizationError,
  checkoutErrorCopy,
  currentAcademyLaunchReadiness,
  guestAccess,
  offerFromSlug,
  type CheckoutEnv,
  type EffectiveAccess,
  type OfferContext,
} from "@syntholo/domain";

export function guestCheckoutContext(): OfferContext {
  const { readiness } = currentAcademyLaunchReadiness();
  return {
    content: readiness,
    access: guestAccess(),
    businessOsReady: false,
  };
}

export function checkoutContextForAccess(access: EffectiveAccess): OfferContext {
  return {
    ...guestCheckoutContext(),
    access,
  };
}

export function resolveCheckoutOffer(slug: string, context: OfferContext, env: CheckoutEnv = {}) {
  const offer = offerFromSlug(slug);
  if (!offer) return null;
  try {
    assertCheckoutAuthorized({ offer, context, env });
    return { offer, allowed: true as const, reasonCode: null, message: null };
  } catch (error) {
    if (error instanceof CheckoutAuthorizationError) {
      return {
        offer,
        allowed: false as const,
        reasonCode: error.code,
        message: checkoutErrorCopy(error.code),
      };
    }
    throw error;
  }
}
