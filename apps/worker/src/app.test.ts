import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWorker } from "./app";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("worker health", () => {
  it("returns the shared release SHA payload", async () => {
    vi.stubEnv("RELEASE_SHA", "gate1");
    const app = buildWorker();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "worker", releaseSha: "gate1" });
    await app.close();
  });
});
