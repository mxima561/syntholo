import { randomUUID } from "node:crypto";
import { checkoutErrorCopy } from "@syntholo/domain";

export function correlationIdFrom(headers: Record<string, unknown> | undefined) {
  const raw = headers?.["x-correlation-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return value;
  }
  return randomUUID();
}

export function apiError(code: string, correlationId: string, message = checkoutErrorCopy(code), details?: Record<string, unknown>) {
  return {
    error: {
      code,
      message,
      correlationId,
      ...(details ? { details } : {}),
    },
  };
}

export function parseJsonObject(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  if (typeof body !== "string" || body.trim() === "") return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}
