import { DatabaseDependencyUnavailableError, ImplementationCompletionInputError } from "@syntholo/database";
import { describe, expect, it, vi } from "vitest";
import { createImplementationCompletionRecomputeHandler } from "./completion-recompute.js";

describe("implementation completion recompute handler", () => {
  it("records and safely replays the exact course completion event", async () => {
    const recordCourseCompletion = vi.fn(async () => ({ kind: "duplicate" as const }));
    const handler = createImplementationCompletionRecomputeHandler({ recordCourseCompletion });
    await expect(handler({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "implementation.completion_recompute",
    }, new AbortController().signal)).resolves.toBeUndefined();
    expect(recordCourseCompletion).toHaveBeenCalledOnce();
  });

  it("classifies invalid ownership as permanent and dependencies as retryable", async () => {
    const invalid = createImplementationCompletionRecomputeHandler({
      recordCourseCompletion: vi.fn(async () => { throw new ImplementationCompletionInputError(); }),
    });
    await expect(invalid({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "implementation.completion_recompute",
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: "JOB_INPUT_INVALID", permanent: true },
    });
    const dependency = createImplementationCompletionRecomputeHandler({
      recordCourseCompletion: vi.fn(async () => { throw new DatabaseDependencyUnavailableError("lock_timeout"); }),
    });
    await expect(dependency({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "implementation.completion_recompute",
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false },
    });
    const unexpected = new Error("unexpected result decoder failure");
    const buggy = createImplementationCompletionRecomputeHandler({
      recordCourseCompletion: vi.fn(async () => { throw unexpected; }),
    });
    await expect(buggy({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "implementation.completion_recompute",
    }, new AbortController().signal)).rejects.toBe(unexpected);
  });
});
