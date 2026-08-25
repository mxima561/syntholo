import { describe, expect, it, vi } from "vitest";
import { handleStripeWebhook, MemoryWebhookReceiptStore } from "@syntholo/contracts";

describe("handleStripeWebhook", () => {
  it("rejects a missing signature", async () => {
    const result = await handleStripeWebhook("{}", null, {
      webhookSecret: "whsec_test",
      verify: vi.fn(),
      receipts: new MemoryWebhookReceiptStore(),
    });
    expect(result.status).toBe(400);
  });

  it("records a verified event once", async () => {
    const receipts = new MemoryWebhookReceiptStore();
    const verify = vi.fn().mockReturnValue({ id: "evt_123", type: "checkout.session.completed" });

    const first = await handleStripeWebhook("raw", "signature", { webhookSecret: "whsec_test", verify, receipts });
    const replay = await handleStripeWebhook("raw", "signature", { webhookSecret: "whsec_test", verify, receipts });

    expect(first).toMatchObject({ status: 200, replay: false });
    expect(replay).toMatchObject({ status: 200, replay: true });
    expect(receipts.size).toBe(1);
  });

  it("rejects a failed signature verification", async () => {
    const result = await handleStripeWebhook("raw", "bad", {
      webhookSecret: "whsec_test",
      verify: () => {
        throw new Error("Invalid signature");
      },
      receipts: new MemoryWebhookReceiptStore(),
    });
    expect(result.status).toBe(400);
  });

  it("atomically claims simultaneous deliveries", async () => {
    const receipts = new MemoryWebhookReceiptStore();
    const dependencies = {
      webhookSecret: "whsec_test",
      verify: () => ({ id: "evt_race", type: "invoice.paid" as const }),
      receipts,
    };

    const results = await Promise.all([
      handleStripeWebhook("raw", "signature", dependencies),
      handleStripeWebhook("raw", "signature", dependencies),
    ]);

    expect(results.filter((result) => result.replay)).toHaveLength(1);
    expect(receipts.size).toBe(1);
  });
});
