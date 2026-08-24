import { NextResponse } from "next/server";
import { handleStripeWebhook, MemoryWebhookReceiptStore } from "@syntholo/contracts";
import { dispatchStripeEvent, PgWebhookReceiptStore } from "@syntholo/db";
import { getRuntimeEnv } from "@/lib/config/env";
import { getStripeClient } from "@/lib/integrations/stripe";

export { handleStripeWebhook, MemoryWebhookReceiptStore };

const runtimeReceipts = new MemoryWebhookReceiptStore();
const postgresReceipts = new PgWebhookReceiptStore();

function pickReceiptStore() {
  const config = getRuntimeEnv();
  if (config.databaseUrl) return postgresReceipts;
  return runtimeReceipts;
}

async function handleLocally(rawBody: string, signature: string | null) {
  const config = getRuntimeEnv().stripe;
  if (!config) return NextResponse.json({ ok: false, error: "Stripe webhook is not configured." }, { status: 503 });
  const result = await handleStripeWebhook(rawBody, signature, {
    webhookSecret: config.webhookSecret,
    verify: (body, sig, secret) => getStripeClient().webhooks.constructEvent(body, sig, secret),
    receipts: pickReceiptStore(),
    onEvent: dispatchStripeEvent,
  });
  return NextResponse.json(
    { ok: result.status === 200, replay: result.replay, eventId: result.eventId, error: result.error },
    { status: result.status },
  );
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  const apiUrl = process.env.API_URL?.trim();
  if (apiUrl) {
    const response = await fetch(`${apiUrl.replace(/\/$/, "")}/webhooks/stripe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature ?? "",
      },
      body: rawBody,
    });
    const payload = await response.json().catch(() => ({ ok: false, error: "API webhook proxy failed." }));
    return NextResponse.json(payload, { status: response.status });
  }
  return handleLocally(rawBody, signature);
}
