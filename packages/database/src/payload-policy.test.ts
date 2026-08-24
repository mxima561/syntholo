import { describe, expect, it } from "vitest";
import {
  assertSafeAuditPayload,
  assertSafeOperationalPayload,
} from "./payload-policy.js";

const joined = (...parts: readonly string[]) => parts.join("");

describe("persisted payload policy", () => {
  it("accepts bounded reference and state metadata", () => {
    const payload = {
      aggregateId: "aggregate_1",
      changedFields: ["status", "role"],
      enabled: true,
      revision: 2,
      status: "active",
    };

    expect(assertSafeAuditPayload(payload)).toEqual(payload);
    expect(assertSafeOperationalPayload(payload)).toEqual(payload);
    expect(assertSafeAuditPayload(payload)).not.toBe(payload);
  });

  it.each([
    ["null", null],
    ["array", []],
    ["date", new Date("2026-08-13T16:00:00.000Z")],
    ["undefined value", { state: undefined }],
    ["non-finite number", { revision: Number.NaN }],
    ["prototype key", JSON.parse('{"__proto__":"redacted"}')],
    ["secret-shaped key", { authorization: "redacted" }],
    ["secret alias", { secret: "opaque_value" }],
    ["credential alias", { credential: "opaque_value" }],
    ["API key alias", { apiKey: "opaque_value" }],
    ["private key alias", { privateKey: "opaque_value" }],
    ["unknown innocent alias", { detail: "opaque_value" }],
    ["secret value under allowed reference", { reference: joined("sk_", "live_", "opaquevalue123") }],
    ["JWT value under allowed reference", { reference: joined("ey", "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature") }],
    ["long opaque value under allowed reference", { reference: "a".repeat(256) }],
    ["GitHub credential prefix", { reference: joined("gh", "p_", "opaqueplaceholder") }],
    ["GitHub fine-grained credential prefix", { reference: joined("github_", "pat_", "opaqueplaceholder") }],
    ["Slack credential prefix", { reference: joined("xo", "xb-", "opaque-placeholder") }],
    ["AWS credential prefix", { reference: joined("AK", "IA", "OPAQUEPLACEHOLDER") }],
    ["Task6 session identifier", { reference: joined("session_", "staff_", "opaque") }],
    ["Cloudflare Access identifier", { reference: joined("work", "os_", "opaque") }],
    ["Clerk identifier", { reference: joined("cl", "erk_", "opaque") }],
    ["high entropy opaque value", { reference: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4" }],
    ["embedded GitHub credential prefix", { reference: joined("ref:g", "hp_", "A".repeat(36)) }],
    ["embedded opaque token run", { reference: `ref:${"A".repeat(64)}` }],
    ["split opaque values", { values: [
      "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6",
      "Q7r8S9t0U1v2W3x4Y5z6A7b8C9d0E1f2",
    ] }],
    ["split provider marker", { values: ["ref:g", joined("h", "p_"), "opaqueplaceholder"] }],
    ["content-shaped key", { transcript: "redacted" }],
    ["content-bearing value", { summary: "contains spaces" }],
    ["email-shaped value", { reference: "redacted@example.invalid" }],
  ])("rejects %s without reflecting the value", (_label, payload) => {
    let error: unknown;
    try {
      assertSafeOperationalPayload(payload);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ message: "PERSISTED_PAYLOAD_INVALID" });
    expect(String(error)).not.toContain("contains spaces");
    expect(String(error)).not.toContain("redacted@example.invalid");
  });

  it("rejects cyclic and deeply nested objects", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const deep = JSON.parse(
      '{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":true}}}}}}}}}',
    );

    expect(() => assertSafeOperationalPayload(cyclic)).toThrow(
      "PERSISTED_PAYLOAD_INVALID",
    );
    expect(() => assertSafeOperationalPayload(deep)).toThrow(
      "PERSISTED_PAYLOAD_INVALID",
    );
  });

  it("rejects symbols and accessors without invoking getters", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "reference", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "unsafe";
      },
    });

    expect(() => assertSafeOperationalPayload(accessor)).toThrow(
      "PERSISTED_PAYLOAD_INVALID",
    );
    expect(() => assertSafeOperationalPayload({
      [Symbol("hidden")]: "unsafe",
    })).toThrow("PERSISTED_PAYLOAD_INVALID");
    expect(getterCalls).toBe(0);
  });

  it("normalizes reflective proxy failures to one stable error", () => {
    const payload = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error("unpersisted reflective detail");
      },
    });

    expect(() => assertSafeOperationalPayload(payload)).toThrowError(
      new Error("PERSISTED_PAYLOAD_INVALID"),
    );
  });

  it("enforces the separate serialized UTF-8 audit and operational limits", () => {
    const auditTooLarge = { reference: `r${"a".repeat(16 * 1024)}` };
    const operationalTooLarge = { reference: `r${"a".repeat(64 * 1024)}` };

    expect(() => assertSafeAuditPayload(auditTooLarge)).toThrow(
      "PERSISTED_PAYLOAD_TOO_LARGE",
    );
    expect(() => assertSafeOperationalPayload(operationalTooLarge)).toThrow(
      "PERSISTED_PAYLOAD_TOO_LARGE",
    );
  });
});
