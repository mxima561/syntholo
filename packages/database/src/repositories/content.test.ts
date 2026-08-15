import { describe, expect, it, vi } from "vitest";
import { ContentCommandConflictError, StaffContentCommandRepository } from "./content.js";

describe("staff content command repository", () => {
  it("derives canonical manifest bytes/hash and calls only the closed preview command in one staff transaction", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        queries.push({ text, values });
        if (text.includes("syntholo_content_create_preview_v1")) return { rows: [{
          id: "10000000-0000-4000-8000-000000000011", manifest_hash: "ee9d08482a22b7f2fbdf693bb29d0d868592d16623c4765693553c52221c36d5",
          manifest_projection: { course: { id: "course" }, schemaVersion: 1, stages: [] }, publication_issues: [], created_at: new Date("2026-08-14T16:00:00.000Z"),
        }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = new StaffContentCommandRepository({ pool: { connect: async () => client } } as never);
    const result = await repository.createPreview({
      actorId: "10000000-0000-4000-8000-000000000001",
      correlationId: "40000000-0000-4000-8000-000000000001",
      courseId: "10000000-0000-4000-8000-000000000010", expectedVersion: 2,
      reason: "Curriculum review", manifest: { stages: [], schemaVersion: 1, course: { id: "course" } },
      publicationIssues: [],
    });
    expect(result.previewId).toBe("10000000-0000-4000-8000-000000000011");
    expect(queries.map(({ text }) => text.trim().split(/\s+/u)[0])).toEqual(["begin", "select", "select", "commit"]);
    const command = queries[2];
    expect(command?.values?.[2]).toBe('{"course":{"id":"course"},"schemaVersion":1,"stages":[]}');
    expect(command?.values?.[3]).toBe("ee9d08482a22b7f2fbdf693bb29d0d868592d16623c4765693553c52221c36d5");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the lease without exposing database details", async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("syntholo_content_create_preview_v1")) throw new Error("postgres://secret");
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = new StaffContentCommandRepository({ pool: { connect: async () => client } } as never);
    await expect(repository.createPreview({
      actorId: "10000000-0000-4000-8000-000000000001", correlationId: "40000000-0000-4000-8000-000000000001",
      courseId: "10000000-0000-4000-8000-000000000010", expectedVersion: 2, reason: "Review",
      manifest: { schemaVersion: 1, course: {}, stages: [] }, publicationIssues: [],
    })).rejects.toThrow("CONTENT_COMMAND_FAILED");
    expect(client.query).toHaveBeenCalledWith("rollback");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("publishes through the closed course command and returns the compare-and-swapped head", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        queries.push({ text, values });
        if (text.includes("syntholo_content_publish_course_v1")) return { rows: [{
          id: "10000000-0000-4000-8000-000000000020",
          course_id: "10000000-0000-4000-8000-000000000010",
          version: 3,
          manifest_hash: "ee9d08482a22b7f2fbdf693bb29d0d868592d16623c4765693553c52221c36d5",
          head_revision: 2,
          published_at: new Date("2026-08-14T16:30:00.000Z"),
        }] };
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
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects an untyped publication issue returned by the database", async () => {
    const client = {
      query: vi.fn(async (text: string) => text.includes("syntholo_content_create_preview_v1")
        ? { rows: [{
          id: "10000000-0000-4000-8000-000000000011",
          manifest_hash: "ee9d08482a22b7f2fbdf693bb29d0d868592d16623c4765693553c52221c36d5",
          manifest_projection: { course: { id: "course" }, schemaVersion: 1, stages: [] },
          publication_issues: [{ code: "VIDEO_NOT_READY", field: "mediaAssetId", lessonId: null, providerError: "private" }],
          created_at: new Date("2026-08-14T16:00:00.000Z"),
        }] }
        : { rows: [] }),
      release: vi.fn(),
    };
    const repository = new StaffContentCommandRepository({ pool: { connect: async () => client } } as never);
    await expect(repository.createPreview({
      actorId: "10000000-0000-4000-8000-000000000001",
      correlationId: "40000000-0000-4000-8000-000000000001",
      courseId: "10000000-0000-4000-8000-000000000010", expectedVersion: 2,
      reason: "Review", manifest: { schemaVersion: 1, course: { id: "course" }, stages: [] },
      publicationIssues: [],
    })).rejects.toThrow("CONTENT_COMMAND_FAILED");
  });

  it.each(["CONTENT_NOT_READY", "MANIFEST_CHANGED", "COURSE_HEAD_CHANGED"] as const)(
    "preserves the typed %s conflict without leaking database details",
    async (code) => {
      const client = {
        query: vi.fn(async (text: string) => {
          if (text.includes("syntholo_content_publish_course_v1")) throw new Error(code);
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
      });
      await expect(result).rejects.toBeInstanceOf(ContentCommandConflictError);
      await expect(result).rejects.toMatchObject({ code });
    },
  );
});
