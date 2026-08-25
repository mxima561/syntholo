import { describe, expect, it } from "vitest";
import { guestCheckoutContext, resolveCheckoutOffer } from "./checkout-state";

describe("resolveCheckoutOffer", () => {
  it("blocks Self-Paced until the curriculum gate passes", () => {
    const view = resolveCheckoutOffer("self-paced", guestCheckoutContext(), { NODE_ENV: "production" });
    expect(view?.allowed).toBe(false);
    expect(view?.reasonCode).toBe("CURRICULUM_GATE_BLOCKED");
    expect(view?.message).toBe("Enrollment is not open yet.");
  });

  it("blocks Operator Club until Academy access exists", () => {
    const view = resolveCheckoutOffer("operator-club", guestCheckoutContext());
    expect(view?.allowed).toBe(false);
    expect(view?.reasonCode).toBe("ACADEMY_REQUIRED");
  });

  it("blocks Business OS until operational readiness is attached", () => {
    const view = resolveCheckoutOffer("business-os", guestCheckoutContext());
    expect(view?.allowed).toBe(false);
    expect(view?.reasonCode).toBe("BUSINESS_OS_NOT_READY");
  });

  it("does not honor a staging override in production", () => {
    const view = resolveCheckoutOffer("self-paced", guestCheckoutContext(), {
      NODE_ENV: "production",
      ACADEMY_CHECKOUT_STAGING_OVERRIDE: "1",
    });
    expect(view?.allowed).toBe(false);
    expect(view?.reasonCode).toBe("CURRICULUM_GATE_BLOCKED");
  });

  it("allows a staging override only outside production", () => {
    const view = resolveCheckoutOffer("self-paced", guestCheckoutContext(), {
      NODE_ENV: "test",
      ACADEMY_CHECKOUT_STAGING_OVERRIDE: "1",
    });
    expect(view?.allowed).toBe(true);
  });
});
