import { describe, expect, it, vi } from "vitest";
import { ImplementationCompletionInputError, WorkerImplementationRepository } from "./implementation-worker.js";

describe("worker implementation repository", () => {
  it("recomputes completion only through the closed event command", async () => {
    const query = vi.fn(async () => ({ rows: [{ outcome: "recorded" }] }));
    const release = vi.fn();
    const repository = new WorkerImplementationRepository({ pool: { connect: vi.fn(async () => ({ query, release })) } } as never);
    await expect(repository.recordCourseCompletion({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "implementation.completion_recompute",
    })).resolves.toEqual({ kind: "recorded" });
    expect(query).toHaveBeenCalledWith(
      "select public.syntholo_implementation_record_course_completion_v1($1,$2) outcome",
      ["10000000-0000-4000-8000-000000000001", "implementation.completion_recompute"],
    );
  });

  it("rejects a mismatched event before acquiring a lease", async () => {
    const connect = vi.fn();
    const repository = new WorkerImplementationRepository({ pool: { connect } } as never);
    await expect(repository.recordCourseCompletion({
      eventId: "bad",
      handlerName: "implementation.completion_recompute",
    })).rejects.toBeInstanceOf(ImplementationCompletionInputError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("maps only the exact database event rejection to terminal input", async () => {
    const rejected = vi.fn(async () => { throw new Error("IMPLEMENTATION_EVENT_INPUT_INVALID"); });
    const release = vi.fn();
    const repository = new WorkerImplementationRepository({ pool: { connect: vi.fn(async () => ({ query: rejected, release })) } } as never);
    await expect(repository.recordCourseCompletion({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "implementation.completion_recompute",
    })).rejects.toBeInstanceOf(ImplementationCompletionInputError);

    const arbitrary = new Error("db down");
    const dependency = new WorkerImplementationRepository({ pool: { connect: vi.fn(async () => ({ query: vi.fn(async () => { throw arbitrary; }), release: vi.fn() })) } } as never);
    await expect(dependency.recordCourseCompletion({
      eventId: "10000000-0000-4000-8000-000000000001",
      handlerName: "implementation.completion_recompute",
    })).rejects.toBe(arbitrary);
  });
});
