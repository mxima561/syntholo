import Fastify, { LogController, type FastifyInstance } from "fastify";
import rawBody from "fastify-raw-body";
import { z } from "zod";
import type { createStripeAdapter } from "@syntholo/integrations";
import { authRoutes } from "./auth/routes.js";
import type { AuthComposition } from "./auth/types.js";
import { correlationIdForRequest, requestContextPlugin } from "./plugins/context.js";
import { safeErrorHandler } from "./plugins/error-handler.js";
import {
  healthRoutes,
  type ReadinessDependency,
} from "./routes/health.js";
import { muxWebhookRoutes, type MuxWebhookRouteHandler } from "./routes/webhooks/mux.js";
import {
  stripeWebhookRoutes,
  type StripeWebhookRouteHandler,
} from "./routes/webhooks/stripe.js";
import { waitlistRoutes, type WaitlistPort } from "./routes/waitlist.js";

export type ApiDependencies = Readonly<{
  releaseSha: string;
  logger?: boolean;
  health: Readonly<{
    dependencies: readonly ReadinessDependency[];
  }>;
  auth: AuthComposition;
  mux?: Readonly<{ kind: "disabled" }> | Readonly<{
    kind: "enabled";
    handler: MuxWebhookRouteHandler;
  }>;
  stripe?: Readonly<{ kind: "disabled" }> | Readonly<{
    kind: "enabled";
    handler: StripeWebhookRouteHandler;
    provider: Pick<ReturnType<typeof createStripeAdapter>, "createCheckout" | "createBillingPortal">;
  }>;
  close?: () => Promise<void>;
  waitlist?: Readonly<{
    webOrigin: string;
    subscribe: WaitlistPort["subscribe"];
  }>;
}>;

const ApiDependenciesSchema = z
  .object({
    releaseSha: z.string().trim().regex(/^[0-9a-f]{40}$/u),
    logger: z.boolean().optional(),
    health: z
      .object({
        dependencies: z.array(
          z
            .object({
              name: z.string().trim().min(1),
              check: z.custom<ReadinessDependency["check"]>(
                (value) => typeof value === "function",
              ),
            })
            .strict(),
        ),
      })
      .strict(),
    auth: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("test-only-disabled") }).strict(),
      z
        .object({
          kind: z.literal("enabled"),
          dependencies: z.custom<
            Extract<AuthComposition, { kind: "enabled" }>["dependencies"]
          >((value) => typeof value === "object" && value !== null),
        })
        .strict(),
    ]),
    mux: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("disabled") }).strict(),
      z.object({
        kind: z.literal("enabled"),
        handler: z.custom<MuxWebhookRouteHandler>((value) => typeof value === "function"),
      }).strict(),
    ]).optional().default({ kind: "disabled" }),
    stripe: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("disabled") }).strict(),
      z.object({
        kind: z.literal("enabled"),
        handler: z.custom<StripeWebhookRouteHandler>((value) => typeof value === "function"),
        provider: z.object({
          createCheckout: z.custom((value) => typeof value === "function"),
          createBillingPortal: z.custom((value) => typeof value === "function"),
        }).strict(),
      }).strict(),
    ]).optional().default({ kind: "disabled" }),
    close: z.custom<() => Promise<void>>((value) => typeof value === "function").optional(),
    waitlist: z.object({
      webOrigin: z.string().trim().min(1),
      subscribe: z.custom<WaitlistPort["subscribe"]>((value) => typeof value === "function"),
    }).strict().optional(),
  })
  .strict();

export async function buildApp(
  dependencies: ApiDependencies,
): Promise<FastifyInstance> {
  const parsedDependencies = ApiDependenciesSchema.safeParse(dependencies);
  if (!parsedDependencies.success) {
    throw new Error("API_DEPENDENCIES_INVALID");
  }
  const app = Fastify({
    logger: parsedDependencies.data.logger ?? false,
    requestIdHeader: false,
    genReqId: correlationIdForRequest,
    logController: new LogController({ disableRequestLogging: true }),
  });

  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: false,
    runFirst: true,
  });
  await app.register(requestContextPlugin);
  app.setErrorHandler(safeErrorHandler);
  await app.register(healthRoutes, {
    prefix: "/v1/health",
    releaseSha: parsedDependencies.data.releaseSha,
    dependencies: parsedDependencies.data.health.dependencies,
  });
  if (parsedDependencies.data.mux.kind === "enabled") {
    await app.register(muxWebhookRoutes, {
      prefix: "/v1/webhooks/mux",
      handler: parsedDependencies.data.mux.handler,
    });
  }
  if (parsedDependencies.data.stripe.kind === "enabled") {
    await app.register(stripeWebhookRoutes, {
      prefix: "/v1/webhooks/stripe",
      handler: parsedDependencies.data.stripe.handler,
    });
  }
  if (parsedDependencies.data.waitlist !== undefined) {
    await app.register(waitlistRoutes, {
      prefix: "/v1",
      webOrigin: parsedDependencies.data.waitlist.webOrigin,
      waitlist: { subscribe: parsedDependencies.data.waitlist.subscribe },
    });
  }
  if (parsedDependencies.data.auth.kind === "enabled") {
    await app.register(authRoutes, {
      prefix: "/v1",
      ...parsedDependencies.data.auth.dependencies,
    });
  }
  if (parsedDependencies.data.close) {
    app.addHook("onClose", parsedDependencies.data.close);
  }
  // Expose only the fully composed app; Fastify rejects later plugins/routes/hooks.
  await app.ready();

  return app;
}
