import { describe, expect, it } from "vitest";
import { ApiErrorSchema } from "./http.js";
import { HealthResponseSchema } from "./health.js";

describe("ApiErrorSchema", () => {
  it("requires a safe code, UUID correlation id, and message", () => {
    expect(() =>
      ApiErrorSchema.parse({
        error: { code: "FORBIDDEN", message: "No access" },
      }),
    ).toThrow();

    expect(
      ApiErrorSchema.parse({
        error: {
          code: "FORBIDDEN",
          message: "No access",
          correlationId: "2c714c69-0b75-46ef-8141-739a72ec9689",
        },
      }),
    ).toBeTruthy();
  });

  it("rejects fields outside the safe error envelope", () => {
    expect(() =>
      ApiErrorSchema.parse({
        error: {
          code: "FORBIDDEN",
          message: "No access",
          correlationId: "2c714c69-0b75-46ef-8141-739a72ec9689",
          internalCause: "do-not-expose",
        },
      }),
    ).toThrow();

    expect(() =>
      ApiErrorSchema.parse({
        error: {
          code: "FORBIDDEN",
          message: "No access",
          correlationId: "2c714c69-0b75-46ef-8141-739a72ec9689",
        },
        trace: "do-not-expose",
      }),
    ).toThrow();
  });
});

describe("HealthResponseSchema", () => {
  it("returns dependencies with only a state and latency summary", () => {
    expect(
      HealthResponseSchema.parse({
        status: "degraded",
        releaseSha: "abc123",
        service: "api",
        dependencies: [
          {
            name: "postgres",
            status: "degraded",
            latencyMs: 42,
            connectionString: "postgres://do-not-expose",
          },
        ],
      }),
    ).toEqual({
      status: "degraded",
      releaseSha: "abc123",
      service: "api",
      dependencies: [
        { name: "postgres", status: "degraded", latencyMs: 42 },
      ],
    });
  });
});
