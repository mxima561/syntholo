export type PurchaseRecord = {
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

async function db() {
  const { getReadyDb } = await import("@/lib/db/client");
  return getReadyDb();
}

/**
 * Idempotent fulfillment for a completed checkout. Safe to call from both the
 * Stripe webhook and the success page — the unique stripe_session_id makes the
 * second call a no-op.
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
  const database = await db();
  const { isOfferId, offers } = await import("@/lib/domain/offers");
  if (!isOfferId(input.offer)) throw new Error(`Unknown offer: ${input.offer}`);
  const offer = offers[input.offer];

  let userId = input.userId ?? null;
  if (!userId) {
    const [existing] = await database`SELECT id FROM app_users WHERE email = ${input.email.toLowerCase()}`;
    userId = existing?.id ?? null;
  }

  const inserted = await database`
    INSERT INTO purchases (user_id, email, offer, kind, status, stripe_session_id, stripe_customer_id, stripe_subscription_id)
    VALUES (${userId}, ${input.email.toLowerCase()}, ${offer.id}, ${offer.kind}, 'paid', ${input.sessionId}, ${input.customerId ?? null}, ${input.subscriptionId ?? null})
    ON CONFLICT (stripe_session_id) DO NOTHING
    RETURNING id
  `;
  if (inserted.length === 0) return { created: false };

  if (userId && offer.grantsCourseId) {
    await database`
      INSERT INTO enrollments (user_id, course_id, source_purchase_id)
      VALUES (${userId}, ${offer.grantsCourseId}, ${inserted[0].id})
      ON CONFLICT (user_id, course_id) DO NOTHING
    `;
  }
  return { created: true };
}

/** Marks a canceled subscription and removes access it had granted. */
export async function revokeSubscription(input: { subscriptionId: string }) {
  const database = await db();
  const [purchase] = await database`
    UPDATE purchases SET status = 'canceled' WHERE stripe_subscription_id = ${input.subscriptionId}
    RETURNING id
  `;
  if (!purchase) return false;
  await database`DELETE FROM enrollments WHERE source_purchase_id = ${purchase.id}`;
  return true;
}

export async function getPurchasesForUser(userId: string): Promise<PurchaseRecord[]> {
  const database = await db();
  const rows = await database`
    SELECT id, user_id AS "userId", email, offer, kind, status,
           stripe_session_id AS "stripeSessionId", stripe_customer_id AS "stripeCustomerId",
           stripe_subscription_id AS "stripeSubscriptionId"
    FROM purchases WHERE user_id = ${userId} ORDER BY created_at DESC
  `;
  return rows.map((row) => ({
    id: String(row.id),
    userId: row.userId ? String(row.userId) : null,
    email: String(row.email),
    offer: String(row.offer),
    kind: row.kind === "subscription" ? ("subscription" as const) : ("payment" as const),
    status: row.status === "canceled" ? ("canceled" as const) : row.status === "refunded" ? ("refunded" as const) : ("paid" as const),
    stripeSessionId: String(row.stripeSessionId),
    stripeCustomerId: row.stripeCustomerId ? String(row.stripeCustomerId) : null,
    stripeSubscriptionId: row.stripeSubscriptionId ? String(row.stripeSubscriptionId) : null,
  }));
}
