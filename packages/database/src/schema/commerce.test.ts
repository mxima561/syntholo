import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accounts } from "./identity.js";
import { providerEventReceipts } from "./operations.js";

async function loadCommerceSchema() {
  return import("./commerce.js").catch(() => null);
}

describe("Commerce catalog persistence schema", () => {
  it("publishes the exact 0014 catalog, provider, financial, claim, and onboarding roots", async () => {
    const schema = await loadCommerceSchema();
    expect(schema, "Commerce schema must exist").not.toBeNull();
    if (schema === null) return;

    expect(Object.keys(schema).sort()).toEqual([
      "accountOnboarding",
      "accountOnboardingPriorities",
      "businessOsSetupEpochs",
      "checkoutAuthorizations",
      "checkoutProviderActions",
      "checkoutSessions",
      "claimTokens",
      "controlledPaymentAuthorizations",
      "invoiceLineAllocations",
      "invoices",
      "offerCatalogVersions",
      "offerPriceBindings",
      "offers",
      "pendingClaimSessions",
      "providerEventAttempts",
      "providerEventEffects",
      "providerEventProcessing",
      "publicBusinessOsSetupFulfillments",
      "publicBusinessOsSetupIntents",
      "purchasePaymentAllocations",
      "purchases",
      "recurringPurchaseIntents",
      "secureLinkDeliveries",
      "stripeCustomerCreationActions",
      "stripeCustomers",
      "subscriptionSchedules",
      "subscriptions",
    ]);
  });

  it("mirrors exact account and provider ownership instead of UUID-only relationships", async () => {
    const schema = await loadCommerceSchema();
    expect(schema).not.toBeNull();
    if (schema === null) return;

    const foreignKeyNames = (table: Parameters<typeof getTableConfig>[0]) =>
      getTableConfig(table).foreignKeys.map((key) => key.getName()).sort();

    expect(foreignKeyNames(schema.checkoutSessions)).toContain(
      "checkout_sessions_authorization_account_fk",
    );
    expect(foreignKeyNames(schema.offers)).toContain(
      "offers_current_catalog_exact_fk",
    );
    expect(foreignKeyNames(schema.checkoutSessions)).toEqual(expect.arrayContaining([
      "checkout_sessions_authorization_id_fk",
      "checkout_sessions_authorization_provider_fk",
    ]));
    expect(foreignKeyNames(schema.checkoutProviderActions)).toContain(
      "checkout_provider_actions_authorization_account_fk",
    );
    expect(foreignKeyNames(schema.checkoutProviderActions)).toContain(
      "checkout_provider_actions_authorization_id_fk",
    );
    expect(foreignKeyNames(schema.checkoutProviderActions)).toContain(
      "checkout_provider_actions_authorization_provider_fk",
    );
    expect(foreignKeyNames(schema.checkoutProviderActions)).toContain(
      "checkout_provider_actions_session_result_fk",
    );
    expect(foreignKeyNames(schema.checkoutAuthorizations)).toEqual(expect.arrayContaining([
      "checkout_authorizations_price_exact_fk",
      "checkout_authorizations_price_provider_fk",
      "checkout_authorizations_public_intent_fk",
      "checkout_authorizations_setup_epoch_fk",
      "checkout_authorizations_recurring_intent_fk",
    ]));
    expect(foreignKeyNames(schema.businessOsSetupEpochs)).toEqual(expect.arrayContaining([
      "business_os_setup_epochs_price_provider_fk",
      "business_os_setup_epochs_public_intent_fk",
    ]));
    expect(foreignKeyNames(schema.recurringPurchaseIntents)).toEqual(expect.arrayContaining([
      "recurring_purchase_intents_price_provider_fk",
      "recurring_purchase_intents_setup_epoch_fk",
      "recurring_purchase_intents_setup_purchase_fk",
    ]));
    expect(foreignKeyNames(schema.stripeCustomers)).toEqual(expect.arrayContaining([
      "stripe_customers_creation_action_provider_fk",
      "stripe_customers_checkout_result_fk",
      "stripe_customers_public_intent_fk",
    ]));
    expect(foreignKeyNames(schema.purchases)).toEqual(expect.arrayContaining([
      "purchases_authorization_fk",
      "purchases_authorization_provider_fk",
    ]));
    expect(foreignKeyNames(schema.subscriptions)).toEqual(expect.arrayContaining([
      "subscriptions_recurring_intent_provider_fk",
      "subscriptions_customer_provider_fk",
      "subscriptions_price_provider_fk",
    ]));
    expect(foreignKeyNames(schema.subscriptionSchedules)).toEqual(expect.arrayContaining([
      "subscription_schedules_intent_provider_fk",
      "subscription_schedules_subscription_provider_fk",
    ]));
    expect(foreignKeyNames(schema.invoices)).toContain(
      "invoices_subscription_provider_fk",
    );
    expect(foreignKeyNames(schema.purchasePaymentAllocations)).toContain(
      "purchase_payment_allocations_purchase_provider_fk",
    );
    expect(foreignKeyNames(schema.invoiceLineAllocations)).toEqual(expect.arrayContaining([
      "invoice_line_allocations_invoice_provider_fk",
      "invoice_line_allocations_price_provider_fk",
    ]));
    expect(foreignKeyNames(schema.controlledPaymentAuthorizations)).toEqual(
      expect.arrayContaining([
        "controlled_payment_authorizations_price_provider_fk",
        "controlled_payment_authorizations_checkout_provider_fk",
      ]),
    );
    expect(foreignKeyNames(schema.accountOnboardingPriorities)).toContain(
      "account_onboarding_priorities_onboarding_account_fk",
    );
    expect(foreignKeyNames(schema.publicBusinessOsSetupFulfillments)).toEqual(
      expect.arrayContaining([
        "public_bos_setup_fulfillments_intent_fk",
        "public_bos_setup_fulfillments_epoch_fk",
        "public_bos_setup_fulfillments_purchase_fk",
        "public_bos_setup_fulfillments_source_fk",
        "public_bos_setup_fulfillments_receipt_fk",
      ]),
    );
    expect(foreignKeyNames(schema.providerEventEffects)).toContain(
      "provider_event_effects_receipt_owner_fk",
    );
    expect(foreignKeyNames(schema.providerEventProcessing)).toContain(
      "provider_event_processing_receipt_owner_fk",
    );
    expect(foreignKeyNames(schema.providerEventAttempts)).toContain(
      "provider_event_attempts_processing_fence_fk",
    );
    expect(foreignKeyNames(schema.secureLinkDeliveries)).toEqual(
      expect.arrayContaining([
        "secure_link_deliveries_claim_account_fk",
        "secure_link_deliveries_invitation_account_fk",
        "secure_link_deliveries_controlled_payment_fk",
      ]),
    );

    const uniqueNames = (table: Parameters<typeof getTableConfig>[0]) =>
      getTableConfig(table).uniqueConstraints.map(({ name }) => name).sort();
    expect(uniqueNames(schema.offerPriceBindings)).toEqual(expect.arrayContaining([
      "offer_price_bindings_authorization_owner_unique",
      "offer_price_bindings_catalog_environment_owner_unique",
      "offer_price_bindings_provider_owner_unique",
      "offer_price_bindings_catalog_provider_owner_unique",
      "offer_price_bindings_price_provider_unique",
    ]));
    expect(uniqueNames(schema.offerCatalogVersions)).toContain(
      "offer_catalog_versions_current_owner_unique",
    );
    expect(uniqueNames(schema.checkoutAuthorizations)).toContain(
      "checkout_authorizations_id_account_unique",
    );
    expect(uniqueNames(schema.checkoutAuthorizations)).toContain(
      "checkout_authorizations_provider_owner_unique",
    );
    expect(uniqueNames(schema.recurringPurchaseIntents)).toContain(
      "recurring_purchase_intents_id_account_unique",
    );
    expect(uniqueNames(schema.recurringPurchaseIntents)).toContain(
      "recurring_purchase_intents_id_account_environment_unique",
    );
    expect(uniqueNames(schema.recurringPurchaseIntents)).toContain(
      "recurring_purchase_intents_provider_owner_unique",
    );
    expect(uniqueNames(schema.recurringPurchaseIntents)).toContain(
      "recurring_purchase_intents_reservation_command_unique",
    );
    expect(uniqueNames(schema.businessOsSetupEpochs)).toContain(
      "business_os_setup_epochs_provider_owner_unique",
    );
    expect(uniqueNames(schema.stripeCustomerCreationActions)).toContain(
      "stripe_customer_creation_actions_provider_owner_unique",
    );
    expect(uniqueNames(schema.stripeCustomers)).toContain(
      "stripe_customers_provider_owner_unique",
    );
    expect(uniqueNames(schema.purchases)).toContain("purchases_id_account_unique");
    expect(uniqueNames(schema.purchases)).toContain("purchases_provider_owner_unique");
    expect(uniqueNames(schema.purchases)).toContain("purchases_authorization_unique");
    expect(uniqueNames(schema.purchasePaymentAllocations)).toContain(
      "purchase_payment_allocations_purchase_type_unique",
    );
    expect(uniqueNames(schema.subscriptions)).toContain("subscriptions_id_account_unique");
    expect(uniqueNames(schema.subscriptions)).toContain(
      "subscriptions_provider_owner_unique",
    );
    expect(uniqueNames(schema.invoices)).toContain(
      "invoices_provider_owner_unique",
    );
    expect(uniqueNames(schema.claimTokens)).toContain("claim_tokens_id_account_unique");
    expect(uniqueNames(schema.publicBusinessOsSetupFulfillments)).toEqual(
      expect.arrayContaining([
        "public_bos_setup_fulfillments_epoch_unique",
        "public_bos_setup_fulfillments_purchase_unique",
        "public_bos_setup_fulfillments_source_unique",
        "public_bos_setup_fulfillments_receipt_unique",
        "public_bos_setup_fulfillments_exact_unique",
      ]),
    );
    expect(uniqueNames(providerEventReceipts)).toContain(
      "provider_event_receipts_fulfillment_owner_unique",
    );
    expect(uniqueNames(schema.providerEventEffects)).toEqual(expect.arrayContaining([
      "provider_event_effects_receipt_effect_target_unique",
      "provider_event_effects_domain_target_unique",
      "provider_event_effects_command_unique",
      "provider_event_effects_exact_unique",
    ]));
  });

  it("freezes provider and public-intent singleton indexes before provider work", async () => {
    const schema = await loadCommerceSchema();
    expect(schema).not.toBeNull();
    if (schema === null) return;

    const indexNames = (table: Parameters<typeof getTableConfig>[0]) =>
      getTableConfig(table).indexes.map(({ config }) => config.name).sort();

    expect(indexNames(schema.offerPriceBindings)).toEqual(expect.arrayContaining([
      "offer_price_bindings_active_role_unique",
      "offer_price_bindings_provider_price_unique",
    ]));
    expect(getTableConfig(schema.offers).checks.map(({ name }) => name))
      .toContain("offers_topology_check");
    expect(getTableConfig(schema.offerCatalogVersions).checks.map(({ name }) => name))
      .toContain("offer_catalog_versions_lifecycle_check");
    expect(getTableConfig(schema.offerPriceBindings).checks.map(({ name }) => name))
      .toContain("offer_price_bindings_lifecycle_check");
    expect(getTableConfig(schema.checkoutProviderActions).checks.map(({ name }) => name))
      .toEqual(expect.arrayContaining([
        "checkout_provider_actions_identity_check",
        "checkout_provider_actions_lifecycle_check",
      ]));
    expect(getTableConfig(schema.checkoutSessions).checks.map(({ name }) => name))
      .toEqual(expect.arrayContaining([
        "checkout_sessions_provider_identity_check",
        "checkout_sessions_time_check",
      ]));
    expect(indexNames(schema.publicBusinessOsSetupIntents)).toContain(
      "public_bos_setup_intents_one_blocking_guard",
    );
    expect(indexNames(schema.businessOsSetupEpochs)).toContain(
      "business_os_setup_epochs_one_blocking_account",
    );
    expect(indexNames(schema.recurringPurchaseIntents)).toContain(
      "recurring_purchase_intents_one_nonterminal_family",
    );
    expect(indexNames(schema.controlledPaymentAuthorizations)).toContain(
      "controlled_payment_authorizations_one_live_release",
    );
  });

  it("persists the exact recurring reservation identity and semantic request hash", async () => {
    const schema = await loadCommerceSchema();
    expect(schema).not.toBeNull();
    if (schema === null) return;

    expect(Object.keys(getTableColumns(schema.recurringPurchaseIntents)))
      .toEqual(expect.arrayContaining([
        "reservationCommandId",
        "reservationRequestHash",
      ]));
    expect(getTableConfig(schema.recurringPurchaseIntents).checks
      .map(({ name }) => name)).toContain(
      "recurring_purchase_intents_request_hash_check",
    );
  });

  it("binds every anonymous checkout to the canonical business-name hash", async () => {
    const schema = await loadCommerceSchema();
    expect(schema).not.toBeNull();
    if (schema === null) return;

    expect(Object.keys(getTableColumns(schema.checkoutAuthorizations)))
      .toContain("businessNameContentHash");
    expect(getTableConfig(schema.checkoutAuthorizations).checks
      .map(({ name }) => name)).toContain(
      "checkout_authorizations_business_name_hash_check",
    );
  });

  it("mirrors the canonical account-name state and immutable Stripe receipt envelope", () => {
    expect(Object.keys(getTableColumns(accounts))).toContain("nameStatus");
    expect(Object.keys(getTableColumns(providerEventReceipts))).toEqual([
      "id",
      "provider",
      "providerEventId",
      "eventType",
      "livemode",
      "apiVersion",
      "providerCreatedAt",
      "dataObjectType",
      "dataObjectId",
      "receiverStripeAccountId",
      "eventAccount",
      "eventContext",
      "rawBodySha256",
      "status",
      "payload",
      "receivedAt",
      "processedAt",
      "lastErrorCode",
    ]);
    expect(getTableConfig(providerEventReceipts).checks.map(({ name }) => name))
      .toContain("provider_event_receipts_stripe_envelope_check");
    const envelopeCheck = getTableConfig(providerEventReceipts).checks
      .find(({ name }) => name === "provider_event_receipts_stripe_envelope_check");
    const envelopeSql = new PgDialect().sqlToQuery(envelopeCheck!.value).sql;
    expect(envelopeSql).toContain("event_account");
    expect(envelopeSql).not.toContain(
      "event_account is null and",
    );
  });

  it("rejects half-fenced provider processing and attempt states", async () => {
    const schema = await loadCommerceSchema();
    expect(schema).not.toBeNull();
    if (schema === null) return;

    expect(getTableConfig(schema.providerEventProcessing).checks
      .map(({ name }) => name)).toEqual(expect.arrayContaining([
      "provider_event_processing_fence_check",
      "provider_event_processing_time_check",
      "provider_event_processing_text_check",
    ]));
    expect(getTableConfig(schema.providerEventAttempts).checks
      .map(({ name }) => name)).toContain(
      "provider_event_attempts_finish_check",
    );
  });
});
