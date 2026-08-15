import type { FastifyRequest } from "fastify";
import { AppError } from "../plugins/error-handler.js";

export function requiredIdempotencyKey(request: FastifyRequest): string {
  const values: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.raw.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1
    || value === undefined
    || value.includes(",")
    || !/^[!-~]{16,128}$/u.test(value)
    || Buffer.byteLength(value, "ascii") !== value.length
  ) {
    throw new AppError("VALIDATION_ERROR", 400, "Request validation failed");
  }
  return value;
}
