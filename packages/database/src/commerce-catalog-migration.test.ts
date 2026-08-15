import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function loadCommerceMigration(): Promise<string | null> {
  return readFile(new URL("../drizzle/0014_commerce_catalog.sql", import.meta.url), "utf8")
    .catch(() => null);
}

describe("0014 Commerce catalog migration contract", () => {
  it("preserves both frozen upstream authorities before appending 0014", async () => {
    const [implementation, certificates] = await Promise.all([
      readFile(new URL("../drizzle/0012_implementation.sql", import.meta.url), "utf8"),
      readFile(new URL("../drizzle/0013_certificates.sql", import.meta.url), "utf8"),
    ]);
    expect(createHash("sha256").update(implementation).digest("hex"))
      .toBe("dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9");
    expect(createHash("sha256").update(certificates).digest("hex"))
      .toBe("878a759f41c44e0cbb9cf7492889bdf4d6f0ab087f0e9d7b26865f988fbe1bd9");

    const sql = await loadCommerceMigration();
    expect(sql, "0014 Commerce catalog migration must exist").not.toBeNull();
  });

  it("adds exactly the bounded 0014 roots and forward extensions", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    expect([...sql.matchAll(/CREATE TABLE public\.([a-z][a-z0-9_]+)/gu)]
      .map((match) => match[1])).toEqual([
      "offers",
      "offer_catalog_versions",
      "offer_price_bindings",
      "checkout_authorizations",
      "checkout_sessions",
      "checkout_provider_actions",
      "public_business_os_setup_intents",
      "stripe_customer_creation_actions",
      "business_os_setup_epochs",
      "recurring_purchase_intents",
      "stripe_customers",
      "purchases",
      "public_business_os_setup_fulfillments",
      "purchase_payment_allocations",
      "subscriptions",
      "subscription_schedules",
      "invoices",
      "invoice_line_allocations",
      "controlled_payment_authorizations",
      "claim_tokens",
      "pending_claim_sessions",
      "secure_link_deliveries",
      "account_onboarding",
      "account_onboarding_priorities",
      "provider_event_processing",
      "provider_event_attempts",
      "provider_event_effects",
    ]);
    expect(sql).toContain("ALTER TABLE public.accounts ADD COLUMN name_status");
    expect(sql).toContain("ALTER TABLE public.provider_event_receipts");
    expect(sql).toContain("payload='{}'::jsonb");
    expect(sql).toContain("account_course_accesses_active_source_course_unique");
    expect(sql).toContain("public_bos_setup_fulfillments_intent_fk");
    expect(sql).toContain("public_bos_setup_fulfillments_epoch_fk");
    expect(sql).toContain("public_bos_setup_fulfillments_purchase_fk");
    expect(sql).toContain("public_bos_setup_fulfillments_source_fk");
    expect(sql).toContain("public_bos_setup_fulfillments_receipt_fk");
    expect(sql).toContain("provider_event_receipts_fulfillment_owner_unique");
    for (const constraint of [
      "offers_current_catalog_exact_fk",
      "checkout_authorizations_public_intent_fk",
      "checkout_authorizations_price_provider_fk",
      "checkout_authorizations_setup_epoch_fk",
      "checkout_authorizations_recurring_intent_fk",
      "checkout_sessions_authorization_id_fk",
      "checkout_sessions_authorization_provider_fk",
      "checkout_provider_actions_authorization_id_fk",
      "checkout_provider_actions_authorization_provider_fk",
      "checkout_provider_actions_session_result_fk",
      "purchases_authorization_fk",
      "purchases_authorization_provider_fk",
      "purchase_payment_allocations_purchase_provider_fk",
      "business_os_setup_epochs_price_provider_fk",
      "recurring_purchase_intents_price_provider_fk",
      "recurring_purchase_intents_setup_purchase_fk",
      "stripe_customers_creation_action_provider_fk",
      "stripe_customers_checkout_result_fk",
      "stripe_customers_public_intent_fk",
      "subscriptions_recurring_intent_provider_fk",
      "subscriptions_customer_provider_fk",
      "subscriptions_price_provider_fk",
      "subscription_schedules_intent_provider_fk",
      "subscription_schedules_subscription_provider_fk",
      "invoices_subscription_provider_fk",
      "invoice_line_allocations_invoice_provider_fk",
      "invoice_line_allocations_price_provider_fk",
      "controlled_payment_authorizations_price_provider_fk",
      "controlled_payment_authorizations_checkout_provider_fk",
      "secure_link_deliveries_claim_account_fk",
      "secure_link_deliveries_invitation_account_fk",
      "secure_link_deliveries_controlled_payment_fk",
      "provider_event_processing_receipt_owner_fk",
      "provider_event_attempts_processing_fence_fk",
    ]) expect(sql).toContain(constraint);
    expect(sql).toContain(
      "'provider_call_pending','checkout_open','setup_succeeded','schedule_pending','subscription_pending','active','grace','cancellation_pending','terminal_cancelled','terminal_expired','terminal_refunded','terminal_revoked','abandoned'",
    );
    expect(sql).toContain("recurring_purchase_intents_offer_topology_check");
  });

  it("freezes exact ordinary catalog money and forbids browser price authority", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    for (const [role, amount] of [
      ["self_paced_once", "39900"],
      ["guided_pilot_once", "75000"],
      ["operator_club_monthly", "5900"],
      ["operator_club_annual", "59000"],
      ["business_os_setup", "99900"],
      ["business_os_monthly", "19900"],
    ]) {
      expect(sql).toContain(`'${role}'`);
      expect(sql).toContain(amount);
    }
    expect(sql).toContain("offer_price_bindings_role_shape_check");
    expect(sql).toMatch(/currency"?\s*=\s*'usd'/u);
    expect(sql).toMatch(/quantity"?\s*=\s*1/u);
  });

  it("keeps cleanup fail-closed until 0016 and preserves certificate non-authority", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    expect(sql).toContain("syntholo_cleanup_public_bos_intents_v1");
    expect(sql).toContain("COMMERCE_CLEANUP_NOT_ACTIVE");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.syntholo_cleanup_public_bos_intents_v1",
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.syntholo_cleanup_public_bos_intents_v1[^;]* TO syntholo_worker/gu,
    );
    expect(sql).not.toMatch(/REFERENCES public\.certificate_/gu);
    expect(sql).toContain("certificateNonAuthority=true");
  });

  it("closes raw table authority and preserves exact upstream/runtime readiness", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    const tables = [...sql.matchAll(/CREATE TABLE public\.([a-z][a-z0-9_]+)/gu)]
      .map((match) => match[1]!);
    for (const table of tables) {
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain("ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE public.%I FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.syntholo_attest_runtime_capability");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.syntholo_certificates_readiness_v1");
    expect(sql).toContain("CREATE FUNCTION public.syntholo_commerce_catalog_readiness_v1");
    expect(sql).toContain("syntholo_implementation_seed_workspace_v1(uuid)");
    expect(sql).toContain("syntholo_record_public_business_os_setup_reconciliation");
    expect(sql).toContain("commerce_reconciliations_business_os_reason_kind_check");
    for (const reason of [
      "STRIPE_CUSTOMER_OWNERSHIP_COLLISION",
      "PAID_CLAIM_IDENTITY_CONFLICT",
      "PAID_IDENTITY_STATE_STALE",
      "PAID_SEMANTIC_CONFLICT",
    ]) expect(sql).toContain(reason);
    expect(sql).toContain("public.syntholo_begin_entitlement_command");
    expect(sql).toContain("public.syntholo_finish_entitlement_command");
    expect(sql).toContain("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC");
    expect(sql.match(
      /GRANT (?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]* TO syntholo_(?:member_api|staff_api|worker);/gu,
    )).toEqual([
      "GRANT UPDATE(name,name_status,updated_at) ON public.accounts TO syntholo_member_api;",
    ]);
  });

  it("makes the Stripe envelope immutable and keeps mutable processing separately fenced", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    for (const column of [
      "event_type",
      "livemode",
      "api_version",
      "provider_created_at",
      "data_object_type",
      "data_object_id",
      "receiver_stripe_account_id",
      "event_account",
      "event_context",
      "raw_body_sha256",
    ]) expect(sql).toContain(column);
    expect(sql).toContain("provider_event_receipts_stripe_envelope_check");
    expect(sql).toContain("provider_event_receipts_stripe_immutable");
    expect(sql).toContain("ALTER TABLE public.provider_event_receipts ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE public.provider_event_receipts FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("CREATE POLICY provider_event_receipts_migrator");
    expect(sql).toContain("provider_event_processing");
    expect(sql).toContain("provider_event_attempts");
    expect(sql).toContain("provider_event_effects_receipt_effect_target_unique");
    expect(sql).toContain("provider_event_effects_receipt_owner_fk");
    expect(sql).toContain("failed_terminal");
    expect(sql).toContain("failed_retryable");
    expect(sql).toContain("payload='{}'::jsonb");
    expect(sql).toContain("provider_event_processing_fence_check");
    expect(sql).toContain("provider_event_processing_time_check");
    expect(sql).toContain("provider_event_processing_text_check");
    expect(sql).toContain("provider_event_attempts_finish_check");
    const recordEventBody = sql.match(
      /CREATE FUNCTION public\.syntholo_commerce_record_provider_event_v1\([\s\S]*?\$record_event\$;/u,
    )?.[0];
    expect(recordEventBody).toBeDefined();
    expect(recordEventBody).not.toContain("OR p_api_version IS NULL");
    expect(recordEventBody).toContain(
      "p_api_version IS DISTINCT FROM p_expected_api_version",
    );
    expect(recordEventBody).toContain("p_event_object_valid boolean");
    expect(recordEventBody).toContain("event_object_mismatch");
    expect(recordEventBody).toContain(
      "context_mismatch OR NOT p_event_object_valid",
    );
  });

  it("extends Task 8 with only the four approved public Business OS reconciliation reasons", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    expect(sql).toContain("commerce_reconciliations_business_os_reason_kind_check");
    expect(sql).toContain(
      "syntholo_record_public_business_os_setup_reconciliation",
    );
    for (const reason of [
      "STRIPE_CUSTOMER_OWNERSHIP_COLLISION",
      "PAID_CLAIM_IDENTITY_CONFLICT",
      "PAID_IDENTITY_STATE_STALE",
      "PAID_SEMANTIC_CONFLICT",
    ]) expect(sql).toContain(reason);
    expect(sql).toContain("public.syntholo_begin_entitlement_command");
    expect(sql).toContain("public.syntholo_finish_entitlement_command");
  });

  it("guards every new row behind exact closed transitions and keeps cleanup deletion disabled", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    const tables = [...sql.matchAll(/CREATE TABLE public\.([a-z][a-z0-9_]+)/gu)]
      .map((match) => match[1]!);
    expect(sql).toContain("CREATE FUNCTION public.syntholo_commerce_row_guard_v1");
    expect(sql).toContain("app.commerce_transition");
    expect(sql).toContain("app.commerce_cleanup_transition");
    expect(sql).toContain("COMMERCE_ROW_IMMUTABLE");
    expect(sql).toContain("COMMERCE_ACCOUNT_IMMUTABLE");
    for (const table of tables) {
      expect(sql).toContain(`CREATE TRIGGER ${table}_guard`);
    }
    const cleanup = sql.slice(sql.indexOf("CREATE FUNCTION public.syntholo_cleanup_public_bos_intents_v1"));
    expect(cleanup).not.toContain("set_config('app.commerce_cleanup_transition','active'");
  });

  it("serializes recurring reservations and records provider effects through closed replay-safe commands", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    expect(sql).toContain('"reservation_command_id" uuid NOT NULL');
    expect(sql).toContain('"reservation_request_hash" text NOT NULL');
    expect(sql).toContain(
      "recurring_purchase_intents_reservation_command_unique",
    );
    expect(sql).toContain(
      "recurring_purchase_intents_request_hash_check",
    );
    expect(sql).toContain("provider_event_effects_domain_target_unique");
    expect(sql).toContain(
      "CREATE FUNCTION public.syntholo_commerce_reserve_recurring_purchase_v1(",
    );
    expect(sql).toContain(
      "CREATE FUNCTION public.syntholo_commerce_record_provider_effect_v1(",
    );
    expect(sql).toContain("PERFORM public.syntholo_lock_entitlement_graph(p_account)");
    expect(sql).toContain(
      "WHEN p_family='business_os' THEN 'business_os_monthly'",
    );
    expect(sql).toContain("COMMERCE_RECURRING_RESERVATION_RECONCILIATION_REQUIRED");
    expect(sql).toContain("COMMERCE_PROVIDER_EFFECT_RECONCILIATION_REQUIRED");
    expect(sql).toContain("current_setting('app.actor_id',true)");
    expect(sql).toContain("processing.worker_id IS DISTINCT FROM actor_id");
    const effectStart = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_record_provider_effect_v1(",
    );
    const effectEnd = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_record_paid_purchase_v1(",
      effectStart,
    );
    const effect = sql.slice(effectStart, effectEnd);
    expect(effect).toContain("p_lease_token uuid");
    expect(effect).toContain("p_lease_generation integer");
    expect(effect).toContain(
      "processing.lease_token IS DISTINCT FROM p_lease_token",
    );
    expect(effect).toContain(
      "processing.lease_generation IS DISTINCT FROM p_lease_generation",
    );
    expect(effect).toContain("FROM public.provider_event_attempts attempt");
    expect(effect).toContain("attempt.outcome IS DISTINCT FROM 'processing'");
    expect(sql).toContain("set_config('app.commerce_transition','active',true)");
    for (const signature of [
      "public.syntholo_commerce_reserve_recurring_purchase_v1(",
      "public.syntholo_commerce_record_provider_effect_v1(",
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature}`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature}`);
    }
  });

  it("serializes owner-scoped Business OS setup before provider work", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    const start = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_reserve_existing_bos_setup_v1(",
    );
    const end = sql.indexOf("--> statement-breakpoint", start);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = sql.slice(start, end);
    expect(body).toContain("membership_row.role='owner'");
    expect(body).toContain("membership_row.status='active'");
    expect(body).toContain("hold.kind='commerce'");
    expect(body).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("business_os_setup_epochs_one_blocking_account");
    expect(body).toContain("'refund_pending','dispute_open'");
    expect(body).toContain("'/v1/member/checkouts'");
    expect(body).toContain("syntholo_commerce_stage_checkout_action_v1");
    expect(body).toContain("COMMERCE_EXISTING_BOS_SETUP_EXISTS");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.syntholo_commerce_reserve_existing_bos_setup_v1(",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.syntholo_commerce_reserve_existing_bos_setup_v1(",
    );
  });

  it("reserves anonymous Self-Paced without creating account authority", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;
    const start = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_reserve_public_self_paced_v1(",
    );
    const end = sql.indexOf("--> statement-breakpoint", start);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = sql.slice(start, end);
    expect(body).toContain("'/v1/public/checkouts'");
    expect(body).toContain("offer.code='self_paced'");
    expect(body).toContain("binding.price_role='self_paced_once'");
    expect(body).toContain("catalog_version.content_readiness_hash");
    expect(body).toContain("p_business_name_content_hash");
    expect(body).toContain("NULL,'anonymous'");
    expect(body).not.toContain("INSERT INTO public.accounts");
    expect(body).not.toContain("INSERT INTO public.memberships");
    expect(body).not.toContain("INSERT INTO public.entitlement_grants");
  });

  it("creates public Self-Paced authority only from the signed paid lease", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;
    const start = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_record_public_self_paced_paid_v1(",
    );
    const end = sql.indexOf("--> statement-breakpoint", start);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = sql.slice(start, end);
    expect(body).toContain("syntholo_commerce_record_provider_effect_v1");
    expect(body).toContain("public.syntholo_account_name_is_canonical");
    expect(body).toContain("business_name_content_hash");
    expect(body).toContain("INSERT INTO public.accounts");
    expect(body).toContain("'provisional'");
    expect(body).toContain("public.syntholo_fulfill_product");
    expect(body).toContain("INSERT INTO public.account_course_accesses");
    expect(body).toContain("syntholo_implementation_seed_workspace_v1");
    expect(body).toContain("INSERT INTO public.claim_tokens");
    expect(body).toContain("interval '168 hours'");
    expect(body).toContain("INSERT INTO public.secure_link_deliveries");
    expect(body).toContain("'identity.account_claim_ready.v1'");
    expect(body).not.toContain("'identity.claim_created.v1'");
    expect(body).not.toContain("INSERT INTO public.memberships");
    expect(body).not.toContain("INSERT INTO public.enrollments");
  });

  it("creates public Business OS authority only after the signed paid setup", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;
    const start = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_record_public_bos_setup_paid_v1(",
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const end = sql.indexOf("--> statement-breakpoint", start);
    const body = sql.slice(start, end);
    expect(body).toContain("INSERT INTO public.accounts");
    expect(body).toContain("'provisional'");
    expect(body).toContain("INSERT INTO public.business_os_setup_epochs");
    expect(body).toContain("INSERT INTO public.stripe_customers");
    expect(body).toContain("INSERT INTO public.purchases");
    expect(body).toContain("INSERT INTO public.public_business_os_setup_fulfillments");
    expect(body).toContain("public.syntholo_record_business_os_setup_purchase");
    expect(body).toContain("public.syntholo_record_public_business_os_setup_reconciliation");
    expect(body).toContain("INSERT INTO public.claim_tokens");
    expect(body).not.toContain("INSERT INTO public.entitlement_grants");
    expect(body).not.toContain("INSERT INTO public.enrollments");
  });

  it("keeps raw claim material outside SQL while atomically establishing the owner", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;
    const initiateStart = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_initiate_claim_v1(",
    );
    const initiateEnd = sql.indexOf("--> statement-breakpoint", initiateStart);
    const redeemStart = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_redeem_claim_v1(",
    );
    const redeemEnd = sql.indexOf("--> statement-breakpoint", redeemStart);
    expect(initiateStart).toBeGreaterThanOrEqual(0);
    expect(redeemStart).toBeGreaterThanOrEqual(0);
    const initiate = sql.slice(initiateStart, initiateEnd);
    const redeem = sql.slice(redeemStart, redeemEnd);
    expect(initiate).toContain("p_claim_token_hash");
    expect(initiate).toContain("p_session_handle_hash");
    expect(initiate).not.toContain("p_raw_token");
    expect(redeem).toContain("public.syntholo_establish_owner");
    expect(redeem).toContain("INSERT INTO public.enrollments");
    expect(redeem).toContain("account_course_accesses");
    expect(redeem).toContain("email_fingerprint");
    expect(redeem).toContain("app.commerce_transition");
    expect(redeem).toContain("'identity.account_claimed.v1'");
    expect(redeem).not.toContain("name_status='confirmed'");
    expect(redeem).not.toContain("INSERT INTO public.entitlement_grants");
  });

  it("keeps onboarding resumable, owner-scoped, and product-state validating", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;
    const getStart = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_get_onboarding_v1(",
    );
    const saveStart = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_save_onboarding_v1(",
    );
    const completeStart = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_complete_onboarding_v1(",
    );
    expect(getStart).toBeGreaterThanOrEqual(0);
    expect(saveStart).toBeGreaterThanOrEqual(0);
    expect(completeStart).toBeGreaterThanOrEqual(0);
    const save = sql.slice(saveStart, completeStart);
    const complete = sql.slice(
      completeStart,
      sql.indexOf("--> statement-breakpoint", completeStart),
    );
    expect(save).toContain("p_expected_version");
    expect(save).toContain("role='owner'");
    expect(save).toContain("FOR UPDATE");
    expect(save).toContain("account_onboarding_priorities");
    expect(save).toContain("app.commerce_transition");
    expect(complete).toContain("/v1/member/onboarding/completions");
    expect(complete).toContain("public.account_course_accesses");
    expect(complete).toContain("public.enrollments");
    expect(complete).toContain("capability='business_os'");
    expect(complete).toContain("name_status='confirmed'");
    expect(complete).toContain("'onboarding.completed.v1'");
    expect(complete).not.toContain("INSERT INTO public.entitlement_grants");
    expect(complete).not.toContain("INSERT INTO public.enrollments");
  });

  it("binds the forward runtime capability replacement to its exact PostgreSQL body", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    const start = sql.indexOf(
      "CREATE OR REPLACE FUNCTION public.syntholo_attest_runtime_capability",
    );
    const bodyMarker = sql.indexOf("AS $fn$", start);
    const bodyStart = bodyMarker + "AS $fn$".length;
    const bodyEnd = sql.indexOf("$fn$;", bodyStart);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(bodyMarker).toBeGreaterThan(start);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const actual = createHash("sha256")
      .update(sql.slice(bodyStart, bodyEnd))
      .digest("hex");
    expect(sql).toContain(`body_hash='${actual}'`);
  });

  it("claims, fences, reclaims, and terminally acknowledges provider receipts", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    expect(sql).toContain(
      "CREATE FUNCTION public.syntholo_commerce_claim_provider_event_v1(",
    );
    expect(sql).toContain(
      "CREATE FUNCTION public.syntholo_commerce_finish_provider_event_v1(",
    );
    expect(sql).toContain("FOR UPDATE OF processing SKIP LOCKED");
    expect(sql).toContain("processing.lease_expires_at<=p_now");
    expect(sql).toContain("lease_expired");
    expect(sql).toContain("COMMERCE_PROVIDER_EVENT_FENCE_INVALID");
    expect(sql).toContain("COMMERCE_PROVIDER_EVENT_ACK_RECONCILIATION_REQUIRED");
    expect(sql).toContain("UPDATE public.provider_event_attempts attempt");
    expect(sql).toContain("set_config('app.commerce_transition','provider_event_processing',true)");
    expect(sql).toContain("set_config('app.commerce_transition','provider_event_attempts',true)");
  });

  it("records exact signed envelopes and durably terminalizes context drift", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    expect(sql).toContain(
      "CREATE FUNCTION public.syntholo_commerce_record_provider_event_v1(",
    );
    expect(sql).toContain("ON CONFLICT(provider,provider_event_id) DO NOTHING");
    expect(sql).toContain("raw_body_sha256 IS DISTINCT FROM p_raw_body_sha256");
    expect(sql).toContain("security_context_mismatch");
    expect(sql).toContain("security_envelope_mismatch");
    expect(sql).toContain("payload='{}'::jsonb");
    expect(sql).toContain(
      "REVOKE ALL ON public.provider_event_receipts FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker,syntholo_system_api",
    );
    expect(sql).not.toContain("raw_body bytea");
  });

  it("publishes only a complete verified catalog topology through closed functions", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;

    for (const constraint of [
      "offers_topology_check",
      "offer_catalog_versions_lifecycle_check",
      "offer_price_bindings_lifecycle_check",
    ]) expect(sql).toContain(constraint);
    expect(sql).toContain(
      "CREATE FUNCTION public.syntholo_commerce_stage_catalog_version_v1(",
    );
    expect(sql).toContain(
      "CREATE FUNCTION public.syntholo_commerce_stage_price_binding_v1(",
    );
    expect(sql).toContain(
      "CREATE FUNCTION public.syntholo_commerce_publish_catalog_version_v1(",
    );
    expect(sql).toContain("COMMERCE_CATALOG_BINDING_SET_INCOMPLETE");
    expect(sql).toContain("commerce-price-binding.v1");
    expect(sql).toContain("set_config('app.commerce_transition','offer_catalog_versions',true)");
    expect(sql).toContain("set_config('app.commerce_transition','offer_price_bindings',true)");
    expect(sql).toContain("set_config('app.commerce_transition','offers',true)");
    const publishStart = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_publish_catalog_version_v1(",
    );
    const publishEnd = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_reserve_recurring_purchase_v1(",
      publishStart,
    );
    const publish = sql.slice(publishStart, publishEnd);
    expect(publish).toContain(
      "evaluation.gate_hash=catalog.content_readiness_hash",
    );
    expect(publish).toContain(
      "approval.gate_hash=catalog.content_readiness_hash",
    );
    expect(publish).toContain("count(*) FILTER(WHERE lesson.required)=18");
  });

  it("stages exactly one stable checkout provider action before external work", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;
    expect(sql).toContain("checkout_provider_actions_identity_check");
    expect(sql).toContain("checkout_provider_actions_lifecycle_check");
    expect(sql).toContain(
      "CREATE FUNCTION public.syntholo_commerce_stage_checkout_action_v1(",
    );
    expect(sql).toContain("'checkout:'||p_authorization_id::text");
    expect(sql).toContain("'business_os_setup_checkout:'||action_id::text");
    expect(sql).toContain("COMMERCE_CHECKOUT_ACTION_RECONCILIATION_REQUIRED");
  });

  it("attaches one encrypted provider Session result through the staged action", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;
    expect(sql).toContain("checkout_sessions_provider_identity_check");
    expect(sql).toContain("checkout_sessions_time_check");
    expect(sql).toContain(
      "CREATE FUNCTION public.syntholo_commerce_record_checkout_session_v1(",
    );
    expect(sql).toContain("COMMERCE_CHECKOUT_SESSION_RECONCILIATION_REQUIRED");
    expect(sql).toContain(
      "set_config('app.commerce_transition','checkout_provider_actions',true)",
    );
    expect(sql).toContain(
      "set_config('app.commerce_transition','checkout_authorizations',true)",
    );
    expect(sql).toContain(
      "CREATE FUNCTION public.syntholo_commerce_begin_checkout_action_v1(",
    );
    expect(sql).toContain(
      "CREATE FUNCTION public.syntholo_commerce_finish_checkout_action_v1(",
    );
    expect(sql).toContain("COMMERCE_CHECKOUT_ACTION_IN_PROGRESS");
    expect(sql).toContain("action.updated_at<=p_now-interval '5 minutes'");
    expect(sql).toContain("COMMERCE_CHECKOUT_ACTION_FENCE_INVALID");
    const beginStart = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_begin_checkout_action_v1(",
    );
    const beginEnd = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_finish_checkout_action_v1(",
      beginStart,
    );
    const begin = sql.slice(beginStart, beginEnd);
    expect(begin).toContain("authorization.expires_at<=p_now");
    expect(begin).toContain("offer.state='enabled'");
    expect(begin).toContain("catalog.state='published'");
    expect(begin).toContain("binding.enabled_at IS NOT NULL");
    expect(begin).toContain("binding.retired_at IS NULL");
  });

  it("reserves one public Business OS setup guard before any account or provider call", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;
    expect(sql).toContain("checkout_authorizations_public_intent_unique");
    expect(sql).toContain(
      "CREATE FUNCTION public.syntholo_commerce_reserve_public_bos_setup_v1(",
    );
    expect(sql).toContain("commerce:public-bos-guard:");
    expect(sql).toContain("COMMERCE_PUBLIC_BOS_SETUP_EXISTS");
    expect(sql).toContain(
      "public.syntholo_commerce_stage_checkout_action_v1(",
    );
    expect(sql).toContain("account_id,principal_kind,principal_id");
  });

  it("records a signed paid one-time purchase and delegates grants only to Task 8", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;
    expect(sql).toContain(
      "CREATE FUNCTION public.syntholo_commerce_record_paid_purchase_v1(",
    );
    expect(sql).toContain("public.syntholo_commerce_record_provider_effect_v1(");
    expect(sql).toContain("public.syntholo_fulfill_product(");
    expect(sql).toContain("receipt.event_type IN(");
    expect(sql).toContain("INSERT INTO public.purchases(");
    expect(sql).toContain("INSERT INTO public.purchase_payment_allocations(");
    expect(sql).toContain(
      "set_config('app.commerce_transition','checkout_sessions',true)",
    );
    expect(sql).toContain("COMMERCE_PAID_PURCHASE_RECONCILIATION_REQUIRED");
    const paidStart = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_record_paid_purchase_v1(",
    );
    const paidEnd = sql.indexOf(
      "CREATE FUNCTION public.syntholo_commerce_initiate_claim_v1(",
      paidStart,
    );
    const paid = sql.slice(paidStart, paidEnd);
    expect(paid).toContain("INSERT INTO public.account_course_accesses(");
    expect(paid).toContain(
      "public.syntholo_implementation_seed_workspace_v1(account_course_access_id)",
    );
    expect(paid).not.toContain("INSERT INTO public.enrollments(");
  });

  it("pins every Commerce authority function to its exact source body", async () => {
    const sql = await loadCommerceMigration();
    expect(sql).not.toBeNull();
    if (sql === null) return;
    const expected = {
      syntholo_provider_event_receipts_stripe_immutable_v1: "444d0c5cb038bfb522f7b91607fb28bf3aadbc80311ce50d42a324bd99a5a518",
      syntholo_record_public_business_os_setup_reconciliation: "b7a277470973e026322d28e4de58a32e72d34f9d17dd69dc9359d17c9ba829d5",
      syntholo_commerce_row_guard_v1: "700499bb1b84f649141bb2443e6a657631f02c3ecf3d5466fdf624bb28558cb8",
      syntholo_commerce_stage_checkout_action_v1: "471b41e4706cffffcb5c014c948ef193b2bd2277ace6e275d1f76cb7952535f3",
      syntholo_commerce_reserve_public_bos_setup_v1: "259ae81ef9c431c2471ad6eca664f1c7d9d38e0a51af58779da9b66148dd760e",
      syntholo_commerce_reserve_public_self_paced_v1: "521cc12ebe31d2ba2256cffa35b588c833f2623f216d6c84cc8552c684184253",
      syntholo_commerce_reserve_existing_bos_setup_v1: "0f9e5fd80465c12f1034c7583c6f58caef1f2d4e079c22a1b264e0d682206e05",
      syntholo_commerce_begin_checkout_action_v1: "a7500bb43a35564bb9f38499705b911ba4e5222f6f18cc62211d2548cf418672",
      syntholo_commerce_finish_checkout_action_v1: "d234d915cff09246a901b0553af71a8b0ff44ed5ba12e56d653a3ea7a99a8279",
      syntholo_commerce_record_checkout_session_v1: "8ed50ecda7fa2fb10d9153dfe1992d4538bf9b06632243b1f4343502a7b36561",
      syntholo_commerce_stage_catalog_version_v1: "796911b9b66e3bc48a32a1bd15831c67890cf06e496b0ad302f25a2ad9fa2909",
      syntholo_commerce_stage_price_binding_v1: "4bf91e836e02f42f500e377fab2fe90378637b79b55402569720558c79384681",
      syntholo_commerce_publish_catalog_version_v1: "2a387675b3c0e53c94397a685af8dc82d8917a6330fc882364696d9ca2f9dca4",
      syntholo_commerce_reserve_recurring_purchase_v1: "f8f0b73a25a6d0ebcb89649f719d7c725ed920d06bbd1a478741241d4a8eb2b8",
      syntholo_commerce_record_provider_effect_v1: "be362f555e6e9b1b4e347908938bb833a64d663af5325e39c189091fd2b48b92",
      syntholo_commerce_record_paid_purchase_v1: "d2174d1439023e878f66d141bfcc4df1f7b0829db2172fd3281458d090a8c42e",
      syntholo_commerce_record_public_self_paced_paid_v1: "b0bf40a1d6c569273bc3b8ecadf6b0cfd1432a56a700104c3ed00e3b6514e702",
      syntholo_commerce_record_public_bos_setup_paid_v1: "f95607c360705dceeddb5b3f7e696c46b8091ee1bfa002bebb32df943128a87a",
      syntholo_commerce_initiate_claim_v1: "bb7b220de986d73107aa1dcd0ae051613347a076e39a111bfd04e12fc87f84c8",
      syntholo_commerce_redeem_claim_v1: "4e448a420f62db77d1e73556718f60a6ed1fe2d10832b698df7d1b37d26ad4f4",
      syntholo_commerce_get_onboarding_v1: "d67866b0e83a245a7baa4618a48b28e0b35a406def0880a533fae4711b3594bf",
      syntholo_commerce_save_onboarding_v1: "70e6ff74216e1488df9a9ff8059a5243266bbcba1c05ee7f128909aadce07c75",
      syntholo_commerce_complete_onboarding_v1: "7d8c78c7e0f27c9147926135db89fb5e363a50258938d0b14ede1ec01423ba07",
      syntholo_commerce_record_provider_event_v1: "743fe1b5ebf358dec732d172c1d8d21a23fb227b839da196119d81526e9620b9",
      syntholo_commerce_claim_provider_event_v1: "9e165fcbc36ecb60c9d878450705871bb4e3e9b2b10e33dc76bcf3984b6e64e8",
      syntholo_commerce_finish_provider_event_v1: "99fd9bf36bc50af2b6c584cc7462f48ddfc00aa931f84a8ca4367573ab2928ce",
      syntholo_cleanup_public_bos_intents_v1: "fbe3c7e935d8514a8d6bf2cc3e30234f63055a5dbd65d8b3f7791ef3c76efce8",
      syntholo_commerce_catalog_readiness_v1: "024a01a9076b44baf72488483768a02d7212479d8a0124945f027fcfe97d604e",
    } as const;
    const actual: Record<string, string> = {};
    for (const statement of sql.split("--> statement-breakpoint")) {
      const functionName = statement.match(
        /CREATE(?: OR REPLACE)? FUNCTION public\.(syntholo_[a-z0-9_]+)\s*\(/u,
      )?.[1];
      if (functionName === undefined || !(functionName in expected)) continue;
      const bodyMarker = [...statement.matchAll(/AS (\$[a-z0-9_]*\$)/gu)].at(-1);
      expect(bodyMarker, functionName).toBeDefined();
      if (bodyMarker === undefined) continue;
      const bodyStart = (bodyMarker.index ?? 0) + bodyMarker[0].length;
      const bodyEnd = statement.indexOf(bodyMarker[1]!, bodyStart);
      actual[functionName] = createHash("sha256")
        .update(statement.slice(bodyStart, bodyEnd))
        .digest("hex");
    }
    expect(actual).toEqual(expected);
  });
});
