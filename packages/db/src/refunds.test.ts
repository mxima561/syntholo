import { describe, expect, it } from "vitest";
import { refundStateTransition, type PurchaseSnapshot } from "./refunds";

function purchase(overrides: Partial<PurchaseSnapshot> = {}): PurchaseSnapshot {
  return {
    id: "p1",
    userId: "u1",
    email: "student@example.com",
    offer: "self-paced",
    kind: "payment",
    status: "paid",
    stripeSessionId: "cs_test",
    stripeCustomerId: "cus_test",
    stripeSubscriptionId: null,
    ...overrides,
  };
}

describe("refundStateTransition", () => {
  it("marks a paid purchase refunded and clears enrollments", () => {
    const enrollments = [{ userId: "u1", courseId: "academy", sourcePurchaseId: "p1" }];
    const result = refundStateTransition(purchase(), enrollments);
    expect(result.changed).toBe(true);
    expect(result.before.purchase.status).toBe("paid");
    expect(result.after.purchase.status).toBe("refunded");
    expect(result.after.enrollments).toEqual([]);
  });

  it("is a no-op when already refunded", () => {
    const result = refundStateTransition(purchase({ status: "refunded" }), []);
    expect(result.changed).toBe(false);
    expect(result.after).toEqual(result.before);
  });
});
