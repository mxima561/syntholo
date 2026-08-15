import { describe, expect, it } from "vitest";
import {
  canonicalRedirectTarget,
  vercelCanonicalRequestUrl,
} from "./canonical-host";

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

  it("trusts only Vercel's production request marker to recover the external canonical origin", () => {
    const internal = new URL("http://127.0.0.1:3201/learn?from=dashboard");
    const marker = new Headers({ "x-vercel-id": "iad1::production-browser-fixture" });
    expect(vercelCanonicalRequestUrl(
      internal,
      marker,
      { vercel: "1", vercelEnvironment: "production", webOrigin: "https://app.syntholo.com" },
    ).toString()).toBe("https://app.syntholo.com/learn?from=dashboard");
    expect(vercelCanonicalRequestUrl(
      internal,
      marker,
      { vercel: undefined, vercelEnvironment: "production", webOrigin: "https://app.syntholo.com" },
    )).toBe(internal);
    expect(vercelCanonicalRequestUrl(
      internal,
      new Headers({ "x-vercel-id": "client-spoof" }),
      { vercel: "1", vercelEnvironment: "production", webOrigin: "https://app.syntholo.com" },
    )).toBe(internal);
  });

  it("cannot use a valid-looking client marker to suppress an external alias redirect", () => {
    const alias = new URL("https://syntholo-git-main-team.vercel.app/learn");
    const reconstructed = vercelCanonicalRequestUrl(
      alias,
      new Headers({ "x-vercel-id": "iad1::client-controlled-value" }),
      { vercel: "1", vercelEnvironment: "production", webOrigin: "https://app.syntholo.com" },
    );
    expect(reconstructed).toBe(alias);
    expect(canonicalRedirectTarget(
      reconstructed,
      { mode: "production", webOrigin: "https://app.syntholo.com" },
    )).toBe("https://app.syntholo.com/learn");
  });
});
