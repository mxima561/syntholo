import {
  applyPurchaseRefund,
  loadPurchaseRefundSnapshot,
  writeAdminAudit,
  type RefundResult,
} from "@syntholo/db";

export async function performAuditedRefund(input: {
  purchaseId: string;
  actorStaffId: string;
  ip?: string | null;
  userAgent?: string | null;
  stripeRefund?: (stripeSessionId: string) => Promise<void>;
}): Promise<{ audited: boolean; result: RefundResult | null }> {
  const snapshot = await loadPurchaseRefundSnapshot(input.purchaseId);
  if (!snapshot) return { audited: false, result: null };
  if (snapshot.purchase.status === "paid" && input.stripeRefund) {
    await input.stripeRefund(snapshot.purchase.stripeSessionId);
  }
  const result = await applyPurchaseRefund(input.purchaseId);
  if (!result?.changed) return { audited: false, result };
  await writeAdminAudit({
    actorStaffId: input.actorStaffId,
    action: "refund",
    targetType: "purchase",
    targetId: input.purchaseId,
    before: result.before,
    after: result.after,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return { audited: true, result };
}
