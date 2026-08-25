import Fastify from "fastify";
import { CreateCheckoutInputSchema, handleStripeWebhook, healthPayload, PilotApplicationInputSchema, ScorecardLeadInputSchema } from "@syntholo/contracts";
import {
  CheckoutAuthorizationError,
  guestAccess,
  listPublicOffers,
} from "@syntholo/domain";
import { apiError, correlationIdFrom, parseJsonObject } from "./http";
import { createCheckout, type StripePort } from "./modules/commerce/create-checkout";
import { evaluateLaunchReadiness } from "./modules/content/evaluate-launch-readiness";

function publicOfferContext() {
  const { readiness } = evaluateLaunchReadiness();
  return {
    content: readiness,
    access: guestAccess(),
    businessOsReady: false,
  };
}

function liveStripePort(): StripePort {
  return {
    async createCheckoutSession(command) {
      const secret = process.env.STRIPE_SECRET_KEY?.trim();
      if (!secret) throw new Error("Stripe is not configured.");
      const stripeModule = await import("stripe");
      const Stripe = stripeModule.default;
      const stripe = new Stripe(secret);
      const session = await stripe.checkout.sessions.create(
        {
          mode: command.mode,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: command.currency,
                unit_amount: command.unitAmount,
                product_data: { name: command.productName },
                ...(command.mode === "subscription" && command.interval
                  ? { recurring: { interval: command.interval } }
                  : {}),
              },
            },
          ],
          customer_email: command.customerEmail,
          metadata: command.metadata,
          success_url: command.successUrl,
          cancel_url: command.cancelUrl,
        },
        { idempotencyKey: command.idempotencyKey },
      );
      if (!session.url) throw new Error("Stripe did not return a checkout URL.");
      return { id: session.id, url: session.url };
    },
  };
}

export function buildApi() {
  const app = Fastify({ logger: false });
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });
  app.get("/health", async () => healthPayload("api"));

  app.get("/v1/member/access", async (request, reply) => {
    const query = request.query as Record<string, unknown> | undefined;
    if (query && Object.prototype.hasOwnProperty.call(query, "accountId")) {
      return reply.code(400).send({ ok: false, error: "accountId is not accepted on this route." });
    }
    return reply.code(401).send({ ok: false, error: "Member authentication is required." });
  });

  app.get("/v1/public/offers", async () => {
    return { offers: listPublicOffers(publicOfferContext()) };
  });

  app.post("/v1/public/scorecards", async (request, reply) => {
    const correlationId = correlationIdFrom(request.headers);
    const body = parseJsonObject(request.body);
    if (!body) return reply.code(400).send(apiError("INVALID_JSON", correlationId));
    const parsed = ScorecardLeadInputSchema.safeParse(body);
    if (!parsed.success) return reply.code(400).send(apiError("INVALID_INPUT", correlationId));
    try {
      const { persistScorecardLead } = await import("@syntholo/db");
      const saved = await persistScorecardLead(parsed.data);
      return {
        ok: true,
        reportToken: saved.reportToken,
        expiresAt: saved.expiresAt.toISOString(),
        report: { overallScore: parsed.data.overallScore, band: parsed.data.band },
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("DATABASE_URL")) {
        return reply.code(503).send(apiError("ACADEMY_UNAVAILABLE", correlationId, "Academy is temporarily unavailable."));
      }
      throw error;
    }
  });

  app.get("/v1/public/scorecards/:reportToken", async (request, reply) => {
    const correlationId = correlationIdFrom(request.headers);
    const reportToken = (request.params as { reportToken?: string }).reportToken ?? "";
    if (!reportToken) return reply.code(400).send(apiError("INVALID_INPUT", correlationId));
    try {
      const { getPublicScorecardReport } = await import("@syntholo/db");
      const report = await getPublicScorecardReport(reportToken);
      if (!report) return reply.code(404).send(apiError("REPORT_NOT_FOUND", correlationId, "This report link is missing or has expired."));
      return { ok: true, report };
    } catch (error) {
      if (error instanceof Error && error.message.includes("DATABASE_URL")) {
        return reply.code(503).send(apiError("ACADEMY_UNAVAILABLE", correlationId, "Academy is temporarily unavailable."));
      }
      throw error;
    }
  });

  app.post("/v1/public/pilot-applications", async (request, reply) => {
    const correlationId = correlationIdFrom(request.headers);
    const body = parseJsonObject(request.body);
    if (!body) return reply.code(400).send(apiError("INVALID_JSON", correlationId));
    const parsed = PilotApplicationInputSchema.safeParse(body);
    if (!parsed.success) return reply.code(400).send(apiError("INVALID_INPUT", correlationId));
    try {
      const { submitPilotApplication } = await import("@syntholo/db");
      const saved = await submitPilotApplication(parsed.data);
      return { ok: true, id: saved.id, status: saved.status };
    } catch (error) {
      if (error instanceof Error && error.message.includes("DATABASE_URL")) {
        return reply.code(503).send(apiError("ACADEMY_UNAVAILABLE", correlationId, "Academy is temporarily unavailable."));
      }
      throw error;
    }
  });

  app.post("/v1/public/checkout", async (request, reply) => {
    const correlationId = correlationIdFrom(request.headers);
    const body = parseJsonObject(request.body);
    if (!body) {
      return reply.code(400).send(apiError("INVALID_JSON", correlationId));
    }
    const parsed = CreateCheckoutInputSchema.safeParse(body);
    if (!parsed.success) {
      return reply.code(400).send(apiError("INVALID_INPUT", correlationId));
    }
    const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const idempotencyHeader = request.headers["idempotency-key"];
    const idempotencyKey = typeof idempotencyHeader === "string" && idempotencyHeader.trim() ? idempotencyHeader : correlationId;
    try {
      const session = await createCheckout(
        {
          offerCode: parsed.data.offerCode,
          email: parsed.data.email,
          authorizationToken: parsed.data.authorizationToken,
          idempotencyKey,
          successUrl: `${appUrl}/claim?session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${appUrl}/pricing`,
        },
        { stripe: liveStripePort(), env: process.env },
      );
      return { ok: true, id: session.id, url: session.url };
    } catch (error) {
      if (error instanceof CheckoutAuthorizationError) {
        const status = error.code === "UNKNOWN_OFFER" ? 400 : 409;
        return reply.code(status).send(apiError(error.code, correlationId));
      }
      throw error;
    }
  });

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
