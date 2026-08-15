import {
  CertificateListQuerySchema,
  CertificateListResponseSchema,
  CertificateRecipientNameResponseSchema,
  ConfirmCertificateRecipientNameRequestSchema,
} from "@syntholo/contracts/learning";
import {
  CertificateRepositoryError,
  DatabaseDependencyUnavailableError,
} from "@syntholo/database";
import { CertificateBlobError } from "@syntholo/integrations";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { authenticateMember } from "../../auth/member.js";
import type { AuthRouteDependencies } from "../../auth/types.js";
import { requiredIdempotencyKey } from "../../http/idempotency-key.js";
import { queryIsEmpty, requestHasBody } from "../../http/request-shape.js";
import { canonicalCorrelationId } from "../../plugins/context.js";
import { AppError } from "../../plugins/error-handler.js";

const CertificateParametersSchema = z.object({ certificateId: z.string().uuid() }).strict();
const exactKey = /^[A-Za-z0-9._~-]{16,128}$/u;
const streamChunkBytes = 64 * 1_024;

type Options = Readonly<{
  member: AuthRouteDependencies["member"];
  certificates: NonNullable<AuthRouteDependencies["member"]["certificates"]>;
  blob: NonNullable<AuthRouteDependencies["member"]["certificateBlob"]>;
}>;

function headers(reply: FastifyReply): void {
  void reply.header("cache-control", "no-store");
  void reply.header("vary", "Authorization");
}

function mapError(error: unknown, reply: FastifyReply): never {
  if (error instanceof DatabaseDependencyUnavailableError) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
  }
  if (error instanceof CertificateRepositoryError) {
    switch (error.code) {
      case "CERTIFICATE_NOT_FOUND":
        throw new AppError("NOT_FOUND", 404, "Certificate not found");
      case "VERSION_CONFLICT":
        throw new AppError(error.code, 409, "Recipient name changed; refresh and retry");
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
    }
  }
  if (error instanceof CertificateBlobError) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Service temporarily unavailable");
  }
  throw error;
}

function key(request: Parameters<typeof requiredIdempotencyKey>[0]): string {
  const value = requiredIdempotencyKey(request);
  if (!exactKey.test(value)) throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
  return value;
}

export const memberCertificateRoutes: FastifyPluginAsync<Options> = async (app, dependencies) => {
  app.get("/member/certificate-recipient-name", { exposeHeadRoute: false }, async (request, reply) => {
    headers(reply);
    if (!queryIsEmpty(request.query) || requestHasBody(request)) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const actor = await authenticateMember(request, dependencies.member);
    try {
      return CertificateRecipientNameResponseSchema.parse(await dependencies.certificates.getRecipientName(
        actor, canonicalCorrelationId(request),
      ));
    } catch (error) {
      return mapError(error, reply);
    }
  });

  app.put("/member/certificate-recipient-name", async (request, reply) => {
    headers(reply);
    const body = ConfirmCertificateRecipientNameRequestSchema.safeParse(request.body);
    if (!queryIsEmpty(request.query) || !body.success) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const intent = key(request);
    const actor = await authenticateMember(request, dependencies.member);
    try {
      return CertificateRecipientNameResponseSchema.parse(await dependencies.certificates.confirmRecipientName(
        actor, canonicalCorrelationId(request), body.data, intent,
      ));
    } catch (error) {
      return mapError(error, reply);
    }
  });

  app.get("/member/certificates", { exposeHeadRoute: false }, async (request, reply) => {
    headers(reply);
    const query = CertificateListQuerySchema.safeParse(request.query);
    if (!query.success || requestHasBody(request)) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const actor = await authenticateMember(request, dependencies.member);
    try {
      return CertificateListResponseSchema.parse(await dependencies.certificates.list(
        actor, canonicalCorrelationId(request), query.data,
      ));
    } catch (error) {
      return mapError(error, reply);
    }
  });

  app.get("/member/certificates/:certificateId/download", { exposeHeadRoute: false }, async (request, reply) => {
    headers(reply);
    const params = CertificateParametersSchema.safeParse(request.params);
    if (!params.success || !queryIsEmpty(request.query) || requestHasBody(request)) {
      throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
    }
    const actor = await authenticateMember(request, dependencies.member);
    const controller = new AbortController();
    const abort = () => controller.abort();
    let stream: Readable | undefined;
    const close = () => {
      controller.abort();
      stream?.destroy();
    };
    const cleanup = () => {
      request.raw.off("aborted", abort);
      reply.raw.off("close", close);
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", close);
    try {
      const fence = await dependencies.certificates.downloadFence(
        actor, canonicalCorrelationId(request), params.data.certificateId,
      );
      const object = await dependencies.blob.download({
        pathname: fence.pathname,
        expected: { byteLength: fence.byteLength, sha256: fence.sha256, etag: fence.etag },
        signal: controller.signal,
      });
      if (object.byteLength !== fence.byteLength || object.sha256 !== fence.sha256 || object.etag !== fence.etag
        || object.contentType !== "application/pdf" || !(object.bytes instanceof Uint8Array)
        || object.bytes.byteLength !== fence.byteLength
        || createHash("sha256").update(object.bytes).digest("hex") !== fence.sha256) {
        throw new CertificateBlobError("CERTIFICATE_BLOB_CONSISTENCY_INCIDENT", false);
      }
      const bytes = Buffer.from(object.bytes);
      stream = Readable.from((async function* certificateBody() {
        for (let offset = 0; offset < bytes.byteLength; offset += streamChunkBytes) {
          if (controller.signal.aborted) return;
          yield bytes.subarray(offset, Math.min(offset + streamChunkBytes, bytes.byteLength));
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      })());
      stream.once("close", cleanup);
      void reply.header("cache-control", "private, no-store");
      void reply.header("content-disposition", "attachment; filename=\"syntholo-certificate-of-completion.pdf\"");
      void reply.header("content-length", object.byteLength);
      void reply.header("content-type", "application/pdf");
      void reply.header("referrer-policy", "no-referrer");
      void reply.header("x-content-type-options", "nosniff");
      return reply.status(200).send(stream);
    } catch (error) {
      cleanup();
      return mapError(error, reply);
    }
  });
};
