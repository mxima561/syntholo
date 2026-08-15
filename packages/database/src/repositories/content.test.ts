import { describe, expect, it, vi } from "vitest";
import { DatabaseDependencyUnavailableError } from "../member-read-deadlines.js";
import { ContentCommandConflictError, StaffContentCommandRepository } from "./content.js";

describe("staff content command repository", () => {
  it("derives a preview through the stable read-only command", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        queries.push({ text, values });
        return text.includes("syntholo_content_get_preview_v1")
          ? { rows: [{ result: {
              draftRevision: 2, candidateManifestHash: "e".repeat(64),
              manifest: { schemaVersion: 1, course: {}, stages: [] }, publicationIssues: [],
            } }] }
          : { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = new StaffContentCommandRepository({ pool: { connect: async () => client } } as never);
    await expect(repository.getPreview({
      actorId: "10000000-0000-4000-8000-000000000001",
      correlationId: "40000000-0000-4000-8000-000000000001",
      courseId: "10000000-0000-4000-8000-000000000010",
      draftRevision: 2,
    })).resolves.toMatchObject({ draftRevision: 2, candidateManifestHash: "e".repeat(64) });
    expect(queries.map(({ text }) => text.trim().split(/\s+/u).slice(0, 2).join(" ")))
      .toEqual(["begin read", "select set_config('app.actor_kind','staff',true),", "select public.syntholo_content_get_preview_v1($1,$2)", "commit"]);
    expect(queries.find(({ text }) => text.includes("syntholo_content_get_preview_v1"))?.values)
      .toEqual(["10000000-0000-4000-8000-000000000010", 2]);
  });

  it("calls the server-derived preview command without accepting caller manifest authority", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        queries.push({ text, values });
        if (text.includes("syntholo_content_create_preview_v3")) return { rows: [{ result: {
          previewId: "10000000-0000-4000-8000-000000000011", manifestHash: "ee9d08482a22b7f2fbdf693bb29d0d868592d16623c4765693553c52221c36d5",
          manifest: { course: { id: "course" }, schemaVersion: 1, stages: [] }, publicationIssues: [], createdAt: "2026-08-14T16:00:00.000Z",
        } }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = new StaffContentCommandRepository({ pool: { connect: async () => client } } as never);
    const result = await repository.createPreview({
      actorId: "10000000-0000-4000-8000-000000000001",
      correlationId: "40000000-0000-4000-8000-000000000001",
      courseId: "10000000-0000-4000-8000-000000000010", expectedVersion: 2,
      reason: "Curriculum review", idempotencyKey: "preview-intent-0001",
    });
    expect(result.previewId).toBe("10000000-0000-4000-8000-000000000011");
    expect(queries.map(({ text }) => text.trim().split(/\s+/u)[0])).toEqual(["begin", "select", "select", "commit"]);
    const command = queries[2];
    expect(command?.text).toContain("syntholo_content_create_preview_v3");
    expect(command?.values).toEqual([
      "10000000-0000-4000-8000-000000000010",
      2,
      "Curriculum review",
      "preview-intent-0001",
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the lease without exposing database details", async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("syntholo_content_create_preview_v3")) throw new Error("postgres://secret");
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = new StaffContentCommandRepository({ pool: { connect: async () => client } } as never);
    await expect(repository.createPreview({
      actorId: "10000000-0000-4000-8000-000000000001", correlationId: "40000000-0000-4000-8000-000000000001",
      courseId: "10000000-0000-4000-8000-000000000010", expectedVersion: 2, reason: "Review", idempotencyKey: "preview-intent-0002",
    })).rejects.toThrow("CONTENT_COMMAND_FAILED");
    expect(client.query).toHaveBeenCalledWith("rollback", []);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("publishes through the closed course command and returns the compare-and-swapped head", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        queries.push({ text, values });
        if (text.includes("syntholo_content_publish_course_v2")) return { rows: [{ result: {
          id: "10000000-0000-4000-8000-000000000020",
          courseId: "10000000-0000-4000-8000-000000000010",
          version: 3,
          manifestHash: "ee9d08482a22b7f2fbdf693bb29d0d868592d16623c4765693553c52221c36d5",
          headRevision: 2,
          publishedAt: "2026-08-14T16:30:00.000Z",
        } }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = new StaffContentCommandRepository({ pool: { connect: async () => client } } as never);
    const result = await repository.publishCourse({
      actorId: "10000000-0000-4000-8000-000000000001",
      correlationId: "40000000-0000-4000-8000-000000000001",
      courseId: "10000000-0000-4000-8000-000000000010",
      previewId: "10000000-0000-4000-8000-000000000011",
      expectedManifestHash: "ee9d08482a22b7f2fbdf693bb29d0d868592d16623c4765693553c52221c36d5",
      expectedHeadRevision: 1,
      reason: "Approved launch publication",
      idempotencyKey: "publish-intent-0001",
    });
    expect(result).toEqual({
      id: "10000000-0000-4000-8000-000000000020",
      courseId: "10000000-0000-4000-8000-000000000010",
      version: 3,
      manifestHash: "ee9d08482a22b7f2fbdf693bb29d0d868592d16623c4765693553c52221c36d5",
      headRevision: 2,
      publishedAt: "2026-08-14T16:30:00.000Z",
    });
    expect(queries.map(({ text }) => text.trim().split(/\s+/u)[0])).toEqual(["begin", "select", "select", "commit"]);
    expect(queries[2]?.values).toEqual([
      "10000000-0000-4000-8000-000000000011",
      "ee9d08482a22b7f2fbdf693bb29d0d868592d16623c4765693553c52221c36d5",
      1,
      "Approved launch publication",
      "publish-intent-0001",
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects an untyped publication issue returned by the database", async () => {
    const client = {
      query: vi.fn(async (text: string) => text.includes("syntholo_content_create_preview_v3")
        ? { rows: [{ result: {
          previewId: "10000000-0000-4000-8000-000000000011",
          manifestHash: "ee9d08482a22b7f2fbdf693bb29d0d868592d16623c4765693553c52221c36d5",
          manifest: { course: { id: "course" }, schemaVersion: 1, stages: [] },
          publicationIssues: [{ code: "VIDEO_NOT_READY", field: "mediaAssetId", lessonId: null, providerError: "private" }],
          createdAt: "2026-08-14T16:00:00.000Z",
        } }] }
        : { rows: [] }),
      release: vi.fn(),
    };
    const repository = new StaffContentCommandRepository({ pool: { connect: async () => client } } as never);
    await expect(repository.createPreview({
      actorId: "10000000-0000-4000-8000-000000000001",
      correlationId: "40000000-0000-4000-8000-000000000001",
      courseId: "10000000-0000-4000-8000-000000000010", expectedVersion: 2,
      reason: "Review", idempotencyKey: "preview-intent-0003",
    })).rejects.toThrow("CONTENT_COMMAND_FAILED");
  });

  it("publishes a lesson through the receipt-backed single-source command", async () => {
    const captured: unknown[][] = [];
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        if (text.includes("syntholo_content_publish_lesson_v2")) {
          captured.push([...(values ?? [])]);
          return { rows: [{ result: {
            id: "10000000-0000-4000-8000-000000000020", lessonId: "10000000-0000-4000-8000-000000000010",
            courseId: "10000000-0000-4000-8000-000000000011", version: 2, contentHash: "e".repeat(64),
            publishedAt: "2026-08-14T16:30:00.000Z",
          } }] };
        }
        return { rows: [] };
      }), release: vi.fn(), once: vi.fn(),
    };
    const repository = new StaffContentCommandRepository({ pool: { connect: async () => client } } as never);
    await expect(repository.publishLesson({
      actorId: "10000000-0000-4000-8000-000000000001", correlationId: "40000000-0000-4000-8000-000000000001",
      lessonId: "10000000-0000-4000-8000-000000000010", expectedVersion: 2, reason: "Approved lesson",
      idempotencyKey: "lesson-publish-0001",
    })).resolves.toMatchObject({ lessonId: "10000000-0000-4000-8000-000000000010", version: 2 });
    expect(captured[0]?.slice(0, 4)).toEqual(["10000000-0000-4000-8000-000000000010", 2, "Approved lesson", "lesson-publish-0001"]);
    expect(captured[0]?.[4]).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each(["CONTENT_NOT_READY", "MANIFEST_CHANGED", "COURSE_HEAD_CHANGED", "PREVIEW_ALREADY_PUBLISHED", "IDEMPOTENCY_KEY_REUSED", "IDEMPOTENCY_IN_PROGRESS", "VERSION_CONFLICT", "LESSON_DRAFT_ALREADY_PUBLISHED"] as const)(
    "preserves the typed %s conflict without leaking database details",
    async (code) => {
      const client = {
        query: vi.fn(async (text: string) => {
          if (text.includes("syntholo_content_publish_course_v2")) throw new Error(code);
          return { rows: [] };
        }),
        release: vi.fn(),
      };
      const repository = new StaffContentCommandRepository({ pool: { connect: async () => client } } as never);
      const result = repository.publishCourse({
        actorId: "10000000-0000-4000-8000-000000000001",
        correlationId: "40000000-0000-4000-8000-000000000001",
        courseId: "10000000-0000-4000-8000-000000000010",
        previewId: "10000000-0000-4000-8000-000000000011",
        expectedManifestHash: "e".repeat(64), expectedHeadRevision: 1, reason: "Approved",
        idempotencyKey: "publish-intent-0001",
      });
      await expect(result).rejects.toBeInstanceOf(ContentCommandConflictError);
      await expect(result).rejects.toMatchObject({ code });
    },
  );

  it("preserves only validated publication issues from CONTENT_NOT_READY detail", async () => {
    const issue = { code: "VIDEO_NOT_READY", field: "mediaAssetId", lessonId: "10000000-0000-4000-8000-000000000010" } as const;
    const databaseError = Object.assign(new Error("CONTENT_NOT_READY"), {
      detail: JSON.stringify([issue]),
    });
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("syntholo_content_publish_course_v2")) throw databaseError;
        return { rows: [] };
      }), release: vi.fn(), once: vi.fn(),
    };
    const repository = new StaffContentCommandRepository({ pool: { connect: async () => client } } as never);
    const result = repository.publishCourse({
      actorId: "10000000-0000-4000-8000-000000000001", correlationId: "40000000-0000-4000-8000-000000000001",
      courseId: "10000000-0000-4000-8000-000000000010", previewId: "10000000-0000-4000-8000-000000000011",
      expectedManifestHash: "e".repeat(64), expectedHeadRevision: 1, reason: "Approved", idempotencyKey: "publish-intent-0001",
    });
    await expect(result).rejects.toMatchObject({ code: "CONTENT_NOT_READY", publicationIssues: [issue] });

    databaseError.detail = JSON.stringify([{ ...issue, providerSecret: "do-not-leak" }]);
    const malformed = repository.publishCourse({
      actorId: "10000000-0000-4000-8000-000000000001", correlationId: "40000000-0000-4000-8000-000000000001",
      courseId: "10000000-0000-4000-8000-000000000010", previewId: "10000000-0000-4000-8000-000000000011",
      expectedManifestHash: "e".repeat(64), expectedHeadRevision: 1, reason: "Approved", idempotencyKey: "publish-intent-0002",
    });
    await expect(malformed).rejects.toMatchObject({ code: "CONTENT_NOT_READY", publicationIssues: undefined });
  });

  it("translates an owned pool deadline without rewriting unknown payload errors", async () => {
    vi.useFakeTimers();
    try {
      const repository = new StaffContentCommandRepository({ pool: { connect: () => new Promise(() => undefined) } } as never);
      const pending = repository.createPreview({
        actorId: "10000000-0000-4000-8000-000000000001", correlationId: "40000000-0000-4000-8000-000000000001",
        courseId: "10000000-0000-4000-8000-000000000010", expectedVersion: 2, reason: "Review", idempotencyKey: "preview-intent-0004",
      }, performance.now() + 10);
      const rejected = expect(pending).rejects.toMatchObject({ name: "DatabaseDependencyUnavailableError", kind: "parent_timeout" });
      await vi.advanceTimersByTimeAsync(10); await rejected;
    } finally { vi.useRealTimers(); }
  });

  it("uses the lock deadline for publication and poisons the blocked lease", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Map<string, () => void>();
      const release = vi.fn((destroy?: boolean) => { if (destroy) listeners.get("end")?.(); });
      const client = {
        query: vi.fn((text: string) => text.includes("syntholo_content_publish_course_v2") ? new Promise(() => undefined) : Promise.resolve({ rows: [] })),
        release, once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      };
      const repository = new StaffContentCommandRepository({ pool: { connect: async () => client } } as never);
      const pending = repository.publishCourse({
        actorId: "10000000-0000-4000-8000-000000000001", correlationId: "40000000-0000-4000-8000-000000000001",
        courseId: "10000000-0000-4000-8000-000000000010", previewId: "10000000-0000-4000-8000-000000000011",
        expectedManifestHash: "e".repeat(64), expectedHeadRevision: 1, reason: "Approved",
        idempotencyKey: "publish-intent-0001",
      }, performance.now() + 8_000);
      const rejected = expect(pending).rejects.toMatchObject({ name: "DatabaseDependencyUnavailableError", kind: "lock_timeout" });
      await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(3_000); await rejected;
      expect(release).toHaveBeenCalledExactlyOnceWith(true);
    } finally { vi.useRealTimers(); }
  });

  it("does not classify malformed command output as a dependency failure", async () => {
    const client = { query: vi.fn(async (text: string) => text.includes("syntholo_content_publish_course_v2") ? { rows: [{ result: { private: "bad" } }] } : { rows: [] }), release: vi.fn(), once: vi.fn() };
    const repository = new StaffContentCommandRepository({ pool: { connect: async () => client } } as never);
    const failure = await repository.publishCourse({
      actorId: "10000000-0000-4000-8000-000000000001", correlationId: "40000000-0000-4000-8000-000000000001",
      courseId: "10000000-0000-4000-8000-000000000010", previewId: "10000000-0000-4000-8000-000000000011",
      expectedManifestHash: "e".repeat(64), expectedHeadRevision: 1, reason: "Approved", idempotencyKey: "publish-intent-0001",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error); expect(failure).not.toBeInstanceOf(DatabaseDependencyUnavailableError);
  });

  it("poisons a staff lease when rollback cannot be confirmed", async () => {
    const listeners = new Map<string, () => void>();
    const release = vi.fn((destroy?: boolean) => { if (destroy) listeners.get("end")?.(); });
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("syntholo_content_create_preview_v3")) throw new Error("integrity failure");
        if (text === "rollback") throw new Error("rollback failed");
        return { rows: [] };
      }), release, once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    };
    const repository = new StaffContentCommandRepository({ pool: { connect: async () => client } } as never);
    await expect(repository.createPreview({
      actorId: "10000000-0000-4000-8000-000000000001", correlationId: "40000000-0000-4000-8000-000000000001",
      courseId: "10000000-0000-4000-8000-000000000010", expectedVersion: 2, reason: "Review", idempotencyKey: "preview-intent-0005",
    })).rejects.toThrow("CONTENT_COMMAND_FAILED");
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
