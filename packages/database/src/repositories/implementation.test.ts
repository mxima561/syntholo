import { canonicalizeArtifactContent } from "@syntholo/domain/implementation";
import { describe, expect, it, vi } from "vitest";

async function loadRepository() {
  return import("./implementation.js").catch(() => null);
}

const actor = {
  kind: "member",
  actorId: "10000000-0000-4000-8000-000000000001",
  clerkUserId: "user_test",
  accountId: "10000000-0000-4000-8000-000000000002",
  membershipId: "10000000-0000-4000-8000-000000000003",
  role: "owner",
  authenticatedAt: new Date("2026-08-15T12:00:00.000Z"),
} as const;
const correlationId = "10000000-0000-4000-8000-000000000004";
const artifactId = "10000000-0000-4000-8000-000000000005";
const content = {
  kind: "ai_policy",
  purpose: "Set safe team boundaries.",
  approvedUses: ["Draft internal summaries"],
  prohibitedUses: ["Make final hiring decisions"],
  humanReviewRules: ["A person approves external claims"],
} satisfies import("@syntholo/contracts/implementation").ArtifactContent;

describe("member implementation repository", () => {
  it("rejects an invalid history cursor secret when the dependency is constructed", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    expect(() => new module.MemberImplementationRepository(
      { pool: { connect: async () => { throw new Error("must not connect"); } } } as never,
      "too-short",
    )).toThrow("IMPLEMENTATION_CURSOR_SECRET_INVALID");
  });

  it("executes one receipt-backed save and verifies returned content hash", async () => {
    const module = await loadRepository();
    expect(module, "implementation repository must exist").not.toBeNull();
    if (module === null) return;
    const hash = canonicalizeArtifactContent(content).hash;
    const response = {
      schemaVersion: 1,
      artifact: { id: artifactId, kind: "ai_policy", title: "Team AI policy", currentVersion: 1, currentState: "draft", currentVersionId: "10000000-0000-4000-8000-000000000006", updatedAt: "2026-08-15T12:00:00.000Z", authorLabel: "You" },
      version: { id: "10000000-0000-4000-8000-000000000006", version: 1, state: "draft", contentHash: hash, createdAt: "2026-08-15T12:00:00.000Z", authorLabel: "You" },
      content,
      implementationCompletion: { completed: false, completedAt: null },
    } as const;
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        queries.push({ text, values });
        return text.includes("syntholo_implementation_save_version_v1")
          ? { rows: [{ result: response }] }
          : { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = new module.MemberImplementationRepository(
      { pool: { connect: async () => client } } as never,
      "cursor-secret-that-is-at-least-32-bytes-long",
    );
    await expect(repository.saveVersion(actor, correlationId, artifactId, {
      expectedVersion: 0,
      state: "draft",
      content,
    }, "intent_1234567890")).resolves.toEqual(response);
    expect(queries.map(({ text }) => text.trim().split(/\s+/u)[0])).toEqual([
      "begin", "select", "select", "commit",
    ]);
    expect(queries[2]?.text).toContain("syntholo_implementation_save_version_v1");
    expect(queries[2]?.values?.slice(0, 5)).toEqual([
      artifactId, 0, "draft", JSON.stringify(content), "intent_1234567890",
    ]);
    expect(queries[2]?.values?.[5]).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("redacts unexpected database and decoder failures without logging artifact content", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const marker = "PRIVATE_ARTIFACT_MARKER";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = {
      query: vi.fn(async (text: string) => {
        if (text === "begin" || text.startsWith("select set_config") || text === "rollback") {
          return { rows: [] };
        }
        const error = new Error("database check failed");
        Object.assign(error, { detail: `Failing row contains ${marker}` });
        throw error;
      }),
      release: vi.fn(),
    };
    const repository = new module.MemberImplementationRepository(
      { pool: { connect: async () => client } } as never,
      "cursor-secret-that-is-at-least-32-bytes-long",
    );
    let thrown: unknown;
    try {
      await repository.saveVersion(actor, correlationId, artifactId, {
        expectedVersion: 0,
        state: "draft",
        content: { ...content, purpose: marker },
      }, "intent_1234567890");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "IMPLEMENTATION_DEPENDENCY_FAILED" });
    expect(JSON.stringify(thrown)).not.toContain(marker);
    expect(String(thrown)).not.toContain(marker);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("authenticates opaque history cursors to principal, account, route, artifact, and limit", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const binding = {
      accountId: actor.accountId,
      actorId: actor.actorId,
      membershipId: actor.membershipId,
      artifactId,
      limit: 25,
    } as const;
    const secret = "cursor-secret-that-is-at-least-32-bytes-long";
    const cursor = module.encodeImplementationHistoryCursor({
      createdAt: "2026-08-15T12:00:00.000Z",
      id: "10000000-0000-4000-8000-000000000006",
    }, binding, secret);
    expect(cursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/u);
    expect(module.decodeImplementationHistoryCursor(cursor, binding, secret)).toEqual({
      createdAt: "2026-08-15T12:00:00.000Z",
      id: "10000000-0000-4000-8000-000000000006",
    });
    for (const mismatch of [
      { artifactId: "10000000-0000-4000-8000-000000000099" },
      { accountId: "10000000-0000-4000-8000-000000000099" },
      { membershipId: "10000000-0000-4000-8000-000000000099" },
      { actorId: "10000000-0000-4000-8000-000000000099" },
      { limit: 26 },
    ] as const) {
      expect(() => module.decodeImplementationHistoryCursor(
        cursor,
        { ...binding, ...mismatch },
        secret,
      )).toThrow("IMPLEMENTATION_CURSOR_INVALID");
    }
    const last = cursor.at(-1)!;
    const flipped = `${cursor.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    expect(() => module.decodeImplementationHistoryCursor(flipped, binding, secret))
      .toThrow("IMPLEMENTATION_CURSOR_INVALID");
  });
});

describe("system implementation repository", () => {
  it("seeds five roots through only the closed system command", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const query = vi.fn(async (text: string) => text.includes("syntholo_implementation_seed_workspace_v1")
      ? { rows: [{ outcome: "seeded" }] }
      : { rows: [] });
    const release = vi.fn();
    const repository = new module.SystemImplementationRepository({ pool: { connect: async () => ({ query, release }) } } as never);
    await expect(repository.seedWorkspace({
      accountCourseAccessId: "10000000-0000-4000-8000-000000000010",
      actorId: "commerce-fulfillment",
      correlationId,
    })).resolves.toEqual({ kind: "seeded" });
    expect(query).toHaveBeenCalledWith(
      "select public.syntholo_implementation_seed_workspace_v1($1) outcome",
      ["10000000-0000-4000-8000-000000000010"],
    );
  });

  it("preserves typed abort and parent-deadline dependency failures", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const connect = vi.fn(async () => new Promise<never>(() => undefined));
    const repository = new module.SystemImplementationRepository({ pool: { connect } } as never);
    const input = {
      accountCourseAccessId: "10000000-0000-4000-8000-000000000010",
      actorId: "commerce-fulfillment",
      correlationId,
    } as const;
    const controller = new AbortController();
    controller.abort();
    await expect(repository.seedWorkspace(input, controller.signal)).rejects.toMatchObject({
      code: "DATABASE_DEPENDENCY_UNAVAILABLE",
      kind: "parent_timeout",
      name: "DatabaseDependencyUnavailableError",
    });
    expect(connect).not.toHaveBeenCalled();

    await expect(repository.seedWorkspace(input, undefined, performance.now()))
      .rejects.toMatchObject({
        code: "DATABASE_DEPENDENCY_UNAVAILABLE",
        kind: "parent_timeout",
        name: "DatabaseDependencyUnavailableError",
      });
  });
});
