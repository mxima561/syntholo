import { describe, expect, it } from "vitest";
import { healthPayload, releaseSha } from "./health";

describe("releaseSha", () => {
  it("prefers RELEASE_SHA over GITHUB_SHA", () => {
    expect(releaseSha({ RELEASE_SHA: "abc123", GITHUB_SHA: "other" })).toBe("abc123");
  });

  it("falls back to dev when unset", () => {
    expect(releaseSha({})).toBe("dev");
  });
});

describe("healthPayload", () => {
  it("reports the same SHA for api and worker", () => {
    const env = { RELEASE_SHA: "rel_1" };
    expect(healthPayload("api", env).releaseSha).toBe(healthPayload("worker", env).releaseSha);
  });
});
