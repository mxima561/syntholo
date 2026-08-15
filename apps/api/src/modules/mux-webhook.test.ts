import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMuxWebhookHandler } from "./mux-webhook.js";
import { buildApp } from "../app.js";

const secret = "test_mux_webhook_secret_which_never_leaves_the_test";
const now = new Date("2026-08-14T18:00:00.000Z");
const rawBody = Buffer.from(JSON.stringify({
  id: "evt_123",
  type: "video.asset.ready",
  object: { type: "asset", id: "asset_123" },
  environment: { id: "env_staging" },
  created_at: "2026-08-14T17:59:30.000Z",
  data: {
    id: "asset_123",
    status: "ready",
    duration: 480,
    aspect_ratio: "16:9",
    playback_ids: [{ id: "playback_123", policy: "signed" }],
  },
}));

function signature(): string {
  const timestamp = Math.floor(now.getTime() / 1_000) - 30;
  return `t=${timestamp},v1=${createHmac("sha256", secret)
    .update(`${timestamp}.`).update(rawBody).digest("hex")}`;
}

describe("Mux webhook API module boundary", () => {
  it("requires raw bytes, verifies them, then applies only the normalized event", async () => {
    const apply = vi.fn(async () => ({
      outcome: "applied" as const,
      mediaAssetId: "10000000-0000-4000-8000-000000000001",
      assetRevision: 1,
      trackRevision: null,
    }));
    const handler = createMuxWebhookHandler({
      actorId: "mux-webhook",
      environmentId: "env_staging",
      repository: { apply },
      secret,
      clock: { now: () => now },
    });
    await expect(handler({
      correlationId: "40000000-0000-4000-8000-000000000001",
      rawBody,
      signature: signature(),
    })).resolves.toEqual({ received: true });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "mux-webhook",
      correlationId: "40000000-0000-4000-8000-000000000001",
      expectedEnvironmentId: "env_staging",
      event: expect.objectContaining({ eventId: "evt_123", type: "video.asset.ready" }),
    }));
    expect(JSON.stringify(apply.mock.calls)).not.toContain("playback_ids");
  });

  it("registers the raw-body route only for a fully composed Mux dependency", async () => {
    const handler = vi.fn(async () => ({ received: true as const }));
    const common = {
      releaseSha: "0123456789abcdef0123456789abcdef01234567",
      logger: false,
      health: { dependencies: [] },
      auth: { kind: "test-only-disabled" as const },
    };
    const disabled = await buildApp({ ...common, mux: { kind: "disabled" } } as never);
    expect((await disabled.inject({ method: "POST", url: "/v1/webhooks/mux", payload: {} })).statusCode)
      .toBe(404);
    await disabled.close();

    const enabled = await buildApp({
      ...common,
      mux: { kind: "enabled", handler },
    } as never);
    const response = await enabled.inject({
      method: "POST",
      url: "/v1/webhooks/mux",
      headers: { "content-type": "application/json", "mux-signature": signature() },
      payload: rawBody,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      rawBody: expect.any(Buffer),
      signature: signature(),
    }));
    await enabled.close();
  });

  it("does not touch storage without the route-scoped raw body or a valid signature", async () => {
    const apply = vi.fn();
    const handler = createMuxWebhookHandler({
      actorId: "mux-webhook",
      environmentId: "env_staging",
      repository: { apply },
      secret,
      clock: { now: () => now },
    });
    await expect(handler({
      correlationId: "40000000-0000-4000-8000-000000000001",
      rawBody: undefined,
      signature: signature(),
    })).rejects.toThrow("MUX_WEBHOOK_RAW_BODY_REQUIRED");
    await expect(handler({
      correlationId: "40000000-0000-4000-8000-000000000001",
      rawBody,
      signature: "t=1,v1=bad",
    })).rejects.toThrow("MUX_WEBHOOK_SIGNATURE_INVALID");
    expect(apply).not.toHaveBeenCalled();
  });
});
