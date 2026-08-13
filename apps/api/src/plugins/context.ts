import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { RequestContext } from "@syntholo/contracts";
import type { FastifyRequest, onSendAsyncHookHandler } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { z } from "zod";

const CORRELATION_ID_HEADER = "x-correlation-id";
const CorrelationIdSchema = z.string().uuid();
const canonicalCorrelationIds = new WeakMap<FastifyRequest, string>();

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

export function canonicalCorrelationId(request: FastifyRequest): string {
  const correlationId = canonicalCorrelationIds.get(request);
  if (correlationId === undefined) throw new Error("REQUEST_CONTEXT_UNAVAILABLE");
  return correlationId;
}

const enforceCorrelationHeader: onSendAsyncHookHandler = async (
  request,
  reply,
  payload,
) => {
  void reply.header(CORRELATION_ID_HEADER, canonicalCorrelationId(request));
  return payload;
};

export const requestContextPlugin = fastifyPlugin(
  async (app) => {
    app.decorateRequest("context", null as unknown as RequestContext);
    app.addHook("onRequest", async (request, reply) => {
      const correlationId = request.id;
      const context = Object.freeze({ correlationId });
      canonicalCorrelationIds.set(request, correlationId);
      Object.defineProperties(request, {
        id: {
          configurable: false,
          enumerable: true,
          value: correlationId,
          writable: false,
        },
        context: {
          configurable: false,
          enumerable: true,
          value: context,
          writable: false,
        },
      });
      void reply.header(CORRELATION_ID_HEADER, correlationId);
    });
    app.addHook("onRoute", (routeOptions) => {
      const routeHooks =
        routeOptions.onSend === undefined
          ? []
          : Array.isArray(routeOptions.onSend)
            ? routeOptions.onSend
            : [routeOptions.onSend];
      routeOptions.onSend = [...routeHooks, enforceCorrelationHeader];
    });
  },
  { name: "request-context" },
);
