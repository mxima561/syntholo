import type { WebhookReceiptStore } from "@/lib/integrations/contracts";

/** Postgres-backed idempotency store so webhook fulfillment survives restarts. */
export class PgWebhookReceiptStore implements WebhookReceiptStore {
  async claim(input: { eventId: string; eventType: string; receivedAt: string }) {
    const { getReadyDb } = await import("@/lib/db/client");
    const db = await getReadyDb();
    const inserted = await db`
      INSERT INTO webhook_receipts (event_id, event_type, received_at)
      VALUES (${input.eventId}, ${input.eventType}, ${input.receivedAt})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `;
    return inserted.length > 0;
  }
}
