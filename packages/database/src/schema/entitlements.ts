import { sql } from "drizzle-orm";
import {
  check,
  boolean,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts, memberships } from "./identity.js";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const instant = (name: string) => timestamp(name, {
  precision: 3,
  withTimezone: true,
});

const accountReference = () => uuid("account_id").notNull().references(
  () => accounts.id,
  { onDelete: "restrict", onUpdate: "restrict" },
);

export const entitlementSources = pgTable(
  "entitlement_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: accountReference(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    offerCode: text("offer_code"),
    academySourceRegistryId: uuid("academy_source_registry_id"),
    provenance: text("provenance").notNull(),
    createdAt: instant("created_at").notNull(),
  },
  (table) => [
    unique("entitlement_sources_global_source_unique").on(
      table.sourceKind,
      table.sourceId,
    ),
    unique("entitlement_sources_id_account_unique").on(table.id, table.accountId),
    unique("entitlement_sources_core_identity_unique").on(
      table.id,
      table.accountId,
      table.sourceKind,
      table.sourceId,
    ),
    foreignKey({
      columns: [table.academySourceRegistryId, table.accountId],
      foreignColumns: [table.id, table.accountId],
      name: "entitlement_sources_academy_parent_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    check("entitlement_sources_kind_check", sql`${table.sourceKind} in ('purchase','subscription','administrative')`),
    check("entitlement_sources_source_id_check", sql`octet_length(${table.sourceId}) between 1 and 255`),
    check("entitlement_sources_offer_check", sql`${table.offerCode} is null or ${table.offerCode} in ('guided_pilot','self_paced','operator_club_monthly','operator_club_annual','business_os')`),
    check("entitlement_sources_product_offer_check", sql`(${table.sourceKind} = 'administrative' and ${table.academySourceRegistryId} is null) or (${table.sourceKind} = 'purchase' and ${table.offerCode} in ('guided_pilot','self_paced','business_os') and ${table.academySourceRegistryId} is null) or (${table.sourceKind} = 'subscription' and ${table.offerCode} in ('operator_club_monthly','operator_club_annual') and ${table.academySourceRegistryId} is not null) or (${table.sourceKind} = 'subscription' and ${table.offerCode}='business_os' and ${table.academySourceRegistryId} is null)`),
    check("entitlement_sources_provenance_check", sql`octet_length(${table.provenance}) between 1 and 255`),
    check("entitlement_sources_created_time_check", sql`isfinite(${table.createdAt}) and ${table.createdAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} = date_trunc('milliseconds', ${table.createdAt})`),
    index("entitlement_sources_account_idx").on(table.accountId),
  ],
);

export const entitlementGrants = pgTable(
  "entitlement_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: accountReference(),
    sourceRegistryId: uuid("source_registry_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    offerCode: text("offer_code"),
    capability: text("capability").notNull(),
    status: text("status").notNull(),
    startsAt: instant("starts_at").notNull(),
    endsAt: instant("ends_at"),
    provenance: text("provenance").notNull(),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.sourceRegistryId,
        table.accountId,
        table.sourceKind,
        table.sourceId,
      ],
      foreignColumns: [
        entitlementSources.id,
        entitlementSources.accountId,
        entitlementSources.sourceKind,
        entitlementSources.sourceId,
      ],
      name: "entitlement_grants_source_core_identity_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    unique("entitlement_grants_source_capability_unique").on(
      table.accountId,
      table.sourceKind,
      table.sourceId,
      table.capability,
    ),
    unique("entitlement_grants_id_account_unique").on(table.id, table.accountId),
    check("entitlement_grants_capability_check", sql`${table.capability} in ('academy_course','support','circle_write','operator_club','business_os')`),
    check("entitlement_grants_status_check", sql`${table.status} in ('active','grace','expired','refunded','revoked')`),
    check("entitlement_grants_kind_check", sql`${table.sourceKind} in ('purchase','subscription','administrative')`),
    check("entitlement_grants_source_id_check", sql`octet_length(${table.sourceId}) between 1 and 255`),
    check("entitlement_grants_interval_check", sql`${table.endsAt} is null or ${table.endsAt} > ${table.startsAt}`),
    check("entitlement_grants_grace_check", sql`${table.status} <> 'grace' or (${table.sourceKind} = 'subscription' and ${table.endsAt} is not null)`),
    check("entitlement_grants_business_os_subscription_check", sql`${table.capability} <> 'business_os' or (${table.sourceKind} = 'subscription' and ${table.offerCode} = 'business_os' and ${table.endsAt} is not null)`),
    check("entitlement_grants_offer_check", sql`${table.offerCode} is null or ${table.offerCode} in ('guided_pilot','self_paced','operator_club_monthly','operator_club_annual','business_os')`),
    check("entitlement_grants_provenance_check", sql`octet_length(${table.provenance}) between 1 and 255`),
    check("entitlement_grants_time_check", sql`isfinite(${table.startsAt}) and (${table.endsAt} is null or isfinite(${table.endsAt})) and isfinite(${table.createdAt}) and isfinite(${table.updatedAt}) and ${table.startsAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.startsAt} < '10000-01-01 00:00:00+00'::timestamptz and (${table.endsAt} is null or (${table.endsAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.endsAt} < '10000-01-01 00:00:00+00'::timestamptz)) and ${table.createdAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.updatedAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.updatedAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.startsAt} = date_trunc('milliseconds', ${table.startsAt}) and (${table.endsAt} is null or ${table.endsAt} = date_trunc('milliseconds', ${table.endsAt})) and ${table.createdAt} = date_trunc('milliseconds', ${table.createdAt}) and ${table.updatedAt} = date_trunc('milliseconds', ${table.updatedAt})`),
    index("entitlement_grants_account_effective_idx").on(
      table.accountId,
      table.capability,
      table.startsAt,
      table.endsAt,
    ),
    index("entitlement_grants_source_registry_idx").on(table.sourceRegistryId),
    uniqueIndex("entitlement_grants_one_structural_academy_purchase_slot")
      .on(table.accountId)
      .where(sql`${table.capability} = 'academy_course' and ${table.sourceKind} = 'purchase' and ${table.offerCode} in ('self_paced','guided_pilot') and ${table.status} in ('active','grace')`),
    uniqueIndex("entitlement_grants_one_effective_club_subscription")
      .on(table.accountId)
      .where(sql`${table.capability} = 'operator_club' and ${table.sourceKind} = 'subscription' and ${table.offerCode} in ('operator_club_monthly','operator_club_annual') and ${table.status} in ('active','grace')`),
    uniqueIndex("entitlement_grants_one_effective_business_os_subscription")
      .on(table.accountId)
      .where(sql`${table.capability} = 'business_os' and ${table.sourceKind} = 'subscription' and ${table.offerCode} = 'business_os' and ${table.status} in ('active','grace')`),
  ],
);

export const businessOsSetupReceipts = pgTable(
  "business_os_setup_receipts",
  {
    sourceRegistryId: uuid("source_registry_id").primaryKey(),
    accountId: accountReference(),
    reconciliationId: uuid("reconciliation_id"),
    status: text("status").notNull(),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceRegistryId, table.accountId],
      foreignColumns: [entitlementSources.id, entitlementSources.accountId],
      name: "business_os_setup_receipts_source_account_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      columns: [table.reconciliationId, table.accountId],
      foreignColumns: [commerceReconciliations.id, commerceReconciliations.accountId],
      name: "business_os_setup_receipts_reconciliation_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    unique("business_os_setup_receipts_reconciliation_id_unique")
      .on(table.reconciliationId),
    check("business_os_setup_receipts_status_check", sql`${table.status} in ('paid','paid_reconciliation','refunded','dispute_lost')`),
    check("business_os_setup_receipts_reconciliation_check", sql`${table.status}<>'paid_reconciliation' or ${table.reconciliationId} is not null`),
    check("business_os_setup_receipts_time_check", sql`isfinite(${table.createdAt}) and isfinite(${table.updatedAt}) and ${table.createdAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.updatedAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.updatedAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.updatedAt} >= ${table.createdAt} and ${table.createdAt} = date_trunc('milliseconds', ${table.createdAt}) and ${table.updatedAt} = date_trunc('milliseconds', ${table.updatedAt})`),
    index("business_os_setup_receipts_account_idx").on(table.accountId),
    uniqueIndex("business_os_setup_receipts_one_nonterminal_epoch")
      .on(table.accountId)
      .where(sql`${table.status}='paid'`),
  ],
);

export const commerceFulfillmentReceipts = pgTable(
  "commerce_fulfillment_receipts",
  {
    sourceRegistryId: uuid("source_registry_id").primaryKey(),
    accountId: accountReference(),
    reconciliationId: uuid("reconciliation_id"),
    status: text("status").notNull(),
    startsAt: instant("starts_at").notNull(),
    endsAt: instant("ends_at"),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceRegistryId, table.accountId],
      foreignColumns: [entitlementSources.id, entitlementSources.accountId],
      name: "commerce_fulfillment_receipts_source_account_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      columns: [table.reconciliationId, table.accountId],
      foreignColumns: [commerceReconciliations.id, commerceReconciliations.accountId],
      name: "commerce_fulfillment_receipts_reconciliation_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    unique("commerce_fulfillment_receipts_reconciliation_id_unique")
      .on(table.reconciliationId),
    check("commerce_fulfillment_receipts_status_check", sql`${table.status} in ('fulfilled','reconciliation','cancelled','refunded','dispute_lost')`),
    check("commerce_fulfillment_receipts_reconciliation_check", sql`${table.status}<>'reconciliation' or ${table.reconciliationId} is not null`),
    check("commerce_fulfillment_receipts_interval_check", sql`${table.endsAt} is null or ${table.endsAt} > ${table.startsAt}`),
    check("commerce_fulfillment_receipts_time_check", sql`isfinite(${table.startsAt}) and (${table.endsAt} is null or isfinite(${table.endsAt})) and isfinite(${table.createdAt}) and isfinite(${table.updatedAt}) and ${table.startsAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.startsAt} < '10000-01-01 00:00:00+00'::timestamptz and (${table.endsAt} is null or ${table.endsAt} < '10000-01-01 00:00:00+00'::timestamptz) and ${table.createdAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.updatedAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.updatedAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.updatedAt} >= ${table.createdAt} and ${table.startsAt} = date_trunc('milliseconds', ${table.startsAt}) and (${table.endsAt} is null or ${table.endsAt} = date_trunc('milliseconds', ${table.endsAt})) and ${table.createdAt} = date_trunc('milliseconds', ${table.createdAt}) and ${table.updatedAt} = date_trunc('milliseconds', ${table.updatedAt})`),
    index("commerce_fulfillment_receipts_account_idx").on(table.accountId),
  ],
);

export const commerceReconciliations = pgTable(
  "commerce_reconciliations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: accountReference(),
    commandKind: text("command_kind").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    reasonCode: text("reason_code").notNull(),
    incidentKind: text("incident_kind").notNull(),
    targetSourceRegistryId: uuid("target_source_registry_id").references(
      () => entitlementSources.id,
      { onDelete: "restrict", onUpdate: "restrict" },
    ),
    expectedPaidThroughAt: instant("expected_paid_through_at"),
    status: text("status").notNull().default("open"),
    reviewDueAt: instant("review_due_at").notNull(),
    claimedByStaffId: uuid("claimed_by_staff_id"),
    claimedAt: instant("claimed_at"),
    resolvedAt: instant("resolved_at"),
    resolutionCode: text("resolution_code"),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (table) => [
    unique("commerce_reconciliations_event_fingerprint_unique").on(
      table.accountId,
      table.commandKind,
      table.sourceKind,
      table.sourceId,
      table.requestFingerprint,
    ),
    unique("commerce_reconciliations_id_account_unique").on(table.id, table.accountId),
    check("commerce_reconciliations_kind_check", sql`${table.commandKind} in ('fulfill_product','business_os_setup_paid','open_dispute','resolve_dispute','club_cancelled','business_os_cancelled','refund_product')`),
    check("commerce_reconciliations_source_kind_check", sql`octet_length(${table.sourceKind}) between 1 and 64`),
    check("commerce_reconciliations_source_id_check", sql`octet_length(${table.sourceId}) between 1 and 255`),
    check("commerce_reconciliations_fingerprint_check", sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
    check("commerce_reconciliations_reason_check", sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`),
    check("commerce_reconciliations_incident_kind_check", sql`${table.incidentKind} in ('parked_paid_receipt','provider_source_collision','linked_academy_refund','linked_club_cancellation')`),
    check("commerce_reconciliations_status_check", sql`${table.status} in ('open','claimed','resolved_fulfilled','resolved_refund','resolved_manual')`),
    check("commerce_reconciliations_resolution_check", sql`${table.resolutionCode} is null or ${table.resolutionCode} in ('fulfilled','refund','manual','club_cancelled','club_refunded','abort_refund','dispute_lost','superseded_by_dispute')`),
    check("commerce_reconciliations_state_check", sql`(${table.status}='open' and ${table.claimedByStaffId} is null and ${table.claimedAt} is null and ${table.resolvedAt} is null and ${table.resolutionCode} is null) or (${table.status}='claimed' and ${table.claimedByStaffId} is not null and ${table.claimedAt} is not null and ${table.resolvedAt} is null and ${table.resolutionCode} is null) or (${table.status} like 'resolved_%' and ${table.resolvedAt} is not null and ${table.resolutionCode} is not null)`),
    check("commerce_reconciliations_time_check", sql`isfinite(${table.reviewDueAt}) and isfinite(${table.createdAt}) and isfinite(${table.updatedAt}) and (${table.claimedAt} is null or isfinite(${table.claimedAt})) and (${table.resolvedAt} is null or isfinite(${table.resolvedAt})) and (${table.expectedPaidThroughAt} is null or (isfinite(${table.expectedPaidThroughAt}) and ${table.expectedPaidThroughAt}>='2000-01-01 00:00:00+00'::timestamptz and ${table.expectedPaidThroughAt}<'10000-01-01 00:00:00+00'::timestamptz and ${table.expectedPaidThroughAt}=date_trunc('milliseconds',${table.expectedPaidThroughAt}))) and ${table.reviewDueAt}=${table.createdAt}+interval '48 hours' and ${table.updatedAt}>=${table.createdAt} and (${table.claimedAt} is null or ${table.claimedAt}>=${table.createdAt}) and (${table.resolvedAt} is null or ${table.resolvedAt}>=${table.createdAt}) and ${table.reviewDueAt}=date_trunc('milliseconds',${table.reviewDueAt}) and ${table.createdAt}=date_trunc('milliseconds',${table.createdAt}) and ${table.updatedAt}=date_trunc('milliseconds',${table.updatedAt}) and (${table.claimedAt} is null or ${table.claimedAt}=date_trunc('milliseconds',${table.claimedAt})) and (${table.resolvedAt} is null or ${table.resolvedAt}=date_trunc('milliseconds',${table.resolvedAt}))`),
    index("commerce_reconciliations_staff_queue_idx")
      .on(table.status, table.reviewDueAt, table.id)
      .where(sql`${table.status} in ('open','claimed')`),
    index("commerce_reconciliations_account_idx")
      .on(table.accountId, table.createdAt, table.id),
  ],
);

export const administrativeGrantRestorations = pgTable(
  "administrative_grant_restorations",
  {
    newSourceRegistryId: uuid("new_source_registry_id").primaryKey(),
    accountId: accountReference(),
    terminalGrantId: uuid("terminal_grant_id").notNull().unique(),
    createdAt: instant("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.newSourceRegistryId, table.accountId],
      foreignColumns: [entitlementSources.id, entitlementSources.accountId],
      name: "administrative_restorations_source_account_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      columns: [table.terminalGrantId, table.accountId],
      foreignColumns: [entitlementGrants.id, entitlementGrants.accountId],
      name: "administrative_restorations_grant_account_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    check("administrative_restorations_time_check", sql`isfinite(${table.createdAt}) and ${table.createdAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} = date_trunc('milliseconds', ${table.createdAt})`),
    index("administrative_grant_restorations_account_idx").on(table.accountId),
  ],
);

export const clubSubscriptionCancellations = pgTable(
  "club_subscription_cancellations",
  {
    sourceRegistryId: uuid("source_registry_id").primaryKey(),
    accountId: accountReference(),
    paidThroughAt: instant("paid_through_at").notNull(),
    createdAt: instant("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceRegistryId, table.accountId],
      foreignColumns: [entitlementSources.id, entitlementSources.accountId],
      name: "club_subscription_cancellations_source_account_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    check("club_subscription_cancellations_time_check", sql`isfinite(${table.paidThroughAt}) and isfinite(${table.createdAt}) and ${table.paidThroughAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.paidThroughAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.paidThroughAt} = date_trunc('milliseconds', ${table.paidThroughAt}) and ${table.createdAt} = date_trunc('milliseconds', ${table.createdAt})`),
    index("club_subscription_cancellations_account_idx").on(table.accountId),
  ],
);

export const businessOsSubscriptionCancellations = pgTable(
  "business_os_subscription_cancellations",
  {
    sourceRegistryId: uuid("source_registry_id").primaryKey(),
    accountId: accountReference(),
    paidThroughAt: instant("paid_through_at").notNull(),
    createdAt: instant("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceRegistryId, table.accountId],
      foreignColumns: [entitlementSources.id, entitlementSources.accountId],
      name: "business_os_subscription_cancellations_source_account_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    check("business_os_subscription_cancellations_time_check", sql`isfinite(${table.paidThroughAt}) and isfinite(${table.createdAt}) and ${table.paidThroughAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.paidThroughAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.paidThroughAt} = date_trunc('milliseconds', ${table.paidThroughAt}) and ${table.createdAt} = date_trunc('milliseconds', ${table.createdAt})`),
    index("business_os_subscription_cancellations_account_idx").on(table.accountId),
  ],
);

export const accountHoldSources = pgTable(
  "account_hold_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: accountReference(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    targetSourceRegistryId: uuid("target_source_registry_id").notNull(),
    createdAt: instant("created_at").notNull(),
  },
  (table) => [
    unique("account_hold_sources_global_source_unique").on(
      table.sourceKind,
      table.sourceId,
    ),
    unique("account_hold_sources_id_account_unique").on(table.id, table.accountId),
    foreignKey({
      columns: [table.targetSourceRegistryId, table.accountId],
      foreignColumns: [entitlementSources.id, entitlementSources.accountId],
      name: "account_hold_sources_target_account_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    check("account_hold_sources_kind_check", sql`octet_length(${table.sourceKind}) between 1 and 64`),
    check("account_hold_sources_id_check", sql`octet_length(${table.sourceId}) between 1 and 255`),
    check("account_hold_sources_created_time_check", sql`isfinite(${table.createdAt}) and ${table.createdAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} = date_trunc('milliseconds', ${table.createdAt})`),
    index("account_hold_sources_account_idx").on(table.accountId),
  ],
);

export const accountHolds = pgTable(
  "account_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: accountReference(),
    sourceRegistryId: uuid("source_registry_id").notNull(),
    kind: text("kind").notNull(),
    createdAt: instant("created_at").notNull(),
    releasedAt: instant("released_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceRegistryId, table.accountId],
      foreignColumns: [accountHoldSources.id, accountHoldSources.accountId],
      name: "account_holds_source_account_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    unique("account_holds_source_kind_unique").on(table.sourceRegistryId, table.kind),
    check("account_holds_kind_check", sql`${table.kind} in ('commerce','seat_changes','business_os_activation')`),
    check("account_holds_release_check", sql`${table.releasedAt} is null or ${table.releasedAt} >= ${table.createdAt}`),
    check("account_holds_time_check", sql`isfinite(${table.createdAt}) and (${table.releasedAt} is null or isfinite(${table.releasedAt})) and ${table.createdAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} < '10000-01-01 00:00:00+00'::timestamptz and (${table.releasedAt} is null or (${table.releasedAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.releasedAt} < '10000-01-01 00:00:00+00'::timestamptz)) and ${table.createdAt} = date_trunc('milliseconds', ${table.createdAt}) and (${table.releasedAt} is null or ${table.releasedAt} = date_trunc('milliseconds', ${table.releasedAt}))`),
    index("account_holds_account_open_idx").on(table.accountId, table.kind),
  ],
);

export const seatInvitations = pgTable(
  "seat_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: accountReference(),
    normalizedEmail: text("normalized_email").notNull(),
    expiresAt: instant("expires_at").notNull(),
    createdAt: instant("created_at").notNull(),
  },
  (table) => [
    unique("seat_invitations_id_account_unique").on(table.id, table.accountId),
    check("seat_invitations_email_check", sql`${table.normalizedEmail} = lower(btrim(${table.normalizedEmail})) and octet_length(${table.normalizedEmail}) between 3 and 320`),
    check("seat_invitations_expiry_check", sql`${table.expiresAt} = ${table.createdAt} + interval '168 hours'`),
    check("seat_invitations_time_check", sql`isfinite(${table.createdAt}) and isfinite(${table.expiresAt}) and ${table.createdAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.expiresAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} = date_trunc('milliseconds', ${table.createdAt}) and ${table.expiresAt} = date_trunc('milliseconds', ${table.expiresAt})`),
    index("seat_invitations_account_idx").on(table.accountId, table.createdAt),
  ],
);

export const seatInvitationTokenGenerations = pgTable(
  "seat_invitation_token_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: accountReference(),
    invitationId: uuid("invitation_id").notNull(),
    generation: integer("generation").notNull(),
    tokenHash: bytea("token_hash").notNull(),
    expiresAt: instant("expires_at").notNull(),
    consumedAt: instant("consumed_at"),
    supersededAt: instant("superseded_at"),
    createdAt: instant("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.invitationId, table.accountId],
      foreignColumns: [seatInvitations.id, seatInvitations.accountId],
      name: "seat_invitation_tokens_invitation_account_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    unique("seat_invitation_tokens_generation_unique").on(table.invitationId, table.generation),
    unique("seat_invitation_tokens_hash_unique").on(table.tokenHash),
    check("seat_invitation_tokens_generation_check", sql`${table.generation} > 0`),
    check("seat_invitation_tokens_hash_check", sql`octet_length(${table.tokenHash}) = 32`),
    check("seat_invitation_tokens_state_check", sql`not (${table.consumedAt} is not null and ${table.supersededAt} is not null)`),
    check("seat_invitation_tokens_time_check", sql`${table.expiresAt} > ${table.createdAt} and (${table.consumedAt} is null or ${table.consumedAt} >= ${table.createdAt}) and (${table.supersededAt} is null or ${table.supersededAt} >= ${table.createdAt})`),
    check("seat_invitation_tokens_commercial_time_check", sql`isfinite(${table.createdAt}) and isfinite(${table.expiresAt}) and (${table.consumedAt} is null or isfinite(${table.consumedAt})) and (${table.supersededAt} is null or isfinite(${table.supersededAt})) and ${table.createdAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.expiresAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} = date_trunc('milliseconds', ${table.createdAt}) and ${table.expiresAt} = date_trunc('milliseconds', ${table.expiresAt}) and (${table.consumedAt} is null or (${table.consumedAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.consumedAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.consumedAt} = date_trunc('milliseconds', ${table.consumedAt}))) and (${table.supersededAt} is null or (${table.supersededAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.supersededAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.supersededAt} = date_trunc('milliseconds', ${table.supersededAt})))`),
    index("seat_invitation_tokens_live_idx").on(table.tokenHash, table.expiresAt),
    uniqueIndex("seat_invitation_tokens_one_live_generation")
      .on(table.invitationId)
      .where(sql`${table.consumedAt} is null and ${table.supersededAt} is null`),
  ],
);

export const seatReservations = pgTable(
  "seat_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: accountReference(),
    slot: integer("slot").notNull(),
    sourceRegistryId: uuid("source_registry_id").notNull(),
    state: text("state").notNull(),
    membershipId: uuid("membership_id"),
    invitationId: uuid("invitation_id"),
    expiresAt: instant("expires_at"),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceRegistryId, table.accountId],
      foreignColumns: [entitlementSources.id, entitlementSources.accountId],
      name: "seat_reservations_source_account_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      columns: [table.membershipId, table.accountId],
      foreignColumns: [memberships.id, memberships.accountId],
      name: "seat_reservations_membership_account_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    foreignKey({
      columns: [table.invitationId, table.accountId],
      foreignColumns: [seatInvitations.id, seatInvitations.accountId],
      name: "seat_reservations_invitation_account_fk",
    }).onDelete("restrict").onUpdate("restrict"),
    check("seat_reservations_slot_check", sql`${table.slot} between 1 and 3`),
    check("seat_reservations_state_check", sql`${table.state} in ('pending','active','expired','revoked')`),
    check("seat_reservations_columns_check", sql`(${table.state} = 'pending' and ${table.membershipId} is null and ${table.invitationId} is not null and ${table.expiresAt} is not null) or (${table.state} = 'active' and ${table.membershipId} is not null and ${table.expiresAt} is null) or (${table.state} = 'expired' and ${table.membershipId} is null and ${table.invitationId} is not null and ${table.expiresAt} is not null) or (${table.state} = 'revoked' and ((${table.membershipId} is null and ${table.invitationId} is not null and ${table.expiresAt} is not null) or (${table.membershipId} is not null and ${table.expiresAt} is null)))`),
    check("seat_reservations_time_check", sql`isfinite(${table.createdAt}) and isfinite(${table.updatedAt}) and (${table.expiresAt} is null or isfinite(${table.expiresAt})) and ${table.createdAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.createdAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.updatedAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.updatedAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.updatedAt} >= ${table.createdAt} and ${table.createdAt} = date_trunc('milliseconds', ${table.createdAt}) and ${table.updatedAt} = date_trunc('milliseconds', ${table.updatedAt}) and (${table.expiresAt} is null or (${table.expiresAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.expiresAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.expiresAt} = date_trunc('milliseconds', ${table.expiresAt})))`),
    index("seat_reservations_account_idx").on(table.accountId, table.slot),
    uniqueIndex("seat_reservations_occupied_slot_unique")
      .on(table.accountId, table.slot)
      .where(sql`${table.state} in ('pending','active')`),
    uniqueIndex("seat_reservations_active_membership_unique")
      .on(table.membershipId)
      .where(sql`${table.state} = 'active'`),
    unique("seat_reservations_invitation_unique").on(table.invitationId),
  ],
);

export const accessDecisionAudit = pgTable(
  "access_decision_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: accountReference(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    commandId: uuid("command_id").notNull(),
    checkKind: text("check_kind").notNull(),
    allowed: boolean("allowed").notNull(),
    reasonCode: text("reason_code").notNull(),
    sourceGrantIds: uuid("source_grant_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
    snapshotVersion: integer("snapshot_version"),
    snapshotHash: text("snapshot_hash"),
    occurredAt: instant("occurred_at").notNull(),
  },
  (table) => [
    unique("access_decision_audit_command_check_unique").on(
      table.accountId,
      table.commandId,
      table.checkKind,
    ),
    check("access_decision_audit_actor_type_check", sql`${table.actorType} in ('member','staff','system')`),
    check("access_decision_audit_actor_id_check", sql`octet_length(${table.actorId}) between 1 and 255`),
    check("access_decision_audit_check_kind_check", sql`octet_length(${table.checkKind}) between 1 and 128`),
    check("access_decision_audit_reason_check", sql`octet_length(${table.reasonCode}) between 1 and 128`),
    check("access_decision_audit_source_ids_check", sql`array_position(${table.sourceGrantIds}, null) is null and cardinality(${table.sourceGrantIds}) <= 64`),
    check("access_decision_audit_snapshot_check", sql`(${table.snapshotVersion} is null) = (${table.snapshotHash} is null) and (${table.snapshotVersion} is null or (${table.snapshotVersion} = 1 and ${table.snapshotHash} ~ '^[0-9a-f]{64}$'))`),
    check("access_decision_audit_time_check", sql`isfinite(${table.occurredAt}) and ${table.occurredAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.occurredAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.occurredAt} = date_trunc('milliseconds', ${table.occurredAt})`),
    index("access_decision_audit_account_time_idx").on(table.accountId, table.occurredAt),
  ],
);

export const entitlementCommands = pgTable(
  "entitlement_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    accountId: accountReference(),
    commandKind: text("command_kind").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    firstCorrelationId: uuid("first_correlation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    outcome: text("outcome"),
    result: jsonb("result"),
    occurredAt: instant("occurred_at").notNull(),
    completedAt: instant("completed_at"),
  },
  (table) => [
    check("entitlement_commands_kind_check", sql`${table.commandKind} in ('fulfill_product','establish_owner','reserve_seat','resend_invitation','redeem_invitation','expire_invitation','revoke_seat','replace_seat','transfer_owner','refund_product','open_dispute','resolve_dispute','club_payment_failed','club_payment_recovered','club_cancelled','expire_club','expire_support','business_os_payment_failed','business_os_payment_recovered','business_os_renewed','business_os_cancelled','expire_business_os','grant_administrative','revoke_administrative','restore_administrative','business_os_setup_paid','reconcile_business_os_setup','reconcile_product_fulfillment','suspend_account','reactivate_account','revoke_member','claim_commerce_reconciliation','resolve_commerce_reconciliation')`),
    check("entitlement_commands_actor_check", sql`${table.actorType} in ('member','staff','system') and octet_length(${table.actorId}) between 1 and 255`),
    check("entitlement_commands_hash_check", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    check("entitlement_commands_completion_check", sql`(${table.outcome} is null and ${table.result} is null and ${table.completedAt} is null) or (${table.outcome} in ('applied','denied') and jsonb_typeof(${table.result})='object' and octet_length(${table.result}::text)<=16384 and ${table.completedAt} is not null and ${table.completedAt}>=${table.occurredAt})`),
    check("entitlement_commands_time_check", sql`isfinite(${table.occurredAt}) and (${table.completedAt} is null or isfinite(${table.completedAt})) and ${table.occurredAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.occurredAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.occurredAt} = date_trunc('milliseconds', ${table.occurredAt}) and (${table.completedAt} is null or (${table.completedAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.completedAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.completedAt} = date_trunc('milliseconds', ${table.completedAt})))`),
    index("entitlement_commands_account_time_idx").on(
      table.accountId,
      table.occurredAt,
    ),
  ],
);
