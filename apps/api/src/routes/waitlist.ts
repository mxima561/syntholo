import {
  WaitlistSubscribeRequestSchema,
  WaitlistSubscribeResponseSchema,
  normalizeWaitlistEmail,
} from "@syntholo/contracts";
import { DatabaseDependencyUnavailableError, WaitlistInputError } from "@syntholo/database";
import type { FastifyPluginAsync } from "fastify";
import { canonicalCorrelationId } from "../plugins/context.js";
import { AppError } from "../plugins/error-handler.js";

export type WaitlistPort = Readonly<{
  subscribe(input: Readonly<{
    email: string;
    source?: string;
    correlationId: string;
  }>): Promise<{
    status: "subscribed" | "already-subscribed";
    email: string;
    createdAt: string;
    source: "school";
  }>;
}>;

export type WaitlistRouteOptions = Readonly<{
  webOrigin: string;
  waitlist: WaitlistPort;
}>;

function originMatches(request: { raw: { rawHeaders: string[] } }, webOrigin: string): boolean {
  const origins: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === "origin") {
      origins.push(request.raw.rawHeaders[index + 1] ?? "");
    }
  }
  return origins.length === 1 && origins[0] === webOrigin;
}

export const waitlistRoutes: FastifyPluginAsync<WaitlistRouteOptions> = async (app, options) => {
  app.post("/waitlist", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    if (!originMatches(request, options.webOrigin)) {
      throw new AppError("CSRF_REJECTED", 403, "Request rejected");
    }
    const body = WaitlistSubscribeRequestSchema.safeParse(request.body);
    if (!body.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    if (normalizeWaitlistEmail(body.data.email) === null) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    try {
      const result = WaitlistSubscribeResponseSchema.parse(await options.waitlist.subscribe({
        email: body.data.email,
        source: body.data.source ?? "school",
        correlationId: canonicalCorrelationId(request),
      }));
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof WaitlistInputError) {
        throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
      }
      if (error instanceof DatabaseDependencyUnavailableError) {
        throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
      }
      throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
    }
  });
};
