import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { RequestContext } from "@syntholo/contracts";
import fastifyPlugin from "fastify-plugin";
import { z } from "zod";

const CORRELATION_ID_HEADER = "x-correlation-id";
const CorrelationIdSchema = z.string().uuid();

declare module "fastify" {
  interface FastifyRequest {
    context: RequestContext;
  }
}

export function correlationIdForRequest(request: IncomingMessage): string {
  const values: string[] = [];

  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === CORRELATION_ID_HEADER) {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }

  if (values.length !== 1 || values[0]?.includes(",")) return randomUUID();
  const parsed = CorrelationIdSchema.safeParse(values[0]);
  return parsed.success ? parsed.data : randomUUID();
}

export const requestContextPlugin = fastifyPlugin(
  async (app) => {
    app.decorateRequest("context", null as unknown as RequestContext);
    app.addHook("onRequest", async (request, reply) => {
      request.context = Object.freeze({ correlationId: request.id });
      void reply.header(CORRELATION_ID_HEADER, request.id);
    });
    app.addHook("onSend", async (request, reply, payload) => {
      void reply.header(CORRELATION_ID_HEADER, request.id);
      return payload;
    });
  },
  { name: "request-context" },
);
