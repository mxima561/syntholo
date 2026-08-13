export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;

export type DomainEvent<TType extends string, TPayload> = Readonly<{
  eventId: string;
  type: TType;
  aggregateId: string;
  accountId: string | null;
  occurredAt: string;
  payload: TPayload;
  schemaVersion: 1;
}>;

export type DomainEventInput<
  TType extends string,
  TPayload extends JsonObject,
> = Readonly<{
  aggregateId: string;
  eventId: string;
  payload: TPayload;
  type: TType;
}>;

export type DomainEventProvenance = Readonly<{
  accountId: string | null;
  occurredAt: Date;
}>;

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const boundedIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const prototypeKeys = new Set(["__proto__", "constructor", "prototype"]);
const registeredDomainEventTypes = new Set([
  "commerce.payment_paid.v1",
  "foundation.account_name_changed.v1",
  "foundation.aggregate_created.v1",
  "foundation.lock_lost.v1",
  "foundation.notification_sent.v1",
]);

function assertEventInput(
  input: DomainEventInput<string, JsonObject>,
  provenance: DomainEventProvenance,
): void {
  if (
    !canonicalUuidPattern.test(input.eventId)
    || !boundedIdentifierPattern.test(input.aggregateId)
    || !registeredDomainEventTypes.has(input.type)
    || !Number.isFinite(provenance.occurredAt.getTime())
    || (provenance.accountId !== null
      && !canonicalUuidPattern.test(provenance.accountId))
  ) {
    throw new Error("DOMAIN_EVENT_INVALID");
  }
}

function cloneJsonValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
): JsonValue {
  if (depth > 32) throw new Error("JSON_VALUE_INVALID");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON_VALUE_INVALID");
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new Error("JSON_VALUE_INVALID");
  }
  const isArray = Array.isArray(value);
  if (!isArray && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("JSON_VALUE_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
    throw new Error("JSON_VALUE_INVALID");
  }
  ancestors.add(value);
  try {
    if (isArray) {
      const length = value.length;
      const clone: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined
          || !("value" in descriptor)
          || !descriptor.enumerable
        ) {
          throw new Error("JSON_VALUE_INVALID");
        }
        clone.push(cloneJsonValue(descriptor.value, depth + 1, ancestors));
      }
      const expectedKeys = new Set(["length", ...clone.map((_, index) => String(index))]);
      if (Object.keys(descriptors).some((key) => !expectedKeys.has(key))) {
        throw new Error("JSON_VALUE_INVALID");
      }
      return Object.freeze(clone);
    }

    const clone: Record<string, JsonValue> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        prototypeKeys.has(key)
        || !("value" in descriptor)
        || !descriptor.enumerable
      ) {
        throw new Error("JSON_VALUE_INVALID");
      }
      Object.defineProperty(clone, key, {
        configurable: false,
        enumerable: true,
        value: cloneJsonValue(descriptor.value, depth + 1, ancestors),
        writable: false,
      });
    }
    return Object.freeze(clone);
  } finally {
    ancestors.delete(value);
  }
}

export function copyJsonObject(value: unknown): JsonObject {
  try {
    const clone = cloneJsonValue(value, 0, new WeakSet<object>());
    if (clone === null || typeof clone !== "object" || Array.isArray(clone)) {
      throw new Error("JSON_OBJECT_INVALID");
    }
    return clone as JsonObject;
  } catch {
    throw new Error("JSON_OBJECT_INVALID");
  }
}

export function createDomainEvent<
  TType extends string,
  TPayload extends JsonObject,
>(
  input: DomainEventInput<TType, TPayload>,
  provenance: DomainEventProvenance,
): DomainEvent<TType, TPayload> {
  try {
    assertEventInput(input, provenance);
    const payload = copyJsonObject(input.payload) as TPayload;
    return Object.freeze({
      eventId: input.eventId,
      type: input.type,
      aggregateId: input.aggregateId,
      accountId: provenance.accountId,
      occurredAt: provenance.occurredAt.toISOString(),
      payload,
      schemaVersion: 1 as const,
    });
  } catch {
    throw new Error("DOMAIN_EVENT_INVALID");
  }
}
