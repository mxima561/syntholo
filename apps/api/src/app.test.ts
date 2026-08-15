import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { ApiErrorSchema, HealthResponseSchema } from "@syntholo/contracts";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type onRouteHookHandler,
} from "fastify";
import rawBody from "fastify-raw-body";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp, type ApiDependencies } from "./app.js";
import { staffCookieNames } from "./auth/staff.js";
import { parseApiConfig } from "./config.js";
import {
  correlationIdForRequest,
  requestContextPlugin,
} from "./plugins/context.js";
import { AppError, safeErrorHandler } from "./plugins/error-handler.js";
import { startApi } from "./server.js";

const execFileAsync = promisify(execFile);
const validCorrelationId = "2c714c69-0b75-46ef-8141-739a72ec9689";
const secondCorrelationId = "b97478b2-1ef7-4aef-8b03-f89e1f80cae5";
const releaseSha = "0123456789abcdef0123456789abcdef01234567";

function productionApiEnvironment(
  patch: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const encryptionKey = Buffer.alloc(32, 5).toString("base64url");
  return {
    NODE_ENV: "production",
    MEMBER_DATABASE_URL: "postgres://member:password@example.test/db",
    STAFF_DATABASE_URL: "postgres://staff:password@example.test/db",
    SYSTEM_DATABASE_URL: "postgres://system:password@example.test/db",
    RELEASE_SHA: releaseSha,
    WEB_ORIGIN: "https://app.syntholo.test",
    CLERK_SECRET_KEY: "sk_clerk_test",
    CLERK_PUBLISHABLE_KEY: "pk_clerk_test",
    CLERK_AUDIENCE: "syntholo-member-api",
    WORKOS_API_KEY: "sk_workos_test",
    WORKOS_CLIENT_ID: "client_staff",
    WORKOS_ORGANIZATION_ID: "org_staff",
    WORKOS_ISSUER: "https://api.workos.test",
    WORKOS_JWKS_URL: "https://api.workos.test/sso/jwks/client_staff",
    STAFF_SESSION_ENCRYPTION_KEYS: `1:${encryptionKey}`,
    IMPLEMENTATION_CURSOR_SECRET: "implementation-cursor-secret-at-least-32-bytes",
    ...patch,
  };
}

function fakes(
  patch: Partial<ApiDependencies> = {},
): ApiDependencies {
  return {
    releaseSha,
    logger: false,
    health: { dependencies: [] },
    auth: { kind: "test-only-disabled" },
    ...patch,
  };
}

type RegisterTestRoutes = (
  app: FastifyInstance,
) => Promise<void> | void;

async function buildRouteTestApp(
  registerRoutes: RegisterTestRoutes,
  options: { routesBeforeContext?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId: correlationIdForRequest,
  });
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: false,
    runFirst: true,
  });
  if (options.routesBeforeContext === true) await registerRoutes(app);
  await app.register(requestContextPlugin);
  app.setErrorHandler(safeErrorHandler);
  if (options.routesBeforeContext !== true) await registerRoutes(app);
  return app;
}

function appendCorrelationHeaderOverride(
  routeOptions: Parameters<onRouteHookHandler>[0],
  value: string,
): void {
  const hooks =
    routeOptions.onSend === undefined
      ? []
      : Array.isArray(routeOptions.onSend)
        ? routeOptions.onSend
        : [routeOptions.onSend];
  routeOptions.onSend = [
    ...hooks,
    async (_request, reply, payload) => {
      void reply.header("x-correlation-id", value);
      return payload;
    },
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildApp", () => {
  it("builds without reading environment configuration or listening", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousReleaseSha = process.env.RELEASE_SHA;
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    delete process.env.RELEASE_SHA;

    try {
      const app = await buildApp(fakes());
      expect(app.server.listening).toBe(false);
      await app.close();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousReleaseSha === undefined) delete process.env.RELEASE_SHA;
      else process.env.RELEASE_SHA = previousReleaseSha;
    }
  });

  it("generates one UUID for the request id, context, header, and error envelope", async () => {
    const app = await buildRouteTestApp((instance) => {
      instance.get("/context-error", async (request) => {
        throw new AppError("CONTEXT_TEST", 409, "Safe context error", {
          requestId: request.id,
          contextId: request.context.correlationId,
        });
      });
    });

    const response = await app.inject({ method: "GET", url: "/context-error" });
    const body = ApiErrorSchema.parse(response.json());

    expect(response.statusCode).toBe(409);
    expect(body.error.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(response.headers["x-correlation-id"]).toBe(
      body.error.correlationId,
    );
    expect(body.error.details).toEqual({
      requestId: body.error.correlationId,
      contextId: body.error.correlationId,
    });

    await app.close();
  });

  it("preserves a single valid correlation id everywhere", async () => {
    const app = await buildRouteTestApp((instance) => {
      instance.get("/context", async (request) => ({
        requestId: request.id,
        contextId: request.context.correlationId,
      }));
    });

    const response = await app.inject({
      method: "GET",
      url: "/context",
      headers: { "x-correlation-id": validCorrelationId },
    });

    expect(response.headers["x-correlation-id"]).toBe(validCorrelationId);
    expect(response.json()).toEqual({
      requestId: validCorrelationId,
      contextId: validCorrelationId,
    });

    await app.close();
  });

  it("overwrites a route-level onSend header with the canonical correlation id", async () => {
    const app = await buildRouteTestApp((instance) => {
      instance.get(
        "/header-override",
        {
          onSend: async (_request, reply, payload) => {
            void reply.header(
              "x-correlation-id",
              "late-route-controlled-secret",
            );
            return payload;
          },
        },
        async () => ({ ok: true }),
      );
    });

    const response = await app.inject({
      method: "GET",
      url: "/header-override",
      headers: { "x-correlation-id": validCorrelationId },
    });

    expect(response.headers["x-correlation-id"]).toBe(validCorrelationId);
    expect(response.payload).not.toContain("late-route-controlled-secret");

    await app.close();
  });

  it.each([
    ["success", "GET", "/late-root/success", undefined, 200],
    ["AppError", "GET", "/late-root/app-error", undefined, 409],
    ["unknown error", "GET", "/late-root/unknown", undefined, 500],
    [
      "validation error",
      "POST",
      "/late-root/validation",
      { providerPayload: "validation-secret" },
      400,
    ],
  ])(
    "commits the canonical header after a later root onRoute hook on the %s path",
    async (_case, method, url, payload, expectedStatus) => {
      const app = await buildRouteTestApp((instance) => {
        instance.addHook("onRoute", (routeOptions) => {
          appendCorrelationHeaderOverride(
            routeOptions,
            "later-root-onroute-secret",
          );
        });
        instance.get("/late-root/success", async () => ({ ok: true }));
        instance.get("/late-root/app-error", async () => {
          throw new AppError("LATE_ROOT_CONFLICT", 409, "Safe conflict");
        });
        instance.get("/late-root/unknown", async () => {
          throw new Error("late-root-provider-secret");
        });
        instance.post(
          "/late-root/validation",
          {
            schema: {
              body: {
                type: "object",
                additionalProperties: false,
                required: ["name"],
                properties: { name: { type: "string", minLength: 1 } },
              },
            },
          },
          async () => ({ ok: true }),
        );
      });

      const response = await app.inject({
        method: method as "GET" | "POST",
        url,
        headers: { "x-correlation-id": validCorrelationId },
        ...(payload === undefined ? {} : { payload }),
      });

      expect(response.statusCode).toBe(expectedStatus);
      expect(response.headers["x-correlation-id"]).toBe(validCorrelationId);
      expect(response.payload).not.toContain("later-root-onroute-secret");
      if (expectedStatus >= 400) {
        expect(ApiErrorSchema.parse(response.json()).error.correlationId).toBe(
          validCorrelationId,
        );
      }

      await app.close();
    },
  );

  it("commits the canonical header after a child plugin onRoute hook", async () => {
    const app = await buildRouteTestApp(async (instance) => {
      await instance.register(async (child) => {
        child.addHook("onRoute", (routeOptions) => {
          appendCorrelationHeaderOverride(
            routeOptions,
            "child-onroute-secret",
          );
        });
        child.get("/child-header", async () => ({ ok: true }));
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/child-header",
      headers: { "x-correlation-id": validCorrelationId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBe(validCorrelationId);
    expect(response.payload).not.toContain("child-onroute-secret");

    await app.close();
  });

  it("commits the canonical header after hook arrays and ordinary reply/raw header writes", async () => {
    const app = await buildRouteTestApp((instance) => {
      instance.addHook("onRoute", (routeOptions) => {
        appendCorrelationHeaderOverride(
          routeOptions,
          "later-hook-array-secret",
        );
      });
      instance.get(
        "/header-writes",
        {
          onSend: [
            async (_request, reply, payload) => {
              void reply.header(
                "x-correlation-id",
                "reply-hook-array-secret",
              );
              return payload;
            },
            async (_request, reply, payload) => {
              reply.raw.setHeader(
                "x-correlation-id",
                "raw-hook-array-secret",
              );
              return payload;
            },
          ],
        },
        async (_request, reply) => {
          reply.raw.setHeader("x-correlation-id", "raw-handler-secret");
          void reply.header("x-correlation-id", "reply-handler-secret");
          return { ok: true };
        },
      );
    });

    const response = await app.inject({
      method: "GET",
      url: "/header-writes",
      headers: { "x-correlation-id": validCorrelationId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBe(validCorrelationId);
    expect(response.payload).not.toContain("secret");

    await app.close();
  });

  it.each([
    [
      "headers overload",
      "/raw-write-head/headers",
      202,
      "headers",
      "Accepted",
    ],
    [
      "status message overload",
      "/raw-write-head/message",
      203,
      "message",
      "Custom Status",
    ],
    [
      "raw header array overload",
      "/raw-write-head/array",
      206,
      "array",
      "Partial Content",
    ],
  ])(
    "preserves the writeHead %s while committing the canonical header",
    async (_case, url, expectedStatus, expectedMarker, expectedStatusMessage) => {
      const app = await buildRouteTestApp((instance) => {
        instance.get("/raw-write-head/headers", async (_request, reply) => {
          reply.hijack();
          reply.raw.writeHead(202, {
            "x-correlation-id": "write-head-headers-secret",
            "x-preserved": "headers",
          });
          reply.raw.end("headers-body");
          return reply;
        });
        instance.get("/raw-write-head/message", async (_request, reply) => {
          reply.hijack();
          reply.raw.writeHead(203, "Custom Status", {
            "x-correlation-id": "write-head-message-secret",
            "x-preserved": "message",
          });
          reply.raw.end("message-body");
          return reply;
        });
        instance.get("/raw-write-head/array", async (_request, reply) => {
          reply.hijack();
          reply.raw.writeHead(206, [
            "x-correlation-id",
            "write-head-array-secret",
            "x-preserved",
            "array",
          ]);
          reply.raw.end("array-body");
          return reply;
        });
      });

      const response = await app.inject({
        method: "GET",
        url,
        headers: { "x-correlation-id": validCorrelationId },
      });

      expect(response.statusCode).toBe(expectedStatus);
      expect(response.statusMessage).toBe(expectedStatusMessage);
      expect(response.headers["x-preserved"]).toBe(expectedMarker);
      expect(response.headers["x-correlation-id"]).toBe(validCorrelationId);
      expect(response.payload).toBe(`${expectedMarker}-body`);

      await app.close();
    },
  );

  it("guards a route registered before request-context plugin registration", async () => {
    const app = await buildRouteTestApp(
      (instance) => {
        instance.get(
          "/pre-context-route",
          {
            onSend: async (_request, reply, payload) => {
              void reply.header(
                "x-correlation-id",
                "pre-context-route-secret",
              );
              return payload;
            },
          },
          async () => ({ ok: true }),
        );
      },
      { routesBeforeContext: true },
    );

    const response = await app.inject({
      method: "GET",
      url: "/pre-context-route",
      headers: { "x-correlation-id": validCorrelationId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBe(validCorrelationId);
    expect(response.payload).not.toContain("pre-context-route-secret");

    await app.close();
  });

  it("seals late plugins, routes, and response hooks outside the public build boundary", async () => {
    const pluginApp = await buildApp(fakes());
    expect(() => {
      pluginApp.register(async (child) => {
        child.addHook("onSend", async (_request, _reply, payload) => payload);
      });
    }).toThrow();
    await pluginApp.close();

    const routeApp = await buildApp(fakes());
    expect(() => {
      routeApp.get("/late-route", async () => ({ ok: true }));
    }).toThrow();
    await routeApp.close();

    const hookApp = await buildApp(fakes());
    expect(() => {
      hookApp.addHook("onSend", async (_request, _reply, payload) => payload);
    }).toThrow();
    await hookApp.close();
  });

  it("prevents request id and context reassignment on a successful response", async () => {
    const app = await buildRouteTestApp((instance) => {
      instance.get("/mutate-context", async (request) => {
        const idMutationAccepted = Reflect.set(
          request,
          "id",
          "route-controlled-secret",
        );
        const contextMutationAccepted = Reflect.set(request, "context", {
          correlationId: "context-controlled-secret",
        });
        const nestedMutationAccepted = Reflect.set(
          request.context,
          "correlationId",
          "nested-controlled-secret",
        );
        return {
          idMutationAccepted,
          contextMutationAccepted,
          nestedMutationAccepted,
          requestId: request.id,
          contextId: request.context.correlationId,
        };
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/mutate-context",
      headers: { "x-correlation-id": validCorrelationId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBe(validCorrelationId);
    expect(response.json()).toEqual({
      idMutationAccepted: false,
      contextMutationAccepted: false,
      nestedMutationAccepted: false,
      requestId: validCorrelationId,
      contextId: validCorrelationId,
    });
    expect(response.payload).not.toContain("controlled-secret");

    await app.close();
  });

  it("keeps a generated canonical id through reassignment attempts and AppError", async () => {
    let originalCorrelationId: string | undefined;
    const app = await buildRouteTestApp((instance) => {
      instance.get("/mutate-context-error", async (request) => {
        originalCorrelationId = request.id;
        const idMutationAccepted = Reflect.set(
          request,
          "id",
          "route-controlled-secret",
        );
        const contextMutationAccepted = Reflect.set(request, "context", {
          correlationId: "context-controlled-secret",
        });
        const nestedMutationAccepted = Reflect.set(
          request.context,
          "correlationId",
          "nested-controlled-secret",
        );
        throw new AppError("CONTEXT_MUTATION", 409, "Safe context error", {
          idMutationAccepted,
          contextMutationAccepted,
          nestedMutationAccepted,
        });
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/mutate-context-error",
    });
    const body = ApiErrorSchema.parse(response.json());

    expect(response.statusCode).toBe(409);
    expect(originalCorrelationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(body.error.correlationId).toBe(originalCorrelationId);
    expect(response.headers["x-correlation-id"]).toBe(originalCorrelationId);
    expect(body.error.details).toEqual({
      idMutationAccepted: false,
      contextMutationAccepted: false,
      nestedMutationAccepted: false,
    });
    expect(response.payload).not.toContain("controlled-secret");

    await app.close();
  });

  it.each([
    ["malformed", "provider-secret"],
    ["comma-joined", `${validCorrelationId}, ${secondCorrelationId}`],
  ])("replaces a %s correlation id rather than reflecting it", async (_case, input) => {
    const app = await buildApp(fakes());
    const response = await app.inject({
      method: "GET",
      url: "/v1/health/live",
      headers: { "x-correlation-id": input },
    });

    expect(response.headers["x-correlation-id"]).not.toBe(input);
    expect(response.headers["x-correlation-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(response.payload).not.toContain(input);

    await app.close();
  });

  it("replaces duplicate correlation ids rather than reflecting either value", async () => {
    const app = await buildApp(fakes());
    const response = await app.inject({
      method: "GET",
      url: "/v1/health/live",
      headers: {
        "x-correlation-id": [validCorrelationId, secondCorrelationId],
      },
    });

    expect(response.headers["x-correlation-id"]).not.toBe(validCorrelationId);
    expect(response.headers["x-correlation-id"]).not.toBe(secondCorrelationId);
    expect(response.headers["x-correlation-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    await app.close();
  });

  it("serves liveness without calling readiness dependencies", async () => {
    const check = vi.fn(async () => ({ status: "ok" as const, latencyMs: 1 }));
    const app = await buildApp(
      fakes({ health: { dependencies: [{ name: "postgres", check }] } }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/v1/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(response.json())).toEqual({
      status: "ok",
      releaseSha,
      service: "api",
      dependencies: [],
    });
    expect(check).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 200 readiness when every parsed dependency is healthy", async () => {
    const app = await buildApp(
      fakes({
        health: {
          dependencies: [
            {
              name: "postgres",
              check: async () => ({ status: "ok", latencyMs: 3 }),
            },
          ],
        },
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/v1/health/ready",
    });

    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(response.json())).toEqual({
      status: "ok",
      releaseSha,
      service: "api",
      dependencies: [{ name: "postgres", status: "ok", latencyMs: 3 }],
    });

    await app.close();
  });

  it("returns parsed 503 degraded readiness without secret-shaped fields", async () => {
    const app = await buildApp(
      fakes({
        health: {
          dependencies: [
            {
              name: "postgres",
              check: async () => ({
                status: "degraded",
                latencyMs: 42,
                databaseUrl: "postgres://secret:secret@example.test/database",
                providerPayload: { password: "do-not-serialize" },
              }),
            },
          ],
        },
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/v1/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(HealthResponseSchema.parse(response.json())).toEqual({
      status: "degraded",
      releaseSha,
      service: "api",
      dependencies: [
        { name: "postgres", status: "degraded", latencyMs: 42 },
      ],
    });
    expect(response.payload).not.toContain("secret");
    expect(response.payload).not.toContain("providerPayload");

    await app.close();
  });

  it.each([
    [
      "malformed",
      async () => ({
        status: "invalid",
        latencyMs: -1,
        databaseUrl: "postgres://malformed-secret@example.test/database",
      }),
    ],
    [
      "thrown",
      async () => {
        throw new Error("readiness-provider-secret");
      },
    ],
  ])("converts %s readiness adapter output to a safe degraded summary", async (_case, check) => {
    const app = await buildApp(
      fakes({
        health: {
          dependencies: [{ name: "postgres", check }],
        },
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/v1/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(HealthResponseSchema.parse(response.json())).toEqual({
      status: "degraded",
      releaseSha,
      service: "api",
      dependencies: [
        { name: "postgres", status: "degraded", latencyMs: 0 },
      ],
    });
    expect(response.payload).not.toContain("secret");
    expect(response.payload).not.toContain("databaseUrl");

    await app.close();
  });

  it("exposes raw bodies only for routes that explicitly opt in", async () => {
    type RequestWithRawBody = FastifyRequest & { rawBody?: Buffer };
    const app = await buildRouteTestApp((instance) => {
      instance.post("/ordinary", async (request) => ({
        hasRawBody: "rawBody" in request,
      }));
      instance.post(
        "/signed",
        { config: { rawBody: true } },
        async (request) => {
          const rawBody = (request as RequestWithRawBody).rawBody;
          return {
            isBuffer: Buffer.isBuffer(rawBody),
            value: rawBody?.toString("utf8"),
          };
        },
      );
    });

    const ordinary = await app.inject({
      method: "POST",
      url: "/ordinary",
      payload: { hello: "world" },
    });
    const signed = await app.inject({
      method: "POST",
      url: "/signed",
      payload: { hello: "world" },
    });

    expect(ordinary.json()).toEqual({ hasRawBody: false });
    expect(signed.json()).toEqual({
      isBuffer: true,
      value: JSON.stringify({ hello: "world" }),
    });

    await app.close();
  });
});

describe("safe error handling", () => {
  it("serializes only explicit safe AppError fields", async () => {
    const app = await buildRouteTestApp((instance) => {
      instance.get("/safe-error", async () => {
        const error = new AppError("CONFLICT", 409, "Safe conflict", {
          field: "email",
        });
        Object.assign(error, {
          cause: new Error("provider-secret"),
          providerPayload: { apiKey: "do-not-serialize" },
        });
        throw error;
      });
    });

    const response = await app.inject({ method: "GET", url: "/safe-error" });
    const body = ApiErrorSchema.parse(response.json());

    expect(response.statusCode).toBe(409);
    expect(body.error).toMatchObject({
      code: "CONFLICT",
      message: "Safe conflict",
      details: { field: "email" },
    });
    expect(response.payload).not.toContain("provider-secret");
    expect(response.payload).not.toContain("providerPayload");
    expect(response.payload).not.toContain("stack");

    await app.close();
  });

  it.each([399, 600, 401.5, Number.NaN])(
    "rejects an invalid AppError HTTP status %s",
    (status) => {
      expect(
        () => new AppError("INVALID_STATUS", status, "Safe message"),
      ).toThrow("APP_ERROR_STATUS_INVALID");
    },
  );

  it("uses a generic envelope for unknown errors", async () => {
    const app = await buildRouteTestApp((instance) => {
      instance.get("/unknown-error", async () => {
        const error = new Error("database-password-provider-secret");
        Object.assign(error, {
          providerPayload: { token: "do-not-serialize" },
        });
        throw error;
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/unknown-error",
    });
    const body = ApiErrorSchema.parse(response.json());

    expect(response.statusCode).toBe(500);
    expect(body.error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    });
    expect(response.payload).not.toContain("database-password-provider-secret");
    expect(response.payload).not.toContain("providerPayload");
    expect(response.payload).not.toContain("stack");

    await app.close();
  });

  it("uses a generic 400 envelope for request validation errors", async () => {
    const app = await buildRouteTestApp((instance) => {
      instance.post(
        "/validated",
        {
          schema: {
            body: {
              type: "object",
              additionalProperties: false,
              required: ["name"],
              properties: { name: { type: "string", minLength: 1 } },
            },
          },
        },
        async () => ({ ok: true }),
      );
    });

    const response = await app.inject({
      method: "POST",
      url: "/validated",
      payload: { providerPayload: "validation-secret" },
    });
    const body = ApiErrorSchema.parse(response.json());

    expect(response.statusCode).toBe(400);
    expect(body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
    });
    expect(response.payload).not.toContain("providerPayload");
    expect(response.payload).not.toContain("validation-secret");

    await app.close();
  });
});

describe("API configuration and startup", () => {
  it.each([
    ["empty release", fakes({ releaseSha: "" })],
    ["whitespace release", fakes({ releaseSha: "   " })],
    ["non-string release", { ...fakes(), releaseSha: 42 }],
    ["missing health", { releaseSha: "test", logger: false }],
    [
      "non-array dependencies",
      { ...fakes(), health: { dependencies: "provider-secret" } },
    ],
    [
      "empty dependency name",
      {
        ...fakes(),
        health: {
          dependencies: [{ name: "   ", check: async () => ({}) }],
        },
      },
    ],
    [
      "non-function dependency check",
      {
        ...fakes(),
        health: {
          dependencies: [{ name: "provider-secret", check: "not-a-function" }],
        },
      },
    ],
  ])("rejects invalid injected composition: %s", async (_case, dependencies) => {
    await expect(
      buildApp(dependencies as unknown as ApiDependencies),
    ).rejects.toThrow("API_DEPENDENCIES_INVALID");
    try {
      await buildApp(dependencies as unknown as ApiDependencies);
    } catch (error) {
      expect(String(error)).not.toContain("provider-secret");
      expect(String(error)).not.toContain("not-a-function");
    }
  });

  it.each([
    ["provider level", { level: "provider-secret-level" }],
    ["invalid serializer", { serializers: { req: "provider-secret-serializer" } }],
    [
      "logger-shaped instance",
      {
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        warn: vi.fn(),
        trace: vi.fn(),
        child: vi.fn(),
      },
    ],
  ])("rejects the %s logger input with one safe composition error", async (_case, logger) => {
    const dependencies = {
      ...fakes(),
      logger,
    } as unknown as ApiDependencies;

    await expect(buildApp(dependencies)).rejects.toThrow(
      "API_DEPENDENCIES_INVALID",
    );
    try {
      await buildApp(dependencies);
    } catch (error) {
      expect(String(error)).toBe("Error: API_DEPENDENCIES_INVALID");
      expect(String(error)).not.toContain("provider-secret");
      expect(String(error)).not.toContain("FST_ERR");
    }
  });

  it.each([false, true])(
    "accepts logger=%s while serving both parsed health contracts",
    async (logger) => {
      const stdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const app = await buildApp(fakes({ logger }));

      const live = await app.inject({
        method: "GET",
        url: "/v1/health/live",
      });
      const ready = await app.inject({
        method: "GET",
        url: "/v1/health/ready",
      });

      expect(live.statusCode).toBe(200);
      expect(HealthResponseSchema.parse(live.json()).status).toBe("ok");
      expect(ready.statusCode).toBe(200);
      expect(HealthResponseSchema.parse(ready.json()).status).toBe("ok");

      await app.close();
      stdoutWrite.mockRestore();
    },
  );

  it("normalizes valid composition before both health contracts are served", async () => {
    const app = await buildApp({
      releaseSha: `  ${releaseSha}  `,
      logger: false,
      health: {
        dependencies: [
          {
            name: "  postgres  ",
            check: async () => ({ status: "ok", latencyMs: 5 }),
          },
        ],
      },
      auth: { kind: "test-only-disabled" },
    });

    const live = await app.inject({
      method: "GET",
      url: "/v1/health/live",
    });
    const ready = await app.inject({
      method: "GET",
      url: "/v1/health/ready",
    });

    expect(live.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(live.json())).toEqual({
      status: "ok",
      releaseSha,
      service: "api",
      dependencies: [],
    });
    expect(ready.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(ready.json())).toEqual({
      status: "ok",
      releaseSha,
      service: "api",
      dependencies: [{ name: "postgres", status: "ok", latencyMs: 5 }],
    });

    await app.close();
  });

  it("parses and preserves validated production startup values", () => {
    const encryptionKey = Buffer.alloc(32, 5).toString("base64url");
    expect(
      parseApiConfig({
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "4400",
        MEMBER_DATABASE_URL: "postgres://member:password@example.test/db",
        STAFF_DATABASE_URL: "postgres://staff:password@example.test/db",
        SYSTEM_DATABASE_URL: "postgres://system:password@example.test/db",
        RELEASE_SHA: `  ${releaseSha}  `,
        WEB_ORIGIN: "https://app.syntholo.test",
        CLERK_SECRET_KEY: "sk_clerk_test",
        CLERK_PUBLISHABLE_KEY: "pk_clerk_test",
        CLERK_AUDIENCE: "syntholo-member-api",
        WORKOS_API_KEY: "sk_workos_test",
        WORKOS_CLIENT_ID: "client_staff",
        WORKOS_ORGANIZATION_ID: "org_staff",
        WORKOS_ISSUER: "https://api.workos.test",
        WORKOS_JWKS_URL: "https://api.workos.test/sso/jwks/client_staff",
        STAFF_SESSION_ENCRYPTION_KEYS: `1:${encryptionKey}`,
        IMPLEMENTATION_CURSOR_SECRET: "implementation-cursor-secret-at-least-32-bytes",
      }),
    ).toEqual({
      environment: "production",
      host: "127.0.0.1",
      port: 4_400,
      memberDatabaseUrl: "postgres://member:password@example.test/db",
      staffDatabaseUrl: "postgres://staff:password@example.test/db",
      systemDatabaseUrl: "postgres://system:password@example.test/db",
      releaseSha,
      webOrigin: "https://app.syntholo.test",
      clerkSecretKey: "sk_clerk_test",
      clerkPublishableKey: "pk_clerk_test",
      clerkAudience: "syntholo-member-api",
      workosApiKey: "sk_workos_test",
      workosClientId: "client_staff",
      workosOrganizationId: "org_staff",
      workosIssuer: "https://api.workos.test",
      workosJwksUrl: "https://api.workos.test/sso/jwks/client_staff",
      sessionEncryptionKeys: `1:${encryptionKey}`,
      implementationCursorSecret: "implementation-cursor-secret-at-least-32-bytes",
      mux: { kind: "disabled" },
    });
  });

  it("keeps Mux uncomposed by default and rejects every partial provider configuration", () => {
    const base = productionApiEnvironment();
    const signingPrivateKey = `-----BEGIN PRIVATE KEY-----\n${"a".repeat(100)}\n-----END PRIVATE KEY-----`;
    const encodedSigningPrivateKey = Buffer.from(signingPrivateKey, "utf8").toString("base64");
    expect(parseApiConfig(base, releaseSha).mux).toEqual({ kind: "disabled" });
    for (const patch of [
      { MUX_CONTENT_ENABLED: "true" },
      { MUX_CONTENT_ENABLED: "true" },
      { MUX_CONTENT_ENABLED: "false", MUX_ENVIRONMENT_ID: "env_staging" },
      { MUX_WEBHOOK_SECRET: "mux-webhook-secret-value" },
    ]) expect(() => parseApiConfig({ ...base, ...patch }, releaseSha))
      .toThrow("API_CONFIG_INVALID");

    expect(parseApiConfig({
      ...base,
      MUX_CONTENT_ENABLED: "true",
      SYSTEM_DATABASE_URL: "postgres://system:password@example.test/db",
      MUX_ENVIRONMENT_ID: "env_staging",
      MUX_WEBHOOK_SECRET: "mux-webhook-secret-value",
      MUX_SIGNING_KEY_ID: "mux-signing-key-1",
      MUX_SIGNING_PRIVATE_KEY: signingPrivateKey,
    }, releaseSha).mux).toEqual({
      kind: "configured",
      environmentId: "env_staging",
      webhookSecret: "mux-webhook-secret-value",
      signingKeyId: "mux-signing-key-1",
      signingPrivateKey,
    });
    expect(parseApiConfig({
      ...base,
      MUX_CONTENT_ENABLED: "true",
      MUX_ENVIRONMENT_ID: "env_staging",
      MUX_WEBHOOK_SECRET: "mux-webhook-secret",
      MUX_SIGNING_KEY_ID: "mux-signing-key",
      MUX_SIGNING_PRIVATE_KEY: encodedSigningPrivateKey,
    }, releaseSha).mux).toMatchObject({ signingPrivateKey });
  });

  it("binds certificate Blob activation to an independent deployment environment and cursor secret", () => {
    const base = productionApiEnvironment();
    const configured = {
      CERTIFICATE_BLOB_ENABLED: "true",
      DEPLOYMENT_ENVIRONMENT: "staging",
      CERTIFICATE_BLOB_ENVIRONMENT: "staging",
      CERTIFICATE_BLOB_TOKEN: `vercel_blob_rw_stagingstore_${"a".repeat(32)}`,
      CERTIFICATE_BLOB_STAGING_STORE_ID: "stagingstore",
      CERTIFICATE_BLOB_PRODUCTION_STORE_ID: "productionstore",
      CERTIFICATE_CURSOR_SECRET: "certificate-cursor-secret-at-least-32-bytes",
    };
    expect(parseApiConfig({ ...base, ...configured }, releaseSha).certificateBlob).toEqual({
      enabled: true,
      environment: "staging",
      token: configured.CERTIFICATE_BLOB_TOKEN,
      storeIds: { staging: "stagingstore", production: "productionstore" },
      operationTimeoutMs: 15_000,
      cursorSecret: "certificate-cursor-secret-at-least-32-bytes",
    });
    for (const patch of [
      { ...configured, DEPLOYMENT_ENVIRONMENT: "production" },
      { ...configured, CERTIFICATE_CURSOR_SECRET: "short" },
      { ...configured, CERTIFICATE_BLOB_PRODUCTION_STORE_ID: "stagingstore" },
      { CERTIFICATE_BLOB_ENABLED: "true" },
      { CERTIFICATE_BLOB_ENABLED: "false", CERTIFICATE_BLOB_ENVIRONMENT: "staging" },
    ]) expect(() => parseApiConfig({ ...base, ...patch }, releaseSha)).toThrow("API_CONFIG_INVALID");
  });

  it("requires explicit production mode before selecting release staff cookies", () => {
    const environment = productionApiEnvironment({ NODE_ENV: undefined });
    expect(() => parseApiConfig(environment, releaseSha))
      .toThrow("API_CONFIG_INVALID");

    const config = parseApiConfig(productionApiEnvironment(), releaseSha);
    expect(staffCookieNames(config.environment)).toEqual({
      login: "__Host-syntholo_staff_login",
      session: "__Host-syntholo_staff_session",
    });
  });

  it("rejects malformed or artifact-mismatched immutable releases", () => {
    const encryptionKey = Buffer.alloc(32, 5).toString("base64url");
    const environment = {
      NODE_ENV: "production",
      MEMBER_DATABASE_URL: "postgres://member:password@example.test/db",
      STAFF_DATABASE_URL: "postgres://staff:password@example.test/db",
      WEB_ORIGIN: "https://app.syntholo.test",
      CLERK_SECRET_KEY: "sk_clerk_test",
      CLERK_PUBLISHABLE_KEY: "pk_clerk_test",
      CLERK_AUDIENCE: "syntholo-member-api",
      WORKOS_API_KEY: "sk_workos_test",
      WORKOS_CLIENT_ID: "client_staff",
      WORKOS_ORGANIZATION_ID: "org_staff",
      WORKOS_ISSUER: "https://api.workos.test",
      WORKOS_JWKS_URL: "https://api.workos.test/sso/jwks/client_staff",
      STAFF_SESSION_ENCRYPTION_KEYS: `1:${encryptionKey}`,
      IMPLEMENTATION_CURSOR_SECRET: "implementation-cursor-secret-at-least-32-bytes",
    };

    expect(() => parseApiConfig({ ...environment, RELEASE_SHA: "ABC" }, releaseSha))
      .toThrow("API_CONFIG_INVALID");
    expect(() => parseApiConfig({
      ...environment,
      RELEASE_SHA: "1123456789abcdef0123456789abcdef01234567",
    }, releaseSha)).toThrow("API_CONFIG_INVALID");
  });

  it("rejects a missing or weak implementation cursor signing secret", () => {
    expect(() => parseApiConfig(productionApiEnvironment({
      IMPLEMENTATION_CURSOR_SECRET: undefined,
    }), releaseSha)).toThrow("API_CONFIG_INVALID");
    expect(() => parseApiConfig(productionApiEnvironment({
      IMPLEMENTATION_CURSOR_SECRET: "too-short",
    }), releaseSha)).toThrow("API_CONFIG_INVALID");
  });

  it.each([
    [{ NODE_ENV: "production", RELEASE_SHA: "release" }],
    [{ NODE_ENV: "production", MEMBER_DATABASE_URL: "postgres://user:secret@example.test/db" }],
  ])("fails production configuration closed without required values", (environment) => {
    const serializedEnvironment = JSON.stringify(environment);
    expect(() => parseApiConfig(environment)).toThrow("API_CONFIG_INVALID");
    try {
      parseApiConfig(environment);
    } catch (error) {
      expect(String(error)).not.toContain(serializedEnvironment);
      expect(String(error)).not.toContain("secret");
    }
  });

  it("validates configuration before building or listening", async () => {
    const build = vi.fn();
    const listen = vi.fn();

    await expect(
      startApi({
        env: { NODE_ENV: "production" },
        build,
        listen,
      }),
    ).rejects.toThrow("API_CONFIG_INVALID");
    expect(build).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });
});

describe("compiled API artifact", () => {
  beforeAll(async () => {
    await execFileAsync("npm", ["run", "build"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, NODE_ENV: "production", RELEASE_SHA: releaseSha },
    });
  });

  it("produces executable Node.js and fails production startup closed", async () => {
    const artifact = new URL("../dist/server.js", import.meta.url);
    await expect(access(artifact)).resolves.toBeUndefined();
    await expect(readFile(artifact, "utf8")).resolves.toContain(releaseSha);
    await expect(
      execFileAsync(process.execPath, [artifact.pathname], {
        env: { NODE_ENV: "production", PATH: process.env.PATH },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: "API_STARTUP_FAILED\n",
    });
  });

  it("refuses to build a release artifact without explicit production mode", async () => {
    await expect(execFileAsync("npm", ["run", "build"], {
      cwd: new URL("..", import.meta.url),
      env: { PATH: process.env.PATH, RELEASE_SHA: releaseSha },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining("API_BUILD_MODE_INVALID"),
    });
  });
});
