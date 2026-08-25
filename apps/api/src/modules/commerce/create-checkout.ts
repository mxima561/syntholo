import {
  assertCheckoutAuthorized,
  CheckoutAuthorizationError,
  guestAccess,
  isOfferCode,
  offersByCode,
  type CheckoutEnv,
  type EffectiveAccess,
  type PilotAuthorization,
} from "@syntholo/domain";
import { evaluateLaunchReadiness } from "../content/evaluate-launch-readiness";

export interface StripePort {
  createCheckoutSession(command: {
    priceId: string;
    mode: "payment" | "subscription";
    currency: "usd";
    unitAmount: number;
    productName: string;
    interval?: "month" | "year";
    customerEmail: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string }>;
}

export type CreateCheckoutCommand = {
  offerCode: string;
  email: string;
  idempotencyKey: string;
  authorizationToken?: string;
  accountId?: string | null;
  successUrl: string;
  cancelUrl: string;
  /** Ignored. Amount and sellability come from the server catalog and readiness report. */
  amount?: unknown;
  priceId?: unknown;
  canSellAcademy?: unknown;
};

export type CheckoutDeps = {
  stripe: StripePort;
  now?: Date;
  env?: CheckoutEnv;
  businessOsReady?: boolean;
  access?: EffectiveAccess;
  loadAccess?: (accountId: string) => Promise<EffectiveAccess>;
  loadPilotAuthorization?: (token: string) => Promise<PilotAuthorization | null>;
  content?: { current: () => { readiness: import("@syntholo/domain").ContentLaunchReadiness } };
};

export async function createCheckout(command: CreateCheckoutCommand, deps: CheckoutDeps) {
  if (!isOfferCode(command.offerCode)) {
    throw new CheckoutAuthorizationError("UNKNOWN_OFFER");
  }
  const offer = offersByCode[command.offerCode];
  const { readiness } = deps.content?.current() ?? evaluateLaunchReadiness(deps.now);
  const access =
    command.accountId && deps.loadAccess ? await deps.loadAccess(command.accountId) : (deps.access ?? guestAccess());
  const pilotAuthorization =
    offer.code === "guided_pilot"
      ? command.authorizationToken
        ? ((await deps.loadPilotAuthorization?.(command.authorizationToken)) ?? {
            status: "missing" as const,
            offerCode: "guided_pilot",
            expiresAt: null,
          })
        : { status: "missing" as const, offerCode: "guided_pilot", expiresAt: null }
      : null;

  assertCheckoutAuthorized({
    offer,
    context: {
      content: readiness,
      access,
      businessOsReady: deps.businessOsReady ?? false,
    },
    env: deps.env ?? process.env,
    now: deps.now ?? new Date(),
    pilotAuthorization,
  });

  if (offer.amount == null || !offer.stripePriceId) {
    throw new CheckoutAuthorizationError("OFFER_NOT_CHECKOUT");
  }

  return deps.stripe.createCheckoutSession({
    priceId: offer.stripePriceId,
    mode: offer.kind === "subscription" ? "subscription" : "payment",
    currency: offer.currency,
    unitAmount: offer.amount,
    productName: offer.name,
    interval: offer.interval,
    customerEmail: command.email,
    successUrl: command.successUrl,
    cancelUrl: command.cancelUrl,
    metadata: {
      offerCode: offer.code,
      offer: offer.slug,
    },
    idempotencyKey: command.idempotencyKey,
  });
}
