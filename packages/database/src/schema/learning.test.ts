import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  accountCourseAccesses,
  certificatePrerequisites,
  courseCompletions,
  enrollments,
  enrollmentVersionTransitions,
  lessonCompletions,
  lessonProgress,
} from "./learning.js";

describe("learning schema", () => {
  it("exports every account/member ownership and immutable completion authority", () => {
    expect([
      accountCourseAccesses,
      enrollments,
      enrollmentVersionTransitions,
      lessonProgress,
      lessonCompletions,
      courseCompletions,
      certificatePrerequisites,
    ].map((table) => getTableConfig(table).name)).toEqual([
      "account_course_accesses",
      "enrollments",
      "enrollment_version_transitions",
      "lesson_progress",
      "lesson_completions",
      "course_completions",
      "certificate_prerequisites",
    ]);
    expect(getTableConfig(lessonProgress).columns.map(({ name }) => name)).toEqual([
      "id", "account_id", "membership_id", "enrollment_id", "course_id",
      "course_version_id", "lesson_id", "lesson_version_id", "last_path",
      "video_seconds", "transcript_block_id", "revision", "updated_at",
    ]);
    expect(getTableConfig(enrollments).checks.map(({ name }) => name).sort()).toEqual([
      "enrollments_status_check", "enrollments_status_time_check",
    ]);
    expect(getTableConfig(lessonProgress).checks.map(({ name }) => name).sort()).toEqual([
      "lesson_progress_last_path_check", "lesson_progress_position_check", "lesson_progress_revision_check",
    ]);
    expect(getTableConfig(lessonCompletions).checks.map(({ name }) => name))
      .toEqual(["lesson_completions_method_check"]);
    expect(getTableConfig(courseCompletions).checks.map(({ name }) => name))
      .toEqual(["course_completions_hash_check"]);
  });

  it("allows only one active pinned access for each source and course", () => {
    expect(getTableConfig(accountCourseAccesses).indexes.map(({ config }) => config.name))
      .toContain("account_course_accesses_active_source_course_unique");
  });
});
