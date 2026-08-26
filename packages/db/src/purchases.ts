import { isOfferId, offers } from "@syntholo/domain/offers";
import type { DatabaseClient } from "./client";
import { ensureAccountForUser } from "./accounts";
import { refundGrantsForPurchase, supportWindowEnd, upsertEntitlementGrant } from "./entitlements";
import { writeActivityEvent } from "./activity";
import { withSystemScope, withUserAccountScope } from "./scope";

export type PurchaseRecord = {
  id: string;
  userId: string | null;
  accountId: string | null;
  email: string;
  offer: string;
  kind: "payment" | "subscription";
  status: "paid" | "canceled" | "refunded";
  stripeSessionId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
};

function mapPurchase(row: Record<string, unknown>): PurchaseRecord {
  return {
    id: String(row.id),
    userId: row.user_id ? String(row.user_id) : null,
    accountId: row.account_id ? String(row.account_id) : null,
    email: String(row.email),
    offer: String(row.offer),
    kind: row.kind === "subscription" ? "subscription" : "payment",
    status: row.status === "canceled" ? "canceled" : row.status === "refunded" ? "refunded" : "paid",
    stripeSessionId: String(row.stripe_session_id),
    stripeCustomerId: row.stripe_customer_id ? String(row.stripe_customer_id) : null,
    stripeSubscriptionId: row.stripe_subscription_id ? String(row.stripe_subscription_id) : null,
  };
}

async function applyOfferGrants(
  db: DatabaseClient,
  input: { accountId: string; userId: string; offerId: string; purchaseId: string },
) {
  const purchaseId = input.purchaseId;
  const supportEnds = supportWindowEnd();
  if (input.offerId === "self-paced" || input.offerId === "operator-club") {
    await upsertEntitlementGrant({
      accountId: input.accountId,
      userId: input.userId,
      capability: "academy_course",
      source: "purchase",
      sourceId: purchaseId,
    }, db);
    await upsertEntitlementGrant({
      accountId: input.accountId,
      userId: input.userId,
      capability: "support",
      source: "purchase",
      sourceId: purchaseId,
      endsAt: supportEnds,
    }, db);
    await upsertEntitlementGrant({
      accountId: input.accountId,
      userId: input.userId,
      capability: "circle_write",
      source: "purchase",
      sourceId: purchaseId,
      endsAt: supportEnds,
    }, db);
  }
  if (input.offerId === "operator-club") {
    await upsertEntitlementGrant({
      accountId: input.accountId,
      userId: input.userId,
      capability: "operator_club",
      source: "purchase",
      sourceId: purchaseId,
    }, db);
  }
  if (input.offerId === "business-os") {
    await upsertEntitlementGrant({
      accountId: input.accountId,
      userId: input.userId,
      capability: "business_os",
      source: "purchase",
      sourceId: purchaseId,
    }, db);
  }
}

/**
 * Idempotent fulfillment for a completed checkout. Safe to call from both the
 * Stripe webhook and the success page — the unique stripe_session_id makes the
 * second call a no-op unless a later claim attaches a student to an unpaid row.
 */
export async function fulfillCheckout(input: {
  sessionId: string;
  email: string;
  offer: string;
  kind: "payment" | "subscription";
  customerId?: string | null;
  subscriptionId?: string | null;
  userId?: string | null;
}): Promise<{ created: boolean }> {
  if (!isOfferId(input.offer)) throw new Error(`Unknown offer: ${input.offer}`);
  const offer = offers[input.offer];
  const email = input.email.toLowerCase();

  return withSystemScope(async (db) => {
    let userId = input.userId ?? null;
    if (!userId) {
      const [existing] = await db`SELECT id FROM app_users WHERE email = ${email}`;
      userId = existing?.id ? String(existing.id) : null;
    }

    let accountId: string | null = null;
    if (userId) {
      accountId = (await ensureAccountForUser(userId, {}, db)).accountId;
    }

    const inserted = await db`
      INSERT INTO purchases (account_id, user_id, email, offer, kind, status, stripe_session_id, stripe_customer_id, stripe_subscription_id)
      VALUES (${accountId}, ${userId}, ${email}, ${offer.id}, ${offer.kind}, 'paid', ${input.sessionId}, ${input.customerId ?? null}, ${input.subscriptionId ?? null})
      ON CONFLICT (stripe_session_id) DO NOTHING
      RETURNING id
    `;

    let purchaseId: string | null = inserted[0] ? String(inserted[0].id) : null;
    let created = inserted.length > 0;

    if (!purchaseId) {
      const [existing] = await db`SELECT * FROM purchases WHERE stripe_session_id = ${input.sessionId}`;
      if (!existing) return { created: false };
      purchaseId = String(existing.id);
      if (userId && existing.user_id && String(existing.user_id) !== userId) {
        return { created: false };
      }
      if (userId && accountId && !existing.user_id) {
        await db`
          UPDATE purchases
          SET user_id = ${userId}, account_id = ${accountId}
          WHERE id = ${purchaseId} AND user_id IS NULL
        `;
        created = true;
      } else {
        return { created: false };
      }
    }

    if (userId && accountId && offer.grantsCourseId) {
      await db`
        INSERT INTO enrollments (account_id, user_id, course_id, source_purchase_id)
        VALUES (${accountId}, ${userId}, ${offer.grantsCourseId}, ${purchaseId})
        ON CONFLICT (user_id, course_id) DO NOTHING
      `;
    }
    if (userId && accountId) {
      await applyOfferGrants(db, { accountId, userId, offerId: offer.id, purchaseId });
      const { attachScorecardsForVerifiedEmail } = await import("./scorecards");
      await attachScorecardsForVerifiedEmail(email, accountId, db);
    }

    await writeActivityEvent({
      actorKind: userId ? "student" : "system",
      actorId: userId,
      actorLabel: email,
      action: "purchase_paid",
      targetType: "purchase",
      targetId: purchaseId,
      summary: `Paid ${offer.id} for ${email}`,
      metadata: { offer: offer.id, sessionId: input.sessionId },
    });
    return { created };
  });
}

export async function revokeSubscription(input: { subscriptionId: string }) {
  return withSystemScope(async (db) => {
    const [purchase] = await db`
      UPDATE purchases SET status = 'canceled' WHERE stripe_subscription_id = ${input.subscriptionId}
      RETURNING id
    `;
    if (!purchase) return false;
    await db`DELETE FROM enrollments WHERE source_purchase_id = ${purchase.id}`;
    await refundGrantsForPurchase(String(purchase.id), db);
    return true;
  });
}

/**
 * Attach paid guest checkouts (and fill missing grants) once the buyer signs in
 * with the same email. Does not move a purchase that already belongs to another user.
 */
export async function claimPaidPurchasesForUser(userId: string, email: string): Promise<number> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return 0;

  return withSystemScope(async (db) => {
    const membership = await ensureAccountForUser(userId, {}, db);
    const rows = await db`
      SELECT * FROM purchases
      WHERE status = 'paid'
        AND lower(email) = ${normalized}
        AND (user_id IS NULL OR user_id = ${userId})
    `;
    let claimed = 0;
    for (const row of rows) {
      const purchase = mapPurchase(row);
      if (!isOfferId(purchase.offer)) continue;
      const offer = offers[purchase.offer];
      if (!purchase.userId || !purchase.accountId) {
        await db`
          UPDATE purchases
          SET user_id = ${userId}, account_id = ${membership.accountId}
          WHERE id = ${purchase.id} AND (user_id IS NULL OR user_id = ${userId})
        `;
      }
      const accountId = purchase.accountId ?? membership.accountId;
      if (offer.grantsCourseId) {
        await db`
          INSERT INTO enrollments (account_id, user_id, course_id, source_purchase_id)
          VALUES (${accountId}, ${userId}, ${offer.grantsCourseId}, ${purchase.id})
          ON CONFLICT (user_id, course_id) DO NOTHING
        `;
      }
      const [existingGrant] = await db`
        SELECT id FROM entitlement_grants
        WHERE account_id = ${accountId}
          AND capability = 'academy_course'
          AND status IN ('active', 'grace')
        LIMIT 1
      `;
      await applyOfferGrants(db, {
        accountId,
        userId,
        offerId: offer.id,
        purchaseId: purchase.id,
      });
      if (!purchase.userId || !existingGrant) claimed += 1;
    }
    return claimed;
  });
}

export async function getPurchasesForUser(userId: string): Promise<PurchaseRecord[]> {
  return withUserAccountScope(userId, async (db, membership) => {
    const rows = await db`
      SELECT * FROM purchases WHERE account_id = ${membership.accountId} ORDER BY created_at DESC
    `;
    return rows.map(mapPurchase);
  });
}
