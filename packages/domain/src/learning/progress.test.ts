import { describe, expect, it } from "vitest";
import { availableAtForReleaseRule, courseIsComplete, nextProgressProjection } from "./progress.js";

describe("learning progress rules", () => {
  it("uses the server enrollment time and inclusive UTC release boundary", () => {
    const enrolledAt = new Date("2026-08-01T12:00:00.000Z");
    expect(availableAtForReleaseRule({ kind: "immediate" }, enrolledAt).toISOString())
      .toBe("2026-08-01T12:00:00.000Z");
    expect(availableAtForReleaseRule({ kind: "elapsed_days", days: 2 }, enrolledAt).toISOString())
      .toBe("2026-08-03T12:00:00.000Z");
    expect(availableAtForReleaseRule({ kind: "fixed_at", at: "2026-08-05T09:30:00.000Z" }, enrolledAt).toISOString())
      .toBe("2026-08-05T09:30:00.000Z");
  });

  it("requires exactly 18 required lessons while ignoring bonus lessons", () => {
    const required = Array.from({ length: 18 }, (_, index) => `required-${index + 1}`);
    expect(courseIsComplete({ requiredLessonIds: required, completedLessonIds: required.slice(0, 17) })).toBe(false);
    expect(courseIsComplete({ requiredLessonIds: required, completedLessonIds: [...required, "bonus-1"] })).toBe(true);
    expect(courseIsComplete({ requiredLessonIds: required.slice(0, 17), completedLessonIds: required })).toBe(false);
  });

  it("never lets a late resume demote immutable completion", () => {
    expect(nextProgressProjection({
      completed: true,
      current: { revision: 3, lastPath: "transcript", position: { blockId: "p-1" } },
      update: { expectedVersion: 3, path: "video", position: { seconds: 120 } },
    })).toEqual({
      revision: 3, state: "completed", lastPath: "transcript", position: { blockId: "p-1" }, changed: false,
    });
  });

  it("keeps completion-without-resume null when a late resume arrives", () => {
    expect(nextProgressProjection({
      completed: true,
      current: null,
      update: { expectedVersion: 0, path: "transcript", position: { blockId: "p-1" } },
    })).toEqual({
      revision: null, state: "completed", lastPath: null, position: null, changed: false,
    });
  });

  it("replays the same PUT state before applying stale-version rejection", () => {
    const current = { revision: 4, lastPath: "video" as const, position: { seconds: 120 } };
    expect(nextProgressProjection({
      completed: false,
      current,
      update: { expectedVersion: 3, path: "video", position: { seconds: 120 } },
    })).toEqual({ ...current, state: "in_progress", changed: false });
    expect(() => nextProgressProjection({
      completed: false,
      current,
      update: { expectedVersion: 3, path: "video", position: { seconds: 121 } },
    })).toThrow("VERSION_CONFLICT");
  });
});
