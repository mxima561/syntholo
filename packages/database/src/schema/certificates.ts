import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn, PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { apiCommandReceipts, courseVersions } from "./content.js";
import { accounts, memberIdentities, memberships, staffIdentities } from "./identity.js";
import { certificatePrerequisites, courseCompletions } from "./learning.js";

const instant = (name: string) => timestamp(name, { precision: 3, withTimezone: true });
const id = (name: string) => uuid(name).notNull();

export const certificateRecipientNameVersions = pgTable("certificate_recipient_name_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: id("account_id").references(() => accounts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  membershipId: id("membership_id"),
  version: integer("version").notNull(),
  displayName: text("display_name").notNull(),
  contentHash: text("content_hash").notNull(),
  actorIdentityId: id("actor_identity_id"),
  sourceCommandReceiptId: id("source_command_receipt_id")
    .references(() => apiCommandReceipts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  correlationId: id("correlation_id"),
  confirmedAt: instant("confirmed_at").notNull()
    .default(sql`date_trunc('milliseconds',clock_timestamp())`),
}, (table) => [
  foreignKey({
    columns: [table.membershipId, table.accountId, table.actorIdentityId],
    foreignColumns: [memberships.id, memberships.accountId, memberships.memberIdentityId],
    name: "certificate_name_versions_membership_actor_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({
    columns: [table.actorIdentityId, table.accountId],
    foreignColumns: [memberIdentities.id, memberIdentities.accountId],
    name: "certificate_name_versions_actor_account_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  unique("certificate_name_versions_scope_version_unique")
    .on(table.accountId, table.membershipId, table.version),
  unique("certificate_name_versions_exact_unique")
    .on(table.id, table.accountId, table.membershipId, table.version),
  unique("certificate_name_versions_snapshot_exact_unique")
    .on(table.id, table.accountId, table.membershipId, table.version, table.displayName),
  unique("certificate_name_versions_source_receipt_unique").on(table.sourceCommandReceiptId),
  check("certificate_name_versions_version_check", sql`${table.version}>0`),
  check("certificate_name_versions_display_name_check", sql`public.syntholo_certificate_recipient_name_valid_v1(${table.displayName})`),
  check("certificate_name_versions_content_hash_check", sql`public.syntholo_certificate_name_content_hash_valid_v1(${table.displayName},${table.contentHash})`),
  index("certificate_name_versions_history_idx")
    .on(table.accountId, table.membershipId, table.version.desc()),
]);

export const certificateRecipientNameHeads = pgTable("certificate_recipient_name_heads", {
  accountId: id("account_id").references(() => accounts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  membershipId: id("membership_id"),
  currentVersion: integer("current_version").notNull(),
  currentVersionId: id("current_version_id"),
  createdAt: instant("created_at").notNull()
    .default(sql`date_trunc('milliseconds',clock_timestamp())`),
  updatedAt: instant("updated_at").notNull()
    .default(sql`date_trunc('milliseconds',clock_timestamp())`),
}, (table): PgTableExtraConfigValue[] => [
  primaryKey({
    name: "certificate_recipient_name_heads_pkey",
    columns: [table.accountId, table.membershipId],
  }),
  foreignKey({
    columns: [table.membershipId, table.accountId],
    foreignColumns: [memberships.id, memberships.accountId],
    name: "certificate_name_heads_membership_account_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({
    columns: [table.currentVersionId, table.accountId, table.membershipId, table.currentVersion],
    foreignColumns: [
      certificateRecipientNameVersions.id,
      certificateRecipientNameVersions.accountId,
      certificateRecipientNameVersions.membershipId,
      certificateRecipientNameVersions.version,
    ] as [AnyPgColumn, AnyPgColumn, AnyPgColumn, AnyPgColumn],
    name: "certificate_name_heads_current_version_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  check("certificate_name_heads_version_check", sql`${table.currentVersion}>0`),
]);

export const certificateRecords = pgTable("certificate_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  certificatePrerequisiteId: id("certificate_prerequisite_id"),
  courseCompletionId: id("course_completion_id"),
  accountId: id("account_id").references(() => accounts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  membershipId: id("membership_id"),
  enrollmentId: id("enrollment_id"),
  courseId: id("course_id"),
  courseVersionId: id("course_version_id"),
  businessNameSnapshot: text("business_name_snapshot").notNull(),
  courseTitleSnapshot: text("course_title_snapshot").notNull(),
  courseVersion: integer("course_version").notNull(),
  completedAt: instant("completed_at").notNull(),
  snapshotRenderable: boolean("snapshot_renderable").notNull(),
  recipientNameVersionId: uuid("recipient_name_version_id"),
  recipientNameVersion: integer("recipient_name_version"),
  recipientNameSnapshot: text("recipient_name_snapshot"),
  rendererVersion: text("renderer_version").notNull().default("certificate-pdf.v1"),
  status: text("status").notNull(),
  failureCode: text("failure_code"),
  issuedAt: instant("issued_at"),
  createdAt: instant("created_at").notNull()
    .default(sql`date_trunc('milliseconds',clock_timestamp())`),
  updatedAt: instant("updated_at").notNull()
    .default(sql`date_trunc('milliseconds',clock_timestamp())`),
}, (table) => [
  foreignKey({
    columns: [
      table.courseCompletionId,
      table.accountId,
      table.membershipId,
      table.enrollmentId,
      table.courseId,
      table.courseVersionId,
    ],
    foreignColumns: [
      courseCompletions.id,
      courseCompletions.accountId,
      courseCompletions.membershipId,
      courseCompletions.enrollmentId,
      courseCompletions.courseId,
      courseCompletions.courseVersionId,
    ],
    name: "certificate_records_completion_exact_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({
    columns: [table.courseVersionId, table.courseId, table.courseVersion],
    foreignColumns: [courseVersions.id, courseVersions.courseId, courseVersions.version],
    name: "certificate_records_course_version_exact_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({
    columns: [
      table.certificatePrerequisiteId,
      table.courseCompletionId,
      table.accountId,
      table.membershipId,
      table.enrollmentId,
      table.courseId,
      table.courseVersionId,
    ],
    foreignColumns: [
      certificatePrerequisites.id,
      certificatePrerequisites.courseCompletionId,
      certificatePrerequisites.accountId,
      certificatePrerequisites.membershipId,
      certificatePrerequisites.enrollmentId,
      certificatePrerequisites.courseId,
      certificatePrerequisites.courseVersionId,
    ],
    name: "certificate_records_prerequisite_exact_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({
    columns: [
      table.recipientNameVersionId,
      table.accountId,
      table.membershipId,
      table.recipientNameVersion,
      table.recipientNameSnapshot,
    ],
    foreignColumns: [
      certificateRecipientNameVersions.id,
      certificateRecipientNameVersions.accountId,
      certificateRecipientNameVersions.membershipId,
      certificateRecipientNameVersions.version,
      certificateRecipientNameVersions.displayName,
    ],
    name: "certificate_records_recipient_name_version_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  unique("certificate_records_completion_unique").on(table.courseCompletionId),
  unique("certificate_records_prerequisite_unique").on(table.certificatePrerequisiteId),
  unique("certificate_records_member_exact_unique").on(table.id, table.accountId, table.membershipId),
  unique("certificate_records_exact_unique")
    .on(table.id, table.accountId, table.membershipId, table.courseCompletionId),
  check("certificate_records_renderer_check", sql`${table.rendererVersion}='certificate-pdf.v1' and ${table.courseVersion}>0`),
  check("certificate_records_snapshot_renderability_check", sql`${table.snapshotRenderable}=(public.syntholo_certificate_business_snapshot_renderable_v1(${table.businessNameSnapshot}) and public.syntholo_certificate_course_snapshot_renderable_v1(${table.courseTitleSnapshot}))`),
  check("certificate_records_state_check", sql`public.syntholo_certificate_record_state_valid_v1(${table.snapshotRenderable},${table.recipientNameVersionId},${table.recipientNameVersion},${table.recipientNameSnapshot},${table.status},${table.failureCode},${table.issuedAt})`),
  index("certificate_records_member_history_idx")
    .on(table.accountId, table.membershipId, table.completedAt.desc(), table.id.desc()),
]);

export const certificateFiles = pgTable("certificate_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  certificateId: id("certificate_id"),
  courseCompletionId: id("course_completion_id"),
  accountId: id("account_id"),
  membershipId: id("membership_id"),
  objectKey: text("object_key").notNull(),
  access: text("access").notNull(),
  contentType: text("content_type").notNull(),
  byteLength: integer("byte_length").notNull(),
  sha256: text("sha256").notNull(),
  etag: text("etag").notNull(),
  rendererVersion: text("renderer_version").notNull(),
  storedAt: instant("stored_at").notNull()
    .default(sql`date_trunc('milliseconds',clock_timestamp())`),
}, (table) => [
  foreignKey({
    columns: [table.certificateId, table.accountId, table.membershipId, table.courseCompletionId],
    foreignColumns: [
      certificateRecords.id,
      certificateRecords.accountId,
      certificateRecords.membershipId,
      certificateRecords.courseCompletionId,
    ],
    name: "certificate_files_record_exact_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  unique("certificate_files_certificate_unique").on(table.certificateId),
  unique("certificate_files_completion_unique").on(table.courseCompletionId),
  unique("certificate_files_exact_unique")
    .on(table.id, table.certificateId, table.accountId, table.membershipId, table.courseCompletionId),
  check("certificate_files_object_key_check", sql`${table.objectKey}='certificates/v1/'||${table.accountId}::text||'/'||${table.courseCompletionId}::text||'.pdf'`),
  check("certificate_files_access_check", sql`${table.access}='private'`),
  check("certificate_files_content_type_check", sql`${table.contentType}='application/pdf'`),
  check("certificate_files_byte_length_check", sql`${table.byteLength} between 1 and 26214400`),
  check("certificate_files_hash_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  check("certificate_files_etag_check", sql`public.syntholo_certificate_etag_valid_v1(${table.etag})`),
  check("certificate_files_renderer_check", sql`${table.rendererVersion}='certificate-pdf.v1'`),
]);

export const certificateDeliveryRequests = pgTable("certificate_delivery_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  certificateId: id("certificate_id"),
  accountId: id("account_id"),
  membershipId: id("membership_id"),
  staffIdentityId: id("staff_identity_id")
    .references(() => staffIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }),
  reason: text("reason").notNull(),
  sourceCommandReceiptId: id("source_command_receipt_id")
    .references(() => apiCommandReceipts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  correlationId: id("correlation_id"),
  status: text("status").notNull().default("delivery_pending"),
  createdAt: instant("created_at").notNull()
    .default(sql`date_trunc('milliseconds',clock_timestamp())`),
}, (table) => [
  foreignKey({
    columns: [table.certificateId, table.accountId, table.membershipId],
    foreignColumns: [certificateRecords.id, certificateRecords.accountId, certificateRecords.membershipId],
    name: "certificate_delivery_requests_record_exact_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  unique("certificate_delivery_requests_source_receipt_unique").on(table.sourceCommandReceiptId),
  unique("certificate_delivery_requests_exact_unique")
    .on(table.id, table.certificateId, table.accountId, table.membershipId),
  check("certificate_delivery_requests_status_check", sql`${table.status}='delivery_pending'`),
  check("certificate_delivery_requests_reason_check", sql`public.syntholo_certificate_text_valid_v1(${table.reason},2000,true)`),
  index("certificate_delivery_requests_certificate_idx").on(table.certificateId, table.createdAt),
]);
