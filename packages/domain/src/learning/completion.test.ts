import { describe, expect, it } from "vitest";
import { canonicalRequiredLessonSetHash } from "./completion.js";

describe("course completion provenance", () => {
  it("hashes the unique sorted 18-lesson set independently of arrival order", () => {
    const ids = Array.from({ length: 18 }, (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    expect(canonicalRequiredLessonSetHash(ids)).toBe(canonicalRequiredLessonSetHash([...ids].reverse()));
    expect(() => canonicalRequiredLessonSetHash(ids.slice(0, 17))).toThrow("LEARNING_REQUIRED_LESSON_SET_INVALID");
    expect(() => canonicalRequiredLessonSetHash([...ids.slice(0, 17), ids[0]!])).toThrow("LEARNING_REQUIRED_LESSON_SET_INVALID");
  });
});
