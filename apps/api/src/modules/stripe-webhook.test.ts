import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

async function loadModule() {
  return import("./stripe-webhook.js").catch(() => null);
}

const envelope = Object.freeze({
  eventId: "evt_signed_1",
  eventType: "checkout.session.completed",
  knownEvent: true,
  objectTypeValid: false,
  livemode: false,
  apiVersion: "2026-06-24.dahlia" as const,
  providerCreatedAt: "2026-08-15T17:00:00.000Z",
  dataObjectType: "invoice",
  dataObjectId: "in_mismatch_1",
  receiverAccountId: "acct_test_syntholo",
  eventAccount: null,
  eventContext: null,
  rawBodySha256: "a".repeat(64),
});

describe("Stripe webhook handler", () => {
  it("uses the official raw-byte verifier with current and previous rotation secrets", async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (module === null) return;
    const now = new Date("2026-08-15T17:00:01.000Z");
    const timestamp = Math.floor(now.getTime() / 1_000);
    const rawBody = Buffer.from(JSON.stringify({
      id: "evt_signed_1",
      object: "event",
      api_version: null,
      created: timestamp,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: "invoice.paid",
      data: { object: { id: "in_mismatch_1", object: "customer" } },
    }));
    const previousSecret = "syntholo_test_fake_webhook_previous";
    const signature = `t=${timestamp},v1=${createHmac("sha256", previousSecret)
      .update(`${timestamp}.`).update(rawBody).digest("hex")}`;
    const record = vi.fn(async () => Object.freeze({
      replayed: false,
      receiptId: "17b0cf20-fb31-4d7b-9320-05661897c7f2",
      status: "failed_terminal" as const,
    }));
    const handler = module.createStripeWebhookHandler({
      binding: {
        receiverAccountId: "acct_test_syntholo",
        expectedLivemode: false,
        expectedApiVersion: "2026-06-24.dahlia",
        expectedEventAccount: null,
        expectedEventContext: null,
      },
      clock: { now: () => now },
      endpointSecrets: [
        { keyId: "stripe-webhook-current", secret: "syntholo_test_fake_webhook_current" },
        { keyId: "stripe-webhook-previous", secret: previousSecret },
      ],
      record,
    });

    await expect(handler({
      correlationId: "9a0fbc9a-0c50-4a9d-8598-370671a2f876",
      rawBody,
      signal: new AbortController().signal,
      signature,
    })).resolves.toEqual({ received: true });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      eventObjectValid: false,
      signal: expect.any(AbortSignal),
      envelope: expect.objectContaining({
        apiVersion: null,
        dataObjectType: "customer",
        objectTypeValid: false,
      }),
    }));
  });

  it("persists the trusted verifier classification without retaining raw authority", async () => {
    const module = await loadModule();
    expect(module, "Stripe webhook handler module must exist").not.toBeNull();
    if (module === null) return;

    const rawBody = Buffer.from('{"id":"evt_signed_1"}');
    const verify = vi.fn(() => Object.freeze({
      status: "terminal_event_mismatch" as const,
      verifiedWithKeyId: "stripe-webhook-current",
      envelope,
    }));
    const record = vi.fn(async () => Object.freeze({
      replayed: false,
      receiptId: "17b0cf20-fb31-4d7b-9320-05661897c7f2",
      status: "failed_terminal" as const,
    }));
    const handler = module.createStripeWebhookHandler({
      binding: Object.freeze({
        receiverAccountId: "acct_test_syntholo",
        expectedLivemode: false,
        expectedApiVersion: "2026-06-24.dahlia",
        expectedEventAccount: null,
        expectedEventContext: null,
      }),
      clock: Object.freeze({ now: () => new Date("2026-08-15T17:00:01.000Z") }),
      endpointSecrets: Object.freeze([
        Object.freeze({ keyId: "stripe-webhook-current", secret: "syntholo_test_fake_webhook_current" }),
      ]),
      record,
      verify,
    });

    await expect(handler({
      correlationId: "9a0fbc9a-0c50-4a9d-8598-370671a2f876",
      rawBody,
      signal: new AbortController().signal,
      signature: "t=1786813200,v1=signature",
    })).resolves.toEqual({ received: true });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ rawBody }));
    expect(record).toHaveBeenCalledWith({
      correlationId: "9a0fbc9a-0c50-4a9d-8598-370671a2f876",
      envelope,
      eventObjectValid: false,
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain(rawBody.toString("utf8"));
    expect(JSON.stringify(record.mock.calls)).not.toContain("syntholo_test_fake_webhook_current");
  });

  it("returns retryable only after the receipt command reports durable retry state", async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (module === null) return;
    const verify = vi.fn(() => Object.freeze({
      status: "accepted" as const,
      verifiedWithKeyId: "stripe-webhook-current",
      envelope: Object.freeze({ ...envelope, objectTypeValid: true }),
    }));
    const record = vi.fn(async () => Object.freeze({
      replayed: true,
      receiptId: "17b0cf20-fb31-4d7b-9320-05661897c7f2",
      status: "failed_retryable" as const,
    }));
    const handler = module.createStripeWebhookHandler({
      binding: {
        receiverAccountId: "acct_test_syntholo",
        expectedLivemode: false,
        expectedApiVersion: "2026-06-24.dahlia",
        expectedEventAccount: null,
        expectedEventContext: null,
      },
      clock: { now: () => new Date("2026-08-15T17:00:01.000Z") },
      endpointSecrets: [{ keyId: "stripe-webhook-current", secret: "syntholo_test_fake_webhook_current" }],
      record,
      verify,
    });
    await expect(handler({
      correlationId: "9a0fbc9a-0c50-4a9d-8598-370671a2f876",
      rawBody: Buffer.from("{}"),
      signal: new AbortController().signal,
      signature: "t=1786813200,v1=signature",
    })).rejects.toThrow("COMMERCE_PROVIDER_EVENT_RETRYABLE");
  });

  it("does not verify or start a receipt transaction after request cancellation", async () => {
    const module = await loadModule();
    expect(module).not.toBeNull();
    if (module === null) return;
    const verify = vi.fn();
    const record = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const handler = module.createStripeWebhookHandler({
      binding: {
        receiverAccountId: "acct_test_syntholo",
        expectedLivemode: false,
        expectedApiVersion: "2026-06-24.dahlia",
        expectedEventAccount: null,
        expectedEventContext: null,
      },
      clock: { now: () => new Date("2026-08-15T17:00:01.000Z") },
      endpointSecrets: [{ keyId: "stripe-webhook-current", secret: "syntholo_test_fake_webhook_current" }],
      record,
      verify,
    });
    await expect(handler({
      correlationId: "9a0fbc9a-0c50-4a9d-8598-370671a2f876",
      rawBody: Buffer.from("{}"),
      signal: controller.signal,
      signature: "t=1786813200,v1=signature",
    })).rejects.toThrow("COMMERCE_PROVIDER_EVENT_RETRYABLE");
    expect(verify).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
