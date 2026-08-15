import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const fixtureUrl = new URL("./commerce-catalog-handshake.json", import.meta.url);
const migrationUrl = new URL("../../drizzle/0014_commerce_catalog.sql", import.meta.url);

describe("Commerce catalog schema handshake", () => {
  it("is SHA-bound and freezes the exact catalog, ownership, receipt, claim, and downstream contract", async () => {
    const fixtureText = await readFile(fixtureUrl, "utf8");
    expect(createHash("sha256").update(fixtureText).digest("hex")).toBe(
      "5f72c5f9c1f25bdfb815f3dc10fa90eccb42e33e3fa13555851da7542e9f7d27",
    );
    const fixture = JSON.parse(fixtureText) as Record<string, unknown>;
    const migration = await readFile(migrationUrl, "utf8");
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      migration: {
        index: 13,
        timestamp: 1787029200000,
        tag: "0014_commerce_catalog",
        sha256: createHash("sha256").update(migration).digest("hex"),
      },
      upstreamAuthority: {
        implementation: {
          sha256: "dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9",
        },
        certificates: {
          sha256: "878a759f41c44e0cbb9cf7492889bdf4d6f0ab087f0e9d7b26865f988fbe1bd9",
          commerceIsAuthority: false,
          commerceMayRevokeOrMutate: false,
        },
      },
      catalog: {
        currency: "usd",
        ordinaryValues: [
          { code: "scorecard", unitAmount: 0 },
          { code: "self_paced", unitAmount: 39900 },
          { code: "guided_pilot", unitAmount: 75000 },
          { code: "operator_club_monthly", unitAmount: 5900 },
          { code: "operator_club_annual", unitAmount: 59000 },
          { code: "business_os", unitAmount: 99900, recurringUnitAmount: 19900 },
        ],
      },
      businessOs: { cleanupEnabled: false },
      providerReceipts: { rawPayloadRetention: "empty_json_only" },
    });
    const requiredSql = [
      "offers_current_catalog_exact_fk",
      "offer_catalog_versions_exact_unique",
      "offer_price_bindings_exact_unique",
      "offer_price_bindings_provider_price_unique",
      "checkout_authorizations_source_receipt_unique",
      "checkout_authorizations_provider_owner_unique",
      "checkout_sessions_provider_unique",
      "checkout_provider_actions_provider_key_unique",
      "public_bos_setup_intents_one_blocking_guard",
      "business_os_setup_epochs_one_blocking_account",
      "recurring_purchase_intents_one_nonterminal_family",
      "stripe_customers_account_environment_unique",
      "purchases_provider_payment_unique",
      "claim_tokens_hash_unique",
      "pending_claim_sessions_handle_unique",
      "account_onboarding_exact_unique",
      "provider_event_receipts_fulfillment_owner_unique",
      "provider_event_processing_fence_owner_unique",
      "provider_event_attempts_lease_token_unique",
      "provider_event_effects_receipt_effect_target_unique",
      "provider_event_effects_domain_target_unique",
      "provider_event_effects_command_unique",
      "identity.account_claim_ready.v1",
      "identity.account_claimed.v1",
      "onboarding.completed.v1",
      "COMMERCE_CLEANUP_NOT_ACTIVE",
    ];
    for (const required of requiredSql) expect(migration).toContain(required);
  });
});
