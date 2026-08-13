import { randomUUID } from "node:crypto";
import type {
  IncomingMessage,
  OutgoingHttpHeader,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import type { RequestContext } from "@syntholo/contracts";
import type { FastifyRequest } from "fastify";
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

type WriteHeadHeaders = OutgoingHttpHeaders | OutgoingHttpHeader[];

function sanitizedWriteHeadHeaders(
  headers: WriteHeadHeaders | undefined,
  correlationId: string,
): WriteHeadHeaders | undefined {
  if (headers === undefined) return undefined;
  if (Array.isArray(headers)) {
    if (headers.length % 2 !== 0) return [...headers];
    const sanitized: OutgoingHttpHeader[] = [];
    for (let index = 0; index < headers.length; index += 2) {
      const name = headers[index];
      if (
        typeof name !== "string" ||
        name.toLowerCase() !== CORRELATION_ID_HEADER
      ) {
        sanitized.push(name);
        const value = headers[index + 1];
        if (value !== undefined) sanitized.push(value);
      }
    }
    sanitized.push(CORRELATION_ID_HEADER, correlationId);
    return sanitized;
  }

  const sanitized: OutgoingHttpHeaders = { ...headers };
  for (const name of Object.keys(sanitized)) {
    if (name.toLowerCase() === CORRELATION_ID_HEADER) {
      delete sanitized[name];
    }
  }
  sanitized[CORRELATION_ID_HEADER] = correlationId;
  return sanitized;
}

function installCorrelationHeaderGuard(
  response: ServerResponse<IncomingMessage>,
  correlationId: string,
): void {
  const originalSetHeader = response.setHeader;
  const originalWriteHead = response.writeHead;

  response.setHeader = function guardedSetHeader(name, value) {
    return originalSetHeader.call(
      this,
      name,
      name.toLowerCase() === CORRELATION_ID_HEADER ? correlationId : value,
    );
  };
  response.writeHead = function guardedWriteHead(
    this: ServerResponse<IncomingMessage>,
    statusCode: number,
    statusMessageOrHeaders?: string | WriteHeadHeaders,
    headers?: WriteHeadHeaders,
  ) {
    originalSetHeader.call(this, CORRELATION_ID_HEADER, correlationId);
    if (typeof statusMessageOrHeaders === "string") {
      if (arguments.length >= 3) {
        return Reflect.apply(originalWriteHead, this, [
          statusCode,
          statusMessageOrHeaders,
          sanitizedWriteHeadHeaders(headers, correlationId),
        ]);
      }
      return Reflect.apply(originalWriteHead, this, [
        statusCode,
        statusMessageOrHeaders,
      ]);
    }
    if (arguments.length >= 2) {
      return Reflect.apply(originalWriteHead, this, [
        statusCode,
        sanitizedWriteHeadHeaders(statusMessageOrHeaders, correlationId),
      ]);
    }
    return Reflect.apply(originalWriteHead, this, [statusCode]);
  } as typeof response.writeHead;
}

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
      installCorrelationHeaderGuard(reply.raw, correlationId);
      void reply.header(CORRELATION_ID_HEADER, correlationId);
    });
  },
  { name: "request-context" },
);
