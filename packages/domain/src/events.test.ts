import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createDomainEvent,
  type DomainEvent,
  type JsonObject,
} from "./events.js";

const occurredAt = new Date("2026-08-13T16:00:00.000Z");

describe("domain event envelope", () => {
  it("creates the canonical immutable version-one envelope from trusted provenance", () => {
    const event = createDomainEvent(
      {
        aggregateId: "aggregate_1",
        eventId: "10000000-0000-4000-8000-000000000001",
        payload: { status: "active" },
        type: "foundation.aggregate_created.v1",
      },
      {
        accountId: "20000000-0000-4000-8000-000000000002",
        occurredAt,
      },
    );

    expect(event).toEqual({
      eventId: "10000000-0000-4000-8000-000000000001",
      type: "foundation.aggregate_created.v1",
      aggregateId: "aggregate_1",
      accountId: "20000000-0000-4000-8000-000000000002",
      occurredAt: "2026-08-13T16:00:00.000Z",
      payload: { status: "active" },
      schemaVersion: 1,
    });
    expect(Object.isFrozen(event)).toBe(true);
    expectTypeOf(event).toMatchTypeOf<DomainEvent<string, JsonObject>>();
  });

  it.each([
    ["future-tense type", "foundation.aggregate_create.v1"],
    ["unversioned type", "foundation.aggregate_created"],
    ["future schema version", "foundation.aggregate_created.v2"],
  ])("rejects a %s", (_label, type) => {
    expect(() => createDomainEvent(
      {
        aggregateId: "aggregate_1",
        eventId: "10000000-0000-4000-8000-000000000001",
        payload: {},
        type,
      },
      { accountId: null, occurredAt },
    )).toThrow("DOMAIN_EVENT_INVALID");
  });

  it("rejects invalid identifiers and timestamps with one stable error", () => {
    expect(() => createDomainEvent(
      {
        aggregateId: "",
        eventId: "not-a-uuid",
        payload: {},
        type: "foundation.aggregate_created.v1",
      },
      { accountId: null, occurredAt: new Date(Number.NaN) },
    )).toThrow("DOMAIN_EVENT_INVALID");
  });

  it.each([
    ["date", { value: new Date("2026-08-13T16:00:00.000Z") }],
    ["map", { value: new Map([["key", "value"]]) }],
    ["set", { value: new Set(["value"]) }],
    ["bigint", { value: 1n }],
  ])("rejects a non-JSON %s payload", (_label, payload) => {
    expect(() => createDomainEvent(
      {
        aggregateId: "aggregate_1",
        eventId: "10000000-0000-4000-8000-000000000001",
        payload: payload as never,
        type: "foundation.aggregate_created.v1",
      },
      { accountId: null, occurredAt },
    )).toThrow("DOMAIN_EVENT_INVALID");
  });

  it("rejects cycles, symbols, and accessors without invoking getters", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "unsafe";
      },
    });
    const symbol = { [Symbol("hidden")]: "unsafe" };
    const prototypeKey = JSON.parse('{"__proto__":{"polluted":true}}');

    for (const payload of [cyclic, accessor, symbol, prototypeKey]) {
      expect(() => createDomainEvent(
        {
          aggregateId: "aggregate_1",
          eventId: "10000000-0000-4000-8000-000000000001",
          payload: payload as never,
          type: "foundation.aggregate_created.v1",
        },
        { accountId: null, occurredAt },
      )).toThrow("DOMAIN_EVENT_INVALID");
    }
    expect(getterCalls).toBe(0);
  });

  it("normalizes reflective failures to one stable error", () => {
    const payload = new Proxy({}, {
      ownKeys: () => {
        throw new Error("unpersisted reflective detail");
      },
    });

    expect(() => createDomainEvent(
      {
        aggregateId: "aggregate_1",
        eventId: "10000000-0000-4000-8000-000000000001",
        payload,
        type: "foundation.aggregate_created.v1",
      },
      { accountId: null, occurredAt },
    )).toThrowError(new Error("DOMAIN_EVENT_INVALID"));
  });

  it("copies and deeply freezes nested payload aliases", () => {
    const source = { nested: { state: "before" }, values: ["one"] };
    const event = createDomainEvent(
      {
        aggregateId: "aggregate_1",
        eventId: "10000000-0000-4000-8000-000000000001",
        payload: source,
        type: "foundation.aggregate_created.v1",
      },
      { accountId: null, occurredAt },
    );
    source.nested.state = "after";
    source.values.push("two");

    expect(event.payload).toEqual({
      nested: { state: "before" },
      values: ["one"],
    });
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(Object.isFrozen(event.payload.nested)).toBe(true);
    expect(Object.isFrozen(event.payload.values)).toBe(true);
  });

  it.each([
    "foundation.notification_sent.v1",
    "commerce.payment_paid.v1",
    "entitlements.command_applied.v1",
    "entitlements.reconciliation_required.v1",
    "foundation.lock_lost.v1",
    "content.course_published.v1",
    "content.lesson_published.v1",
    "content.version_archived.v1",
  ])("accepts the registered irregular past-tense event %s", (type) => {
    expect(() => createDomainEvent(
      {
        aggregateId: "aggregate_1",
        eventId: "10000000-0000-4000-8000-000000000001",
        payload: {},
        type,
      },
      { accountId: null, occurredAt },
    )).not.toThrow();
  });
});
