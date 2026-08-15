import { createHash } from "node:crypto";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function canonicalRequiredLessonSetHash(lessonIds: readonly string[]): string {
  const sorted = [...lessonIds].sort();
  if (sorted.length !== 18 || new Set(sorted).size !== 18 || sorted.some((id) => !uuid.test(id))) {
    throw new Error("LEARNING_REQUIRED_LESSON_SET_INVALID");
  }
  return createHash("sha256").update(JSON.stringify(sorted), "utf8").digest("hex");
}
