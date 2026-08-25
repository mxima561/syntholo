import type { EffectiveAccess } from "@syntholo/domain";
import { loadEffectiveAccess } from "./access";
import { ensureAccountForUser } from "./accounts";
import { refundGrantsForPurchase, revokeEntitlementGrants, upsertEntitlementGrant } from "./entitlements";
import { appendAudit, enqueueOutbox, mutateWithEvent } from "./outbox";
import { withStaffScope } from "./scope";

export type PurchaseSnapshot = {
  id: string;
  userId: string | null;
  email: string;
  offer: string;
  kind: "payment" | "subscription";
  status: "paid" | "canceled" | "refunded";
  stripeSessionId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
};

export type EnrollmentSnapshot = {
  userId: string;
  courseId: string;
  sourcePurchaseId: string | null;
};

export type RefundResult = {
  changed: boolean;
  before: { purchase: PurchaseSnapshot; enrollments: EnrollmentSnapshot[] };
  after: { purchase: PurchaseSnapshot; enrollments: EnrollmentSnapshot[] };
};

function mapPurchase(row: Record<string, unknown>): PurchaseSnapshot {
  return {
    id: String(row.id),
    userId: row.user_id ? String(row.user_id) : null,
    email: String(row.email),
    offer: String(row.offer),
    kind: row.kind === "subscription" ? "subscription" : "payment",
    status: row.status === "canceled" ? "canceled" : row.status === "refunded" ? "refunded" : "paid",
    stripeSessionId: String(row.stripe_session_id),
    stripeCustomerId: row.stripe_customer_id ? String(row.stripe_customer_id) : null,
    stripeSubscriptionId: row.stripe_subscription_id ? String(row.stripe_subscription_id) : null,
  };
}

export function refundStateTransition(
  purchase: PurchaseSnapshot,
  enrollments: EnrollmentSnapshot[],
): RefundResult {
  const before = { purchase, enrollments };
  if (purchase.status === "refunded") {
    return { changed: false, before, after: before };
  }
  return {
    changed: true,
    before,
    after: {
      purchase: { ...purchase, status: "refunded" },
      enrollments: [],
    },
  };
}

export async function loadPurchaseRefundSnapshot(purchaseId: string): Promise<{
  purchase: PurchaseSnapshot;
  enrollments: EnrollmentSnapshot[];
} | null> {
  return withStaffScope(async (db) => {
    const [row] = await db`SELECT * FROM purchases WHERE id = ${purchaseId}`;
    if (!row) return null;
    const purchase = mapPurchase(row);
    const enrollmentRows = await db`
      SELECT user_id, course_id, source_purchase_id
      FROM enrollments WHERE source_purchase_id = ${purchaseId}
    `;
    return {
      purchase,
      enrollments: enrollmentRows.map((enrollment) => ({
        userId: String(enrollment.user_id),
        courseId: String(enrollment.course_id),
        sourcePurchaseId: enrollment.source_purchase_id ? String(enrollment.source_purchase_id) : null,
      })),
    };
  });
}

export async function applyPurchaseRefund(purchaseId: string): Promise<RefundResult | null> {
  return mutateWithEvent(async (db) => {
    const [row] = await db`SELECT * FROM purchases WHERE id = ${purchaseId}`;
    if (!row) return null;
    const purchase = mapPurchase(row);
    const enrollmentRows = await db`
      SELECT user_id, course_id, source_purchase_id
      FROM enrollments WHERE source_purchase_id = ${purchaseId}
    `;
    const enrollments = enrollmentRows.map((enrollment) => ({
      userId: String(enrollment.user_id),
      courseId: String(enrollment.course_id),
      sourcePurchaseId: enrollment.source_purchase_id ? String(enrollment.source_purchase_id) : null,
    }));
    const transition = refundStateTransition(purchase, enrollments);
    if (!transition.changed) return transition;

    await db`UPDATE purchases SET status = 'refunded' WHERE id = ${purchaseId}`;
    await db`DELETE FROM enrollments WHERE source_purchase_id = ${purchaseId}`;
    await refundGrantsForPurchase(purchaseId, db);
    await appendAudit(db, {
      actorKind: "system",
      actorId: "applyPurchaseRefund",
      action: "purchase.refunded",
      targetType: "purchase",
      targetId: purchaseId,
      payload: { offer: purchase.offer, userId: purchase.userId },
    });
    await enqueueOutbox(db, {
      eventName: "purchase.refunded.v1",
      accountId: row.account_id ? String(row.account_id) : null,
      payload: { purchaseId, offer: purchase.offer },
    });
    return transition;
  });
}

export async function listPaidPurchases(limit = 50): Promise<PurchaseSnapshot[]> {
  return withStaffScope(async (db) => {
    const rows = await db`
      SELECT * FROM purchases ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(mapPurchase);
  });
}

export async function grantCourseEntitlement(userId: string, courseId: string): Promise<EffectiveAccess> {
  return mutateWithEvent(async (db) => {
    const membership = await ensureAccountForUser(userId, {}, db);
    await db`
      INSERT INTO enrollments (account_id, user_id, course_id)
      VALUES (${membership.accountId}, ${userId}, ${courseId})
      ON CONFLICT (user_id, course_id) DO NOTHING
    `;
    await upsertEntitlementGrant(
      { accountId: membership.accountId, userId, capability: "academy_course", source: "admin" },
      db,
    );
    const access = await loadEffectiveAccess(membership.accountId, new Date(), db);
    await appendAudit(db, {
      actorKind: "system",
      actorId: "grantCourseEntitlement",
      action: "entitlement.granted",
      targetType: "account",
      targetId: membership.accountId,
      payload: { userId, courseId, capability: "academy_course" },
    });
    await enqueueOutbox(db, {
      eventName: "entitlement.granted.v1",
      accountId: membership.accountId,
      payload: { userId, courseId, capability: "academy_course" },
    });
    return access;
  });
}

export async function revokeCourseEntitlement(userId: string, courseId: string): Promise<EffectiveAccess> {
  return mutateWithEvent(async (db) => {
    const membership = await ensureAccountForUser(userId, {}, db);
    await db`DELETE FROM enrollments WHERE user_id = ${userId} AND course_id = ${courseId}`;
    await revokeEntitlementGrants(membership.accountId, "academy_course", db);
    const access = await loadEffectiveAccess(membership.accountId, new Date(), db);
    await appendAudit(db, {
      actorKind: "system",
      actorId: "revokeCourseEntitlement",
      action: "entitlement.revoked",
      targetType: "account",
      targetId: membership.accountId,
      payload: { userId, courseId, capability: "academy_course" },
    });
    await enqueueOutbox(db, {
      eventName: "entitlement.revoked.v1",
      accountId: membership.accountId,
      payload: { userId, courseId, capability: "academy_course" },
    });
    return access;
  });
}

export async function listEnrollmentsForUser(userId: string): Promise<EnrollmentSnapshot[]> {
  return withStaffScope(async (db) => {
    const rows = await db`
      SELECT user_id, course_id, source_purchase_id FROM enrollments WHERE user_id = ${userId}
    `;
    return rows.map((row) => ({
      userId: String(row.user_id),
      courseId: String(row.course_id),
      sourcePurchaseId: row.source_purchase_id ? String(row.source_purchase_id) : null,
    }));
  });
}
