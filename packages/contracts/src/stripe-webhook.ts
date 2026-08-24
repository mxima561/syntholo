export type WebhookReceiptStore = {
  claim(input: { eventId: string; eventType: string; receivedAt: string }): Promise<boolean>;
};

export type VerifiedStripeEvent = {
  id: string;
  type: string;
  data?: { object?: unknown };
};

export type StripeWebhookDependencies = {
  webhookSecret: string;
  verify: (rawBody: string, signature: string, secret: string) => VerifiedStripeEvent;
  receipts: WebhookReceiptStore;
  onEvent?: (event: VerifiedStripeEvent) => Promise<void>;
};

export class MemoryWebhookReceiptStore implements WebhookReceiptStore {
  private events = new Map<string, { eventType: string; receivedAt: string }>();
  get size() {
    return this.events.size;
  }
  async claim(input: { eventId: string; eventType: string; receivedAt: string }) {
    if (this.events.has(input.eventId)) return false;
    this.events.set(input.eventId, { eventType: input.eventType, receivedAt: input.receivedAt });
    return true;
  }
}

export async function handleStripeWebhook(
  rawBody: string,
  signature: string | null,
  dependencies: StripeWebhookDependencies,
) {
  if (!signature) return { status: 400, replay: false, error: "Missing Stripe signature." };
  let event: VerifiedStripeEvent;
  try {
    event = dependencies.verify(rawBody, signature, dependencies.webhookSecret);
  } catch {
    return { status: 400, replay: false, error: "Invalid Stripe signature." };
  }
  const claimed = await dependencies.receipts.claim({
    eventId: event.id,
    eventType: event.type,
    receivedAt: new Date().toISOString(),
  });
  if (!claimed) return { status: 200, replay: true, eventId: event.id };
  try {
    await dependencies.onEvent?.(event);
  } catch (error) {
    return {
      status: 500,
      replay: false,
      eventId: event.id,
      error: error instanceof Error ? error.message : "Fulfillment failed.",
    };
  }
  return { status: 200, replay: false, eventId: event.id };
}
