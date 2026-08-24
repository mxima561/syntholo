import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getRuntimeEnv } from "@/lib/config/env";
import type { WebhookReceiptStore } from "@/lib/integrations/contracts";
import { PgWebhookReceiptStore } from "@/lib/db/webhook-receipts";
import { getStripeClient } from "@/lib/integrations/stripe";
import { fulfillCheckout, revokeSubscription } from "@/lib/server/purchases";
import { isOfferId } from "@/lib/domain/offers";

type VerifiedStripeEvent = {
  id: string;
  type: string;
  data?: { object?: unknown };
};
type WebhookDependencies = {
  webhookSecret: string;
  verify: (rawBody: string, signature: string, secret: string) => VerifiedStripeEvent;
  receipts: WebhookReceiptStore;
  onEvent?: (event: VerifiedStripeEvent) => Promise<void>;
};

export class MemoryWebhookReceiptStore implements WebhookReceiptStore {
  private events = new Map<string, { eventType: string; receivedAt: string }>();
  get size() { return this.events.size; }
  async claim(input: { eventId: string; eventType: string; receivedAt: string }) {
    if (this.events.has(input.eventId)) return false;
    this.events.set(input.eventId, { eventType: input.eventType, receivedAt: input.receivedAt });
    return true;
  }
}

const runtimeReceipts = new MemoryWebhookReceiptStore();
const postgresReceipts = new PgWebhookReceiptStore();

function pickReceiptStore(): WebhookReceiptStore {
  const config = getRuntimeEnv();
  if (config.databaseUrl) return postgresReceipts;
  return runtimeReceipts;
}

export async function handleCheckoutCompleted(object: Record<string, unknown>) {
  const sessionId = typeof object.id === "string" ? object.id : null;
  const offer = object.metadata && typeof (object.metadata as Record<string, unknown>).offer === "string"
    ? (object.metadata as Record<string, unknown>).offer as string
    : null;
  const email = object.customer_details && typeof (object.customer_details as Record<string, unknown>).email === "string"
    ? (object.customer_details as Record<string, unknown>).email as string
    : null;
  if (!sessionId || !offer || !isOfferId(offer) || !email) return;

  await fulfillCheckout({
    sessionId,
    email,
    offer,
    kind: object.mode === "subscription" ? "subscription" : "payment",
    customerId: typeof object.customer === "string" ? object.customer : null,
    subscriptionId: typeof object.subscription === "string" ? object.subscription : null,
    userId: typeof object.client_reference_id === "string" && object.client_reference_id ? object.client_reference_id : null,
  });
}

export async function handleSubscriptionCanceled(object: Record<string, unknown>) {
  const subscriptionId = typeof object.id === "string" ? object.id : null;
  if (!subscriptionId) return;
  await revokeSubscription({ subscriptionId });
}

/** Routes verified events to fulfillment. Errors propagate so Stripe retries. */
export async function dispatchStripeEvent(event: VerifiedStripeEvent) {
  const object = (event.data?.object ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(object);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionCanceled(object);
      break;
    case "customer.subscription.updated":
      if ((object as { status?: string }).status === "canceled") {
        await handleSubscriptionCanceled(object);
      }
      break;
    default:
      break;
  }
}

export async function handleStripeWebhook(rawBody: string, signature: string | null, dependencies: WebhookDependencies) {
  if (!signature) return { status: 400, replay: false, error: "Missing Stripe signature." };
  let event: VerifiedStripeEvent;
  try {
    event = dependencies.verify(rawBody, signature, dependencies.webhookSecret);
  } catch {
    return { status: 400, replay: false, error: "Invalid Stripe signature." };
  }
  const claimed = await dependencies.receipts.claim({ eventId: event.id, eventType: event.type, receivedAt: new Date().toISOString() });
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

export async function POST(request: Request) {
  const config = getRuntimeEnv().stripe;
  if (!config) return NextResponse.json({ ok: false, error: "Stripe webhook is not configured." }, { status: 503 });
  const rawBody = await request.text();
  const result = await handleStripeWebhook(rawBody, request.headers.get("stripe-signature"), {
    webhookSecret: config.webhookSecret,
    verify: (body, signature, secret) => getStripeClient().webhooks.constructEvent(body, signature, secret),
    receipts: pickReceiptStore(),
    onEvent: dispatchStripeEvent,
  });
  return NextResponse.json(
    { ok: result.status === 200, replay: result.replay, eventId: result.eventId, error: result.error },
    { status: result.status },
  );
}
