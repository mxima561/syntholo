import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "./app";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("api health", () => {
  it("returns the shared release SHA payload", async () => {
    vi.stubEnv("RELEASE_SHA", "gate1");
    const app = buildApi();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "api", releaseSha: "gate1" });
    await app.close();
  });
});
