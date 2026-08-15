import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { AppError } from "../../plugins/error-handler.js";
import { canonicalCorrelationId } from "../../plugins/context.js";

type RawRequest = FastifyRequest & { rawBody?: Buffer };

export type MuxWebhookRouteHandler = (request: Readonly<{
  correlationId: string;
  rawBody: Buffer | undefined;
  signature: string;
}>) => Promise<Readonly<{ received: true }>>;

export const muxWebhookRoutes: FastifyPluginAsync<Readonly<{
  handler: MuxWebhookRouteHandler;
}>> = async (app, options) => {
  app.post("/", {
    bodyLimit: 1_048_576,
    config: { rawBody: true },
  }, async (request, reply) => {
    const signature = request.headers["mux-signature"];
    if (typeof signature !== "string") {
      throw new AppError("WEBHOOK_SIGNATURE_INVALID", 400, "Webhook signature invalid");
    }
    try {
      const result = await options.handler({
        correlationId: canonicalCorrelationId(request),
        rawBody: (request as RawRequest).rawBody,
        signature,
      });
      return reply.status(200).send(result);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (["MUX_WEBHOOK_SIGNATURE_INVALID", "MUX_WEBHOOK_RAW_BODY_REQUIRED"].includes(code)) {
        throw new AppError("WEBHOOK_SIGNATURE_INVALID", 400, "Webhook signature invalid");
      }
      if (["MUX_WEBHOOK_EVENT_INVALID", "MUX_EVENT_APPLY_INVALID"].includes(code)) {
        throw new AppError("WEBHOOK_PAYLOAD_INVALID", 400, "Webhook payload invalid");
      }
      throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Webhook processing unavailable");
    }
  });
};
