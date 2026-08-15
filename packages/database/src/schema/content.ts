import type { ContentPublicationIssue, ReleaseRule } from "@syntholo/contracts/content";
import { sql, type SQLWrapper } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { staffIdentities } from "./identity.js";

const time = (name: string) => timestamp(name, { precision: 3, withTimezone: true });
const uuidReference = (name: string) => uuid(name).notNull();
const releaseRuleCheck = (column: SQLWrapper) =>
  sql`case
    when ${column} = '{"kind":"immediate"}'::jsonb then true
    when jsonb_typeof(${column})='object'
      and (${column} - ARRAY['kind','days']::text[]) = '{}'::jsonb
      and ${column}->>'kind'='elapsed_days' and jsonb_typeof(${column}->'days')='number'
      and ${column}->>'days' ~ '^(0|[1-9][0-9]{0,2})$'
      then (${column}->>'days')::integer between 0 and 365
    when jsonb_typeof(${column})='object'
      and (${column} - ARRAY['kind','at']::text[]) = '{}'::jsonb
      and ${column}->>'kind'='fixed_at' and jsonb_typeof(${column}->'at')='string'
      and ${column}->>'at' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$'
      then isfinite((${column}->>'at')::timestamptz)
        and to_char((${column}->>'at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=${column}->>'at'
    else false end`;

export const courses = pgTable("courses", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  currentDraftRevision: integer("current_draft_revision").notNull().default(1),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (table) => [
  check("courses_slug_check", sql`octet_length(${table.slug}) between 1 and 100 and ${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  check("courses_revision_check", sql`${table.currentDraftRevision} >= 1`),
]);

export const courseDrafts = pgTable("course_drafts", {
  courseId: uuidReference("course_id").primaryKey().references(() => courses.id, { onDelete: "restrict", onUpdate: "restrict" }),
  revision: integer("revision").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  updatedByStaffId: uuidReference("updated_by_staff_id").references(() => staffIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (table) => [check("course_drafts_revision_check", sql`${table.revision} >= 1`)]);

export const stages = pgTable("stages", {
  id: uuid("id").primaryKey().defaultRandom(),
  courseId: uuidReference("course_id").references(() => courses.id, { onDelete: "restrict", onUpdate: "restrict" }),
  slug: text("slug").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  unique("stages_course_slug_unique").on(table.courseId, table.slug),
  unique("stages_id_course_unique").on(table.id, table.courseId),
]);

export const stageDrafts = pgTable("stage_drafts", {
  stageId: uuidReference("stage_id").primaryKey().references(() => stages.id, { onDelete: "restrict", onUpdate: "restrict" }),
  courseId: uuidReference("course_id"),
  revision: integer("revision").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  order: integer("order").notNull(),
  updatedByStaffId: uuidReference("updated_by_staff_id").references(() => staffIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.stageId, table.courseId], foreignColumns: [stages.id, stages.courseId], name: "stage_drafts_stage_course_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("stage_drafts_course_order_unique").on(table.courseId, table.order),
  check("stage_drafts_revision_check", sql`${table.revision} >= 1`),
  check("stage_drafts_order_check", sql`${table.order} >= 1`),
]);

export const lessons = pgTable("lessons", {
  id: uuid("id").primaryKey().defaultRandom(),
  courseId: uuidReference("course_id").references(() => courses.id, { onDelete: "restrict", onUpdate: "restrict" }),
  stageId: uuidReference("stage_id"),
  slug: text("slug").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.stageId, table.courseId], foreignColumns: [stages.id, stages.courseId], name: "lessons_stage_course_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("lessons_course_slug_unique").on(table.courseId, table.slug),
  unique("lessons_id_course_unique").on(table.id, table.courseId),
]);

export const lessonDrafts = pgTable("lesson_drafts", {
  lessonId: uuidReference("lesson_id").primaryKey().references(() => lessons.id, { onDelete: "restrict", onUpdate: "restrict" }),
  courseId: uuidReference("course_id"),
  stageId: uuidReference("stage_id"),
  revision: integer("revision").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  durationSeconds: integer("duration_seconds"),
  blocks: jsonb("blocks").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
  transcript: jsonb("transcript").$type<Record<string, unknown>>().notNull().default(sql`'{"schemaVersion":1,"blocks":[]}'::jsonb`),
  mediaAssetId: uuid("media_asset_id"),
  stageOrder: integer("stage_order").notNull(),
  order: integer("order").notNull(),
  required: boolean("required").notNull().default(true),
  releaseRule: jsonb("release_rule").$type<ReleaseRule>().notNull().default(sql`'{"kind":"immediate"}'::jsonb`),
  placeholderDetected: boolean("placeholder_detected").notNull().default(false),
  updatedByStaffId: uuidReference("updated_by_staff_id").references(() => staffIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.lessonId, table.courseId], foreignColumns: [lessons.id, lessons.courseId], name: "lesson_drafts_lesson_course_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.stageId, table.courseId], foreignColumns: [stages.id, stages.courseId], name: "lesson_drafts_stage_course_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.mediaAssetId], foreignColumns: [contentMediaAssets.id], name: "lesson_drafts_media_asset_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("lesson_drafts_course_stage_order_unique").on(table.courseId, table.stageId, table.order),
  check("lesson_drafts_revision_check", sql`${table.revision} >= 1`),
  check("lesson_drafts_order_check", sql`${table.stageOrder} >= 1 and ${table.order} >= 1`),
  check("lesson_drafts_duration_check", sql`${table.durationSeconds} is null or ${table.durationSeconds} between 1 and 86400`),
  check("lesson_drafts_blocks_check", sql`jsonb_typeof(${table.blocks}) = 'array' and octet_length(${table.blocks}::text) <= 262144`),
  check("lesson_drafts_transcript_check", sql`jsonb_typeof(${table.transcript}) = 'object' and octet_length(${table.transcript}::text) <= 1048576`),
  check("lesson_drafts_release_rule_check", releaseRuleCheck(table.releaseRule)),
]);

export const lessonAccessibilityDecisions = pgTable("lesson_accessibility_decisions", {
  id: uuid("id").primaryKey().defaultRandom(), lessonId: uuidReference("lesson_id").references(() => lessons.id, { onDelete: "restrict", onUpdate: "restrict" }),
  draftRevision: integer("draft_revision").notNull(), draftHash: text("draft_hash").notNull(), decisionSequence: integer("decision_sequence").notNull(),
  decision: text("decision").notNull(), reviewerStaffId: uuidReference("reviewer_staff_id").references(() => staffIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }),
  reason: text("reason").notNull(), decidedAt: time("decided_at").notNull().defaultNow(),
}, (table) => [
  unique("lesson_accessibility_decisions_id_lesson_sequence_unique").on(table.id, table.lessonId, table.decisionSequence),
  unique("lesson_accessibility_decisions_lesson_sequence_unique").on(table.lessonId, table.decisionSequence),
  check("lesson_accessibility_decisions_status_check", sql`${table.decision} in ('approved','rejected')`),
  check("lesson_accessibility_decisions_sequence_check", sql`${table.decisionSequence} > 0`),
  check("lesson_accessibility_decisions_hash_check", sql`${table.draftHash} ~ '^[0-9a-f]{64}$'`),
]);

export const lessonAccessibilityReviewHeads = pgTable("lesson_accessibility_review_heads", {
  lessonId: uuidReference("lesson_id").primaryKey().references(() => lessons.id, { onDelete: "restrict", onUpdate: "restrict" }),
  decisionSequence: integer("decision_sequence").notNull().default(0),
  currentDecisionId: uuid("current_decision_id"), currentDraftRevision: integer("current_draft_revision"), currentDraftHash: text("current_draft_hash"),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.currentDecisionId, table.lessonId, table.decisionSequence], foreignColumns: [lessonAccessibilityDecisions.id, lessonAccessibilityDecisions.lessonId, lessonAccessibilityDecisions.decisionSequence], name: "lesson_accessibility_heads_decision_fk" }).onDelete("restrict").onUpdate("restrict"),
  check("lesson_accessibility_heads_state_check", sql`(${table.decisionSequence}=0 and ${table.currentDecisionId} is null and ${table.currentDraftRevision} is null and ${table.currentDraftHash} is null) or (${table.decisionSequence}>0 and ${table.currentDecisionId} is not null and ${table.currentDraftRevision} is not null and ${table.currentDraftHash} ~ '^[0-9a-f]{64}$')`),
]);

export const lessonDisclosureDecisions = pgTable("lesson_disclosure_decisions", {
  id: uuid("id").primaryKey().defaultRandom(), lessonId: uuidReference("lesson_id").references(() => lessons.id, { onDelete: "restrict", onUpdate: "restrict" }),
  draftRevision: integer("draft_revision").notNull(), draftHash: text("draft_hash").notNull(), decisionSequence: integer("decision_sequence").notNull(),
  decision: text("decision").notNull(), policyVersion: text("policy_version").notNull(), reviewerStaffId: uuidReference("reviewer_staff_id").references(() => staffIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }),
  reason: text("reason").notNull(), decidedAt: time("decided_at").notNull().defaultNow(),
}, (table) => [
  unique("lesson_disclosure_decisions_id_lesson_sequence_unique").on(table.id, table.lessonId, table.decisionSequence),
  unique("lesson_disclosure_decisions_lesson_sequence_unique").on(table.lessonId, table.decisionSequence),
  check("lesson_disclosure_decisions_status_check", sql`${table.decision} in ('applicable','not_applicable')`),
  check("lesson_disclosure_decisions_sequence_check", sql`${table.decisionSequence} > 0`),
  check("lesson_disclosure_decisions_hash_check", sql`${table.draftHash} ~ '^[0-9a-f]{64}$'`),
]);

export const lessonDisclosureReviewHeads = pgTable("lesson_disclosure_review_heads", {
  lessonId: uuidReference("lesson_id").primaryKey().references(() => lessons.id, { onDelete: "restrict", onUpdate: "restrict" }),
  decisionSequence: integer("decision_sequence").notNull().default(0),
  currentDecisionId: uuid("current_decision_id"), currentDraftRevision: integer("current_draft_revision"), currentDraftHash: text("current_draft_hash"),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.currentDecisionId, table.lessonId, table.decisionSequence], foreignColumns: [lessonDisclosureDecisions.id, lessonDisclosureDecisions.lessonId, lessonDisclosureDecisions.decisionSequence], name: "lesson_disclosure_heads_decision_fk" }).onDelete("restrict").onUpdate("restrict"),
  check("lesson_disclosure_heads_state_check", sql`(${table.decisionSequence}=0 and ${table.currentDecisionId} is null and ${table.currentDraftRevision} is null and ${table.currentDraftHash} is null) or (${table.decisionSequence}>0 and ${table.currentDecisionId} is not null and ${table.currentDraftRevision} is not null and ${table.currentDraftHash} ~ '^[0-9a-f]{64}$')`),
]);

export const lessonVersions = pgTable("lesson_versions", {
  id: uuid("id").primaryKey().defaultRandom(), lessonId: uuidReference("lesson_id"), courseId: uuidReference("course_id"), stageId: uuidReference("stage_id"),
  version: integer("version").notNull(), title: text("title").notNull(), summary: text("summary").notNull(), durationSeconds: integer("duration_seconds").notNull(),
  blocks: jsonb("blocks").$type<unknown[]>().notNull(), transcript: jsonb("transcript").$type<Record<string, unknown>>().notNull(), mediaAssetId: uuid("media_asset_id"),
  stageOrder: integer("stage_order").notNull(), order: integer("order").notNull(), required: boolean("required").notNull(), releaseRule: jsonb("release_rule").$type<ReleaseRule>().notNull(),
  accessibilityDecisionId: uuidReference("accessibility_decision_id"), accessibilityDecisionSequence: integer("accessibility_decision_sequence").notNull(),
  disclosureDecisionId: uuidReference("disclosure_decision_id"), disclosureDecisionSequence: integer("disclosure_decision_sequence").notNull(),
  contentHash: text("content_hash").notNull(), publishedByStaffId: uuidReference("published_by_staff_id").references(() => staffIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }),
  publishReason: text("publish_reason").notNull(), publishedAt: time("published_at").notNull().defaultNow(), sourceDraftRevision: integer("source_draft_revision"),
}, (table) => [
  foreignKey({ columns: [table.lessonId, table.courseId], foreignColumns: [lessons.id, lessons.courseId], name: "lesson_versions_lesson_course_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.accessibilityDecisionId, table.lessonId, table.accessibilityDecisionSequence], foreignColumns: [lessonAccessibilityDecisions.id, lessonAccessibilityDecisions.lessonId, lessonAccessibilityDecisions.decisionSequence], name: "lesson_versions_accessibility_decision_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.disclosureDecisionId, table.lessonId, table.disclosureDecisionSequence], foreignColumns: [lessonDisclosureDecisions.id, lessonDisclosureDecisions.lessonId, lessonDisclosureDecisions.decisionSequence], name: "lesson_versions_disclosure_decision_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.mediaAssetId], foreignColumns: [contentMediaAssets.id], name: "lesson_versions_media_asset_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("lesson_versions_lesson_version_unique").on(table.lessonId, table.version),
  unique("lesson_versions_id_lesson_course_unique").on(table.id, table.lessonId, table.courseId),
  uniqueIndex("lesson_versions_source_draft_unique").on(table.lessonId, table.sourceDraftRevision).where(sql`${table.sourceDraftRevision} is not null`),
  check("lesson_versions_source_draft_revision_check", sql`${table.sourceDraftRevision} is null or ${table.sourceDraftRevision}>0`),
  check("lesson_versions_content_hash_check", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  check("lesson_versions_release_rule_check", releaseRuleCheck(table.releaseRule)),
]);

export const contentMediaAssets = pgTable("content_media_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull().default("mux"),
  environmentId: text("environment_id").notNull(),
  providerAssetId: text("provider_asset_id").notNull(),
  signedPolicyPlaybackId: text("signed_policy_playback_id"),
  state: text("state").notNull().default("waiting"),
  durationMilliseconds: bigint("duration_milliseconds", { mode: "number" }),
  aspectRatio: text("aspect_ratio"),
  safeErrorCode: text("safe_error_code"),
  readinessRevision: integer("readiness_revision").notNull().default(0),
  lastProviderEventAt: time("last_provider_event_at"),
  lastProviderEventId: text("last_provider_event_id"),
  lastReconciledAt: time("last_reconciled_at"),
  importedAt: time("imported_at"),
  importedByStaffId: uuid("imported_by_staff_id").references(() => staffIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (table) => [
  unique("content_media_assets_environment_asset_unique").on(table.environmentId, table.providerAssetId),
  unique("content_media_assets_environment_playback_unique").on(table.environmentId, table.signedPolicyPlaybackId),
  check("content_media_assets_provider_check", sql`${table.provider} = 'mux'`),
  check("content_media_assets_identity_check", sql`octet_length(${table.environmentId}) between 1 and 255 and ${table.environmentId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' and octet_length(${table.providerAssetId}) between 1 and 255 and ${table.providerAssetId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'`),
  check("content_media_assets_signed_playback_check", sql`${table.signedPolicyPlaybackId} is null or (octet_length(${table.signedPolicyPlaybackId}) between 1 and 255 and ${table.signedPolicyPlaybackId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$')`),
  check("content_media_assets_state_check", sql`${table.state} in ('waiting','preparing','ready','errored','deleted')`),
  check("content_media_assets_duration_check", sql`${table.durationMilliseconds} is null or ${table.durationMilliseconds} between 1 and 86400000`),
  check("content_media_assets_aspect_ratio_check", sql`${table.aspectRatio} is null or ${table.aspectRatio} ~ '^[1-9][0-9]{0,4}:[1-9][0-9]{0,4}$'`),
  check("content_media_assets_revision_check", sql`${table.readinessRevision} >= 0`),
]);

export const contentMediaTracks = pgTable("content_media_tracks", {
  id: uuid("id").primaryKey().defaultRandom(),
  mediaAssetId: uuidReference("media_asset_id"),
  providerTrackId: text("provider_track_id").notNull(),
  kind: text("kind").notNull().default("captions"),
  language: text("language").notNull(),
  label: text("label").notNull(),
  closedCaptions: boolean("closed_captions").notNull(),
  source: text("source").notNull(),
  state: text("state").notNull().default("preparing"),
  safeErrorCode: text("safe_error_code"),
  readinessRevision: integer("readiness_revision").notNull().default(0),
  lastProviderEventAt: time("last_provider_event_at"),
  lastProviderEventId: text("last_provider_event_id"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.mediaAssetId], foreignColumns: [contentMediaAssets.id], name: "content_media_tracks_asset_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("content_media_tracks_asset_provider_track_unique").on(table.mediaAssetId, table.providerTrackId),
  check("content_media_tracks_identity_check", sql`octet_length(${table.providerTrackId}) between 1 and 255 and ${table.providerTrackId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'`),
  check("content_media_tracks_kind_check", sql`${table.kind} = 'captions'`),
  check("content_media_tracks_language_check", sql`${table.language} ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`),
  check("content_media_tracks_label_check", sql`octet_length(${table.label}) between 1 and 100`),
  check("content_media_tracks_source_check", sql`${table.source} in ('human','mux_generated')`),
  check("content_media_tracks_state_check", sql`${table.state} in ('preparing','ready','errored','deleted')`),
  check("content_media_tracks_revision_check", sql`${table.readinessRevision} >= 0`),
]);

export const courseDraftManifestEntries = pgTable("course_draft_manifest_entries", {
  courseId: uuidReference("course_id").references(() => courses.id, { onDelete: "restrict", onUpdate: "restrict" }), courseDraftRevision: integer("course_draft_revision").notNull(),
  stageId: uuidReference("stage_id"), stageOrder: integer("stage_order").notNull(), lessonId: uuidReference("lesson_id"), lessonOrder: integer("lesson_order").notNull(),
  required: boolean("required").notNull(), releaseRule: jsonb("release_rule").$type<ReleaseRule>().notNull(),
  selectedLessonDraftRevision: integer("selected_lesson_draft_revision"), selectedLessonDraftHash: text("selected_lesson_draft_hash"),
  selectedLessonVersionId: uuid("selected_lesson_version_id"), selectedLessonVersionHash: text("selected_lesson_version_hash"),
  readinessRevision: integer("readiness_revision").notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.courseId, table.courseDraftRevision, table.lessonId] }),
  unique("course_draft_manifest_order_unique").on(table.courseId, table.courseDraftRevision, table.lessonOrder),
  foreignKey({ columns: [table.selectedLessonVersionId, table.lessonId, table.courseId], foreignColumns: [lessonVersions.id, lessonVersions.lessonId, lessonVersions.courseId], name: "course_draft_manifest_lesson_version_fk" }).onDelete("restrict").onUpdate("restrict"),
  check("course_draft_manifest_selection_check", sql`(${table.selectedLessonDraftRevision} is not null and ${table.selectedLessonDraftHash} ~ '^[0-9a-f]{64}$' and ${table.selectedLessonVersionId} is null and ${table.selectedLessonVersionHash} is null) or (${table.selectedLessonDraftRevision} is null and ${table.selectedLessonDraftHash} is null and ${table.selectedLessonVersionId} is not null and ${table.selectedLessonVersionHash} ~ '^[0-9a-f]{64}$')`),
  check("course_draft_manifest_release_rule_check", releaseRuleCheck(table.releaseRule)),
]);

export const contentPreviews = pgTable("content_previews", {
  id: uuid("id").primaryKey().defaultRandom(), courseId: uuidReference("course_id").references(() => courses.id, { onDelete: "restrict", onUpdate: "restrict" }),
  draftRevision: integer("draft_revision").notNull(), manifestCanonicalJson: text("manifest_canonical_json").notNull(), manifestHash: text("manifest_hash").notNull(),
  manifestProjection: jsonb("manifest_projection").$type<Record<string, unknown>>().notNull(), publicationIssues: jsonb("publication_issues").$type<ContentPublicationIssue[]>().notNull().default(sql`'[]'::jsonb`),
  createdByStaffId: uuidReference("created_by_staff_id").references(() => staffIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }), reason: text("reason").notNull(), createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  unique("content_previews_id_course_hash_unique").on(table.id, table.courseId, table.manifestHash),
  check("content_previews_manifest_hash_check", sql`${table.manifestHash} ~ '^[0-9a-f]{64}$'`),
  check("content_previews_manifest_projection_check", sql`jsonb_typeof(${table.manifestProjection})='object' and ${table.manifestProjection}::text = ${table.manifestCanonicalJson}::jsonb::text`),
]);

export const courseVersions = pgTable("course_versions", {
  id: uuid("id").primaryKey().defaultRandom(), courseId: uuidReference("course_id").references(() => courses.id, { onDelete: "restrict", onUpdate: "restrict" }),
  version: integer("version").notNull(), title: text("title").notNull(), description: text("description").notNull(), manifestHash: text("manifest_hash").notNull(), sourcePreviewId: uuidReference("source_preview_id"),
  publishedByStaffId: uuidReference("published_by_staff_id").references(() => staffIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }), publishReason: text("publish_reason").notNull(), publishedAt: time("published_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.sourcePreviewId, table.courseId, table.manifestHash], foreignColumns: [contentPreviews.id, contentPreviews.courseId, contentPreviews.manifestHash], name: "course_versions_source_preview_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("course_versions_course_version_unique").on(table.courseId, table.version),
  unique("course_versions_source_preview_unique").on(table.sourcePreviewId),
  unique("course_versions_id_course_hash_unique").on(table.id, table.courseId, table.manifestHash),
  unique("course_versions_id_course_unique").on(table.id, table.courseId),
]);

export const courseVersionLessons = pgTable("course_version_lessons", {
  courseVersionId: uuidReference("course_version_id"), courseId: uuidReference("course_id"), lessonId: uuidReference("lesson_id"), lessonVersionId: uuidReference("lesson_version_id"),
  stageId: uuidReference("stage_id"), stageTitle: text("stage_title").notNull(), stageOrder: integer("stage_order").notNull(), lessonOrder: integer("lesson_order").notNull(), required: boolean("required").notNull(), releaseRule: jsonb("release_rule").$type<ReleaseRule>().notNull(),
}, (table) => [
  primaryKey({ columns: [table.courseVersionId, table.lessonId] }),
  foreignKey({ columns: [table.courseVersionId, table.courseId], foreignColumns: [courseVersions.id, courseVersions.courseId], name: "course_version_lessons_course_version_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.lessonVersionId, table.lessonId, table.courseId], foreignColumns: [lessonVersions.id, lessonVersions.lessonId, lessonVersions.courseId], name: "course_version_lessons_lesson_version_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("course_version_lessons_exact_membership_unique").on(table.courseVersionId, table.courseId, table.lessonId, table.lessonVersionId),
  unique("course_version_lessons_order_unique").on(table.courseVersionId, table.lessonOrder),
  check("course_version_lessons_release_rule_check", releaseRuleCheck(table.releaseRule)),
]);

export const courseHeads = pgTable("course_heads", {
  courseId: uuidReference("course_id").references(() => courses.id, { onDelete: "restrict", onUpdate: "restrict" }), channel: text("channel").notNull().default("production"),
  currentCourseVersionId: uuidReference("current_course_version_id"), manifestHash: text("manifest_hash").notNull(), headRevision: integer("head_revision").notNull(),
  setByStaffId: uuidReference("set_by_staff_id").references(() => staffIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }), setAt: time("set_at").notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.courseId, table.channel] }),
  foreignKey({ columns: [table.currentCourseVersionId, table.courseId, table.manifestHash], foreignColumns: [courseVersions.id, courseVersions.courseId, courseVersions.manifestHash], name: "course_heads_version_manifest_fk" }).onDelete("restrict").onUpdate("restrict"),
  check("course_heads_channel_check", sql`${table.channel}='production'`), check("course_heads_revision_check", sql`${table.headRevision}>0`),
]);

export const contentResourceDrafts = pgTable("content_resource_drafts", {
  id: uuid("id").primaryKey().defaultRandom(), lessonId: uuidReference("lesson_id").references(() => lessons.id, { onDelete: "restrict", onUpdate: "restrict" }), lessonDraftRevision: integer("lesson_draft_revision").notNull(), revision: integer("revision").notNull(),
  label: text("label").notNull(), accessibleLabel: text("accessible_label").notNull(), delivery: text("delivery").notNull(), deliveryReference: text("delivery_reference").notNull(), mime: text("mime").notNull(), byteSize: integer("byte_size").notNull(), contentHash: text("content_hash").notNull(), archivedAt: time("archived_at"), updatedAt: time("updated_at").notNull().defaultNow(),
}, (table) => [check("content_resource_drafts_delivery_check", sql`${table.delivery} in ('external_https','private_blob')`)]);

export const lessonVersionResources = pgTable("lesson_version_resources", {
  lessonVersionId: uuidReference("lesson_version_id").references(() => lessonVersions.id, { onDelete: "restrict", onUpdate: "restrict" }), resourceId: uuidReference("resource_id").references(() => contentResourceDrafts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  order: integer("order").notNull(), label: text("label").notNull(), accessibleLabel: text("accessible_label").notNull(), delivery: text("delivery").notNull(), deliveryReference: text("delivery_reference").notNull(), mime: text("mime").notNull(), byteSize: integer("byte_size").notNull(), contentHash: text("content_hash").notNull(),
}, (table) => [primaryKey({ columns: [table.lessonVersionId, table.resourceId] }), unique("lesson_version_resources_order_unique").on(table.lessonVersionId, table.order)]);

export const resourceDeliveryHealth = pgTable("resource_delivery_health", {
  deliveryReference: text("delivery_reference").primaryKey(), state: text("state").notNull(), readinessRevision: integer("readiness_revision").notNull().default(0), safeErrorCode: text("safe_error_code"), checkedAt: time("checked_at").notNull().defaultNow(),
}, (table) => [check("resource_delivery_health_state_check", sql`${table.state} in ('preparing','ready','unavailable','deleted')`)]);

export const contentSchedules = pgTable("content_schedules", {
  id: uuid("id").primaryKey().defaultRandom(), targetKind: text("target_kind").notNull(), targetId: uuidReference("target_id"), expectedDraftRevision: integer("expected_draft_revision").notNull(), expectedDraftHash: text("expected_draft_hash").notNull(), runAt: time("run_at").notNull(), authorizingStaffId: uuidReference("authorizing_staff_id").references(() => staffIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }), authenticatedAt: time("authenticated_at").notNull(), reason: text("reason").notNull(), status: text("status").notNull().default("scheduled"), createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [uniqueIndex("content_schedules_active_target_hash_unique").on(table.targetKind, table.targetId, table.expectedDraftHash).where(sql`${table.status}='scheduled'`)]);

export const contentArchives = pgTable("content_archives", {
  id: uuid("id").primaryKey().defaultRandom(), targetKind: text("target_kind").notNull(), targetVersionId: uuidReference("target_version_id"), staffId: uuidReference("staff_id").references(() => staffIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }), reason: text("reason").notNull(), archivedAt: time("archived_at").notNull().defaultNow(),
}, (table) => [unique("content_archives_target_version_unique").on(table.targetKind, table.targetVersionId)]);

export const contentReadinessEvaluations = pgTable("content_readiness_evaluations", {
  id: uuid("id").primaryKey().defaultRandom(), courseVersionId: uuidReference("course_version_id").references(() => courseVersions.id, { onDelete: "restrict", onUpdate: "restrict" }), gateHash: text("gate_hash").notNull(), issues: jsonb("issues").$type<unknown[]>().notNull(), passed: boolean("passed").notNull(), evaluatorVersion: text("evaluator_version").notNull(), evaluatedAt: time("evaluated_at").notNull().defaultNow(),
}, (table) => [unique("content_readiness_evaluations_version_hash_unique").on(table.courseVersionId, table.gateHash)]);

export const contentReadinessApprovals = pgTable("content_readiness_approvals", {
  id: uuid("id").primaryKey().defaultRandom(), evaluationId: uuidReference("evaluation_id").references(() => contentReadinessEvaluations.id, { onDelete: "restrict", onUpdate: "restrict" }), gateHash: text("gate_hash").notNull(), approverStaffId: uuidReference("approver_staff_id").references(() => staffIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }), reason: text("reason").notNull(), approvedAt: time("approved_at").notNull().defaultNow(),
}, (table) => [unique("content_readiness_approvals_evaluation_unique").on(table.evaluationId)]);

export const apiCommandReceipts = pgTable("api_command_receipts", {
  id: uuid("id").primaryKey().defaultRandom(), principalKind: text("principal_kind").notNull(), principalId: text("principal_id").notNull(), method: text("method").notNull(), routeTemplate: text("route_template").notNull(), idempotencyKey: text("idempotency_key").notNull(), requestHash: text("request_hash").notNull(), status: text("status").notNull().default("in_progress"), responseStatus: integer("response_status"), response: jsonb("response").$type<Record<string, unknown>>(), expiresAt: time("expires_at").notNull(), createdAt: time("created_at").notNull().defaultNow(), completedAt: time("completed_at"),
}, (table) => [
  unique("api_command_receipts_scope_key_unique").on(table.principalKind, table.principalId, table.method, table.routeTemplate, table.idempotencyKey),
  check("api_command_receipts_status_check", sql`${table.status} in ('in_progress','completed')`),
  check("api_command_receipts_expiry_check", sql`${table.expiresAt} >= ${table.createdAt} + interval '30 days'`),
  index("api_command_receipts_expiry_idx").on(table.expiresAt),
]);
