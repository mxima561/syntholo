import { describe, expect, it, vi } from "vitest";

vi.mock("@syntholo/db", () => ({
  loadPurchaseRefundSnapshot: vi.fn(),
  applyPurchaseRefund: vi.fn(),
  writeAdminAudit: vi.fn(),
}));

import { applyPurchaseRefund, loadPurchaseRefundSnapshot, writeAdminAudit } from "@syntholo/db";
import { performAuditedRefund } from "./refund-mutation";

const purchase = {
  id: "p1",
  userId: "u1",
  email: "student@example.com",
  offer: "self-paced",
  kind: "payment" as const,
  status: "paid" as const,
  stripeSessionId: "cs_test",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
};

const result = {
  changed: true,
  before: { purchase, enrollments: [{ userId: "u1", courseId: "academy", sourcePurchaseId: "p1" }] },
  after: { purchase: { ...purchase, status: "refunded" as const }, enrollments: [] },
};

describe("performAuditedRefund", () => {
  it("writes exactly one audit row with actor and before/after state", async () => {
    vi.mocked(loadPurchaseRefundSnapshot).mockResolvedValue({ purchase, enrollments: result.before.enrollments });
    vi.mocked(applyPurchaseRefund).mockResolvedValue(result);
    vi.mocked(writeAdminAudit).mockResolvedValue({
      id: "a1",
      actorStaffId: "staff-1",
      action: "refund",
      targetType: "purchase",
      targetId: "p1",
      beforeJson: result.before,
      afterJson: result.after,
      ip: null,
      userAgent: null,
      createdAt: new Date(),
    });

    const outcome = await performAuditedRefund({ purchaseId: "p1", actorStaffId: "staff-1" });

    expect(outcome.audited).toBe(true);
    expect(writeAdminAudit).toHaveBeenCalledTimes(1);
    expect(writeAdminAudit).toHaveBeenCalledWith({
      actorStaffId: "staff-1",
      action: "refund",
      targetType: "purchase",
      targetId: "p1",
      before: result.before,
      after: result.after,
      ip: undefined,
      userAgent: undefined,
    });
  });
});
