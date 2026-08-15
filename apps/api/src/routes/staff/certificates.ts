import {
  CertificateDeliveryResponseSchema,
  CreateCertificateDeliveryRequestSchema,
} from "@syntholo/contracts/learning";
import {
  CertificateRepositoryError,
  DatabaseDependencyUnavailableError,
} from "@syntholo/database";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { authorize, requireAdmin, requireRecentAuth } from "../../auth/authorize.js";
import { authenticateStaff, requireUnsafeStaffRequest } from "../../auth/staff.js";
import type { AuthRouteDependencies } from "../../auth/types.js";
import { requiredIdempotencyKey } from "../../http/idempotency-key.js";
import { queryIsEmpty } from "../../http/request-shape.js";
import { canonicalCorrelationId } from "../../plugins/context.js";
import { AppError } from "../../plugins/error-handler.js";

const CertificateParametersSchema = z.object({ certificateId: z.string().uuid() }).strict();
const exactKey = /^[A-Za-z0-9._~-]{16,128}$/u;

type Options = Readonly<{
  staff: AuthRouteDependencies["staff"];
  certificates: NonNullable<AuthRouteDependencies["staff"]["certificates"]>;
}>;

function mapError(error: unknown, reply: FastifyReply): never {
  if (error instanceof DatabaseDependencyUnavailableError) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
  }
  if (error instanceof CertificateRepositoryError) {
    switch (error.code) {
      case "CERTIFICATE_NOT_FOUND":
        throw new AppError("NOT_FOUND", 404, "Certificate not found");
      case "IDEMPOTENCY_KEY_REUSED":
        throw new AppError(error.code, 409, "Idempotency key was already used");
      case "IDEMPOTENCY_IN_PROGRESS":
        void reply.header("retry-after", "1");
        throw new AppError(error.code, 409, "This request is still in progress");
      case "CERTIFICATE_COMMAND_INVALID":
      case "INVALID_CURSOR":
        throw new AppError(error.code, 400, "Request validation failed");
      case "CERTIFICATE_DEPENDENCY_FAILED":
        throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
      case "VERSION_CONFLICT":
        throw new AppError(error.code, 409, "Certificate state changed; refresh and retry");
    }
  }
  throw error;
}

export const staffCertificateRoutes: FastifyPluginAsync<Options> = async (app, dependencies) => {
  app.post("/staff/certificates/:certificateId/deliveries", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("vary", "Cookie");
    const params = CertificateParametersSchema.safeParse(request.params);
    const body = CreateCertificateDeliveryRequestSchema.safeParse(request.body);
    if (!params.success || !body.success || !queryIsEmpty(request.query)) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const idempotencyKey = requiredIdempotencyKey(request);
    if (!exactKey.test(idempotencyKey)) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    requireUnsafeStaffRequest(request, dependencies.staff);
    const authenticated = await authenticateStaff(request, dependencies.staff);
    const actor = requireRecentAuth(
      authorize(requireAdmin(authenticated), { permission: "certificates:deliver" }),
      300,
      dependencies.staff.clock.now(),
    );
    try {
      const response = CertificateDeliveryResponseSchema.parse(await dependencies.certificates.createDelivery(
        actor,
        canonicalCorrelationId(request),
        params.data.certificateId,
        body.data,
        idempotencyKey,
      ));
      return reply.status(202).send(response);
    } catch (error) {
      return mapError(error, reply);
    }
  });
};
