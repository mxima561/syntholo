import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
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
import type { AnyPgColumn, PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { apiCommandReceipts } from "./content.js";
import { entitlementSources, seatInvitations } from "./entitlements.js";
import { accounts, staffIdentities } from "./identity.js";
import { providerEventReceipts } from "./operations.js";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const instant = (name: string) => timestamp(name, { precision: 3, withTimezone: true });
const now = (name: string) => instant(name).notNull()
  .default(sql`date_trunc('milliseconds',clock_timestamp())`);
const accountId = () => uuid("account_id").notNull().references(() => accounts.id, {
  onDelete: "restrict",
  onUpdate: "restrict",
});
const boundedText = (value: unknown, maximum = 255) =>
  sql`octet_length(${value}) between 1 and ${sql.raw(String(maximum))}`;

export const offers = pgTable("offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  family: text("family").notNull(),
  purchaseModel: text("purchase_model").notNull(),
  state: text("state").notNull().default("draft"),
  displayCurrency: text("display_currency").notNull().default("usd"),
  displayUnitAmount: integer("display_unit_amount").notNull(),
  displayRecurringUnitAmount: integer("display_recurring_unit_amount"),
  readinessPolicy: text("readiness_policy").notNull(),
  currentCatalogVersionId: uuid("current_catalog_version_id"),
  createdAt: now("created_at"),
  updatedAt: now("updated_at"),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({
    columns: [table.currentCatalogVersionId, table.id, table.code],
    foreignColumns: [offerCatalogVersions.id, offerCatalogVersions.offerId, offerCatalogVersions.offerCode] as [AnyPgColumn, AnyPgColumn, AnyPgColumn],
    name: "offers_current_catalog_exact_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  unique("offers_code_unique").on(table.code),
  unique("offers_id_code_unique").on(table.id, table.code),
  check("offers_code_check", sql`${table.code} in ('scorecard','self_paced','guided_pilot','operator_club_monthly','operator_club_annual','business_os')`),
  check("offers_family_check", sql`${table.family} in ('scorecard','academy','operator_club','business_os')`),
  check("offers_purchase_model_check", sql`${table.purchaseModel} in ('free','one_time','recurring','two_stage')`),
  check("offers_state_check", sql`${table.state} in ('draft','waitlist','enabled','paused')`),
  check("offers_money_check", sql`${table.displayCurrency}='usd' and ${table.displayUnitAmount}>=0 and (${table.displayRecurringUnitAmount} is null or ${table.displayRecurringUnitAmount}>0)`),
  check("offers_topology_check", sql`
    (${table.code}='scorecard' and ${table.family}='scorecard' and ${table.purchaseModel}='free' and ${table.displayUnitAmount}=0 and ${table.displayRecurringUnitAmount} is null)
    or (${table.code}='self_paced' and ${table.family}='academy' and ${table.purchaseModel}='one_time' and ${table.displayUnitAmount}=39900 and ${table.displayRecurringUnitAmount} is null)
    or (${table.code}='guided_pilot' and ${table.family}='academy' and ${table.purchaseModel}='one_time' and ${table.displayUnitAmount}=75000 and ${table.displayRecurringUnitAmount} is null)
    or (${table.code}='operator_club_monthly' and ${table.family}='operator_club' and ${table.purchaseModel}='recurring' and ${table.displayUnitAmount}=5900 and ${table.displayRecurringUnitAmount} is null)
    or (${table.code}='operator_club_annual' and ${table.family}='operator_club' and ${table.purchaseModel}='recurring' and ${table.displayUnitAmount}=59000 and ${table.displayRecurringUnitAmount} is null)
    or (${table.code}='business_os' and ${table.family}='business_os' and ${table.purchaseModel}='two_stage' and ${table.displayUnitAmount}=99900 and ${table.displayRecurringUnitAmount}=19900)
  `),
]);

export const offerCatalogVersions = pgTable("offer_catalog_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  offerId: uuid("offer_id").notNull(),
  offerCode: text("offer_code").notNull(),
  version: text("version").notNull(),
  state: text("state").notNull().default("draft"),
  policyVersions: jsonb("policy_versions").$type<Record<string, string>>().notNull(),
  contentReadinessHash: text("content_readiness_hash"),
  catalogHash: text("catalog_hash").notNull(),
  publishedAt: instant("published_at"),
  retiredAt: instant("retired_at"),
  createdAt: now("created_at"),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({
    columns: [table.offerId, table.offerCode],
    foreignColumns: [offers.id, offers.code],
    name: "offer_catalog_versions_offer_exact_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  unique("offer_catalog_versions_offer_version_unique").on(table.offerId, table.version),
  unique("offer_catalog_versions_exact_unique").on(table.id, table.offerId, table.offerCode, table.version),
  unique("offer_catalog_versions_current_owner_unique").on(table.id, table.offerId, table.offerCode),
  check("offer_catalog_versions_state_check", sql`${table.state} in ('draft','published','retired')`),
  check("offer_catalog_versions_hash_check", sql`${table.catalogHash}~'^[0-9a-f]{64}$' and (${table.contentReadinessHash} is null or ${table.contentReadinessHash}~'^[0-9a-f]{64}$')`),
  check("offer_catalog_versions_policy_check", sql`jsonb_typeof(${table.policyVersions})='object'`),
  check("offer_catalog_versions_lifecycle_check", sql`
    (${table.state}='draft' and ${table.publishedAt} is null and ${table.retiredAt} is null)
    or (${table.state}='published' and ${table.publishedAt} is not null and ${table.retiredAt} is null)
    or (${table.state}='retired' and ${table.publishedAt} is not null and ${table.retiredAt} is not null and ${table.retiredAt}>=${table.publishedAt})
  `),
]);

export const offerPriceBindings = pgTable("offer_price_bindings", {
  id: uuid("id").primaryKey().defaultRandom(),
  offerId: uuid("offer_id").notNull(),
  offerCode: text("offer_code").notNull(),
  catalogVersionId: uuid("catalog_version_id").notNull(),
  catalogVersion: text("catalog_version").notNull(),
  environment: text("environment").notNull(),
  stripeAccountId: text("stripe_account_id").notNull(),
  stripeProductId: text("stripe_product_id").notNull(),
  stripePriceId: text("stripe_price_id").notNull(),
  priceRole: text("price_role").notNull(),
  productTaxCode: text("product_tax_code").notNull(),
  currency: text("currency").notNull(),
  unitAmount: integer("unit_amount").notNull(),
  recurringInterval: text("recurring_interval"),
  intervalCount: integer("interval_count"),
  taxBehavior: text("tax_behavior").notNull(),
  quantity: integer("quantity").notNull().default(1),
  fingerprint: text("fingerprint").notNull(),
  verifiedAt: instant("verified_at").notNull(),
  enabledAt: instant("enabled_at"),
  retiredAt: instant("retired_at"),
  createdAt: now("created_at"),
}, (table) => [
  foreignKey({ columns: [table.offerId, table.offerCode], foreignColumns: [offers.id, offers.code], name: "offer_price_bindings_offer_exact_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.catalogVersionId, table.offerId, table.offerCode, table.catalogVersion], foreignColumns: [offerCatalogVersions.id, offerCatalogVersions.offerId, offerCatalogVersions.offerCode, offerCatalogVersions.version], name: "offer_price_bindings_catalog_exact_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("offer_price_bindings_exact_unique").on(table.id, table.offerId, table.catalogVersionId, table.environment),
  unique("offer_price_bindings_authorization_owner_unique").on(
    table.id,
    table.offerId,
    table.catalogVersionId,
  ),
  unique("offer_price_bindings_catalog_environment_owner_unique").on(
    table.id,
    table.catalogVersionId,
    table.environment,
  ),
  unique("offer_price_bindings_provider_owner_unique").on(
    table.id,
    table.offerId,
    table.catalogVersionId,
    table.environment,
    table.stripeAccountId,
  ),
  unique("offer_price_bindings_catalog_provider_owner_unique").on(
    table.id,
    table.catalogVersionId,
    table.environment,
    table.stripeAccountId,
  ),
  unique("offer_price_bindings_price_provider_unique").on(
    table.id,
    table.environment,
    table.stripeAccountId,
  ),
  unique("offer_price_bindings_role_unique").on(table.offerId, table.catalogVersionId, table.environment, table.priceRole),
  uniqueIndex("offer_price_bindings_provider_price_unique").on(table.environment, table.stripeAccountId, table.stripePriceId),
  uniqueIndex("offer_price_bindings_active_role_unique").on(table.offerId, table.catalogVersionId, table.environment, table.priceRole).where(sql`${table.enabledAt} is not null and ${table.retiredAt} is null`),
  check("offer_price_bindings_environment_check", sql`${table.environment} in ('test','staging','production')`),
  check("offer_price_bindings_money_check", sql`${table.currency}='usd' and ${table.unitAmount}>0 and ${table.quantity}=1`),
  check("offer_price_bindings_interval_check", sql`(${table.recurringInterval} is null and ${table.intervalCount} is null) or (${table.recurringInterval} in ('month','year') and ${table.intervalCount}=1)`),
  check("offer_price_bindings_tax_check", sql`${table.productTaxCode}~'^txcd_[A-Za-z0-9._:-]+$' and ${table.taxBehavior} in ('inclusive','exclusive')`),
  check("offer_price_bindings_role_shape_check", sql`
    (${table.priceRole}='self_paced_once' and ${table.offerCode}='self_paced' and ${table.unitAmount}=39900 and ${table.recurringInterval} is null)
    or (${table.priceRole}='guided_pilot_once' and ${table.offerCode}='guided_pilot' and ${table.unitAmount}=75000 and ${table.recurringInterval} is null)
    or (${table.priceRole}='operator_club_monthly' and ${table.offerCode}='operator_club_monthly' and ${table.unitAmount}=5900 and ${table.recurringInterval}='month')
    or (${table.priceRole}='operator_club_annual' and ${table.offerCode}='operator_club_annual' and ${table.unitAmount}=59000 and ${table.recurringInterval}='year')
    or (${table.priceRole}='business_os_setup' and ${table.offerCode}='business_os' and ${table.unitAmount}=99900 and ${table.recurringInterval} is null)
    or (${table.priceRole}='business_os_monthly' and ${table.offerCode}='business_os' and ${table.unitAmount}=19900 and ${table.recurringInterval}='month')
    or (${table.priceRole}='gate5_validation' and ${table.offerCode}='self_paced' and ${table.environment}='production' and ${table.recurringInterval} is null)
  `),
  check("offer_price_bindings_fingerprint_check", sql`${table.fingerprint}~'^[0-9a-f]{64}$'`),
  check("offer_price_bindings_lifecycle_check", sql`
    ${table.verifiedAt}=date_trunc('milliseconds',${table.verifiedAt})
    and ((${table.enabledAt} is null and ${table.retiredAt} is null)
      or (${table.enabledAt} is not null and ${table.enabledAt}=date_trunc('milliseconds',${table.enabledAt}) and ${table.enabledAt}>=${table.verifiedAt} and (${table.retiredAt} is null or (${table.retiredAt}=date_trunc('milliseconds',${table.retiredAt}) and ${table.retiredAt}>=${table.enabledAt}))))
  `),
]);

export const publicBusinessOsSetupIntents = pgTable("public_business_os_setup_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  family: text("family").notNull().default("business_os_setup"),
  purchaserGuardHmac: bytea("purchaser_guard_hmac").notNull(),
  semanticRequestHmac: bytea("semantic_request_hmac").notNull(),
  emailNormalizationVersion: text("email_normalization_version").notNull(),
  equalityKeyId: text("equality_key_id").notNull(),
  commandDigestKeyId: text("command_digest_key_id").notNull(),
  contactCiphertext: bytea("contact_ciphertext"),
  contactNonce: bytea("contact_nonce"),
  contactTag: bytea("contact_tag"),
  contactKeyId: text("contact_key_id"),
  businessNameCiphertext: bytea("business_name_ciphertext"),
  businessNameNonce: bytea("business_name_nonce"),
  businessNameTag: bytea("business_name_tag"),
  businessNameKeyId: text("business_name_key_id"),
  catalogVersionId: uuid("catalog_version_id").notNull(),
  priceBindingId: uuid("price_binding_id").notNull(),
  state: text("state").notNull().default("checkout_create_pending"),
  terminalizedAt: instant("terminalized_at"),
  securityHoldAt: instant("security_hold_at"),
  legalHoldAt: instant("legal_hold_at"),
  financialRetentionUntil: instant("financial_retention_until"),
  expiresAt: instant("expires_at").notNull(),
  createdAt: now("created_at"),
  updatedAt: now("updated_at"),
}, (table) => [
  foreignKey({ columns: [table.priceBindingId, table.catalogVersionId, table.environment, table.receiverStripeAccountId], foreignColumns: [offerPriceBindings.id, offerPriceBindings.catalogVersionId, offerPriceBindings.environment, offerPriceBindings.stripeAccountId], name: "public_bos_setup_intents_price_exact_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("public_bos_setup_intents_exact_unique").on(table.id, table.environment, table.receiverStripeAccountId),
  uniqueIndex("public_bos_setup_intents_one_blocking_guard").on(table.environment, table.purchaserGuardHmac, table.family).where(sql`${table.state} in ('checkout_create_pending','checkout_open','async_payment_pending','paid_processing','paid_consumed','refund_pending','dispute_open','terminal_security')`),
  index("public_bos_setup_intents_cleanup_idx").on(table.expiresAt, table.id).where(sql`${table.state}='terminal_abandoned_unpaid' and ${table.securityHoldAt} is null and ${table.legalHoldAt} is null`),
  check("public_bos_setup_intents_environment_check", sql`${table.environment} in ('test','staging','production')`),
  check("public_bos_setup_intents_family_check", sql`${table.family}='business_os_setup'`),
  check("public_bos_setup_intents_hmac_check", sql`octet_length(${table.purchaserGuardHmac})=32 and octet_length(${table.semanticRequestHmac})=32`),
  check("public_bos_setup_intents_contact_ciphertext_check", sql`
    (${table.contactCiphertext} is null and ${table.contactNonce} is null and ${table.contactTag} is null and ${table.contactKeyId} is null)
    or (octet_length(${table.contactCiphertext}) between 1 and 4096 and octet_length(${table.contactNonce})=12 and octet_length(${table.contactTag})=16 and ${boundedText(table.contactKeyId, 128)})
  `),
  check("public_bos_setup_intents_name_ciphertext_check", sql`
    (${table.businessNameCiphertext} is null and ${table.businessNameNonce} is null and ${table.businessNameTag} is null and ${table.businessNameKeyId} is null)
    or (octet_length(${table.businessNameCiphertext}) between 1 and 4096 and octet_length(${table.businessNameNonce})=12 and octet_length(${table.businessNameTag})=16 and ${boundedText(table.businessNameKeyId, 128)})
  `),
  check("public_bos_setup_intents_state_check", sql`${table.state} in ('checkout_create_pending','checkout_open','async_payment_pending','paid_processing','paid_consumed','refund_pending','dispute_open','terminal_refunded','terminal_dispute_lost','terminal_abandoned_unpaid','terminal_security')`),
]);

export const businessOsSetupEpochs = pgTable("business_os_setup_epochs", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: accountId(),
  ordinal: integer("ordinal").notNull(),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  catalogVersionId: uuid("catalog_version_id").notNull(),
  priceBindingId: uuid("price_binding_id").notNull(),
  state: text("state").notNull().default("checkout_create_pending"),
  publicIntentId: uuid("public_intent_id"),
  sourceRegistryId: uuid("source_registry_id"),
  provisioningStartedAt: instant("provisioning_started_at"),
  terminalizedAt: instant("terminalized_at"),
  createdAt: now("created_at"),
  updatedAt: now("updated_at"),
}, (table) => [
  foreignKey({ columns: [table.priceBindingId, table.catalogVersionId, table.environment, table.receiverStripeAccountId], foreignColumns: [offerPriceBindings.id, offerPriceBindings.catalogVersionId, offerPriceBindings.environment, offerPriceBindings.stripeAccountId], name: "business_os_setup_epochs_price_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.publicIntentId, table.environment, table.receiverStripeAccountId], foreignColumns: [publicBusinessOsSetupIntents.id, publicBusinessOsSetupIntents.environment, publicBusinessOsSetupIntents.receiverStripeAccountId], name: "business_os_setup_epochs_public_intent_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.sourceRegistryId, table.accountId], foreignColumns: [entitlementSources.id, entitlementSources.accountId], name: "business_os_setup_epochs_source_account_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("business_os_setup_epochs_scope_ordinal_unique").on(table.accountId, table.ordinal),
  unique("business_os_setup_epochs_exact_unique").on(table.id, table.accountId, table.environment),
  unique("business_os_setup_epochs_provider_owner_unique").on(table.id, table.accountId, table.environment, table.receiverStripeAccountId),
  uniqueIndex("business_os_setup_epochs_one_blocking_account").on(table.accountId).where(sql`${table.state} in ('checkout_create_pending','checkout_open','async_payment_pending','paid','refund_pending','dispute_open')`),
  check("business_os_setup_epochs_state_check", sql`${table.state} in ('checkout_create_pending','checkout_open','async_payment_pending','paid','refund_pending','dispute_open','terminal_abandoned_unpaid','terminal_refunded','terminal_dispute_lost')`),
  check("business_os_setup_epochs_ordinal_check", sql`${table.ordinal}>=1`),
]);

export const recurringPurchaseIntents = pgTable("recurring_purchase_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: accountId(),
  reservationCommandId: uuid("reservation_command_id").notNull(),
  reservationRequestHash: text("reservation_request_hash").notNull(),
  family: text("family").notNull(),
  offerCode: text("offer_code").notNull(),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  catalogVersionId: uuid("catalog_version_id").notNull(),
  priceBindingId: uuid("price_binding_id").notNull(),
  state: text("state").notNull().default("provider_call_pending"),
  setupEpochId: uuid("setup_epoch_id"),
  setupPurchaseId: uuid("setup_purchase_id"),
  academySourceRegistryId: uuid("academy_source_registry_id"),
  expiresAt: instant("expires_at").notNull(),
  terminalizedAt: instant("terminalized_at"),
  createdAt: now("created_at"),
  updatedAt: now("updated_at"),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({ columns: [table.priceBindingId, table.catalogVersionId, table.environment, table.receiverStripeAccountId], foreignColumns: [offerPriceBindings.id, offerPriceBindings.catalogVersionId, offerPriceBindings.environment, offerPriceBindings.stripeAccountId], name: "recurring_purchase_intents_price_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.setupEpochId, table.accountId, table.environment, table.receiverStripeAccountId], foreignColumns: [businessOsSetupEpochs.id, businessOsSetupEpochs.accountId, businessOsSetupEpochs.environment, businessOsSetupEpochs.receiverStripeAccountId], name: "recurring_purchase_intents_setup_epoch_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.setupPurchaseId, table.accountId, table.environment, table.receiverStripeAccountId], foreignColumns: [purchases.id, purchases.accountId, purchases.environment, purchases.receiverStripeAccountId] as [AnyPgColumn, AnyPgColumn, AnyPgColumn, AnyPgColumn], name: "recurring_purchase_intents_setup_purchase_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.academySourceRegistryId, table.accountId], foreignColumns: [entitlementSources.id, entitlementSources.accountId], name: "recurring_purchase_intents_academy_source_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("recurring_purchase_intents_exact_unique").on(table.id, table.accountId, table.family, table.environment),
  unique("recurring_purchase_intents_id_account_unique").on(table.id, table.accountId),
  unique("recurring_purchase_intents_id_account_environment_unique").on(table.id, table.accountId, table.environment),
  unique("recurring_purchase_intents_provider_owner_unique").on(table.id, table.accountId, table.environment, table.receiverStripeAccountId),
  unique("recurring_purchase_intents_reservation_command_unique").on(table.reservationCommandId),
  unique("recurring_purchase_intents_checkout_owner_unique").on(table.id, table.accountId, table.offerCode, table.environment, table.receiverStripeAccountId, table.catalogVersionId, table.priceBindingId),
  unique("recurring_purchase_intents_subscription_owner_unique").on(table.id, table.accountId, table.family, table.offerCode, table.environment, table.receiverStripeAccountId, table.catalogVersionId, table.priceBindingId),
  uniqueIndex("recurring_purchase_intents_one_nonterminal_family").on(table.accountId, table.family).where(sql`${table.state} in ('provider_call_pending','checkout_open','setup_succeeded','schedule_pending','subscription_pending','active','grace','cancellation_pending')`),
  check("recurring_purchase_intents_family_check", sql`${table.family} in ('operator_club','business_os')`),
  check("recurring_purchase_intents_request_hash_check", sql`${table.reservationRequestHash}~'^[0-9a-f]{64}$'`),
  check("recurring_purchase_intents_offer_topology_check", sql`
    (${table.family}='operator_club' and ${table.offerCode} in ('operator_club_monthly','operator_club_annual') and ${table.academySourceRegistryId} is not null and ${table.setupEpochId} is null and ${table.setupPurchaseId} is null)
    or (${table.family}='business_os' and ${table.offerCode}='business_os' and ${table.academySourceRegistryId} is null and ${table.setupEpochId} is not null and ${table.setupPurchaseId} is not null)
  `),
  check("recurring_purchase_intents_state_check", sql`${table.state} in ('provider_call_pending','checkout_open','setup_succeeded','schedule_pending','subscription_pending','active','grace','cancellation_pending','terminal_cancelled','terminal_expired','terminal_refunded','terminal_revoked','abandoned')`),
]);

export const checkoutAuthorizations = pgTable("checkout_authorizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").references(() => accounts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  principalKind: text("principal_kind").notNull(),
  principalId: text("principal_id").notNull(),
  offerId: uuid("offer_id").notNull(),
  offerCode: text("offer_code").notNull(),
  catalogVersionId: uuid("catalog_version_id").notNull(),
  priceBindingId: uuid("price_binding_id").notNull(),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  publicIntentId: uuid("public_intent_id"),
  setupEpochId: uuid("setup_epoch_id"),
  recurringIntentId: uuid("recurring_intent_id"),
  contactEmailFingerprint: bytea("contact_email_fingerprint"),
  contactCiphertext: bytea("contact_ciphertext"),
  contactNonce: bytea("contact_nonce"),
  contactTag: bytea("contact_tag"),
  contactKeyId: text("contact_key_id"),
  businessNameCiphertext: bytea("business_name_ciphertext"),
  businessNameNonce: bytea("business_name_nonce"),
  businessNameTag: bytea("business_name_tag"),
  businessNameKeyId: text("business_name_key_id"),
  businessNameContentHash: text("business_name_content_hash"),
  accountNameSchemaVersion: text("account_name_schema_version"),
  sourceCommandReceiptId: uuid("source_command_receipt_id").notNull().references(() => apiCommandReceipts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  requestHash: text("request_hash").notNull(),
  integrationIdentifier: text("integration_identifier").notNull(),
  policyVersions: jsonb("policy_versions").$type<Record<string, string>>().notNull(),
  status: text("status").notNull().default("provider_call_pending"),
  expiresAt: instant("expires_at").notNull(),
  createdAt: now("created_at"),
  updatedAt: now("updated_at"),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({ columns: [table.offerId, table.offerCode], foreignColumns: [offers.id, offers.code], name: "checkout_authorizations_offer_exact_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.priceBindingId, table.offerId, table.catalogVersionId, table.environment], foreignColumns: [offerPriceBindings.id, offerPriceBindings.offerId, offerPriceBindings.catalogVersionId, offerPriceBindings.environment], name: "checkout_authorizations_price_exact_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.priceBindingId, table.offerId, table.catalogVersionId, table.environment, table.receiverStripeAccountId], foreignColumns: [offerPriceBindings.id, offerPriceBindings.offerId, offerPriceBindings.catalogVersionId, offerPriceBindings.environment, offerPriceBindings.stripeAccountId], name: "checkout_authorizations_price_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.publicIntentId, table.environment, table.receiverStripeAccountId], foreignColumns: [publicBusinessOsSetupIntents.id, publicBusinessOsSetupIntents.environment, publicBusinessOsSetupIntents.receiverStripeAccountId], name: "checkout_authorizations_public_intent_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.setupEpochId, table.accountId, table.environment, table.receiverStripeAccountId], foreignColumns: [businessOsSetupEpochs.id, businessOsSetupEpochs.accountId, businessOsSetupEpochs.environment, businessOsSetupEpochs.receiverStripeAccountId], name: "checkout_authorizations_setup_epoch_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.recurringIntentId, table.accountId, table.offerCode, table.environment, table.receiverStripeAccountId, table.catalogVersionId, table.priceBindingId], foreignColumns: [recurringPurchaseIntents.id, recurringPurchaseIntents.accountId, recurringPurchaseIntents.offerCode, recurringPurchaseIntents.environment, recurringPurchaseIntents.receiverStripeAccountId, recurringPurchaseIntents.catalogVersionId, recurringPurchaseIntents.priceBindingId] as [AnyPgColumn, AnyPgColumn, AnyPgColumn, AnyPgColumn, AnyPgColumn, AnyPgColumn, AnyPgColumn], name: "checkout_authorizations_recurring_intent_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("checkout_authorizations_source_receipt_unique").on(table.sourceCommandReceiptId),
  unique("checkout_authorizations_public_intent_unique").on(table.publicIntentId),
  unique("checkout_authorizations_id_account_unique").on(table.id, table.accountId),
  unique("checkout_authorizations_provider_owner_unique").on(table.id, table.environment, table.receiverStripeAccountId),
  unique("checkout_authorizations_purchase_owner_unique").on(table.id, table.offerCode, table.environment, table.receiverStripeAccountId),
  unique("checkout_authorizations_exact_unique").on(table.id, table.accountId, table.offerCode),
  check("checkout_authorizations_principal_check", sql`${table.principalKind} in ('anonymous','member','staff') and ${boundedText(table.principalId)}`),
  check("checkout_authorizations_environment_check", sql`${table.environment} in ('test','staging','production')`),
  check("checkout_authorizations_hash_check", sql`${table.requestHash}~'^[0-9a-f]{64}$'`),
  check("checkout_authorizations_business_name_hash_check", sql`${table.businessNameContentHash} is null or ${table.businessNameContentHash}~'^[0-9a-f]{64}$'`),
  check("checkout_authorizations_state_check", sql`${table.status} in ('provider_call_pending','checkout_open','async_payment_pending','paid','claim_sent','failed','expired','consumed')`),
  check("checkout_authorizations_source_topology_check", sql`num_nonnulls(${table.publicIntentId},${table.setupEpochId},${table.recurringIntentId})<=1 and (${table.publicIntentId} is null or (${table.offerCode}='business_os' and ${table.accountId} is null)) and (${table.setupEpochId} is null or (${table.offerCode}='business_os' and ${table.accountId} is not null)) and (${table.recurringIntentId} is null or ${table.accountId} is not null)`),
  check("checkout_authorizations_contact_check", sql`
    (${table.contactEmailFingerprint} is null and ${table.contactCiphertext} is null and ${table.contactNonce} is null and ${table.contactTag} is null and ${table.contactKeyId} is null and ${table.businessNameCiphertext} is null and ${table.businessNameNonce} is null and ${table.businessNameTag} is null and ${table.businessNameKeyId} is null and ${table.businessNameContentHash} is null and ${table.accountNameSchemaVersion} is null)
    or ((${table.contactEmailFingerprint} is null or octet_length(${table.contactEmailFingerprint})=32) and octet_length(${table.contactCiphertext}) between 1 and 4096 and octet_length(${table.contactNonce})=12 and octet_length(${table.contactTag})=16 and ${boundedText(table.contactKeyId, 128)} and octet_length(${table.businessNameCiphertext}) between 1 and 4096 and octet_length(${table.businessNameNonce})=12 and octet_length(${table.businessNameTag})=16 and ${boundedText(table.businessNameKeyId, 128)} and ${table.businessNameContentHash}~'^[0-9a-f]{64}$' and ${boundedText(table.accountNameSchemaVersion, 64)})
  `),
  check("checkout_authorizations_identity_boundary_check", sql`
    (${table.accountId} is not null and ${table.publicIntentId} is null and ${table.contactEmailFingerprint} is null)
    or (${table.accountId} is null and ${table.publicIntentId} is not null and ${table.contactEmailFingerprint} is null)
    or (${table.accountId} is null and ${table.publicIntentId} is null and ${table.contactEmailFingerprint} is not null)
    or (${table.accountId} is null and ${table.publicIntentId} is null and ${table.offerCode}='self_paced' and ${table.status}='consumed' and ${table.contactEmailFingerprint} is null)
  `),
]);

export const checkoutSessions = pgTable("checkout_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  authorizationId: uuid("authorization_id").notNull(),
  accountId: uuid("account_id"),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  providerSessionId: text("provider_session_id").notNull(),
  providerCustomerId: text("provider_customer_id"),
  providerPaymentIntentId: text("provider_payment_intent_id"),
  providerSubscriptionId: text("provider_subscription_id"),
  providerSetupIntentId: text("provider_setup_intent_id"),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  paymentStatus: text("payment_status").notNull(),
  checkoutUrlCiphertext: bytea("checkout_url_ciphertext"),
  checkoutUrlNonce: bytea("checkout_url_nonce"),
  checkoutUrlTag: bytea("checkout_url_tag"),
  checkoutUrlKeyId: text("checkout_url_key_id"),
  expiresAt: instant("expires_at").notNull(),
  createdAt: now("created_at"),
  updatedAt: now("updated_at"),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({ columns: [table.authorizationId], foreignColumns: [checkoutAuthorizations.id], name: "checkout_sessions_authorization_id_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.authorizationId, table.accountId], foreignColumns: [checkoutAuthorizations.id, checkoutAuthorizations.accountId], name: "checkout_sessions_authorization_account_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.authorizationId, table.environment, table.receiverStripeAccountId], foreignColumns: [checkoutAuthorizations.id, checkoutAuthorizations.environment, checkoutAuthorizations.receiverStripeAccountId], name: "checkout_sessions_authorization_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("checkout_sessions_authorization_unique").on(table.authorizationId),
  unique("checkout_sessions_provider_unique").on(table.environment, table.receiverStripeAccountId, table.providerSessionId),
  unique("checkout_sessions_action_result_unique").on(table.authorizationId, table.environment, table.receiverStripeAccountId, table.providerSessionId),
  unique("checkout_sessions_customer_result_unique").on(table.id, table.authorizationId, table.environment, table.receiverStripeAccountId, table.providerCustomerId),
  unique("checkout_sessions_payment_intent_unique").on(table.environment, table.receiverStripeAccountId, table.providerPaymentIntentId),
  unique("checkout_sessions_subscription_unique").on(table.environment, table.receiverStripeAccountId, table.providerSubscriptionId),
  unique("checkout_sessions_setup_intent_unique").on(table.environment, table.receiverStripeAccountId, table.providerSetupIntentId),
  unique("checkout_sessions_exact_unique").on(table.id, table.authorizationId, table.accountId),
  check("checkout_sessions_mode_check", sql`${table.mode} in ('payment','setup','subscription')`),
  check("checkout_sessions_status_check", sql`${table.status} in ('open','complete','expired')`),
  check("checkout_sessions_payment_check", sql`${table.paymentStatus} in ('paid','unpaid','no_payment_required')`),
  check("checkout_sessions_url_ciphertext_check", sql`
    (${table.checkoutUrlCiphertext} is null and ${table.checkoutUrlNonce} is null and ${table.checkoutUrlTag} is null and ${table.checkoutUrlKeyId} is null)
    or (octet_length(${table.checkoutUrlCiphertext}) between 1 and 4096 and octet_length(${table.checkoutUrlNonce})=12 and octet_length(${table.checkoutUrlTag})=16 and ${boundedText(table.checkoutUrlKeyId, 128)})
  `),
  check("checkout_sessions_provider_identity_check", sql`
    ${table.environment} in ('test','staging','production')
    and ${boundedText(table.receiverStripeAccountId)}
    and ${boundedText(table.providerSessionId)}
    and ${table.providerSessionId}~'^cs_[A-Za-z0-9._:-]+$'
    and (${table.providerCustomerId} is null
      or (${boundedText(table.providerCustomerId)} and ${table.providerCustomerId}~'^cus_[A-Za-z0-9._:-]+$'))
    and (${table.providerPaymentIntentId} is null
      or (${boundedText(table.providerPaymentIntentId)} and ${table.providerPaymentIntentId}~'^pi_[A-Za-z0-9._:-]+$'))
    and (${table.providerSubscriptionId} is null
      or (${boundedText(table.providerSubscriptionId)} and ${table.providerSubscriptionId}~'^sub_[A-Za-z0-9._:-]+$'))
    and (${table.providerSetupIntentId} is null
      or (${boundedText(table.providerSetupIntentId)} and ${table.providerSetupIntentId}~'^seti_[A-Za-z0-9._:-]+$'))
  `),
  check("checkout_sessions_time_check", sql`
    ${table.expiresAt}=date_trunc('milliseconds',${table.expiresAt})
    and ${table.createdAt}=date_trunc('milliseconds',${table.createdAt})
    and ${table.updatedAt}=date_trunc('milliseconds',${table.updatedAt})
    and ${table.expiresAt}>${table.createdAt}
    and ${table.updatedAt}>=${table.createdAt}
  `),
]);

export const checkoutProviderActions = pgTable("checkout_provider_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  authorizationId: uuid("authorization_id").notNull(),
  accountId: uuid("account_id"),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  actionKind: text("action_kind").notNull(),
  providerIdempotencyKey: text("provider_idempotency_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  status: text("status").notNull().default("pending"),
  providerSessionId: text("provider_session_id"),
  attempts: integer("attempts").notNull().default(0),
  lastErrorCode: text("last_error_code"),
  createdAt: now("created_at"),
  updatedAt: now("updated_at"),
}, (table) => [
  foreignKey({ columns: [table.authorizationId], foreignColumns: [checkoutAuthorizations.id], name: "checkout_provider_actions_authorization_id_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.authorizationId, table.accountId], foreignColumns: [checkoutAuthorizations.id, checkoutAuthorizations.accountId], name: "checkout_provider_actions_authorization_account_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.authorizationId, table.environment, table.receiverStripeAccountId], foreignColumns: [checkoutAuthorizations.id, checkoutAuthorizations.environment, checkoutAuthorizations.receiverStripeAccountId], name: "checkout_provider_actions_authorization_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.authorizationId, table.environment, table.receiverStripeAccountId, table.providerSessionId], foreignColumns: [checkoutSessions.authorizationId, checkoutSessions.environment, checkoutSessions.receiverStripeAccountId, checkoutSessions.providerSessionId], name: "checkout_provider_actions_session_result_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("checkout_provider_actions_authorization_kind_unique").on(table.authorizationId, table.actionKind),
  unique("checkout_provider_actions_provider_key_unique").on(table.providerIdempotencyKey),
  unique("checkout_provider_actions_exact_unique").on(table.id, table.authorizationId, table.accountId, table.environment, table.receiverStripeAccountId),
  check("checkout_provider_actions_state_check", sql`${table.status} in ('pending','in_flight','succeeded','failed_retryable','failed_terminal','ambiguous')`),
  check("checkout_provider_actions_hash_check", sql`${table.requestFingerprint}~'^[0-9a-f]{64}$'`),
  check("checkout_provider_actions_identity_check", sql`
    ${table.environment} in ('test','staging','production')
    and ${boundedText(table.receiverStripeAccountId)}
    and ${table.actionKind} in ('create_checkout_session','create_business_os_setup_checkout')
    and (
      (${table.actionKind}='create_checkout_session'
        and ${table.providerIdempotencyKey}='checkout:'||${table.authorizationId}::text)
      or (${table.actionKind}='create_business_os_setup_checkout'
        and ${table.providerIdempotencyKey}='business_os_setup_checkout:'||${table.id}::text)
    )
    and (${table.providerSessionId} is null
      or (${boundedText(table.providerSessionId)} and ${table.providerSessionId}~'^cs_[A-Za-z0-9._:-]+$'))
    and (${table.lastErrorCode} is null
      or (${boundedText(table.lastErrorCode, 128)} and ${table.lastErrorCode}~'^[A-Z][A-Z0-9_]*$'))
    and ${table.createdAt}=date_trunc('milliseconds',${table.createdAt})
    and ${table.updatedAt}=date_trunc('milliseconds',${table.updatedAt})
    and ${table.updatedAt}>=${table.createdAt}
  `),
  check("checkout_provider_actions_lifecycle_check", sql`
    (${table.status}='pending' and ${table.attempts}=0
      and ${table.providerSessionId} is null and ${table.lastErrorCode} is null)
    or (${table.status}='in_flight' and ${table.attempts}>0
      and ${table.providerSessionId} is null and ${table.lastErrorCode} is null)
    or (${table.status}='succeeded' and ${table.attempts}>0
      and ${table.providerSessionId} is not null and ${table.lastErrorCode} is null)
    or (${table.status} in ('failed_retryable','failed_terminal','ambiguous')
      and ${table.attempts}>0 and ${table.providerSessionId} is null
      and ${table.lastErrorCode} is not null)
  `),
]);

export const stripeCustomerCreationActions = pgTable("stripe_customer_creation_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: accountId(),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  providerIdempotencyKey: text("provider_idempotency_key").notNull(),
  status: text("status").notNull().default("pending"),
  providerCustomerId: text("provider_customer_id"),
  createdAt: now("created_at"),
  updatedAt: now("updated_at"),
}, (table) => [
  unique("stripe_customer_creation_actions_scope_unique").on(table.accountId, table.environment),
  unique("stripe_customer_creation_actions_provider_key_unique").on(table.providerIdempotencyKey),
  unique("stripe_customer_creation_actions_exact_unique").on(table.id, table.accountId, table.environment),
  unique("stripe_customer_creation_actions_provider_owner_unique").on(table.id, table.accountId, table.environment, table.receiverStripeAccountId),
  unique("stripe_customer_creation_actions_result_owner_unique").on(table.id, table.accountId, table.environment, table.receiverStripeAccountId, table.providerCustomerId),
  check("stripe_customer_creation_actions_state_check", sql`${table.status} in ('pending','in_flight','succeeded','failed_retryable','failed_terminal','ambiguous')`),
]);

export const stripeCustomers = pgTable("stripe_customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: accountId(),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  providerCustomerId: text("provider_customer_id").notNull(),
  creationActionId: uuid("creation_action_id"),
  checkoutSessionId: uuid("checkout_session_id"),
  checkoutAuthorizationId: uuid("checkout_authorization_id"),
  publicIntentId: uuid("public_intent_id"),
  createdAt: now("created_at"),
}, (table) => [
  foreignKey({ columns: [table.creationActionId, table.accountId, table.environment, table.receiverStripeAccountId, table.providerCustomerId], foreignColumns: [stripeCustomerCreationActions.id, stripeCustomerCreationActions.accountId, stripeCustomerCreationActions.environment, stripeCustomerCreationActions.receiverStripeAccountId, stripeCustomerCreationActions.providerCustomerId], name: "stripe_customers_creation_action_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.checkoutSessionId, table.checkoutAuthorizationId, table.environment, table.receiverStripeAccountId, table.providerCustomerId], foreignColumns: [checkoutSessions.id, checkoutSessions.authorizationId, checkoutSessions.environment, checkoutSessions.receiverStripeAccountId, checkoutSessions.providerCustomerId], name: "stripe_customers_checkout_result_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.publicIntentId, table.environment, table.receiverStripeAccountId], foreignColumns: [publicBusinessOsSetupIntents.id, publicBusinessOsSetupIntents.environment, publicBusinessOsSetupIntents.receiverStripeAccountId], name: "stripe_customers_public_intent_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("stripe_customers_account_environment_unique").on(table.accountId, table.environment),
  unique("stripe_customers_provider_unique").on(table.environment, table.receiverStripeAccountId, table.providerCustomerId),
  unique("stripe_customers_creation_action_unique").on(table.creationActionId),
  unique("stripe_customers_public_intent_unique").on(table.publicIntentId),
  unique("stripe_customers_exact_unique").on(table.id, table.accountId, table.environment),
  unique("stripe_customers_provider_owner_unique").on(table.id, table.accountId, table.environment, table.receiverStripeAccountId),
  check("stripe_customers_source_check", sql`num_nonnulls(${table.creationActionId},${table.checkoutSessionId})=1 and ((${table.checkoutSessionId} is null and ${table.checkoutAuthorizationId} is null and ${table.publicIntentId} is null) or (${table.checkoutSessionId} is not null and ${table.checkoutAuthorizationId} is not null))`),
]);

export const purchases = pgTable("purchases", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: accountId(),
  authorizationId: uuid("authorization_id").notNull(),
  offerCode: text("offer_code").notNull(),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  providerPaymentIntentId: text("provider_payment_intent_id").notNull(),
  providerChargeId: text("provider_charge_id"),
  currency: text("currency").notNull(),
  grossAmount: integer("gross_amount").notNull(),
  taxAmount: integer("tax_amount").notNull(),
  status: text("status").notNull(),
  sourceRegistryId: uuid("source_registry_id"),
  purchasedAt: instant("purchased_at").notNull(),
  createdAt: now("created_at"),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({ columns: [table.authorizationId], foreignColumns: [checkoutAuthorizations.id] as [AnyPgColumn], name: "purchases_authorization_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.authorizationId, table.offerCode, table.environment, table.receiverStripeAccountId], foreignColumns: [checkoutAuthorizations.id, checkoutAuthorizations.offerCode, checkoutAuthorizations.environment, checkoutAuthorizations.receiverStripeAccountId] as [AnyPgColumn, AnyPgColumn, AnyPgColumn, AnyPgColumn], name: "purchases_authorization_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.sourceRegistryId, table.accountId], foreignColumns: [entitlementSources.id, entitlementSources.accountId], name: "purchases_source_account_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("purchases_provider_payment_unique").on(table.environment, table.receiverStripeAccountId, table.providerPaymentIntentId),
  unique("purchases_provider_charge_unique").on(table.environment, table.receiverStripeAccountId, table.providerChargeId),
  unique("purchases_authorization_unique").on(table.authorizationId),
  unique("purchases_id_account_unique").on(table.id, table.accountId),
  unique("purchases_provider_owner_unique").on(table.id, table.accountId, table.environment, table.receiverStripeAccountId),
  unique("purchases_exact_unique").on(table.id, table.accountId, table.offerCode),
  check("purchases_money_check", sql`${table.currency}='usd' and ${table.grossAmount}>0 and ${table.taxAmount} between 0 and ${table.grossAmount}`),
  check("purchases_state_check", sql`${table.status} in ('paid','paid_reconciliation','refunded','dispute_open','dispute_lost')`),
]);

export const publicBusinessOsSetupFulfillments = pgTable("public_business_os_setup_fulfillments", {
  publicIntentId: uuid("public_intent_id").primaryKey(),
  accountId: accountId(),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  setupEpochId: uuid("setup_epoch_id").notNull(),
  purchaseId: uuid("purchase_id").notNull(),
  sourceRegistryId: uuid("source_registry_id"),
  providerReceiptId: uuid("provider_receipt_id").notNull(),
  provider: text("provider").notNull().default("stripe"),
  fulfilledAt: instant("fulfilled_at").notNull(),
}, (table) => [
  foreignKey({
    columns: [table.publicIntentId, table.environment, table.receiverStripeAccountId],
    foreignColumns: [
      publicBusinessOsSetupIntents.id,
      publicBusinessOsSetupIntents.environment,
      publicBusinessOsSetupIntents.receiverStripeAccountId,
    ],
    name: "public_bos_setup_fulfillments_intent_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({
    columns: [table.setupEpochId, table.accountId, table.environment, table.receiverStripeAccountId],
    foreignColumns: [businessOsSetupEpochs.id, businessOsSetupEpochs.accountId, businessOsSetupEpochs.environment, businessOsSetupEpochs.receiverStripeAccountId],
    name: "public_bos_setup_fulfillments_epoch_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({
    columns: [table.purchaseId, table.accountId, table.environment, table.receiverStripeAccountId],
    foreignColumns: [purchases.id, purchases.accountId, purchases.environment, purchases.receiverStripeAccountId],
    name: "public_bos_setup_fulfillments_purchase_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({
    columns: [table.sourceRegistryId, table.accountId],
    foreignColumns: [entitlementSources.id, entitlementSources.accountId],
    name: "public_bos_setup_fulfillments_source_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({
    columns: [table.providerReceiptId, table.provider, table.receiverStripeAccountId],
    foreignColumns: [
      providerEventReceipts.id,
      providerEventReceipts.provider,
      providerEventReceipts.receiverStripeAccountId,
    ],
    name: "public_bos_setup_fulfillments_receipt_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  unique("public_bos_setup_fulfillments_epoch_unique").on(table.setupEpochId),
  unique("public_bos_setup_fulfillments_purchase_unique").on(table.purchaseId),
  unique("public_bos_setup_fulfillments_source_unique").on(table.sourceRegistryId),
  unique("public_bos_setup_fulfillments_receipt_unique").on(table.providerReceiptId),
  unique("public_bos_setup_fulfillments_exact_unique").on(
    table.publicIntentId,
    table.accountId,
    table.setupEpochId,
    table.purchaseId,
  ),
  check("public_bos_setup_fulfillments_environment_check", sql`${table.environment} in ('test','staging','production')`),
  check("public_bos_setup_fulfillments_provider_check", sql`${table.provider}='stripe'`),
  check("public_bos_setup_fulfillments_time_check", sql`${table.fulfilledAt}=date_trunc('milliseconds',${table.fulfilledAt})`),
]);

export const purchasePaymentAllocations = pgTable("purchase_payment_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  purchaseId: uuid("purchase_id").notNull(),
  accountId: accountId(),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  providerPaymentObjectType: text("provider_payment_object_type").notNull(),
  providerPaymentObjectId: text("provider_payment_object_id").notNull(),
  grossAmount: integer("gross_amount").notNull(),
  taxAmount: integer("tax_amount").notNull(),
  createdAt: now("created_at"),
}, (table) => [
  foreignKey({ columns: [table.purchaseId, table.accountId, table.environment, table.receiverStripeAccountId], foreignColumns: [purchases.id, purchases.accountId, purchases.environment, purchases.receiverStripeAccountId], name: "purchase_payment_allocations_purchase_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("purchase_payment_allocations_provider_unique").on(table.environment, table.receiverStripeAccountId, table.providerPaymentObjectType, table.providerPaymentObjectId),
  unique("purchase_payment_allocations_purchase_type_unique").on(table.purchaseId, table.providerPaymentObjectType),
  check("purchase_payment_allocations_type_check", sql`${table.providerPaymentObjectType} in ('payment_intent','charge')`),
  check("purchase_payment_allocations_money_check", sql`${table.grossAmount}>0 and ${table.taxAmount} between 0 and ${table.grossAmount}`),
]);

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: accountId(),
  recurringIntentId: uuid("recurring_intent_id").notNull(),
  recurringFamily: text("recurring_family").notNull(),
  stripeCustomerId: uuid("stripe_customer_id").notNull(),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  providerSubscriptionId: text("provider_subscription_id").notNull(),
  offerCode: text("offer_code").notNull(),
  catalogVersionId: uuid("catalog_version_id").notNull(),
  priceBindingId: uuid("price_binding_id").notNull(),
  status: text("status").notNull(),
  currentPeriodStart: instant("current_period_start"),
  currentPeriodEnd: instant("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  sourceRegistryId: uuid("source_registry_id"),
  createdAt: now("created_at"),
  updatedAt: now("updated_at"),
}, (table) => [
  foreignKey({ columns: [table.recurringIntentId, table.accountId, table.recurringFamily, table.offerCode, table.environment, table.receiverStripeAccountId, table.catalogVersionId, table.priceBindingId], foreignColumns: [recurringPurchaseIntents.id, recurringPurchaseIntents.accountId, recurringPurchaseIntents.family, recurringPurchaseIntents.offerCode, recurringPurchaseIntents.environment, recurringPurchaseIntents.receiverStripeAccountId, recurringPurchaseIntents.catalogVersionId, recurringPurchaseIntents.priceBindingId], name: "subscriptions_recurring_intent_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.stripeCustomerId, table.accountId, table.environment, table.receiverStripeAccountId], foreignColumns: [stripeCustomers.id, stripeCustomers.accountId, stripeCustomers.environment, stripeCustomers.receiverStripeAccountId], name: "subscriptions_customer_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.priceBindingId, table.catalogVersionId, table.environment, table.receiverStripeAccountId], foreignColumns: [offerPriceBindings.id, offerPriceBindings.catalogVersionId, offerPriceBindings.environment, offerPriceBindings.stripeAccountId], name: "subscriptions_price_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.sourceRegistryId, table.accountId], foreignColumns: [entitlementSources.id, entitlementSources.accountId], name: "subscriptions_source_account_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("subscriptions_provider_unique").on(table.environment, table.receiverStripeAccountId, table.providerSubscriptionId),
  unique("subscriptions_intent_unique").on(table.recurringIntentId),
  unique("subscriptions_id_account_unique").on(table.id, table.accountId),
  unique("subscriptions_provider_owner_unique").on(table.id, table.accountId, table.environment, table.receiverStripeAccountId),
  unique("subscriptions_intent_provider_owner_unique").on(table.id, table.recurringIntentId, table.accountId, table.recurringFamily, table.offerCode, table.environment, table.receiverStripeAccountId, table.catalogVersionId, table.priceBindingId),
  unique("subscriptions_exact_unique").on(table.id, table.accountId, table.offerCode),
  check("subscriptions_state_check", sql`${table.status} in ('incomplete','trialing','active','past_due','unpaid','paused','canceled')`),
]);

export const subscriptionSchedules = pgTable("subscription_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: accountId(),
  recurringIntentId: uuid("recurring_intent_id").notNull(),
  recurringFamily: text("recurring_family").notNull(),
  subscriptionId: uuid("subscription_id"),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  offerCode: text("offer_code").notNull(),
  catalogVersionId: uuid("catalog_version_id").notNull(),
  priceBindingId: uuid("price_binding_id").notNull(),
  providerScheduleId: text("provider_schedule_id").notNull(),
  status: text("status").notNull(),
  phaseStartsAt: instant("phase_starts_at").notNull(),
  createdAt: now("created_at"),
  updatedAt: now("updated_at"),
}, (table) => [
  foreignKey({ columns: [table.recurringIntentId, table.accountId, table.recurringFamily, table.offerCode, table.environment, table.receiverStripeAccountId, table.catalogVersionId, table.priceBindingId], foreignColumns: [recurringPurchaseIntents.id, recurringPurchaseIntents.accountId, recurringPurchaseIntents.family, recurringPurchaseIntents.offerCode, recurringPurchaseIntents.environment, recurringPurchaseIntents.receiverStripeAccountId, recurringPurchaseIntents.catalogVersionId, recurringPurchaseIntents.priceBindingId], name: "subscription_schedules_intent_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.subscriptionId, table.recurringIntentId, table.accountId, table.recurringFamily, table.offerCode, table.environment, table.receiverStripeAccountId, table.catalogVersionId, table.priceBindingId], foreignColumns: [subscriptions.id, subscriptions.recurringIntentId, subscriptions.accountId, subscriptions.recurringFamily, subscriptions.offerCode, subscriptions.environment, subscriptions.receiverStripeAccountId, subscriptions.catalogVersionId, subscriptions.priceBindingId], name: "subscription_schedules_subscription_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("subscription_schedules_provider_unique").on(table.environment, table.receiverStripeAccountId, table.providerScheduleId),
  unique("subscription_schedules_intent_unique").on(table.recurringIntentId),
  check("subscription_schedules_state_check", sql`${table.status} in ('not_started','active','released','completed','canceled','aborted')`),
]);

export const invoices = pgTable("invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: accountId(),
  subscriptionId: uuid("subscription_id").notNull(),
  recurringIntentId: uuid("recurring_intent_id").notNull(),
  recurringFamily: text("recurring_family").notNull(),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  offerCode: text("offer_code").notNull(),
  catalogVersionId: uuid("catalog_version_id").notNull(),
  priceBindingId: uuid("price_binding_id").notNull(),
  providerInvoiceId: text("provider_invoice_id").notNull(),
  status: text("status").notNull(),
  collectionMethod: text("collection_method").notNull(),
  currency: text("currency").notNull(),
  amountDue: integer("amount_due").notNull(),
  amountPaid: integer("amount_paid").notNull(),
  amountRemaining: integer("amount_remaining").notNull(),
  totalTaxAmount: integer("total_tax_amount").notNull(),
  periodStart: instant("period_start").notNull(),
  periodEnd: instant("period_end").notNull(),
  paidAt: instant("paid_at"),
  createdAt: now("created_at"),
}, (table) => [
  foreignKey({ columns: [table.subscriptionId, table.recurringIntentId, table.accountId, table.recurringFamily, table.offerCode, table.environment, table.receiverStripeAccountId, table.catalogVersionId, table.priceBindingId], foreignColumns: [subscriptions.id, subscriptions.recurringIntentId, subscriptions.accountId, subscriptions.recurringFamily, subscriptions.offerCode, subscriptions.environment, subscriptions.receiverStripeAccountId, subscriptions.catalogVersionId, subscriptions.priceBindingId], name: "invoices_subscription_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("invoices_provider_unique").on(table.environment, table.receiverStripeAccountId, table.providerInvoiceId),
  unique("invoices_exact_unique").on(table.id, table.accountId, table.subscriptionId),
  unique("invoices_provider_owner_unique").on(table.id, table.accountId, table.subscriptionId, table.recurringIntentId, table.recurringFamily, table.offerCode, table.environment, table.receiverStripeAccountId, table.catalogVersionId, table.priceBindingId),
  check("invoices_state_check", sql`${table.status} in ('draft','open','paid','uncollectible','void')`),
  check("invoices_collection_check", sql`${table.collectionMethod}='charge_automatically'`),
  check("invoices_money_check", sql`${table.currency}='usd' and ${table.amountDue}>=0 and ${table.amountPaid}>=0 and ${table.amountRemaining}>=0 and ${table.totalTaxAmount}>=0`),
]);

export const invoiceLineAllocations = pgTable("invoice_line_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id").notNull(),
  accountId: accountId(),
  subscriptionId: uuid("subscription_id").notNull(),
  recurringIntentId: uuid("recurring_intent_id").notNull(),
  recurringFamily: text("recurring_family").notNull(),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  offerCode: text("offer_code").notNull(),
  catalogVersionId: uuid("catalog_version_id").notNull(),
  providerInvoiceLineId: text("provider_invoice_line_id").notNull(),
  priceBindingId: uuid("price_binding_id").notNull(),
  amount: integer("amount").notNull(),
  taxAmount: integer("tax_amount").notNull(),
  createdAt: now("created_at"),
}, (table) => [
  foreignKey({ columns: [table.invoiceId, table.accountId, table.subscriptionId, table.recurringIntentId, table.recurringFamily, table.offerCode, table.environment, table.receiverStripeAccountId, table.catalogVersionId, table.priceBindingId], foreignColumns: [invoices.id, invoices.accountId, invoices.subscriptionId, invoices.recurringIntentId, invoices.recurringFamily, invoices.offerCode, invoices.environment, invoices.receiverStripeAccountId, invoices.catalogVersionId, invoices.priceBindingId], name: "invoice_line_allocations_invoice_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.priceBindingId, table.catalogVersionId, table.environment, table.receiverStripeAccountId], foreignColumns: [offerPriceBindings.id, offerPriceBindings.catalogVersionId, offerPriceBindings.environment, offerPriceBindings.stripeAccountId], name: "invoice_line_allocations_price_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("invoice_line_allocations_provider_line_unique").on(table.invoiceId, table.providerInvoiceLineId),
  check("invoice_line_allocations_money_check", sql`${table.amount}>=0 and ${table.taxAmount}>=0`),
]);

export const controlledPaymentAuthorizations = pgTable("controlled_payment_authorizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  releaseSha: text("release_sha").notNull(),
  environment: text("environment").notNull(),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  catalogHash: text("catalog_hash").notNull(),
  policyHash: text("policy_hash").notNull(),
  contentHash: text("content_hash").notNull(),
  catalogVersionId: uuid("catalog_version_id").notNull(),
  priceBindingId: uuid("price_binding_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  creatorStaffId: uuid("creator_staff_id").notNull().references(() => staffIdentities.id, { onDelete: "restrict", onUpdate: "restrict" }),
  maximumGrossAmount: integer("maximum_gross_amount").notNull(),
  state: text("state").notNull().default("issued"),
  checkoutAuthorizationId: uuid("checkout_authorization_id"),
  providerPaymentIntentId: text("provider_payment_intent_id"),
  expiresAt: instant("expires_at").notNull(),
  createdAt: now("created_at"),
  consumedAt: instant("consumed_at"),
}, (table) => [
  foreignKey({ columns: [table.priceBindingId, table.catalogVersionId, table.environment, table.receiverStripeAccountId], foreignColumns: [offerPriceBindings.id, offerPriceBindings.catalogVersionId, offerPriceBindings.environment, offerPriceBindings.stripeAccountId], name: "controlled_payment_authorizations_price_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.checkoutAuthorizationId, table.environment, table.receiverStripeAccountId], foreignColumns: [checkoutAuthorizations.id, checkoutAuthorizations.environment, checkoutAuthorizations.receiverStripeAccountId], name: "controlled_payment_authorizations_checkout_provider_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("controlled_payment_authorizations_checkout_unique").on(table.checkoutAuthorizationId),
  unique("controlled_payment_authorizations_payment_unique").on(table.providerPaymentIntentId),
  unique("controlled_payment_authorizations_token_hash_unique").on(table.tokenHash),
  uniqueIndex("controlled_payment_authorizations_one_live_release").on(table.releaseSha).where(sql`${table.state} in ('issued','checkout_open','paid')`),
  check("controlled_payment_authorizations_environment_check", sql`${table.environment}='production'`),
  check("controlled_payment_authorizations_state_check", sql`${table.state} in ('issued','checkout_open','paid','expired','revoked')`),
  check("controlled_payment_authorizations_amount_check", sql`${table.maximumGrossAmount}>0`),
  check("controlled_payment_authorizations_token_hash_check", sql`${table.tokenHash}~'^[0-9a-f]{64}$'`),
  check("controlled_payment_authorizations_hashes_check", sql`${table.catalogHash}~'^[0-9a-f]{64}$' and ${table.policyHash}~'^[0-9a-f]{64}$' and ${table.contentHash}~'^[0-9a-f]{64}$'`),
  check("controlled_payment_authorizations_release_check", sql`${table.releaseSha}~'^[0-9a-f]{40}$'`),
  check("controlled_payment_authorizations_expiry_check", sql`${table.expiresAt}>${table.createdAt} and ${table.expiresAt}<=${table.createdAt}+interval '2 hours'`),
]);

export const claimTokens = pgTable("claim_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: accountId(),
  purchaseId: uuid("purchase_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  emailFingerprint: bytea("email_fingerprint").notNull(),
  emailCiphertext: bytea("email_ciphertext"),
  emailNonce: bytea("email_nonce"),
  emailTag: bytea("email_tag"),
  emailKeyId: text("email_key_id"),
  status: text("status").notNull().default("pending"),
  expiresAt: instant("expires_at").notNull(),
  consumedAt: instant("consumed_at"),
  createdAt: now("created_at"),
}, (table) => [
  foreignKey({ columns: [table.purchaseId, table.accountId], foreignColumns: [purchases.id, purchases.accountId], name: "claim_tokens_purchase_account_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("claim_tokens_hash_unique").on(table.tokenHash),
  unique("claim_tokens_purchase_unique").on(table.purchaseId),
  unique("claim_tokens_id_account_unique").on(table.id, table.accountId),
  unique("claim_tokens_exact_unique").on(table.id, table.accountId, table.purchaseId),
  check("claim_tokens_hash_check", sql`${table.tokenHash}~'^[0-9a-f]{64}$'`),
  check("claim_tokens_state_check", sql`${table.status} in ('pending','consumed','expired','revoked')`),
  check("claim_tokens_email_fingerprint_check", sql`octet_length(${table.emailFingerprint})=32`),
  check("claim_tokens_email_ciphertext_check", sql`
    (${table.emailCiphertext} is null and ${table.emailNonce} is null and ${table.emailTag} is null and ${table.emailKeyId} is null)
    or (octet_length(${table.emailCiphertext}) between 1 and 4096 and octet_length(${table.emailNonce})=12 and octet_length(${table.emailTag})=16 and ${boundedText(table.emailKeyId, 128)})
  `),
  check("claim_tokens_expiry_check", sql`${table.expiresAt}=${table.createdAt}+interval '168 hours'`),
  check("claim_tokens_consumed_check", sql`(${table.status}='consumed')=(${table.consumedAt} is not null)`),
]);

export const pendingClaimSessions = pgTable("pending_claim_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  claimTokenId: uuid("claim_token_id").notNull(),
  accountId: accountId(),
  sessionHandleHash: text("session_handle_hash").notNull(),
  status: text("status").notNull().default("pending"),
  candidatePrincipalId: text("candidate_principal_id"),
  expiresAt: instant("expires_at").notNull(),
  consumedAt: instant("consumed_at"),
  createdAt: now("created_at"),
}, (table) => [
  foreignKey({ columns: [table.claimTokenId, table.accountId], foreignColumns: [claimTokens.id, claimTokens.accountId], name: "pending_claim_sessions_claim_account_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("pending_claim_sessions_handle_unique").on(table.sessionHandleHash),
  unique("pending_claim_sessions_claim_unique").on(table.claimTokenId),
  check("pending_claim_sessions_hash_check", sql`${table.sessionHandleHash}~'^[0-9a-f]{64}$'`),
  check("pending_claim_sessions_state_check", sql`${table.status} in ('pending','consumed','expired')`),
  check("pending_claim_sessions_candidate_check", sql`${table.candidatePrincipalId} is null or ${boundedText(table.candidatePrincipalId)}`),
  check("pending_claim_sessions_expiry_check", sql`${table.expiresAt}>${table.createdAt} and ${table.expiresAt}<=${table.createdAt}+interval '168 hours'`),
  check("pending_claim_sessions_consumed_check", sql`(${table.status}='consumed')=(${table.consumedAt} is not null)`),
]);

export const secureLinkDeliveries = pgTable("secure_link_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").references(() => accounts.id, { onDelete: "restrict", onUpdate: "restrict" }),
  kind: text("kind").notNull(),
  claimTokenId: uuid("claim_token_id"),
  seatInvitationId: uuid("seat_invitation_id"),
  controlledPaymentAuthorizationId: uuid("controlled_payment_authorization_id"),
  tokenCiphertext: bytea("token_ciphertext"),
  tokenNonce: bytea("token_nonce"),
  tokenTag: bytea("token_tag"),
  tokenKeyId: text("token_key_id"),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  deliveredAt: instant("delivered_at"),
  erasedAt: instant("erased_at"),
  createdAt: now("created_at"),
}, (table) => [
  foreignKey({ columns: [table.claimTokenId, table.accountId], foreignColumns: [claimTokens.id, claimTokens.accountId], name: "secure_link_deliveries_claim_account_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.seatInvitationId, table.accountId], foreignColumns: [seatInvitations.id, seatInvitations.accountId], name: "secure_link_deliveries_invitation_account_fk" }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.controlledPaymentAuthorizationId], foreignColumns: [controlledPaymentAuthorizations.id], name: "secure_link_deliveries_controlled_payment_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("secure_link_deliveries_claim_unique").on(table.claimTokenId),
  unique("secure_link_deliveries_invitation_unique").on(table.seatInvitationId),
  unique("secure_link_deliveries_controlled_payment_unique").on(table.controlledPaymentAuthorizationId),
  check("secure_link_deliveries_kind_check", sql`${table.kind} in ('claim','seat_invitation','controlled_payment')`),
  check("secure_link_deliveries_target_check", sql`
    (${table.kind}='claim' and ${table.claimTokenId} is not null and ${table.accountId} is not null and ${table.seatInvitationId} is null and ${table.controlledPaymentAuthorizationId} is null)
    or (${table.kind}='seat_invitation' and ${table.seatInvitationId} is not null and ${table.accountId} is not null and ${table.claimTokenId} is null and ${table.controlledPaymentAuthorizationId} is null)
    or (${table.kind}='controlled_payment' and ${table.controlledPaymentAuthorizationId} is not null and ${table.accountId} is null and ${table.claimTokenId} is null and ${table.seatInvitationId} is null)
  `),
  check("secure_link_deliveries_state_check", sql`${table.status} in ('pending','processing','delivered','failed','erased')`),
  check("secure_link_deliveries_attempts_check", sql`${table.attempts}>=0`),
  check("secure_link_deliveries_ciphertext_check", sql`
    (${table.status}='erased' and ${table.tokenCiphertext} is null and ${table.tokenNonce} is null and ${table.tokenTag} is null and ${table.tokenKeyId} is null and ${table.erasedAt} is not null)
    or (${table.status}<>'erased' and octet_length(${table.tokenCiphertext}) between 1 and 4096 and octet_length(${table.tokenNonce})=12 and octet_length(${table.tokenTag})=16 and ${boundedText(table.tokenKeyId, 128)} and ${table.erasedAt} is null)
  `),
]);

export const accountOnboarding = pgTable("account_onboarding", {
  accountId: accountId().primaryKey(),
  productFamily: text("product_family").notNull(),
  version: integer("version").notNull().default(1),
  businessName: text("business_name").notNull(),
  website: text("website"),
  category: text("category"),
  country: text("country"),
  timezone: text("timezone"),
  teamSizeBand: text("team_size_band"),
  ownerRole: text("owner_role"),
  primaryGoal: text("primary_goal"),
  tools: jsonb("tools").$type<Record<string, readonly string[]>>().notNull().default(sql`'{}'::jsonb`),
  scorecardAttachmentId: uuid("scorecard_attachment_id"),
  invitationStepCompleted: boolean("invitation_step_completed").notNull().default(false),
  deliveryScheduleConfirmed: boolean("delivery_schedule_confirmed").notNull().default(false),
  currentStep: text("current_step").notNull().default("business"),
  completedAt: instant("completed_at"),
  createdAt: now("created_at"),
  updatedAt: now("updated_at"),
}, (table) => [
  unique("account_onboarding_exact_unique").on(table.accountId, table.version),
  check("account_onboarding_family_check", sql`${table.productFamily} in ('academy','business_os')`),
  check("account_onboarding_version_check", sql`${table.version}>=1`),
  check("account_onboarding_step_check", sql`${table.currentStep} in ('business','tools','priorities','team','delivery','complete')`),
  check("account_onboarding_tools_check", sql`jsonb_typeof(${table.tools})='object'`),
]);

export const accountOnboardingPriorities = pgTable("account_onboarding_priorities", {
  accountId: uuid("account_id").notNull(),
  onboardingVersion: integer("onboarding_version").notNull(),
  ordinal: integer("ordinal").notNull(),
  priority: text("priority").notNull(),
  createdAt: now("created_at"),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.onboardingVersion, table.ordinal] }),
  foreignKey({ columns: [table.accountId, table.onboardingVersion], foreignColumns: [accountOnboarding.accountId, accountOnboarding.version], name: "account_onboarding_priorities_onboarding_account_fk" }).onDelete("restrict").onUpdate("restrict"),
  check("account_onboarding_priorities_ordinal_check", sql`${table.ordinal} between 1 and 3`),
  check("account_onboarding_priorities_text_check", boundedText(table.priority, 1000)),
]);

export const providerEventProcessing = pgTable("provider_event_processing", {
  receiptId: uuid("receipt_id").primaryKey(),
  provider: text("provider").notNull().default("stripe"),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  status: text("status").notNull().default("received"),
  workerId: text("worker_id"),
  leaseToken: uuid("lease_token"),
  leaseGeneration: integer("lease_generation").notNull().default(0),
  leaseExpiresAt: instant("lease_expires_at"),
  outcomeCode: text("outcome_code"),
  completedAt: instant("completed_at"),
  updatedAt: now("updated_at"),
}, (table) => [
  foreignKey({ columns: [table.receiptId, table.provider, table.receiverStripeAccountId], foreignColumns: [providerEventReceipts.id, providerEventReceipts.provider, providerEventReceipts.receiverStripeAccountId], name: "provider_event_processing_receipt_owner_fk" }).onDelete("restrict").onUpdate("restrict"),
  unique("provider_event_processing_fence_owner_unique").on(table.receiptId, table.provider, table.receiverStripeAccountId),
  check("provider_event_processing_provider_check", sql`${table.provider}='stripe'`),
  check("provider_event_processing_state_check", sql`${table.status} in ('received','processing','processed','failed_retryable','failed_terminal')`),
  check("provider_event_processing_generation_check", sql`${table.leaseGeneration}>=0`),
  check("provider_event_processing_fence_check", sql`
    (${table.status}='received' and ${table.workerId} is null and ${table.leaseToken} is null and ${table.leaseGeneration}=0 and ${table.leaseExpiresAt} is null and ${table.outcomeCode} is null and ${table.completedAt} is null)
    or (${table.status}='processing' and ${table.workerId} is not null and ${table.leaseToken} is not null and ${table.leaseGeneration}>0 and ${table.leaseExpiresAt} is not null and ${table.outcomeCode} is null and ${table.completedAt} is null)
    or (${table.status} in ('processed','failed_retryable','failed_terminal') and ${table.workerId} is null and ${table.leaseToken} is null and ${table.leaseGeneration}>0 and ${table.leaseExpiresAt} is null and ${table.outcomeCode} is not null and ${table.completedAt} is not null)
  `),
  check("provider_event_processing_time_check", sql`
    ${table.updatedAt}=date_trunc('milliseconds',${table.updatedAt})
    and (${table.leaseExpiresAt} is null or (${table.leaseExpiresAt}=date_trunc('milliseconds',${table.leaseExpiresAt}) and ${table.leaseExpiresAt}>${table.updatedAt}))
    and (${table.completedAt} is null or ${table.completedAt}=date_trunc('milliseconds',${table.completedAt}))
  `),
  check("provider_event_processing_text_check", sql`
    (${table.workerId} is null or ${boundedText(table.workerId)})
    and (${table.outcomeCode} is null or ${boundedText(table.outcomeCode, 64)})
  `),
  index("provider_event_processing_claim_idx").on(table.status, table.leaseExpiresAt, table.receiptId),
]);

export const providerEventAttempts = pgTable("provider_event_attempts", {
  receiptId: uuid("receipt_id").notNull(),
  provider: text("provider").notNull().default("stripe"),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  attempt: integer("attempt").notNull(),
  leaseGeneration: integer("lease_generation").notNull(),
  leaseToken: uuid("lease_token").notNull(),
  workerId: text("worker_id").notNull(),
  outcome: text("outcome").notNull(),
  safeCode: text("safe_code").notNull(),
  startedAt: instant("started_at").notNull(),
  finishedAt: instant("finished_at"),
}, (table) => [
  foreignKey({ columns: [table.receiptId, table.provider, table.receiverStripeAccountId], foreignColumns: [providerEventProcessing.receiptId, providerEventProcessing.provider, providerEventProcessing.receiverStripeAccountId], name: "provider_event_attempts_processing_fence_fk" }).onDelete("restrict").onUpdate("restrict"),
  primaryKey({ columns: [table.receiptId, table.attempt, table.leaseGeneration] }),
  unique("provider_event_attempts_lease_token_unique").on(table.leaseToken),
  check("provider_event_attempts_attempt_check", sql`${table.attempt}>0 and ${table.leaseGeneration}>0`),
  check("provider_event_attempts_outcome_check", sql`${table.outcome} in ('processing','processed','failed_retryable','failed_terminal','lease_expired')`),
  check("provider_event_attempts_code_check", boundedText(table.safeCode, 64)),
  check("provider_event_attempts_provider_check", sql`${table.provider}='stripe'`),
  check("provider_event_attempts_finish_check", sql`
    (${table.outcome}='processing' and ${table.finishedAt} is null)
    or (${table.outcome}<>'processing' and ${table.finishedAt} is not null and ${table.finishedAt}>=${table.startedAt})
  `),
]);

export const providerEventEffects = pgTable("provider_event_effects", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerReceiptId: uuid("provider_receipt_id").notNull(),
  provider: text("provider").notNull().default("stripe"),
  receiverStripeAccountId: text("receiver_stripe_account_id").notNull(),
  accountId: uuid("account_id").references(() => accounts.id, {
    onDelete: "restrict",
    onUpdate: "restrict",
  }),
  effectKind: text("effect_kind").notNull(),
  targetObjectId: uuid("target_object_id").notNull(),
  commandId: uuid("command_id").notNull(),
  createdAt: now("created_at"),
}, (table) => [
  foreignKey({
    columns: [table.providerReceiptId, table.provider, table.receiverStripeAccountId],
    foreignColumns: [
      providerEventReceipts.id,
      providerEventReceipts.provider,
      providerEventReceipts.receiverStripeAccountId,
    ],
    name: "provider_event_effects_receipt_owner_fk",
  }).onDelete("restrict").onUpdate("restrict"),
  unique("provider_event_effects_receipt_effect_target_unique").on(
    table.providerReceiptId,
    table.effectKind,
    table.targetObjectId,
  ),
  unique("provider_event_effects_domain_target_unique").on(
    table.provider,
    table.receiverStripeAccountId,
    table.effectKind,
    table.targetObjectId,
  ),
  unique("provider_event_effects_command_unique").on(table.commandId),
  unique("provider_event_effects_exact_unique").on(
    table.id,
    table.providerReceiptId,
    table.effectKind,
    table.targetObjectId,
  ),
  check("provider_event_effects_provider_check", sql`${table.provider}='stripe'`),
  check("provider_event_effects_kind_check", sql`${table.effectKind}~'^[a-z][a-z0-9_.]{0,63}$'`),
]);
