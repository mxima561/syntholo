import { ApiErrorSchema } from "@syntholo/contracts";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { canonicalCorrelationId } from "./context.js";

const AppErrorStatusSchema = z.number().int().min(400).max(599);
const AppErrorCodeSchema = z.string().min(1);
const AppErrorMessageSchema = z.string().min(1);
const AppErrorDetailsSchema = z.record(z.string(), z.unknown());

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly safeMessage: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    status: number,
    safeMessage: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(safeMessage);

    const parsedStatus = AppErrorStatusSchema.safeParse(status);
    if (!parsedStatus.success) throw new Error("APP_ERROR_STATUS_INVALID");
    const parsedCode = AppErrorCodeSchema.safeParse(code);
    const parsedMessage = AppErrorMessageSchema.safeParse(safeMessage);
    const parsedDetails =
      details === undefined
        ? { success: true as const, data: undefined }
        : AppErrorDetailsSchema.safeParse(details);
    if (!parsedCode.success || !parsedMessage.success || !parsedDetails.success) {
      throw new Error("APP_ERROR_FIELDS_INVALID");
    }

    this.name = "AppError";
    this.code = parsedCode.data;
    this.status = parsedStatus.data;
    this.safeMessage = parsedMessage.data;
    this.details = parsedDetails.data;
  }
}

type ValidationError = FastifyError & {
  validation?: unknown;
};

export function safeErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (request.url.split("?", 1)[0] === "/v1/webhooks/stripe"
    && ["FST_ERR_CTP_BODY_TOO_LARGE", "FST_ERR_CTP_INVALID_MEDIA_TYPE"].includes(error.code)) {
    const payload = ApiErrorSchema.parse({
      error: {
        code: "WEBHOOK_SIGNATURE_INVALID",
        message: "Webhook signature invalid",
        correlationId: canonicalCorrelationId(request),
      },
    });
    void reply.header("cache-control", "no-store").status(400).send(payload);
    return;
  }
  if (error instanceof AppError) {
    const payload = ApiErrorSchema.parse({
      error: {
        code: error.code,
        message: error.safeMessage,
        correlationId: canonicalCorrelationId(request),
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    void reply.status(error.status).send(payload);
    return;
  }

  const validationError = error as ValidationError;
  const isValidationError = Array.isArray(validationError.validation);
  const payload = ApiErrorSchema.parse({
    error: {
      code: isValidationError ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
      message: isValidationError
        ? "Request validation failed"
        : "Internal server error",
      correlationId: canonicalCorrelationId(request),
    },
  });
  void reply.status(isValidationError ? 400 : 500).send(payload);
}
