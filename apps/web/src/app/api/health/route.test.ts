import { describe, expect, it } from "vitest";
import { createWebHealthResponse } from "./health";

const releaseSha = "0123456789abcdef0123456789abcdef01234567";

describe("web health", () => {
  it("returns only the service, immutable release, and status", () => {
    expect(createWebHealthResponse({ RELEASE_SHA: releaseSha }, releaseSha)).toEqual({
      body: { releaseSha, service: "web", status: "ok" },
      status: 200,
    });
  });

  it.each([undefined, "ABC", "1123456789abcdef0123456789abcdef01234567"])(
    "fails closed without the exact build release (%s)",
    (runtimeReleaseSha) => {
      expect(createWebHealthResponse(
        runtimeReleaseSha === undefined ? {} : { RELEASE_SHA: runtimeReleaseSha },
        releaseSha,
      )).toEqual({
        body: { releaseSha, service: "web", status: "degraded" },
        status: 503,
      });
    },
  );
});
