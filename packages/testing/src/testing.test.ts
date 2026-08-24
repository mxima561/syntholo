import { describe, expect, it } from "vitest";
import {
  createFixture,
  day,
  hour,
  memberActor,
  minute,
  staffActor,
} from "@syntholo/testing";

describe("test clock", () => {
  it("returns deterministic dates relative to the test epoch", () => {
    expect(minute(1).toISOString()).toBe("2026-01-01T12:01:00.000Z");
    expect(hour(-1).toISOString()).toBe("2026-01-01T11:00:00.000Z");
    expect(day(1).toISOString()).toBe("2026-01-02T12:00:00.000Z");
  });
});

describe("actor factories", () => {
  it("returns a complete member actor with deterministic defaults", () => {
    expect(memberActor()).toEqual({
      kind: "member",
      actorId: "actor_member",
      clerkUserId: "user_member",
      accountId: "account_1",
      membershipId: "membership_1",
      role: "owner",
      authenticatedAt: new Date("2026-01-01T12:00:00.000Z"),
    });
  });

  it("returns a complete staff actor with deterministic defaults", () => {
    expect(staffActor()).toEqual({
      kind: "staff",
      actorId: "actor_staff",
      accessUserId: "removed_user_staff",
      staffId: "staff_1",
      role: "coach",
      permissions: ["content:publish"],
      authenticatedAt: new Date("2026-01-01T12:00:00.000Z"),
    });
  });

  it("applies actor patches", () => {
    expect(memberActor({ role: "teammate" }).role).toBe("teammate");
    expect(staffActor({ role: "admin", permissions: [] })).toMatchObject({
      role: "admin",
      permissions: [],
    });
  });
});

describe("createFixture", () => {
  it("applies a partial patch to deterministic domain defaults", () => {
    const buildStatus = createFixture(() => ({ state: "draft", priority: 1 }));

    expect(buildStatus({ priority: 2 })).toEqual({
      state: "draft",
      priority: 2,
    });
  });

  it("isolates nested defaults between fixtures", () => {
    const buildDocument = createFixture(() => ({
      metadata: { tags: ["draft"] },
      createdAt: new Date("2026-01-01T12:00:00.000Z"),
    }));
    const first = buildDocument();

    first.metadata.tags.push("mutated");
    first.createdAt.setUTCDate(2);

    expect(buildDocument()).toEqual({
      metadata: { tags: ["draft"] },
      createdAt: new Date("2026-01-01T12:00:00.000Z"),
    });
  });
});
