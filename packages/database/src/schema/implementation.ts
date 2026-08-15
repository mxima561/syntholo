import type { ArtifactContent, ArtifactKind } from "@syntholo/contracts/implementation";
import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn, PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { accounts, memberships } from "./identity.js";
import { accountCourseAccesses, courseCompletions } from "./learning.js";
import { apiCommandReceipts, courses } from "./content.js";

const instant = (name: string) => timestamp(name, { precision: 3, withTimezone: true });
const id = (name: string) => uuid(name).notNull();

export const implementationArtifacts = pgTable("implementation_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: id("account_id").references(() => accounts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  courseId: id("course_id").references(() => courses.id, { onDelete: "restrict", onUpdate: "restrict" }),
  seededFromAccountCourseAccessId: id("seeded_from_account_course_access_id"),
  seededFromCourseVersionId: id("seeded_from_course_version_id"),
  kind: text("kind").$type<ArtifactKind>().notNull(),
  title: text("title").notNull(),
  currentVersion: integer("current_version").notNull().default(0),
  currentVersionId: uuid("current_version_id"),
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({ columns: [table.seededFromAccountCourseAccessId, table.accountId, table.courseId, table.seededFromCourseVersionId], foreignColumns: [accountCourseAccesses.id, accountCourseAccesses.accountId, accountCourseAccesses.courseId, accountCourseAccesses.courseVersionId], name: "implementation_artifacts_seed_access_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.currentVersionId, table.accountId, table.courseId, table.id, table.kind, table.currentVersion], foreignColumns: [implementationArtifactVersions.id, implementationArtifactVersions.accountId, implementationArtifactVersions.courseId, implementationArtifactVersions.artifactId, implementationArtifactVersions.kind, implementationArtifactVersions.version] as [AnyPgColumn, AnyPgColumn, AnyPgColumn, AnyPgColumn, AnyPgColumn, AnyPgColumn], name: "implementation_artifacts_current_version_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("implementation_artifacts_account_course_kind_unique").on(table.accountId, table.courseId, table.kind),
  unique("implementation_artifacts_exact_unique").on(table.id, table.accountId, table.courseId),
  unique("implementation_artifacts_kind_exact_unique").on(table.id, table.accountId, table.courseId, table.kind),
  check("implementation_artifacts_kind_check", sql`${table.kind} in ('readiness_map','ai_policy','workflow_portfolio','enablement_checklist','roadmap')`),
  check("implementation_artifacts_title_check", sql`octet_length(btrim(${table.title})) between 1 and 255`),
  check("implementation_artifacts_head_check", sql`(${table.currentVersion}=0 and ${table.currentVersionId} is null) or (${table.currentVersion}>0 and ${table.currentVersionId} is not null)`),
]);

export const implementationArtifactVersions = pgTable("implementation_artifact_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: id("account_id"),
  courseId: id("course_id"),
  artifactId: id("artifact_id"),
  kind: text("kind").$type<ArtifactKind>().notNull(),
  version: integer("version").notNull(),
  state: text("state").notNull(),
  content: jsonb("content").$type<ArtifactContent>().notNull(),
  canonicalJson: text("canonical_json").notNull(),
  contentHash: text("content_hash").notNull(),
  creatorMembershipId: id("creator_membership_id"),
  sourceCommandReceiptId: id("source_command_receipt_id").references(() => apiCommandReceipts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  createdAt: instant("created_at").notNull().defaultNow(),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({ columns: [table.artifactId, table.accountId, table.courseId, table.kind], foreignColumns: [implementationArtifacts.id, implementationArtifacts.accountId, implementationArtifacts.courseId, implementationArtifacts.kind], name: "implementation_versions_artifact_exact_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.creatorMembershipId, table.accountId], foreignColumns: [memberships.id, memberships.accountId], name: "implementation_versions_creator_account_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("implementation_versions_artifact_version_unique").on(table.artifactId, table.version),
  unique("implementation_versions_source_command_receipt_id_unique").on(table.sourceCommandReceiptId),
  unique("implementation_versions_exact_unique").on(table.accountId, table.artifactId, table.id),
  unique("implementation_versions_course_exact_unique").on(table.id, table.accountId, table.courseId, table.artifactId),
  unique("implementation_versions_kind_exact_unique").on(table.id, table.accountId, table.courseId, table.artifactId, table.kind),
  unique("implementation_versions_head_unique").on(table.id, table.accountId, table.courseId, table.artifactId, table.kind, table.version),
  check("implementation_versions_version_check", sql`${table.version}>0`),
  check("implementation_versions_state_check", sql`${table.state} in ('draft','final')`),
  check("implementation_versions_hash_check", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  check("implementation_versions_canonical_size_check", sql`octet_length(${table.canonicalJson}) between 2 and 1048576`),
  check("implementation_versions_content_check", sql`${table.content}->>'kind'=${table.kind} and public.syntholo_implementation_content_valid_v1(${table.kind},${table.state},${table.content})`),
  check("implementation_versions_canonical_check", sql`${table.canonicalJson}=public.syntholo_canonical_jsonb_text_v1(${table.content})`),
  check("implementation_versions_hash_parity_check", sql`${table.contentHash}=encode(sha256(convert_to(${table.canonicalJson},'UTF8')),'hex')`),
  index("implementation_versions_history_idx").on(table.artifactId, table.createdAt.desc(), table.id.desc()),
]);

export const implementationWorkflows = pgTable("implementation_workflows", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: id("account_id"),
  courseId: id("course_id"),
  artifactId: id("artifact_id"),
  artifactVersionId: id("artifact_version_id"),
  artifactKind: text("artifact_kind").$type<ArtifactKind>().notNull().default("workflow_portfolio"),
  ordinal: integer("ordinal").notNull(),
  name: text("name").notNull(),
  engine: text("engine").notNull(),
  problem: text("problem").notNull(),
  trigger: text("trigger").notNull(),
  owner: text("owner").notNull(),
  approvedTools: jsonb("approved_tools").$type<string[]>().notNull(),
  steps: jsonb("steps").$type<string[]>().notNull(),
  humanReviewPoint: text("human_review_point").notNull(),
  safetyNotes: text("safety_notes").notNull(),
  baseline: text("baseline").notNull(),
  target: text("target").notNull(),
  lifecycleState: text("lifecycle_state").notNull(),
  testStatus: text("test_status").notNull(),
  launchDate: date("launch_date"),
  createdAt: instant("created_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.artifactVersionId, table.accountId, table.courseId, table.artifactId, table.artifactKind], foreignColumns: [implementationArtifactVersions.id, implementationArtifactVersions.accountId, implementationArtifactVersions.courseId, implementationArtifactVersions.artifactId, implementationArtifactVersions.kind], name: "implementation_workflows_version_exact_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("implementation_workflows_version_ordinal_unique").on(table.artifactVersionId, table.ordinal),
  unique("implementation_workflows_exact_unique").on(table.accountId, table.artifactId, table.id),
  unique("implementation_workflows_version_exact_unique").on(table.accountId, table.courseId, table.artifactId, table.artifactVersionId, table.id),
  check("implementation_workflows_ordinal_check", sql`${table.ordinal} between 1 and 3`),
  check("implementation_workflows_artifact_kind_check", sql`${table.artifactKind}='workflow_portfolio'`),
  check("implementation_workflows_engine_check", sql`${table.engine} in ('growth','client','management')`),
  check("implementation_workflows_lifecycle_check", sql`${table.lifecycleState} in ('draft','testing','live','paused')`),
  check("implementation_workflows_test_check", sql`${table.testStatus} in ('not_started','in_progress','passed','failed')`),
  check("implementation_workflows_text_check", sql`public.syntholo_implementation_text_valid_v1(${table.name},255) and public.syntholo_implementation_text_valid_v1(${table.problem},2000) and public.syntholo_implementation_text_valid_v1(${table.trigger},2000) and public.syntholo_implementation_text_valid_v1(${table.owner},255) and public.syntholo_implementation_text_valid_v1(${table.humanReviewPoint},2000) and public.syntholo_implementation_text_valid_v1(${table.safetyNotes},2000) and public.syntholo_implementation_text_valid_v1(${table.baseline},255) and public.syntholo_implementation_text_valid_v1(${table.target},255)`),
  check("implementation_workflows_arrays_check", sql`public.syntholo_implementation_text_array_valid_v1(${table.approvedTools},25,255) and public.syntholo_implementation_text_array_valid_v1(${table.steps},25,2000)`),
  check("implementation_workflows_live_check", sql`${table.lifecycleState}<>'live' or (${table.testStatus}='passed' and ${table.launchDate} is not null and public.syntholo_implementation_text_complete_v1(${table.name},255) and public.syntholo_implementation_text_complete_v1(${table.problem},2000) and public.syntholo_implementation_text_complete_v1(${table.trigger},2000) and public.syntholo_implementation_text_complete_v1(${table.owner},255) and public.syntholo_implementation_text_complete_v1(${table.humanReviewPoint},2000) and public.syntholo_implementation_text_complete_v1(${table.safetyNotes},2000) and public.syntholo_implementation_text_complete_v1(${table.baseline},255) and public.syntholo_implementation_text_complete_v1(${table.target},255) and public.syntholo_implementation_text_array_complete_v1(${table.approvedTools}) and public.syntholo_implementation_text_array_complete_v1(${table.steps}))`),
]);

export const implementationCompletions = pgTable("implementation_completions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: id("account_id"),
  courseId: id("course_id"),
  courseCompletionId: id("course_completion_id"),
  membershipId: id("membership_id"),
  enrollmentId: id("enrollment_id"),
  courseVersionId: id("course_version_id"),
  completedAt: instant("completed_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.courseCompletionId, table.accountId, table.membershipId, table.enrollmentId, table.courseId, table.courseVersionId], foreignColumns: [courseCompletions.id, courseCompletions.accountId, courseCompletions.membershipId, courseCompletions.enrollmentId, courseCompletions.courseId, courseCompletions.courseVersionId], name: "implementation_completions_course_completion_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("implementation_completions_account_course_unique").on(table.accountId, table.courseId),
  unique("implementation_completions_exact_unique").on(table.id, table.accountId, table.courseId),
]);

export const implementationCompletionArtifactSnapshots = pgTable("implementation_completion_artifact_snapshots", {
  completionId: id("completion_id"),
  accountId: id("account_id"),
  courseId: id("course_id"),
  artifactId: id("artifact_id"),
  artifactVersionId: id("artifact_version_id"),
  kind: text("kind").$type<ArtifactKind>().notNull(),
}, (table) => [
  primaryKey({ name: "implementation_completion_artifact_snapshots_pkey", columns: [table.completionId, table.artifactId] }),
  foreignKey({ columns: [table.completionId, table.accountId, table.courseId], foreignColumns: [implementationCompletions.id, implementationCompletions.accountId, implementationCompletions.courseId], name: "implementation_completion_artifacts_completion_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.artifactVersionId, table.accountId, table.courseId, table.artifactId, table.kind], foreignColumns: [implementationArtifactVersions.id, implementationArtifactVersions.accountId, implementationArtifactVersions.courseId, implementationArtifactVersions.artifactId, implementationArtifactVersions.kind], name: "implementation_completion_artifacts_version_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("implementation_completion_artifacts_kind_unique").on(table.completionId, table.kind),
  unique("implementation_completion_artifacts_version_unique").on(table.completionId, table.artifactId, table.artifactVersionId),
]);

export const implementationCompletionWorkflowSnapshots = pgTable("implementation_completion_workflow_snapshots", {
  completionId: id("completion_id"),
  accountId: id("account_id"),
  courseId: id("course_id"),
  artifactId: id("artifact_id"),
  artifactVersionId: id("artifact_version_id"),
  workflowId: id("workflow_id"),
}, (table) => [
  primaryKey({ name: "implementation_completion_workflow_snapshots_pkey", columns: [table.completionId, table.workflowId] }),
  foreignKey({ columns: [table.completionId, table.accountId, table.courseId], foreignColumns: [implementationCompletions.id, implementationCompletions.accountId, implementationCompletions.courseId], name: "implementation_completion_workflows_completion_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.completionId, table.artifactId, table.artifactVersionId], foreignColumns: [implementationCompletionArtifactSnapshots.completionId, implementationCompletionArtifactSnapshots.artifactId, implementationCompletionArtifactSnapshots.artifactVersionId], name: "implementation_completion_workflows_artifact_snapshot_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.accountId, table.courseId, table.artifactId, table.artifactVersionId, table.workflowId], foreignColumns: [implementationWorkflows.accountId, implementationWorkflows.courseId, implementationWorkflows.artifactId, implementationWorkflows.artifactVersionId, implementationWorkflows.id], name: "implementation_completion_workflows_workflow_fk" }).onDelete("restrict").onUpdate("restrict"),
]);
