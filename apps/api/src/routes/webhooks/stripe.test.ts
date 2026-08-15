import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createConnection } from "node:net";
import { buildApp, type ApiDependencies } from "../../app.js";
import { createStripeWebhookHandler } from "../../modules/stripe-webhook.js";

const releaseSha = "0123456789abcdef0123456789abcdef01234567";

function dependencies(handler: ReturnType<typeof vi.fn>): ApiDependencies {
  return {
    releaseSha,
    logger: false,
    health: { dependencies: [] },
    auth: { kind: "test-only-disabled" },
    stripe: {
      kind: "enabled",
      handler,
      provider: {
        createCheckout: vi.fn(),
        createBillingPortal: vi.fn(),
      },
    },
  } as unknown as ApiDependencies;
}

describe("POST /v1/webhooks/stripe", () => {
  it("verifies the exact route bytes and rejects malformed, stale, and mutated signed input", async () => {
    const now = new Date("2026-08-15T17:00:01.000Z");
    const timestamp = Math.floor(now.getTime() / 1_000);
    const secret = "syntholo_test_fake_webhook_current";
    const raw = Buffer.from(JSON.stringify({
      id: "evt_signed_route_1",
      object: "event",
      api_version: "2026-06-24.dahlia",
      created: timestamp,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: "invoice.paid",
      data: { object: { id: "in_route_1", object: "invoice" } },
    }));
    const signed = (body: Buffer, at: number) => `t=${at},v1=${createHmac("sha256", secret)
      .update(`${at}.`).update(body).digest("hex")}`;
    const record = vi.fn(async () => Object.freeze({
      replayed: false,
      receiptId: "17b0cf20-fb31-4d7b-9320-05661897c7f2",
      status: "received" as const,
    }));
    const handler = createStripeWebhookHandler({
      binding: {
        receiverAccountId: "acct_test_syntholo",
        expectedLivemode: false,
        expectedApiVersion: "2026-06-24.dahlia",
        expectedEventAccount: null,
        expectedEventContext: null,
      },
      clock: { now: () => now },
      endpointSecrets: [{ keyId: "stripe-webhook-current", secret }],
      record,
    });
    const app = await buildApp(dependencies(vi.fn(handler)));
    const send = (body: Buffer, signature: string) => app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: body,
    });

    await expect(send(raw, signed(raw, timestamp))).resolves.toMatchObject({ statusCode: 200 });
    const malformed = Buffer.from("{not-json}");
    await expect(send(malformed, signed(malformed, timestamp)))
      .resolves.toMatchObject({ statusCode: 400 });
    await expect(send(Buffer.concat([raw, Buffer.from(" ")]), signed(raw, timestamp)))
      .resolves.toMatchObject({ statusCode: 400 });
    await expect(send(raw, signed(raw, timestamp - 301)))
      .resolves.toMatchObject({ statusCode: 400 });
    await expect(send(Buffer.alloc(0), signed(Buffer.alloc(0), timestamp)))
      .resolves.toMatchObject({ statusCode: 400 });
    expect(record).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("registers only the exact raw-body POST route and returns the strict receipt", async () => {
    const handler = vi.fn(async () => Object.freeze({ received: true as const }));
    const composed = dependencies(handler);
    const app = await buildApp(composed);
    const raw = '{"id":"evt_signed_1"}';

    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1786813200,v1=signature",
      },
      payload: raw,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: response.headers["x-correlation-id"],
      rawBody: Buffer.from(raw),
      signature: "t=1786813200,v1=signature",
    }));
    if (composed.stripe?.kind === "enabled") {
      expect(composed.stripe.provider.createCheckout).not.toHaveBeenCalled();
      expect(composed.stripe.provider.createBillingPortal).not.toHaveBeenCalled();
    }
    await expect(app.inject({ method: "GET", url: "/v1/webhooks/stripe" }))
      .resolves.toMatchObject({ statusCode: 404 });
    await expect(app.inject({ method: "HEAD", url: "/v1/webhooks/stripe" }))
      .resolves.toMatchObject({ statusCode: 404 });
    await expect(app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe?account=attacker",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1786813200,v1=signature",
      },
      payload: raw,
    })).resolves.toMatchObject({ statusCode: 400 });
    await app.close();
  });

  it("rejects duplicate signature headers and oversized bodies before the handler", async () => {
    const handler = vi.fn(async () => Object.freeze({ received: true as const }));
    const app = await buildApp(dependencies(handler));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("test server address unavailable");
    const duplicate = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: address.port });
      let response = "";
      socket.setEncoding("utf8");
      socket.once("error", reject);
      socket.on("data", (chunk) => { response += chunk; });
      socket.once("end", () => resolve(response));
      socket.once("connect", () => {
        socket.end([
          "POST /v1/webhooks/stripe HTTP/1.1",
          `Host: 127.0.0.1:${address.port}`,
          "Content-Type: application/json",
          "Content-Length: 2",
          "Stripe-Signature: t=1,v1=first",
          "Stripe-Signature: t=1,v1=second",
          "Connection: close",
          "",
          "{}",
        ].join("\r\n"));
      });
    });
    expect(duplicate).toMatch(/^HTTP\/1\.1 400 /u);
    expect(duplicate).toContain('"code":"WEBHOOK_SIGNATURE_INVALID"');

    const oversized = await app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1,v1=signature",
      },
      payload: Buffer.alloc(1_048_577, 0x61),
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.headers["cache-control"]).toBe("no-store");
    expect(oversized.json()).toMatchObject({ error: { code: "WEBHOOK_SIGNATURE_INVALID" } });

    const missingSignature = await app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(missingSignature.statusCode).toBe(400);
    expect(missingSignature.json()).toMatchObject({ error: { code: "WEBHOOK_SIGNATURE_INVALID" } });

    const unsupportedMedia = await app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "stripe-signature": "t=1,v1=signature" },
      payload: "{}",
    });
    expect(unsupportedMedia.statusCode).toBe(400);
    expect(unsupportedMedia.json()).toMatchObject({ error: { code: "WEBHOOK_SIGNATURE_INVALID" } });
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it("aborts a pending handler when the client disconnects before the receipt starts", async () => {
    let startedResolve!: () => void;
    let abortedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const aborted = new Promise<void>((resolve) => { abortedResolve = resolve; });
    const handler = vi.fn(({ signal }: Readonly<{ signal: AbortSignal }>) => {
      startedResolve();
      return new Promise<Readonly<{ received: true }>>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortedResolve();
          reject(new Error("COMMERCE_PROVIDER_EVENT_RETRYABLE"));
        }, { once: true });
      });
    });
    const app = await buildApp(dependencies(handler));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("test server address unavailable");
    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write([
      "POST /v1/webhooks/stripe HTTP/1.1",
      `Host: 127.0.0.1:${address.port}`,
      "Content-Type: application/json",
      "Content-Length: 2",
      "Stripe-Signature: t=1,v1=signature",
      "",
      "{}",
    ].join("\r\n"));
    await started;
    socket.destroy();
    await expect(aborted).resolves.toBeUndefined();
    await app.close();
  });

  it("maps signature and retryable failures without leaking their cause", async () => {
    const signature = vi.fn(async () => { throw new Error("WEBHOOK_SIGNATURE_INVALID"); });
    const signatureApp = await buildApp(dependencies(signature));
    const invalid = await signatureApp.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "stripe-signature": "invalid", "content-type": "application/json" },
      payload: "{}",
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "WEBHOOK_SIGNATURE_INVALID" } });
    expect(invalid.headers["cache-control"]).toBe("no-store");
    await signatureApp.close();

    const retryable = vi.fn(async () => { throw new Error("COMMERCE_PROVIDER_EVENT_RETRYABLE"); });
    const retryableApp = await buildApp(dependencies(retryable));
    const unavailable = await retryableApp.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "stripe-signature": "t=1786813200,v1=signature", "content-type": "application/json" },
      payload: "{}",
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.headers["retry-after"]).toBe("1");
    expect(unavailable.json()).toMatchObject({ error: { code: "DEPENDENCY_UNAVAILABLE" } });
    expect(unavailable.body).not.toContain("COMMERCE_PROVIDER_EVENT_RETRYABLE");
    await retryableApp.close();
  });
});
