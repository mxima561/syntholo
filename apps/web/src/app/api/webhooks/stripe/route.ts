import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getRuntimeEnv } from "@/lib/config/env";
import type { WebhookReceiptStore } from "@/lib/integrations/contracts";
import { MongoWebhookReceiptStore } from "@/lib/integrations/mongodb";
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
  async claim(input: { eventId: string; eventType: string; receivedAt: string }) {
    if (this.events.has(input.eventId)) return false;
    this.events.set(input.eventId, { eventType: input.eventType, receivedAt: input.receivedAt });
    return true;
  }
}

const runtimeReceipts = new MemoryWebhookReceiptStore();
const productionReceipts = new MongoWebhookReceiptStore();

export async function handleStripeWebhook(rawBody: string, signature: string | null, dependencies: WebhookDependencies) {
  if (!signature) return { status: 400, replay: false, error: "Missing Stripe signature." };
  let event: VerifiedStripeEvent;
  try {
    event = dependencies.verify(rawBody, signature, dependencies.webhookSecret);
  } catch {
    return { status: 400, replay: false, error: "Invalid Stripe signature." };
  }
  const claimed = await dependencies.receipts.claim({ eventId: event.id, eventType: event.type, receivedAt: new Date().toISOString() });
  return { status: 200, replay: !claimed, eventId: event.id };
}

export async function POST(request: Request) {
  const config = getRuntimeEnv().stripe;
  if (!config) return NextResponse.json({ ok: false, error: "Stripe webhook is not configured." }, { status: 503 });
  const rawBody = await request.text();
  const result = await handleStripeWebhook(rawBody, request.headers.get("stripe-signature"), {
    webhookSecret: config.webhookSecret,
    verify: (body, signature, secret) => getStripeClient().webhooks.constructEvent(body, signature, secret),
    receipts: getRuntimeEnv().mode === "production" ? productionReceipts : runtimeReceipts,
  });
  return NextResponse.json({ ok: result.status === 200, replay: result.replay, eventId: result.eventId, error: result.error }, { status: result.status });
}
