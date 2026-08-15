import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { canonicalCorrelationId } from "../../plugins/context.js";
import { AppError } from "../../plugins/error-handler.js";

type RawRequest = FastifyRequest & { rawBody?: Buffer };

export type StripeWebhookRouteHandler = (request: Readonly<{
  correlationId: string;
  rawBody: Buffer | undefined;
  signal: AbortSignal;
  signature: string;
}>) => Promise<Readonly<{ received: true }>>;

function oneSignatureHeader(request: FastifyRequest): string | null {
  let count = 0;
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === "stripe-signature") count += 1;
  }
  const value = request.headers["stripe-signature"];
  return count === 1 && typeof value === "string" && value.length > 0 ? value : null;
}

export const stripeWebhookRoutes: FastifyPluginAsync<Readonly<{
  handler: StripeWebhookRouteHandler;
}>> = async (app, options) => {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  app.post("/", {
    bodyLimit: 1_048_576,
    config: { rawBody: true },
    onRequest: async (_request, reply) => {
      void reply.header("cache-control", "no-store");
    },
  }, async (request, reply) => {
    if (Object.keys(request.query as object).length !== 0) {
      throw new AppError("INVALID_QUERY", 400, "Query parameters are not accepted");
    }
    const signature = oneSignatureHeader(request);
    if (signature === null) {
      throw new AppError("WEBHOOK_SIGNATURE_INVALID", 400, "Webhook signature invalid");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    if (request.raw.aborted || reply.raw.destroyed) abort();
    try {
      const result = await options.handler({
        correlationId: canonicalCorrelationId(request),
        rawBody: (request as RawRequest).rawBody,
        signal: controller.signal,
        signature,
      });
      return reply.header("cache-control", "no-store").status(200).send(result);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (["WEBHOOK_SIGNATURE_INVALID", "WEBHOOK_EVENT_INVALID"].includes(code)) {
        throw new AppError("WEBHOOK_SIGNATURE_INVALID", 400, "Webhook signature invalid");
      }
      if (code === "COMMERCE_PROVIDER_EVENT_RETRYABLE") {
        void reply.header("retry-after", "1");
        throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Webhook processing unavailable");
      }
      void reply.header("retry-after", "1");
      throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Webhook processing unavailable");
    } finally {
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abort);
    }
  });
};
