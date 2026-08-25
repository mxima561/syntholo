export type CheckoutEnv = Readonly<{
  NODE_ENV?: string;
  APP_MODE?: string;
  ACADEMY_CHECKOUT_STAGING_OVERRIDE?: string;
}>;

export function academyCurriculumOverrideEnabled(env: CheckoutEnv = {}): boolean {
  if (env.NODE_ENV === "production") return false;
  if (env.APP_MODE === "production") return false;
  return env.ACADEMY_CHECKOUT_STAGING_OVERRIDE === "1";
}

export class CheckoutAuthorizationError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "CheckoutAuthorizationError";
    this.code = code;
  }
}

export type PilotAuthorizationStatus = "missing" | "expired" | "consumed" | "valid" | "wrong_offer";

export type PilotAuthorization = Readonly<{
  status: PilotAuthorizationStatus;
  offerCode: string;
  expiresAt: Date | null;
}>;

export const CHECKOUT_ERROR_COPY = {
  OFFER_UNAVAILABLE: "This offer is not available right now.",
  OFFER_DISABLED: "This offer is not available right now.",
  OFFER_WAITLIST: "This offer is on the waitlist.",
  OFFER_NOT_CHECKOUT: "This offer cannot be purchased at checkout.",
  UNKNOWN_OFFER: "This offer is not available right now.",
  CURRICULUM_GATE_BLOCKED: "Enrollment is not open yet.",
  AUTHORIZATION_EXPIRED: "This private checkout link has expired.",
  AUTHORIZATION_REQUIRED: "This private checkout link is not valid.",
  AUTHORIZATION_REPLAYED: "This private checkout link has already been used.",
  WRONG_OFFER: "This checkout link does not match the selected offer.",
  ACADEMY_REQUIRED: "Operator Club is available after Academy access is active.",
  BUSINESS_OS_NOT_READY: "Business OS checkout is not open yet.",
  COMMERCE_HOLD: "New purchases are paused on this account.",
} as const;

export type CheckoutErrorCode = keyof typeof CHECKOUT_ERROR_COPY;

export function checkoutErrorCopy(code: string): string {
  return (CHECKOUT_ERROR_COPY as Record<string, string>)[code] ?? CHECKOUT_ERROR_COPY.OFFER_UNAVAILABLE;
}
