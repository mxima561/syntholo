import { getTableColumns } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  apiCommandReceipts,
  contentPreviews,
  courseDraftManifestEntries,
  courseHeads,
  courseVersionLessons,
  courseVersions,
  courses,
  lessonDrafts,
  lessonVersions,
} from "./content.js";

describe("content schema authority", () => {
  it("persists one mutable lesson media binding and explicit order, required, and release authority", () => {
    expect(Object.keys(getTableColumns(lessonDrafts))).toEqual([
      "lessonId", "courseId", "stageId", "revision", "title", "summary",
      "durationSeconds", "blocks", "transcript", "mediaAssetId", "stageOrder",
      "order", "required", "releaseRule", "placeholderDetected", "updatedByStaffId",
      "createdAt", "updatedAt",
    ]);
    expect(Object.keys(getTableColumns(lessonVersions))).toContain("mediaAssetId");
  });

  it("binds immutable course versions to the exact preview/hash and authoritative manifest joins", () => {
    const versionConfig = getTableConfig(courseVersions);
    const joinConfig = getTableConfig(courseVersionLessons);
    const headConfig = getTableConfig(courseHeads);
    expect(versionConfig.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain("course_versions_source_preview_fk");
    expect(joinConfig.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(expect.arrayContaining([
      "course_version_lessons_course_version_fk",
      "course_version_lessons_lesson_version_fk",
    ]));
    expect(headConfig.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain("course_heads_version_manifest_fk");
  });

  it("models exact persisted preview bytes and reusable idempotency receipts without customer scope", () => {
    expect(Object.keys(getTableColumns(contentPreviews))).toContain("manifestCanonicalJson");
    expect(Object.keys(getTableColumns(courseDraftManifestEntries))).toContain("selectedLessonVersionHash");
    expect(Object.keys(getTableColumns(apiCommandReceipts))).not.toContain("accountId");
    expect(Object.keys(getTableColumns(courses))).not.toContain("accountId");
  });

  it("renders the same exact-key and UTC-millisecond release union on all four authorities", () => {
    const dialect = new PgDialect();
    for (const [table, checkName] of [
      [lessonDrafts, "lesson_drafts_release_rule_check"],
      [lessonVersions, "lesson_versions_release_rule_check"],
      [courseDraftManifestEntries, "course_draft_manifest_release_rule_check"],
      [courseVersionLessons, "course_version_lessons_release_rule_check"],
    ] as const) {
      const check = getTableConfig(table).checks.find(({ name }) => name === checkName);
      expect(check).toBeDefined();
      const rendered = dialect.sqlToQuery(check!.value).sql;
      expect(rendered).not.toContain("jsonb_object_length");
      expect(rendered).toContain("- ARRAY['kind','days']::text[]");
      expect(rendered).toContain("- ARRAY['kind','at']::text[]");
      expect(rendered).toContain("\\.[0-9]{3}Z$");
    }
  });
});
