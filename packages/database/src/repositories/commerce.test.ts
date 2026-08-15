import { createHash } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

async function loadRepository() {
  return import("./commerce.js").catch(() => null);
}

const accountId = "10000000-0000-4000-8000-000000000001";
const commandId = "10000000-0000-4000-8000-000000000002";
const correlationId = "10000000-0000-4000-8000-000000000003";
const catalogVersionId = "10000000-0000-4000-8000-000000000004";
const priceBindingId = "10000000-0000-4000-8000-000000000005";
const academySourceRegistryId = "10000000-0000-4000-8000-000000000006";
const receiptId = "10000000-0000-4000-8000-000000000007";
const targetObjectId = "10000000-0000-4000-8000-000000000008";
const effectCommandId = "10000000-0000-4000-8000-000000000009";
const authorizationId = "10000000-0000-4000-8000-000000000012";
const providerActionId = "10000000-0000-4000-8000-000000000013";
const checkoutSessionId = "10000000-0000-4000-8000-000000000014";
const publicIntentId = "10000000-0000-4000-8000-000000000015";
const purchaseId = "10000000-0000-4000-8000-000000000017";
const providerLeaseToken = "10000000-0000-4000-8000-000000000018";
const membershipId = "10000000-0000-4000-8000-000000000019";
const setupEpochId = "10000000-0000-4000-8000-000000000020";
const claimId = "10000000-0000-4000-8000-000000000021";
const deliveryId = "10000000-0000-4000-8000-000000000022";
const pendingClaimSessionId = "10000000-0000-4000-8000-000000000023";
const identityId = "10000000-0000-4000-8000-000000000024";
const enrollmentId = "10000000-0000-4000-8000-000000000025";
const now = new Date("2026-08-15T16:00:00.000Z");

function fixture(rows: readonly Record<string, unknown>[]) {
  const execute = vi.fn(async (
    query: Parameters<PgDialect["sqlToQuery"]>[0],
  ) => {
    void query;
    return { rows };
  });
  const guard = {
    assertActive: vi.fn(),
    assertSettled: vi.fn(),
    run: <T>(operation: () => Promise<T>) => operation(),
  };
  return { execute, guard };
}

describe("TransactionCommerceRepository", () => {
  it("reserves one exact recurring family/catalog/provider topology before provider work", async () => {
    const module = await loadRepository();
    expect(module, "Commerce repository must exist").not.toBeNull();
    if (module === null) return;
    const db = fixture([{
      replayed: false,
      intent_id: "10000000-0000-4000-8000-000000000010",
      state: "provider_call_pending",
    }]);
    const repository = new module.TransactionCommerceRepository(
      { execute: db.execute } as never,
      {
        accountId,
        actor: { kind: "system", actorId: "commerce-provider.v1" },
        clock: { now: () => now },
        correlationId,
      },
      db.guard as never,
    );
    const input = {
      commandId,
      family: "operator_club" as const,
      offerCode: "operator_club_monthly" as const,
      environment: "production" as const,
      receiverStripeAccountId: "acct_production",
      catalogVersionId,
      priceBindingId,
      setupEpochId: null,
      setupPurchaseId: null,
      academySourceRegistryId,
      expiresAt: new Date("2026-08-15T16:30:00.000Z"),
    };
    await expect(repository.reserveRecurringPurchase(input)).resolves.toEqual({
      replayed: false,
      intentId: "10000000-0000-4000-8000-000000000010",
      state: "provider_call_pending",
    });
    expect(db.execute).toHaveBeenCalledOnce();
    const query = db.execute.mock.calls[0]![0];
    const values = new PgDialect().sqlToQuery(query).params;
    expect(values).toContain(accountId);
    expect(values).toContain(commandId);
    expect(values).toContain(createHash("sha256").update(JSON.stringify({
      academySourceRegistryId,
      catalogVersionId,
      environment: "production",
      expiresAt: "2026-08-15T16:30:00.000Z",
      family: "operator_club",
      offerCode: "operator_club_monthly",
      priceBindingId,
      receiverStripeAccountId: "acct_production",
      setupEpochId: null,
      setupPurchaseId: null,
    })).digest("hex"));
  });

  it("records one exact receipt/effect/target command and rejects malformed rows", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const db = fixture([{
      replayed: true,
      effect_id: "10000000-0000-4000-8000-000000000011",
      command_id: effectCommandId,
    }]);
    const repository = new module.TransactionCommerceRepository(
      { execute: db.execute } as never,
      {
        accountId,
        actor: { kind: "system", actorId: "commerce-provider.v1" },
        clock: { now: () => now },
        correlationId,
      },
      db.guard as never,
    );
    await expect(repository.recordProviderEffect({
      providerReceiptId: receiptId,
      provider: "stripe",
      receiverStripeAccountId: "acct_production",
      leaseToken: providerLeaseToken,
      leaseGeneration: 2,
      effectKind: "purchase.fulfilled",
      targetObjectId,
      commandId: effectCommandId,
    })).resolves.toEqual({
      replayed: true,
      effectId: "10000000-0000-4000-8000-000000000011",
      commandId: effectCommandId,
    });

    const malformed = fixture([{ replayed: "yes", effect_id: "private", command_id: null }]);
    const malformedRepository = new module.TransactionCommerceRepository(
      { execute: malformed.execute } as never,
      {
        accountId,
        actor: { kind: "system", actorId: "commerce-provider.v1" },
        clock: { now: () => now },
        correlationId,
      },
      malformed.guard as never,
    );
    await expect(malformedRepository.recordProviderEffect({
      providerReceiptId: receiptId,
      provider: "stripe",
      receiverStripeAccountId: "acct_production",
      leaseToken: providerLeaseToken,
      leaseGeneration: 2,
      effectKind: "purchase.fulfilled",
      targetObjectId,
      commandId: effectCommandId,
    })).rejects.toThrow("COMMERCE_COMMAND_RESULT_INVALID");
  });

  it("records one verified Stripe envelope while preserving terminal context drift", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const db = fixture([{
      replayed: false,
      receipt_id: receiptId,
      status: "failed_terminal",
    }]);
    const repository = new module.TransactionCommerceRepository(
      { execute: db.execute } as never,
      {
        accountId: null,
        actor: { kind: "system", actorId: "commerce-webhook.v1" },
        clock: { now: () => now },
        correlationId,
      },
      db.guard as never,
    );
    await expect(repository.recordProviderEvent({
      providerEventId: "evt_verified_1",
      eventType: "checkout.session.completed",
      livemode: true,
      apiVersion: "2026-06-24.dahlia",
      providerCreatedAt: new Date("2026-08-15T15:59:59.123Z"),
      dataObjectType: "checkout.session",
      dataObjectId: "cs_live_verified_1",
      eventObjectValid: true,
      receiverStripeAccountId: "acct_wrong",
      eventAccount: "acct_connect",
      eventContext: "ctx_connect",
      rawBodySha256: "a".repeat(64),
      expectedLivemode: true,
      expectedApiVersion: "2026-06-24.dahlia",
      expectedReceiverStripeAccountId: "acct_production",
    })).resolves.toEqual({
      replayed: false,
      receiptId,
      status: "failed_terminal",
    });
    const query = db.execute.mock.calls[0]![0];
    const values = new PgDialect().sqlToQuery(query).params;
    expect(values).toEqual(expect.arrayContaining([
      "evt_verified_1",
      "acct_wrong",
      "acct_connect",
      "ctx_connect",
      "acct_production",
      "a".repeat(64),
    ]));
  });

  it("durably records a correctly signed event with a missing API version as terminal", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const db = fixture([{
      replayed: false,
      receipt_id: receiptId,
      status: "failed_terminal",
    }]);
    const repository = new module.TransactionCommerceRepository(
      { execute: db.execute } as never,
      {
        accountId: null,
        actor: { kind: "system", actorId: "commerce-webhook.v1" },
        clock: { now: () => now },
        correlationId,
      },
      db.guard as never,
    );

    await expect(repository.recordProviderEvent({
      providerEventId: "evt_missing_version_1",
      eventType: "checkout.session.completed",
      livemode: true,
      apiVersion: null,
      providerCreatedAt: new Date("2026-08-15T15:59:59.123Z"),
      dataObjectType: "checkout.session",
      dataObjectId: "cs_live_missing_version_1",
      eventObjectValid: true,
      receiverStripeAccountId: "acct_production",
      eventAccount: null,
      eventContext: null,
      rawBodySha256: "b".repeat(64),
      expectedLivemode: true,
      expectedApiVersion: "2026-06-24.dahlia",
      expectedReceiverStripeAccountId: "acct_production",
    })).resolves.toEqual({
      replayed: false,
      receiptId,
      status: "failed_terminal",
    });
    const query = db.execute.mock.calls[0]![0];
    expect(new PgDialect().sqlToQuery(query).params[3]).toBeNull();
  });

  it("stages and publishes one exact catalog binding fingerprint", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const metadata = {
      accountId: null,
      actor: { kind: "system" as const, actorId: "commerce-catalog.v1" },
      clock: { now: () => now },
      correlationId,
    };
    const catalogDb = fixture([{
      replayed: false,
      catalog_version_id: catalogVersionId,
      state: "draft",
    }]);
    const catalogRepository = new module.TransactionCommerceRepository(
      { execute: catalogDb.execute } as never,
      metadata,
      catalogDb.guard as never,
    );
    await expect(catalogRepository.stageCatalogVersion({
      offerCode: "self_paced",
      version: "academy-2026-08",
      policyVersions: { availability: "v1", tax: "approved-2026-08" },
      contentReadinessHash: "b".repeat(64),
      catalogHash: "c".repeat(64),
    })).resolves.toEqual({
      replayed: false,
      catalogVersionId,
      state: "draft",
    });

    const bindingDb = fixture([{
      replayed: false,
      price_binding_id: priceBindingId,
    }]);
    const bindingRepository = new module.TransactionCommerceRepository(
      { execute: bindingDb.execute } as never,
      metadata,
      bindingDb.guard as never,
    );
    await expect(bindingRepository.stagePriceBinding({
      catalogVersionId,
      offerCode: "self_paced",
      environment: "production",
      stripeAccountId: "acct_production",
      stripeProductId: "prod_self_paced",
      stripePriceId: "price_self_paced",
      priceRole: "self_paced_once",
      productTaxCode: "txcd_education",
      currency: "usd",
      unitAmount: 39900,
      recurringInterval: null,
      intervalCount: null,
      taxBehavior: "exclusive",
      verifiedAt: new Date("2026-08-15T15:55:00.000Z"),
    })).resolves.toEqual({ replayed: false, priceBindingId });
    const bindingValues = new PgDialect().sqlToQuery(
      bindingDb.execute.mock.calls[0]![0],
    ).params;
    expect(bindingValues).toContain(createHash("sha256").update([
      "commerce-price-binding.v1",
      "self_paced",
      "production",
      "acct_production",
      "prod_self_paced",
      "price_self_paced",
      "self_paced_once",
      "txcd_education",
      "usd",
      "39900",
      "-",
      "0",
      "exclusive",
      "1",
    ].join("\n")).digest("hex"));

    const publishDb = fixture([{
      replayed: false,
      catalog_version_id: catalogVersionId,
      state: "published",
    }]);
    const publishRepository = new module.TransactionCommerceRepository(
      { execute: publishDb.execute } as never,
      metadata,
      publishDb.guard as never,
    );
    await expect(publishRepository.publishCatalogVersion({
      catalogVersionId,
      offerCode: "self_paced",
      environment: "production",
    })).resolves.toEqual({
      replayed: false,
      catalogVersionId,
      state: "published",
    });
  });

  it("stages one stable checkout action identity before provider work", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const db = fixture([{
      replayed: false,
      action_id: providerActionId,
      provider_idempotency_key: `checkout:${authorizationId}`,
      status: "pending",
    }]);
    const repository = new module.TransactionCommerceRepository(
      { execute: db.execute } as never,
      {
        accountId,
        actor: { kind: "system", actorId: "commerce-checkout.v1" },
        clock: { now: () => now },
        correlationId,
      },
      db.guard as never,
    );
    await expect(repository.stageCheckoutAction({
      authorizationId,
      requestFingerprint: "d".repeat(64),
    })).resolves.toEqual({
      replayed: false,
      actionId: providerActionId,
      providerIdempotencyKey: `checkout:${authorizationId}`,
      status: "pending",
    });
  });

  it("records one encrypted provider Session result and validates exact replay output", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const db = fixture([{
      replayed: false,
      checkout_session_id: checkoutSessionId,
      status: "open",
      payment_status: "unpaid",
    }]);
    const repository = new module.TransactionCommerceRepository(
      { execute: db.execute } as never,
      {
        accountId,
        actor: { kind: "system", actorId: "commerce-checkout.v1" },
        clock: { now: () => now },
        correlationId,
      },
      db.guard as never,
    );
    await expect(repository.recordCheckoutSession({
      actionId: providerActionId,
      requestFingerprint: "d".repeat(64),
      attempt: 1,
      providerSessionId: "cs_test_session",
      providerCustomerId: "cus_test_customer",
      mode: "payment",
      paymentStatus: "unpaid",
      checkoutUrlCiphertext: Buffer.from("ciphertext"),
      checkoutUrlNonce: Buffer.alloc(12, 1),
      checkoutUrlTag: Buffer.alloc(16, 2),
      checkoutUrlKeyId: "checkout-url-k1",
      expiresAt: new Date("2026-08-15T16:30:00.000Z"),
    })).resolves.toEqual({
      replayed: false,
      checkoutSessionId,
      status: "open",
      paymentStatus: "unpaid",
    });
  });

  it("fences a provider attempt and records only a bounded non-success outcome", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const beginDb = fixture([{
      replayed: false,
      action_id: providerActionId,
      provider_idempotency_key: `checkout:${authorizationId}`,
      attempt: 2,
    }]);
    const metadata = {
      accountId,
      actor: { kind: "system" as const, actorId: "commerce-checkout.v1" },
      clock: { now: () => now },
      correlationId,
    };
    const beginRepository = new module.TransactionCommerceRepository(
      { execute: beginDb.execute } as never,
      metadata,
      beginDb.guard as never,
    );
    await expect(beginRepository.beginCheckoutAction({
      actionId: providerActionId,
      requestFingerprint: "d".repeat(64),
    })).resolves.toEqual({
      replayed: false,
      actionId: providerActionId,
      providerIdempotencyKey: `checkout:${authorizationId}`,
      attempt: 2,
    });

    const finishDb = fixture([{
      replayed: false,
      status: "ambiguous",
    }]);
    const finishRepository = new module.TransactionCommerceRepository(
      { execute: finishDb.execute } as never,
      metadata,
      finishDb.guard as never,
    );
    await expect(finishRepository.finishCheckoutAction({
      actionId: providerActionId,
      requestFingerprint: "d".repeat(64),
      attempt: 2,
      outcome: "ambiguous",
      errorCode: "PROVIDER_RESULT_UNKNOWN",
    })).resolves.toEqual({ replayed: false, status: "ambiguous" });
  });

  it("reserves a pre-account Business OS setup without returning HMAC or ciphertext", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const db = fixture([{
      replayed: false,
      public_intent_id: publicIntentId,
      authorization_id: authorizationId,
      action_id: providerActionId,
      provider_idempotency_key: `business_os_setup_checkout:${providerActionId}`,
      state: "checkout_create_pending",
    }]);
    const repository = new module.TransactionCommerceRepository(
      { execute: db.execute } as never,
      {
        accountId: null,
        actor: { kind: "system", actorId: "commerce-public-checkout.v1" },
        clock: { now: () => now },
        correlationId,
      },
      db.guard as never,
    );
    await expect(repository.reservePublicBusinessOsSetup({
      principalId: "anonymous-session-1",
      idempotencyKey: "public-bos-checkout-0001",
      environment: "production",
      receiverStripeAccountId: "acct_production",
      catalogVersionId,
      priceBindingId,
      purchaserGuardHmac: Buffer.alloc(32, 1),
      semanticRequestHmac: Buffer.alloc(32, 2),
      equalityKeyId: "privacy-equality-k1",
      commandDigestKeyId: "command-digest-k1",
      contactCiphertext: Buffer.from("contact"),
      contactNonce: Buffer.alloc(12, 3),
      contactTag: Buffer.alloc(16, 4),
      contactKeyId: "contact-k1",
      businessNameCiphertext: Buffer.from("business"),
      businessNameNonce: Buffer.alloc(12, 5),
      businessNameTag: Buffer.alloc(16, 6),
      businessNameKeyId: "business-name-k1",
      businessNameContentHash: "b".repeat(64),
      accountNameSchemaVersion: "account_name_v1",
      requestHash: "e".repeat(64),
      integrationIdentifier: "syntholo_AbCdEfGh",
      policyVersions: { refund: "refund_v1", recurring: "recurring_v1" },
      expiresAt: new Date("2026-08-15T16:30:00.000Z"),
    })).resolves.toEqual({
      replayed: false,
      publicIntentId,
      authorizationId,
      actionId: providerActionId,
      providerIdempotencyKey: `business_os_setup_checkout:${providerActionId}`,
      state: "checkout_create_pending",
    });
  });

  it("reserves anonymous Self-Paced with immutable contact and name bindings", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const db = fixture([{
      replayed: false,
      authorization_id: authorizationId,
      action_id: providerActionId,
      provider_idempotency_key: `checkout:${authorizationId}`,
      state: "provider_call_pending",
    }]);
    const repository = new module.TransactionCommerceRepository(
      { execute: db.execute } as never,
      {
        accountId: null,
        actor: { kind: "system", actorId: "commerce-public-checkout.v1" },
        clock: { now: () => now },
        correlationId,
      },
      db.guard as never,
    );
    await expect(repository.reservePublicSelfPacedCheckout({
      principalId: "anonymous-session-2",
      idempotencyKey: "public-self-paced-0001",
      environment: "production",
      receiverStripeAccountId: "acct_production",
      catalogVersionId,
      priceBindingId,
      contactEmailFingerprint: Buffer.alloc(32, 1),
      contactCiphertext: Buffer.from("contact"),
      contactNonce: Buffer.alloc(12, 2),
      contactTag: Buffer.alloc(16, 3),
      contactKeyId: "contact-k1",
      businessNameCiphertext: Buffer.from("business"),
      businessNameNonce: Buffer.alloc(12, 4),
      businessNameTag: Buffer.alloc(16, 5),
      businessNameKeyId: "business-name-k1",
      businessNameContentHash: "c".repeat(64),
      accountNameSchemaVersion: "account_name_v1",
      requestHash: "d".repeat(64),
      integrationIdentifier: "syntholo_AbCdEfGh",
      policyVersions: {
        terms: "terms_v1",
        privacy: "privacy_v1",
        refund: "refund_v1",
      },
      expiresAt: new Date("2026-08-15T16:30:00.000Z"),
    })).resolves.toEqual({
      replayed: false,
      authorizationId,
      actionId: providerActionId,
      providerIdempotencyKey: `checkout:${authorizationId}`,
      state: "provider_call_pending",
    });
  });

  it("reserves one owner-scoped Business OS setup epoch before provider work", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const db = fixture([{
      replayed: false,
      setup_epoch_id: setupEpochId,
      authorization_id: authorizationId,
      action_id: providerActionId,
      provider_idempotency_key: `checkout:${authorizationId}`,
      state: "checkout_create_pending",
    }]);
    const repository = new module.TransactionCommerceRepository(
      { execute: db.execute } as never,
      {
        accountId,
        actor: { kind: "system", actorId: "commerce-member-checkout.v1" },
        clock: { now: () => now },
        correlationId,
      },
      db.guard as never,
    );
    await expect(repository.reserveExistingBusinessOsSetup({
      membershipId,
      idempotencyKey: "member-bos-checkout-0001",
      environment: "production",
      receiverStripeAccountId: "acct_production",
      catalogVersionId,
      priceBindingId,
      requestHash: "f".repeat(64),
      integrationIdentifier: "syntholo_AbCdEfGh",
      policyVersions: { refund: "refund_v1", recurring: "recurring_v1" },
      expiresAt: new Date("2026-08-15T16:30:00.000Z"),
    })).resolves.toEqual({
      replayed: false,
      setupEpochId,
      authorizationId,
      actionId: providerActionId,
      providerIdempotencyKey: `checkout:${authorizationId}`,
      state: "checkout_create_pending",
    });
    const values = new PgDialect().sqlToQuery(db.execute.mock.calls[0]![0]).params;
    expect(values).toEqual(expect.arrayContaining([
      accountId,
      membershipId,
      "member-bos-checkout-0001",
      "f".repeat(64),
    ]));
  });

  it("records a signed paid purchase as one immutable financial and Task 8 effect", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const db = fixture([{
      replayed: false,
      purchase_id: purchaseId,
      status: "paid",
      source_registry_id: academySourceRegistryId,
      fulfillment_status: "fulfilled",
    }]);
    const repository = new module.TransactionCommerceRepository(
      { execute: db.execute } as never,
      {
        accountId,
        actor: { kind: "system", actorId: "commerce-provider-v1" },
        clock: { now: () => now },
        correlationId,
      },
      db.guard as never,
    );
    await expect(repository.recordPaidPurchase({
      providerReceiptId: receiptId,
      receiverStripeAccountId: "acct_production",
      leaseToken: providerLeaseToken,
      leaseGeneration: 2,
      authorizationId,
      providerPaymentIntentId: "pi_paid_1",
      providerChargeId: "ch_paid_1",
      grossAmount: 39900,
      taxAmount: 0,
      purchasedAt: now,
      commandId: effectCommandId,
    })).resolves.toEqual({
      replayed: false,
      purchaseId,
      status: "paid",
      sourceRegistryId: academySourceRegistryId,
      fulfillmentStatus: "fulfilled",
    });
  });

  it("atomically creates the public Self-Paced account, claim, and learning seed", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const db = fixture([{
      replayed: false,
      account_id: accountId,
      purchase_id: purchaseId,
      status: "paid",
      source_registry_id: academySourceRegistryId,
      fulfillment_status: "fulfilled",
      claim_id: claimId,
      delivery_id: deliveryId,
    }]);
    const repository = new module.TransactionCommerceRepository(
      { execute: db.execute } as never,
      {
        accountId: null,
        actor: { kind: "system", actorId: "commerce-provider-v1" },
        clock: { now: () => now },
        correlationId,
      },
      db.guard as never,
    );
    await expect(repository.recordPublicSelfPacedPaid({
      providerReceiptId: receiptId,
      receiverStripeAccountId: "acct_production",
      leaseToken: providerLeaseToken,
      leaseGeneration: 2,
      authorizationId,
      providerPaymentIntentId: "pi_public_paid_1",
      providerChargeId: "ch_public_paid_1",
      grossAmount: 39900,
      taxAmount: 0,
      purchasedAt: now,
      commandId: effectCommandId,
      businessName: "Syntholo Studio",
      claimTokenHash: "a".repeat(64),
      deliveryTokenCiphertext: Buffer.from("claim-token"),
      deliveryTokenNonce: Buffer.alloc(12, 1),
      deliveryTokenTag: Buffer.alloc(16, 2),
      deliveryTokenKeyId: "claim-delivery-k1",
    })).resolves.toEqual({
      replayed: false,
      accountId,
      purchaseId,
      status: "paid",
      sourceRegistryId: academySourceRegistryId,
      fulfillmentStatus: "fulfilled",
      claimId,
      deliveryId,
    });
  });

  it("atomically creates a public Business OS setup without creating grants", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const db = fixture([{
      replayed: false, account_id: accountId, purchase_id: purchaseId,
      setup_epoch_id: setupEpochId, status: "paid",
      source_registry_id: academySourceRegistryId,
      setup_kind: "recorded", claim_id: claimId, delivery_id: deliveryId,
    }]);
    const repository = new module.TransactionCommerceRepository(
      { execute: db.execute } as never,
      {
        accountId: null,
        actor: { kind: "system", actorId: "commerce-provider-v1" },
        clock: { now: () => now }, correlationId,
      },
      db.guard as never,
    );
    await expect(repository.recordPublicBusinessOsSetupPaid({
      providerReceiptId: receiptId, receiverStripeAccountId: "acct_production",
      leaseToken: providerLeaseToken, leaseGeneration: 2,
      publicIntentId, authorizationId, providerCustomerId: "cus_bos_paid_1",
      providerPaymentIntentId: "pi_bos_paid_1", providerChargeId: "ch_bos_paid_1",
      grossAmount: 99900, taxAmount: 0, purchasedAt: now,
      commandId: effectCommandId, businessName: "Syntholo Studio",
      claimTokenHash: "a".repeat(64), deliveryTokenCiphertext: Buffer.from("claim-token"),
      deliveryTokenNonce: Buffer.alloc(12, 1), deliveryTokenTag: Buffer.alloc(16, 2),
      deliveryTokenKeyId: "claim-delivery-k1", reconciliationReason: null,
    })).resolves.toEqual({
      replayed: false, accountId, purchaseId, setupEpochId, status: "paid",
      sourceRegistryId: academySourceRegistryId, setupKind: "recorded",
      claimId, deliveryId,
    });
  });

  it("initiates and redeems one encrypted owner claim without granting twice", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        replayed: false,
        pending_session_id: pendingClaimSessionId,
        account_id: accountId,
        offer_code: "self_paced",
        business_name: "Syntholo Studio",
        expires_at: new Date("2026-08-22T16:00:00.000Z"),
      }] })
      .mockResolvedValueOnce({ rows: [{
        replayed: false,
        account_id: accountId,
        identity_id: identityId,
        membership_id: membershipId,
        enrollment_id: enrollmentId,
        seat_activated: true,
      }] });
    const guard = {
      assertActive: vi.fn(), assertSettled: vi.fn(),
      run: <T>(operation: () => Promise<T>) => operation(),
    };
    const repository = new module.TransactionCommerceRepository(
      { execute } as never,
      {
        accountId: null,
        actor: { kind: "system", actorId: "commerce-claim.v1" },
        clock: { now: () => now },
        correlationId,
      },
      guard as never,
    );
    await expect(repository.initiateClaim({
      claimTokenHash: "a".repeat(64),
      sessionHandleHash: "b".repeat(64),
    })).resolves.toEqual({
      replayed: false,
      pendingSessionId: pendingClaimSessionId,
      accountId,
      offerCode: "self_paced",
      businessName: "Syntholo Studio",
      expiresAt: new Date("2026-08-22T16:00:00.000Z"),
    });
    await expect(repository.redeemClaim({
      sessionHandleHash: "b".repeat(64),
      commandId,
      clerkUserId: "user_claim_owner",
      verifiedEmail: "owner@example.test",
      verifiedEmailFingerprint: Buffer.alloc(32, 7),
    })).resolves.toEqual({
      replayed: false,
      accountId,
      identityId,
      membershipId,
      enrollmentId,
      seatActivated: true,
    });
  });

  it("reads, saves, and completes one exact optimistic onboarding workflow", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        account_id: accountId, product_family: "academy", version: 1,
        business_name: "Syntholo Studio", website: null, category: null,
        country: null, timezone: null, team_size_band: null, owner_role: null,
        primary_goal: null, tools: { crm: [], scheduling: [], email: [] },
        priorities: [], scorecard_attachment_id: null,
        invitation_step_completed: false, delivery_schedule_confirmed: false,
        current_step: "business", completed_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [{
        version: 2, current_step: "priorities", completed: false,
      }] })
      .mockResolvedValueOnce({ rows: [{
        replayed: false, version: 2, destination: "academy",
      }] });
    const guard = {
      assertActive: vi.fn(), assertSettled: vi.fn(),
      run: <T>(operation: () => Promise<T>) => operation(),
    };
    const repository = new module.TransactionCommerceRepository(
      { execute } as never,
      {
        accountId,
        actor: {
          kind: "member", actorId: identityId, accountId, membershipId,
          clerkUserId: "user_onboarding_owner", role: "owner", authenticatedAt: now,
        },
        clock: { now: () => now }, correlationId,
      },
      guard as never,
    );
    await expect(repository.getOnboarding()).resolves.toMatchObject({
      accountId, productFamily: "academy", version: 1,
      businessName: "Syntholo Studio", currentStep: "business",
    });
    await expect(repository.saveOnboarding({
      expectedVersion: 1, businessName: "Syntholo Studio",
      website: "https://syntholo.example.test", category: "education",
      country: "US", timezone: "America/New_York", teamSizeBand: "2-5",
      ownerRole: "Founder", primaryGoal: "Build a repeatable operating system",
      tools: { crm: ["HubSpot"], scheduling: ["Calendly"], email: ["Gmail"] },
      priorities: ["Ship onboarding", "Instrument learning", "Invite team"],
      scorecardAttachmentId: null, invitationStepCompleted: false,
      deliveryScheduleConfirmed: false, currentStep: "priorities",
    })).resolves.toEqual({ version: 2, currentStep: "priorities", completed: false });
    await expect(repository.completeOnboarding({
      expectedVersion: 2, idempotencyKey: "onboarding-complete-0001",
      requestHash: "c".repeat(64),
    })).resolves.toEqual({ replayed: false, version: 2, destination: "academy" });
  });

  it("returns the existing safe recurring state instead of starting another provider call", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const db = fixture([{
      replayed: true,
      intent_id: "10000000-0000-4000-8000-000000000010",
      state: "active",
    }]);
    const repository = new module.TransactionCommerceRepository(
      { execute: db.execute } as never,
      {
        accountId,
        actor: { kind: "system", actorId: "commerce-provider.v1" },
        clock: { now: () => now },
        correlationId,
      },
      db.guard as never,
    );

    await expect(repository.reserveRecurringPurchase({
      commandId,
      family: "operator_club",
      offerCode: "operator_club_monthly",
      environment: "production",
      receiverStripeAccountId: "acct_production",
      catalogVersionId,
      priceBindingId,
      setupEpochId: null,
      setupPurchaseId: null,
      academySourceRegistryId,
      expiresAt: new Date("2026-08-15T16:30:00.000Z"),
    })).resolves.toEqual({
      replayed: true,
      intentId: "10000000-0000-4000-8000-000000000010",
      state: "active",
    });
  });

  it("claims and finishes one exact provider receipt lease", async () => {
    const module = await loadRepository();
    expect(module).not.toBeNull();
    if (module === null) return;
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        receipt_id: receiptId,
        provider_event_id: "evt_123",
        event_type: "invoice.paid",
        livemode: true,
        api_version: "2026-08-01.syntholo",
        provider_created_at: new Date("2026-08-15T15:59:00.000Z"),
        data_object_type: "invoice",
        data_object_id: "in_123",
        receiver_stripe_account_id: "acct_production",
        event_account: null,
        event_context: null,
        raw_body_sha256: "a".repeat(64),
        received_at: new Date("2026-08-15T15:59:01.000Z"),
        lease_token: "10000000-0000-4000-8000-000000000012",
        lease_generation: 1,
        lease_expires_at: new Date("2026-08-15T16:00:30.000Z"),
      }] })
      .mockResolvedValueOnce({ rows: [{
        replayed: false,
        status: "processed",
      }] });
    const guard = fixture([]).guard;
    const repository = new module.TransactionCommerceRepository(
      { execute } as never,
      {
        accountId: null,
        actor: { kind: "system", actorId: "commerce-worker-01" },
        clock: { now: () => now },
        correlationId,
      },
      guard as never,
    );

    const claim = await repository.claimProviderEvent({ leaseDurationMs: 30_000 });
    expect(claim).toMatchObject({
      receiptId,
      providerEventId: "evt_123",
      eventType: "invoice.paid",
      leaseGeneration: 1,
      receiverStripeAccountId: "acct_production",
    });
    await expect(repository.finishProviderEvent({
      receiptId,
      leaseToken: "10000000-0000-4000-8000-000000000012",
      leaseGeneration: 1,
      outcome: "processed",
      safeCode: "invoice_paid_applied",
    })).resolves.toEqual({ replayed: false, status: "processed" });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
