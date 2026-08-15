import {
  ArtifactDetailResponseSchema,
  ArtifactListResponseSchema,
  ArtifactVersionsQuerySchema,
  ArtifactVersionsResponseSchema,
  SaveArtifactVersionRequestSchema,
  SaveArtifactVersionResponseSchema,
} from "@syntholo/contracts/implementation";
import {
  DatabaseDependencyUnavailableError,
  ImplementationRepositoryError,
} from "@syntholo/database";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import type { AuthRouteDependencies } from "../../auth/types.js";
import { requiredIdempotencyKey } from "../../http/idempotency-key.js";
import { queryIsEmpty, requestHasBody } from "../../http/request-shape.js";
import { canonicalCorrelationId } from "../../plugins/context.js";
import { AppError } from "../../plugins/error-handler.js";
import { authorizeLearningMember, learningResponseHeaders } from "./learning.js";

const ArtifactParametersSchema = z.object({ artifactId: z.string().uuid() }).strict();
export type MemberImplementationPort = NonNullable<AuthRouteDependencies["member"]["implementation"]>;

function parameters(value: unknown): Readonly<{ artifactId: string }> {
  const parsed = ArtifactParametersSchema.safeParse(value);
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
  return parsed.data;
}

function mapImplementationError(error: unknown, reply: FastifyReply): never {
  if (error instanceof DatabaseDependencyUnavailableError) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
  }
  if (error instanceof ImplementationRepositoryError) {
    switch (error.code) {
      case "IMPLEMENTATION_NOT_FOUND":
        throw new AppError("NOT_FOUND", 404, "Artifact not found");
      case "VERSION_CONFLICT":
        throw new AppError(error.code, 409, "Artifact changed; reload before saving");
      case "IDEMPOTENCY_KEY_REUSED":
        throw new AppError(error.code, 409, "Idempotency key was already used");
      case "IDEMPOTENCY_IN_PROGRESS":
        void reply.header("retry-after", "1");
        throw new AppError(error.code, 409, "This save is still in progress");
      case "INVALID_CURSOR":
      case "IMPLEMENTATION_COMMAND_INVALID":
        throw new AppError(error.code, 400, "Request validation failed");
      case "IMPLEMENTATION_DEPENDENCY_FAILED":
        throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
    }
  }
  throw error;
}

export const memberImplementationRoutes: FastifyPluginAsync<{
  member: AuthRouteDependencies["member"];
  implementation: MemberImplementationPort;
}> = async (app, dependencies) => {
  app.addHook("onRequest", (_request, reply, done) => {
    learningResponseHeaders(reply);
    done();
  });

  app.get("/member/artifacts", { exposeHeadRoute: false }, async (request, reply) => {
    if (!queryIsEmpty(request.query) || requestHasBody(request)) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const actor = await authorizeLearningMember(request, dependencies.member);
    try {
      return ArtifactListResponseSchema.parse(await dependencies.implementation.list(
        actor,
        canonicalCorrelationId(request),
      ));
    } catch (error) {
      return mapImplementationError(error, reply);
    }
  });

  app.get("/member/artifacts/:artifactId", { exposeHeadRoute: false }, async (request, reply) => {
    const { artifactId } = parameters(request.params);
    if (!queryIsEmpty(request.query) || requestHasBody(request)) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const actor = await authorizeLearningMember(request, dependencies.member);
    try {
      return ArtifactDetailResponseSchema.parse(await dependencies.implementation.get(
        actor,
        canonicalCorrelationId(request),
        artifactId,
      ));
    } catch (error) {
      return mapImplementationError(error, reply);
    }
  });

  app.get("/member/artifacts/:artifactId/versions", { exposeHeadRoute: false }, async (request, reply) => {
    const { artifactId } = parameters(request.params);
    const query = ArtifactVersionsQuerySchema.safeParse(request.query);
    if (!query.success || requestHasBody(request)) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const actor = await authorizeLearningMember(request, dependencies.member);
    try {
      return ArtifactVersionsResponseSchema.parse(await dependencies.implementation.versions(
        actor,
        canonicalCorrelationId(request),
        artifactId,
        query.data,
      ));
    } catch (error) {
      return mapImplementationError(error, reply);
    }
  });

  app.post("/member/artifacts/:artifactId/versions", async (request, reply) => {
    const { artifactId } = parameters(request.params);
    const input = SaveArtifactVersionRequestSchema.safeParse(request.body);
    if (!queryIsEmpty(request.query) || !input.success) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const idempotencyKey = requiredIdempotencyKey(request);
    if (!/^[A-Za-z0-9._~-]{16,128}$/u.test(idempotencyKey)) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const actor = await authorizeLearningMember(request, dependencies.member);
    try {
      const response = SaveArtifactVersionResponseSchema.parse(
        await dependencies.implementation.saveVersion(
          actor,
          canonicalCorrelationId(request),
          artifactId,
          input.data,
          idempotencyKey,
        ),
      );
      return reply.status(201).send(response);
    } catch (error) {
      return mapImplementationError(error, reply);
    }
  });
};
