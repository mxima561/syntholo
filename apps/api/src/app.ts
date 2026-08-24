import Fastify from "fastify";
import { handleStripeWebhook } from "@syntholo/contracts";
import { healthPayload } from "@syntholo/contracts";

export function buildApi() {
  const app = Fastify({ logger: false });
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });
  app.get("/health", async () => healthPayload("api"));

  app.post("/webhooks/stripe", async (request, reply) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
    const stripeSecret = process.env.STRIPE_SECRET_KEY?.trim();
    if (!webhookSecret || !stripeSecret) {
      return reply.code(503).send({ ok: false, error: "Stripe webhook is not configured." });
    }
    const rawBody = typeof request.body === "string" ? request.body : "";
    const signatureHeader = request.headers["stripe-signature"];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader ?? null;

    const [{ dispatchStripeEvent, PgWebhookReceiptStore }, stripeModule] = await Promise.all([
      import("@syntholo/db"),
      import("stripe"),
    ]);
    const Stripe = stripeModule.default;
    const stripe = new Stripe(stripeSecret);
    const result = await handleStripeWebhook(rawBody, signature, {
      webhookSecret,
      verify: (body, sig, secret) => stripe.webhooks.constructEvent(body, sig, secret),
      receipts: new PgWebhookReceiptStore(),
      onEvent: dispatchStripeEvent,
    });
    return reply.code(result.status).send({
      ok: result.status === 200,
      replay: result.replay,
      eventId: result.eventId,
      error: result.error,
    });
  });

  return app;
}
