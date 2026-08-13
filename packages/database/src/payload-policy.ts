import { Buffer } from "node:buffer";
import { copyJsonObject, type JsonObject, type JsonValue } from "@syntholo/domain";

const MAX_DEPTH = 8;
const AUDIT_MAX_BYTES = 16 * 1024;
const OPERATIONAL_MAX_BYTES = 64 * 1024;
const allowedKeys = new Set([
  "accountId",
  "aggregateId",
  "attempt",
  "changedFields",
  "enabled",
  "eventId",
  "handlerName",
  "kind",
  "outcome",
  "queue",
  "reference",
  "referenceId",
  "references",
  "revision",
  "role",
  "schemaVersion",
  "state",
  "status",
  "type",
  "values",
]);
const safeValuePattern = /^[A-Za-z0-9._:/-]*$/u;
const forbiddenValuePattern = /(?:^|[._:-])(?:api[-_]?key|bearer|credential|password|private[-_]?key|secret|sk_(?:live|test)|token)(?:$|[._:-])/iu;
const jwtPattern = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const providerSecretPattern = /(?:ghp_|github_pat_|xox[baprs]-|AKIA|ASIA|sess(?:ion)?[_:-]|staff_session[_:-]|clerk[_:-]|workos[_:-])/iu;
const opaqueSecretPattern = /[A-Za-z0-9_-]{48,}/u;
const prototypeKeys = new Set(["__proto__", "constructor", "prototype"]);

function invalidPayload(): never {
  throw new Error("PERSISTED_PAYLOAD_INVALID");
}

function validateValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
): asserts value is JsonValue {
  if (depth > MAX_DEPTH) invalidPayload();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidPayload();
    return;
  }
  if (typeof value === "string") {
    if (
      Buffer.byteLength(value, "utf8") > 255
      ||
      !safeValuePattern.test(value)
      || value.includes("@")
      || forbiddenValuePattern.test(value)
      || jwtPattern.test(value)
      || providerSecretPattern.test(value)
      || opaqueSecretPattern.test(value)
    ) invalidPayload();
    return;
  }
  if (typeof value !== "object" || ancestors.has(value)) invalidPayload();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        value.every((item) => typeof item === "string")
        && (
          forbiddenValuePattern.test(value.join(""))
          || jwtPattern.test(value.join(""))
          || providerSecretPattern.test(value.join(""))
          || opaqueSecretPattern.test(value.join(""))
        )
      ) invalidPayload();
      for (const item of value) validateValue(item, depth + 1, ancestors);
      return;
    }
    for (const key of Object.keys(value)) {
      if (
        prototypeKeys.has(key)
        || !allowedKeys.has(key)
      ) invalidPayload();
      validateValue((value as Record<string, unknown>)[key], depth + 1, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function assertSafePayload(value: unknown, limit: number): JsonObject {
  let clone: JsonObject;
  try {
    clone = copyJsonObject(value);
  } catch {
    return invalidPayload();
  }
  const serialized = JSON.stringify(clone);
  if (Buffer.byteLength(serialized, "utf8") > limit) {
    throw new Error("PERSISTED_PAYLOAD_TOO_LARGE");
  }
  try {
    validateValue(clone, 0, new WeakSet<object>());
  } catch {
    return invalidPayload();
  }
  return clone;
}

export function assertSafeAuditPayload(value: unknown): JsonObject {
  return assertSafePayload(value, AUDIT_MAX_BYTES);
}

export function assertSafeOperationalPayload(value: unknown): JsonObject {
  return assertSafePayload(value, OPERATIONAL_MAX_BYTES);
}
