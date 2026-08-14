import { describe, expect, it } from "vitest";
import { parseWebBuildIdentity } from "./build";

const releaseSha = "0123456789abcdef0123456789abcdef01234567";

describe("web build identity", () => {
  it("returns the exact immutable release for Next build metadata", () => {
    expect(parseWebBuildIdentity({ RELEASE_SHA: releaseSha })).toBe(releaseSha);
  });

  it.each([
    {},
    { RELEASE_SHA: "ABC" },
    {
      GITHUB_SHA: "1123456789abcdef0123456789abcdef01234567",
      RELEASE_SHA: releaseSha,
    },
  ])("fails missing, malformed, or CI-mismatched release identity", (environment) => {
    expect(() => parseWebBuildIdentity(environment)).toThrow(
      "WEB_RELEASE_IDENTITY_INVALID",
    );
  });

  it.each([
    { RELEASE_SHA: releaseSha, VERCEL: "1" },
    { RELEASE_SHA: releaseSha, VERCEL_ENV: "production" },
    {
      RELEASE_SHA: releaseSha,
      VERCEL: "1",
      VERCEL_GIT_COMMIT_SHA: "1123456789abcdef0123456789abcdef01234567",
    },
  ])("fails a Vercel build without the exact provider checkout SHA", (environment) => {
    expect(() => parseWebBuildIdentity(environment)).toThrow(
      "WEB_RELEASE_IDENTITY_INVALID",
    );
  });

  it("binds Vercel metadata to the immutable release", () => {
    expect(parseWebBuildIdentity({
      RELEASE_SHA: releaseSha,
      VERCEL: "1",
      VERCEL_GIT_COMMIT_SHA: releaseSha,
    })).toBe(releaseSha);
  });
});
