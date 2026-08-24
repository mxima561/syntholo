import { ensureAccountForUser } from "./accounts";
import { refundGrantsForPurchase, revokeEntitlementGrants, upsertEntitlementGrant } from "./entitlements";
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
  const snapshot = await loadPurchaseRefundSnapshot(purchaseId);
  if (!snapshot) return null;
  const transition = refundStateTransition(snapshot.purchase, snapshot.enrollments);
  if (!transition.changed) return transition;

  await withStaffScope(async (db) => {
    await db`UPDATE purchases SET status = 'refunded' WHERE id = ${purchaseId}`;
    await db`DELETE FROM enrollments WHERE source_purchase_id = ${purchaseId}`;
    await refundGrantsForPurchase(purchaseId, db);
  });
  return transition;
}

export async function listPaidPurchases(limit = 50): Promise<PurchaseSnapshot[]> {
  return withStaffScope(async (db) => {
    const rows = await db`
      SELECT * FROM purchases ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(mapPurchase);
  });
}

export async function grantCourseEntitlement(userId: string, courseId: string): Promise<void> {
  await withStaffScope(async (db) => {
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
  });
}

export async function revokeCourseEntitlement(userId: string, courseId: string): Promise<void> {
  await withStaffScope(async (db) => {
    const membership = await ensureAccountForUser(userId, {}, db);
    await db`DELETE FROM enrollments WHERE user_id = ${userId} AND course_id = ${courseId}`;
    await revokeEntitlementGrants(membership.accountId, "academy_course", db);
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
