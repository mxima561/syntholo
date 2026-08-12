import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getRuntimeEnv } from "@/lib/config/env";
import type { WebhookReceiptStore } from "@/lib/integrations/contracts";
import { getStripeClient } from "@/lib/integrations/stripe";

type VerifiedStripeEvent = Pick<Stripe.Event, "id" | "type">;
type WebhookDependencies = {
  webhookSecret: string;
  verify: (rawBody: string, signature: string, secret: string) => VerifiedStripeEvent;
  receipts: WebhookReceiptStore;
};

export class MemoryWebhookReceiptStore implements WebhookReceiptStore {
  private events = new Map<string, { eventType: string; receivedAt: string }>();
  get size() { return this.events.size; }
  async has(eventId: string) { return this.events.has(eventId); }
  async record(input: { eventId: string; eventType: string; receivedAt: string }) { this.events.set(input.eventId, { eventType: input.eventType, receivedAt: input.receivedAt }); }
}

const runtimeReceipts = new MemoryWebhookReceiptStore();

export async function handleStripeWebhook(rawBody: string, signature: string | null, dependencies: WebhookDependencies) {
  if (!signature) return { status: 400, replay: false, error: "Missing Stripe signature." };
  let event: VerifiedStripeEvent;
  try {
    event = dependencies.verify(rawBody, signature, dependencies.webhookSecret);
  } catch {
    return { status: 400, replay: false, error: "Invalid Stripe signature." };
  }
  if (await dependencies.receipts.has(event.id)) return { status: 200, replay: true, eventId: event.id };

  await dependencies.receipts.record({ eventId: event.id, eventType: event.type, receivedAt: new Date().toISOString() });
  return { status: 200, replay: false, eventId: event.id };
}

export async function POST(request: Request) {
  const config = getRuntimeEnv().stripe;
  if (!config) return NextResponse.json({ ok: false, error: "Stripe webhook is not configured." }, { status: 503 });
  const rawBody = await request.text();
  const result = await handleStripeWebhook(rawBody, request.headers.get("stripe-signature"), {
    webhookSecret: config.webhookSecret,
    verify: (body, signature, secret) => getStripeClient().webhooks.constructEvent(body, signature, secret),
    receipts: runtimeReceipts,
  });
  return NextResponse.json({ ok: result.status === 200, replay: result.replay, eventId: result.eventId, error: result.error }, { status: result.status });
}
