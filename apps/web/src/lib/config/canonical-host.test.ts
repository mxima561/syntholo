import { describe, expect, it } from "vitest";
import { canonicalRedirectTarget } from "./canonical-host";

describe("canonical web host", () => {
  it("redirects every production alias to the fixed WEB_ORIGIN while preserving path and query", () => {
    expect(canonicalRedirectTarget(
      new URL("https://syntholo-git-main-team.vercel.app/learn/course?lesson=2"),
      { mode: "production", webOrigin: "https://app.syntholo.com" },
    )).toBe("https://app.syntholo.com/learn/course?lesson=2");
  });

  it("does not redirect the exact canonical origin or demo preview hosts", () => {
    expect(canonicalRedirectTarget(
      new URL("https://app.syntholo.com/learn"),
      { mode: "production", webOrigin: "https://app.syntholo.com" },
    )).toBeUndefined();
    expect(canonicalRedirectTarget(
      new URL("https://syntholo-preview.vercel.app/learn"),
      { mode: "demo", webOrigin: "http://localhost:3000" },
    )).toBeUndefined();
  });
});
