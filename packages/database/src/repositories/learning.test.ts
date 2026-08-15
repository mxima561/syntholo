import { describe, expect, it, vi } from "vitest";
import { DatabaseDependencyUnavailableError } from "../member-read-deadlines.js";
import { MemberLearningRepository } from "./learning.js";

const actor = {
  kind: "member" as const,
  actorId: "10000000-0000-4000-8000-000000000001",
  clerkUserId: "user_member",
  accountId: "10000000-0000-4000-8000-000000000002",
  membershipId: "10000000-0000-4000-8000-000000000003",
  role: "owner" as const,
  authenticatedAt: new Date("2026-08-15T12:00:00.000Z"),
};
const correlationId = "40000000-0000-4000-8000-000000000001";

describe("member learning repository", () => {
  it("selects exactly one active enrollment/access and reads its course in the same trusted transaction", async () => {
    const course = {
      schemaVersion: 1, enrollmentId: "10000000-0000-4000-8000-000000000004",
      course: { id: "10000000-0000-4000-8000-000000000005", versionId: "10000000-0000-4000-8000-000000000006", title: "Academy", description: "Course" },
      stages: [], progress: { completedRequired: 0, requiredTotal: 18, percent: 0 },
    };
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client = { query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      queries.push({ text, values });
      if (text.includes("from public.enrollments") && text.includes("account_course_accesses")) {
        return { rows: [{ course_id: course.course.id }] };
      }
      return text.includes("syntholo_learning_get_course_v1")
        ? { rows: [{ result: course }] }
        : { rows: [] };
    }), release: vi.fn(), once: vi.fn() };
    const repository = new MemberLearningRepository({ pool: { connect: async () => client } } as never);

    await expect(repository.getDashboardCourse(actor, correlationId)).resolves.toEqual(course);
    expect(queries[2]?.text).toContain("account_course_accesses");
    expect(queries[2]?.text).toContain("join public.memberships");
    expect(queries[2]?.text).toContain("m.member_identity_id=nullif(current_setting('app.actor_id',true),'')::uuid");
    expect(queries[2]?.text).toContain("m.status='active'");
    expect(queries[3]).toMatchObject({
      text: expect.stringContaining("syntholo_learning_get_course_v1"),
      values: [course.course.id],
    });
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns null for no active dashboard enrollment and rejects multiplicity", async () => {
    const connect = (courseIds: readonly string[]) => {
      const client = { query: vi.fn(async (text: string) => text.includes("account_course_accesses")
        ? { rows: courseIds.map((course_id) => ({ course_id })) }
        : { rows: [] }), release: vi.fn(), once: vi.fn() };
      return { client, repository: new MemberLearningRepository({ pool: { connect: async () => client } } as never) };
    };
    const empty = connect([]);
    await expect(empty.repository.getDashboardCourse(actor, correlationId)).resolves.toBeNull();
    expect(empty.client.query.mock.calls.some(([text]) => String(text).includes("syntholo_learning_get_course_v1"))).toBe(false);

    const multiple = connect([
      "10000000-0000-4000-8000-000000000005",
      "10000000-0000-4000-8000-000000000006",
    ]);
    await expect(multiple.repository.getDashboardCourse(actor, correlationId))
      .rejects.toMatchObject({ code: "LEARNING_ENROLLMENT_INTEGRITY" });
  });

  it("sets immutable actor scope and reads only through the closed course command", async () => {
    const course = {
      schemaVersion: 1, enrollmentId: "10000000-0000-4000-8000-000000000004",
      course: { id: "10000000-0000-4000-8000-000000000005", versionId: "10000000-0000-4000-8000-000000000006", title: "Academy", description: "Course" },
      stages: [], progress: { completedRequired: 0, requiredTotal: 18, percent: 0 },
    };
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client = { query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      queries.push({ text, values });
      return text.includes("syntholo_learning_get_course_v1") ? { rows: [{ result: course }] } : { rows: [] };
    }), release: vi.fn(), once: vi.fn() };
    const repository = new MemberLearningRepository({ pool: { connect: async () => client } } as never);
    await expect(repository.getCourse(actor, correlationId, course.course.id)).resolves.toEqual(course);
    expect(queries[1]?.values).toEqual([actor.accountId, actor.actorId, actor.membershipId, correlationId, actor.role, actor.authenticatedAt.toISOString()]);
    expect(queries[2]?.text).toContain("syntholo_learning_get_course_v1");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("passes only the resume position branch and keeps authority out of command input", async () => {
    const progress = { revision: 2, state: "in_progress", lastPath: "transcript", position: { blockId: "transcript-2" } };
    const captured: unknown[][] = [];
    const client = { query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      if (text.includes("syntholo_learning_resume_lesson_v1")) captured.push([...(values ?? [])]);
      return text.includes("syntholo_learning_resume_lesson_v1") ? { rows: [{ result: progress }] } : { rows: [] };
    }), release: vi.fn(), once: vi.fn() };
    const repository = new MemberLearningRepository({ pool: { connect: async () => client } } as never);
    await expect(repository.resumeLesson(actor, correlationId, "10000000-0000-4000-8000-000000000007", {
      expectedVersion: 1, path: "transcript", position: { blockId: "transcript-2" },
    })).resolves.toEqual(progress);
    expect(captured).toEqual([["10000000-0000-4000-8000-000000000007", 1, "transcript", null, "transcript-2"]]);
  });

  it("hashes the exact completion intent and delegates atomic idempotency to the closed command", async () => {
    const result = {
      schemaVersion: 1,
      lessonCompletion: { id: "10000000-0000-4000-8000-000000000008", lessonVersionId: "10000000-0000-4000-8000-000000000009", method: "transcript", completedAt: "2026-08-15T12:00:00.000Z" },
      courseCompletion: null, nextRequiredLessonId: null,
    };
    const captured: unknown[][] = [];
    const client = { query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      if (text.includes("syntholo_learning_complete_lesson_v1")) captured.push([...(values ?? [])]);
      return text.includes("syntholo_learning_complete_lesson_v1") ? { rows: [{ result }] } : { rows: [] };
    }), release: vi.fn(), once: vi.fn() };
    const repository = new MemberLearningRepository({ pool: { connect: async () => client } } as never);
    await repository.completeLesson(actor, correlationId, "10000000-0000-4000-8000-000000000007", { method: "transcript" }, "complete-intent-0001");
    expect(captured[0]?.slice(0, 3)).toEqual(["10000000-0000-4000-8000-000000000007", "transcript", "complete-intent-0001"]);
    expect(captured[0]?.[3]).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("translates an owned pool deadline into dependency unavailable", async () => {
    vi.useFakeTimers();
    try {
      const repository = new MemberLearningRepository({
        pool: { connect: () => new Promise(() => undefined) },
      } as never);
      const pending = repository.getCourse(
        actor,
        correlationId,
        "10000000-0000-4000-8000-000000000005",
        performance.now() + 10,
      );
      const rejected = expect(pending).rejects.toMatchObject({
        name: "DatabaseDependencyUnavailableError",
        kind: "parent_timeout",
      });
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the lock deadline for a blocked resume command and poisons the lease", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Map<string, () => void>();
      const release = vi.fn((destroy?: boolean) => {
        if (destroy) listeners.get("end")?.();
      });
      const client = {
        query: vi.fn((text: string) => text.includes("syntholo_learning_resume_lesson_v1")
          ? new Promise(() => undefined)
          : Promise.resolve({ rows: [] })),
        release,
        once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      };
      const repository = new MemberLearningRepository({ pool: { connect: async () => client } } as never);
      const pending = repository.resumeLesson(
        actor,
        correlationId,
        "10000000-0000-4000-8000-000000000007",
        { expectedVersion: 1, path: "video", position: { seconds: 120 } },
        performance.now() + 8_000,
      );
      const rejected = expect(pending).rejects.toMatchObject({
        name: "DatabaseDependencyUnavailableError",
        kind: "lock_timeout",
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3_000);
      await rejected;
      expect(release).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not rewrite malformed database payloads as dependency failures", async () => {
    const client = {
      query: vi.fn(async (text: string) => text.includes("syntholo_learning_get_course_v1")
        ? { rows: [{ result: { schemaVersion: 999 } }] }
        : { rows: [] }),
      release: vi.fn(),
      once: vi.fn(),
    };
    const repository = new MemberLearningRepository({ pool: { connect: async () => client } } as never);
    const failure = await repository.getCourse(
      actor,
      correlationId,
      "10000000-0000-4000-8000-000000000005",
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(DatabaseDependencyUnavailableError);
  });

  it("does not report an internally ready resource as member-deliverable before an authorized delivery route exists", async () => {
    const lesson = {
      schemaVersion: 1,
      enrollmentId: "10000000-0000-4000-8000-000000000004",
      courseVersionId: "10000000-0000-4000-8000-000000000005",
      lessonId: "10000000-0000-4000-8000-000000000006",
      lessonVersionId: "10000000-0000-4000-8000-000000000007",
      title: "Academy lesson", summary: "A valid member lesson.", durationSeconds: 600,
      blocks: [], transcript: { schemaVersion: 1, blocks: [] },
      resources: [{
        id: "10000000-0000-4000-8000-000000000008", label: "Worksheet",
        accessibleLabel: "Download worksheet", delivery: "private_blob",
        mime: "application/pdf", byteSize: 1024, availability: "ready",
      }],
      progress: { revision: null, state: "not_started", lastPath: null, position: null },
      previousRequiredLessonId: null, nextRequiredLessonId: null,
    };
    const client = {
      query: vi.fn(async (text: string) => text.includes("syntholo_learning_get_lesson_v1")
        ? { rows: [{ result: lesson }] }
        : { rows: [] }),
      release: vi.fn(), once: vi.fn(),
    };
    const repository = new MemberLearningRepository({ pool: { connect: async () => client } } as never);
    await expect(repository.getLesson(actor, correlationId, lesson.lessonId)).resolves.toMatchObject({
      resources: [{ availability: "unavailable" }],
    });
  });

  it("does not trust a database error that only contains a learning code as a substring", async () => {
    const unknownFailure = new Error("unexpected LEARNING_LESSON_NOT_FOUND suffix");
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("syntholo_learning_get_lesson_v1")) throw unknownFailure;
        return { rows: [] };
      }),
      release: vi.fn(),
      once: vi.fn(),
    };
    const repository = new MemberLearningRepository({ pool: { connect: async () => client } } as never);
    await expect(repository.getLesson(
      actor,
      correlationId,
      "10000000-0000-4000-8000-000000000007",
    )).rejects.toBe(unknownFailure);
  });

  it("poisons a lease when rollback cannot be confirmed", async () => {
    const listeners = new Map<string, () => void>();
    const release = vi.fn((destroy?: boolean) => {
      if (destroy) listeners.get("end")?.();
    });
    const integrityFailure = Object.assign(new Error("duplicate completion"), { code: "23505" });
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("syntholo_learning_complete_lesson_v1")) throw integrityFailure;
        if (text === "rollback") throw new Error("connection lost during rollback");
        return { rows: [] };
      }),
      release,
      once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    };
    const repository = new MemberLearningRepository({ pool: { connect: async () => client } } as never);
    await expect(repository.completeLesson(
      actor,
      correlationId,
      "10000000-0000-4000-8000-000000000007",
      { method: "transcript" },
      "complete-intent-0001",
    )).rejects.toBe(integrityFailure);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
