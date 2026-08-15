import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apiCommandReceipts, courseVersionLessons, courseVersions, courses } from "./content.js";
import { entitlementSources } from "./entitlements.js";
import { accounts, memberships } from "./identity.js";

const instant = (name: string) => timestamp(name, { precision: 3, withTimezone: true });
const id = (name: string) => uuid(name).notNull();

export const accountCourseAccesses = pgTable("account_course_accesses", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: id("account_id").references(() => accounts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  entitlementSourceId: id("entitlement_source_id"),
  courseId: id("course_id").references(() => courses.id, { onDelete: "restrict", onUpdate: "restrict" }),
  courseVersionId: id("course_version_id"),
  status: text("status").notNull().default("active"),
  createdAt: instant("created_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.entitlementSourceId, table.accountId], foreignColumns: [entitlementSources.id, entitlementSources.accountId], name: "account_course_accesses_source_account_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.courseVersionId, table.courseId], foreignColumns: [courseVersions.id, courseVersions.courseId], name: "account_course_accesses_version_course_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("account_course_accesses_exact_unique").on(table.id, table.accountId, table.courseId, table.courseVersionId),
  uniqueIndex("account_course_accesses_active_source_course_unique").on(table.accountId, table.entitlementSourceId, table.courseId).where(sql`${table.status}='active'`),
  uniqueIndex("account_course_accesses_active_source_version_unique").on(table.accountId, table.entitlementSourceId, table.courseId, table.courseVersionId).where(sql`${table.status}='active'`),
  check("account_course_accesses_status_check", sql`${table.status} in ('active','revoked')`),
]);

export const enrollments = pgTable("enrollments", {
  id: uuid("id").primaryKey().defaultRandom(), accountId: id("account_id"),
  accountCourseAccessId: id("account_course_access_id"), membershipId: id("membership_id"),
  courseId: id("course_id"), courseVersionId: id("course_version_id"),
  status: text("status").notNull().default("active"),
  enrolledAt: instant("enrolled_at").notNull().defaultNow(), revokedAt: instant("revoked_at"),
}, (table) => [
  foreignKey({ columns: [table.membershipId, table.accountId], foreignColumns: [memberships.id, memberships.accountId], name: "enrollments_membership_account_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.accountCourseAccessId, table.accountId, table.courseId, table.courseVersionId], foreignColumns: [accountCourseAccesses.id, accountCourseAccesses.accountId, accountCourseAccesses.courseId, accountCourseAccesses.courseVersionId], name: "enrollments_access_exact_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("enrollments_exact_unique").on(table.id, table.accountId, table.membershipId, table.courseId, table.courseVersionId),
  unique("enrollments_transition_target_unique").on(table.id, table.accountId, table.membershipId, table.courseId),
  uniqueIndex("enrollments_one_active_course_unique").on(table.accountId, table.membershipId, table.courseId).where(sql`${table.status}='active'`),
  check("enrollments_status_check", sql`${table.status} in ('active','revoked')`),
  check("enrollments_status_time_check", sql`(${table.status}='active' and ${table.revokedAt} is null) or (${table.status}='revoked' and ${table.revokedAt} is not null)`),
]);

export const enrollmentVersionTransitions = pgTable("enrollment_version_transitions", {
  id: uuid("id").primaryKey().defaultRandom(), accountId: id("account_id"), membershipId: id("membership_id"), courseId: id("course_id"),
  fromEnrollmentId: id("from_enrollment_id"), toEnrollmentId: id("to_enrollment_id").unique(), actorType: text("actor_type").notNull(), actorId: text("actor_id").notNull(),
  reason: text("reason").notNull(), transitionedAt: instant("transitioned_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.fromEnrollmentId, table.accountId, table.membershipId, table.courseId], foreignColumns: [enrollments.id, enrollments.accountId, enrollments.membershipId, enrollments.courseId], name: "enrollment_transitions_from_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.toEnrollmentId, table.accountId, table.membershipId, table.courseId], foreignColumns: [enrollments.id, enrollments.accountId, enrollments.membershipId, enrollments.courseId], name: "enrollment_transitions_to_fk" }).onDelete("restrict").onUpdate("restrict"),
  check("enrollment_transitions_actor_check", sql`${table.actorType} in ('member','staff','system')`),
  check("enrollment_transitions_reason_check", sql`octet_length(${table.reason}) between 1 and 1000`),
  check("enrollment_transitions_distinct_check", sql`${table.fromEnrollmentId}<>${table.toEnrollmentId}`),
]);

export const lessonProgress = pgTable("lesson_progress", {
  id: uuid("id").primaryKey().defaultRandom(), accountId: id("account_id"), membershipId: id("membership_id"), enrollmentId: id("enrollment_id"), courseId: id("course_id"), courseVersionId: id("course_version_id"), lessonId: id("lesson_id"), lessonVersionId: id("lesson_version_id"),
  lastPath: text("last_path").notNull(), videoSeconds: integer("video_seconds"), transcriptBlockId: text("transcript_block_id"), revision: integer("revision").notNull().default(1), updatedAt: instant("updated_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.enrollmentId, table.accountId, table.membershipId, table.courseId, table.courseVersionId], foreignColumns: [enrollments.id, enrollments.accountId, enrollments.membershipId, enrollments.courseId, enrollments.courseVersionId], name: "lesson_progress_enrollment_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.courseVersionId, table.courseId, table.lessonId, table.lessonVersionId], foreignColumns: [courseVersionLessons.courseVersionId, courseVersionLessons.courseId, courseVersionLessons.lessonId, courseVersionLessons.lessonVersionId], name: "lesson_progress_manifest_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("lesson_progress_enrollment_lesson_unique").on(table.enrollmentId, table.lessonId),
  index("lesson_progress_actor_idx").on(table.accountId, table.membershipId),
  check("lesson_progress_last_path_check", sql`${table.lastPath} in ('video','transcript')`),
  check("lesson_progress_revision_check", sql`${table.revision}>=1`),
  check("lesson_progress_position_check", sql`(${table.lastPath}='video' and ${table.videoSeconds} between 0 and 86400 and ${table.transcriptBlockId} is null) or (${table.lastPath}='transcript' and ${table.videoSeconds} is null and octet_length(${table.transcriptBlockId}) between 1 and 128)`),
]);

export const lessonCompletions = pgTable("lesson_completions", {
  id: uuid("id").primaryKey().defaultRandom(), accountId: id("account_id"), membershipId: id("membership_id"), enrollmentId: id("enrollment_id"), courseId: id("course_id"), courseVersionId: id("course_version_id"), lessonId: id("lesson_id"), lessonVersionId: id("lesson_version_id"), method: text("method").notNull(), sourceCommandReceiptId: id("source_command_receipt_id").unique().references(() => apiCommandReceipts.id, { onDelete: "restrict", onUpdate: "restrict" }), completedAt: instant("completed_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.enrollmentId, table.accountId, table.membershipId, table.courseId, table.courseVersionId], foreignColumns: [enrollments.id, enrollments.accountId, enrollments.membershipId, enrollments.courseId, enrollments.courseVersionId], name: "lesson_completions_enrollment_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.courseVersionId, table.courseId, table.lessonId, table.lessonVersionId], foreignColumns: [courseVersionLessons.courseVersionId, courseVersionLessons.courseId, courseVersionLessons.lessonId, courseVersionLessons.lessonVersionId], name: "lesson_completions_manifest_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("lesson_completions_enrollment_lesson_unique").on(table.enrollmentId, table.lessonId),
  unique("lesson_completions_exact_unique").on(table.id, table.accountId, table.membershipId, table.enrollmentId, table.courseId, table.courseVersionId),
  check("lesson_completions_method_check", sql`${table.method} in ('video','transcript','mixed')`),
]);

export const courseCompletions = pgTable("course_completions", {
  id: uuid("id").primaryKey().defaultRandom(), accountId: id("account_id"), membershipId: id("membership_id"), enrollmentId: id("enrollment_id"), courseId: id("course_id"), courseVersionId: id("course_version_id"), requiredLessonSetHash: text("required_lesson_set_hash").notNull(), completedAt: instant("completed_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.enrollmentId, table.accountId, table.membershipId, table.courseId, table.courseVersionId], foreignColumns: [enrollments.id, enrollments.accountId, enrollments.membershipId, enrollments.courseId, enrollments.courseVersionId], name: "course_completions_enrollment_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("course_completions_enrollment_unique").on(table.enrollmentId),
  unique("course_completions_exact_unique").on(table.id, table.accountId, table.membershipId, table.enrollmentId, table.courseId, table.courseVersionId),
  index("course_completions_implementation_lookup_idx").on(table.accountId, table.courseId, table.completedAt, table.id),
  check("course_completions_hash_check", sql`${table.requiredLessonSetHash} ~ '^[0-9a-f]{64}$'`),
]);

export const certificatePrerequisites = pgTable("certificate_prerequisites", {
  id: uuid("id").primaryKey().defaultRandom(), courseCompletionId: id("course_completion_id").unique(), accountId: id("account_id"), membershipId: id("membership_id"), enrollmentId: id("enrollment_id"), courseId: id("course_id"), courseVersionId: id("course_version_id"), recordedAt: instant("recorded_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.courseCompletionId, table.accountId, table.membershipId, table.enrollmentId, table.courseId, table.courseVersionId], foreignColumns: [courseCompletions.id, courseCompletions.accountId, courseCompletions.membershipId, courseCompletions.enrollmentId, courseCompletions.courseId, courseCompletions.courseVersionId], name: "certificate_prerequisites_completion_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("certificate_prerequisites_exact_unique").on(
    table.id,
    table.courseCompletionId,
    table.accountId,
    table.membershipId,
    table.enrollmentId,
    table.courseId,
    table.courseVersionId,
  ),
]);
