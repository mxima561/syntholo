import { describe, expect, it, vi } from "vitest";
import { createContentReadinessRecomputeHandler } from "./readiness-recompute.js";

describe("content readiness recompute handler", () => {
  it("invokes the closed exact event/handler command", async () => {
    const recompute = vi.fn(async () => ({ kind: "evaluated" as const }));
    const handler = createContentReadinessRecomputeHandler({ recompute });
    const signal = new AbortController().signal;
    await handler({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "content.readiness_recompute",
    }, signal);
    expect(recompute).toHaveBeenCalledWith({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "content.readiness_recompute",
    });
  });

  it("classifies closed-command dependency failures as retryable", async () => {
    const handler = createContentReadinessRecomputeHandler({
      recompute: vi.fn(async () => { throw new Error("private database detail"); }),
    });
    await expect(handler({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "content.readiness_recompute",
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false },
    });
  });
});
