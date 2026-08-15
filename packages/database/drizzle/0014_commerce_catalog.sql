ALTER TABLE public.accounts ADD COLUMN name_status text;
UPDATE public.accounts SET name_status='confirmed';
SET CONSTRAINTS accounts_owner_valid IMMEDIATE;
SET CONSTRAINTS accounts_owner_valid DEFERRED;
ALTER TABLE public.accounts ALTER COLUMN name_status SET DEFAULT 'confirmed';
ALTER TABLE public.accounts ALTER COLUMN name_status SET NOT NULL;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_name_status_check
  CHECK(name_status IN('provisional','confirmed'));
GRANT UPDATE(name,name_status,updated_at) ON public.accounts TO syntholo_member_api;
--> statement-breakpoint
DO $preflight$
BEGIN
  IF EXISTS(SELECT 1 FROM public.provider_event_receipts WHERE provider='stripe') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_LEGACY_STRIPE_RECEIPT_UNSAFE';
  END IF;
END $preflight$;
--> statement-breakpoint
ALTER TABLE public.provider_event_receipts
  ADD COLUMN event_type text,
  ADD COLUMN livemode boolean,
  ADD COLUMN api_version text,
  ADD COLUMN provider_created_at timestamptz(3),
  ADD COLUMN data_object_type text,
  ADD COLUMN data_object_id text,
  ADD COLUMN receiver_stripe_account_id text,
  ADD COLUMN event_account text,
  ADD COLUMN event_context text,
  ADD COLUMN raw_body_sha256 text;
ALTER TABLE public.provider_event_receipts
  ADD CONSTRAINT provider_event_receipts_stripe_envelope_check CHECK(
    provider<>'stripe' OR (
      event_type IS NOT NULL AND octet_length(event_type) BETWEEN 1 AND 128
      AND livemode IS NOT NULL
      AND (api_version IS NULL OR octet_length(api_version) BETWEEN 1 AND 64)
      AND provider_created_at IS NOT NULL
      AND provider_created_at=date_trunc('milliseconds',provider_created_at)
      AND data_object_type IS NOT NULL AND octet_length(data_object_type) BETWEEN 1 AND 128
      AND data_object_id IS NOT NULL AND octet_length(data_object_id) BETWEEN 1 AND 255
      AND receiver_stripe_account_id IS NOT NULL
      AND octet_length(receiver_stripe_account_id) BETWEEN 1 AND 255
      AND (event_account IS NULL OR octet_length(event_account) BETWEEN 1 AND 255)
      AND (event_context IS NULL OR octet_length(event_context) BETWEEN 1 AND 255)
      AND raw_body_sha256~'^[0-9a-f]{64}$'
      AND status='received' AND payload='{}'::jsonb
    )
  );
ALTER TABLE public.provider_event_receipts
  ADD CONSTRAINT provider_event_receipts_fulfillment_owner_unique
  UNIQUE(id,provider,receiver_stripe_account_id);
--> statement-breakpoint
CREATE FUNCTION public.syntholo_provider_event_receipts_stripe_immutable_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $f$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='COMMERCE_PROVIDER_EVENT_ENVELOPE_IMMUTABLE';
  END IF;
  IF OLD.provider='stripe' OR (TG_OP='UPDATE' AND NEW.provider='stripe') THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='COMMERCE_PROVIDER_EVENT_ENVELOPE_IMMUTABLE';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $f$;
REVOKE ALL ON FUNCTION public.syntholo_provider_event_receipts_stripe_immutable_v1() FROM PUBLIC;
CREATE TRIGGER provider_event_receipts_stripe_immutable
  BEFORE UPDATE OR DELETE ON public.provider_event_receipts
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_provider_event_receipts_stripe_immutable_v1();
CREATE TRIGGER provider_event_receipts_truncate_denied
  BEFORE TRUNCATE ON public.provider_event_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_provider_event_receipts_stripe_immutable_v1();
ALTER TABLE public.provider_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_event_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_event_receipts_migrator
  ON public.provider_event_receipts FOR ALL TO syntholo_migrator
  USING(true) WITH CHECK(true);
--> statement-breakpoint
ALTER TABLE public.commerce_reconciliations
  ADD CONSTRAINT commerce_reconciliations_business_os_reason_kind_check
  CHECK(
    command_kind<>'business_os_setup_paid'
    OR (
      incident_kind='provider_source_collision'
      AND reason_code IN(
        'SOURCE_RECONCILIATION_REQUIRED',
        'STRIPE_CUSTOMER_OWNERSHIP_COLLISION'
      )
    )
    OR (
      incident_kind='parked_paid_receipt'
      AND reason_code IN(
        'BUSINESS_OS_SETUP_RECONCILIATION_REQUIRED',
        'BUSINESS_OS_SETUP_EPOCH_RECONCILIATION_REQUIRED',
        'PAID_CLAIM_IDENTITY_CONFLICT',
        'PAID_IDENTITY_STATE_STALE',
        'PAID_SEMANTIC_CONFLICT'
      )
    )
  );
--> statement-breakpoint
CREATE FUNCTION public.syntholo_record_public_business_os_setup_reconciliation(
  p_account uuid,
  p_command uuid,
  p_input_hash text,
  p_source_id text,
  p_purchased_at timestamptz,
  p_reconciliation_reason text,
  p_now timestamptz
)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $reconciliation$
DECLARE
  v_command_state record;
  v_source_registry_id uuid:=gen_random_uuid();
  v_reconciliation_id uuid;
  v_reconciliation_status text;
  v_reconciliation_created boolean;
  v_incident_kind text;
  v_result_value jsonb;
BEGIN
  IF p_account IS NULL OR p_command IS NULL OR p_input_hash IS NULL
    OR p_input_hash!~'^[0-9a-f]{64}$'
    OR p_source_id IS NULL OR octet_length(p_source_id) NOT BETWEEN 1 AND 255
    OR p_purchased_at IS NULL OR NOT isfinite(p_purchased_at)
    OR p_purchased_at<>date_trunc('milliseconds',p_purchased_at)
    OR p_purchased_at<'2000-01-01 00:00:00+00'::timestamptz
    OR p_purchased_at>='10000-01-01 00:00:00+00'::timestamptz
    OR p_reconciliation_reason NOT IN(
      'STRIPE_CUSTOMER_OWNERSHIP_COLLISION',
      'PAID_CLAIM_IDENTITY_CONFLICT',
      'PAID_IDENTITY_STATE_STALE',
      'PAID_SEMANTIC_CONFLICT'
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE='22023',
      MESSAGE='SYNTHOLO_PUBLIC_BUSINESS_OS_RECONCILIATION_INPUT_INVALID';
  END IF;

  PERFORM public.syntholo_lock_entitlement_graph(p_account);
  PERFORM pg_advisory_xact_lock(hashtextextended('purchase:'||p_source_id,0));
  SELECT * INTO v_command_state
  FROM public.syntholo_begin_entitlement_command(
    p_account,p_command,'business_os_setup_paid',p_input_hash,p_now,
    'syntholo_system_api'
  );

  IF v_command_state.replayed THEN
    replayed:=true;
    outcome:=v_command_state.outcome;
    result:=v_command_state.result;
    RETURN NEXT;
    RETURN;
  END IF;

  IF EXISTS(
    SELECT 1 FROM public.entitlement_sources source
    WHERE source.source_kind='purchase' AND source.source_id=p_source_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE='23505',
      MESSAGE='SYNTHOLO_PUBLIC_BUSINESS_OS_SOURCE_CONFLICT';
  END IF;

  v_incident_kind:=CASE
    WHEN p_reconciliation_reason='STRIPE_CUSTOMER_OWNERSHIP_COLLISION'
      THEN 'provider_source_collision'
    ELSE 'parked_paid_receipt'
  END;

  INSERT INTO public.entitlement_sources(
    id,account_id,source_kind,source_id,offer_code,
    academy_source_registry_id,provenance,created_at
  ) VALUES(
    v_source_registry_id,p_account,'purchase',p_source_id,'business_os',NULL,
    'commerce-public-business-os-setup-reconciliation',p_purchased_at
  );

  SELECT opened.reconciliation_id,opened.reconciliation_status,opened.created
  INTO v_reconciliation_id,v_reconciliation_status,v_reconciliation_created
  FROM public.syntholo_open_commerce_reconciliation(
    p_account,'business_os_setup_paid','purchase',p_source_id,p_input_hash,
    p_reconciliation_reason,v_incident_kind,v_source_registry_id,NULL,p_now
  ) AS opened;

  INSERT INTO public.business_os_setup_receipts(
    source_registry_id,account_id,reconciliation_id,status,created_at,updated_at
  ) VALUES(
    v_source_registry_id,p_account,v_reconciliation_id,'paid_reconciliation',
    p_purchased_at,p_now
  );

  v_result_value:=jsonb_build_object(
    'sourceRegistryId',v_source_registry_id,
    'reconciliationId',v_reconciliation_id,
    'reconciliationStatus',v_reconciliation_status,
    'reconciliationRequired',v_reconciliation_created,
    'receiptStatus','paid_reconciliation',
    'setupKind',CASE
      WHEN v_incident_kind='provider_source_collision' THEN 'provider_collision'
      ELSE 'parked_receipt'
    END,
    'reasonCode',p_reconciliation_reason
  );

  PERFORM public.syntholo_finish_entitlement_command(
    p_account,p_command,'business_os_setup_paid','applied',v_result_value,
    'business_os:setup',p_reconciliation_reason,'{}'::uuid[],p_now
  );
  replayed:=false;
  outcome:='applied';
  result:=v_result_value;
  RETURN NEXT;
END
$reconciliation$;
REVOKE ALL ON FUNCTION public.syntholo_record_public_business_os_setup_reconciliation(
  uuid,uuid,text,text,timestamptz,text,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_record_public_business_os_setup_reconciliation(
  uuid,uuid,text,text,timestamptz,text,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE TABLE public.offers (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"family" text NOT NULL,
	"purchase_model" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"display_currency" text DEFAULT 'usd' NOT NULL,
	"display_unit_amount" integer NOT NULL,
	"display_recurring_unit_amount" integer,
	"readiness_policy" text NOT NULL,
	"current_catalog_version_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "offers_code_unique" UNIQUE("code"),
	CONSTRAINT "offers_id_code_unique" UNIQUE("id","code"),
	CONSTRAINT "offers_code_check" CHECK ("offers"."code" in ('scorecard','self_paced','guided_pilot','operator_club_monthly','operator_club_annual','business_os')),
	CONSTRAINT "offers_family_check" CHECK ("offers"."family" in ('scorecard','academy','operator_club','business_os')),
	CONSTRAINT "offers_purchase_model_check" CHECK ("offers"."purchase_model" in ('free','one_time','recurring','two_stage')),
	CONSTRAINT "offers_state_check" CHECK ("offers"."state" in ('draft','waitlist','enabled','paused')),
	CONSTRAINT "offers_money_check" CHECK ("offers"."display_currency"='usd' and "offers"."display_unit_amount">=0 and ("offers"."display_recurring_unit_amount" is null or "offers"."display_recurring_unit_amount">0)),
	CONSTRAINT "offers_topology_check" CHECK (
    ("offers"."code"='scorecard' and "offers"."family"='scorecard' and "offers"."purchase_model"='free' and "offers"."display_unit_amount"=0 and "offers"."display_recurring_unit_amount" is null)
    or ("offers"."code"='self_paced' and "offers"."family"='academy' and "offers"."purchase_model"='one_time' and "offers"."display_unit_amount"=39900 and "offers"."display_recurring_unit_amount" is null)
    or ("offers"."code"='guided_pilot' and "offers"."family"='academy' and "offers"."purchase_model"='one_time' and "offers"."display_unit_amount"=75000 and "offers"."display_recurring_unit_amount" is null)
    or ("offers"."code"='operator_club_monthly' and "offers"."family"='operator_club' and "offers"."purchase_model"='recurring' and "offers"."display_unit_amount"=5900 and "offers"."display_recurring_unit_amount" is null)
    or ("offers"."code"='operator_club_annual' and "offers"."family"='operator_club' and "offers"."purchase_model"='recurring' and "offers"."display_unit_amount"=59000 and "offers"."display_recurring_unit_amount" is null)
    or ("offers"."code"='business_os' and "offers"."family"='business_os' and "offers"."purchase_model"='two_stage' and "offers"."display_unit_amount"=99900 and "offers"."display_recurring_unit_amount"=19900)
  )
);
--> statement-breakpoint
CREATE TABLE public.offer_catalog_versions (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"offer_code" text NOT NULL,
	"version" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"policy_versions" jsonb NOT NULL,
	"content_readiness_hash" text,
	"catalog_hash" text NOT NULL,
	"published_at" timestamp (3) with time zone,
	"retired_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "offer_catalog_versions_offer_version_unique" UNIQUE("offer_id","version"),
	CONSTRAINT "offer_catalog_versions_exact_unique" UNIQUE("id","offer_id","offer_code","version"),
	CONSTRAINT "offer_catalog_versions_current_owner_unique" UNIQUE("id","offer_id","offer_code"),
	CONSTRAINT "offer_catalog_versions_state_check" CHECK ("offer_catalog_versions"."state" in ('draft','published','retired')),
	CONSTRAINT "offer_catalog_versions_hash_check" CHECK ("offer_catalog_versions"."catalog_hash"~'^[0-9a-f]{64}$' and ("offer_catalog_versions"."content_readiness_hash" is null or "offer_catalog_versions"."content_readiness_hash"~'^[0-9a-f]{64}$')),
	CONSTRAINT "offer_catalog_versions_policy_check" CHECK (jsonb_typeof("offer_catalog_versions"."policy_versions")='object'),
	CONSTRAINT "offer_catalog_versions_lifecycle_check" CHECK (
    ("offer_catalog_versions"."state"='draft' and "offer_catalog_versions"."published_at" is null and "offer_catalog_versions"."retired_at" is null)
    or ("offer_catalog_versions"."state"='published' and "offer_catalog_versions"."published_at" is not null and "offer_catalog_versions"."retired_at" is null)
    or ("offer_catalog_versions"."state"='retired' and "offer_catalog_versions"."published_at" is not null and "offer_catalog_versions"."retired_at" is not null and "offer_catalog_versions"."retired_at">="offer_catalog_versions"."published_at")
  )
);
--> statement-breakpoint
CREATE TABLE public.offer_price_bindings (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"offer_code" text NOT NULL,
	"catalog_version_id" uuid NOT NULL,
	"catalog_version" text NOT NULL,
	"environment" text NOT NULL,
	"stripe_account_id" text NOT NULL,
	"stripe_product_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"price_role" text NOT NULL,
	"product_tax_code" text NOT NULL,
	"currency" text NOT NULL,
	"unit_amount" integer NOT NULL,
	"recurring_interval" text,
	"interval_count" integer,
	"tax_behavior" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"fingerprint" text NOT NULL,
	"verified_at" timestamp (3) with time zone NOT NULL,
	"enabled_at" timestamp (3) with time zone,
	"retired_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "offer_price_bindings_exact_unique" UNIQUE("id","offer_id","catalog_version_id","environment"),
	CONSTRAINT "offer_price_bindings_authorization_owner_unique" UNIQUE("id","offer_id","catalog_version_id"),
	CONSTRAINT "offer_price_bindings_catalog_environment_owner_unique" UNIQUE("id","catalog_version_id","environment"),
	CONSTRAINT "offer_price_bindings_provider_owner_unique" UNIQUE("id","offer_id","catalog_version_id","environment","stripe_account_id"),
	CONSTRAINT "offer_price_bindings_catalog_provider_owner_unique" UNIQUE("id","catalog_version_id","environment","stripe_account_id"),
	CONSTRAINT "offer_price_bindings_price_provider_unique" UNIQUE("id","environment","stripe_account_id"),
	CONSTRAINT "offer_price_bindings_role_unique" UNIQUE("offer_id","catalog_version_id","environment","price_role"),
	CONSTRAINT "offer_price_bindings_environment_check" CHECK ("offer_price_bindings"."environment" in ('test','staging','production')),
	CONSTRAINT "offer_price_bindings_money_check" CHECK ("offer_price_bindings"."currency"='usd' and "offer_price_bindings"."unit_amount">0 and "offer_price_bindings"."quantity"=1),
	CONSTRAINT "offer_price_bindings_interval_check" CHECK (("offer_price_bindings"."recurring_interval" is null and "offer_price_bindings"."interval_count" is null) or ("offer_price_bindings"."recurring_interval" in ('month','year') and "offer_price_bindings"."interval_count"=1)),
	CONSTRAINT "offer_price_bindings_tax_check" CHECK ("offer_price_bindings"."product_tax_code"~'^txcd_[A-Za-z0-9._:-]+$' and "offer_price_bindings"."tax_behavior" in ('inclusive','exclusive')),
	CONSTRAINT "offer_price_bindings_role_shape_check" CHECK (
    ("offer_price_bindings"."price_role"='self_paced_once' and "offer_price_bindings"."offer_code"='self_paced' and "offer_price_bindings"."unit_amount"=39900 and "offer_price_bindings"."recurring_interval" is null)
    or ("offer_price_bindings"."price_role"='guided_pilot_once' and "offer_price_bindings"."offer_code"='guided_pilot' and "offer_price_bindings"."unit_amount"=75000 and "offer_price_bindings"."recurring_interval" is null)
    or ("offer_price_bindings"."price_role"='operator_club_monthly' and "offer_price_bindings"."offer_code"='operator_club_monthly' and "offer_price_bindings"."unit_amount"=5900 and "offer_price_bindings"."recurring_interval"='month')
    or ("offer_price_bindings"."price_role"='operator_club_annual' and "offer_price_bindings"."offer_code"='operator_club_annual' and "offer_price_bindings"."unit_amount"=59000 and "offer_price_bindings"."recurring_interval"='year')
    or ("offer_price_bindings"."price_role"='business_os_setup' and "offer_price_bindings"."offer_code"='business_os' and "offer_price_bindings"."unit_amount"=99900 and "offer_price_bindings"."recurring_interval" is null)
    or ("offer_price_bindings"."price_role"='business_os_monthly' and "offer_price_bindings"."offer_code"='business_os' and "offer_price_bindings"."unit_amount"=19900 and "offer_price_bindings"."recurring_interval"='month')
    or ("offer_price_bindings"."price_role"='gate5_validation' and "offer_price_bindings"."offer_code"='self_paced' and "offer_price_bindings"."environment"='production' and "offer_price_bindings"."recurring_interval" is null)
  ),
	CONSTRAINT "offer_price_bindings_fingerprint_check" CHECK ("offer_price_bindings"."fingerprint"~'^[0-9a-f]{64}$'),
	CONSTRAINT "offer_price_bindings_lifecycle_check" CHECK (
    "offer_price_bindings"."verified_at"=date_trunc('milliseconds',"offer_price_bindings"."verified_at")
    and (("offer_price_bindings"."enabled_at" is null and "offer_price_bindings"."retired_at" is null)
      or ("offer_price_bindings"."enabled_at" is not null and "offer_price_bindings"."enabled_at"=date_trunc('milliseconds',"offer_price_bindings"."enabled_at") and "offer_price_bindings"."enabled_at">="offer_price_bindings"."verified_at" and ("offer_price_bindings"."retired_at" is null or ("offer_price_bindings"."retired_at"=date_trunc('milliseconds',"offer_price_bindings"."retired_at") and "offer_price_bindings"."retired_at">="offer_price_bindings"."enabled_at"))))
  )
);
--> statement-breakpoint
CREATE TABLE public.checkout_authorizations (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"offer_id" uuid NOT NULL,
	"offer_code" text NOT NULL,
	"catalog_version_id" uuid NOT NULL,
	"price_binding_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"public_intent_id" uuid,
	"setup_epoch_id" uuid,
	"recurring_intent_id" uuid,
	"contact_email_fingerprint" "bytea",
	"contact_ciphertext" "bytea",
	"contact_nonce" "bytea",
	"contact_tag" "bytea",
	"contact_key_id" text,
	"business_name_ciphertext" "bytea",
	"business_name_nonce" "bytea",
	"business_name_tag" "bytea",
	"business_name_key_id" text,
	"business_name_content_hash" text,
	"account_name_schema_version" text,
	"source_command_receipt_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"integration_identifier" text NOT NULL,
	"policy_versions" jsonb NOT NULL,
	"status" text DEFAULT 'provider_call_pending' NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "checkout_authorizations_source_receipt_unique" UNIQUE("source_command_receipt_id"),
	CONSTRAINT "checkout_authorizations_public_intent_unique" UNIQUE("public_intent_id"),
	CONSTRAINT "checkout_authorizations_id_account_unique" UNIQUE("id","account_id"),
	CONSTRAINT "checkout_authorizations_provider_owner_unique" UNIQUE("id","environment","receiver_stripe_account_id"),
	CONSTRAINT "checkout_authorizations_purchase_owner_unique" UNIQUE("id","offer_code","environment","receiver_stripe_account_id"),
	CONSTRAINT "checkout_authorizations_exact_unique" UNIQUE("id","account_id","offer_code"),
	CONSTRAINT "checkout_authorizations_principal_check" CHECK ("checkout_authorizations"."principal_kind" in ('anonymous','member','staff') and octet_length("checkout_authorizations"."principal_id") between 1 and 255),
	CONSTRAINT "checkout_authorizations_environment_check" CHECK ("checkout_authorizations"."environment" in ('test','staging','production')),
	CONSTRAINT "checkout_authorizations_hash_check" CHECK ("checkout_authorizations"."request_hash"~'^[0-9a-f]{64}$'),
	CONSTRAINT "checkout_authorizations_business_name_hash_check" CHECK ("checkout_authorizations"."business_name_content_hash" is null or "checkout_authorizations"."business_name_content_hash"~'^[0-9a-f]{64}$'),
	CONSTRAINT "checkout_authorizations_state_check" CHECK ("checkout_authorizations"."status" in ('provider_call_pending','checkout_open','async_payment_pending','paid','claim_sent','failed','expired','consumed')),
	CONSTRAINT "checkout_authorizations_source_topology_check" CHECK (num_nonnulls("checkout_authorizations"."public_intent_id","checkout_authorizations"."setup_epoch_id","checkout_authorizations"."recurring_intent_id")<=1 and ("checkout_authorizations"."public_intent_id" is null or ("checkout_authorizations"."offer_code"='business_os' and "checkout_authorizations"."account_id" is null)) and ("checkout_authorizations"."setup_epoch_id" is null or ("checkout_authorizations"."offer_code"='business_os' and "checkout_authorizations"."account_id" is not null)) and ("checkout_authorizations"."recurring_intent_id" is null or "checkout_authorizations"."account_id" is not null)),
	CONSTRAINT "checkout_authorizations_contact_check" CHECK (
	  ("checkout_authorizations"."contact_email_fingerprint" is null and "checkout_authorizations"."contact_ciphertext" is null and "checkout_authorizations"."contact_nonce" is null and "checkout_authorizations"."contact_tag" is null and "checkout_authorizations"."contact_key_id" is null and "checkout_authorizations"."business_name_ciphertext" is null and "checkout_authorizations"."business_name_nonce" is null and "checkout_authorizations"."business_name_tag" is null and "checkout_authorizations"."business_name_key_id" is null and "checkout_authorizations"."business_name_content_hash" is null and "checkout_authorizations"."account_name_schema_version" is null)
	  or (("checkout_authorizations"."contact_email_fingerprint" is null or octet_length("checkout_authorizations"."contact_email_fingerprint")=32) and octet_length("checkout_authorizations"."contact_ciphertext") between 1 and 4096 and octet_length("checkout_authorizations"."contact_nonce")=12 and octet_length("checkout_authorizations"."contact_tag")=16 and octet_length("checkout_authorizations"."contact_key_id") between 1 and 128 and octet_length("checkout_authorizations"."business_name_ciphertext") between 1 and 4096 and octet_length("checkout_authorizations"."business_name_nonce")=12 and octet_length("checkout_authorizations"."business_name_tag")=16 and octet_length("checkout_authorizations"."business_name_key_id") between 1 and 128 and "checkout_authorizations"."business_name_content_hash"~'^[0-9a-f]{64}$' and octet_length("checkout_authorizations"."account_name_schema_version") between 1 and 64)
	),
	CONSTRAINT "checkout_authorizations_identity_boundary_check" CHECK (
	  ("checkout_authorizations"."account_id" is not null and "checkout_authorizations"."public_intent_id" is null and "checkout_authorizations"."contact_email_fingerprint" is null)
	  or ("checkout_authorizations"."account_id" is null and "checkout_authorizations"."public_intent_id" is not null and "checkout_authorizations"."contact_email_fingerprint" is null)
	  or ("checkout_authorizations"."account_id" is null and "checkout_authorizations"."public_intent_id" is null and "checkout_authorizations"."contact_email_fingerprint" is not null)
	  or ("checkout_authorizations"."account_id" is null and "checkout_authorizations"."public_intent_id" is null and "checkout_authorizations"."offer_code"='self_paced' and "checkout_authorizations"."status"='consumed' and "checkout_authorizations"."contact_email_fingerprint" is null)
	)
);
--> statement-breakpoint
CREATE TABLE public.checkout_sessions (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"authorization_id" uuid NOT NULL,
	"account_id" uuid,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"provider_session_id" text NOT NULL,
	"provider_customer_id" text,
	"provider_payment_intent_id" text,
	"provider_subscription_id" text,
	"provider_setup_intent_id" text,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"payment_status" text NOT NULL,
	"checkout_url_ciphertext" "bytea",
	"checkout_url_nonce" "bytea",
	"checkout_url_tag" "bytea",
	"checkout_url_key_id" text,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "checkout_sessions_authorization_unique" UNIQUE("authorization_id"),
	CONSTRAINT "checkout_sessions_provider_unique" UNIQUE("environment","receiver_stripe_account_id","provider_session_id"),
	CONSTRAINT "checkout_sessions_action_result_unique" UNIQUE("authorization_id","environment","receiver_stripe_account_id","provider_session_id"),
	CONSTRAINT "checkout_sessions_customer_result_unique" UNIQUE("id","authorization_id","environment","receiver_stripe_account_id","provider_customer_id"),
	CONSTRAINT "checkout_sessions_payment_intent_unique" UNIQUE("environment","receiver_stripe_account_id","provider_payment_intent_id"),
	CONSTRAINT "checkout_sessions_subscription_unique" UNIQUE("environment","receiver_stripe_account_id","provider_subscription_id"),
	CONSTRAINT "checkout_sessions_setup_intent_unique" UNIQUE("environment","receiver_stripe_account_id","provider_setup_intent_id"),
	CONSTRAINT "checkout_sessions_exact_unique" UNIQUE("id","authorization_id","account_id"),
	CONSTRAINT "checkout_sessions_mode_check" CHECK ("checkout_sessions"."mode" in ('payment','setup','subscription')),
	CONSTRAINT "checkout_sessions_status_check" CHECK ("checkout_sessions"."status" in ('open','complete','expired')),
	CONSTRAINT "checkout_sessions_payment_check" CHECK ("checkout_sessions"."payment_status" in ('paid','unpaid','no_payment_required')),
	CONSTRAINT "checkout_sessions_url_ciphertext_check" CHECK (
	  ("checkout_sessions"."checkout_url_ciphertext" is null and "checkout_sessions"."checkout_url_nonce" is null and "checkout_sessions"."checkout_url_tag" is null and "checkout_sessions"."checkout_url_key_id" is null)
	  or (octet_length("checkout_sessions"."checkout_url_ciphertext") between 1 and 4096 and octet_length("checkout_sessions"."checkout_url_nonce")=12 and octet_length("checkout_sessions"."checkout_url_tag")=16 and octet_length("checkout_sessions"."checkout_url_key_id") between 1 and 128)
	),
	CONSTRAINT "checkout_sessions_provider_identity_check" CHECK (
    "checkout_sessions"."environment" in ('test','staging','production')
    and octet_length("checkout_sessions"."receiver_stripe_account_id") between 1 and 255
    and octet_length("checkout_sessions"."provider_session_id") between 1 and 255
    and "checkout_sessions"."provider_session_id"~'^cs_[A-Za-z0-9._:-]+$'
    and ("checkout_sessions"."provider_customer_id" is null or (octet_length("checkout_sessions"."provider_customer_id") between 1 and 255 and "checkout_sessions"."provider_customer_id"~'^cus_[A-Za-z0-9._:-]+$'))
    and ("checkout_sessions"."provider_payment_intent_id" is null or (octet_length("checkout_sessions"."provider_payment_intent_id") between 1 and 255 and "checkout_sessions"."provider_payment_intent_id"~'^pi_[A-Za-z0-9._:-]+$'))
    and ("checkout_sessions"."provider_subscription_id" is null or (octet_length("checkout_sessions"."provider_subscription_id") between 1 and 255 and "checkout_sessions"."provider_subscription_id"~'^sub_[A-Za-z0-9._:-]+$'))
    and ("checkout_sessions"."provider_setup_intent_id" is null or (octet_length("checkout_sessions"."provider_setup_intent_id") between 1 and 255 and "checkout_sessions"."provider_setup_intent_id"~'^seti_[A-Za-z0-9._:-]+$'))
	),
	CONSTRAINT "checkout_sessions_time_check" CHECK (
    "checkout_sessions"."expires_at"=date_trunc('milliseconds',"checkout_sessions"."expires_at")
    and "checkout_sessions"."created_at"=date_trunc('milliseconds',"checkout_sessions"."created_at")
    and "checkout_sessions"."updated_at"=date_trunc('milliseconds',"checkout_sessions"."updated_at")
    and "checkout_sessions"."expires_at">"checkout_sessions"."created_at"
    and "checkout_sessions"."updated_at">="checkout_sessions"."created_at"
	)
);
--> statement-breakpoint
CREATE TABLE public.checkout_provider_actions (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"authorization_id" uuid NOT NULL,
	"account_id" uuid,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"action_kind" text NOT NULL,
	"provider_idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_session_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "checkout_provider_actions_authorization_kind_unique" UNIQUE("authorization_id","action_kind"),
	CONSTRAINT "checkout_provider_actions_provider_key_unique" UNIQUE("provider_idempotency_key"),
	CONSTRAINT "checkout_provider_actions_exact_unique" UNIQUE("id","authorization_id","account_id","environment","receiver_stripe_account_id"),
	CONSTRAINT "checkout_provider_actions_state_check" CHECK ("checkout_provider_actions"."status" in ('pending','in_flight','succeeded','failed_retryable','failed_terminal','ambiguous')),
	CONSTRAINT "checkout_provider_actions_hash_check" CHECK ("checkout_provider_actions"."request_fingerprint"~'^[0-9a-f]{64}$'),
	CONSTRAINT "checkout_provider_actions_identity_check" CHECK (
    "checkout_provider_actions"."environment" in ('test','staging','production')
    and octet_length("checkout_provider_actions"."receiver_stripe_account_id") between 1 and 255
    and "checkout_provider_actions"."action_kind" in ('create_checkout_session','create_business_os_setup_checkout')
    and (("checkout_provider_actions"."action_kind"='create_checkout_session'
        and "checkout_provider_actions"."provider_idempotency_key"='checkout:'||"checkout_provider_actions"."authorization_id"::text)
      or ("checkout_provider_actions"."action_kind"='create_business_os_setup_checkout'
        and "checkout_provider_actions"."provider_idempotency_key"='business_os_setup_checkout:'||"checkout_provider_actions"."id"::text))
    and ("checkout_provider_actions"."provider_session_id" is null
      or (octet_length("checkout_provider_actions"."provider_session_id") between 1 and 255
        and "checkout_provider_actions"."provider_session_id"~'^cs_[A-Za-z0-9._:-]+$'))
    and ("checkout_provider_actions"."last_error_code" is null
      or (octet_length("checkout_provider_actions"."last_error_code") between 1 and 128
        and "checkout_provider_actions"."last_error_code"~'^[A-Z][A-Z0-9_]*$'))
    and "checkout_provider_actions"."created_at"=date_trunc('milliseconds',"checkout_provider_actions"."created_at")
    and "checkout_provider_actions"."updated_at"=date_trunc('milliseconds',"checkout_provider_actions"."updated_at")
    and "checkout_provider_actions"."updated_at">="checkout_provider_actions"."created_at"
  ),
	CONSTRAINT "checkout_provider_actions_lifecycle_check" CHECK (
    ("checkout_provider_actions"."status"='pending' and "checkout_provider_actions"."attempts"=0
      and "checkout_provider_actions"."provider_session_id" is null and "checkout_provider_actions"."last_error_code" is null)
    or ("checkout_provider_actions"."status"='in_flight' and "checkout_provider_actions"."attempts">0
      and "checkout_provider_actions"."provider_session_id" is null and "checkout_provider_actions"."last_error_code" is null)
    or ("checkout_provider_actions"."status"='succeeded' and "checkout_provider_actions"."attempts">0
      and "checkout_provider_actions"."provider_session_id" is not null and "checkout_provider_actions"."last_error_code" is null)
    or ("checkout_provider_actions"."status" in ('failed_retryable','failed_terminal','ambiguous')
      and "checkout_provider_actions"."attempts">0 and "checkout_provider_actions"."provider_session_id" is null
      and "checkout_provider_actions"."last_error_code" is not null)
  )
);
--> statement-breakpoint
CREATE TABLE public.public_business_os_setup_intents (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"family" text DEFAULT 'business_os_setup' NOT NULL,
	"purchaser_guard_hmac" "bytea" NOT NULL,
	"semantic_request_hmac" "bytea" NOT NULL,
	"email_normalization_version" text NOT NULL,
	"equality_key_id" text NOT NULL,
	"command_digest_key_id" text NOT NULL,
	"contact_ciphertext" "bytea",
	"contact_nonce" "bytea",
	"contact_tag" "bytea",
	"contact_key_id" text,
	"business_name_ciphertext" "bytea",
	"business_name_nonce" "bytea",
	"business_name_tag" "bytea",
	"business_name_key_id" text,
	"catalog_version_id" uuid NOT NULL,
	"price_binding_id" uuid NOT NULL,
	"state" text DEFAULT 'checkout_create_pending' NOT NULL,
	"terminalized_at" timestamp (3) with time zone,
	"security_hold_at" timestamp (3) with time zone,
	"legal_hold_at" timestamp (3) with time zone,
	"financial_retention_until" timestamp (3) with time zone,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "public_bos_setup_intents_exact_unique" UNIQUE("id","environment","receiver_stripe_account_id"),
	CONSTRAINT "public_bos_setup_intents_environment_check" CHECK ("public_business_os_setup_intents"."environment" in ('test','staging','production')),
	CONSTRAINT "public_bos_setup_intents_family_check" CHECK ("public_business_os_setup_intents"."family"='business_os_setup'),
	CONSTRAINT "public_bos_setup_intents_hmac_check" CHECK (octet_length("public_business_os_setup_intents"."purchaser_guard_hmac")=32 and octet_length("public_business_os_setup_intents"."semantic_request_hmac")=32),
	CONSTRAINT "public_bos_setup_intents_contact_ciphertext_check" CHECK (
	  ("public_business_os_setup_intents"."contact_ciphertext" is null and "public_business_os_setup_intents"."contact_nonce" is null and "public_business_os_setup_intents"."contact_tag" is null and "public_business_os_setup_intents"."contact_key_id" is null)
	  or (octet_length("public_business_os_setup_intents"."contact_ciphertext") between 1 and 4096 and octet_length("public_business_os_setup_intents"."contact_nonce")=12 and octet_length("public_business_os_setup_intents"."contact_tag")=16 and octet_length("public_business_os_setup_intents"."contact_key_id") between 1 and 128)
	),
	CONSTRAINT "public_bos_setup_intents_name_ciphertext_check" CHECK (
	  ("public_business_os_setup_intents"."business_name_ciphertext" is null and "public_business_os_setup_intents"."business_name_nonce" is null and "public_business_os_setup_intents"."business_name_tag" is null and "public_business_os_setup_intents"."business_name_key_id" is null)
	  or (octet_length("public_business_os_setup_intents"."business_name_ciphertext") between 1 and 4096 and octet_length("public_business_os_setup_intents"."business_name_nonce")=12 and octet_length("public_business_os_setup_intents"."business_name_tag")=16 and octet_length("public_business_os_setup_intents"."business_name_key_id") between 1 and 128)
	),
	CONSTRAINT "public_bos_setup_intents_state_check" CHECK ("public_business_os_setup_intents"."state" in ('checkout_create_pending','checkout_open','async_payment_pending','paid_processing','paid_consumed','refund_pending','dispute_open','terminal_refunded','terminal_dispute_lost','terminal_abandoned_unpaid','terminal_security'))
);
--> statement-breakpoint
CREATE TABLE public.stripe_customer_creation_actions (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"provider_idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_customer_id" text,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "stripe_customer_creation_actions_scope_unique" UNIQUE("account_id","environment"),
	CONSTRAINT "stripe_customer_creation_actions_provider_key_unique" UNIQUE("provider_idempotency_key"),
	CONSTRAINT "stripe_customer_creation_actions_exact_unique" UNIQUE("id","account_id","environment"),
	CONSTRAINT "stripe_customer_creation_actions_provider_owner_unique" UNIQUE("id","account_id","environment","receiver_stripe_account_id"),
	CONSTRAINT "stripe_customer_creation_actions_result_owner_unique" UNIQUE("id","account_id","environment","receiver_stripe_account_id","provider_customer_id"),
	CONSTRAINT "stripe_customer_creation_actions_state_check" CHECK ("stripe_customer_creation_actions"."status" in ('pending','in_flight','succeeded','failed_retryable','failed_terminal','ambiguous'))
);
--> statement-breakpoint
CREATE TABLE public.business_os_setup_epochs (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"catalog_version_id" uuid NOT NULL,
	"price_binding_id" uuid NOT NULL,
	"state" text DEFAULT 'checkout_create_pending' NOT NULL,
	"public_intent_id" uuid,
	"source_registry_id" uuid,
	"provisioning_started_at" timestamp (3) with time zone,
	"terminalized_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "business_os_setup_epochs_scope_ordinal_unique" UNIQUE("account_id","ordinal"),
	CONSTRAINT "business_os_setup_epochs_exact_unique" UNIQUE("id","account_id","environment"),
	CONSTRAINT "business_os_setup_epochs_provider_owner_unique" UNIQUE("id","account_id","environment","receiver_stripe_account_id"),
	CONSTRAINT "business_os_setup_epochs_state_check" CHECK ("business_os_setup_epochs"."state" in ('checkout_create_pending','checkout_open','async_payment_pending','paid','refund_pending','dispute_open','terminal_abandoned_unpaid','terminal_refunded','terminal_dispute_lost')),
	CONSTRAINT "business_os_setup_epochs_ordinal_check" CHECK ("business_os_setup_epochs"."ordinal">=1)
);
--> statement-breakpoint
CREATE TABLE public.recurring_purchase_intents (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"reservation_command_id" uuid NOT NULL,
	"reservation_request_hash" text NOT NULL,
	"family" text NOT NULL,
	"offer_code" text NOT NULL,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"catalog_version_id" uuid NOT NULL,
	"price_binding_id" uuid NOT NULL,
	"state" text DEFAULT 'provider_call_pending' NOT NULL,
	"setup_epoch_id" uuid,
	"setup_purchase_id" uuid,
	"academy_source_registry_id" uuid,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"terminalized_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "recurring_purchase_intents_exact_unique" UNIQUE("id","account_id","family","environment"),
	CONSTRAINT "recurring_purchase_intents_id_account_unique" UNIQUE("id","account_id"),
	CONSTRAINT "recurring_purchase_intents_id_account_environment_unique" UNIQUE("id","account_id","environment"),
	CONSTRAINT "recurring_purchase_intents_provider_owner_unique" UNIQUE("id","account_id","environment","receiver_stripe_account_id"),
	CONSTRAINT "recurring_purchase_intents_reservation_command_unique" UNIQUE("reservation_command_id"),
	CONSTRAINT "recurring_purchase_intents_checkout_owner_unique" UNIQUE("id","account_id","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id"),
	CONSTRAINT "recurring_purchase_intents_subscription_owner_unique" UNIQUE("id","account_id","family","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id"),
	CONSTRAINT "recurring_purchase_intents_family_check" CHECK ("recurring_purchase_intents"."family" in ('operator_club','business_os')),
	CONSTRAINT "recurring_purchase_intents_request_hash_check" CHECK ("recurring_purchase_intents"."reservation_request_hash"~'^[0-9a-f]{64}$'),
	CONSTRAINT "recurring_purchase_intents_offer_topology_check" CHECK (
	  ("recurring_purchase_intents"."family"='operator_club' and "recurring_purchase_intents"."offer_code" in ('operator_club_monthly','operator_club_annual') and "recurring_purchase_intents"."academy_source_registry_id" is not null and "recurring_purchase_intents"."setup_epoch_id" is null and "recurring_purchase_intents"."setup_purchase_id" is null)
	  or ("recurring_purchase_intents"."family"='business_os' and "recurring_purchase_intents"."offer_code"='business_os' and "recurring_purchase_intents"."academy_source_registry_id" is null and "recurring_purchase_intents"."setup_epoch_id" is not null and "recurring_purchase_intents"."setup_purchase_id" is not null)
	),
	CONSTRAINT "recurring_purchase_intents_state_check" CHECK ("recurring_purchase_intents"."state" in ('provider_call_pending','checkout_open','setup_succeeded','schedule_pending','subscription_pending','active','grace','cancellation_pending','terminal_cancelled','terminal_expired','terminal_refunded','terminal_revoked','abandoned'))
);
--> statement-breakpoint
CREATE TABLE public.stripe_customers (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"provider_customer_id" text NOT NULL,
	"creation_action_id" uuid,
	"checkout_session_id" uuid,
	"checkout_authorization_id" uuid,
	"public_intent_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "stripe_customers_account_environment_unique" UNIQUE("account_id","environment"),
	CONSTRAINT "stripe_customers_provider_unique" UNIQUE("environment","receiver_stripe_account_id","provider_customer_id"),
	CONSTRAINT "stripe_customers_creation_action_unique" UNIQUE("creation_action_id"),
	CONSTRAINT "stripe_customers_public_intent_unique" UNIQUE("public_intent_id"),
	CONSTRAINT "stripe_customers_exact_unique" UNIQUE("id","account_id","environment"),
	CONSTRAINT "stripe_customers_provider_owner_unique" UNIQUE("id","account_id","environment","receiver_stripe_account_id"),
	CONSTRAINT "stripe_customers_source_check" CHECK (num_nonnulls("stripe_customers"."creation_action_id","stripe_customers"."checkout_session_id")=1 and (("stripe_customers"."checkout_session_id" is null and "stripe_customers"."checkout_authorization_id" is null and "stripe_customers"."public_intent_id" is null) or ("stripe_customers"."checkout_session_id" is not null and "stripe_customers"."checkout_authorization_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE public.purchases (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"offer_code" text NOT NULL,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"provider_payment_intent_id" text NOT NULL,
	"provider_charge_id" text,
	"currency" text NOT NULL,
	"gross_amount" integer NOT NULL,
	"tax_amount" integer NOT NULL,
	"status" text NOT NULL,
	"source_registry_id" uuid,
	"purchased_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "purchases_provider_payment_unique" UNIQUE("environment","receiver_stripe_account_id","provider_payment_intent_id"),
	CONSTRAINT "purchases_provider_charge_unique" UNIQUE("environment","receiver_stripe_account_id","provider_charge_id"),
	CONSTRAINT "purchases_authorization_unique" UNIQUE("authorization_id"),
	CONSTRAINT "purchases_id_account_unique" UNIQUE("id","account_id"),
	CONSTRAINT "purchases_provider_owner_unique" UNIQUE("id","account_id","environment","receiver_stripe_account_id"),
	CONSTRAINT "purchases_exact_unique" UNIQUE("id","account_id","offer_code"),
	CONSTRAINT "purchases_money_check" CHECK ("purchases"."currency"='usd' and "purchases"."gross_amount">0 and "purchases"."tax_amount" between 0 and "purchases"."gross_amount"),
	CONSTRAINT "purchases_state_check" CHECK ("purchases"."status" in ('paid','paid_reconciliation','refunded','dispute_open','dispute_lost'))
);
--> statement-breakpoint
CREATE TABLE public.public_business_os_setup_fulfillments (
	"public_intent_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"setup_epoch_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"source_registry_id" uuid,
	"provider_receipt_id" uuid NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"fulfilled_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "public_bos_setup_fulfillments_epoch_unique" UNIQUE("setup_epoch_id"),
	CONSTRAINT "public_bos_setup_fulfillments_purchase_unique" UNIQUE("purchase_id"),
	CONSTRAINT "public_bos_setup_fulfillments_source_unique" UNIQUE("source_registry_id"),
	CONSTRAINT "public_bos_setup_fulfillments_receipt_unique" UNIQUE("provider_receipt_id"),
	CONSTRAINT "public_bos_setup_fulfillments_exact_unique" UNIQUE("public_intent_id","account_id","setup_epoch_id","purchase_id"),
	CONSTRAINT "public_bos_setup_fulfillments_environment_check" CHECK ("public_business_os_setup_fulfillments"."environment" in ('test','staging','production')),
	CONSTRAINT "public_bos_setup_fulfillments_provider_check" CHECK ("public_business_os_setup_fulfillments"."provider"='stripe'),
	CONSTRAINT "public_bos_setup_fulfillments_time_check" CHECK ("public_business_os_setup_fulfillments"."fulfilled_at"=date_trunc('milliseconds',"public_business_os_setup_fulfillments"."fulfilled_at"))
);
--> statement-breakpoint
CREATE TABLE public.purchase_payment_allocations (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"provider_payment_object_type" text NOT NULL,
	"provider_payment_object_id" text NOT NULL,
	"gross_amount" integer NOT NULL,
	"tax_amount" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "purchase_payment_allocations_provider_unique" UNIQUE("environment","receiver_stripe_account_id","provider_payment_object_type","provider_payment_object_id"),
	CONSTRAINT "purchase_payment_allocations_purchase_type_unique" UNIQUE("purchase_id","provider_payment_object_type"),
	CONSTRAINT "purchase_payment_allocations_type_check" CHECK ("purchase_payment_allocations"."provider_payment_object_type" in ('payment_intent','charge')),
	CONSTRAINT "purchase_payment_allocations_money_check" CHECK ("purchase_payment_allocations"."gross_amount">0 and "purchase_payment_allocations"."tax_amount" between 0 and "purchase_payment_allocations"."gross_amount")
);
--> statement-breakpoint
CREATE TABLE public.subscriptions (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"recurring_intent_id" uuid NOT NULL,
	"recurring_family" text NOT NULL,
	"stripe_customer_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"offer_code" text NOT NULL,
	"catalog_version_id" uuid NOT NULL,
	"price_binding_id" uuid NOT NULL,
	"status" text NOT NULL,
	"current_period_start" timestamp (3) with time zone,
	"current_period_end" timestamp (3) with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"source_registry_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "subscriptions_provider_unique" UNIQUE("environment","receiver_stripe_account_id","provider_subscription_id"),
	CONSTRAINT "subscriptions_intent_unique" UNIQUE("recurring_intent_id"),
	CONSTRAINT "subscriptions_id_account_unique" UNIQUE("id","account_id"),
	CONSTRAINT "subscriptions_provider_owner_unique" UNIQUE("id","account_id","environment","receiver_stripe_account_id"),
	CONSTRAINT "subscriptions_intent_provider_owner_unique" UNIQUE("id","recurring_intent_id","account_id","recurring_family","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id"),
	CONSTRAINT "subscriptions_exact_unique" UNIQUE("id","account_id","offer_code"),
	CONSTRAINT "subscriptions_state_check" CHECK ("subscriptions"."status" in ('incomplete','trialing','active','past_due','unpaid','paused','canceled'))
);
--> statement-breakpoint
CREATE TABLE public.subscription_schedules (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"recurring_intent_id" uuid NOT NULL,
	"recurring_family" text NOT NULL,
	"subscription_id" uuid,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"offer_code" text NOT NULL,
	"catalog_version_id" uuid NOT NULL,
	"price_binding_id" uuid NOT NULL,
	"provider_schedule_id" text NOT NULL,
	"status" text NOT NULL,
	"phase_starts_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "subscription_schedules_provider_unique" UNIQUE("environment","receiver_stripe_account_id","provider_schedule_id"),
	CONSTRAINT "subscription_schedules_intent_unique" UNIQUE("recurring_intent_id"),
	CONSTRAINT "subscription_schedules_state_check" CHECK ("subscription_schedules"."status" in ('not_started','active','released','completed','canceled','aborted'))
);
--> statement-breakpoint
CREATE TABLE public.invoices (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"recurring_intent_id" uuid NOT NULL,
	"recurring_family" text NOT NULL,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"offer_code" text NOT NULL,
	"catalog_version_id" uuid NOT NULL,
	"price_binding_id" uuid NOT NULL,
	"provider_invoice_id" text NOT NULL,
	"status" text NOT NULL,
	"collection_method" text NOT NULL,
	"currency" text NOT NULL,
	"amount_due" integer NOT NULL,
	"amount_paid" integer NOT NULL,
	"amount_remaining" integer NOT NULL,
	"total_tax_amount" integer NOT NULL,
	"period_start" timestamp (3) with time zone NOT NULL,
	"period_end" timestamp (3) with time zone NOT NULL,
	"paid_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "invoices_provider_unique" UNIQUE("environment","receiver_stripe_account_id","provider_invoice_id"),
	CONSTRAINT "invoices_exact_unique" UNIQUE("id","account_id","subscription_id"),
	CONSTRAINT "invoices_provider_owner_unique" UNIQUE("id","account_id","subscription_id","recurring_intent_id","recurring_family","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id"),
	CONSTRAINT "invoices_state_check" CHECK ("invoices"."status" in ('draft','open','paid','uncollectible','void')),
	CONSTRAINT "invoices_collection_check" CHECK ("invoices"."collection_method"='charge_automatically'),
	CONSTRAINT "invoices_money_check" CHECK ("invoices"."currency"='usd' and "invoices"."amount_due">=0 and "invoices"."amount_paid">=0 and "invoices"."amount_remaining">=0 and "invoices"."total_tax_amount">=0)
);
--> statement-breakpoint
CREATE TABLE public.invoice_line_allocations (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"recurring_intent_id" uuid NOT NULL,
	"recurring_family" text NOT NULL,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"offer_code" text NOT NULL,
	"catalog_version_id" uuid NOT NULL,
	"provider_invoice_line_id" text NOT NULL,
	"price_binding_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"tax_amount" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "invoice_line_allocations_provider_line_unique" UNIQUE("invoice_id","provider_invoice_line_id"),
	CONSTRAINT "invoice_line_allocations_money_check" CHECK ("invoice_line_allocations"."amount">=0 and "invoice_line_allocations"."tax_amount">=0)
);
--> statement-breakpoint
CREATE TABLE public.controlled_payment_authorizations (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_sha" text NOT NULL,
	"environment" text NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"catalog_hash" text NOT NULL,
	"policy_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"catalog_version_id" uuid NOT NULL,
	"price_binding_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"creator_staff_id" uuid NOT NULL,
	"maximum_gross_amount" integer NOT NULL,
	"state" text DEFAULT 'issued' NOT NULL,
	"checkout_authorization_id" uuid,
	"provider_payment_intent_id" text,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	"consumed_at" timestamp (3) with time zone,
	CONSTRAINT "controlled_payment_authorizations_checkout_unique" UNIQUE("checkout_authorization_id"),
	CONSTRAINT "controlled_payment_authorizations_payment_unique" UNIQUE("provider_payment_intent_id"),
	CONSTRAINT "controlled_payment_authorizations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "controlled_payment_authorizations_environment_check" CHECK ("controlled_payment_authorizations"."environment"='production'),
	CONSTRAINT "controlled_payment_authorizations_state_check" CHECK ("controlled_payment_authorizations"."state" in ('issued','checkout_open','paid','expired','revoked')),
	CONSTRAINT "controlled_payment_authorizations_amount_check" CHECK ("controlled_payment_authorizations"."maximum_gross_amount">0),
	CONSTRAINT "controlled_payment_authorizations_token_hash_check" CHECK ("controlled_payment_authorizations"."token_hash"~'^[0-9a-f]{64}$'),
	CONSTRAINT "controlled_payment_authorizations_hashes_check" CHECK ("controlled_payment_authorizations"."catalog_hash"~'^[0-9a-f]{64}$' and "controlled_payment_authorizations"."policy_hash"~'^[0-9a-f]{64}$' and "controlled_payment_authorizations"."content_hash"~'^[0-9a-f]{64}$'),
	CONSTRAINT "controlled_payment_authorizations_release_check" CHECK ("controlled_payment_authorizations"."release_sha"~'^[0-9a-f]{40}$'),
	CONSTRAINT "controlled_payment_authorizations_expiry_check" CHECK ("controlled_payment_authorizations"."expires_at">"controlled_payment_authorizations"."created_at" and "controlled_payment_authorizations"."expires_at"<="controlled_payment_authorizations"."created_at"+interval '2 hours')
);
--> statement-breakpoint
CREATE TABLE public.claim_tokens (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"email_fingerprint" "bytea" NOT NULL,
	"email_ciphertext" "bytea",
	"email_nonce" "bytea",
	"email_tag" "bytea",
	"email_key_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"consumed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "claim_tokens_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "claim_tokens_purchase_unique" UNIQUE("purchase_id"),
	CONSTRAINT "claim_tokens_id_account_unique" UNIQUE("id","account_id"),
	CONSTRAINT "claim_tokens_exact_unique" UNIQUE("id","account_id","purchase_id"),
	CONSTRAINT "claim_tokens_hash_check" CHECK ("claim_tokens"."token_hash"~'^[0-9a-f]{64}$'),
	CONSTRAINT "claim_tokens_state_check" CHECK ("claim_tokens"."status" in ('pending','consumed','expired','revoked')),
	CONSTRAINT "claim_tokens_email_fingerprint_check" CHECK (octet_length("claim_tokens"."email_fingerprint")=32),
	CONSTRAINT "claim_tokens_email_ciphertext_check" CHECK (
	  ("claim_tokens"."email_ciphertext" is null and "claim_tokens"."email_nonce" is null and "claim_tokens"."email_tag" is null and "claim_tokens"."email_key_id" is null)
	  or (octet_length("claim_tokens"."email_ciphertext") between 1 and 4096 and octet_length("claim_tokens"."email_nonce")=12 and octet_length("claim_tokens"."email_tag")=16 and octet_length("claim_tokens"."email_key_id") between 1 and 128)
	),
	CONSTRAINT "claim_tokens_expiry_check" CHECK ("claim_tokens"."expires_at"="claim_tokens"."created_at"+interval '168 hours'),
	CONSTRAINT "claim_tokens_consumed_check" CHECK (("claim_tokens"."status"='consumed')=("claim_tokens"."consumed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE public.pending_claim_sessions (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_token_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"session_handle_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"candidate_principal_id" text,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"consumed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "pending_claim_sessions_handle_unique" UNIQUE("session_handle_hash"),
	CONSTRAINT "pending_claim_sessions_claim_unique" UNIQUE("claim_token_id"),
	CONSTRAINT "pending_claim_sessions_hash_check" CHECK ("pending_claim_sessions"."session_handle_hash"~'^[0-9a-f]{64}$'),
	CONSTRAINT "pending_claim_sessions_state_check" CHECK ("pending_claim_sessions"."status" in ('pending','consumed','expired')),
	CONSTRAINT "pending_claim_sessions_candidate_check" CHECK ("pending_claim_sessions"."candidate_principal_id" is null or octet_length("pending_claim_sessions"."candidate_principal_id") between 1 and 255),
	CONSTRAINT "pending_claim_sessions_expiry_check" CHECK ("pending_claim_sessions"."expires_at">"pending_claim_sessions"."created_at" and "pending_claim_sessions"."expires_at"<="pending_claim_sessions"."created_at"+interval '168 hours'),
	CONSTRAINT "pending_claim_sessions_consumed_check" CHECK (("pending_claim_sessions"."status"='consumed')=("pending_claim_sessions"."consumed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE public.secure_link_deliveries (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"kind" text NOT NULL,
	"claim_token_id" uuid,
	"seat_invitation_id" uuid,
	"controlled_payment_authorization_id" uuid,
	"token_ciphertext" "bytea",
	"token_nonce" "bytea",
	"token_tag" "bytea",
	"token_key_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp (3) with time zone,
	"erased_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "secure_link_deliveries_claim_unique" UNIQUE("claim_token_id"),
	CONSTRAINT "secure_link_deliveries_invitation_unique" UNIQUE("seat_invitation_id"),
	CONSTRAINT "secure_link_deliveries_controlled_payment_unique" UNIQUE("controlled_payment_authorization_id"),
	CONSTRAINT "secure_link_deliveries_kind_check" CHECK ("secure_link_deliveries"."kind" in ('claim','seat_invitation','controlled_payment')),
	CONSTRAINT "secure_link_deliveries_target_check" CHECK (
	  ("secure_link_deliveries"."kind"='claim' and "secure_link_deliveries"."claim_token_id" is not null and "secure_link_deliveries"."account_id" is not null and "secure_link_deliveries"."seat_invitation_id" is null and "secure_link_deliveries"."controlled_payment_authorization_id" is null)
	  or ("secure_link_deliveries"."kind"='seat_invitation' and "secure_link_deliveries"."seat_invitation_id" is not null and "secure_link_deliveries"."account_id" is not null and "secure_link_deliveries"."claim_token_id" is null and "secure_link_deliveries"."controlled_payment_authorization_id" is null)
	  or ("secure_link_deliveries"."kind"='controlled_payment' and "secure_link_deliveries"."controlled_payment_authorization_id" is not null and "secure_link_deliveries"."account_id" is null and "secure_link_deliveries"."claim_token_id" is null and "secure_link_deliveries"."seat_invitation_id" is null)
	),
	CONSTRAINT "secure_link_deliveries_state_check" CHECK ("secure_link_deliveries"."status" in ('pending','processing','delivered','failed','erased')),
	CONSTRAINT "secure_link_deliveries_attempts_check" CHECK ("secure_link_deliveries"."attempts">=0),
	CONSTRAINT "secure_link_deliveries_ciphertext_check" CHECK (
	  ("secure_link_deliveries"."status"='erased' and "secure_link_deliveries"."token_ciphertext" is null and "secure_link_deliveries"."token_nonce" is null and "secure_link_deliveries"."token_tag" is null and "secure_link_deliveries"."token_key_id" is null and "secure_link_deliveries"."erased_at" is not null)
	  or ("secure_link_deliveries"."status"<>'erased' and octet_length("secure_link_deliveries"."token_ciphertext") between 1 and 4096 and octet_length("secure_link_deliveries"."token_nonce")=12 and octet_length("secure_link_deliveries"."token_tag")=16 and octet_length("secure_link_deliveries"."token_key_id") between 1 and 128 and "secure_link_deliveries"."erased_at" is null)
	)
);
--> statement-breakpoint
CREATE TABLE public.account_onboarding (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"product_family" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"business_name" text NOT NULL,
	"website" text,
	"category" text,
	"country" text,
	"timezone" text,
	"team_size_band" text,
	"owner_role" text,
	"primary_goal" text,
	"tools" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scorecard_attachment_id" uuid,
	"invitation_step_completed" boolean DEFAULT false NOT NULL,
	"delivery_schedule_confirmed" boolean DEFAULT false NOT NULL,
	"current_step" text DEFAULT 'business' NOT NULL,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "account_onboarding_exact_unique" UNIQUE("account_id","version"),
	CONSTRAINT "account_onboarding_family_check" CHECK ("account_onboarding"."product_family" in ('academy','business_os')),
	CONSTRAINT "account_onboarding_version_check" CHECK ("account_onboarding"."version">=1),
	CONSTRAINT "account_onboarding_step_check" CHECK ("account_onboarding"."current_step" in ('business','tools','priorities','team','delivery','complete')),
	CONSTRAINT "account_onboarding_tools_check" CHECK (jsonb_typeof("account_onboarding"."tools")='object')
);
--> statement-breakpoint
CREATE TABLE public.account_onboarding_priorities (
	"account_id" uuid NOT NULL,
	"onboarding_version" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"priority" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "account_onboarding_priorities_account_id_onboarding_version_ordinal_pk" PRIMARY KEY("account_id","onboarding_version","ordinal"),
	CONSTRAINT "account_onboarding_priorities_ordinal_check" CHECK ("account_onboarding_priorities"."ordinal" between 1 and 3),
	CONSTRAINT "account_onboarding_priorities_text_check" CHECK (octet_length("account_onboarding_priorities"."priority") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE public.provider_event_processing (
	"receipt_id" uuid PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"worker_id" text,
	"lease_token" uuid,
	"lease_generation" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp (3) with time zone,
	"outcome_code" text,
	"completed_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "provider_event_processing_state_check" CHECK ("provider_event_processing"."status" in ('received','processing','processed','failed_retryable','failed_terminal')),
	CONSTRAINT "provider_event_processing_fence_owner_unique" UNIQUE("receipt_id","provider","receiver_stripe_account_id"),
	CONSTRAINT "provider_event_processing_provider_check" CHECK ("provider_event_processing"."provider"='stripe'),
	CONSTRAINT "provider_event_processing_generation_check" CHECK ("provider_event_processing"."lease_generation">=0),
	CONSTRAINT "provider_event_processing_fence_check" CHECK (
	  ("provider_event_processing"."status"='received' and "provider_event_processing"."worker_id" is null and "provider_event_processing"."lease_token" is null and "provider_event_processing"."lease_generation"=0 and "provider_event_processing"."lease_expires_at" is null and "provider_event_processing"."outcome_code" is null and "provider_event_processing"."completed_at" is null)
	  or ("provider_event_processing"."status"='processing' and "provider_event_processing"."worker_id" is not null and "provider_event_processing"."lease_token" is not null and "provider_event_processing"."lease_generation">0 and "provider_event_processing"."lease_expires_at" is not null and "provider_event_processing"."outcome_code" is null and "provider_event_processing"."completed_at" is null)
	  or ("provider_event_processing"."status" in ('processed','failed_retryable','failed_terminal') and "provider_event_processing"."worker_id" is null and "provider_event_processing"."lease_token" is null and "provider_event_processing"."lease_generation">0 and "provider_event_processing"."lease_expires_at" is null and "provider_event_processing"."outcome_code" is not null and "provider_event_processing"."completed_at" is not null)
	),
	CONSTRAINT "provider_event_processing_time_check" CHECK (
	  "provider_event_processing"."updated_at"=date_trunc('milliseconds',"provider_event_processing"."updated_at")
	  and ("provider_event_processing"."lease_expires_at" is null or ("provider_event_processing"."lease_expires_at"=date_trunc('milliseconds',"provider_event_processing"."lease_expires_at") and "provider_event_processing"."lease_expires_at">"provider_event_processing"."updated_at"))
	  and ("provider_event_processing"."completed_at" is null or "provider_event_processing"."completed_at"=date_trunc('milliseconds',"provider_event_processing"."completed_at"))
	),
	CONSTRAINT "provider_event_processing_text_check" CHECK (("provider_event_processing"."worker_id" is null or octet_length("provider_event_processing"."worker_id") between 1 and 255) and ("provider_event_processing"."outcome_code" is null or octet_length("provider_event_processing"."outcome_code") between 1 and 64))
);
--> statement-breakpoint
CREATE TABLE public.provider_event_attempts (
	"receipt_id" uuid NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"lease_generation" integer NOT NULL,
	"lease_token" uuid NOT NULL,
	"worker_id" text NOT NULL,
	"outcome" text NOT NULL,
	"safe_code" text NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone,
	CONSTRAINT "provider_event_attempts_receipt_id_attempt_lease_generation_pk" PRIMARY KEY("receipt_id","attempt","lease_generation"),
	CONSTRAINT "provider_event_attempts_lease_token_unique" UNIQUE("lease_token"),
	CONSTRAINT "provider_event_attempts_attempt_check" CHECK ("provider_event_attempts"."attempt">0 and "provider_event_attempts"."lease_generation">0),
	CONSTRAINT "provider_event_attempts_outcome_check" CHECK ("provider_event_attempts"."outcome" in ('processing','processed','failed_retryable','failed_terminal','lease_expired')),
	CONSTRAINT "provider_event_attempts_code_check" CHECK (octet_length("provider_event_attempts"."safe_code") between 1 and 64),
	CONSTRAINT "provider_event_attempts_provider_check" CHECK ("provider_event_attempts"."provider"='stripe'),
	CONSTRAINT "provider_event_attempts_finish_check" CHECK (("provider_event_attempts"."outcome"='processing' and "provider_event_attempts"."finished_at" is null) or ("provider_event_attempts"."outcome"<>'processing' and "provider_event_attempts"."finished_at" is not null and "provider_event_attempts"."finished_at">="provider_event_attempts"."started_at"))
);
--> statement-breakpoint
CREATE TABLE public.provider_event_effects (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_receipt_id" uuid NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"receiver_stripe_account_id" text NOT NULL,
	"account_id" uuid,
	"effect_kind" text NOT NULL,
	"target_object_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds',clock_timestamp()) NOT NULL,
	CONSTRAINT "provider_event_effects_receipt_effect_target_unique" UNIQUE("provider_receipt_id","effect_kind","target_object_id"),
	CONSTRAINT "provider_event_effects_domain_target_unique" UNIQUE("provider","receiver_stripe_account_id","effect_kind","target_object_id"),
	CONSTRAINT "provider_event_effects_command_unique" UNIQUE("command_id"),
	CONSTRAINT "provider_event_effects_exact_unique" UNIQUE("id","provider_receipt_id","effect_kind","target_object_id"),
	CONSTRAINT "provider_event_effects_provider_check" CHECK ("provider_event_effects"."provider"='stripe'),
	CONSTRAINT "provider_event_effects_kind_check" CHECK ("provider_event_effects"."effect_kind"~'^[a-z][a-z0-9_.]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE public.offers ADD CONSTRAINT "offers_current_catalog_exact_fk" FOREIGN KEY ("current_catalog_version_id","id","code") REFERENCES "public"."offer_catalog_versions"("id","offer_id","offer_code") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.offer_catalog_versions ADD CONSTRAINT "offer_catalog_versions_offer_exact_fk" FOREIGN KEY ("offer_id","offer_code") REFERENCES "public"."offers"("id","code") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.offer_price_bindings ADD CONSTRAINT "offer_price_bindings_offer_exact_fk" FOREIGN KEY ("offer_id","offer_code") REFERENCES "public"."offers"("id","code") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.offer_price_bindings ADD CONSTRAINT "offer_price_bindings_catalog_exact_fk" FOREIGN KEY ("catalog_version_id","offer_id","offer_code","catalog_version") REFERENCES "public"."offer_catalog_versions"("id","offer_id","offer_code","version") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.checkout_authorizations ADD CONSTRAINT "checkout_authorizations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.checkout_authorizations ADD CONSTRAINT "checkout_authorizations_source_command_receipt_id_api_command_receipts_id_fk" FOREIGN KEY ("source_command_receipt_id") REFERENCES "public"."api_command_receipts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.checkout_authorizations ADD CONSTRAINT "checkout_authorizations_offer_exact_fk" FOREIGN KEY ("offer_id","offer_code") REFERENCES "public"."offers"("id","code") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.checkout_authorizations ADD CONSTRAINT "checkout_authorizations_price_exact_fk" FOREIGN KEY ("price_binding_id","offer_id","catalog_version_id","environment") REFERENCES "public"."offer_price_bindings"("id","offer_id","catalog_version_id","environment") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.checkout_authorizations ADD CONSTRAINT "checkout_authorizations_price_provider_fk" FOREIGN KEY ("price_binding_id","offer_id","catalog_version_id","environment","receiver_stripe_account_id") REFERENCES "public"."offer_price_bindings"("id","offer_id","catalog_version_id","environment","stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.checkout_authorizations ADD CONSTRAINT "checkout_authorizations_public_intent_fk" FOREIGN KEY ("public_intent_id","environment","receiver_stripe_account_id") REFERENCES "public"."public_business_os_setup_intents"("id","environment","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.checkout_authorizations ADD CONSTRAINT "checkout_authorizations_setup_epoch_fk" FOREIGN KEY ("setup_epoch_id","account_id","environment","receiver_stripe_account_id") REFERENCES "public"."business_os_setup_epochs"("id","account_id","environment","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.checkout_authorizations ADD CONSTRAINT "checkout_authorizations_recurring_intent_fk" FOREIGN KEY ("recurring_intent_id","account_id","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id") REFERENCES "public"."recurring_purchase_intents"("id","account_id","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.checkout_sessions ADD CONSTRAINT "checkout_sessions_authorization_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."checkout_authorizations"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.checkout_sessions ADD CONSTRAINT "checkout_sessions_authorization_account_fk" FOREIGN KEY ("authorization_id","account_id") REFERENCES "public"."checkout_authorizations"("id","account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.checkout_sessions ADD CONSTRAINT "checkout_sessions_authorization_provider_fk" FOREIGN KEY ("authorization_id","environment","receiver_stripe_account_id") REFERENCES "public"."checkout_authorizations"("id","environment","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.checkout_provider_actions ADD CONSTRAINT "checkout_provider_actions_authorization_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."checkout_authorizations"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.checkout_provider_actions ADD CONSTRAINT "checkout_provider_actions_authorization_account_fk" FOREIGN KEY ("authorization_id","account_id") REFERENCES "public"."checkout_authorizations"("id","account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.checkout_provider_actions ADD CONSTRAINT "checkout_provider_actions_authorization_provider_fk" FOREIGN KEY ("authorization_id","environment","receiver_stripe_account_id") REFERENCES "public"."checkout_authorizations"("id","environment","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.checkout_provider_actions ADD CONSTRAINT "checkout_provider_actions_session_result_fk" FOREIGN KEY ("authorization_id","environment","receiver_stripe_account_id","provider_session_id") REFERENCES "public"."checkout_sessions"("authorization_id","environment","receiver_stripe_account_id","provider_session_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.public_business_os_setup_intents ADD CONSTRAINT "public_bos_setup_intents_price_exact_fk" FOREIGN KEY ("price_binding_id","catalog_version_id","environment","receiver_stripe_account_id") REFERENCES "public"."offer_price_bindings"("id","catalog_version_id","environment","stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.stripe_customer_creation_actions ADD CONSTRAINT "stripe_customer_creation_actions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.business_os_setup_epochs ADD CONSTRAINT "business_os_setup_epochs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.business_os_setup_epochs ADD CONSTRAINT "business_os_setup_epochs_price_provider_fk" FOREIGN KEY ("price_binding_id","catalog_version_id","environment","receiver_stripe_account_id") REFERENCES "public"."offer_price_bindings"("id","catalog_version_id","environment","stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.business_os_setup_epochs ADD CONSTRAINT "business_os_setup_epochs_public_intent_fk" FOREIGN KEY ("public_intent_id","environment","receiver_stripe_account_id") REFERENCES "public"."public_business_os_setup_intents"("id","environment","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.business_os_setup_epochs ADD CONSTRAINT "business_os_setup_epochs_source_account_fk" FOREIGN KEY ("source_registry_id","account_id") REFERENCES "public"."entitlement_sources"("id","account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.recurring_purchase_intents ADD CONSTRAINT "recurring_purchase_intents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.recurring_purchase_intents ADD CONSTRAINT "recurring_purchase_intents_price_provider_fk" FOREIGN KEY ("price_binding_id","catalog_version_id","environment","receiver_stripe_account_id") REFERENCES "public"."offer_price_bindings"("id","catalog_version_id","environment","stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.recurring_purchase_intents ADD CONSTRAINT "recurring_purchase_intents_setup_epoch_fk" FOREIGN KEY ("setup_epoch_id","account_id","environment","receiver_stripe_account_id") REFERENCES "public"."business_os_setup_epochs"("id","account_id","environment","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.recurring_purchase_intents ADD CONSTRAINT "recurring_purchase_intents_setup_purchase_fk" FOREIGN KEY ("setup_purchase_id","account_id","environment","receiver_stripe_account_id") REFERENCES "public"."purchases"("id","account_id","environment","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.recurring_purchase_intents ADD CONSTRAINT "recurring_purchase_intents_academy_source_fk" FOREIGN KEY ("academy_source_registry_id","account_id") REFERENCES "public"."entitlement_sources"("id","account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.stripe_customers ADD CONSTRAINT "stripe_customers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.stripe_customers ADD CONSTRAINT "stripe_customers_creation_action_provider_fk" FOREIGN KEY ("creation_action_id","account_id","environment","receiver_stripe_account_id","provider_customer_id") REFERENCES "public"."stripe_customer_creation_actions"("id","account_id","environment","receiver_stripe_account_id","provider_customer_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.stripe_customers ADD CONSTRAINT "stripe_customers_checkout_result_fk" FOREIGN KEY ("checkout_session_id","checkout_authorization_id","environment","receiver_stripe_account_id","provider_customer_id") REFERENCES "public"."checkout_sessions"("id","authorization_id","environment","receiver_stripe_account_id","provider_customer_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.stripe_customers ADD CONSTRAINT "stripe_customers_public_intent_fk" FOREIGN KEY ("public_intent_id","environment","receiver_stripe_account_id") REFERENCES "public"."public_business_os_setup_intents"("id","environment","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.purchases ADD CONSTRAINT "purchases_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.purchases ADD CONSTRAINT "purchases_authorization_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."checkout_authorizations"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.purchases ADD CONSTRAINT "purchases_authorization_provider_fk" FOREIGN KEY ("authorization_id","offer_code","environment","receiver_stripe_account_id") REFERENCES "public"."checkout_authorizations"("id","offer_code","environment","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.purchases ADD CONSTRAINT "purchases_source_account_fk" FOREIGN KEY ("source_registry_id","account_id") REFERENCES "public"."entitlement_sources"("id","account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.public_business_os_setup_fulfillments ADD CONSTRAINT "public_business_os_setup_fulfillments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.public_business_os_setup_fulfillments ADD CONSTRAINT "public_bos_setup_fulfillments_intent_fk" FOREIGN KEY ("public_intent_id","environment","receiver_stripe_account_id") REFERENCES "public"."public_business_os_setup_intents"("id","environment","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.public_business_os_setup_fulfillments ADD CONSTRAINT "public_bos_setup_fulfillments_epoch_fk" FOREIGN KEY ("setup_epoch_id","account_id","environment","receiver_stripe_account_id") REFERENCES "public"."business_os_setup_epochs"("id","account_id","environment","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.public_business_os_setup_fulfillments ADD CONSTRAINT "public_bos_setup_fulfillments_purchase_fk" FOREIGN KEY ("purchase_id","account_id","environment","receiver_stripe_account_id") REFERENCES "public"."purchases"("id","account_id","environment","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.public_business_os_setup_fulfillments ADD CONSTRAINT "public_bos_setup_fulfillments_source_fk" FOREIGN KEY ("source_registry_id","account_id") REFERENCES "public"."entitlement_sources"("id","account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.public_business_os_setup_fulfillments ADD CONSTRAINT "public_bos_setup_fulfillments_receipt_fk" FOREIGN KEY ("provider_receipt_id","provider","receiver_stripe_account_id") REFERENCES "public"."provider_event_receipts"("id","provider","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.purchase_payment_allocations ADD CONSTRAINT "purchase_payment_allocations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.purchase_payment_allocations ADD CONSTRAINT "purchase_payment_allocations_purchase_provider_fk" FOREIGN KEY ("purchase_id","account_id","environment","receiver_stripe_account_id") REFERENCES "public"."purchases"("id","account_id","environment","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.subscriptions ADD CONSTRAINT "subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.subscriptions ADD CONSTRAINT "subscriptions_recurring_intent_provider_fk" FOREIGN KEY ("recurring_intent_id","account_id","recurring_family","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id") REFERENCES "public"."recurring_purchase_intents"("id","account_id","family","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.subscriptions ADD CONSTRAINT "subscriptions_customer_provider_fk" FOREIGN KEY ("stripe_customer_id","account_id","environment","receiver_stripe_account_id") REFERENCES "public"."stripe_customers"("id","account_id","environment","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.subscriptions ADD CONSTRAINT "subscriptions_price_provider_fk" FOREIGN KEY ("price_binding_id","catalog_version_id","environment","receiver_stripe_account_id") REFERENCES "public"."offer_price_bindings"("id","catalog_version_id","environment","stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.subscriptions ADD CONSTRAINT "subscriptions_source_account_fk" FOREIGN KEY ("source_registry_id","account_id") REFERENCES "public"."entitlement_sources"("id","account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.subscription_schedules ADD CONSTRAINT "subscription_schedules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.subscription_schedules ADD CONSTRAINT "subscription_schedules_intent_provider_fk" FOREIGN KEY ("recurring_intent_id","account_id","recurring_family","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id") REFERENCES "public"."recurring_purchase_intents"("id","account_id","family","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.subscription_schedules ADD CONSTRAINT "subscription_schedules_subscription_provider_fk" FOREIGN KEY ("subscription_id","recurring_intent_id","account_id","recurring_family","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id") REFERENCES "public"."subscriptions"("id","recurring_intent_id","account_id","recurring_family","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.invoices ADD CONSTRAINT "invoices_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.invoices ADD CONSTRAINT "invoices_subscription_provider_fk" FOREIGN KEY ("subscription_id","recurring_intent_id","account_id","recurring_family","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id") REFERENCES "public"."subscriptions"("id","recurring_intent_id","account_id","recurring_family","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.invoice_line_allocations ADD CONSTRAINT "invoice_line_allocations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.invoice_line_allocations ADD CONSTRAINT "invoice_line_allocations_invoice_provider_fk" FOREIGN KEY ("invoice_id","account_id","subscription_id","recurring_intent_id","recurring_family","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id") REFERENCES "public"."invoices"("id","account_id","subscription_id","recurring_intent_id","recurring_family","offer_code","environment","receiver_stripe_account_id","catalog_version_id","price_binding_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.invoice_line_allocations ADD CONSTRAINT "invoice_line_allocations_price_provider_fk" FOREIGN KEY ("price_binding_id","catalog_version_id","environment","receiver_stripe_account_id") REFERENCES "public"."offer_price_bindings"("id","catalog_version_id","environment","stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.controlled_payment_authorizations ADD CONSTRAINT "controlled_payment_authorizations_creator_staff_id_staff_identities_id_fk" FOREIGN KEY ("creator_staff_id") REFERENCES "public"."staff_identities"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.controlled_payment_authorizations ADD CONSTRAINT "controlled_payment_authorizations_price_provider_fk" FOREIGN KEY ("price_binding_id","catalog_version_id","environment","receiver_stripe_account_id") REFERENCES "public"."offer_price_bindings"("id","catalog_version_id","environment","stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.controlled_payment_authorizations ADD CONSTRAINT "controlled_payment_authorizations_checkout_provider_fk" FOREIGN KEY ("checkout_authorization_id","environment","receiver_stripe_account_id") REFERENCES "public"."checkout_authorizations"("id","environment","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.claim_tokens ADD CONSTRAINT "claim_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.claim_tokens ADD CONSTRAINT "claim_tokens_purchase_account_fk" FOREIGN KEY ("purchase_id","account_id") REFERENCES "public"."purchases"("id","account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.pending_claim_sessions ADD CONSTRAINT "pending_claim_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.pending_claim_sessions ADD CONSTRAINT "pending_claim_sessions_claim_account_fk" FOREIGN KEY ("claim_token_id","account_id") REFERENCES "public"."claim_tokens"("id","account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.secure_link_deliveries ADD CONSTRAINT "secure_link_deliveries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.secure_link_deliveries ADD CONSTRAINT "secure_link_deliveries_claim_account_fk" FOREIGN KEY ("claim_token_id","account_id") REFERENCES "public"."claim_tokens"("id","account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.secure_link_deliveries ADD CONSTRAINT "secure_link_deliveries_invitation_account_fk" FOREIGN KEY ("seat_invitation_id","account_id") REFERENCES "public"."seat_invitations"("id","account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.secure_link_deliveries ADD CONSTRAINT "secure_link_deliveries_controlled_payment_fk" FOREIGN KEY ("controlled_payment_authorization_id") REFERENCES "public"."controlled_payment_authorizations"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.account_onboarding ADD CONSTRAINT "account_onboarding_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.account_onboarding_priorities ADD CONSTRAINT "account_onboarding_priorities_onboarding_account_fk" FOREIGN KEY ("account_id","onboarding_version") REFERENCES "public"."account_onboarding"("account_id","version") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.provider_event_processing ADD CONSTRAINT "provider_event_processing_receipt_owner_fk" FOREIGN KEY ("receipt_id","provider","receiver_stripe_account_id") REFERENCES "public"."provider_event_receipts"("id","provider","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.provider_event_attempts ADD CONSTRAINT "provider_event_attempts_processing_fence_fk" FOREIGN KEY ("receipt_id","provider","receiver_stripe_account_id") REFERENCES "public"."provider_event_processing"("receipt_id","provider","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.provider_event_effects ADD CONSTRAINT "provider_event_effects_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE public.provider_event_effects ADD CONSTRAINT "provider_event_effects_receipt_owner_fk" FOREIGN KEY ("provider_receipt_id","provider","receiver_stripe_account_id") REFERENCES "public"."provider_event_receipts"("id","provider","receiver_stripe_account_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "offer_price_bindings_provider_price_unique" ON public.offer_price_bindings USING btree ("environment","stripe_account_id","stripe_price_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "offer_price_bindings_active_role_unique" ON public.offer_price_bindings USING btree ("offer_id","catalog_version_id","environment","price_role") WHERE "offer_price_bindings"."enabled_at" is not null and "offer_price_bindings"."retired_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "public_bos_setup_intents_one_blocking_guard" ON public.public_business_os_setup_intents USING btree ("environment","purchaser_guard_hmac","family") WHERE "public_business_os_setup_intents"."state" in ('checkout_create_pending','checkout_open','async_payment_pending','paid_processing','paid_consumed','refund_pending','dispute_open','terminal_security');
--> statement-breakpoint
CREATE INDEX "public_bos_setup_intents_cleanup_idx" ON public.public_business_os_setup_intents USING btree ("expires_at","id") WHERE "public_business_os_setup_intents"."state"='terminal_abandoned_unpaid' and "public_business_os_setup_intents"."security_hold_at" is null and "public_business_os_setup_intents"."legal_hold_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "business_os_setup_epochs_one_blocking_account" ON public.business_os_setup_epochs USING btree ("account_id") WHERE "business_os_setup_epochs"."state" in ('checkout_create_pending','checkout_open','async_payment_pending','paid','refund_pending','dispute_open');
--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_purchase_intents_one_nonterminal_family" ON public.recurring_purchase_intents USING btree ("account_id","family") WHERE "recurring_purchase_intents"."state" in ('provider_call_pending','checkout_open','setup_succeeded','schedule_pending','subscription_pending','active','grace','cancellation_pending');
--> statement-breakpoint
CREATE UNIQUE INDEX "controlled_payment_authorizations_one_live_release" ON public.controlled_payment_authorizations USING btree ("release_sha") WHERE "controlled_payment_authorizations"."state" in ('issued','checkout_open','paid');
--> statement-breakpoint
CREATE INDEX "provider_event_processing_claim_idx" ON public.provider_event_processing USING btree ("status","lease_expires_at","receipt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "account_course_accesses_active_source_course_unique" ON public.account_course_accesses USING btree ("account_id","entitlement_source_id","course_id") WHERE status='active';
--> statement-breakpoint
INSERT INTO public.offers(
  id,code,family,purchase_model,state,display_currency,display_unit_amount,
  display_recurring_unit_amount,readiness_policy
) VALUES
  ('00000000-0000-4000-8000-000000001401','scorecard','scorecard','free','paused','usd',0,NULL,'scorecard.v1'),
  ('00000000-0000-4000-8000-000000001402','self_paced','academy','one_time','paused','usd',39900,NULL,'academy-content.v1'),
  ('00000000-0000-4000-8000-000000001403','guided_pilot','academy','one_time','paused','usd',75000,NULL,'pilot-authorization.v1'),
  ('00000000-0000-4000-8000-000000001404','operator_club_monthly','operator_club','recurring','paused','usd',5900,NULL,'academy-eligibility.v1'),
  ('00000000-0000-4000-8000-000000001405','operator_club_annual','operator_club','recurring','paused','usd',59000,NULL,'academy-eligibility.v1'),
  ('00000000-0000-4000-8000-000000001406','business_os','business_os','two_stage','paused','usd',99900,19900,'business-os-readiness.v1');
COMMENT ON TABLE public.purchases IS 'commerce financial authority; certificateNonAuthority=true';
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_row_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp
AS $guard$
DECLARE
  transition_name text := current_setting('app.commerce_transition',true);
  cleanup_active boolean :=
    current_setting('app.commerce_cleanup_transition',true)='active';
BEGIN
  IF TG_OP='TRUNCATE' THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',
      MESSAGE='COMMERCE_ROW_IMMUTABLE';
  END IF;

  IF transition_name IS DISTINCT FROM TG_TABLE_NAME THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',
      MESSAGE='COMMERCE_ROW_IMMUTABLE';
  END IF;

  IF TG_OP='DELETE' THEN
    IF TG_TABLE_NAME='account_onboarding_priorities' THEN
      RETURN OLD;
    END IF;
    IF NOT cleanup_active OR TG_TABLE_NAME NOT IN (
      'checkout_provider_actions',
      'checkout_sessions',
      'checkout_authorizations',
      'stripe_customer_creation_actions',
      'public_business_os_setup_intents'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE='55000',
        MESSAGE='COMMERCE_ROW_IMMUTABLE';
    END IF;
    RETURN OLD;
  END IF;

  IF (to_jsonb(OLD)->>'account_id')
      IS DISTINCT FROM (to_jsonb(NEW)->>'account_id') THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',
      MESSAGE='COMMERCE_ACCOUNT_IMMUTABLE';
  END IF;

  RETURN NEW;
END
$guard$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_row_guard_v1()
FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker,syntholo_system_api;
--> statement-breakpoint
CREATE TRIGGER offers_guard
  BEFORE UPDATE OR DELETE ON public.offers
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER offers_truncate_guard
  BEFORE TRUNCATE ON public.offers
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER offer_catalog_versions_guard
  BEFORE UPDATE OR DELETE ON public.offer_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER offer_catalog_versions_truncate_guard
  BEFORE TRUNCATE ON public.offer_catalog_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER offer_price_bindings_guard
  BEFORE UPDATE OR DELETE ON public.offer_price_bindings
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER offer_price_bindings_truncate_guard
  BEFORE TRUNCATE ON public.offer_price_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER checkout_authorizations_guard
  BEFORE UPDATE OR DELETE ON public.checkout_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER checkout_authorizations_truncate_guard
  BEFORE TRUNCATE ON public.checkout_authorizations
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER checkout_sessions_guard
  BEFORE UPDATE OR DELETE ON public.checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER checkout_sessions_truncate_guard
  BEFORE TRUNCATE ON public.checkout_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER checkout_provider_actions_guard
  BEFORE UPDATE OR DELETE ON public.checkout_provider_actions
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER checkout_provider_actions_truncate_guard
  BEFORE TRUNCATE ON public.checkout_provider_actions
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER public_business_os_setup_intents_guard
  BEFORE UPDATE OR DELETE ON public.public_business_os_setup_intents
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER public_business_os_setup_intents_truncate_guard
  BEFORE TRUNCATE ON public.public_business_os_setup_intents
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER stripe_customer_creation_actions_guard
  BEFORE UPDATE OR DELETE ON public.stripe_customer_creation_actions
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER stripe_customer_creation_actions_truncate_guard
  BEFORE TRUNCATE ON public.stripe_customer_creation_actions
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER business_os_setup_epochs_guard
  BEFORE UPDATE OR DELETE ON public.business_os_setup_epochs
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER business_os_setup_epochs_truncate_guard
  BEFORE TRUNCATE ON public.business_os_setup_epochs
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER recurring_purchase_intents_guard
  BEFORE UPDATE OR DELETE ON public.recurring_purchase_intents
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER recurring_purchase_intents_truncate_guard
  BEFORE TRUNCATE ON public.recurring_purchase_intents
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER stripe_customers_guard
  BEFORE UPDATE OR DELETE ON public.stripe_customers
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER stripe_customers_truncate_guard
  BEFORE TRUNCATE ON public.stripe_customers
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER purchases_guard
  BEFORE UPDATE OR DELETE ON public.purchases
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER purchases_truncate_guard
  BEFORE TRUNCATE ON public.purchases
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER public_business_os_setup_fulfillments_guard
  BEFORE UPDATE OR DELETE ON public.public_business_os_setup_fulfillments
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER public_business_os_setup_fulfillments_truncate_guard
  BEFORE TRUNCATE ON public.public_business_os_setup_fulfillments
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER purchase_payment_allocations_guard
  BEFORE UPDATE OR DELETE ON public.purchase_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER purchase_payment_allocations_truncate_guard
  BEFORE TRUNCATE ON public.purchase_payment_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER subscriptions_guard
  BEFORE UPDATE OR DELETE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER subscriptions_truncate_guard
  BEFORE TRUNCATE ON public.subscriptions
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER subscription_schedules_guard
  BEFORE UPDATE OR DELETE ON public.subscription_schedules
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER subscription_schedules_truncate_guard
  BEFORE TRUNCATE ON public.subscription_schedules
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER invoices_guard
  BEFORE UPDATE OR DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER invoices_truncate_guard
  BEFORE TRUNCATE ON public.invoices
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER invoice_line_allocations_guard
  BEFORE UPDATE OR DELETE ON public.invoice_line_allocations
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER invoice_line_allocations_truncate_guard
  BEFORE TRUNCATE ON public.invoice_line_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER controlled_payment_authorizations_guard
  BEFORE UPDATE OR DELETE ON public.controlled_payment_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER controlled_payment_authorizations_truncate_guard
  BEFORE TRUNCATE ON public.controlled_payment_authorizations
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER claim_tokens_guard
  BEFORE UPDATE OR DELETE ON public.claim_tokens
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER claim_tokens_truncate_guard
  BEFORE TRUNCATE ON public.claim_tokens
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER pending_claim_sessions_guard
  BEFORE UPDATE OR DELETE ON public.pending_claim_sessions
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER pending_claim_sessions_truncate_guard
  BEFORE TRUNCATE ON public.pending_claim_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER secure_link_deliveries_guard
  BEFORE UPDATE OR DELETE ON public.secure_link_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER secure_link_deliveries_truncate_guard
  BEFORE TRUNCATE ON public.secure_link_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER account_onboarding_guard
  BEFORE UPDATE OR DELETE ON public.account_onboarding
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER account_onboarding_truncate_guard
  BEFORE TRUNCATE ON public.account_onboarding
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER account_onboarding_priorities_guard
  BEFORE UPDATE OR DELETE ON public.account_onboarding_priorities
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER account_onboarding_priorities_truncate_guard
  BEFORE TRUNCATE ON public.account_onboarding_priorities
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER provider_event_processing_guard
  BEFORE UPDATE OR DELETE ON public.provider_event_processing
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER provider_event_processing_truncate_guard
  BEFORE TRUNCATE ON public.provider_event_processing
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER provider_event_attempts_guard
  BEFORE UPDATE OR DELETE ON public.provider_event_attempts
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER provider_event_attempts_truncate_guard
  BEFORE TRUNCATE ON public.provider_event_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE TRIGGER provider_event_effects_guard
  BEFORE UPDATE OR DELETE ON public.provider_event_effects
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
CREATE TRIGGER provider_event_effects_truncate_guard
  BEFORE TRUNCATE ON public.provider_event_effects
  FOR EACH STATEMENT EXECUTE FUNCTION public.syntholo_commerce_row_guard_v1();
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_stage_checkout_action_v1(
  p_authorization_id uuid,
  p_request_fingerprint text,
  p_now timestamptz
)
RETURNS TABLE(
  replayed boolean,
  action_id uuid,
  provider_idempotency_key text,
  status text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $stage_checkout_action$
DECLARE
  target_authorization public.checkout_authorizations%ROWTYPE;
  existing public.checkout_provider_actions%ROWTYPE;
  expected_action_kind text;
  expected_provider_key text;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_authorization_id IS NULL
    OR p_request_fingerprint IS NULL
    OR p_request_fingerprint!~'^[0-9a-f]{64}$'
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE='22023',MESSAGE='COMMERCE_CHECKOUT_ACTION_INPUT_INVALID';
  END IF;

  SELECT authorization_row.* INTO target_authorization
  FROM public.checkout_authorizations authorization_row
  WHERE authorization_row.id=p_authorization_id
  FOR UPDATE;
  IF NOT FOUND
    OR coalesce(target_authorization.account_id::text,'')
      IS DISTINCT FROM coalesce(current_setting('app.account_id',true),'')
  THEN
    RAISE EXCEPTION USING
      ERRCODE='42501',MESSAGE='COMMERCE_CHECKOUT_ACTION_NOT_AUTHORIZED';
  END IF;

  expected_action_kind:=CASE WHEN target_authorization.public_intent_id IS NULL
    THEN 'create_checkout_session'
    ELSE 'create_business_os_setup_checkout'
  END;
  SELECT action_row.* INTO existing
  FROM public.checkout_provider_actions action_row
  WHERE action_row.authorization_id=target_authorization.id
    AND action_row.action_kind=expected_action_kind
  FOR UPDATE;
  IF FOUND THEN
    expected_provider_key:=CASE expected_action_kind
      WHEN 'create_checkout_session' THEN 'checkout:'||p_authorization_id::text
      ELSE 'business_os_setup_checkout:'||existing.id::text
    END;
    IF existing.account_id IS DISTINCT FROM target_authorization.account_id
      OR existing.environment IS DISTINCT FROM target_authorization.environment
      OR existing.receiver_stripe_account_id
        IS DISTINCT FROM target_authorization.receiver_stripe_account_id
      OR existing.provider_idempotency_key IS DISTINCT FROM expected_provider_key
      OR existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
    THEN
      RAISE EXCEPTION USING
        ERRCODE='23514',
        MESSAGE='COMMERCE_CHECKOUT_ACTION_RECONCILIATION_REQUIRED';
    END IF;
    replayed:=true;
    action_id:=existing.id;
    provider_idempotency_key:=existing.provider_idempotency_key;
    status:=existing.status;
    RETURN NEXT;
    RETURN;
  END IF;

  IF target_authorization.status<>'provider_call_pending'
    OR target_authorization.expires_at<=p_now
    OR NOT EXISTS(
      SELECT 1
      FROM public.offers offer
      JOIN public.offer_catalog_versions catalog
        ON catalog.id=target_authorization.catalog_version_id
       AND catalog.offer_id=target_authorization.offer_id
       AND catalog.offer_code=target_authorization.offer_code
      JOIN public.offer_price_bindings binding
        ON binding.id=target_authorization.price_binding_id
       AND binding.offer_id=target_authorization.offer_id
       AND binding.catalog_version_id=target_authorization.catalog_version_id
       AND binding.environment=target_authorization.environment
       AND binding.stripe_account_id=target_authorization.receiver_stripe_account_id
      WHERE offer.id=target_authorization.offer_id
        AND offer.code=target_authorization.offer_code
        AND offer.state='enabled'
        AND offer.current_catalog_version_id=target_authorization.catalog_version_id
        AND catalog.state='published'
        AND binding.enabled_at IS NOT NULL
        AND binding.retired_at IS NULL
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_CHECKOUT_ACTION_NOT_ELIGIBLE';
  END IF;

  action_id:=gen_random_uuid();
  provider_idempotency_key:=CASE expected_action_kind
    WHEN 'create_checkout_session' THEN 'checkout:'||p_authorization_id::text
    ELSE 'business_os_setup_checkout:'||action_id::text
  END;
  INSERT INTO public.checkout_provider_actions(
    id,authorization_id,account_id,environment,receiver_stripe_account_id,
    action_kind,provider_idempotency_key,request_fingerprint,status,
    provider_session_id,attempts,last_error_code,created_at,updated_at
  ) VALUES(
    action_id,target_authorization.id,target_authorization.account_id,target_authorization.environment,
    target_authorization.receiver_stripe_account_id,expected_action_kind,
    provider_idempotency_key,p_request_fingerprint,'pending',NULL,0,NULL,p_now,p_now
  );
  replayed:=false;
  status:='pending';
  RETURN NEXT;
END
$stage_checkout_action$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_stage_checkout_action_v1(
  uuid,text,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_stage_checkout_action_v1(
  uuid,text,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_reserve_public_bos_setup_v1(
  p_principal_id text,p_idempotency_key text,p_environment text,
  p_receiver_stripe_account_id text,p_catalog_version_id uuid,
  p_price_binding_id uuid,p_purchaser_guard_hmac bytea,
  p_semantic_request_hmac bytea,p_equality_key_id text,
  p_command_digest_key_id text,p_contact_ciphertext bytea,
  p_contact_nonce bytea,p_contact_tag bytea,p_contact_key_id text,
  p_business_name_ciphertext bytea,p_business_name_nonce bytea,
  p_business_name_tag bytea,p_business_name_key_id text,
  p_business_name_content_hash text,
  p_account_name_schema_version text,p_request_hash text,
  p_integration_identifier text,p_policy_versions jsonb,
  p_expires_at timestamptz,p_now timestamptz
)
RETURNS TABLE(
  replayed boolean,public_intent_id uuid,authorization_id uuid,action_id uuid,
  provider_idempotency_key text,state text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $reserve_public_bos$
DECLARE
  receipt public.api_command_receipts%ROWTYPE;
  existing public.public_business_os_setup_intents%ROWTYPE;
  catalog record;
  action record;
  prior record;
  response_payload jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_principal_id IS NULL OR p_principal_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR p_idempotency_key IS NULL OR p_idempotency_key!~'^[A-Za-z0-9._~-]{16,128}$'
    OR p_environment IS NULL OR p_environment NOT IN('test','staging','production')
    OR p_receiver_stripe_account_id IS NULL
    OR p_receiver_stripe_account_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    OR p_catalog_version_id IS NULL OR p_price_binding_id IS NULL
    OR octet_length(p_purchaser_guard_hmac)<>32
    OR octet_length(p_semantic_request_hmac)<>32
    OR p_equality_key_id IS NULL OR octet_length(p_equality_key_id) NOT BETWEEN 1 AND 128
    OR p_command_digest_key_id IS NULL OR octet_length(p_command_digest_key_id) NOT BETWEEN 1 AND 128
    OR octet_length(p_contact_ciphertext) NOT BETWEEN 1 AND 4096
    OR octet_length(p_contact_nonce)<>12 OR octet_length(p_contact_tag)<>16
    OR p_contact_key_id IS NULL OR octet_length(p_contact_key_id) NOT BETWEEN 1 AND 128
    OR octet_length(p_business_name_ciphertext) NOT BETWEEN 1 AND 4096
    OR octet_length(p_business_name_nonce)<>12 OR octet_length(p_business_name_tag)<>16
    OR p_business_name_key_id IS NULL OR octet_length(p_business_name_key_id) NOT BETWEEN 1 AND 128
    OR p_business_name_content_hash IS NULL
    OR p_business_name_content_hash!~'^[0-9a-f]{64}$'
    OR p_account_name_schema_version IS DISTINCT FROM 'account_name_v1'
    OR p_request_hash IS NULL OR p_request_hash!~'^[0-9a-f]{64}$'
    OR p_integration_identifier IS NULL
    OR p_integration_identifier!~'^syntholo_[A-Za-z]{8}$'
    OR p_policy_versions IS NULL OR jsonb_typeof(p_policy_versions)<>'object'
    OR p_policy_versions='{}'::jsonb OR octet_length(p_policy_versions::text)>4096
    OR p_expires_at IS NULL OR NOT isfinite(p_expires_at)
    OR p_expires_at<>date_trunc('milliseconds',p_expires_at) OR p_expires_at<=p_now
    OR p_now IS NULL OR NOT isfinite(p_now) OR p_now<>date_trunc('milliseconds',p_now)
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
    OR nullif(current_setting('app.correlation_id',true),'') IS NULL
    OR nullif(current_setting('app.correlation_id',true),'')
      !~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR nullif(current_setting('app.account_id',true),'') IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_PUBLIC_BOS_INPUT_INVALID';
  END IF;
  INSERT INTO public.api_command_receipts(
    principal_kind,principal_id,method,route_template,idempotency_key,
    request_hash,status,expires_at,created_at
  ) VALUES(
    'anonymous',p_principal_id,'POST','/v1/public/checkouts',p_idempotency_key,
    p_request_hash,'in_progress',p_now+interval '30 days',p_now
  ) ON CONFLICT(principal_kind,principal_id,method,route_template,idempotency_key)
    DO NOTHING;
  SELECT receipt_row.* INTO receipt FROM public.api_command_receipts receipt_row
  WHERE receipt_row.principal_kind='anonymous'
    AND receipt_row.principal_id=p_principal_id AND receipt_row.method='POST'
    AND receipt_row.route_template='/v1/public/checkouts'
    AND receipt_row.idempotency_key=p_idempotency_key FOR UPDATE;
  IF receipt.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='IDEMPOTENCY_KEY_REUSED';
  END IF;
  IF receipt.status='completed' THEN
    IF receipt.response IS NULL
      OR coalesce(receipt.response->>'publicIntentId','')
        !~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      RAISE EXCEPTION USING
        ERRCODE='55000',MESSAGE='COMMERCE_PUBLIC_BOS_RECONCILIATION_REQUIRED';
    END IF;
    SELECT intent.*,authorization_row.id authorization_id,
      authorization_row.principal_id authorization_principal_id,
      authorization_row.request_hash authorization_request_hash,
      authorization_row.business_name_content_hash,
      authorization_row.integration_identifier,
      authorization_row.policy_versions,authorization_row.expires_at authorization_expires_at,
      action_row.id action_id,action_row.provider_idempotency_key
    INTO prior
    FROM public.public_business_os_setup_intents intent
    JOIN public.checkout_authorizations authorization_row
      ON authorization_row.public_intent_id=intent.id
    JOIN public.checkout_provider_actions action_row
      ON action_row.authorization_id=authorization_row.id
     AND action_row.action_kind='create_business_os_setup_checkout'
    WHERE intent.id=(receipt.response->>'publicIntentId')::uuid
    FOR UPDATE OF intent,authorization_row,action_row;
    IF NOT FOUND OR prior.environment IS DISTINCT FROM p_environment
      OR prior.receiver_stripe_account_id IS DISTINCT FROM p_receiver_stripe_account_id
      OR prior.purchaser_guard_hmac IS DISTINCT FROM p_purchaser_guard_hmac
      OR prior.semantic_request_hmac IS DISTINCT FROM p_semantic_request_hmac
      OR prior.equality_key_id IS DISTINCT FROM p_equality_key_id
      OR prior.command_digest_key_id IS DISTINCT FROM p_command_digest_key_id
      OR prior.catalog_version_id IS DISTINCT FROM p_catalog_version_id
      OR prior.price_binding_id IS DISTINCT FROM p_price_binding_id
      OR prior.authorization_principal_id IS DISTINCT FROM p_principal_id
      OR prior.authorization_request_hash IS DISTINCT FROM p_request_hash
      OR prior.business_name_content_hash IS DISTINCT FROM p_business_name_content_hash
      OR prior.integration_identifier IS DISTINCT FROM p_integration_identifier
      OR prior.policy_versions IS DISTINCT FROM p_policy_versions
      OR prior.authorization_expires_at IS DISTINCT FROM p_expires_at
    THEN
      RAISE EXCEPTION USING
        ERRCODE='23514',MESSAGE='COMMERCE_PUBLIC_BOS_RECONCILIATION_REQUIRED';
    END IF;
    replayed:=true;public_intent_id:=prior.id;
    authorization_id:=prior.authorization_id;action_id:=prior.action_id;
    provider_idempotency_key:=prior.provider_idempotency_key;state:=prior.state;
    RETURN NEXT;RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'commerce:public-bos-guard:'||encode(p_purchaser_guard_hmac,'hex'),0
  ));
  SELECT intent.* INTO existing FROM public.public_business_os_setup_intents intent
  WHERE intent.environment=p_environment AND intent.family='business_os_setup'
    AND intent.purchaser_guard_hmac=p_purchaser_guard_hmac
    AND intent.state IN(
      'checkout_create_pending','checkout_open','async_payment_pending',
      'paid_processing','paid_consumed','refund_pending','dispute_open','terminal_security'
    )
  FOR UPDATE;
  IF FOUND THEN
    IF existing.semantic_request_hmac IS DISTINCT FROM p_semantic_request_hmac THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_PUBLIC_BOS_SETUP_EXISTS';
    END IF;
    SELECT authorization_row.id,action_row.id,action_row.provider_idempotency_key
    INTO authorization_id,action_id,provider_idempotency_key
    FROM public.checkout_authorizations authorization_row
    JOIN public.checkout_provider_actions action_row
      ON action_row.authorization_id=authorization_row.id
     AND action_row.action_kind='create_business_os_setup_checkout'
    WHERE authorization_row.public_intent_id=existing.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='COMMERCE_PUBLIC_BOS_RECONCILIATION_REQUIRED';
    END IF;
    replayed:=true;public_intent_id:=existing.id;state:=existing.state;
  ELSE
    SELECT offer.id offer_id,catalog_version.version catalog_version
    INTO catalog
    FROM public.offers offer
    JOIN public.offer_catalog_versions catalog_version
      ON catalog_version.id=p_catalog_version_id
     AND catalog_version.offer_id=offer.id AND catalog_version.offer_code='business_os'
    JOIN public.offer_price_bindings binding
      ON binding.id=p_price_binding_id AND binding.offer_id=offer.id
     AND binding.catalog_version_id=catalog_version.id
     AND binding.environment=p_environment
     AND binding.stripe_account_id=p_receiver_stripe_account_id
    WHERE offer.code='business_os' AND offer.state='enabled'
      AND offer.current_catalog_version_id=catalog_version.id
      AND catalog_version.state='published' AND binding.price_role='business_os_setup'
      AND binding.unit_amount=99900 AND binding.currency='usd'
      AND binding.enabled_at IS NOT NULL AND binding.retired_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='COMMERCE_PUBLIC_BOS_NOT_ELIGIBLE';
    END IF;
    INSERT INTO public.public_business_os_setup_intents(
      environment,receiver_stripe_account_id,family,purchaser_guard_hmac,
      semantic_request_hmac,email_normalization_version,equality_key_id,
      command_digest_key_id,contact_ciphertext,contact_nonce,contact_tag,
      contact_key_id,business_name_ciphertext,business_name_nonce,
      business_name_tag,business_name_key_id,catalog_version_id,price_binding_id,
      state,expires_at,created_at,updated_at
    ) VALUES(
      p_environment,p_receiver_stripe_account_id,'business_os_setup',
      p_purchaser_guard_hmac,p_semantic_request_hmac,'email_v1',p_equality_key_id,
      p_command_digest_key_id,p_contact_ciphertext,p_contact_nonce,p_contact_tag,
      p_contact_key_id,p_business_name_ciphertext,p_business_name_nonce,
      p_business_name_tag,p_business_name_key_id,p_catalog_version_id,
      p_price_binding_id,'checkout_create_pending',p_expires_at,p_now,p_now
    ) RETURNING id,public_business_os_setup_intents.state
      INTO public_intent_id,state;
    INSERT INTO public.checkout_authorizations(
      account_id,principal_kind,principal_id,offer_id,offer_code,
      catalog_version_id,price_binding_id,environment,receiver_stripe_account_id,
      public_intent_id,contact_ciphertext,contact_nonce,contact_tag,contact_key_id,
      business_name_ciphertext,business_name_nonce,business_name_tag,
      business_name_key_id,business_name_content_hash,
      account_name_schema_version,source_command_receipt_id,
      request_hash,integration_identifier,policy_versions,status,expires_at,
      created_at,updated_at
    ) VALUES(
      NULL,'anonymous',p_principal_id,catalog.offer_id,'business_os',
      p_catalog_version_id,p_price_binding_id,p_environment,
      p_receiver_stripe_account_id,public_intent_id,p_contact_ciphertext,
      p_contact_nonce,p_contact_tag,p_contact_key_id,p_business_name_ciphertext,
      p_business_name_nonce,p_business_name_tag,p_business_name_key_id,
      p_business_name_content_hash,p_account_name_schema_version,receipt.id,p_request_hash,
      p_integration_identifier,p_policy_versions,'provider_call_pending',
      p_expires_at,p_now,p_now
    ) RETURNING id INTO authorization_id;
    SELECT * INTO action FROM public.syntholo_commerce_stage_checkout_action_v1(
      authorization_id,p_request_hash,p_now
    );
    action_id:=action.action_id;
    provider_idempotency_key:=action.provider_idempotency_key;
    replayed:=false;
  END IF;
  response_payload:=jsonb_build_object(
    'publicIntentId',public_intent_id,'authorizationId',authorization_id,
    'actionId',action_id,'state',state
  );
  UPDATE public.api_command_receipts receipt_row
  SET status='completed',response_status=201,response=response_payload,
    completed_at=p_now
  WHERE receipt_row.id=receipt.id AND receipt_row.status='in_progress';
  RETURN NEXT;
END
$reserve_public_bos$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_reserve_public_bos_setup_v1(
  text,text,text,text,uuid,uuid,bytea,bytea,text,text,bytea,bytea,bytea,text,
  bytea,bytea,bytea,text,text,text,text,text,jsonb,timestamptz,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_reserve_public_bos_setup_v1(
  text,text,text,text,uuid,uuid,bytea,bytea,text,text,bytea,bytea,bytea,text,
  bytea,bytea,bytea,text,text,text,text,text,jsonb,timestamptz,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_reserve_public_self_paced_v1(
  p_principal_id text,p_idempotency_key text,p_environment text,
  p_receiver_stripe_account_id text,p_catalog_version_id uuid,
  p_price_binding_id uuid,p_contact_email_fingerprint bytea,
  p_contact_ciphertext bytea,p_contact_nonce bytea,p_contact_tag bytea,
  p_contact_key_id text,p_business_name_ciphertext bytea,
  p_business_name_nonce bytea,p_business_name_tag bytea,
  p_business_name_key_id text,p_business_name_content_hash text,
  p_account_name_schema_version text,p_request_hash text,
  p_integration_identifier text,p_policy_versions jsonb,
  p_expires_at timestamptz,p_now timestamptz
)
RETURNS TABLE(
  replayed boolean,authorization_id uuid,action_id uuid,
  provider_idempotency_key text,state text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $reserve_public_self_paced$
DECLARE
  receipt public.api_command_receipts%ROWTYPE;
  prior record;
  catalog record;
  action record;
  ready_course_count integer;
  response_payload jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_principal_id IS NULL
    OR p_principal_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR p_idempotency_key IS NULL
    OR p_idempotency_key!~'^[A-Za-z0-9._~-]{16,128}$'
    OR p_environment IS NULL OR p_environment NOT IN('test','staging','production')
    OR p_receiver_stripe_account_id IS NULL
    OR p_receiver_stripe_account_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    OR p_catalog_version_id IS NULL OR p_price_binding_id IS NULL
    OR octet_length(p_contact_email_fingerprint)<>32
    OR octet_length(p_contact_ciphertext) NOT BETWEEN 1 AND 4096
    OR octet_length(p_contact_nonce)<>12 OR octet_length(p_contact_tag)<>16
    OR p_contact_key_id IS NULL
    OR octet_length(p_contact_key_id) NOT BETWEEN 1 AND 128
    OR octet_length(p_business_name_ciphertext) NOT BETWEEN 1 AND 4096
    OR octet_length(p_business_name_nonce)<>12
    OR octet_length(p_business_name_tag)<>16
    OR p_business_name_key_id IS NULL
    OR octet_length(p_business_name_key_id) NOT BETWEEN 1 AND 128
    OR p_business_name_content_hash IS NULL
    OR p_business_name_content_hash!~'^[0-9a-f]{64}$'
    OR p_account_name_schema_version IS DISTINCT FROM 'account_name_v1'
    OR p_request_hash IS NULL OR p_request_hash!~'^[0-9a-f]{64}$'
    OR p_integration_identifier IS NULL
    OR p_integration_identifier!~'^syntholo_[A-Za-z]{8}$'
    OR p_policy_versions IS NULL OR jsonb_typeof(p_policy_versions)<>'object'
    OR NOT (p_policy_versions ?& ARRAY['terms','privacy','refund'])
    OR p_policy_versions-ARRAY['terms','privacy','refund']::text[]<>'{}'::jsonb
    OR EXISTS(
      SELECT 1 FROM jsonb_each(p_policy_versions) policy(key,value)
      WHERE jsonb_typeof(policy.value)<>'string'
        OR octet_length(policy.value#>>'{}') NOT BETWEEN 1 AND 255
    )
    OR octet_length(p_policy_versions::text)>4096
    OR p_expires_at IS NULL OR NOT isfinite(p_expires_at)
    OR p_expires_at<>date_trunc('milliseconds',p_expires_at)
    OR p_expires_at<=p_now OR p_expires_at>p_now+interval '24 hours'
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
    OR nullif(current_setting('app.account_id',true),'') IS NOT NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE='22023',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_INPUT_INVALID';
  END IF;

  INSERT INTO public.api_command_receipts(
    principal_kind,principal_id,method,route_template,idempotency_key,
    request_hash,status,expires_at,created_at
  ) VALUES(
    'anonymous',p_principal_id,'POST','/v1/public/checkouts',p_idempotency_key,
    p_request_hash,'in_progress',p_now+interval '30 days',p_now
  ) ON CONFLICT(principal_kind,principal_id,method,route_template,idempotency_key)
    DO NOTHING;
  SELECT receipt_row.* INTO receipt
  FROM public.api_command_receipts receipt_row
  WHERE receipt_row.principal_kind='anonymous'
    AND receipt_row.principal_id=p_principal_id
    AND receipt_row.method='POST'
    AND receipt_row.route_template='/v1/public/checkouts'
    AND receipt_row.idempotency_key=p_idempotency_key
  FOR UPDATE;
  IF receipt.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='IDEMPOTENCY_KEY_REUSED';
  END IF;
  IF receipt.status='completed' THEN
    IF receipt.response IS NULL
      OR coalesce(receipt.response->>'authorizationId','')
        !~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      RAISE EXCEPTION USING
        ERRCODE='55000',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_RECONCILIATION_REQUIRED';
    END IF;
    SELECT authorization_row.*,action_row.id action_id,
      action_row.provider_idempotency_key
    INTO prior
    FROM public.checkout_authorizations authorization_row
    JOIN public.checkout_provider_actions action_row
      ON action_row.authorization_id=authorization_row.id
     AND action_row.action_kind='create_checkout_session'
    WHERE authorization_row.id=(receipt.response->>'authorizationId')::uuid
    FOR UPDATE OF authorization_row,action_row;
    IF NOT FOUND OR prior.account_id IS NOT NULL
      OR prior.principal_kind IS DISTINCT FROM 'anonymous'
      OR prior.principal_id IS DISTINCT FROM p_principal_id
      OR prior.offer_code IS DISTINCT FROM 'self_paced'
      OR prior.catalog_version_id IS DISTINCT FROM p_catalog_version_id
      OR prior.price_binding_id IS DISTINCT FROM p_price_binding_id
      OR prior.environment IS DISTINCT FROM p_environment
      OR prior.receiver_stripe_account_id IS DISTINCT FROM p_receiver_stripe_account_id
      OR prior.contact_email_fingerprint IS DISTINCT FROM p_contact_email_fingerprint
      OR prior.business_name_content_hash IS DISTINCT FROM p_business_name_content_hash
      OR prior.account_name_schema_version IS DISTINCT FROM p_account_name_schema_version
      OR prior.request_hash IS DISTINCT FROM p_request_hash
      OR prior.integration_identifier IS DISTINCT FROM p_integration_identifier
      OR prior.policy_versions IS DISTINCT FROM p_policy_versions
      OR prior.expires_at IS DISTINCT FROM p_expires_at
    THEN
      RAISE EXCEPTION USING
        ERRCODE='23514',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_RECONCILIATION_REQUIRED';
    END IF;
    replayed:=true;authorization_id:=prior.id;action_id:=prior.action_id;
    provider_idempotency_key:=prior.provider_idempotency_key;state:=prior.status;
    RETURN NEXT;RETURN;
  END IF;

  SELECT offer.id offer_id,catalog_version.content_readiness_hash
  INTO catalog
  FROM public.offers offer
  JOIN public.offer_catalog_versions catalog_version
    ON catalog_version.id=p_catalog_version_id
   AND catalog_version.offer_id=offer.id
   AND catalog_version.offer_code=offer.code
  JOIN public.offer_price_bindings binding
    ON binding.id=p_price_binding_id AND binding.offer_id=offer.id
   AND binding.catalog_version_id=catalog_version.id
   AND binding.environment=p_environment
   AND binding.stripe_account_id=p_receiver_stripe_account_id
  WHERE offer.code='self_paced' AND offer.state='enabled'
    AND offer.current_catalog_version_id=catalog_version.id
    AND catalog_version.state='published'
    AND catalog_version.content_readiness_hash IS NOT NULL
    AND binding.price_role='self_paced_once'
    AND binding.unit_amount=39900 AND binding.currency='usd'
    AND binding.recurring_interval IS NULL AND binding.interval_count IS NULL
    AND binding.enabled_at IS NOT NULL AND binding.retired_at IS NULL
  FOR SHARE OF offer,catalog_version,binding;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE='42501',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_NOT_ELIGIBLE';
  END IF;
  SELECT count(*) INTO ready_course_count
  FROM (
    SELECT head.course_id
    FROM public.course_heads head
    JOIN public.course_versions course_version
      ON course_version.id=head.current_course_version_id
     AND course_version.course_id=head.course_id
     AND course_version.manifest_hash=head.manifest_hash
    JOIN public.content_readiness_evaluations evaluation
      ON evaluation.course_version_id=course_version.id
     AND evaluation.gate_hash=catalog.content_readiness_hash
     AND evaluation.passed AND evaluation.issues='[]'::jsonb
    JOIN public.content_readiness_approvals approval
      ON approval.evaluation_id=evaluation.id
     AND approval.gate_hash=catalog.content_readiness_hash
    JOIN public.course_version_lessons lesson
      ON lesson.course_version_id=course_version.id
     AND lesson.course_id=course_version.course_id
    WHERE head.channel='production'
    GROUP BY head.course_id
    HAVING count(*) FILTER(WHERE lesson.required)=18
  ) ready_course;
  IF ready_course_count<>1 THEN
    RAISE EXCEPTION USING
      ERRCODE='42501',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_NOT_ELIGIBLE';
  END IF;

  INSERT INTO public.checkout_authorizations(
    account_id,principal_kind,principal_id,offer_id,offer_code,
    catalog_version_id,price_binding_id,environment,receiver_stripe_account_id,
    contact_email_fingerprint,contact_ciphertext,contact_nonce,contact_tag,
    contact_key_id,business_name_ciphertext,business_name_nonce,
    business_name_tag,business_name_key_id,business_name_content_hash,
    account_name_schema_version,source_command_receipt_id,request_hash,
    integration_identifier,policy_versions,status,expires_at,created_at,updated_at
  ) VALUES(
    NULL,'anonymous',p_principal_id,catalog.offer_id,'self_paced',
    p_catalog_version_id,p_price_binding_id,p_environment,
    p_receiver_stripe_account_id,p_contact_email_fingerprint,
    p_contact_ciphertext,p_contact_nonce,p_contact_tag,p_contact_key_id,
    p_business_name_ciphertext,p_business_name_nonce,p_business_name_tag,
    p_business_name_key_id,p_business_name_content_hash,
    p_account_name_schema_version,receipt.id,p_request_hash,
    p_integration_identifier,p_policy_versions,'provider_call_pending',
    p_expires_at,p_now,p_now
  ) RETURNING id,checkout_authorizations.status INTO authorization_id,state;
  SELECT * INTO action FROM public.syntholo_commerce_stage_checkout_action_v1(
    authorization_id,p_request_hash,p_now
  );
  action_id:=action.action_id;
  provider_idempotency_key:=action.provider_idempotency_key;
  replayed:=false;
  response_payload:=jsonb_build_object(
    'authorizationId',authorization_id,'actionId',action_id,'state',state
  );
  UPDATE public.api_command_receipts receipt_row
  SET status='completed',response_status=201,response=response_payload,
    completed_at=p_now
  WHERE receipt_row.id=receipt.id AND receipt_row.status='in_progress';
  RETURN NEXT;
END
$reserve_public_self_paced$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_reserve_public_self_paced_v1(
  text,text,text,text,uuid,uuid,bytea,bytea,bytea,bytea,text,bytea,bytea,bytea,
  text,text,text,text,text,jsonb,timestamptz,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_reserve_public_self_paced_v1(
  text,text,text,text,uuid,uuid,bytea,bytea,bytea,bytea,text,bytea,bytea,bytea,
  text,text,text,text,text,jsonb,timestamptz,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_reserve_existing_bos_setup_v1(
  p_account uuid,p_membership_id uuid,p_idempotency_key text,
  p_environment text,p_receiver_stripe_account_id text,
  p_catalog_version_id uuid,p_price_binding_id uuid,p_request_hash text,
  p_integration_identifier text,p_policy_versions jsonb,
  p_expires_at timestamptz,p_now timestamptz
)
RETURNS TABLE(
  replayed boolean,setup_epoch_id uuid,authorization_id uuid,action_id uuid,
  provider_idempotency_key text,state text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $reserve_existing_bos$
DECLARE
  membership public.memberships%ROWTYPE;
  receipt public.api_command_receipts%ROWTYPE;
  existing public.business_os_setup_epochs%ROWTYPE;
  catalog record;
  prior record;
  action record;
  next_ordinal integer;
  response_payload jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_account IS NULL OR p_membership_id IS NULL
    OR p_idempotency_key IS NULL
    OR p_idempotency_key!~'^[A-Za-z0-9._~-]{16,128}$'
    OR p_environment IS NULL OR p_environment NOT IN('test','staging','production')
    OR p_receiver_stripe_account_id IS NULL
    OR p_receiver_stripe_account_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    OR p_catalog_version_id IS NULL OR p_price_binding_id IS NULL
    OR p_request_hash IS NULL OR p_request_hash!~'^[0-9a-f]{64}$'
    OR p_integration_identifier IS NULL
    OR p_integration_identifier!~'^syntholo_[A-Za-z]{8}$'
    OR p_policy_versions IS NULL OR jsonb_typeof(p_policy_versions)<>'object'
    OR p_policy_versions='{}'::jsonb OR octet_length(p_policy_versions::text)>4096
    OR EXISTS(
      SELECT 1 FROM jsonb_each(p_policy_versions) policy(key,value)
      WHERE policy.key!~'^[A-Za-z][A-Za-z0-9._-]{0,63}$'
        OR jsonb_typeof(policy.value)<>'string'
        OR octet_length(policy.value#>>'{}') NOT BETWEEN 1 AND 255
    )
    OR p_expires_at IS NULL OR NOT isfinite(p_expires_at)
    OR p_expires_at<>date_trunc('milliseconds',p_expires_at)
    OR p_expires_at<=p_now OR p_expires_at>p_now+interval '24 hours'
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
    OR nullif(current_setting('app.account_id',true),'')::uuid
      IS DISTINCT FROM p_account
  THEN
    RAISE EXCEPTION USING
      ERRCODE='22023',MESSAGE='COMMERCE_EXISTING_BOS_INPUT_INVALID';
  END IF;

  SELECT membership_row.* INTO membership
  FROM public.memberships membership_row
  JOIN public.member_identities identity
    ON identity.id=membership_row.member_identity_id
   AND identity.account_id=membership_row.account_id
  JOIN public.accounts account
    ON account.id=membership_row.account_id AND account.status='active'
  WHERE membership_row.id=p_membership_id
    AND membership_row.account_id=p_account
    AND membership_row.role='owner'
    AND membership_row.status='active'
  FOR SHARE OF membership_row,identity,account;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE='42501',MESSAGE='COMMERCE_EXISTING_BOS_NOT_AUTHORIZED';
  END IF;

  PERFORM public.syntholo_lock_entitlement_graph(p_account);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'commerce:existing-bos:'||p_account::text,0
  ));
  PERFORM 1 FROM public.account_holds hold
  WHERE hold.account_id=p_account AND hold.kind='commerce'
    AND hold.released_at IS NULL
  FOR SHARE;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE='42501',MESSAGE='COMMERCE_EXISTING_BOS_NOT_ELIGIBLE';
  END IF;

  INSERT INTO public.api_command_receipts(
    principal_kind,principal_id,method,route_template,idempotency_key,
    request_hash,status,expires_at,created_at
  ) VALUES(
    'member',p_membership_id::text,'POST','/v1/member/checkouts',
    p_idempotency_key,p_request_hash,'in_progress',p_now+interval '30 days',p_now
  ) ON CONFLICT(principal_kind,principal_id,method,route_template,idempotency_key)
    DO NOTHING;
  SELECT receipt_row.* INTO receipt
  FROM public.api_command_receipts receipt_row
  WHERE receipt_row.principal_kind='member'
    AND receipt_row.principal_id=p_membership_id::text
    AND receipt_row.method='POST'
    AND receipt_row.route_template='/v1/member/checkouts'
    AND receipt_row.idempotency_key=p_idempotency_key
  FOR UPDATE;
  IF receipt.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='IDEMPOTENCY_KEY_REUSED';
  END IF;
  IF receipt.status='completed' THEN
    IF receipt.response IS NULL
      OR coalesce(receipt.response->>'setupEpochId','')
        !~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      RAISE EXCEPTION USING
        ERRCODE='55000',MESSAGE='COMMERCE_EXISTING_BOS_RECONCILIATION_REQUIRED';
    END IF;
    SELECT epoch.*,authorization_row.id authorization_id,
      authorization_row.principal_id authorization_principal_id,
      authorization_row.catalog_version_id authorization_catalog_version_id,
      authorization_row.price_binding_id authorization_price_binding_id,
      authorization_row.request_hash authorization_request_hash,
      authorization_row.integration_identifier,
      authorization_row.policy_versions,
      authorization_row.expires_at authorization_expires_at,
      action_row.id action_id,action_row.provider_idempotency_key
    INTO prior
    FROM public.business_os_setup_epochs epoch
    JOIN public.checkout_authorizations authorization_row
      ON authorization_row.setup_epoch_id=epoch.id
     AND authorization_row.account_id=epoch.account_id
    JOIN public.checkout_provider_actions action_row
      ON action_row.authorization_id=authorization_row.id
     AND action_row.action_kind='create_checkout_session'
    WHERE epoch.id=(receipt.response->>'setupEpochId')::uuid
      AND epoch.account_id=p_account
    FOR UPDATE OF epoch,authorization_row,action_row;
    IF NOT FOUND
      OR prior.environment IS DISTINCT FROM p_environment
      OR prior.receiver_stripe_account_id IS DISTINCT FROM p_receiver_stripe_account_id
      OR prior.authorization_catalog_version_id IS DISTINCT FROM p_catalog_version_id
      OR prior.authorization_price_binding_id IS DISTINCT FROM p_price_binding_id
      OR prior.authorization_principal_id IS DISTINCT FROM p_membership_id::text
      OR prior.authorization_request_hash IS DISTINCT FROM p_request_hash
      OR prior.integration_identifier IS DISTINCT FROM p_integration_identifier
      OR prior.policy_versions IS DISTINCT FROM p_policy_versions
      OR prior.authorization_expires_at IS DISTINCT FROM p_expires_at
    THEN
      RAISE EXCEPTION USING
        ERRCODE='23514',MESSAGE='COMMERCE_EXISTING_BOS_RECONCILIATION_REQUIRED';
    END IF;
    replayed:=true;setup_epoch_id:=prior.id;
    authorization_id:=prior.authorization_id;action_id:=prior.action_id;
    provider_idempotency_key:=prior.provider_idempotency_key;state:=prior.state;
    RETURN NEXT;RETURN;
  END IF;

  SELECT epoch.* INTO existing
  FROM public.business_os_setup_epochs epoch
  WHERE epoch.account_id=p_account
    AND epoch.state IN(
      'checkout_create_pending','checkout_open','async_payment_pending','paid',
      'refund_pending','dispute_open'
    )
  FOR UPDATE;
  IF FOUND THEN
    SELECT epoch.*,authorization_row.id authorization_id,
      authorization_row.principal_id authorization_principal_id,
      authorization_row.catalog_version_id authorization_catalog_version_id,
      authorization_row.price_binding_id authorization_price_binding_id,
      authorization_row.request_hash authorization_request_hash,
      authorization_row.integration_identifier,
      authorization_row.policy_versions,
      authorization_row.expires_at authorization_expires_at,
      action_row.id action_id,action_row.provider_idempotency_key
    INTO prior
    FROM public.business_os_setup_epochs epoch
    JOIN public.checkout_authorizations authorization_row
      ON authorization_row.setup_epoch_id=epoch.id
     AND authorization_row.account_id=epoch.account_id
    JOIN public.checkout_provider_actions action_row
      ON action_row.authorization_id=authorization_row.id
     AND action_row.action_kind='create_checkout_session'
    WHERE epoch.id=existing.id
    FOR UPDATE OF epoch,authorization_row,action_row;
    IF NOT FOUND
      OR prior.environment IS DISTINCT FROM p_environment
      OR prior.receiver_stripe_account_id IS DISTINCT FROM p_receiver_stripe_account_id
      OR prior.authorization_catalog_version_id IS DISTINCT FROM p_catalog_version_id
      OR prior.authorization_price_binding_id IS DISTINCT FROM p_price_binding_id
      OR prior.authorization_principal_id IS DISTINCT FROM p_membership_id::text
      OR prior.authorization_request_hash IS DISTINCT FROM p_request_hash
      OR prior.integration_identifier IS DISTINCT FROM p_integration_identifier
      OR prior.policy_versions IS DISTINCT FROM p_policy_versions
      OR prior.authorization_expires_at IS DISTINCT FROM p_expires_at
    THEN
      RAISE EXCEPTION USING
        ERRCODE='23514',MESSAGE='COMMERCE_EXISTING_BOS_SETUP_EXISTS';
    END IF;
    replayed:=true;setup_epoch_id:=prior.id;
    authorization_id:=prior.authorization_id;action_id:=prior.action_id;
    provider_idempotency_key:=prior.provider_idempotency_key;state:=prior.state;
  ELSE
    SELECT offer.id offer_id,catalog_version.version catalog_version
    INTO catalog
    FROM public.offers offer
    JOIN public.offer_catalog_versions catalog_version
      ON catalog_version.id=p_catalog_version_id
     AND catalog_version.offer_id=offer.id
     AND catalog_version.offer_code='business_os'
    JOIN public.offer_price_bindings binding
      ON binding.id=p_price_binding_id AND binding.offer_id=offer.id
     AND binding.catalog_version_id=catalog_version.id
     AND binding.environment=p_environment
     AND binding.stripe_account_id=p_receiver_stripe_account_id
    WHERE offer.code='business_os' AND offer.state='enabled'
      AND offer.current_catalog_version_id=catalog_version.id
      AND catalog_version.state='published'
      AND binding.price_role='business_os_setup'
      AND binding.unit_amount=99900 AND binding.currency='usd'
      AND binding.recurring_interval IS NULL AND binding.interval_count IS NULL
      AND binding.enabled_at IS NOT NULL AND binding.retired_at IS NULL
    FOR SHARE OF offer,catalog_version,binding;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE='42501',MESSAGE='COMMERCE_EXISTING_BOS_NOT_ELIGIBLE';
    END IF;
    SELECT coalesce(max(epoch.ordinal),0)+1 INTO next_ordinal
    FROM public.business_os_setup_epochs epoch
    WHERE epoch.account_id=p_account;
    INSERT INTO public.business_os_setup_epochs(
      account_id,ordinal,environment,receiver_stripe_account_id,
      catalog_version_id,price_binding_id,state,created_at,updated_at
    ) VALUES(
      p_account,next_ordinal,p_environment,p_receiver_stripe_account_id,
      p_catalog_version_id,p_price_binding_id,'checkout_create_pending',p_now,p_now
    ) RETURNING id,business_os_setup_epochs.state INTO setup_epoch_id,state;
    INSERT INTO public.checkout_authorizations(
      account_id,principal_kind,principal_id,offer_id,offer_code,
      catalog_version_id,price_binding_id,environment,receiver_stripe_account_id,
      setup_epoch_id,source_command_receipt_id,request_hash,
      integration_identifier,policy_versions,status,expires_at,created_at,updated_at
    ) VALUES(
      p_account,'member',p_membership_id::text,catalog.offer_id,'business_os',
      p_catalog_version_id,p_price_binding_id,p_environment,
      p_receiver_stripe_account_id,setup_epoch_id,receipt.id,p_request_hash,
      p_integration_identifier,p_policy_versions,'provider_call_pending',
      p_expires_at,p_now,p_now
    ) RETURNING id INTO authorization_id;
    SELECT * INTO action FROM public.syntholo_commerce_stage_checkout_action_v1(
      authorization_id,p_request_hash,p_now
    );
    action_id:=action.action_id;
    provider_idempotency_key:=action.provider_idempotency_key;
    replayed:=false;
  END IF;
  response_payload:=jsonb_build_object(
    'setupEpochId',setup_epoch_id,'authorizationId',authorization_id,
    'actionId',action_id,'state',state
  );
  UPDATE public.api_command_receipts receipt_row
  SET status='completed',response_status=201,response=response_payload,
    completed_at=p_now
  WHERE receipt_row.id=receipt.id AND receipt_row.status='in_progress';
  RETURN NEXT;
END
$reserve_existing_bos$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_reserve_existing_bos_setup_v1(
  uuid,uuid,text,text,text,uuid,uuid,text,text,jsonb,timestamptz,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_reserve_existing_bos_setup_v1(
  uuid,uuid,text,text,text,uuid,uuid,text,text,jsonb,timestamptz,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_begin_checkout_action_v1(
  p_action_id uuid,
  p_request_fingerprint text,
  p_now timestamptz
)
RETURNS TABLE(
  replayed boolean,
  action_id uuid,
  provider_idempotency_key text,
  attempt integer
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $begin_checkout_action$
DECLARE
  v_authorization_id uuid;
  v_public_intent_id uuid;
  target_authorization public.checkout_authorizations%ROWTYPE;
  action public.checkout_provider_actions%ROWTYPE;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_action_id IS NULL OR p_request_fingerprint IS NULL
    OR p_request_fingerprint!~'^[0-9a-f]{64}$'
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE='22023',MESSAGE='COMMERCE_CHECKOUT_ACTION_INPUT_INVALID';
  END IF;
  SELECT action_row.authorization_id,authorization_row.public_intent_id
  INTO v_authorization_id,v_public_intent_id
  FROM public.checkout_provider_actions action_row
  JOIN public.checkout_authorizations authorization_row
    ON authorization_row.id=action_row.authorization_id
  WHERE action_row.id=p_action_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE='42501',MESSAGE='COMMERCE_CHECKOUT_ACTION_NOT_AUTHORIZED';
  END IF;
  IF v_public_intent_id IS NOT NULL THEN
    PERFORM 1 FROM public.public_business_os_setup_intents public_intent
    WHERE public_intent.id=v_public_intent_id FOR UPDATE;
  END IF;
  SELECT authorization_row.* INTO target_authorization
  FROM public.checkout_authorizations authorization_row
  WHERE authorization_row.id=v_authorization_id FOR UPDATE;
  SELECT action_row.* INTO action
  FROM public.checkout_provider_actions action_row
  WHERE action_row.id=p_action_id
    AND action_row.authorization_id=target_authorization.id
  FOR UPDATE;
  IF NOT FOUND
    OR coalesce(target_authorization.account_id::text,'')
      IS DISTINCT FROM coalesce(current_setting('app.account_id',true),'')
    OR action.request_fingerprint IS DISTINCT FROM p_request_fingerprint
    OR target_authorization.status<>'provider_call_pending'
  THEN
    RAISE EXCEPTION USING
      ERRCODE='42501',MESSAGE='COMMERCE_CHECKOUT_ACTION_NOT_AUTHORIZED';
  END IF;
  IF target_authorization.expires_at<=p_now OR NOT EXISTS(
    SELECT 1 FROM public.offers offer
    JOIN public.offer_catalog_versions catalog
      ON catalog.id=target_authorization.catalog_version_id
     AND catalog.offer_id=target_authorization.offer_id
     AND catalog.offer_code=target_authorization.offer_code
    JOIN public.offer_price_bindings binding
      ON binding.id=target_authorization.price_binding_id
     AND binding.offer_id=target_authorization.offer_id
     AND binding.catalog_version_id=target_authorization.catalog_version_id
     AND binding.environment=target_authorization.environment
     AND binding.stripe_account_id=target_authorization.receiver_stripe_account_id
    WHERE offer.id=target_authorization.offer_id AND offer.code=target_authorization.offer_code
      AND offer.state='enabled'
      AND offer.current_catalog_version_id=target_authorization.catalog_version_id
      AND catalog.state='published'
      AND binding.enabled_at IS NOT NULL AND binding.retired_at IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_CHECKOUT_ACTION_NOT_ELIGIBLE';
  END IF;
  IF action.status IN('succeeded','failed_terminal') THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_CHECKOUT_ACTION_TERMINAL';
  END IF;
  IF action.status='in_flight'
    AND action.updated_at>p_now-interval '5 minutes'
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_CHECKOUT_ACTION_IN_PROGRESS';
  END IF;
  IF action.status='in_flight'
    AND NOT(action.updated_at<=p_now-interval '5 minutes')
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_CHECKOUT_ACTION_FENCE_INVALID';
  END IF;
  PERFORM set_config('app.commerce_transition','checkout_provider_actions',true);
  UPDATE public.checkout_provider_actions action_row
  SET status='in_flight',attempts=action_row.attempts+1,
    last_error_code=NULL,updated_at=p_now
  WHERE action_row.id=action.id
  RETURNING action_row.attempts INTO attempt;
  PERFORM set_config('app.commerce_transition','',true);
  replayed:=false;
  action_id:=action.id;
  provider_idempotency_key:=action.provider_idempotency_key;
  RETURN NEXT;
END
$begin_checkout_action$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_begin_checkout_action_v1(
  uuid,text,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_begin_checkout_action_v1(
  uuid,text,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_finish_checkout_action_v1(
  p_action_id uuid,
  p_request_fingerprint text,
  p_attempt integer,
  p_outcome text,
  p_error_code text,
  p_now timestamptz
)
RETURNS TABLE(replayed boolean,status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $finish_checkout_action$
DECLARE
  v_authorization_id uuid;
  v_public_intent_id uuid;
  target_authorization public.checkout_authorizations%ROWTYPE;
  action public.checkout_provider_actions%ROWTYPE;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_action_id IS NULL OR p_request_fingerprint IS NULL
    OR p_request_fingerprint!~'^[0-9a-f]{64}$'
    OR p_attempt IS NULL OR p_attempt<1
    OR p_outcome IS NULL
    OR p_outcome NOT IN('failed_retryable','failed_terminal','ambiguous')
    OR p_error_code IS NULL OR p_error_code!~'^[A-Z][A-Z0-9_]{0,127}$'
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE='22023',MESSAGE='COMMERCE_CHECKOUT_ACTION_INPUT_INVALID';
  END IF;
  SELECT action_row.authorization_id,authorization_row.public_intent_id
  INTO v_authorization_id,v_public_intent_id
  FROM public.checkout_provider_actions action_row
  JOIN public.checkout_authorizations authorization_row
    ON authorization_row.id=action_row.authorization_id
  WHERE action_row.id=p_action_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE='42501',MESSAGE='COMMERCE_CHECKOUT_ACTION_NOT_AUTHORIZED';
  END IF;
  IF v_public_intent_id IS NOT NULL THEN
    PERFORM 1 FROM public.public_business_os_setup_intents public_intent
    WHERE public_intent.id=v_public_intent_id FOR UPDATE;
  END IF;
  SELECT authorization_row.* INTO target_authorization
  FROM public.checkout_authorizations authorization_row
  WHERE authorization_row.id=v_authorization_id FOR UPDATE;
  SELECT action_row.* INTO action
  FROM public.checkout_provider_actions action_row
  WHERE action_row.id=p_action_id
    AND action_row.authorization_id=target_authorization.id
  FOR UPDATE;
  IF NOT FOUND
    OR coalesce(target_authorization.account_id::text,'')
      IS DISTINCT FROM coalesce(current_setting('app.account_id',true),'')
    OR action.request_fingerprint IS DISTINCT FROM p_request_fingerprint
  THEN
    RAISE EXCEPTION USING
      ERRCODE='42501',MESSAGE='COMMERCE_CHECKOUT_ACTION_NOT_AUTHORIZED';
  END IF;
  IF action.status=p_outcome AND action.attempts=p_attempt
    AND action.last_error_code=p_error_code
  THEN
    replayed:=true;status:=action.status;RETURN NEXT;RETURN;
  END IF;
  IF action.status<>'in_flight' OR action.attempts<>p_attempt THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_CHECKOUT_ACTION_FENCE_INVALID';
  END IF;
  PERFORM set_config('app.commerce_transition','checkout_provider_actions',true);
  UPDATE public.checkout_provider_actions action_row
  SET status=p_outcome,last_error_code=p_error_code,updated_at=p_now
  WHERE action_row.id=action.id;
  PERFORM set_config('app.commerce_transition','',true);
  IF p_outcome='failed_terminal' THEN
    PERFORM set_config('app.commerce_transition','checkout_authorizations',true);
    UPDATE public.checkout_authorizations authorization_row
    SET status='failed',updated_at=p_now
    WHERE authorization_row.id=target_authorization.id
      AND authorization_row.status='provider_call_pending';
    PERFORM set_config('app.commerce_transition','',true);
  END IF;
  replayed:=false;status:=p_outcome;RETURN NEXT;
END
$finish_checkout_action$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_finish_checkout_action_v1(
  uuid,text,integer,text,text,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_finish_checkout_action_v1(
  uuid,text,integer,text,text,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_record_checkout_session_v1(
  p_action_id uuid,
  p_request_fingerprint text,
  p_attempt integer,
  p_provider_session_id text,
  p_provider_customer_id text,
  p_mode text,
  p_payment_status text,
  p_checkout_url_ciphertext bytea,
  p_checkout_url_nonce bytea,
  p_checkout_url_tag bytea,
  p_checkout_url_key_id text,
  p_expires_at timestamptz,
  p_now timestamptz
)
RETURNS TABLE(
  replayed boolean,
  checkout_session_id uuid,
  status text,
  payment_status text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $record_checkout_session$
DECLARE
  v_authorization_id uuid;
  v_public_intent_id uuid;
  target_authorization public.checkout_authorizations%ROWTYPE;
  action public.checkout_provider_actions%ROWTYPE;
  existing public.checkout_sessions%ROWTYPE;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_action_id IS NULL
    OR p_request_fingerprint IS NULL
    OR p_request_fingerprint!~'^[0-9a-f]{64}$'
    OR p_attempt IS NULL OR p_attempt<1
    OR p_provider_session_id IS NULL
    OR p_provider_session_id!~'^cs_[A-Za-z0-9._:-]+$'
    OR octet_length(p_provider_session_id) NOT BETWEEN 1 AND 255
    OR (p_provider_customer_id IS NOT NULL AND (
      p_provider_customer_id!~'^cus_[A-Za-z0-9._:-]+$'
      OR octet_length(p_provider_customer_id) NOT BETWEEN 1 AND 255))
    OR p_mode IS NULL OR p_mode NOT IN('payment','setup','subscription')
    OR p_payment_status IS NULL
    OR p_payment_status NOT IN('paid','unpaid','no_payment_required')
    OR p_checkout_url_ciphertext IS NULL
    OR octet_length(p_checkout_url_ciphertext) NOT BETWEEN 1 AND 4096
    OR p_checkout_url_nonce IS NULL OR octet_length(p_checkout_url_nonce)<>12
    OR p_checkout_url_tag IS NULL OR octet_length(p_checkout_url_tag)<>16
    OR p_checkout_url_key_id IS NULL
    OR octet_length(p_checkout_url_key_id) NOT BETWEEN 1 AND 128
    OR p_checkout_url_key_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    OR p_expires_at IS NULL OR NOT isfinite(p_expires_at)
    OR p_expires_at<>date_trunc('milliseconds',p_expires_at)
    OR p_expires_at<=p_now
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE='22023',MESSAGE='COMMERCE_CHECKOUT_SESSION_INPUT_INVALID';
  END IF;

  SELECT action_row.authorization_id,authorization_row.public_intent_id
  INTO v_authorization_id,v_public_intent_id
  FROM public.checkout_provider_actions action_row
  JOIN public.checkout_authorizations authorization_row
    ON authorization_row.id=action_row.authorization_id
  WHERE action_row.id=p_action_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE='42501',MESSAGE='COMMERCE_CHECKOUT_SESSION_NOT_AUTHORIZED';
  END IF;
  IF v_public_intent_id IS NOT NULL THEN
    PERFORM 1 FROM public.public_business_os_setup_intents public_intent
    WHERE public_intent.id=v_public_intent_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE='55000',MESSAGE='COMMERCE_CHECKOUT_SESSION_AUTHORITY_INVALID';
    END IF;
  END IF;
  SELECT authorization_row.* INTO target_authorization
  FROM public.checkout_authorizations authorization_row
  WHERE authorization_row.id=v_authorization_id FOR UPDATE;
  SELECT action_row.* INTO action
  FROM public.checkout_provider_actions action_row
  WHERE action_row.id=p_action_id
    AND action_row.authorization_id=target_authorization.id
  FOR UPDATE;
  IF NOT FOUND
    OR coalesce(target_authorization.account_id::text,'')
      IS DISTINCT FROM coalesce(current_setting('app.account_id',true),'')
    OR action.account_id IS DISTINCT FROM target_authorization.account_id
    OR action.environment IS DISTINCT FROM target_authorization.environment
    OR action.receiver_stripe_account_id
      IS DISTINCT FROM target_authorization.receiver_stripe_account_id
    OR action.request_fingerprint IS DISTINCT FROM p_request_fingerprint
  THEN
    RAISE EXCEPTION USING
      ERRCODE='42501',MESSAGE='COMMERCE_CHECKOUT_SESSION_NOT_AUTHORIZED';
  END IF;

  SELECT session_row.* INTO existing
  FROM public.checkout_sessions session_row
  WHERE session_row.authorization_id=target_authorization.id
  FOR UPDATE;
  IF FOUND THEN
    IF action.status IS DISTINCT FROM 'succeeded'
      OR action.attempts IS DISTINCT FROM p_attempt
      OR action.provider_session_id IS DISTINCT FROM p_provider_session_id
      OR existing.account_id IS DISTINCT FROM target_authorization.account_id
      OR existing.environment IS DISTINCT FROM target_authorization.environment
      OR existing.receiver_stripe_account_id
        IS DISTINCT FROM target_authorization.receiver_stripe_account_id
      OR existing.provider_session_id IS DISTINCT FROM p_provider_session_id
      OR existing.provider_customer_id IS DISTINCT FROM p_provider_customer_id
      OR existing.mode IS DISTINCT FROM p_mode
      OR existing.status IS DISTINCT FROM 'open'
      OR existing.payment_status IS DISTINCT FROM p_payment_status
      OR existing.checkout_url_ciphertext IS DISTINCT FROM p_checkout_url_ciphertext
      OR existing.checkout_url_nonce IS DISTINCT FROM p_checkout_url_nonce
      OR existing.checkout_url_tag IS DISTINCT FROM p_checkout_url_tag
      OR existing.checkout_url_key_id IS DISTINCT FROM p_checkout_url_key_id
      OR existing.expires_at IS DISTINCT FROM p_expires_at
    THEN
      RAISE EXCEPTION USING
        ERRCODE='23514',
        MESSAGE='COMMERCE_CHECKOUT_SESSION_RECONCILIATION_REQUIRED';
    END IF;
    replayed:=true;
    checkout_session_id:=existing.id;
    status:=existing.status;
    payment_status:=existing.payment_status;
    RETURN NEXT;
    RETURN;
  END IF;

  IF action.status<>'in_flight'
    OR action.attempts IS DISTINCT FROM p_attempt
    OR target_authorization.status<>'provider_call_pending'
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_CHECKOUT_SESSION_STATE_INVALID';
  END IF;
  checkout_session_id:=gen_random_uuid();
  INSERT INTO public.checkout_sessions(
    id,authorization_id,account_id,environment,receiver_stripe_account_id,
    provider_session_id,provider_customer_id,provider_payment_intent_id,
    provider_subscription_id,provider_setup_intent_id,mode,status,payment_status,
    checkout_url_ciphertext,checkout_url_nonce,checkout_url_tag,
    checkout_url_key_id,expires_at,created_at,updated_at
  ) VALUES(
    checkout_session_id,target_authorization.id,target_authorization.account_id,
    target_authorization.environment,target_authorization.receiver_stripe_account_id,
    p_provider_session_id,p_provider_customer_id,NULL,NULL,NULL,p_mode,'open',
    p_payment_status,p_checkout_url_ciphertext,p_checkout_url_nonce,
    p_checkout_url_tag,p_checkout_url_key_id,p_expires_at,p_now,p_now
  );
  PERFORM set_config('app.commerce_transition','checkout_provider_actions',true);
  UPDATE public.checkout_provider_actions action_row
  SET status='succeeded',provider_session_id=p_provider_session_id,
    attempts=greatest(action_row.attempts,1),last_error_code=NULL,updated_at=p_now
  WHERE action_row.id=action.id;
  PERFORM set_config('app.commerce_transition','',true);
  PERFORM set_config('app.commerce_transition','checkout_authorizations',true);
  UPDATE public.checkout_authorizations authorization_row
  SET status='checkout_open',updated_at=p_now
  WHERE authorization_row.id=target_authorization.id
    AND authorization_row.status='provider_call_pending';
  PERFORM set_config('app.commerce_transition','',true);
  IF v_public_intent_id IS NOT NULL THEN
    PERFORM set_config(
      'app.commerce_transition','public_business_os_setup_intents',true
    );
    UPDATE public.public_business_os_setup_intents public_intent
    SET state='checkout_open',updated_at=p_now
    WHERE public_intent.id=v_public_intent_id
      AND public_intent.state='checkout_create_pending';
    PERFORM set_config('app.commerce_transition','',true);
  END IF;
  replayed:=false;
  status:='open';
  payment_status:=p_payment_status;
  RETURN NEXT;
END
$record_checkout_session$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_record_checkout_session_v1(
  uuid,text,integer,text,text,text,text,bytea,bytea,bytea,text,timestamptz,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_record_checkout_session_v1(
  uuid,text,integer,text,text,text,text,bytea,bytea,bytea,text,timestamptz,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_stage_catalog_version_v1(
  p_offer_code text,
  p_version text,
  p_policy_versions jsonb,
  p_content_readiness_hash text,
  p_catalog_hash text,
  p_now timestamptz
)
RETURNS TABLE(replayed boolean,catalog_version_id uuid,state text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $stage_catalog$
DECLARE
  target_offer public.offers%ROWTYPE;
  existing public.offer_catalog_versions%ROWTYPE;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_offer_code IS NULL OR p_offer_code NOT IN(
      'scorecard','self_paced','guided_pilot','operator_club_monthly',
      'operator_club_annual','business_os')
    OR p_version IS NULL OR p_version!~'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    OR p_policy_versions IS NULL OR jsonb_typeof(p_policy_versions)<>'object'
    OR p_policy_versions='{}'::jsonb OR octet_length(p_policy_versions::text)>4096
    OR EXISTS(
      SELECT 1 FROM jsonb_each(p_policy_versions) policy(key,value)
      WHERE policy.key!~'^[A-Za-z][A-Za-z0-9._-]{0,63}$'
        OR jsonb_typeof(policy.value)<>'string'
        OR octet_length(policy.value#>>'{}') NOT BETWEEN 1 AND 255
    )
    OR ((p_offer_code IN('self_paced','guided_pilot'))
      IS DISTINCT FROM (p_content_readiness_hash IS NOT NULL))
    OR (p_content_readiness_hash IS NOT NULL
      AND p_content_readiness_hash!~'^[0-9a-f]{64}$')
    OR p_catalog_hash IS NULL OR p_catalog_hash!~'^[0-9a-f]{64}$'
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
    OR nullif(current_setting('app.account_id',true),'') IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_CATALOG_INPUT_INVALID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('commerce:catalog:'||p_offer_code,0));
  SELECT offer.* INTO target_offer FROM public.offers offer
  WHERE offer.code=p_offer_code FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='COMMERCE_CATALOG_OFFER_INVALID';
  END IF;
  SELECT catalog.* INTO existing FROM public.offer_catalog_versions catalog
  WHERE catalog.offer_id=target_offer.id AND catalog.version=p_version
  FOR UPDATE;
  IF FOUND THEN
    IF existing.offer_code IS DISTINCT FROM p_offer_code
      OR existing.policy_versions IS DISTINCT FROM p_policy_versions
      OR existing.content_readiness_hash IS DISTINCT FROM p_content_readiness_hash
      OR existing.catalog_hash IS DISTINCT FROM p_catalog_hash
    THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_CATALOG_RECONCILIATION_REQUIRED';
    END IF;
    replayed:=true;catalog_version_id:=existing.id;state:=existing.state;
    RETURN NEXT;RETURN;
  END IF;
  INSERT INTO public.offer_catalog_versions(
    offer_id,offer_code,version,state,policy_versions,content_readiness_hash,
    catalog_hash,published_at,retired_at,created_at
  ) VALUES(
    target_offer.id,p_offer_code,p_version,'draft',p_policy_versions,
    p_content_readiness_hash,p_catalog_hash,NULL,NULL,p_now
  ) RETURNING id,offer_catalog_versions.state INTO catalog_version_id,state;
  replayed:=false;RETURN NEXT;
END
$stage_catalog$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_stage_catalog_version_v1(
  text,text,jsonb,text,text,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_stage_catalog_version_v1(
  text,text,jsonb,text,text,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_stage_price_binding_v1(
  p_catalog_version_id uuid,
  p_offer_code text,
  p_environment text,
  p_stripe_account_id text,
  p_stripe_product_id text,
  p_stripe_price_id text,
  p_price_role text,
  p_product_tax_code text,
  p_currency text,
  p_unit_amount integer,
  p_recurring_interval text,
  p_interval_count integer,
  p_tax_behavior text,
  p_fingerprint text,
  p_verified_at timestamptz,
  p_now timestamptz
)
RETURNS TABLE(replayed boolean,price_binding_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $stage_binding$
DECLARE
  catalog public.offer_catalog_versions%ROWTYPE;
  existing public.offer_price_bindings%ROWTYPE;
  expected_fingerprint text;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  expected_fingerprint:=encode(sha256(convert_to(array_to_string(ARRAY[
    'commerce-price-binding.v1',p_offer_code,p_environment,p_stripe_account_id,
    p_stripe_product_id,p_stripe_price_id,p_price_role,p_product_tax_code,
    p_currency,p_unit_amount::text,coalesce(p_recurring_interval,'-'),
    coalesce(p_interval_count::text,'0'),p_tax_behavior,'1'
  ],E'\n'),'UTF8')),'hex');
  IF p_catalog_version_id IS NULL OR p_offer_code IS NULL
    OR p_environment IS NULL OR p_environment NOT IN('test','staging','production')
    OR p_stripe_account_id IS NULL OR p_stripe_account_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    OR p_stripe_product_id IS NULL OR p_stripe_product_id!~'^prod_[A-Za-z0-9._:-]+$'
    OR p_stripe_price_id IS NULL OR p_stripe_price_id!~'^price_[A-Za-z0-9._:-]+$'
    OR p_price_role IS NULL OR p_price_role NOT IN(
      'self_paced_once','guided_pilot_once','operator_club_monthly',
      'operator_club_annual','business_os_setup','business_os_monthly','gate5_validation')
    OR p_product_tax_code IS NULL OR p_product_tax_code!~'^txcd_[A-Za-z0-9._:-]+$'
    OR p_currency IS DISTINCT FROM 'usd' OR p_unit_amount IS NULL OR p_unit_amount<=0
    OR NOT ((p_recurring_interval IS NULL AND p_interval_count IS NULL)
      OR (p_recurring_interval IN('month','year') AND p_interval_count=1))
    OR p_tax_behavior IS NULL OR p_tax_behavior NOT IN('inclusive','exclusive')
    OR p_fingerprint IS NULL OR p_fingerprint IS DISTINCT FROM expected_fingerprint
    OR p_verified_at IS NULL OR NOT isfinite(p_verified_at)
    OR p_verified_at<>date_trunc('milliseconds',p_verified_at) OR p_verified_at>p_now
    OR p_now IS NULL OR NOT isfinite(p_now) OR p_now<>date_trunc('milliseconds',p_now)
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
    OR nullif(current_setting('app.account_id',true),'') IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_CATALOG_BINDING_INPUT_INVALID';
  END IF;
  SELECT version_row.* INTO catalog FROM public.offer_catalog_versions version_row
  WHERE version_row.id=p_catalog_version_id AND version_row.offer_code=p_offer_code
  FOR UPDATE;
  IF NOT FOUND OR catalog.state<>'draft' THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='COMMERCE_CATALOG_VERSION_NOT_DRAFT';
  END IF;
  SELECT binding.* INTO existing FROM public.offer_price_bindings binding
  WHERE binding.offer_id=catalog.offer_id
    AND binding.catalog_version_id=catalog.id
    AND binding.environment=p_environment AND binding.price_role=p_price_role
  FOR UPDATE;
  IF FOUND THEN
    IF existing.offer_code IS DISTINCT FROM p_offer_code
      OR existing.catalog_version IS DISTINCT FROM catalog.version
      OR existing.stripe_account_id IS DISTINCT FROM p_stripe_account_id
      OR existing.stripe_product_id IS DISTINCT FROM p_stripe_product_id
      OR existing.stripe_price_id IS DISTINCT FROM p_stripe_price_id
      OR existing.product_tax_code IS DISTINCT FROM p_product_tax_code
      OR existing.currency IS DISTINCT FROM p_currency
      OR existing.unit_amount IS DISTINCT FROM p_unit_amount
      OR existing.recurring_interval IS DISTINCT FROM p_recurring_interval
      OR existing.interval_count IS DISTINCT FROM p_interval_count
      OR existing.tax_behavior IS DISTINCT FROM p_tax_behavior
      OR existing.fingerprint IS DISTINCT FROM p_fingerprint
      OR existing.verified_at IS DISTINCT FROM p_verified_at
    THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_CATALOG_BINDING_RECONCILIATION_REQUIRED';
    END IF;
    replayed:=true;price_binding_id:=existing.id;RETURN NEXT;RETURN;
  END IF;
  INSERT INTO public.offer_price_bindings(
    offer_id,offer_code,catalog_version_id,catalog_version,environment,
    stripe_account_id,stripe_product_id,stripe_price_id,price_role,
    product_tax_code,currency,unit_amount,recurring_interval,interval_count,
    tax_behavior,quantity,fingerprint,verified_at,enabled_at,retired_at,created_at
  ) VALUES(
    catalog.offer_id,p_offer_code,catalog.id,catalog.version,p_environment,
    p_stripe_account_id,p_stripe_product_id,p_stripe_price_id,p_price_role,
    p_product_tax_code,p_currency,p_unit_amount,p_recurring_interval,p_interval_count,
    p_tax_behavior,1,p_fingerprint,p_verified_at,NULL,NULL,p_now
  ) RETURNING id INTO price_binding_id;
  replayed:=false;RETURN NEXT;
END
$stage_binding$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_stage_price_binding_v1(
  uuid,text,text,text,text,text,text,text,text,integer,text,integer,text,text,timestamptz,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_stage_price_binding_v1(
  uuid,text,text,text,text,text,text,text,text,integer,text,integer,text,text,timestamptz,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_publish_catalog_version_v1(
  p_catalog_version_id uuid,
  p_offer_code text,
  p_environment text,
  p_now timestamptz
)
RETURNS TABLE(replayed boolean,catalog_version_id uuid,state text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $publish_catalog$
DECLARE
  target_offer public.offers%ROWTYPE;
  catalog public.offer_catalog_versions%ROWTYPE;
  prior_catalog public.offer_catalog_versions%ROWTYPE;
  was_published boolean;
  ready_course_count integer;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_catalog_version_id IS NULL OR p_offer_code IS NULL
    OR p_environment IS NULL OR p_environment NOT IN('test','staging','production')
    OR p_now IS NULL OR NOT isfinite(p_now) OR p_now<>date_trunc('milliseconds',p_now)
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
    OR nullif(current_setting('app.account_id',true),'') IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_CATALOG_PUBLISH_INPUT_INVALID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('commerce:catalog:'||p_offer_code,0));
  SELECT offer.* INTO target_offer FROM public.offers offer
  WHERE offer.code=p_offer_code FOR UPDATE;
  SELECT version_row.* INTO catalog FROM public.offer_catalog_versions version_row
  WHERE version_row.id=p_catalog_version_id
    AND version_row.offer_id=target_offer.id
    AND version_row.offer_code=p_offer_code
  FOR UPDATE;
  IF NOT FOUND OR catalog.state NOT IN('draft','published') THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='COMMERCE_CATALOG_VERSION_NOT_PUBLISHABLE';
  END IF;
  IF p_offer_code IN('self_paced','guided_pilot') THEN
    SELECT count(*) INTO ready_course_count
    FROM (
      SELECT head.course_id
      FROM public.course_heads head
      JOIN public.course_versions course_version
        ON course_version.id=head.current_course_version_id
       AND course_version.course_id=head.course_id
       AND course_version.manifest_hash=head.manifest_hash
      JOIN public.content_readiness_evaluations evaluation
        ON evaluation.course_version_id=course_version.id
       AND evaluation.gate_hash=catalog.content_readiness_hash
       AND evaluation.passed
       AND evaluation.issues='[]'::jsonb
      JOIN public.content_readiness_approvals approval
        ON approval.evaluation_id=evaluation.id
       AND approval.gate_hash=catalog.content_readiness_hash
      JOIN public.course_version_lessons lesson
        ON lesson.course_version_id=course_version.id
       AND lesson.course_id=course_version.course_id
      WHERE head.channel='production'
      GROUP BY head.course_id
      HAVING count(*) FILTER(WHERE lesson.required)=18
    ) ready_course;
    IF catalog.content_readiness_hash IS NULL OR ready_course_count<>1 THEN
      RAISE EXCEPTION USING
        ERRCODE='55000',MESSAGE='COMMERCE_CATALOG_CONTENT_NOT_READY';
    END IF;
  ELSIF catalog.content_readiness_hash IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_CATALOG_CONTENT_NOT_READY';
  END IF;
  IF p_offer_code<>'scorecard' AND (
    EXISTS(
      WITH required(role) AS (VALUES
        (CASE p_offer_code
          WHEN 'self_paced' THEN 'self_paced_once'
          WHEN 'guided_pilot' THEN 'guided_pilot_once'
          WHEN 'operator_club_monthly' THEN 'operator_club_monthly'
          WHEN 'operator_club_annual' THEN 'operator_club_annual'
          WHEN 'business_os' THEN 'business_os_setup'
        END),
        (CASE WHEN p_offer_code='business_os' THEN 'business_os_monthly' END)
      )
      SELECT role FROM required WHERE role IS NOT NULL
      EXCEPT
      SELECT binding.price_role FROM public.offer_price_bindings binding
      WHERE binding.catalog_version_id=catalog.id
        AND binding.offer_id=catalog.offer_id
        AND binding.environment=p_environment
    )
    OR EXISTS(
      SELECT 1 FROM public.offer_price_bindings binding
      WHERE binding.catalog_version_id=catalog.id
        AND binding.offer_id=catalog.offer_id
        AND binding.environment=p_environment
        AND binding.price_role NOT IN(
          CASE p_offer_code
            WHEN 'self_paced' THEN 'self_paced_once'
            WHEN 'guided_pilot' THEN 'guided_pilot_once'
            WHEN 'operator_club_monthly' THEN 'operator_club_monthly'
            WHEN 'operator_club_annual' THEN 'operator_club_annual'
            WHEN 'business_os' THEN 'business_os_setup'
          END,
          CASE WHEN p_offer_code='business_os' THEN 'business_os_monthly'
               WHEN p_offer_code='self_paced' AND p_environment='production' THEN 'gate5_validation'
          END
        )
    )
    OR (SELECT count(DISTINCT binding.stripe_account_id)<>1
        FROM public.offer_price_bindings binding
        WHERE binding.catalog_version_id=catalog.id
          AND binding.offer_id=catalog.offer_id
          AND binding.environment=p_environment)
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_CATALOG_BINDING_SET_INCOMPLETE';
  END IF;
  IF p_offer_code='scorecard' AND EXISTS(
    SELECT 1 FROM public.offer_price_bindings binding
    WHERE binding.catalog_version_id=catalog.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_CATALOG_BINDING_SET_INCOMPLETE';
  END IF;
  was_published:=catalog.state='published'
    AND target_offer.current_catalog_version_id=catalog.id
    AND NOT EXISTS(
      SELECT 1 FROM public.offer_price_bindings binding
      WHERE binding.catalog_version_id=catalog.id AND binding.environment=p_environment
        AND (binding.enabled_at IS NULL OR binding.retired_at IS NOT NULL)
    );
  IF was_published THEN
    replayed:=true;catalog_version_id:=catalog.id;state:='published';
    RETURN NEXT;RETURN;
  END IF;
  IF target_offer.current_catalog_version_id IS NOT NULL
    AND target_offer.current_catalog_version_id<>catalog.id
  THEN
    SELECT version_row.* INTO prior_catalog FROM public.offer_catalog_versions version_row
    WHERE version_row.id=target_offer.current_catalog_version_id FOR UPDATE;
    PERFORM set_config('app.commerce_transition','offer_price_bindings',true);
    UPDATE public.offer_price_bindings binding
    SET retired_at=p_now
    WHERE binding.catalog_version_id=prior_catalog.id
      AND binding.enabled_at IS NOT NULL AND binding.retired_at IS NULL;
    PERFORM set_config('app.commerce_transition','',true);
    PERFORM set_config('app.commerce_transition','offer_catalog_versions',true);
    UPDATE public.offer_catalog_versions version_row
    SET state='retired',retired_at=p_now
    WHERE version_row.id=prior_catalog.id AND version_row.state='published';
    PERFORM set_config('app.commerce_transition','',true);
  END IF;
  PERFORM set_config('app.commerce_transition','offer_price_bindings',true);
  UPDATE public.offer_price_bindings binding
  SET enabled_at=coalesce(binding.enabled_at,p_now)
  WHERE binding.catalog_version_id=catalog.id AND binding.environment=p_environment
    AND binding.retired_at IS NULL;
  PERFORM set_config('app.commerce_transition','',true);
  PERFORM set_config('app.commerce_transition','offer_catalog_versions',true);
  UPDATE public.offer_catalog_versions version_row
  SET state='published',published_at=coalesce(version_row.published_at,p_now)
  WHERE version_row.id=catalog.id;
  PERFORM set_config('app.commerce_transition','',true);
  PERFORM set_config('app.commerce_transition','offers',true);
  UPDATE public.offers offer
  SET current_catalog_version_id=catalog.id,updated_at=p_now
  WHERE offer.id=target_offer.id;
  PERFORM set_config('app.commerce_transition','',true);
  replayed:=false;catalog_version_id:=catalog.id;state:='published';RETURN NEXT;
END
$publish_catalog$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_publish_catalog_version_v1(
  uuid,text,text,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_publish_catalog_version_v1(
  uuid,text,text,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_reserve_recurring_purchase_v1(
  p_account uuid,
  p_command uuid,
  p_request_hash text,
  p_family text,
  p_offer_code text,
  p_environment text,
  p_receiver_stripe_account_id text,
  p_catalog_version_id uuid,
  p_price_binding_id uuid,
  p_setup_epoch_id uuid,
  p_setup_purchase_id uuid,
  p_academy_source_registry_id uuid,
  p_expires_at timestamptz,
  p_now timestamptz
)
RETURNS TABLE(replayed boolean,intent_id uuid,state text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $reserve$
DECLARE
  existing public.recurring_purchase_intents%ROWTYPE;
  actor_id text:=nullif(current_setting('app.actor_id',true),'');
  actor_account uuid:=nullif(current_setting('app.account_id',true),'')::uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_account IS NULL OR p_command IS NULL OR p_request_hash IS NULL
    OR p_request_hash!~'^[0-9a-f]{64}$'
    OR p_family NOT IN('operator_club','business_os')
    OR p_offer_code NOT IN('operator_club_monthly','operator_club_annual','business_os')
    OR p_environment NOT IN('test','staging','production')
    OR p_receiver_stripe_account_id IS NULL
    OR octet_length(p_receiver_stripe_account_id) NOT BETWEEN 1 AND 255
    OR p_catalog_version_id IS NULL OR p_price_binding_id IS NULL
    OR p_expires_at IS NULL OR NOT isfinite(p_expires_at)
    OR p_expires_at<>date_trunc('milliseconds',p_expires_at)
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR p_now<'2000-01-01 00:00:00+00'::timestamptz
    OR p_expires_at<=p_now OR p_expires_at>p_now+interval '24 hours'
    OR current_setting('app.actor_kind',true)<>'system'
    OR actor_id IS NULL OR octet_length(actor_id)>255
    OR actor_account IS DISTINCT FROM p_account
    OR (
      p_family='operator_club' AND (
        p_offer_code NOT IN('operator_club_monthly','operator_club_annual')
        OR p_academy_source_registry_id IS NULL
        OR p_setup_epoch_id IS NOT NULL OR p_setup_purchase_id IS NOT NULL
      )
    )
    OR (
      p_family='business_os' AND (
        p_offer_code<>'business_os' OR p_academy_source_registry_id IS NOT NULL
        OR p_setup_epoch_id IS NULL OR p_setup_purchase_id IS NULL
      )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_RECURRING_RESERVATION_INPUT_INVALID';
  END IF;

  PERFORM public.syntholo_lock_entitlement_graph(p_account);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'syntholo-commerce-recurring:'||p_account::text||':'||p_family,0
  ));

  IF EXISTS(
    SELECT 1 FROM public.account_holds hold
    WHERE hold.account_id=p_account AND hold.released_at IS NULL
  ) OR NOT EXISTS(
    SELECT 1
    FROM public.offers offer
    JOIN public.offer_catalog_versions catalog
      ON catalog.id=p_catalog_version_id
     AND catalog.offer_id=offer.id AND catalog.offer_code=offer.code
    JOIN public.offer_price_bindings price
      ON price.id=p_price_binding_id
     AND price.offer_id=offer.id AND price.offer_code=offer.code
     AND price.catalog_version_id=catalog.id
     AND price.environment=p_environment
     AND price.stripe_account_id=p_receiver_stripe_account_id
    WHERE offer.code=p_offer_code AND offer.state='enabled'
      AND offer.current_catalog_version_id=catalog.id
      AND catalog.state='published'
      AND price.enabled_at IS NOT NULL AND price.retired_at IS NULL
      AND price.price_role=CASE
        WHEN p_family='business_os' THEN 'business_os_monthly'
        ELSE p_offer_code
      END
  ) OR (
    p_family='operator_club' AND NOT EXISTS(
      SELECT 1
      FROM public.entitlement_sources source
      JOIN public.account_course_accesses access
        ON access.account_id=source.account_id
       AND access.entitlement_source_id=source.id AND access.status='active'
      WHERE source.id=p_academy_source_registry_id
        AND source.account_id=p_account AND source.offer_code='self_paced'
    )
  ) OR (
    p_family='business_os' AND NOT EXISTS(
      SELECT 1
      FROM public.business_os_setup_epochs epoch
      JOIN public.purchases purchase
        ON purchase.id=p_setup_purchase_id
       AND purchase.account_id=epoch.account_id
       AND purchase.environment=epoch.environment
       AND purchase.receiver_stripe_account_id=epoch.receiver_stripe_account_id
      WHERE epoch.id=p_setup_epoch_id AND epoch.account_id=p_account
        AND epoch.environment=p_environment
        AND epoch.receiver_stripe_account_id=p_receiver_stripe_account_id
        AND epoch.state='paid' AND purchase.offer_code='business_os'
        AND purchase.status='paid' AND purchase.source_registry_id IS NOT NULL
        AND epoch.source_registry_id=purchase.source_registry_id
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='COMMERCE_RECURRING_RESERVATION_NOT_ELIGIBLE';
  END IF;

  SELECT intent.* INTO existing
  FROM public.recurring_purchase_intents intent
  WHERE intent.reservation_command_id=p_command
  FOR UPDATE;
  IF FOUND THEN
    IF existing.account_id IS DISTINCT FROM p_account
      OR existing.reservation_request_hash IS DISTINCT FROM p_request_hash
      OR existing.family IS DISTINCT FROM p_family
      OR existing.offer_code IS DISTINCT FROM p_offer_code
      OR existing.environment IS DISTINCT FROM p_environment
      OR existing.receiver_stripe_account_id IS DISTINCT FROM p_receiver_stripe_account_id
      OR existing.catalog_version_id IS DISTINCT FROM p_catalog_version_id
      OR existing.price_binding_id IS DISTINCT FROM p_price_binding_id
      OR existing.setup_epoch_id IS DISTINCT FROM p_setup_epoch_id
      OR existing.setup_purchase_id IS DISTINCT FROM p_setup_purchase_id
      OR existing.academy_source_registry_id IS DISTINCT FROM p_academy_source_registry_id
      OR existing.expires_at IS DISTINCT FROM p_expires_at
    THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_RECURRING_RESERVATION_RECONCILIATION_REQUIRED';
    END IF;
    replayed:=true;intent_id:=existing.id;state:=existing.state;
    RETURN NEXT;RETURN;
  END IF;

  SELECT intent.* INTO existing
  FROM public.recurring_purchase_intents intent
  WHERE intent.account_id=p_account AND intent.family=p_family
    AND intent.state IN(
      'provider_call_pending','checkout_open','setup_succeeded','schedule_pending',
      'subscription_pending','active','grace','cancellation_pending'
    )
  FOR UPDATE;
  IF FOUND THEN
    IF existing.reservation_request_hash IS DISTINCT FROM p_request_hash
      OR existing.offer_code IS DISTINCT FROM p_offer_code
      OR existing.environment IS DISTINCT FROM p_environment
      OR existing.receiver_stripe_account_id IS DISTINCT FROM p_receiver_stripe_account_id
      OR existing.catalog_version_id IS DISTINCT FROM p_catalog_version_id
      OR existing.price_binding_id IS DISTINCT FROM p_price_binding_id
      OR existing.setup_epoch_id IS DISTINCT FROM p_setup_epoch_id
      OR existing.setup_purchase_id IS DISTINCT FROM p_setup_purchase_id
      OR existing.academy_source_registry_id IS DISTINCT FROM p_academy_source_registry_id
      OR existing.expires_at IS DISTINCT FROM p_expires_at
    THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_RECURRING_RESERVATION_RECONCILIATION_REQUIRED';
    END IF;
    replayed:=true;intent_id:=existing.id;state:=existing.state;
    RETURN NEXT;RETURN;
  END IF;

  PERFORM set_config('app.commerce_transition','active',true);
  INSERT INTO public.recurring_purchase_intents(
    account_id,reservation_command_id,reservation_request_hash,family,offer_code,
    environment,receiver_stripe_account_id,catalog_version_id,price_binding_id,
    setup_epoch_id,setup_purchase_id,academy_source_registry_id,expires_at,
    created_at,updated_at
  ) VALUES(
    p_account,p_command,p_request_hash,p_family,p_offer_code,p_environment,
    p_receiver_stripe_account_id,p_catalog_version_id,p_price_binding_id,
    p_setup_epoch_id,p_setup_purchase_id,p_academy_source_registry_id,
    p_expires_at,p_now,p_now
  ) RETURNING id,recurring_purchase_intents.state INTO intent_id,state;
  PERFORM set_config('app.commerce_transition','',true);
  replayed:=false;
  RETURN NEXT;
END
$reserve$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_reserve_recurring_purchase_v1(
  uuid,uuid,text,text,text,text,text,uuid,uuid,uuid,uuid,uuid,timestamptz,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_reserve_recurring_purchase_v1(
  uuid,uuid,text,text,text,text,text,uuid,uuid,uuid,uuid,uuid,timestamptz,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_record_provider_effect_v1(
  p_provider_receipt_id uuid,
  p_provider text,
  p_receiver_stripe_account_id text,
  p_lease_token uuid,
  p_lease_generation integer,
  p_account uuid,
  p_effect_kind text,
  p_target_object_id uuid,
  p_command uuid,
  p_now timestamptz
)
RETURNS TABLE(replayed boolean,effect_id uuid,command_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $effect$
DECLARE
  processing public.provider_event_processing%ROWTYPE;
  attempt public.provider_event_attempts%ROWTYPE;
  existing public.provider_event_effects%ROWTYPE;
  actor_id text:=nullif(current_setting('app.actor_id',true),'');
  actor_account uuid:=nullif(current_setting('app.account_id',true),'')::uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_provider_receipt_id IS NULL OR p_provider<>'stripe'
    OR p_receiver_stripe_account_id IS NULL
    OR octet_length(p_receiver_stripe_account_id) NOT BETWEEN 1 AND 255
    OR p_lease_token IS NULL OR p_lease_generation IS NULL
    OR p_lease_generation<=0
    OR p_effect_kind IS NULL OR p_effect_kind!~'^[a-z][a-z0-9_.]{0,63}$'
    OR p_target_object_id IS NULL OR p_command IS NULL
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR p_now<'2000-01-01 00:00:00+00'::timestamptz
    OR current_setting('app.actor_kind',true)<>'system'
    OR actor_id IS NULL OR octet_length(actor_id)>255
    OR actor_account IS DISTINCT FROM p_account
  THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_PROVIDER_EFFECT_INPUT_INVALID';
  END IF;

  SELECT processing_row.* INTO processing
  FROM public.provider_event_processing processing_row
  WHERE processing_row.receipt_id=p_provider_receipt_id
    AND processing_row.provider=p_provider
    AND processing_row.receiver_stripe_account_id=p_receiver_stripe_account_id
  FOR UPDATE;
  IF NOT FOUND OR processing.status<>'processing'
    OR processing.worker_id IS DISTINCT FROM actor_id
    OR processing.lease_token IS DISTINCT FROM p_lease_token
    OR processing.lease_generation IS DISTINCT FROM p_lease_generation
    OR processing.lease_expires_at IS NULL OR processing.lease_expires_at<=p_now
  THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='COMMERCE_PROVIDER_EFFECT_FENCE_INVALID';
  END IF;
  SELECT attempt_row.* INTO attempt
  FROM public.provider_event_attempts attempt_row
  WHERE attempt_row.receipt_id=processing.receipt_id
    AND attempt_row.provider=processing.provider
    AND attempt_row.receiver_stripe_account_id
      =processing.receiver_stripe_account_id
    AND attempt_row.attempt=p_lease_generation
    AND attempt_row.lease_generation=p_lease_generation
    AND attempt_row.lease_token=p_lease_token
  FOR SHARE;
  IF NOT FOUND OR attempt.worker_id IS DISTINCT FROM actor_id
    OR attempt.outcome IS DISTINCT FROM 'processing'
    OR attempt.finished_at IS NOT NULL OR attempt.started_at>p_now
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_PROVIDER_EFFECT_FENCE_INVALID';
  END IF;

  SELECT effect.* INTO existing
  FROM public.provider_event_effects effect
  WHERE effect.command_id=p_command
  FOR UPDATE;
  IF FOUND THEN
    IF existing.provider_receipt_id IS DISTINCT FROM p_provider_receipt_id
      OR existing.provider IS DISTINCT FROM p_provider
      OR existing.receiver_stripe_account_id IS DISTINCT FROM p_receiver_stripe_account_id
      OR existing.account_id IS DISTINCT FROM p_account
      OR existing.effect_kind IS DISTINCT FROM p_effect_kind
      OR existing.target_object_id IS DISTINCT FROM p_target_object_id
    THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_PROVIDER_EFFECT_RECONCILIATION_REQUIRED';
    END IF;
    replayed:=true;effect_id:=existing.id;command_id:=existing.command_id;
    RETURN NEXT;RETURN;
  END IF;

  SELECT effect.* INTO existing
  FROM public.provider_event_effects effect
  WHERE effect.provider=p_provider
    AND effect.receiver_stripe_account_id=p_receiver_stripe_account_id
    AND effect.effect_kind=p_effect_kind
    AND effect.target_object_id=p_target_object_id
  FOR UPDATE;
  IF FOUND THEN
    IF existing.account_id IS DISTINCT FROM p_account THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_PROVIDER_EFFECT_RECONCILIATION_REQUIRED';
    END IF;
    replayed:=true;effect_id:=existing.id;command_id:=existing.command_id;
    RETURN NEXT;RETURN;
  END IF;

  PERFORM set_config('app.commerce_transition','active',true);
  INSERT INTO public.provider_event_effects(
    provider_receipt_id,provider,receiver_stripe_account_id,account_id,
    effect_kind,target_object_id,command_id,created_at
  ) VALUES(
    p_provider_receipt_id,p_provider,p_receiver_stripe_account_id,p_account,
    p_effect_kind,p_target_object_id,p_command,p_now
  ) RETURNING id,provider_event_effects.command_id INTO effect_id,command_id;
  PERFORM set_config('app.commerce_transition','',true);
  replayed:=false;
  RETURN NEXT;
END
$effect$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_record_provider_effect_v1(
  uuid,text,text,uuid,integer,uuid,text,uuid,uuid,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_record_provider_effect_v1(
  uuid,text,text,uuid,integer,uuid,text,uuid,uuid,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_record_paid_purchase_v1(
  p_provider_receipt_id uuid,
  p_receiver_stripe_account_id text,
  p_lease_token uuid,
  p_lease_generation integer,
  p_authorization_id uuid,
  p_provider_payment_intent_id text,
  p_provider_charge_id text,
  p_gross_amount integer,
  p_tax_amount integer,
  p_purchased_at timestamptz,
  p_command_id uuid,
  p_now timestamptz
)
RETURNS TABLE(
  replayed boolean,
  purchase_id uuid,
  status text,
  source_registry_id uuid,
  fulfillment_status text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $paid_purchase$
DECLARE
  actor_account_text text:=nullif(current_setting('app.account_id',true),'');
  actor_account uuid;
  receipt public.provider_event_receipts%ROWTYPE;
  target_authorization public.checkout_authorizations%ROWTYPE;
  checkout_session public.checkout_sessions%ROWTYPE;
  provider_action public.checkout_provider_actions%ROWTYPE;
  catalog record;
  effect record;
  fulfillment record;
  existing public.purchases%ROWTYPE;
  expected_price_role text;
  fulfillment_input_hash text;
  source_text text;
  resolved_source uuid;
  resolved_status text;
  ready_course_count integer;
  learning_seed record;
  account_course_access_id uuid;
  workspace_seed_outcome text;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_provider_receipt_id IS NULL
    OR p_receiver_stripe_account_id IS NULL
    OR p_receiver_stripe_account_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    OR p_lease_token IS NULL OR p_lease_generation IS NULL
    OR p_lease_generation<=0
    OR p_authorization_id IS NULL
    OR p_provider_payment_intent_id IS NULL
    OR p_provider_payment_intent_id!~'^pi_[A-Za-z0-9._:-]+$'
    OR octet_length(p_provider_payment_intent_id) NOT BETWEEN 4 AND 255
    OR p_provider_charge_id IS NULL
    OR p_provider_charge_id!~'^ch_[A-Za-z0-9._:-]+$'
    OR octet_length(p_provider_charge_id) NOT BETWEEN 4 AND 255
    OR p_gross_amount IS NULL OR p_gross_amount<=0
    OR p_tax_amount IS NULL OR p_tax_amount<0 OR p_tax_amount>p_gross_amount
    OR p_purchased_at IS NULL OR NOT isfinite(p_purchased_at)
    OR p_purchased_at<>date_trunc('milliseconds',p_purchased_at)
    OR p_purchased_at<'2000-01-01 00:00:00+00'::timestamptz
    OR p_command_id IS NULL
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR p_now<'2000-01-01 00:00:00+00'::timestamptz
    OR p_purchased_at>p_now
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
    OR actor_account_text IS NULL
    OR actor_account_text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION USING
      ERRCODE='22023',MESSAGE='COMMERCE_PAID_PURCHASE_INPUT_INVALID';
  END IF;
  actor_account:=actor_account_text::uuid;

  SELECT effect_row.* INTO effect
  FROM public.syntholo_commerce_record_provider_effect_v1(
    p_provider_receipt_id,'stripe',p_receiver_stripe_account_id,
    p_lease_token,p_lease_generation,actor_account,'purchase.paid',
    p_authorization_id,p_command_id,p_now
  ) effect_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_PAID_PURCHASE_RECONCILIATION_REQUIRED';
  END IF;

  SELECT receipt_row.* INTO receipt
  FROM public.provider_event_receipts receipt_row
  WHERE receipt_row.id=p_provider_receipt_id
    AND receipt_row.provider='stripe'
    AND receipt_row.receiver_stripe_account_id=p_receiver_stripe_account_id
  FOR SHARE;
  IF NOT FOUND
    OR NOT (receipt.event_type IN(
      'checkout.session.completed','checkout.session.async_payment_succeeded'
    ))
    OR receipt.data_object_type IS DISTINCT FROM 'checkout.session'
    OR receipt.event_account IS NOT NULL OR receipt.event_context IS NOT NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_PAID_PURCHASE_RECEIPT_INVALID';
  END IF;

  SELECT authorization_row.* INTO target_authorization
  FROM public.checkout_authorizations authorization_row
  WHERE authorization_row.id=p_authorization_id
  FOR UPDATE;
  IF NOT FOUND
    OR target_authorization.account_id IS DISTINCT FROM actor_account
    OR target_authorization.public_intent_id IS NOT NULL
    OR target_authorization.setup_epoch_id IS NOT NULL
    OR target_authorization.recurring_intent_id IS NOT NULL
    OR target_authorization.offer_code NOT IN('self_paced','guided_pilot')
    OR target_authorization.receiver_stripe_account_id
      IS DISTINCT FROM p_receiver_stripe_account_id
    OR receipt.livemode IS DISTINCT FROM (target_authorization.environment='production')
    OR target_authorization.status NOT IN(
      'checkout_open','async_payment_pending','paid'
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE='42501',MESSAGE='COMMERCE_PAID_PURCHASE_NOT_AUTHORIZED';
  END IF;

  SELECT session_row.* INTO checkout_session
  FROM public.checkout_sessions session_row
  WHERE session_row.authorization_id=target_authorization.id
  FOR UPDATE;
  IF NOT FOUND
    OR checkout_session.account_id IS DISTINCT FROM actor_account
    OR checkout_session.environment IS DISTINCT FROM target_authorization.environment
    OR checkout_session.receiver_stripe_account_id
      IS DISTINCT FROM target_authorization.receiver_stripe_account_id
    OR checkout_session.provider_session_id IS DISTINCT FROM receipt.data_object_id
    OR checkout_session.mode IS DISTINCT FROM 'payment'
    OR checkout_session.status NOT IN('open','complete')
    OR checkout_session.payment_status NOT IN('paid','unpaid')
    OR (checkout_session.provider_payment_intent_id IS NOT NULL
      AND checkout_session.provider_payment_intent_id
        IS DISTINCT FROM p_provider_payment_intent_id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_PAID_PURCHASE_SESSION_INVALID';
  END IF;

  SELECT action_row.* INTO provider_action
  FROM public.checkout_provider_actions action_row
  WHERE action_row.authorization_id=target_authorization.id
    AND action_row.action_kind='create_checkout_session'
  FOR UPDATE;
  IF NOT FOUND
    OR provider_action.account_id IS DISTINCT FROM actor_account
    OR provider_action.environment IS DISTINCT FROM target_authorization.environment
    OR provider_action.receiver_stripe_account_id
      IS DISTINCT FROM target_authorization.receiver_stripe_account_id
    OR provider_action.provider_session_id
      IS DISTINCT FROM checkout_session.provider_session_id
    OR provider_action.status IS DISTINCT FROM 'succeeded'
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_PAID_PURCHASE_ACTION_INVALID';
  END IF;

  SELECT
    offer.code offer_code,offer.family,offer.purchase_model,
    catalog_version.state catalog_state,
    catalog_version.content_readiness_hash,
    binding.price_role,binding.currency,binding.unit_amount,
    binding.recurring_interval,binding.interval_count,binding.tax_behavior,
    binding.enabled_at,binding.retired_at
  INTO catalog
  FROM public.offers offer
  JOIN public.offer_catalog_versions catalog_version
    ON catalog_version.id=target_authorization.catalog_version_id
   AND catalog_version.offer_id=offer.id
   AND catalog_version.offer_code=offer.code
  JOIN public.offer_price_bindings binding
    ON binding.id=target_authorization.price_binding_id
   AND binding.offer_id=offer.id
   AND binding.offer_code=offer.code
   AND binding.catalog_version_id=catalog_version.id
   AND binding.environment=target_authorization.environment
   AND binding.stripe_account_id=target_authorization.receiver_stripe_account_id
  WHERE offer.id=target_authorization.offer_id AND offer.code=target_authorization.offer_code;
  expected_price_role:=CASE target_authorization.offer_code
    WHEN 'self_paced' THEN 'self_paced_once'
    WHEN 'guided_pilot' THEN 'guided_pilot_once'
  END;
  IF NOT FOUND
    OR catalog.family IS DISTINCT FROM 'academy'
    OR catalog.purchase_model IS DISTINCT FROM 'one_time'
    OR catalog.catalog_state NOT IN('published','retired')
    OR catalog.price_role IS DISTINCT FROM expected_price_role
    OR catalog.currency IS DISTINCT FROM 'usd'
    OR catalog.recurring_interval IS NOT NULL OR catalog.interval_count IS NOT NULL
    OR catalog.enabled_at IS NULL OR catalog.enabled_at>target_authorization.created_at
    OR (catalog.retired_at IS NOT NULL
      AND catalog.retired_at<target_authorization.created_at)
    OR (catalog.tax_behavior='inclusive'
      AND p_gross_amount IS DISTINCT FROM catalog.unit_amount)
    OR (catalog.tax_behavior='exclusive'
      AND p_gross_amount IS DISTINCT FROM catalog.unit_amount+p_tax_amount)
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_PAID_PURCHASE_CATALOG_INVALID';
  END IF;

  SELECT count(*) INTO ready_course_count
  FROM (
    SELECT course_version.course_id,course_version.id
    FROM public.course_versions course_version
    JOIN public.content_readiness_evaluations evaluation
      ON evaluation.course_version_id=course_version.id
     AND evaluation.gate_hash=catalog.content_readiness_hash
     AND evaluation.passed
     AND evaluation.issues='[]'::jsonb
    JOIN public.content_readiness_approvals approval
      ON approval.evaluation_id=evaluation.id
     AND approval.gate_hash=catalog.content_readiness_hash
    JOIN public.course_version_lessons lesson
      ON lesson.course_version_id=course_version.id
     AND lesson.course_id=course_version.course_id
    GROUP BY course_version.course_id,course_version.id
    HAVING count(*) FILTER(WHERE lesson.required)=18
  ) ready_course;
  IF catalog.content_readiness_hash IS NULL OR ready_course_count<>1 THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_PAID_PURCHASE_CONTENT_NOT_READY';
  END IF;
  SELECT course_version.course_id,course_version.id course_version_id
  INTO learning_seed
  FROM public.course_versions course_version
  JOIN public.content_readiness_evaluations evaluation
    ON evaluation.course_version_id=course_version.id
   AND evaluation.gate_hash=catalog.content_readiness_hash
   AND evaluation.passed
   AND evaluation.issues='[]'::jsonb
  JOIN public.content_readiness_approvals approval
    ON approval.evaluation_id=evaluation.id
   AND approval.gate_hash=catalog.content_readiness_hash
  WHERE (SELECT count(*) FROM public.course_version_lessons lesson
    WHERE lesson.course_version_id=course_version.id AND lesson.required)=18
  FOR SHARE OF course_version,evaluation,approval;

  SELECT purchase_row.* INTO existing
  FROM public.purchases purchase_row
  WHERE purchase_row.authorization_id=target_authorization.id
    OR (purchase_row.environment=target_authorization.environment
      AND purchase_row.receiver_stripe_account_id
        =target_authorization.receiver_stripe_account_id
      AND (purchase_row.provider_payment_intent_id=p_provider_payment_intent_id
        OR purchase_row.provider_charge_id=p_provider_charge_id))
  ORDER BY purchase_row.id
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    IF existing.account_id IS DISTINCT FROM actor_account
      OR existing.authorization_id IS DISTINCT FROM target_authorization.id
      OR existing.offer_code IS DISTINCT FROM target_authorization.offer_code
      OR existing.environment IS DISTINCT FROM target_authorization.environment
      OR existing.receiver_stripe_account_id
        IS DISTINCT FROM target_authorization.receiver_stripe_account_id
      OR existing.provider_payment_intent_id
        IS DISTINCT FROM p_provider_payment_intent_id
      OR existing.provider_charge_id IS DISTINCT FROM p_provider_charge_id
      OR existing.currency IS DISTINCT FROM 'usd'
      OR existing.gross_amount IS DISTINCT FROM p_gross_amount
      OR existing.tax_amount IS DISTINCT FROM p_tax_amount
      OR existing.purchased_at IS DISTINCT FROM p_purchased_at
      OR existing.status NOT IN('paid','paid_reconciliation')
      OR target_authorization.status IS DISTINCT FROM 'paid'
      OR checkout_session.status IS DISTINCT FROM 'complete'
      OR checkout_session.payment_status IS DISTINCT FROM 'paid'
      OR checkout_session.provider_payment_intent_id
        IS DISTINCT FROM p_provider_payment_intent_id
      OR NOT EXISTS(
        SELECT 1 FROM public.purchase_payment_allocations allocation
        WHERE allocation.purchase_id=existing.id
          AND allocation.account_id=existing.account_id
          AND allocation.environment=existing.environment
          AND allocation.receiver_stripe_account_id
            =existing.receiver_stripe_account_id
          AND allocation.provider_payment_object_type='charge'
          AND allocation.provider_payment_object_id=p_provider_charge_id
          AND allocation.gross_amount=p_gross_amount
          AND allocation.tax_amount=p_tax_amount
      )
      OR (existing.status='paid' AND NOT EXISTS(
        SELECT 1 FROM public.account_course_accesses access
        WHERE access.account_id=existing.account_id
          AND access.entitlement_source_id=existing.source_registry_id
          AND access.course_id=learning_seed.course_id
          AND access.course_version_id=learning_seed.course_version_id
          AND access.status='active'
      ))
    THEN
      RAISE EXCEPTION USING
        ERRCODE='23514',
        MESSAGE='COMMERCE_PAID_PURCHASE_RECONCILIATION_REQUIRED';
    END IF;
    IF existing.status='paid' THEN
      SELECT access.id INTO account_course_access_id
      FROM public.account_course_accesses access
      WHERE access.account_id=existing.account_id
        AND access.entitlement_source_id=existing.source_registry_id
        AND access.course_id=learning_seed.course_id
        AND access.course_version_id=learning_seed.course_version_id
        AND access.status='active'
      FOR SHARE;
      SELECT public.syntholo_implementation_seed_workspace_v1(account_course_access_id)
      INTO workspace_seed_outcome;
      IF workspace_seed_outcome IS DISTINCT FROM 'duplicate' THEN
        RAISE EXCEPTION USING
          ERRCODE='23514',
          MESSAGE='COMMERCE_PAID_PURCHASE_RECONCILIATION_REQUIRED';
      END IF;
    END IF;
    replayed:=true;
    purchase_id:=existing.id;
    status:=existing.status;
    source_registry_id:=existing.source_registry_id;
    fulfillment_status:=CASE existing.status
      WHEN 'paid' THEN 'fulfilled' ELSE 'reconciliation'
    END;
    RETURN NEXT;
    RETURN;
  END IF;
  IF effect.replayed OR target_authorization.status='paid'
    OR checkout_session.status='complete'
  THEN
    RAISE EXCEPTION USING
      ERRCODE='23514',
      MESSAGE='COMMERCE_PAID_PURCHASE_RECONCILIATION_REQUIRED';
  END IF;

  fulfillment_input_hash:=encode(sha256(convert_to(
    'commerce-paid-purchase.v1'||E'\n'||actor_account::text||E'\n'
    ||target_authorization.id::text||E'\n'||p_provider_payment_intent_id||E'\n'
    ||p_provider_charge_id||E'\n'||p_gross_amount::text||E'\n'
    ||p_tax_amount::text||E'\n'
    ||to_char(p_purchased_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'UTF8'
  )),'hex');
  SELECT fulfillment_row.* INTO fulfillment
  FROM public.syntholo_fulfill_product(
    actor_account,p_command_id,fulfillment_input_hash,'purchase',
    p_provider_payment_intent_id,target_authorization.offer_code,NULL,
    p_purchased_at,NULL,p_now
  ) fulfillment_row;
  IF NOT FOUND OR fulfillment.outcome IS DISTINCT FROM 'applied'
    OR fulfillment.result IS NULL
    OR jsonb_typeof(fulfillment.result)<>'object'
    OR fulfillment.result->>'fulfillmentStatus'
      NOT IN('fulfilled','reconciliation')
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',
      MESSAGE='COMMERCE_PAID_PURCHASE_RECONCILIATION_REQUIRED';
  END IF;
  fulfillment_status:=fulfillment.result->>'fulfillmentStatus';
  source_text:=fulfillment.result->>'sourceRegistryId';
  IF source_text IS NOT NULL
    AND source_text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',
      MESSAGE='COMMERCE_PAID_PURCHASE_RECONCILIATION_REQUIRED';
  END IF;
  resolved_source:=source_text::uuid;
  IF fulfillment_status='fulfilled' AND resolved_source IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',
      MESSAGE='COMMERCE_PAID_PURCHASE_RECONCILIATION_REQUIRED';
  END IF;
  resolved_status:=CASE fulfillment_status
    WHEN 'fulfilled' THEN 'paid' ELSE 'paid_reconciliation'
  END;

  IF fulfillment_status='fulfilled' THEN
    INSERT INTO public.account_course_accesses(
      account_id,entitlement_source_id,course_id,course_version_id,
      status,created_at
    ) VALUES(
      actor_account,resolved_source,learning_seed.course_id,
      learning_seed.course_version_id,'active',p_now
    ) RETURNING id INTO account_course_access_id;
    SELECT public.syntholo_implementation_seed_workspace_v1(account_course_access_id)
    INTO workspace_seed_outcome;
    IF workspace_seed_outcome IS DISTINCT FROM 'seeded' THEN
      RAISE EXCEPTION USING
        ERRCODE='55000',
        MESSAGE='COMMERCE_PAID_PURCHASE_RECONCILIATION_REQUIRED';
    END IF;
  END IF;

  INSERT INTO public.purchases(
    account_id,authorization_id,offer_code,environment,
    receiver_stripe_account_id,provider_payment_intent_id,provider_charge_id,
    currency,gross_amount,tax_amount,status,source_registry_id,
    purchased_at,created_at
  ) VALUES(
    actor_account,target_authorization.id,target_authorization.offer_code,
    target_authorization.environment,target_authorization.receiver_stripe_account_id,
    p_provider_payment_intent_id,p_provider_charge_id,'usd',p_gross_amount,
    p_tax_amount,resolved_status,resolved_source,p_purchased_at,p_now
  ) RETURNING id INTO purchase_id;
  INSERT INTO public.purchase_payment_allocations(
    purchase_id,account_id,environment,receiver_stripe_account_id,
    provider_payment_object_type,provider_payment_object_id,
    gross_amount,tax_amount,created_at
  ) VALUES(
    purchase_id,actor_account,target_authorization.environment,
    target_authorization.receiver_stripe_account_id,'charge',p_provider_charge_id,
    p_gross_amount,p_tax_amount,p_now
  );

  PERFORM set_config('app.commerce_transition','checkout_sessions',true);
  UPDATE public.checkout_sessions session_row
  SET status='complete',payment_status='paid',
    provider_payment_intent_id=p_provider_payment_intent_id,updated_at=p_now
  WHERE session_row.id=checkout_session.id
    AND session_row.authorization_id=target_authorization.id;
  PERFORM set_config('app.commerce_transition','',true);
  PERFORM set_config('app.commerce_transition','checkout_authorizations',true);
  UPDATE public.checkout_authorizations authorization_row
  SET status='paid',updated_at=p_now
  WHERE authorization_row.id=target_authorization.id
    AND authorization_row.status IN('checkout_open','async_payment_pending');
  PERFORM set_config('app.commerce_transition','',true);

  replayed:=false;
  status:=resolved_status;
  source_registry_id:=resolved_source;
  RETURN NEXT;
END
$paid_purchase$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_record_paid_purchase_v1(
  uuid,text,uuid,integer,uuid,text,text,integer,integer,timestamptz,uuid,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_record_paid_purchase_v1(
  uuid,text,uuid,integer,uuid,text,text,integer,integer,timestamptz,uuid,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_record_public_self_paced_paid_v1(
  p_provider_receipt_id uuid,p_receiver_stripe_account_id text,
  p_lease_token uuid,p_lease_generation integer,p_authorization_id uuid,
  p_provider_payment_intent_id text,p_provider_charge_id text,
  p_gross_amount integer,p_tax_amount integer,p_purchased_at timestamptz,
  p_command_id uuid,p_business_name text,p_claim_token_hash text,
  p_delivery_token_ciphertext bytea,p_delivery_token_nonce bytea,
  p_delivery_token_tag bytea,p_delivery_token_key_id text,p_now timestamptz
)
RETURNS TABLE(
  replayed boolean,account_id uuid,purchase_id uuid,status text,
  source_registry_id uuid,fulfillment_status text,claim_id uuid,delivery_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $public_self_paced_paid$
DECLARE
  receipt public.provider_event_receipts%ROWTYPE;
  target_authorization public.checkout_authorizations%ROWTYPE;
  checkout_session public.checkout_sessions%ROWTYPE;
  provider_action public.checkout_provider_actions%ROWTYPE;
  existing public.purchases%ROWTYPE;
  existing_claim public.claim_tokens%ROWTYPE;
  existing_delivery public.secure_link_deliveries%ROWTYPE;
  catalog record;
  learning_seed record;
  effect record;
  fulfillment record;
  replay_account uuid;
  resolved_source uuid;
  source_text text;
  resolved_status text;
  fulfillment_input_hash text;
  account_course_access_id uuid;
  workspace_seed_outcome text;
  ready_course_count integer;
  claim_event_id uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_provider_receipt_id IS NULL OR p_receiver_stripe_account_id IS NULL
    OR p_receiver_stripe_account_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    OR p_lease_token IS NULL OR p_lease_generation IS NULL
    OR p_lease_generation<=0 OR p_authorization_id IS NULL
    OR p_provider_payment_intent_id IS NULL
    OR p_provider_payment_intent_id!~'^pi_[A-Za-z0-9._:-]+$'
    OR octet_length(p_provider_payment_intent_id) NOT BETWEEN 4 AND 255
    OR p_provider_charge_id IS NULL
    OR p_provider_charge_id!~'^ch_[A-Za-z0-9._:-]+$'
    OR octet_length(p_provider_charge_id) NOT BETWEEN 4 AND 255
    OR p_gross_amount IS NULL OR p_gross_amount<=0
    OR p_tax_amount IS NULL OR p_tax_amount<0 OR p_tax_amount>p_gross_amount
    OR p_purchased_at IS NULL OR NOT isfinite(p_purchased_at)
    OR p_purchased_at<>date_trunc('milliseconds',p_purchased_at)
    OR p_purchased_at<'2000-01-01 00:00:00+00'::timestamptz
    OR p_command_id IS NULL
    OR p_business_name IS NULL
    OR NOT public.syntholo_account_name_is_canonical(p_business_name)
    OR p_claim_token_hash IS NULL OR p_claim_token_hash!~'^[0-9a-f]{64}$'
    OR octet_length(p_delivery_token_ciphertext) NOT BETWEEN 1 AND 4096
    OR octet_length(p_delivery_token_nonce)<>12
    OR octet_length(p_delivery_token_tag)<>16
    OR p_delivery_token_key_id IS NULL
    OR p_delivery_token_key_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR p_now<'2000-01-01 00:00:00+00'::timestamptz
    OR p_purchased_at>p_now
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
    OR nullif(current_setting('app.correlation_id',true),'') IS NULL
    OR nullif(current_setting('app.correlation_id',true),'')
      !~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR nullif(current_setting('app.account_id',true),'') IS NOT NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE='22023',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_INPUT_INVALID';
  END IF;

  SELECT purchase.account_id INTO replay_account
  FROM public.purchases purchase
  WHERE purchase.authorization_id=p_authorization_id
  ORDER BY purchase.id LIMIT 1;
  IF replay_account IS NOT NULL THEN
    PERFORM 1 FROM public.accounts account
    WHERE account.id=replay_account FOR UPDATE;
  END IF;

  SELECT authorization_row.* INTO target_authorization
  FROM public.checkout_authorizations authorization_row
  WHERE authorization_row.id=p_authorization_id FOR UPDATE;
  IF NOT FOUND OR target_authorization.account_id IS NOT NULL
    OR target_authorization.public_intent_id IS NOT NULL
    OR target_authorization.setup_epoch_id IS NOT NULL
    OR target_authorization.recurring_intent_id IS NOT NULL
    OR target_authorization.principal_kind IS DISTINCT FROM 'anonymous'
    OR target_authorization.offer_code IS DISTINCT FROM 'self_paced'
    OR target_authorization.contact_email_fingerprint IS NULL
    OR octet_length(target_authorization.contact_email_fingerprint)<>32
    OR target_authorization.business_name_content_hash IS DISTINCT FROM
      encode(sha256(convert_to(p_business_name,'UTF8')),'hex')
    OR target_authorization.account_name_schema_version IS DISTINCT FROM 'account_name_v1'
    OR target_authorization.receiver_stripe_account_id
      IS DISTINCT FROM p_receiver_stripe_account_id
    OR target_authorization.status NOT IN('checkout_open','async_payment_pending','paid','claim_sent')
  THEN
    RAISE EXCEPTION USING
      ERRCODE='42501',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_NOT_AUTHORIZED';
  END IF;

  SELECT receipt_row.* INTO receipt
  FROM public.provider_event_receipts receipt_row
  WHERE receipt_row.id=p_provider_receipt_id
    AND receipt_row.provider='stripe'
    AND receipt_row.receiver_stripe_account_id=p_receiver_stripe_account_id
  FOR SHARE;
  IF NOT FOUND OR receipt.event_type NOT IN(
      'checkout.session.completed','checkout.session.async_payment_succeeded'
    ) OR receipt.data_object_type IS DISTINCT FROM 'checkout.session'
    OR receipt.event_account IS NOT NULL OR receipt.event_context IS NOT NULL
    OR receipt.livemode IS DISTINCT FROM (target_authorization.environment='production')
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_RECEIPT_INVALID';
  END IF;
  SELECT session_row.* INTO checkout_session
  FROM public.checkout_sessions session_row
  WHERE session_row.authorization_id=target_authorization.id FOR UPDATE;
  IF NOT FOUND OR checkout_session.account_id IS NOT NULL
    OR checkout_session.environment IS DISTINCT FROM target_authorization.environment
    OR checkout_session.receiver_stripe_account_id
      IS DISTINCT FROM target_authorization.receiver_stripe_account_id
    OR checkout_session.provider_session_id IS DISTINCT FROM receipt.data_object_id
    OR checkout_session.mode IS DISTINCT FROM 'payment'
    OR checkout_session.status NOT IN('open','complete')
    OR checkout_session.payment_status NOT IN('paid','unpaid')
    OR (checkout_session.provider_payment_intent_id IS NOT NULL
      AND checkout_session.provider_payment_intent_id
        IS DISTINCT FROM p_provider_payment_intent_id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_SESSION_INVALID';
  END IF;
  SELECT action_row.* INTO provider_action
  FROM public.checkout_provider_actions action_row
  WHERE action_row.authorization_id=target_authorization.id
    AND action_row.action_kind='create_checkout_session' FOR UPDATE;
  IF NOT FOUND OR provider_action.account_id IS NOT NULL
    OR provider_action.environment IS DISTINCT FROM target_authorization.environment
    OR provider_action.receiver_stripe_account_id
      IS DISTINCT FROM target_authorization.receiver_stripe_account_id
    OR provider_action.provider_session_id
      IS DISTINCT FROM checkout_session.provider_session_id
    OR provider_action.status IS DISTINCT FROM 'succeeded'
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_ACTION_INVALID';
  END IF;

  SELECT offer.code offer_code,offer.family,offer.purchase_model,
    catalog_version.state catalog_state,catalog_version.content_readiness_hash,
    binding.price_role,binding.currency,binding.unit_amount,
    binding.recurring_interval,binding.interval_count,binding.tax_behavior,
    binding.enabled_at,binding.retired_at
  INTO catalog
  FROM public.offers offer
  JOIN public.offer_catalog_versions catalog_version
    ON catalog_version.id=target_authorization.catalog_version_id
   AND catalog_version.offer_id=offer.id
   AND catalog_version.offer_code=offer.code
  JOIN public.offer_price_bindings binding
    ON binding.id=target_authorization.price_binding_id
   AND binding.offer_id=offer.id AND binding.offer_code=offer.code
   AND binding.catalog_version_id=catalog_version.id
   AND binding.environment=target_authorization.environment
   AND binding.stripe_account_id=target_authorization.receiver_stripe_account_id
  WHERE offer.id=target_authorization.offer_id AND offer.code='self_paced';
  IF NOT FOUND OR catalog.family IS DISTINCT FROM 'academy'
    OR catalog.purchase_model IS DISTINCT FROM 'one_time'
    OR catalog.catalog_state NOT IN('published','retired')
    OR catalog.price_role IS DISTINCT FROM 'self_paced_once'
    OR catalog.currency IS DISTINCT FROM 'usd'
    OR catalog.recurring_interval IS NOT NULL OR catalog.interval_count IS NOT NULL
    OR catalog.enabled_at IS NULL OR catalog.enabled_at>target_authorization.created_at
    OR (catalog.retired_at IS NOT NULL AND catalog.retired_at<target_authorization.created_at)
    OR (catalog.tax_behavior='inclusive'
      AND p_gross_amount IS DISTINCT FROM catalog.unit_amount)
    OR (catalog.tax_behavior='exclusive'
      AND p_gross_amount IS DISTINCT FROM catalog.unit_amount+p_tax_amount)
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_CATALOG_INVALID';
  END IF;
  SELECT count(*) INTO ready_course_count
  FROM (
    SELECT course_version.course_id,course_version.id
    FROM public.course_versions course_version
    JOIN public.content_readiness_evaluations evaluation
      ON evaluation.course_version_id=course_version.id
     AND evaluation.gate_hash=catalog.content_readiness_hash
     AND evaluation.passed AND evaluation.issues='[]'::jsonb
    JOIN public.content_readiness_approvals approval
      ON approval.evaluation_id=evaluation.id
     AND approval.gate_hash=catalog.content_readiness_hash
    JOIN public.course_version_lessons lesson
      ON lesson.course_version_id=course_version.id
     AND lesson.course_id=course_version.course_id
    GROUP BY course_version.course_id,course_version.id
    HAVING count(*) FILTER(WHERE lesson.required)=18
  ) ready_course;
  IF catalog.content_readiness_hash IS NULL OR ready_course_count<>1 THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_CONTENT_NOT_READY';
  END IF;
  SELECT course_version.course_id,course_version.id course_version_id
  INTO learning_seed
  FROM public.course_versions course_version
  JOIN public.content_readiness_evaluations evaluation
    ON evaluation.course_version_id=course_version.id
   AND evaluation.gate_hash=catalog.content_readiness_hash
   AND evaluation.passed AND evaluation.issues='[]'::jsonb
  JOIN public.content_readiness_approvals approval
    ON approval.evaluation_id=evaluation.id
   AND approval.gate_hash=catalog.content_readiness_hash
  WHERE (SELECT count(*) FROM public.course_version_lessons lesson
    WHERE lesson.course_version_id=course_version.id AND lesson.required)=18
  FOR SHARE OF course_version,evaluation,approval;

  SELECT purchase.* INTO existing
  FROM public.purchases purchase
  WHERE purchase.authorization_id=target_authorization.id
    OR (purchase.environment=target_authorization.environment
      AND purchase.receiver_stripe_account_id=target_authorization.receiver_stripe_account_id
      AND (purchase.provider_payment_intent_id=p_provider_payment_intent_id
        OR purchase.provider_charge_id=p_provider_charge_id))
  ORDER BY purchase.id LIMIT 1 FOR UPDATE;
  IF FOUND AND replay_account IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE='40001',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_RESTART_REQUIRED';
  END IF;
  IF FOUND THEN
    account_id:=existing.account_id;
    IF account_id IS DISTINCT FROM replay_account
      OR existing.authorization_id IS DISTINCT FROM target_authorization.id
      OR existing.offer_code IS DISTINCT FROM 'self_paced'
      OR existing.provider_payment_intent_id IS DISTINCT FROM p_provider_payment_intent_id
      OR existing.provider_charge_id IS DISTINCT FROM p_provider_charge_id
      OR existing.gross_amount IS DISTINCT FROM p_gross_amount
      OR existing.tax_amount IS DISTINCT FROM p_tax_amount
      OR existing.purchased_at IS DISTINCT FROM p_purchased_at
      OR existing.status NOT IN('paid','paid_reconciliation')
      OR NOT EXISTS(SELECT 1 FROM public.accounts account
        WHERE account.id=existing.account_id AND account.name=p_business_name
          AND account.name_status='provisional')
    THEN
      RAISE EXCEPTION USING
        ERRCODE='23514',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_RECONCILIATION_REQUIRED';
    END IF;
    PERFORM set_config('app.account_id',account_id::text,true);
    SELECT * INTO effect FROM public.syntholo_commerce_record_provider_effect_v1(
      p_provider_receipt_id,'stripe',p_receiver_stripe_account_id,
      p_lease_token,p_lease_generation,account_id,'purchase.paid',
      p_authorization_id,p_command_id,p_now
    );
    IF NOT effect.replayed THEN
      RAISE EXCEPTION USING
        ERRCODE='23514',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_RECONCILIATION_REQUIRED';
    END IF;
    purchase_id:=existing.id;status:=existing.status;
    source_registry_id:=existing.source_registry_id;
    fulfillment_status:=CASE existing.status
      WHEN 'paid' THEN 'fulfilled' ELSE 'reconciliation' END;
    IF existing.status='paid' THEN
      SELECT claim.* INTO existing_claim FROM public.claim_tokens claim
      WHERE claim.purchase_id=existing.id AND claim.account_id=existing.account_id
      FOR SHARE;
      SELECT delivery.* INTO existing_delivery FROM public.secure_link_deliveries delivery
      WHERE delivery.claim_token_id=existing_claim.id
        AND delivery.account_id=existing.account_id FOR SHARE;
      IF NOT FOUND OR existing_claim.token_hash IS DISTINCT FROM p_claim_token_hash
        OR existing_claim.email_fingerprint
          IS DISTINCT FROM target_authorization.contact_email_fingerprint
        OR existing_claim.expires_at IS DISTINCT FROM existing_claim.created_at+interval '168 hours'
        OR existing_delivery.kind IS DISTINCT FROM 'claim'
        OR existing_delivery.token_ciphertext IS DISTINCT FROM p_delivery_token_ciphertext
        OR existing_delivery.token_nonce IS DISTINCT FROM p_delivery_token_nonce
        OR existing_delivery.token_tag IS DISTINCT FROM p_delivery_token_tag
        OR existing_delivery.token_key_id IS DISTINCT FROM p_delivery_token_key_id
      THEN
        RAISE EXCEPTION USING
          ERRCODE='23514',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_RECONCILIATION_REQUIRED';
      END IF;
      claim_id:=existing_claim.id;delivery_id:=existing_delivery.id;
      SELECT access.id INTO account_course_access_id
      FROM public.account_course_accesses access
      WHERE access.account_id=existing.account_id
        AND access.entitlement_source_id=existing.source_registry_id
        AND access.course_id=learning_seed.course_id
        AND access.course_version_id=learning_seed.course_version_id
        AND access.status='active' FOR SHARE;
      SELECT public.syntholo_implementation_seed_workspace_v1(account_course_access_id)
      INTO workspace_seed_outcome;
      IF workspace_seed_outcome IS DISTINCT FROM 'duplicate' THEN
        RAISE EXCEPTION USING
          ERRCODE='23514',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_RECONCILIATION_REQUIRED';
      END IF;
    END IF;
    PERFORM set_config('app.account_id','',true);
    replayed:=true;RETURN NEXT;RETURN;
  END IF;

  account_id:=gen_random_uuid();
  INSERT INTO public.accounts(
    id,name,name_status,status,owner_established_at,created_at,updated_at
  ) VALUES(account_id,p_business_name,'provisional','active',NULL,p_now,p_now);
  PERFORM set_config('app.account_id',account_id::text,true);
  SELECT * INTO effect FROM public.syntholo_commerce_record_provider_effect_v1(
    p_provider_receipt_id,'stripe',p_receiver_stripe_account_id,
    p_lease_token,p_lease_generation,account_id,'purchase.paid',
    p_authorization_id,p_command_id,p_now
  );
  IF effect.replayed THEN
    RAISE EXCEPTION USING
      ERRCODE='23514',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_RECONCILIATION_REQUIRED';
  END IF;
  fulfillment_input_hash:=encode(sha256(convert_to(
    'commerce-public-self-paced-paid.v1'||E'\n'||account_id::text||E'\n'
    ||target_authorization.id::text||E'\n'||p_provider_payment_intent_id||E'\n'
    ||p_provider_charge_id||E'\n'||p_gross_amount::text||E'\n'
    ||p_tax_amount::text||E'\n'||to_char(p_purchased_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'UTF8')),'hex');
  SELECT * INTO fulfillment FROM public.syntholo_fulfill_product(
    account_id,p_command_id,fulfillment_input_hash,'purchase',
    p_provider_payment_intent_id,'self_paced',NULL,p_purchased_at,NULL,p_now
  );
  IF NOT FOUND OR fulfillment.outcome IS DISTINCT FROM 'applied'
    OR fulfillment.result IS NULL OR jsonb_typeof(fulfillment.result)<>'object'
    OR fulfillment.result->>'fulfillmentStatus' NOT IN('fulfilled','reconciliation')
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_RECONCILIATION_REQUIRED';
  END IF;
  fulfillment_status:=fulfillment.result->>'fulfillmentStatus';
  source_text:=fulfillment.result->>'sourceRegistryId';
  IF source_text IS NOT NULL
    AND source_text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_RECONCILIATION_REQUIRED';
  END IF;
  resolved_source:=source_text::uuid;
  IF fulfillment_status='fulfilled' AND resolved_source IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_RECONCILIATION_REQUIRED';
  END IF;
  resolved_status:=CASE fulfillment_status WHEN 'fulfilled' THEN 'paid'
    ELSE 'paid_reconciliation' END;
  IF fulfillment_status='fulfilled' THEN
    INSERT INTO public.account_course_accesses(
      account_id,entitlement_source_id,course_id,course_version_id,status,created_at
    ) VALUES(
      account_id,resolved_source,learning_seed.course_id,
      learning_seed.course_version_id,'active',p_now
    ) RETURNING id INTO account_course_access_id;
    SELECT public.syntholo_implementation_seed_workspace_v1(account_course_access_id)
    INTO workspace_seed_outcome;
    IF workspace_seed_outcome IS DISTINCT FROM 'seeded' THEN
      RAISE EXCEPTION USING
        ERRCODE='55000',MESSAGE='COMMERCE_PUBLIC_SELF_PACED_PAID_RECONCILIATION_REQUIRED';
    END IF;
  END IF;
  INSERT INTO public.purchases(
    account_id,authorization_id,offer_code,environment,
    receiver_stripe_account_id,provider_payment_intent_id,provider_charge_id,
    currency,gross_amount,tax_amount,status,source_registry_id,purchased_at,created_at
  ) VALUES(
    account_id,target_authorization.id,'self_paced',target_authorization.environment,
    target_authorization.receiver_stripe_account_id,p_provider_payment_intent_id,
    p_provider_charge_id,'usd',p_gross_amount,p_tax_amount,resolved_status,
    resolved_source,p_purchased_at,p_now
  ) RETURNING id INTO purchase_id;
  INSERT INTO public.purchase_payment_allocations(
    purchase_id,account_id,environment,receiver_stripe_account_id,
    provider_payment_object_type,provider_payment_object_id,
    gross_amount,tax_amount,created_at
  ) VALUES(
    purchase_id,account_id,target_authorization.environment,
    target_authorization.receiver_stripe_account_id,'charge',p_provider_charge_id,
    p_gross_amount,p_tax_amount,p_now
  );
  IF fulfillment_status='fulfilled' THEN
    INSERT INTO public.claim_tokens(
      account_id,purchase_id,token_hash,email_fingerprint,email_ciphertext,
      email_nonce,email_tag,email_key_id,status,expires_at,created_at
    ) VALUES(
      account_id,purchase_id,p_claim_token_hash,
      target_authorization.contact_email_fingerprint,target_authorization.contact_ciphertext,
      target_authorization.contact_nonce,target_authorization.contact_tag,
      target_authorization.contact_key_id,'pending',p_now+interval '168 hours',p_now
    ) RETURNING id INTO claim_id;
    INSERT INTO public.secure_link_deliveries(
      account_id,kind,claim_token_id,token_ciphertext,token_nonce,token_tag,
      token_key_id,status,attempts,created_at
    ) VALUES(
      account_id,'claim',claim_id,p_delivery_token_ciphertext,
      p_delivery_token_nonce,p_delivery_token_tag,p_delivery_token_key_id,
      'pending',0,p_now
    ) RETURNING id INTO delivery_id;
    claim_event_id:=gen_random_uuid();
    INSERT INTO public.outbox_events(
      event_id,account_id,type,aggregate_id,payload,schema_version,status,
      attempts,available_at,created_at,occurred_at,actor_type,actor_id,
      correlation_id,max_attempts,claim_generation
    ) VALUES(
      claim_event_id,account_id,'identity.account_claim_ready.v1',claim_id::text,
      jsonb_build_object('deliveryId',delivery_id,'accountId',account_id),1,
      'pending',0,p_now,p_now,p_now,'system',
      current_setting('app.actor_id',true),
      nullif(current_setting('app.correlation_id',true),'')::uuid,10,0
    );
  END IF;
  PERFORM set_config('app.commerce_transition','checkout_sessions',true);
  UPDATE public.checkout_sessions session_row
  SET status='complete',payment_status='paid',
    provider_payment_intent_id=p_provider_payment_intent_id,updated_at=p_now
  WHERE session_row.id=checkout_session.id;
  PERFORM set_config('app.commerce_transition','',true);
  PERFORM set_config('app.commerce_transition','checkout_authorizations',true);
  UPDATE public.checkout_authorizations authorization_row
  SET status=CASE WHEN fulfillment_status='fulfilled' THEN 'claim_sent' ELSE 'paid' END,
    updated_at=p_now
  WHERE authorization_row.id=target_authorization.id;
  PERFORM set_config('app.commerce_transition','',true);
  PERFORM set_config('app.account_id','',true);
  replayed:=false;status:=resolved_status;source_registry_id:=resolved_source;
  RETURN NEXT;
END
$public_self_paced_paid$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_record_public_self_paced_paid_v1(
  uuid,text,uuid,integer,uuid,text,text,integer,integer,timestamptz,uuid,text,text,
  bytea,bytea,bytea,text,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_record_public_self_paced_paid_v1(
  uuid,text,uuid,integer,uuid,text,text,integer,integer,timestamptz,uuid,text,text,
  bytea,bytea,bytea,text,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_record_public_bos_setup_paid_v1(
  p_provider_receipt_id uuid,p_receiver_stripe_account_id text,
  p_lease_token uuid,p_lease_generation integer,p_public_intent_id uuid,
  p_authorization_id uuid,p_provider_customer_id text,
  p_provider_payment_intent_id text,p_provider_charge_id text,
  p_gross_amount integer,p_tax_amount integer,p_purchased_at timestamptz,
  p_command_id uuid,p_business_name text,p_claim_token_hash text,
  p_delivery_token_ciphertext bytea,p_delivery_token_nonce bytea,
  p_delivery_token_tag bytea,p_delivery_token_key_id text,
  p_reconciliation_reason text,p_now timestamptz
) RETURNS TABLE(
  replayed boolean,account_id uuid,purchase_id uuid,setup_epoch_id uuid,
  status text,source_registry_id uuid,setup_kind text,claim_id uuid,delivery_id uuid
) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $paid$
DECLARE
  intent public.public_business_os_setup_intents%ROWTYPE;
  target_authorization public.checkout_authorizations%ROWTYPE;
  checkout_session public.checkout_sessions%ROWTYPE;
  provider_action public.checkout_provider_actions%ROWTYPE;
  receipt public.provider_event_receipts%ROWTYPE;
  existing_fulfillment public.public_business_os_setup_fulfillments%ROWTYPE;
  existing_purchase public.purchases%ROWTYPE;
  command_result record;
  effect record;
  account_id_value uuid:=gen_random_uuid();
  purchase_id_value uuid:=gen_random_uuid();
  setup_epoch_id_value uuid:=gen_random_uuid();
  source_id_value uuid;
  setup_kind_value text;
  receipt_status_value text;
  command_input_hash text;
  claim_event_id uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_provider_receipt_id IS NULL OR p_receiver_stripe_account_id IS NULL
    OR p_receiver_stripe_account_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    OR p_lease_token IS NULL OR p_lease_generation IS NULL OR p_lease_generation<=0
    OR p_public_intent_id IS NULL OR p_authorization_id IS NULL
    OR p_provider_customer_id IS NULL OR p_provider_customer_id!~'^cus_[A-Za-z0-9._:-]+$'
    OR p_provider_payment_intent_id IS NULL
    OR p_provider_payment_intent_id!~'^pi_[A-Za-z0-9._:-]+$'
    OR p_provider_charge_id IS NULL OR p_provider_charge_id!~'^ch_[A-Za-z0-9._:-]+$'
    OR p_gross_amount IS NULL OR p_gross_amount<=0
    OR p_tax_amount IS NULL OR p_tax_amount<0 OR p_tax_amount>p_gross_amount
    OR p_purchased_at IS NULL OR NOT isfinite(p_purchased_at)
    OR p_purchased_at<>date_trunc('milliseconds',p_purchased_at)
    OR p_command_id IS NULL
    OR public.syntholo_account_name_is_canonical(p_business_name) IS DISTINCT FROM true
    OR p_claim_token_hash IS NULL OR p_claim_token_hash!~'^[0-9a-f]{64}$'
    OR octet_length(p_delivery_token_ciphertext) NOT BETWEEN 1 AND 4096
    OR octet_length(p_delivery_token_nonce)<>12 OR octet_length(p_delivery_token_tag)<>16
    OR p_delivery_token_key_id IS NULL
    OR p_delivery_token_key_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR (p_reconciliation_reason IS NOT NULL AND p_reconciliation_reason NOT IN(
      'STRIPE_CUSTOMER_OWNERSHIP_COLLISION','PAID_CLAIM_IDENTITY_CONFLICT',
      'PAID_IDENTITY_STATE_STALE','PAID_SEMANTIC_CONFLICT'))
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now) OR p_purchased_at>p_now
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
    OR nullif(current_setting('app.account_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.correlation_id',true),'')::uuid IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_PUBLIC_BOS_PAID_INPUT_INVALID';
  END IF;
  SELECT intent_row.* INTO intent FROM public.public_business_os_setup_intents intent_row
  WHERE intent_row.id=p_public_intent_id FOR UPDATE;
  IF NOT FOUND OR intent.environment<>'production'
    OR intent.receiver_stripe_account_id<>p_receiver_stripe_account_id
    OR intent.state NOT IN('checkout_open','async_payment_pending','paid_processing','paid_consumed')
  THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='COMMERCE_PUBLIC_BOS_PAID_NOT_AUTHORIZED';
  END IF;
  SELECT fulfillment.* INTO existing_fulfillment
  FROM public.public_business_os_setup_fulfillments fulfillment
  WHERE fulfillment.public_intent_id=intent.id FOR SHARE;
  IF FOUND THEN
    SELECT purchase.* INTO existing_purchase FROM public.purchases purchase
    WHERE purchase.id=existing_fulfillment.purchase_id
      AND purchase.account_id=existing_fulfillment.account_id FOR SHARE;
    SELECT claim.id,delivery.id INTO claim_id,delivery_id
    FROM public.claim_tokens claim
    JOIN public.secure_link_deliveries delivery
      ON delivery.claim_token_id=claim.id AND delivery.account_id=claim.account_id
    WHERE claim.purchase_id=existing_purchase.id;
    IF existing_purchase.id IS NULL OR intent.state<>'paid_consumed'
      OR existing_purchase.authorization_id<>p_authorization_id
      OR existing_purchase.provider_payment_intent_id<>p_provider_payment_intent_id
      OR existing_purchase.provider_charge_id<>p_provider_charge_id
      OR existing_purchase.gross_amount<>p_gross_amount
      OR existing_purchase.tax_amount<>p_tax_amount
      OR existing_purchase.purchased_at<>p_purchased_at
      OR (claim_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM public.claim_tokens claim
        WHERE claim.id=claim_id AND claim.token_hash=p_claim_token_hash))
    THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_PUBLIC_BOS_PAID_RECONCILIATION_REQUIRED';
    END IF;
    replayed:=true;account_id:=existing_fulfillment.account_id;
    purchase_id:=existing_purchase.id;setup_epoch_id:=existing_fulfillment.setup_epoch_id;
    status:=existing_purchase.status;source_registry_id:=existing_purchase.source_registry_id;
    setup_kind:=CASE WHEN existing_purchase.status='paid' THEN 'recorded'
      WHEN existing_purchase.source_registry_id IS NULL THEN 'provider_collision'
      ELSE 'parked_receipt' END;
    RETURN NEXT;RETURN;
  END IF;
  SELECT authorization_row.* INTO target_authorization
  FROM public.checkout_authorizations authorization_row
  WHERE authorization_row.id=p_authorization_id
    AND authorization_row.public_intent_id=intent.id FOR UPDATE;
  SELECT session_row.* INTO checkout_session FROM public.checkout_sessions session_row
  WHERE session_row.authorization_id=target_authorization.id FOR UPDATE;
  SELECT action_row.* INTO provider_action FROM public.checkout_provider_actions action_row
  WHERE action_row.authorization_id=target_authorization.id
    AND action_row.action_kind='create_business_os_setup_checkout' FOR UPDATE;
  SELECT receipt_row.* INTO receipt FROM public.provider_event_receipts receipt_row
  WHERE receipt_row.id=p_provider_receipt_id AND receipt_row.provider='stripe'
    AND receipt_row.receiver_stripe_account_id=p_receiver_stripe_account_id FOR SHARE;
  IF target_authorization.id IS NULL OR target_authorization.account_id IS NOT NULL
    OR target_authorization.offer_code<>'business_os'
    OR target_authorization.business_name_content_hash
      <>encode(sha256(convert_to(p_business_name,'UTF8')),'hex')
    OR target_authorization.account_name_schema_version<>'account_name_v1'
    OR target_authorization.status NOT IN('checkout_open','async_payment_pending')
    OR checkout_session.id IS NULL OR checkout_session.mode<>'payment'
    OR checkout_session.provider_session_id<>receipt.data_object_id
    OR checkout_session.provider_customer_id<>p_provider_customer_id
    OR checkout_session.status<>'open'
    OR checkout_session.payment_status NOT IN('unpaid','paid')
    OR provider_action.id IS NULL OR provider_action.status<>'succeeded'
    OR provider_action.provider_session_id<>checkout_session.provider_session_id
    OR receipt.id IS NULL OR receipt.event_type NOT IN(
      'checkout.session.completed','checkout.session.async_payment_succeeded')
    OR receipt.data_object_type<>'checkout.session'
    OR receipt.livemode IS DISTINCT FROM true
    OR p_gross_amount<>99900
  THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='COMMERCE_PUBLIC_BOS_PAID_RECEIPT_INVALID';
  END IF;
  IF p_reconciliation_reason IS NULL AND (
    EXISTS(SELECT 1 FROM public.stripe_customers customer
      WHERE customer.environment=intent.environment
        AND customer.receiver_stripe_account_id=intent.receiver_stripe_account_id
        AND customer.provider_customer_id=p_provider_customer_id)
    OR EXISTS(SELECT 1 FROM public.claim_tokens claim
      WHERE claim.token_hash=p_claim_token_hash)
  ) THEN
    RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='COMMERCE_PUBLIC_BOS_PAID_RESTART_REQUIRED';
  END IF;
  INSERT INTO public.accounts(
    id,name,name_status,status,owner_established_at,created_at,updated_at
  ) VALUES(account_id_value,p_business_name,'provisional','active',NULL,p_now,p_now);
  PERFORM set_config('app.account_id',account_id_value::text,true);
  SELECT effect_row.* INTO effect
  FROM public.syntholo_commerce_record_provider_effect_v1(
    p_provider_receipt_id,'stripe',p_receiver_stripe_account_id,p_lease_token,
    p_lease_generation,account_id_value,'business_os.setup.paid',intent.id,
    p_command_id,p_now
  ) effect_row;
  command_input_hash:=encode(sha256(convert_to(
    'commerce-public-business-os-setup.v1'||chr(10)||
    p_provider_payment_intent_id||chr(10)||p_purchased_at::text,'UTF8')),'hex');
  IF p_reconciliation_reason IS NULL THEN
    SELECT result_row.* INTO command_result
    FROM public.syntholo_record_business_os_setup_purchase(
      account_id_value,p_command_id,command_input_hash,
      p_provider_payment_intent_id,p_purchased_at,p_now
    ) result_row;
  ELSE
    SELECT result_row.* INTO command_result
    FROM public.syntholo_record_public_business_os_setup_reconciliation(
      account_id_value,p_command_id,command_input_hash,
      p_provider_payment_intent_id,p_purchased_at,p_reconciliation_reason,p_now
    ) result_row;
  END IF;
  IF command_result.outcome IS DISTINCT FROM 'applied'
    OR command_result.result IS NULL
    OR command_result.result->>'receiptStatus' NOT IN('paid','paid_reconciliation')
    OR command_result.result->>'setupKind'
      NOT IN('recorded','parked_receipt','provider_collision')
  THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_PUBLIC_BOS_PAID_RECONCILIATION_REQUIRED';
  END IF;
  receipt_status_value:=command_result.result->>'receiptStatus';
  setup_kind_value:=command_result.result->>'setupKind';
  source_id_value:=nullif(command_result.result->>'sourceRegistryId','')::uuid;
  IF receipt_status_value='paid' AND (setup_kind_value<>'recorded'
    OR source_id_value IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_PUBLIC_BOS_PAID_RECONCILIATION_REQUIRED';
  END IF;
  IF p_reconciliation_reason IS NULL THEN
    INSERT INTO public.stripe_customers(
      account_id,environment,receiver_stripe_account_id,provider_customer_id,
      checkout_session_id,checkout_authorization_id,public_intent_id,created_at
    ) VALUES(
      account_id_value,intent.environment,intent.receiver_stripe_account_id,
      p_provider_customer_id,checkout_session.id,target_authorization.id,intent.id,p_now
    );
  END IF;
  INSERT INTO public.business_os_setup_epochs(
    id,account_id,ordinal,environment,receiver_stripe_account_id,
    catalog_version_id,price_binding_id,state,public_intent_id,
    source_registry_id,provisioning_started_at,created_at,updated_at
  ) VALUES(
    setup_epoch_id_value,account_id_value,1,intent.environment,
    intent.receiver_stripe_account_id,intent.catalog_version_id,
    intent.price_binding_id,'paid',intent.id,source_id_value,
    CASE WHEN receipt_status_value='paid' THEN p_now END,p_now,p_now
  );
  INSERT INTO public.purchases(
    id,account_id,authorization_id,offer_code,environment,
    receiver_stripe_account_id,provider_payment_intent_id,provider_charge_id,
    currency,gross_amount,tax_amount,status,source_registry_id,purchased_at,created_at
  ) VALUES(
    purchase_id_value,account_id_value,target_authorization.id,'business_os',
    intent.environment,intent.receiver_stripe_account_id,
    p_provider_payment_intent_id,p_provider_charge_id,'usd',p_gross_amount,
    p_tax_amount,receipt_status_value,source_id_value,p_purchased_at,p_now
  );
  INSERT INTO public.purchase_payment_allocations(
    purchase_id,account_id,environment,receiver_stripe_account_id,
    provider_payment_object_type,provider_payment_object_id,gross_amount,
    tax_amount,created_at
  ) VALUES(
    purchase_id_value,account_id_value,intent.environment,
    intent.receiver_stripe_account_id,'charge',p_provider_charge_id,
    p_gross_amount,p_tax_amount,p_now
  );
  INSERT INTO public.public_business_os_setup_fulfillments(
    public_intent_id,account_id,environment,receiver_stripe_account_id,
    setup_epoch_id,purchase_id,source_registry_id,provider_receipt_id,
    provider,fulfilled_at
  ) VALUES(
    intent.id,account_id_value,intent.environment,intent.receiver_stripe_account_id,
    setup_epoch_id_value,purchase_id_value,source_id_value,p_provider_receipt_id,
    'stripe',p_now
  );
  IF receipt_status_value='paid' THEN
    INSERT INTO public.claim_tokens(
      account_id,purchase_id,token_hash,email_fingerprint,email_ciphertext,
      email_nonce,email_tag,email_key_id,status,expires_at,created_at
    ) VALUES(
      account_id_value,purchase_id_value,p_claim_token_hash,
      intent.purchaser_guard_hmac,intent.contact_ciphertext,intent.contact_nonce,
      intent.contact_tag,intent.contact_key_id,'pending',p_now+interval '168 hours',p_now
    ) RETURNING id INTO claim_id;
    INSERT INTO public.secure_link_deliveries(
      account_id,kind,claim_token_id,token_ciphertext,token_nonce,token_tag,
      token_key_id,status,attempts,created_at
    ) VALUES(
      account_id_value,'claim',claim_id,p_delivery_token_ciphertext,
      p_delivery_token_nonce,p_delivery_token_tag,p_delivery_token_key_id,
      'pending',0,p_now
    ) RETURNING id INTO delivery_id;
    claim_event_id:=gen_random_uuid();
    INSERT INTO public.outbox_events(
      event_id,account_id,type,aggregate_id,payload,schema_version,status,
      attempts,available_at,created_at,occurred_at,actor_type,actor_id,
      correlation_id,max_attempts,claim_generation
    ) VALUES(
      claim_event_id,account_id_value,'identity.account_claim_ready.v1',claim_id::text,
      jsonb_build_object('deliveryId',delivery_id,'accountId',account_id_value),
      1,'pending',0,p_now,p_now,p_now,'system',current_setting('app.actor_id',true),
      nullif(current_setting('app.correlation_id',true),'')::uuid,10,0
    );
  END IF;
  PERFORM set_config('app.commerce_transition','public_business_os_setup_intents',true);
  UPDATE public.public_business_os_setup_intents intent_row
  SET state='paid_consumed',business_name_ciphertext=NULL,
      business_name_nonce=NULL,business_name_tag=NULL,business_name_key_id=NULL,
      financial_retention_until=p_now+interval '7 years',updated_at=p_now
  WHERE intent_row.id=intent.id;
  PERFORM set_config('app.commerce_transition','checkout_sessions',true);
  UPDATE public.checkout_sessions session_row
  SET status='complete',payment_status='paid',
      provider_payment_intent_id=p_provider_payment_intent_id,updated_at=p_now
  WHERE session_row.id=checkout_session.id;
  PERFORM set_config('app.commerce_transition','checkout_authorizations',true);
  UPDATE public.checkout_authorizations authorization_row
  SET status=CASE WHEN claim_id IS NULL THEN 'paid' ELSE 'claim_sent' END,
      updated_at=p_now WHERE authorization_row.id=target_authorization.id;
  PERFORM set_config('app.commerce_transition','',true);
  PERFORM set_config('app.account_id','',true);
  replayed:=false;account_id:=account_id_value;purchase_id:=purchase_id_value;
  setup_epoch_id:=setup_epoch_id_value;status:=receipt_status_value;
  source_registry_id:=source_id_value;setup_kind:=setup_kind_value;RETURN NEXT;
END
$paid$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_record_public_bos_setup_paid_v1(
  uuid,text,uuid,integer,uuid,uuid,text,text,text,integer,integer,timestamptz,
  uuid,text,text,bytea,bytea,bytea,text,text,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_record_public_bos_setup_paid_v1(
  uuid,text,uuid,integer,uuid,uuid,text,text,text,integer,integer,timestamptz,
  uuid,text,text,bytea,bytea,bytea,text,text,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_initiate_claim_v1(
  p_claim_token_hash text,p_session_handle_hash text,p_now timestamptz
) RETURNS TABLE(
  replayed boolean,pending_session_id uuid,account_id uuid,offer_code text,
  business_name text,expires_at timestamptz
) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $claim$
DECLARE
  discovered_account uuid;
  target_claim public.claim_tokens%ROWTYPE;
  target_purchase public.purchases%ROWTYPE;
  target_account public.accounts%ROWTYPE;
  existing_session public.pending_claim_sessions%ROWTYPE;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_claim_token_hash IS NULL OR p_claim_token_hash!~'^[0-9a-f]{64}$'
    OR p_session_handle_hash IS NULL OR p_session_handle_hash!~'^[0-9a-f]{64}$'
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR p_now<'2000-01-01 00:00:00+00'::timestamptz
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
    OR nullif(current_setting('app.account_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.correlation_id',true),'')::uuid IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_CLAIM_INPUT_INVALID';
  END IF;

  SELECT claim.account_id INTO discovered_account
  FROM public.claim_tokens claim WHERE claim.token_hash=p_claim_token_hash;
  IF discovered_account IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='COMMERCE_CLAIM_NOT_FOUND';
  END IF;
  SELECT account_row.* INTO target_account FROM public.accounts account_row
  WHERE account_row.id=discovered_account FOR UPDATE;
  IF NOT FOUND OR target_account.status<>'active'
    OR target_account.name_status<>'provisional' THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='COMMERCE_CLAIM_NOT_FOUND';
  END IF;
  SELECT claim.* INTO target_claim FROM public.claim_tokens claim
  WHERE claim.token_hash=p_claim_token_hash AND claim.account_id=discovered_account
  FOR UPDATE;
  IF NOT FOUND OR target_claim.status<>'pending'
    OR target_claim.expires_at<=p_now OR target_claim.email_ciphertext IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='COMMERCE_CLAIM_NOT_FOUND';
  END IF;
  SELECT purchase.* INTO target_purchase FROM public.purchases purchase
  WHERE purchase.id=target_claim.purchase_id
    AND purchase.account_id=target_claim.account_id FOR SHARE;
  IF NOT FOUND OR target_purchase.offer_code NOT IN('self_paced','business_os')
    OR target_purchase.status<>'paid' OR target_purchase.source_registry_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_CLAIM_RECONCILIATION_REQUIRED';
  END IF;
  SELECT session.* INTO existing_session FROM public.pending_claim_sessions session
  WHERE session.claim_token_id=target_claim.id FOR UPDATE;
  IF FOUND THEN
    IF existing_session.account_id=target_claim.account_id
      AND existing_session.session_handle_hash=p_session_handle_hash
      AND existing_session.status='pending'
      AND existing_session.expires_at=target_claim.expires_at
      AND existing_session.expires_at>p_now THEN
      replayed:=true;pending_session_id:=existing_session.id;
      account_id:=target_claim.account_id;offer_code:=target_purchase.offer_code;
      business_name:=target_account.name;expires_at:=existing_session.expires_at;
      RETURN NEXT;RETURN;
    END IF;
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='COMMERCE_CLAIM_ALREADY_INITIATED';
  END IF;
  INSERT INTO public.pending_claim_sessions(
    claim_token_id,account_id,session_handle_hash,status,expires_at,created_at
  ) VALUES(
    target_claim.id,target_claim.account_id,p_session_handle_hash,'pending',
    target_claim.expires_at,p_now
  ) RETURNING id INTO pending_session_id;
  replayed:=false;account_id:=target_claim.account_id;
  offer_code:=target_purchase.offer_code;business_name:=target_account.name;
  expires_at:=target_claim.expires_at;RETURN NEXT;
END
$claim$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_initiate_claim_v1(
  text,text,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_initiate_claim_v1(
  text,text,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_redeem_claim_v1(
  p_session_handle_hash text,p_command_id uuid,p_owner_input_hash text,
  p_clerk_user_id text,p_verified_email text,p_verified_email_fingerprint bytea,
  p_now timestamptz
) RETURNS TABLE(
  replayed boolean,account_id uuid,identity_id uuid,membership_id uuid,
  enrollment_id uuid,seat_activated boolean
) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $claim$
DECLARE
  discovered_account uuid;
  target_session public.pending_claim_sessions%ROWTYPE;
  target_claim public.claim_tokens%ROWTYPE;
  target_purchase public.purchases%ROWTYPE;
  target_authorization public.checkout_authorizations%ROWTYPE;
  target_public_intent public.public_business_os_setup_intents%ROWTYPE;
  target_access public.account_course_accesses%ROWTYPE;
  target_delivery public.secure_link_deliveries%ROWTYPE;
  established record;
  existing_command public.entitlement_commands%ROWTYPE;
  existing_enrollment public.enrollments%ROWTYPE;
  new_enrollment_id uuid:=gen_random_uuid();
  resolved_identity_id uuid;
  resolved_membership_id uuid;
  resolved_enrollment_id uuid;
  resolved_seat_activated boolean;
  claimed_event_id uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_session_handle_hash IS NULL OR p_session_handle_hash!~'^[0-9a-f]{64}$'
    OR p_command_id IS NULL OR p_owner_input_hash IS NULL
    OR p_owner_input_hash!~'^[0-9a-f]{64}$'
    OR p_clerk_user_id IS NULL OR p_clerk_user_id!~'^[A-Za-z0-9._:-]{1,255}$'
    OR p_verified_email IS NULL
    OR lower(btrim(p_verified_email))!~'^[^[:space:]@]+@[^[:space:]@]+$'
    OR octet_length(lower(btrim(p_verified_email))) NOT BETWEEN 3 AND 320
    OR p_verified_email_fingerprint IS NULL
    OR octet_length(p_verified_email_fingerprint)<>32
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR p_now<'2000-01-01 00:00:00+00'::timestamptz
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
    OR nullif(current_setting('app.account_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.correlation_id',true),'')::uuid IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_CLAIM_INPUT_INVALID';
  END IF;
  SELECT session.account_id INTO discovered_account
  FROM public.pending_claim_sessions session
  WHERE session.session_handle_hash=p_session_handle_hash;
  IF discovered_account IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='COMMERCE_CLAIM_NOT_FOUND';
  END IF;
  PERFORM 1 FROM public.accounts account_row
  WHERE account_row.id=discovered_account AND account_row.status='active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='COMMERCE_CLAIM_NOT_FOUND';
  END IF;
  SELECT session.* INTO target_session FROM public.pending_claim_sessions session
  WHERE session.session_handle_hash=p_session_handle_hash
    AND session.account_id=discovered_account FOR UPDATE;
  SELECT claim.* INTO target_claim FROM public.claim_tokens claim
  WHERE claim.id=target_session.claim_token_id
    AND claim.account_id=target_session.account_id FOR UPDATE;
  SELECT purchase.* INTO target_purchase FROM public.purchases purchase
  WHERE purchase.id=target_claim.purchase_id
    AND purchase.account_id=target_claim.account_id FOR SHARE;
  SELECT authorization_row.* INTO target_authorization
  FROM public.checkout_authorizations authorization_row
  WHERE authorization_row.id=target_purchase.authorization_id FOR UPDATE;
  SELECT access.* INTO target_access FROM public.account_course_accesses access
  WHERE access.account_id=target_purchase.account_id
    AND access.entitlement_source_id=target_purchase.source_registry_id
    AND access.status='active' FOR SHARE;
  IF target_authorization.public_intent_id IS NOT NULL THEN
    SELECT intent.* INTO target_public_intent
    FROM public.public_business_os_setup_intents intent
    WHERE intent.id=target_authorization.public_intent_id
      AND intent.environment=target_authorization.environment
      AND intent.receiver_stripe_account_id=target_authorization.receiver_stripe_account_id
    FOR SHARE;
  END IF;
  SELECT delivery.* INTO target_delivery FROM public.secure_link_deliveries delivery
  WHERE delivery.claim_token_id=target_claim.id
    AND delivery.account_id=target_claim.account_id FOR UPDATE;
  IF target_session.id IS NULL OR target_claim.id IS NULL OR target_purchase.id IS NULL
    OR target_authorization.id IS NULL OR target_delivery.id IS NULL
    OR target_purchase.offer_code NOT IN('self_paced','business_os')
    OR target_purchase.status<>'paid' OR target_purchase.source_registry_id IS NULL
    OR target_authorization.offer_code<>'self_paced'
    OR target_authorization.account_id IS NOT NULL
    OR (target_purchase.offer_code='self_paced' AND (
      target_access.id IS NULL OR target_authorization.public_intent_id IS NOT NULL
      OR target_authorization.contact_email_fingerprint
        IS DISTINCT FROM target_claim.email_fingerprint
    ))
    OR (target_purchase.offer_code='business_os' AND (
      target_public_intent.id IS NULL OR target_access.id IS NOT NULL
      OR target_public_intent.purchaser_guard_hmac
        IS DISTINCT FROM target_claim.email_fingerprint
    ))
    OR target_claim.email_fingerprint IS DISTINCT FROM p_verified_email_fingerprint
  THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_CLAIM_RECONCILIATION_REQUIRED';
  END IF;
  IF target_session.status='consumed' OR target_claim.status='consumed' THEN
    SELECT command.* INTO existing_command FROM public.entitlement_commands command
    WHERE command.command_id=p_command_id AND command.account_id=discovered_account
      AND command.command_kind='establish_owner' AND command.actor_type='system'
      AND command.actor_id=current_setting('app.actor_id',true)
      AND command.input_hash=p_owner_input_hash AND command.outcome='applied'
    FOR SHARE;
    IF target_session.status<>'consumed' OR target_claim.status<>'consumed'
      OR target_session.candidate_principal_id IS DISTINCT FROM p_clerk_user_id
      OR existing_command.command_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_CLAIM_CONSUMED';
    END IF;
  ELSIF target_session.status<>'pending' OR target_claim.status<>'pending'
    OR target_session.expires_at<=p_now OR target_claim.expires_at<=p_now THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='COMMERCE_CLAIM_NOT_FOUND';
  END IF;
  PERFORM set_config('app.account_id',discovered_account::text,true);
  SELECT * INTO established FROM public.syntholo_establish_owner(
    discovered_account,p_command_id,p_owner_input_hash,p_clerk_user_id,
    lower(btrim(p_verified_email)),p_now
  );
  IF established.outcome IS DISTINCT FROM 'applied'
    OR established.result->>'identityId' IS NULL
    OR established.result->>'membershipId' IS NULL
    OR (established.result->>'seatActivated')::boolean
      IS DISTINCT FROM (target_purchase.offer_code='self_paced')
  THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='COMMERCE_CLAIM_OWNER_DENIED';
  END IF;
  resolved_identity_id:=(established.result->>'identityId')::uuid;
  resolved_membership_id:=(established.result->>'membershipId')::uuid;
  resolved_seat_activated:=(established.result->>'seatActivated')::boolean;
  IF target_purchase.offer_code='self_paced' THEN
    SELECT enrollment.* INTO existing_enrollment FROM public.enrollments enrollment
    WHERE enrollment.account_id=discovered_account
      AND enrollment.membership_id=resolved_membership_id
      AND enrollment.course_id=target_access.course_id
      AND enrollment.status='active' FOR UPDATE;
    IF FOUND THEN
      IF existing_enrollment.account_course_access_id<>target_access.id
        OR existing_enrollment.course_version_id<>target_access.course_version_id THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_CLAIM_RECONCILIATION_REQUIRED';
      END IF;
      resolved_enrollment_id:=existing_enrollment.id;
    ELSE
      INSERT INTO public.enrollments(
        id,account_id,account_course_access_id,membership_id,course_id,
        course_version_id,status,enrolled_at
      ) VALUES(
        new_enrollment_id,discovered_account,target_access.id,resolved_membership_id,
        target_access.course_id,target_access.course_version_id,'active',p_now
      );
      resolved_enrollment_id:=new_enrollment_id;
    END IF;
  END IF;
  IF target_session.status='pending' THEN
    INSERT INTO public.account_onboarding(
      account_id,product_family,version,business_name,current_step,
      created_at,updated_at
    ) SELECT account_row.id,
      CASE target_purchase.offer_code WHEN 'self_paced' THEN 'academy'
        ELSE 'business_os' END,
      1,account_row.name,'business',p_now,p_now
    FROM public.accounts account_row WHERE account_row.id=discovered_account
    ON CONFLICT ON CONSTRAINT account_onboarding_pkey DO NOTHING;
    IF NOT EXISTS(
      SELECT 1 FROM public.account_onboarding onboarding
      WHERE onboarding.account_id=discovered_account
        AND onboarding.product_family=CASE target_purchase.offer_code
          WHEN 'self_paced' THEN 'academy' ELSE 'business_os' END
        AND onboarding.completed_at IS NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_ONBOARDING_RECONCILIATION_REQUIRED';
    END IF;
    claimed_event_id:=gen_random_uuid();
    INSERT INTO public.outbox_events(
      event_id,account_id,type,aggregate_id,payload,schema_version,status,
      attempts,available_at,created_at,occurred_at,actor_type,actor_id,
      correlation_id,max_attempts,claim_generation
    ) VALUES(
      claimed_event_id,discovered_account,'identity.account_claimed.v1',
      target_claim.id::text,
      jsonb_strip_nulls(jsonb_build_object('claimId',target_claim.id,
        'membershipId',resolved_membership_id,
        'enrollmentId',resolved_enrollment_id)),
      1,'pending',0,p_now,p_now,p_now,'system',
      current_setting('app.actor_id',true),
      nullif(current_setting('app.correlation_id',true),'')::uuid,10,0
    );
    PERFORM set_config('app.commerce_transition','pending_claim_sessions',true);
    UPDATE public.pending_claim_sessions session
    SET status='consumed',candidate_principal_id=p_clerk_user_id,consumed_at=p_now
    WHERE session.id=target_session.id;
    PERFORM set_config('app.commerce_transition','claim_tokens',true);
    UPDATE public.claim_tokens claim
    SET status='consumed',email_ciphertext=NULL,email_nonce=NULL,email_tag=NULL,
        email_key_id=NULL,consumed_at=p_now WHERE claim.id=target_claim.id;
    PERFORM set_config('app.commerce_transition','secure_link_deliveries',true);
    UPDATE public.secure_link_deliveries delivery
    SET status='erased',token_ciphertext=NULL,token_nonce=NULL,token_tag=NULL,
        token_key_id=NULL,erased_at=p_now WHERE delivery.id=target_delivery.id;
    PERFORM set_config('app.commerce_transition','checkout_authorizations',true);
    UPDATE public.checkout_authorizations authorization_row
    SET status='consumed',contact_email_fingerprint=NULL,contact_ciphertext=NULL,
        contact_nonce=NULL,contact_tag=NULL,contact_key_id=NULL,
        business_name_ciphertext=NULL,business_name_nonce=NULL,
        business_name_tag=NULL,business_name_key_id=NULL,
        business_name_content_hash=NULL,account_name_schema_version=NULL,
        updated_at=p_now WHERE authorization_row.id=target_authorization.id;
    PERFORM set_config('app.commerce_transition','',true);
  END IF;
  replayed:=established.replayed;account_id:=discovered_account;
  identity_id:=resolved_identity_id;membership_id:=resolved_membership_id;
  enrollment_id:=resolved_enrollment_id;seat_activated:=resolved_seat_activated;
  PERFORM set_config('app.account_id','',true);RETURN NEXT;
END
$claim$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_redeem_claim_v1(
  text,uuid,text,text,text,bytea,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_redeem_claim_v1(
  text,uuid,text,text,text,bytea,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_get_onboarding_v1()
RETURNS TABLE(
  account_id uuid,product_family text,version integer,business_name text,
  website text,category text,country text,timezone text,team_size_band text,
  owner_role text,primary_goal text,tools jsonb,priorities text[],
  scorecard_attachment_id uuid,invitation_step_completed boolean,
  delivery_schedule_confirmed boolean,current_step text,completed_at timestamptz
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $onboarding$
DECLARE
  actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid;
  actor_account uuid:=nullif(current_setting('app.account_id',true),'')::uuid;
  actor_membership uuid:=nullif(current_setting('app.membership_id',true),'')::uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api');
  IF current_setting('app.actor_kind',true) IS DISTINCT FROM 'member'
    OR actor IS NULL OR actor_account IS NULL OR actor_membership IS NULL
    OR nullif(current_setting('app.correlation_id',true),'')::uuid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='COMMERCE_ONBOARDING_NOT_FOUND';
  END IF;
  PERFORM 1 FROM public.accounts account_row
  JOIN public.memberships membership ON membership.account_id=account_row.id
  WHERE account_row.id=actor_account AND account_row.status='active'
    AND membership.id=actor_membership AND membership.member_identity_id=actor
    AND membership.status='active';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='COMMERCE_ONBOARDING_NOT_FOUND';
  END IF;
  RETURN QUERY
  SELECT onboarding.account_id,onboarding.product_family,onboarding.version,
    onboarding.business_name,onboarding.website,onboarding.category,
    onboarding.country,onboarding.timezone,onboarding.team_size_band,
    onboarding.owner_role,onboarding.primary_goal,onboarding.tools,
    ARRAY(
      SELECT priority.priority FROM public.account_onboarding_priorities priority
      WHERE priority.account_id=onboarding.account_id
        AND priority.onboarding_version=onboarding.version
      ORDER BY priority.ordinal
    ),onboarding.scorecard_attachment_id,onboarding.invitation_step_completed,
    onboarding.delivery_schedule_confirmed,onboarding.current_step,
    onboarding.completed_at
  FROM public.account_onboarding onboarding
  WHERE onboarding.account_id=actor_account;
END
$onboarding$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_get_onboarding_v1()
FROM PUBLIC,syntholo_staff_api,syntholo_worker,syntholo_system_api;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_get_onboarding_v1()
TO syntholo_member_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_save_onboarding_v1(
  p_expected_version integer,p_business_name text,p_website text,p_category text,
  p_country text,p_timezone text,p_team_size_band text,p_owner_role text,
  p_primary_goal text,p_tools jsonb,p_priorities text[],
  p_scorecard_attachment_id uuid,p_invitation_step_completed boolean,
  p_delivery_schedule_confirmed boolean,p_current_step text,p_now timestamptz
) RETURNS TABLE(version integer,current_step text,completed boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $onboarding$
DECLARE
  actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid;
  actor_account uuid:=nullif(current_setting('app.account_id',true),'')::uuid;
  actor_membership uuid:=nullif(current_setting('app.membership_id',true),'')::uuid;
  target public.account_onboarding%ROWTYPE;
  next_updated_at timestamptz;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api');
  IF current_setting('app.actor_kind',true) IS DISTINCT FROM 'member'
    OR actor IS NULL OR actor_account IS NULL OR actor_membership IS NULL
    OR nullif(current_setting('app.correlation_id',true),'')::uuid IS NULL
    OR p_expected_version IS NULL OR p_expected_version<1
    OR public.syntholo_account_name_is_canonical(p_business_name) IS DISTINCT FROM true
    OR (p_website IS NOT NULL AND (octet_length(p_website) NOT BETWEEN 1 AND 2048
      OR p_website!~'^https://[^[:space:]]+$'))
    OR (p_category IS NOT NULL AND octet_length(p_category) NOT BETWEEN 1 AND 255)
    OR (p_country IS NOT NULL AND p_country!~'^[A-Z]{2}$')
    OR (p_timezone IS NOT NULL AND (octet_length(p_timezone) NOT BETWEEN 1 AND 255
      OR NOT EXISTS(SELECT 1 FROM pg_timezone_names zone WHERE zone.name=p_timezone)))
    OR (p_team_size_band IS NOT NULL
      AND p_team_size_band NOT IN('solo','2-5','6-10','11-25','26+'))
    OR (p_owner_role IS NOT NULL AND octet_length(p_owner_role) NOT BETWEEN 1 AND 255)
    OR (p_primary_goal IS NOT NULL AND octet_length(p_primary_goal) NOT BETWEEN 1 AND 1000)
    OR p_tools IS NULL OR jsonb_typeof(p_tools)<>'object'
    OR p_tools-'crm'-'scheduling'-'email'<>'{}'::jsonb
    OR NOT (p_tools ?& ARRAY['crm','scheduling','email'])
    OR EXISTS(
      SELECT 1 FROM jsonb_each(p_tools) entry
      WHERE jsonb_typeof(entry.value)<>'array'
        OR jsonb_array_length(entry.value)>20
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(entry.value) element
          WHERE jsonb_typeof(element)<>'string'
            OR octet_length(element#>>'{}') NOT BETWEEN 1 AND 128)
    )
    OR p_priorities IS NULL OR array_ndims(p_priorities)<>1
    OR array_lower(p_priorities,1)<>1 OR cardinality(p_priorities) NOT IN(0,3)
    OR EXISTS(SELECT 1 FROM unnest(p_priorities) priority
      WHERE priority IS NULL OR priority<>btrim(priority)
        OR octet_length(priority) NOT BETWEEN 1 AND 1000)
    OR (SELECT count(*)<>count(DISTINCT priority) FROM unnest(p_priorities) priority)
    OR p_invitation_step_completed IS NULL OR p_delivery_schedule_confirmed IS NULL
    OR p_current_step IS NULL
    OR p_current_step NOT IN('business','tools','priorities','team','delivery')
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR p_now<'2000-01-01 00:00:00+00'::timestamptz
  THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_ONBOARDING_INPUT_INVALID';
  END IF;
  PERFORM 1 FROM public.accounts account_row
  WHERE account_row.id=actor_account AND account_row.status='active' FOR UPDATE;
  PERFORM 1 FROM public.memberships membership
  WHERE membership.id=actor_membership AND membership.account_id=actor_account
    AND membership.member_identity_id=actor AND membership.status='active'
    AND membership.role='owner' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='COMMERCE_ONBOARDING_NOT_FOUND';
  END IF;
  SELECT onboarding.* INTO target FROM public.account_onboarding onboarding
  WHERE onboarding.account_id=actor_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='COMMERCE_ONBOARDING_NOT_FOUND';
  END IF;
  IF target.completed_at IS NOT NULL OR target.version<>p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='COMMERCE_ONBOARDING_VERSION_CONFLICT';
  END IF;
  next_updated_at:=greatest(p_now,target.updated_at+interval '1 millisecond');
  PERFORM set_config('app.commerce_transition','account_onboarding_priorities',true);
  DELETE FROM public.account_onboarding_priorities priority
  WHERE priority.account_id=actor_account
    AND priority.onboarding_version=target.version;
  PERFORM set_config('app.commerce_transition','account_onboarding',true);
  UPDATE public.account_onboarding onboarding
  SET version=target.version+1,business_name=p_business_name,website=p_website,
      category=p_category,country=p_country,timezone=p_timezone,
      team_size_band=p_team_size_band,owner_role=p_owner_role,
      primary_goal=p_primary_goal,tools=p_tools,
      scorecard_attachment_id=p_scorecard_attachment_id,
      invitation_step_completed=p_invitation_step_completed,
      delivery_schedule_confirmed=p_delivery_schedule_confirmed,
      current_step=p_current_step,updated_at=next_updated_at
  WHERE onboarding.account_id=actor_account;
  PERFORM set_config('app.commerce_transition','account_onboarding_priorities',true);
  INSERT INTO public.account_onboarding_priorities(
    account_id,onboarding_version,ordinal,priority,created_at
  ) SELECT actor_account,target.version+1,entry.ordinal,entry.priority,p_now
  FROM unnest(p_priorities) WITH ORDINALITY entry(priority,ordinal);
  PERFORM set_config('app.commerce_transition','',true);
  version:=target.version+1;current_step:=p_current_step;completed:=false;
  RETURN NEXT;
END
$onboarding$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_save_onboarding_v1(
  integer,text,text,text,text,text,text,text,text,jsonb,text[],uuid,boolean,boolean,
  text,timestamptz
) FROM PUBLIC,syntholo_staff_api,syntholo_worker,syntholo_system_api;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_save_onboarding_v1(
  integer,text,text,text,text,text,text,text,text,jsonb,text[],uuid,boolean,boolean,
  text,timestamptz
) TO syntholo_member_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_complete_onboarding_v1(
  p_expected_version integer,p_idempotency_key text,p_request_hash text,
  p_now timestamptz
) RETURNS TABLE(replayed boolean,version integer,destination text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $onboarding$
DECLARE
  actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid;
  actor_account uuid:=nullif(current_setting('app.account_id',true),'')::uuid;
  actor_membership uuid:=nullif(current_setting('app.membership_id',true),'')::uuid;
  correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid;
  principal text;
  computed_hash text;
  receipt public.api_command_receipts%ROWTYPE;
  target public.account_onboarding%ROWTYPE;
  destination_value text;
  response_payload jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api');
  IF current_setting('app.actor_kind',true) IS DISTINCT FROM 'member'
    OR actor IS NULL OR actor_account IS NULL OR actor_membership IS NULL
    OR correlation IS NULL OR p_expected_version IS NULL OR p_expected_version<1
    OR p_idempotency_key IS NULL OR p_idempotency_key!~'^[A-Za-z0-9._~-]{16,128}$'
    OR p_request_hash IS NULL OR p_request_hash!~'^[0-9a-f]{64}$'
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
  THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_ONBOARDING_INPUT_INVALID';
  END IF;
  PERFORM 1 FROM public.accounts account_row
  WHERE account_row.id=actor_account AND account_row.status='active' FOR UPDATE;
  PERFORM 1 FROM public.memberships membership
  WHERE membership.id=actor_membership AND membership.account_id=actor_account
    AND membership.member_identity_id=actor AND membership.status='active'
    AND membership.role='owner' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='COMMERCE_ONBOARDING_NOT_FOUND';
  END IF;
  principal:=actor::text||':'||actor_account::text||':'||actor_membership::text;
  computed_hash:=encode(sha256(convert_to(
    public.syntholo_canonical_jsonb_text_v1(jsonb_build_object(
      'routeVersion','commerce-onboarding-complete.v1','accountId',actor_account::text,
      'membershipId',actor_membership::text,'expectedVersion',p_expected_version
    )),'UTF8')),'hex');
  IF computed_hash<>p_request_hash THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_ONBOARDING_INPUT_INVALID';
  END IF;
  IF NOT pg_try_advisory_xact_lock(
    hashtext('commerce-onboarding-complete.v1'),hashtext(principal||':'||p_idempotency_key)
  ) THEN
    RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='IDEMPOTENCY_IN_PROGRESS';
  END IF;
  SELECT command_receipt.* INTO receipt FROM public.api_command_receipts command_receipt
  WHERE command_receipt.principal_kind='member'
    AND command_receipt.principal_id=principal AND command_receipt.method='POST'
    AND command_receipt.route_template='/v1/member/onboarding/completions'
    AND command_receipt.idempotency_key=p_idempotency_key FOR UPDATE;
  IF receipt.id IS NOT NULL THEN
    IF receipt.request_hash<>p_request_hash THEN
      RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='IDEMPOTENCY_KEY_REUSED';
    END IF;
    IF receipt.status='completed' THEN
      replayed:=true;version:=(receipt.response->>'version')::integer;
      destination:=receipt.response->>'destination';RETURN NEXT;RETURN;
    END IF;
    RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='IDEMPOTENCY_IN_PROGRESS';
  END IF;
  INSERT INTO public.api_command_receipts(
    principal_kind,principal_id,method,route_template,idempotency_key,
    request_hash,status,expires_at,created_at
  ) VALUES(
    'member',principal,'POST','/v1/member/onboarding/completions',
    p_idempotency_key,p_request_hash,'in_progress',p_now+interval '30 days',p_now
  ) RETURNING * INTO receipt;
  SELECT onboarding.* INTO target FROM public.account_onboarding onboarding
  WHERE onboarding.account_id=actor_account FOR UPDATE;
  IF NOT FOUND OR target.version<>p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='COMMERCE_ONBOARDING_VERSION_CONFLICT';
  END IF;
  IF target.completed_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_ONBOARDING_RECONCILIATION_REQUIRED';
  END IF;
  IF public.syntholo_account_name_is_canonical(target.business_name) IS DISTINCT FROM true
    OR target.category IS NULL OR target.country IS NULL OR target.timezone IS NULL
    OR target.team_size_band IS NULL OR target.owner_role IS NULL
    OR target.primary_goal IS NULL OR target.delivery_schedule_confirmed IS NOT TRUE
    OR (SELECT count(*)<>3 FROM public.account_onboarding_priorities priority
      WHERE priority.account_id=actor_account
        AND priority.onboarding_version=target.version)
  THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_ONBOARDING_INCOMPLETE';
  END IF;
  IF target.product_family='academy' THEN
    IF NOT EXISTS(
      SELECT 1 FROM public.enrollments enrollment
      JOIN public.account_course_accesses access
        ON access.id=enrollment.account_course_access_id
       AND access.account_id=enrollment.account_id
       AND access.course_id=enrollment.course_id
       AND access.course_version_id=enrollment.course_version_id
      JOIN public.purchases purchase
        ON purchase.account_id=access.account_id
       AND purchase.source_registry_id=access.entitlement_source_id
      WHERE enrollment.account_id=actor_account
        AND enrollment.membership_id=actor_membership
        AND enrollment.status='active' AND access.status='active'
        AND purchase.offer_code IN('self_paced','guided_pilot')
        AND purchase.status='paid'
    ) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='COMMERCE_ONBOARDING_PRODUCT_UNAVAILABLE';
    END IF;
    destination_value:='academy';
  ELSIF target.product_family='business_os' THEN
    IF NOT EXISTS(
      SELECT 1 FROM public.entitlement_grants grant_row
      JOIN public.business_os_setup_receipts setup
        ON setup.account_id=grant_row.account_id AND setup.status='paid'
      WHERE grant_row.account_id=actor_account
        AND grant_row.capability='business_os'
        AND grant_row.source_kind='subscription'
        AND grant_row.offer_code='business_os'
        AND grant_row.status IN('active','grace')
    ) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='COMMERCE_ONBOARDING_PRODUCT_UNAVAILABLE';
    END IF;
    destination_value:='business_os';
  ELSE
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_ONBOARDING_RECONCILIATION_REQUIRED';
  END IF;
  UPDATE public.accounts account_row
  SET name=target.business_name,name_status='confirmed',updated_at=p_now
  WHERE account_row.id=actor_account;
  PERFORM set_config('app.commerce_transition','account_onboarding',true);
  UPDATE public.account_onboarding onboarding
  SET current_step='complete',completed_at=p_now,
      updated_at=greatest(p_now,target.updated_at+interval '1 millisecond')
  WHERE onboarding.account_id=actor_account;
  PERFORM set_config('app.commerce_transition','',true);
  response_payload:=jsonb_build_object(
    'version',target.version,'destination',destination_value
  );
  UPDATE public.api_command_receipts command_receipt
  SET status='completed',response_status=200,response=response_payload,
      completed_at=p_now WHERE command_receipt.id=receipt.id;
  INSERT INTO public.audit_events(
    id,account_id,actor_type,actor_id,action,target_type,target_id,
    correlation_id,payload,occurred_at
  ) VALUES(
    gen_random_uuid(),actor_account,'member',actor::text,'onboarding_completed',
    'account',actor_account::text,correlation,
    jsonb_build_object('version',target.version,'destination',destination_value),p_now
  );
  INSERT INTO public.outbox_events(
    event_id,account_id,type,aggregate_id,payload,schema_version,status,attempts,
    available_at,created_at,occurred_at,actor_type,actor_id,correlation_id,
    max_attempts,claim_generation
  ) VALUES(
    receipt.id,actor_account,'onboarding.completed.v1',actor_account::text,
    response_payload,1,'pending',0,p_now,p_now,p_now,'member',actor::text,
    correlation,10,0
  );
  replayed:=false;version:=target.version;destination:=destination_value;
  RETURN NEXT;
END
$onboarding$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_complete_onboarding_v1(
  integer,text,text,timestamptz
) FROM PUBLIC,syntholo_staff_api,syntholo_worker,syntholo_system_api;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_complete_onboarding_v1(
  integer,text,text,timestamptz
) TO syntholo_member_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_record_provider_event_v1(
  p_provider_event_id text,
  p_event_type text,
  p_livemode boolean,
  p_api_version text,
  p_provider_created_at timestamptz,
  p_data_object_type text,
  p_data_object_id text,
  p_event_object_valid boolean,
  p_receiver_stripe_account_id text,
  p_event_account text,
  p_event_context text,
  p_raw_body_sha256 text,
  p_expected_livemode boolean,
  p_expected_api_version text,
  p_expected_receiver_stripe_account_id text,
  p_now timestamptz
)
RETURNS TABLE(replayed boolean,receipt_id uuid,status text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $record_event$
DECLARE
  stored public.provider_event_receipts%ROWTYPE;
  processing public.provider_event_processing%ROWTYPE;
  current_attempt public.provider_event_attempts%ROWTYPE;
  inserted_id uuid;
  terminal_token uuid;
  terminal_generation integer;
  context_mismatch boolean;
  terminal_code text;
  envelope_mismatch boolean;
  actor_id text:=nullif(current_setting('app.actor_id',true),'');
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_provider_event_id IS NULL OR p_provider_event_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    OR p_event_type IS NULL OR p_event_type!~'^[a-z][a-z0-9_.]{0,127}$'
    OR p_livemode IS NULL
    OR (p_api_version IS NOT NULL
      AND p_api_version!~'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
    OR p_provider_created_at IS NULL OR NOT isfinite(p_provider_created_at)
    OR p_provider_created_at<>date_trunc('milliseconds',p_provider_created_at)
    OR p_data_object_type IS NULL OR p_data_object_type!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    OR p_data_object_id IS NULL OR p_data_object_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    OR p_event_object_valid IS NULL
    OR p_receiver_stripe_account_id IS NULL
    OR p_receiver_stripe_account_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    OR (p_event_account IS NOT NULL AND p_event_account!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$')
    OR (p_event_context IS NOT NULL AND p_event_context!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$')
    OR p_raw_body_sha256 IS NULL OR p_raw_body_sha256!~'^[0-9a-f]{64}$'
    OR p_expected_livemode IS NULL
    OR p_expected_api_version IS NULL
    OR p_expected_api_version!~'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    OR p_expected_receiver_stripe_account_id IS NULL
    OR p_expected_receiver_stripe_account_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR p_now<'2000-01-01 00:00:00+00'::timestamptz
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR actor_id IS NULL OR actor_id!~'^[A-Za-z0-9._:-]{1,255}$'
    OR nullif(current_setting('app.account_id',true),'') IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_PROVIDER_EVENT_INPUT_INVALID';
  END IF;

  context_mismatch:=p_livemode IS DISTINCT FROM p_expected_livemode
    OR p_api_version IS DISTINCT FROM p_expected_api_version
    OR p_receiver_stripe_account_id IS DISTINCT FROM p_expected_receiver_stripe_account_id
    OR p_event_account IS NOT NULL OR p_event_context IS NOT NULL;
  terminal_code:=CASE WHEN context_mismatch
    THEN 'security_context_mismatch' ELSE 'event_object_mismatch' END;

  INSERT INTO public.provider_event_receipts(
    provider,provider_event_id,event_type,livemode,api_version,
    provider_created_at,data_object_type,data_object_id,
    receiver_stripe_account_id,event_account,event_context,raw_body_sha256,
    status,payload,received_at,processed_at,last_error_code
  ) VALUES(
    'stripe',p_provider_event_id,p_event_type,p_livemode,p_api_version,
    p_provider_created_at,p_data_object_type,p_data_object_id,
    p_receiver_stripe_account_id,p_event_account,p_event_context,p_raw_body_sha256,
    'received','{}'::jsonb,p_now,NULL,NULL
  ) ON CONFLICT(provider,provider_event_id) DO NOTHING
  RETURNING id INTO inserted_id;

  IF inserted_id IS NOT NULL THEN
    IF context_mismatch OR NOT p_event_object_valid THEN
      terminal_token:=gen_random_uuid();
      INSERT INTO public.provider_event_processing(
        receipt_id,provider,receiver_stripe_account_id,status,worker_id,
        lease_token,lease_generation,lease_expires_at,outcome_code,
        completed_at,updated_at
      ) VALUES(
        inserted_id,'stripe',p_receiver_stripe_account_id,'failed_terminal',NULL,
        NULL,1,NULL,terminal_code,p_now,p_now
      );
      INSERT INTO public.provider_event_attempts(
        receipt_id,provider,receiver_stripe_account_id,attempt,lease_generation,
        lease_token,worker_id,outcome,safe_code,started_at,finished_at
      ) VALUES(
        inserted_id,'stripe',p_receiver_stripe_account_id,1,1,terminal_token,
        actor_id,'failed_terminal',terminal_code,p_now,p_now
      );
      replayed:=false;receipt_id:=inserted_id;status:='failed_terminal';
    ELSE
      INSERT INTO public.provider_event_processing(
        receipt_id,provider,receiver_stripe_account_id,status,updated_at
      ) VALUES(inserted_id,'stripe',p_receiver_stripe_account_id,'received',p_now);
      replayed:=false;receipt_id:=inserted_id;status:='received';
    END IF;
    RETURN NEXT;RETURN;
  END IF;

  SELECT receipt.* INTO stored
  FROM public.provider_event_receipts receipt
  WHERE receipt.provider='stripe' AND receipt.provider_event_id=p_provider_event_id;
  SELECT processing_row.* INTO processing
  FROM public.provider_event_processing processing_row
  WHERE processing_row.receipt_id=stored.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='COMMERCE_PROVIDER_EVENT_RECONCILIATION_REQUIRED';
  END IF;

  envelope_mismatch:=stored.event_type IS DISTINCT FROM p_event_type
    OR stored.livemode IS DISTINCT FROM p_livemode
    OR stored.api_version IS DISTINCT FROM p_api_version
    OR stored.provider_created_at IS DISTINCT FROM p_provider_created_at
    OR stored.data_object_type IS DISTINCT FROM p_data_object_type
    OR stored.data_object_id IS DISTINCT FROM p_data_object_id
    OR stored.receiver_stripe_account_id IS DISTINCT FROM p_receiver_stripe_account_id
    OR stored.event_account IS DISTINCT FROM p_event_account
    OR stored.event_context IS DISTINCT FROM p_event_context
    OR stored.raw_body_sha256 IS DISTINCT FROM p_raw_body_sha256;
  IF NOT envelope_mismatch THEN
    replayed:=true;receipt_id:=stored.id;status:=processing.status;
    RETURN NEXT;RETURN;
  END IF;

  IF processing.status='failed_terminal'
    AND processing.outcome_code='security_envelope_mismatch'
  THEN
    replayed:=true;receipt_id:=stored.id;status:='failed_terminal';
    RETURN NEXT;RETURN;
  END IF;

  IF processing.status='processing' THEN
    SELECT attempt.* INTO current_attempt
    FROM public.provider_event_attempts attempt
    WHERE attempt.receipt_id=processing.receipt_id
      AND attempt.attempt=processing.lease_generation
      AND attempt.lease_generation=processing.lease_generation
    FOR UPDATE;
    IF NOT FOUND OR current_attempt.outcome<>'processing'
      OR current_attempt.lease_token IS DISTINCT FROM processing.lease_token
      OR current_attempt.worker_id IS DISTINCT FROM processing.worker_id
    THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='COMMERCE_PROVIDER_EVENT_RECONCILIATION_REQUIRED';
    END IF;
    PERFORM set_config('app.commerce_transition','provider_event_attempts',true);
    UPDATE public.provider_event_attempts attempt
    SET outcome='failed_terminal',safe_code='security_envelope_mismatch',finished_at=p_now
    WHERE attempt.receipt_id=processing.receipt_id
      AND attempt.attempt=processing.lease_generation
      AND attempt.lease_generation=processing.lease_generation;
    PERFORM set_config('app.commerce_transition','',true);
  END IF;

  terminal_generation:=processing.lease_generation+1;
  terminal_token:=gen_random_uuid();
  INSERT INTO public.provider_event_attempts(
    receipt_id,provider,receiver_stripe_account_id,attempt,lease_generation,
    lease_token,worker_id,outcome,safe_code,started_at,finished_at
  ) VALUES(
    processing.receipt_id,processing.provider,processing.receiver_stripe_account_id,
    terminal_generation,terminal_generation,terminal_token,actor_id,
    'failed_terminal','security_envelope_mismatch',p_now,p_now
  );
  PERFORM set_config('app.commerce_transition','provider_event_processing',true);
  UPDATE public.provider_event_processing processing_row
  SET status='failed_terminal',worker_id=NULL,lease_token=NULL,
      lease_generation=terminal_generation,lease_expires_at=NULL,
      outcome_code='security_envelope_mismatch',completed_at=p_now,updated_at=p_now
  WHERE processing_row.receipt_id=processing.receipt_id;
  PERFORM set_config('app.commerce_transition','',true);
  replayed:=true;receipt_id:=stored.id;status:='failed_terminal';
  RETURN NEXT;
END
$record_event$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_record_provider_event_v1(
  text,text,boolean,text,timestamptz,text,text,boolean,text,text,text,text,
  boolean,text,text,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_record_provider_event_v1(
  text,text,boolean,text,timestamptz,text,text,boolean,text,text,text,text,
  boolean,text,text,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_claim_provider_event_v1(
  p_worker_id text,
  p_lease_duration_ms integer,
  p_now timestamptz
)
RETURNS TABLE(
  receipt_id uuid,
  provider_event_id text,
  event_type text,
  livemode boolean,
  api_version text,
  provider_created_at timestamptz,
  data_object_type text,
  data_object_id text,
  receiver_stripe_account_id text,
  event_account text,
  event_context text,
  raw_body_sha256 text,
  received_at timestamptz,
  lease_token uuid,
  lease_generation integer,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $claim$
DECLARE
  target public.provider_event_processing%ROWTYPE;
  current_attempt public.provider_event_attempts%ROWTYPE;
  next_token uuid;
  next_generation integer;
  next_expiry timestamptz;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_worker_id IS NULL OR p_worker_id!~'^[A-Za-z0-9._:-]{1,255}$'
    OR p_lease_duration_ms IS NULL OR p_lease_duration_ms NOT BETWEEN 1000 AND 300000
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR p_now<'2000-01-01 00:00:00+00'::timestamptz
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS DISTINCT FROM p_worker_id
    OR nullif(current_setting('app.account_id',true),'') IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_PROVIDER_EVENT_CLAIM_INPUT_INVALID';
  END IF;

  SELECT processing.* INTO target
  FROM public.provider_event_processing processing
  JOIN public.provider_event_receipts receipt
    ON receipt.id=processing.receipt_id
   AND receipt.provider=processing.provider
   AND receipt.receiver_stripe_account_id=processing.receiver_stripe_account_id
  WHERE receipt.provider='stripe'
    AND (
      processing.status IN('received','failed_retryable')
      OR (processing.status='processing' AND processing.lease_expires_at<=p_now)
    )
  ORDER BY receipt.received_at,processing.receipt_id
  FOR UPDATE OF processing SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  IF target.status='processing' THEN
    SELECT attempt.* INTO current_attempt
    FROM public.provider_event_attempts attempt
    WHERE attempt.receipt_id=target.receipt_id
      AND attempt.provider=target.provider
      AND attempt.receiver_stripe_account_id=target.receiver_stripe_account_id
      AND attempt.attempt=target.lease_generation
      AND attempt.lease_generation=target.lease_generation
    FOR UPDATE;
    IF NOT FOUND OR current_attempt.outcome<>'processing'
      OR current_attempt.lease_token IS DISTINCT FROM target.lease_token
      OR current_attempt.worker_id IS DISTINCT FROM target.worker_id
      OR current_attempt.finished_at IS NOT NULL
    THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='COMMERCE_PROVIDER_EVENT_FENCE_INVALID';
    END IF;
    PERFORM set_config('app.commerce_transition','provider_event_attempts',true);
    UPDATE public.provider_event_attempts attempt
    SET outcome='lease_expired',safe_code='lease_expired',finished_at=p_now
    WHERE attempt.receipt_id=target.receipt_id
      AND attempt.attempt=target.lease_generation
      AND attempt.lease_generation=target.lease_generation;
    PERFORM set_config('app.commerce_transition','',true);
  END IF;

  next_token:=gen_random_uuid();
  next_generation:=target.lease_generation+1;
  next_expiry:=p_now+(p_lease_duration_ms*interval '1 millisecond');
  PERFORM set_config('app.commerce_transition','provider_event_processing',true);
  UPDATE public.provider_event_processing processing
  SET status='processing',worker_id=p_worker_id,lease_token=next_token,
      lease_generation=next_generation,lease_expires_at=next_expiry,
      outcome_code=NULL,completed_at=NULL,updated_at=p_now
  WHERE processing.receipt_id=target.receipt_id;
  PERFORM set_config('app.commerce_transition','',true);

  INSERT INTO public.provider_event_attempts(
    receipt_id,provider,receiver_stripe_account_id,attempt,lease_generation,
    lease_token,worker_id,outcome,safe_code,started_at,finished_at
  ) VALUES(
    target.receipt_id,target.provider,target.receiver_stripe_account_id,
    next_generation,next_generation,next_token,p_worker_id,'processing',
    'processing',p_now,NULL
  );

  RETURN QUERY
  SELECT receipt.id,receipt.provider_event_id,receipt.event_type,receipt.livemode,
    receipt.api_version,receipt.provider_created_at,receipt.data_object_type,
    receipt.data_object_id,receipt.receiver_stripe_account_id,
    receipt.event_account,receipt.event_context,receipt.raw_body_sha256,
    receipt.received_at,next_token,next_generation,next_expiry
  FROM public.provider_event_receipts receipt
  WHERE receipt.id=target.receipt_id;
END
$claim$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_claim_provider_event_v1(
  text,integer,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_claim_provider_event_v1(
  text,integer,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_finish_provider_event_v1(
  p_receipt_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_lease_generation integer,
  p_outcome text,
  p_safe_code text,
  p_now timestamptz
)
RETURNS TABLE(replayed boolean,status text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $finish$
DECLARE
  target public.provider_event_processing%ROWTYPE;
  current_attempt public.provider_event_attempts%ROWTYPE;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_receipt_id IS NULL OR p_worker_id IS NULL
    OR p_worker_id!~'^[A-Za-z0-9._:-]{1,255}$'
    OR p_lease_token IS NULL OR p_lease_generation IS NULL OR p_lease_generation<=0
    OR p_outcome IS NULL OR p_outcome NOT IN('processed','failed_retryable','failed_terminal')
    OR p_safe_code IS NULL OR p_safe_code!~'^[a-z][a-z0-9_]{0,63}$'
    OR p_now IS NULL OR NOT isfinite(p_now)
    OR p_now<>date_trunc('milliseconds',p_now)
    OR p_now<'2000-01-01 00:00:00+00'::timestamptz
    OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'system'
    OR nullif(current_setting('app.actor_id',true),'') IS DISTINCT FROM p_worker_id
    OR nullif(current_setting('app.account_id',true),'') IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMMERCE_PROVIDER_EVENT_ACK_INPUT_INVALID';
  END IF;

  SELECT processing.* INTO target
  FROM public.provider_event_processing processing
  WHERE processing.receipt_id=p_receipt_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='COMMERCE_PROVIDER_EVENT_FENCE_INVALID';
  END IF;

  SELECT attempt.* INTO current_attempt
  FROM public.provider_event_attempts attempt
  WHERE attempt.receipt_id=p_receipt_id
    AND attempt.attempt=p_lease_generation
    AND attempt.lease_generation=p_lease_generation
  FOR UPDATE;

  IF target.status IN('processed','failed_retryable','failed_terminal') THEN
    IF FOUND AND target.status=p_outcome
      AND target.outcome_code IS NOT DISTINCT FROM p_safe_code
      AND target.lease_generation=p_lease_generation
      AND current_attempt.provider=target.provider
      AND current_attempt.receiver_stripe_account_id=target.receiver_stripe_account_id
      AND current_attempt.lease_token=p_lease_token
      AND current_attempt.worker_id=p_worker_id
      AND current_attempt.outcome=p_outcome
      AND current_attempt.safe_code=p_safe_code
      AND current_attempt.finished_at IS NOT DISTINCT FROM target.completed_at
    THEN
      replayed:=true;status:=p_outcome;RETURN NEXT;RETURN;
    END IF;
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='COMMERCE_PROVIDER_EVENT_ACK_RECONCILIATION_REQUIRED';
  END IF;

  IF target.status<>'processing' OR NOT FOUND
    OR target.worker_id IS DISTINCT FROM p_worker_id
    OR target.lease_token IS DISTINCT FROM p_lease_token
    OR target.lease_generation IS DISTINCT FROM p_lease_generation
    OR target.lease_expires_at IS NULL OR target.lease_expires_at<=p_now
    OR current_attempt.provider IS DISTINCT FROM target.provider
    OR current_attempt.receiver_stripe_account_id IS DISTINCT FROM target.receiver_stripe_account_id
    OR current_attempt.lease_token IS DISTINCT FROM p_lease_token
    OR current_attempt.worker_id IS DISTINCT FROM p_worker_id
    OR current_attempt.outcome<>'processing' OR current_attempt.finished_at IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='COMMERCE_PROVIDER_EVENT_FENCE_INVALID';
  END IF;

  PERFORM set_config('app.commerce_transition','provider_event_attempts',true);
  UPDATE public.provider_event_attempts attempt
  SET outcome=p_outcome,safe_code=p_safe_code,finished_at=p_now
  WHERE attempt.receipt_id=p_receipt_id
    AND attempt.attempt=p_lease_generation
    AND attempt.lease_generation=p_lease_generation;
  PERFORM set_config('app.commerce_transition','',true);

  PERFORM set_config('app.commerce_transition','provider_event_processing',true);
  UPDATE public.provider_event_processing processing
  SET status=p_outcome,worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,
      outcome_code=p_safe_code,completed_at=p_now,updated_at=p_now
  WHERE processing.receipt_id=p_receipt_id;
  PERFORM set_config('app.commerce_transition','',true);

  replayed:=false;status:=p_outcome;RETURN NEXT;
END
$finish$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_finish_provider_event_v1(
  uuid,text,uuid,integer,text,text,timestamptz
) FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_finish_provider_event_v1(
  uuid,text,uuid,integer,text,text,timestamptz
) TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_cleanup_public_bos_intents_v1(
  p_job uuid,p_worker text,p_job_attempt integer,p_job_generation integer,
  p_job_token uuid,p_event uuid,p_receipt_attempt integer,
  p_receipt_generation integer,p_receipt_token uuid,p_batch_limit integer DEFAULT 250
) RETURNS TABLE(
  selected_count integer,ciphertexts_shredded integer,action_rows_deleted integer,
  intent_rows_deleted integer,more_eligible boolean
) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
BEGIN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='COMMERCE_CLEANUP_NOT_ACTIVE';
END $f$;
REVOKE ALL ON FUNCTION public.syntholo_cleanup_public_bos_intents_v1(
  uuid,text,integer,integer,uuid,uuid,integer,integer,uuid,integer
) FROM PUBLIC,syntholo_migrator,syntholo_member_api,syntholo_staff_api,
  syntholo_worker,syntholo_system_api;
--> statement-breakpoint
DO $rls$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'offers','offer_catalog_versions','offer_price_bindings',
    'checkout_authorizations','checkout_sessions','checkout_provider_actions',
    'public_business_os_setup_intents','stripe_customer_creation_actions',
    'business_os_setup_epochs','recurring_purchase_intents','stripe_customers',
    'purchases','public_business_os_setup_fulfillments',
    'purchase_payment_allocations','subscriptions',
    'subscription_schedules','invoices','invoice_line_allocations',
    'controlled_payment_authorizations','claim_tokens','pending_claim_sessions',
    'secure_link_deliveries','account_onboarding','account_onboarding_priorities',
    'provider_event_processing','provider_event_attempts','provider_event_effects'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true)',
      table_name||'_migrator',table_name
    );
  END LOOP;
END $rls$;
--> statement-breakpoint
REVOKE ALL ON public.offers,public.offer_catalog_versions,
  public.offer_price_bindings,public.checkout_authorizations,
  public.checkout_sessions,public.checkout_provider_actions,
  public.public_business_os_setup_intents,public.stripe_customer_creation_actions,
  public.business_os_setup_epochs,public.recurring_purchase_intents,
  public.stripe_customers,public.purchases,
  public.public_business_os_setup_fulfillments,public.purchase_payment_allocations,
  public.subscriptions,public.subscription_schedules,public.invoices,
  public.invoice_line_allocations,public.controlled_payment_authorizations,
  public.claim_tokens,public.pending_claim_sessions,public.secure_link_deliveries,
  public.account_onboarding,public.account_onboarding_priorities,
  public.provider_event_processing,public.provider_event_attempts,
  public.provider_event_effects
FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker,syntholo_system_api;
REVOKE ALL ON public.provider_event_receipts FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker,syntholo_system_api;
GRANT ALL ON public.offers,public.offer_catalog_versions,
  public.offer_price_bindings,public.checkout_authorizations,
  public.checkout_sessions,public.checkout_provider_actions,
  public.public_business_os_setup_intents,public.stripe_customer_creation_actions,
  public.business_os_setup_epochs,public.recurring_purchase_intents,
  public.stripe_customers,public.purchases,
  public.public_business_os_setup_fulfillments,public.purchase_payment_allocations,
  public.subscriptions,public.subscription_schedules,public.invoices,
  public.invoice_line_allocations,public.controlled_payment_authorizations,
  public.claim_tokens,public.pending_claim_sessions,public.secure_link_deliveries,
  public.account_onboarding,public.account_onboarding_priorities,
  public.provider_event_processing,public.provider_event_attempts,
  public.provider_event_effects
TO syntholo_migrator;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.syntholo_attest_runtime_capability(p_expected text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE login_state record; capability_state record;
DECLARE reachable_count integer; expected_count integer;
DECLARE membership_options_safe boolean;
BEGIN
  IF p_expected IS NULL OR p_expected NOT IN ('syntholo_member_api','syntholo_staff_api','syntholo_system_api','syntholo_worker') THEN RAISE EXCEPTION 'SYNTHOLO_RUNTIME_CAPABILITY_INVALID' USING ERRCODE='42501'; END IF;
  SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig INTO login_state FROM pg_roles WHERE rolname=session_user;
  SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig INTO capability_state FROM pg_roles WHERE rolname=p_expected;
  WITH RECURSIVE memberships AS (
    SELECT am.roleid,am.inherit_option,am.set_option,am.admin_option,ARRAY[login_state.oid,am.roleid]::oid[] path FROM pg_auth_members am WHERE am.member=login_state.oid
    UNION ALL
    SELECT am.roleid,am.inherit_option,am.set_option,am.admin_option,parent.path||am.roleid FROM pg_auth_members am JOIN memberships parent ON parent.roleid=am.member WHERE NOT am.roleid=ANY(parent.path)
  )
  SELECT count(DISTINCT roleid)::int,count(DISTINCT roleid) FILTER(WHERE roleid=capability_state.oid)::int,coalesce(bool_and(inherit_option AND NOT set_option AND NOT admin_option),false)
    INTO reachable_count,expected_count,membership_options_safe FROM memberships;
  IF login_state.oid IS NULL OR capability_state.oid IS NULL
    OR NOT login_state.rolcanlogin OR login_state.rolsuper OR login_state.rolcreatedb OR login_state.rolcreaterole OR login_state.rolreplication OR login_state.rolbypassrls OR login_state.rolconfig IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_db_role_setting WHERE setrole=login_state.oid)
    OR reachable_count<>1 OR expected_count<>1 OR NOT membership_options_safe
    OR capability_state.rolcanlogin OR capability_state.rolsuper OR capability_state.rolcreatedb OR capability_state.rolcreaterole OR capability_state.rolreplication OR capability_state.rolbypassrls OR capability_state.rolconfig IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_db_role_setting WHERE setrole=capability_state.oid)
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=capability_state.oid)
    OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=login_state.oid)
    OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=login_state.oid)
    OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=login_state.oid)
    OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=login_state.oid)
    OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=capability_state.oid)
    OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=capability_state.oid)
    OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=capability_state.oid)
    OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=capability_state.oid)
    OR has_database_privilege(session_user,current_database(),'CREATE') OR has_database_privilege(session_user,current_database(),'TEMP')
    OR has_database_privilege(p_expected,current_database(),'CREATE') OR has_database_privilege(p_expected,current_database(),'TEMP')
    OR has_schema_privilege(session_user,'public','CREATE') OR has_schema_privilege(p_expected,'public','CREATE')
    OR (p_expected='syntholo_system_api' AND EXISTS(
      SELECT 1 FROM pg_namespace n WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' AND ((n.nspname='public' AND (NOT has_schema_privilege(p_expected,n.oid,'USAGE') OR has_schema_privilege(p_expected,n.oid,'CREATE'))) OR (n.nspname<>'public' AND (has_schema_privilege(p_expected,n.oid,'USAGE') OR has_schema_privilege(p_expected,n.oid,'CREATE'))))))
    OR (p_expected='syntholo_system_api' AND EXISTS(
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) privilege(name)
      WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(p_expected,c.oid,privilege.name)
        AND NOT(n.nspname='public' AND c.relname IN ('audit_events','outbox_events') AND privilege.name='INSERT')))
    OR (p_expected='syntholo_system_api' AND EXISTS(
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) privilege(name)
      WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' AND c.relkind IN ('r','p','v','m','f') AND has_any_column_privilege(p_expected,c.oid,privilege.name)
        AND NOT(n.nspname='public' AND c.relname IN ('audit_events','outbox_events') AND privilege.name='INSERT')))
    OR (p_expected='syntholo_system_api' AND EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' AND (
        (has_function_privilege(p_expected,p.oid,'EXECUTE') AND NOT EXISTS(
          SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
          WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')
        AND (n.nspname<>'public' OR p.oid::regprocedure::text NOT IN (
          'syntholo_account_name_readiness_v1()',
          'syntholo_business_os_cancelled(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_business_os_payment_failed(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_business_os_payment_recovered(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_business_os_renewed(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_club_cancelled(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_club_payment_failed(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_club_payment_recovered(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_content_assets_readiness_v1()',
          'syntholo_content_readiness_v1()',
          'syntholo_establish_owner(uuid,uuid,text,text,text,timestamp with time zone)',
          'syntholo_expire_business_os(uuid,uuid,text,uuid,timestamp with time zone)',
          'syntholo_expire_club(uuid,uuid,text,uuid,timestamp with time zone)',
          'syntholo_expire_included_support(uuid,uuid,text,uuid,timestamp with time zone)',
          'syntholo_expire_invitation(uuid,uuid,text,uuid,timestamp with time zone)',
          'syntholo_fulfill_product(uuid,uuid,text,text,text,text,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)',
          'syntholo_certificates_readiness_v1()',
          'syntholo_implementation_readiness_v1()',
          'syntholo_implementation_seed_workspace_v1(uuid)',
          'syntholo_lock_scoped_system_account(uuid)',
          'syntholo_mux_apply_event_v1(text,text,text,text,timestamp with time zone,text,text,text,bigint,text,text,text,text,text,boolean,text,text)',
          'syntholo_open_dispute(uuid,uuid,text,text,uuid,timestamp with time zone)',
          'syntholo_record_business_os_setup_purchase(uuid,uuid,text,text,timestamp with time zone,timestamp with time zone)',
          'syntholo_record_access_decision(uuid,uuid,text,boolean,text,uuid[],integer,text,timestamp with time zone)',
          'syntholo_redeem_invitation(uuid,uuid,text,bytea,text,text,timestamp with time zone)',
          'syntholo_refund_product(uuid,uuid,text,uuid,text,timestamp with time zone)',
          'syntholo_resolve_dispute(uuid,uuid,text,uuid,text,timestamp with time zone)',
          'syntholo_record_public_business_os_setup_reconciliation(uuid,uuid,text,text,timestamp with time zone,text,timestamp with time zone)',
          'syntholo_commerce_catalog_readiness_v1()',
          'syntholo_commerce_begin_checkout_action_v1(uuid,text,timestamp with time zone)',
          'syntholo_commerce_claim_provider_event_v1(text,integer,timestamp with time zone)',
          'syntholo_commerce_initiate_claim_v1(text,text,timestamp with time zone)',
          'syntholo_commerce_redeem_claim_v1(text,uuid,text,text,text,bytea,timestamp with time zone)',
          'syntholo_commerce_finish_checkout_action_v1(uuid,text,integer,text,text,timestamp with time zone)',
          'syntholo_commerce_finish_provider_event_v1(uuid,text,uuid,integer,text,text,timestamp with time zone)',
          'syntholo_commerce_record_provider_event_v1(text,text,boolean,text,timestamp with time zone,text,text,boolean,text,text,text,text,boolean,text,text,timestamp with time zone)',
          'syntholo_commerce_record_provider_effect_v1(uuid,text,text,uuid,integer,uuid,text,uuid,uuid,timestamp with time zone)',
          'syntholo_commerce_record_paid_purchase_v1(uuid,text,uuid,integer,uuid,text,text,integer,integer,timestamp with time zone,uuid,timestamp with time zone)',
          'syntholo_commerce_record_public_bos_setup_paid_v1(uuid,text,uuid,integer,uuid,uuid,text,text,text,integer,integer,timestamp with time zone,uuid,text,text,bytea,bytea,bytea,text,text,timestamp with time zone)',
          'syntholo_commerce_record_public_self_paced_paid_v1(uuid,text,uuid,integer,uuid,text,text,integer,integer,timestamp with time zone,uuid,text,text,bytea,bytea,bytea,text,timestamp with time zone)',
          'syntholo_commerce_reserve_existing_bos_setup_v1(uuid,uuid,text,text,text,uuid,uuid,text,text,jsonb,timestamp with time zone,timestamp with time zone)',
          'syntholo_commerce_reserve_recurring_purchase_v1(uuid,uuid,text,text,text,text,text,uuid,uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_commerce_reserve_public_bos_setup_v1(text,text,text,text,uuid,uuid,bytea,bytea,text,text,bytea,bytea,bytea,text,bytea,bytea,bytea,text,text,text,text,text,jsonb,timestamp with time zone,timestamp with time zone)',
          'syntholo_commerce_reserve_public_self_paced_v1(text,text,text,text,uuid,uuid,bytea,bytea,bytea,bytea,text,bytea,bytea,bytea,text,text,text,text,text,jsonb,timestamp with time zone,timestamp with time zone)',
          'syntholo_commerce_publish_catalog_version_v1(uuid,text,text,timestamp with time zone)',
          'syntholo_commerce_record_checkout_session_v1(uuid,text,integer,text,text,text,text,bytea,bytea,bytea,text,timestamp with time zone,timestamp with time zone)',
          'syntholo_commerce_stage_checkout_action_v1(uuid,text,timestamp with time zone)',
          'syntholo_commerce_stage_catalog_version_v1(text,text,jsonb,text,text,timestamp with time zone)',
          'syntholo_commerce_stage_price_binding_v1(uuid,text,text,text,text,text,text,text,text,integer,text,integer,text,text,timestamp with time zone,timestamp with time zone)',
          'syntholo_runtime_readiness()'
        )))
        OR (n.nspname='public' AND p.proname~'^syntholo_' AND EXISTS(
          SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
          WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'))
      )))
  THEN RAISE EXCEPTION 'SYNTHOLO_RUNTIME_CAPABILITY_INVALID' USING ERRCODE='42501'; END IF;
END;
$fn$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.syntholo_implementation_readiness_v1() RETURNS TABLE(
  contract_version text,migration_created_at bigint,migration_hash text,table_ready boolean,structure_ready boolean,immutability_ready boolean,rls_ready boolean,policy_ready boolean,table_acl_ready boolean,function_ready boolean,function_acl_ready boolean,public_execute_denied boolean,receipt_binding_ready boolean,upstream_fk_ready boolean,seed_backfill_ready boolean
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
  WITH required_tables(name,column_signature) AS (VALUES
    ('implementation_artifacts',ARRAY['id:uuid:t','account_id:uuid:t','course_id:uuid:t','seeded_from_account_course_access_id:uuid:t','seeded_from_course_version_id:uuid:t','kind:text:t','title:text:t','current_version:integer:t','current_version_id:uuid:f','created_at:timestamp(3) with time zone:t','updated_at:timestamp(3) with time zone:t']::text[]),
    ('implementation_artifact_versions',ARRAY['id:uuid:t','account_id:uuid:t','course_id:uuid:t','artifact_id:uuid:t','kind:text:t','version:integer:t','state:text:t','content:jsonb:t','canonical_json:text:t','content_hash:text:t','creator_membership_id:uuid:t','source_command_receipt_id:uuid:t','created_at:timestamp(3) with time zone:t']::text[]),
    ('implementation_workflows',ARRAY['id:uuid:t','account_id:uuid:t','course_id:uuid:t','artifact_id:uuid:t','artifact_version_id:uuid:t','artifact_kind:text:t','ordinal:integer:t','name:text:t','engine:text:t','problem:text:t','trigger:text:t','owner:text:t','approved_tools:jsonb:t','steps:jsonb:t','human_review_point:text:t','safety_notes:text:t','baseline:text:t','target:text:t','lifecycle_state:text:t','test_status:text:t','launch_date:date:f','created_at:timestamp(3) with time zone:t']::text[]),
    ('implementation_completions',ARRAY['id:uuid:t','account_id:uuid:t','course_id:uuid:t','course_completion_id:uuid:t','membership_id:uuid:t','enrollment_id:uuid:t','course_version_id:uuid:t','completed_at:timestamp(3) with time zone:t']::text[]),
    ('implementation_completion_artifact_snapshots',ARRAY['completion_id:uuid:t','account_id:uuid:t','course_id:uuid:t','artifact_id:uuid:t','artifact_version_id:uuid:t','kind:text:t']::text[]),
    ('implementation_completion_workflow_snapshots',ARRAY['completion_id:uuid:t','account_id:uuid:t','course_id:uuid:t','artifact_id:uuid:t','artifact_version_id:uuid:t','workflow_id:uuid:t']::text[])
  ), relations AS (SELECT r.name,r.column_signature,c.oid,c.relkind,c.relpersistence,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.relacl FROM required_tables r LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||r.name)),
  actual_columns_raw AS (SELECT c.relname table_name,a.attname column_name,format_type(a.atttypid,a.atttypmod) type_name,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,coalesce(coll.collname,'') collation_name,coalesce(pg_get_expr(d.adbin,d.adrelid),'') default_expression,a.attnum FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_collation coll ON coll.oid=a.attcollation WHERE n.nspname='public' AND c.relname IN (SELECT name FROM required_tables) AND a.attnum>0 AND NOT a.attisdropped),
  actual_columns AS (SELECT table_name,array_agg(column_name||':'||type_name||':'||CASE WHEN attnotnull THEN 't' ELSE 'f' END ORDER BY attnum) column_signature FROM actual_columns_raw GROUP BY table_name),
  expected_defaults(table_name,column_name,default_expression) AS (VALUES
    ('implementation_artifacts','id','gen_random_uuid()'),('implementation_artifacts','current_version','0'),('implementation_artifacts','created_at',E'date_trunc(\'milliseconds\'::text, clock_timestamp())'),('implementation_artifacts','updated_at',E'date_trunc(\'milliseconds\'::text, clock_timestamp())'),
    ('implementation_artifact_versions','id','gen_random_uuid()'),('implementation_artifact_versions','created_at',E'date_trunc(\'milliseconds\'::text, clock_timestamp())'),
    ('implementation_workflows','id','gen_random_uuid()'),('implementation_workflows','artifact_kind',E'\'workflow_portfolio\'::text'),('implementation_workflows','created_at',E'date_trunc(\'milliseconds\'::text, clock_timestamp())'),
    ('implementation_completions','id','gen_random_uuid()'),('implementation_completions','completed_at',E'date_trunc(\'milliseconds\'::text, clock_timestamp())')
  ), actual_defaults AS (SELECT table_name,column_name,default_expression FROM actual_columns_raw WHERE default_expression<>''),
  expected_keys(table_name,constraint_name,constraint_type,column_names) AS (VALUES
    ('implementation_artifacts','implementation_artifacts_pkey','p',ARRAY['id']::text[]),('implementation_artifacts','implementation_artifacts_account_course_kind_unique','u',ARRAY['account_id','course_id','kind']::text[]),('implementation_artifacts','implementation_artifacts_exact_unique','u',ARRAY['id','account_id','course_id']::text[]),('implementation_artifacts','implementation_artifacts_kind_exact_unique','u',ARRAY['id','account_id','course_id','kind']::text[]),
    ('implementation_artifact_versions','implementation_artifact_versions_pkey','p',ARRAY['id']::text[]),('implementation_artifact_versions','implementation_versions_artifact_version_unique','u',ARRAY['artifact_id','version']::text[]),('implementation_artifact_versions','implementation_versions_source_command_receipt_id_unique','u',ARRAY['source_command_receipt_id']::text[]),('implementation_artifact_versions','implementation_versions_exact_unique','u',ARRAY['account_id','artifact_id','id']::text[]),('implementation_artifact_versions','implementation_versions_course_exact_unique','u',ARRAY['id','account_id','course_id','artifact_id']::text[]),('implementation_artifact_versions','implementation_versions_kind_exact_unique','u',ARRAY['id','account_id','course_id','artifact_id','kind']::text[]),('implementation_artifact_versions','implementation_versions_head_unique','u',ARRAY['id','account_id','course_id','artifact_id','kind','version']::text[]),
    ('implementation_workflows','implementation_workflows_pkey','p',ARRAY['id']::text[]),('implementation_workflows','implementation_workflows_version_ordinal_unique','u',ARRAY['artifact_version_id','ordinal']::text[]),('implementation_workflows','implementation_workflows_exact_unique','u',ARRAY['account_id','artifact_id','id']::text[]),('implementation_workflows','implementation_workflows_version_exact_unique','u',ARRAY['account_id','course_id','artifact_id','artifact_version_id','id']::text[]),
    ('implementation_completions','implementation_completions_pkey','p',ARRAY['id']::text[]),('implementation_completions','implementation_completions_account_course_unique','u',ARRAY['account_id','course_id']::text[]),('implementation_completions','implementation_completions_exact_unique','u',ARRAY['id','account_id','course_id']::text[]),
    ('implementation_completion_artifact_snapshots','implementation_completion_artifact_snapshots_pkey','p',ARRAY['completion_id','artifact_id']::text[]),('implementation_completion_artifact_snapshots','implementation_completion_artifacts_kind_unique','u',ARRAY['completion_id','kind']::text[]),('implementation_completion_artifact_snapshots','implementation_completion_artifacts_version_unique','u',ARRAY['completion_id','artifact_id','artifact_version_id']::text[]),
    ('implementation_completion_workflow_snapshots','implementation_completion_workflow_snapshots_pkey','p',ARRAY['completion_id','workflow_id']::text[])
  ), actual_keys AS (SELECT rel.relname table_name,c.conname constraint_name,c.contype::text constraint_type,ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ordinal) column_names,c.convalidated,c.condeferrable,c.condeferred,pg_get_constraintdef(c.oid,true) definition FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid JOIN pg_namespace n ON n.oid=rel.relnamespace WHERE n.nspname='public' AND rel.relname IN (SELECT name FROM required_tables) AND c.contype IN ('p','u')),
  expected_fks(table_name,constraint_name,column_names,foreign_table,foreign_column_names) AS (VALUES
    ('implementation_artifacts','implementation_artifacts_account_id_fkey',ARRAY['account_id']::text[],'accounts',ARRAY['id']::text[]),('implementation_artifacts','implementation_artifacts_course_id_fkey',ARRAY['course_id']::text[],'courses',ARRAY['id']::text[]),('implementation_artifacts','implementation_artifacts_seed_access_fk',ARRAY['seeded_from_account_course_access_id','account_id','course_id','seeded_from_course_version_id']::text[],'account_course_accesses',ARRAY['id','account_id','course_id','course_version_id']::text[]),('implementation_artifacts','implementation_artifacts_current_version_fk',ARRAY['current_version_id','account_id','course_id','id','kind','current_version']::text[],'implementation_artifact_versions',ARRAY['id','account_id','course_id','artifact_id','kind','version']::text[]),
    ('implementation_artifact_versions','implementation_artifact_versions_source_command_receipt_id_fkey',ARRAY['source_command_receipt_id']::text[],'api_command_receipts',ARRAY['id']::text[]),('implementation_artifact_versions','implementation_versions_artifact_exact_fk',ARRAY['artifact_id','account_id','course_id','kind']::text[],'implementation_artifacts',ARRAY['id','account_id','course_id','kind']::text[]),('implementation_artifact_versions','implementation_versions_creator_account_fk',ARRAY['creator_membership_id','account_id']::text[],'memberships',ARRAY['id','account_id']::text[]),
    ('implementation_workflows','implementation_workflows_version_exact_fk',ARRAY['artifact_version_id','account_id','course_id','artifact_id','artifact_kind']::text[],'implementation_artifact_versions',ARRAY['id','account_id','course_id','artifact_id','kind']::text[]),
    ('implementation_completions','implementation_completions_course_completion_fk',ARRAY['course_completion_id','account_id','membership_id','enrollment_id','course_id','course_version_id']::text[],'course_completions',ARRAY['id','account_id','membership_id','enrollment_id','course_id','course_version_id']::text[]),
    ('implementation_completion_artifact_snapshots','implementation_completion_artifacts_completion_fk',ARRAY['completion_id','account_id','course_id']::text[],'implementation_completions',ARRAY['id','account_id','course_id']::text[]),('implementation_completion_artifact_snapshots','implementation_completion_artifacts_version_fk',ARRAY['artifact_version_id','account_id','course_id','artifact_id','kind']::text[],'implementation_artifact_versions',ARRAY['id','account_id','course_id','artifact_id','kind']::text[]),
    ('implementation_completion_workflow_snapshots','implementation_completion_workflows_completion_fk',ARRAY['completion_id','account_id','course_id']::text[],'implementation_completions',ARRAY['id','account_id','course_id']::text[]),('implementation_completion_workflow_snapshots','implementation_completion_workflows_artifact_snapshot_fk',ARRAY['completion_id','artifact_id','artifact_version_id']::text[],'implementation_completion_artifact_snapshots',ARRAY['completion_id','artifact_id','artifact_version_id']::text[]),('implementation_completion_workflow_snapshots','implementation_completion_workflows_workflow_fk',ARRAY['account_id','course_id','artifact_id','artifact_version_id','workflow_id']::text[],'implementation_workflows',ARRAY['account_id','course_id','artifact_id','artifact_version_id','id']::text[])
  ), actual_fks AS (SELECT source.relname table_name,c.conname constraint_name,ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ordinal) column_names,target.relname foreign_table,ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.ordinal) foreign_column_names,c.confupdtype,c.confdeltype,c.confmatchtype,c.convalidated,c.condeferrable,c.condeferred,pg_get_constraintdef(c.oid,true) definition FROM pg_constraint c JOIN pg_class source ON source.oid=c.conrelid JOIN pg_class target ON target.oid=c.confrelid JOIN pg_namespace source_namespace ON source_namespace.oid=source.relnamespace JOIN pg_namespace target_namespace ON target_namespace.oid=target.relnamespace WHERE source_namespace.nspname='public' AND target_namespace.nspname='public' AND source.relname IN (SELECT name FROM required_tables) AND c.contype='f'),
  expected_checks(table_name,constraint_name,definition) AS (VALUES
    ('implementation_artifacts','implementation_artifacts_kind_check',E'(kind=any(array[\'readiness_map\',\'ai_policy\',\'workflow_portfolio\',\'enablement_checklist\',\'roadmap\']))'),
    ('implementation_artifacts','implementation_artifacts_title_check',E'((octet_length(btrim(title))>=1)and(octet_length(btrim(title))<=255))'),
    ('implementation_artifacts','implementation_artifacts_head_check',E'(((current_version=0)and(current_version_idisnull))or((current_version>0)and(current_version_idisnotnull)))'),
    ('implementation_artifact_versions','implementation_versions_version_check',E'(version>0)'),
    ('implementation_artifact_versions','implementation_versions_state_check',E'(state=any(array[\'draft\',\'final\']))'),
    ('implementation_artifact_versions','implementation_versions_canonical_size_check',E'((octet_length(canonical_json)>=2)and(octet_length(canonical_json)<=1048576))'),
    ('implementation_artifact_versions','implementation_versions_hash_check',E'(content_hash~\'^[0-9a-f]{64}$\')'),
    ('implementation_artifact_versions','implementation_versions_content_check',E'(((content->>\'kind\')=kind)andpublic.syntholo_implementation_content_valid_v1(kind,state,content))'),
    ('implementation_artifact_versions','implementation_versions_canonical_check',E'(canonical_json=public.syntholo_canonical_jsonb_text_v1(content))'),
    ('implementation_artifact_versions','implementation_versions_hash_parity_check',E'(content_hash=encode(sha256(convert_to(canonical_json,\'utf8\'::name)),\'hex\'))'),
    ('implementation_workflows','implementation_workflows_ordinal_check',E'((ordinal>=1)and(ordinal<=3))'),
    ('implementation_workflows','implementation_workflows_engine_check',E'(engine=any(array[\'growth\',\'client\',\'management\']))'),
    ('implementation_workflows','implementation_workflows_lifecycle_check',E'(lifecycle_state=any(array[\'draft\',\'testing\',\'live\',\'paused\']))'),
    ('implementation_workflows','implementation_workflows_test_check',E'(test_status=any(array[\'not_started\',\'in_progress\',\'passed\',\'failed\']))'),
    ('implementation_workflows','implementation_workflows_artifact_kind_check',E'(artifact_kind=\'workflow_portfolio\')'),
    ('implementation_workflows','implementation_workflows_text_check',E'(public.syntholo_implementation_text_valid_v1(name,255)andpublic.syntholo_implementation_text_valid_v1(problem,2000)andpublic.syntholo_implementation_text_valid_v1(trigger,2000)andpublic.syntholo_implementation_text_valid_v1(owner,255)andpublic.syntholo_implementation_text_valid_v1(human_review_point,2000)andpublic.syntholo_implementation_text_valid_v1(safety_notes,2000)andpublic.syntholo_implementation_text_valid_v1(baseline,255)andpublic.syntholo_implementation_text_valid_v1(target,255))'),
    ('implementation_workflows','implementation_workflows_arrays_check',E'(public.syntholo_implementation_text_array_valid_v1(approved_tools,25,255)andpublic.syntholo_implementation_text_array_valid_v1(steps,25,2000))'),
    ('implementation_workflows','implementation_workflows_live_check',E'((lifecycle_state<>\'live\')or((test_status=\'passed\')and(launch_dateisnotnull)andpublic.syntholo_implementation_text_complete_v1(name,255)andpublic.syntholo_implementation_text_complete_v1(problem,2000)andpublic.syntholo_implementation_text_complete_v1(trigger,2000)andpublic.syntholo_implementation_text_complete_v1(owner,255)andpublic.syntholo_implementation_text_complete_v1(human_review_point,2000)andpublic.syntholo_implementation_text_complete_v1(safety_notes,2000)andpublic.syntholo_implementation_text_complete_v1(baseline,255)andpublic.syntholo_implementation_text_complete_v1(target,255)andpublic.syntholo_implementation_text_array_complete_v1(approved_tools)andpublic.syntholo_implementation_text_array_complete_v1(steps)))'),
    ('implementation_completion_artifact_snapshots','implementation_completion_artifacts_kind_check',E'(kind=any(array[\'readiness_map\',\'ai_policy\',\'workflow_portfolio\',\'enablement_checklist\',\'roadmap\']))')
  ), actual_checks AS (SELECT rel.relname table_name,c.conname constraint_name,regexp_replace(replace(lower(pg_get_expr(c.conbin,c.conrelid)),'::text',''),'[[:space:]]','','g') definition,c.convalidated FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid JOIN pg_namespace n ON n.oid=rel.relnamespace WHERE n.nspname='public' AND rel.relname IN (SELECT name FROM required_tables) AND c.contype='c'),
  expected_indexes(table_name,index_name,column_names,index_options,opclasses) AS (VALUES ('implementation_artifact_versions','implementation_versions_history_idx',ARRAY['artifact_id','created_at','id']::text[],ARRAY[0,3,3]::smallint[],ARRAY['uuid_ops','timestamptz_ops','uuid_ops']::text[]),('course_completions','course_completions_implementation_lookup_idx',ARRAY['account_id','course_id','completed_at','id']::text[],ARRAY[0,0,0,0]::smallint[],ARRAY['uuid_ops','uuid_ops','timestamptz_ops','uuid_ops']::text[])),
  actual_indexes AS (SELECT table_rel.relname table_name,index_rel.relname index_name,ARRAY(SELECT a.attname FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ordinal) column_names,ARRAY(SELECT option FROM unnest(i.indoption::smallint[]) WITH ORDINALITY option_value(option,ordinal) ORDER BY ordinal) index_options,ARRAY(SELECT opc.opcname FROM unnest(i.indclass::oid[]) WITH ORDINALITY c(opcoid,ordinal) JOIN pg_opclass opc ON opc.oid=c.opcoid ORDER BY c.ordinal) opclasses,am.amname access_method,i.indnkeyatts,i.indnatts,i.indpred,i.indexprs,i.indisunique,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) definition FROM pg_index i JOIN pg_class table_rel ON table_rel.oid=i.indrelid JOIN pg_namespace n ON n.oid=table_rel.relnamespace JOIN pg_class index_rel ON index_rel.oid=i.indexrelid JOIN pg_am am ON am.oid=index_rel.relam WHERE n.nspname='public' AND NOT EXISTS(SELECT 1 FROM pg_constraint constraint_index WHERE constraint_index.conindid=i.indexrelid) AND (table_rel.relname IN (SELECT name FROM required_tables) OR index_rel.relname='course_completions_implementation_lookup_idx')),
  expected_functions(signature,security_definer,volatility,body_hash) AS (VALUES
    ('public.syntholo_implementation_text_valid_v1(text,integer)',false,'i','14c8ddb9b6c7007773a74f62b0d9016e3aad3e305870c7068302bfbc87531f04'),
    ('public.syntholo_implementation_text_complete_v1(text,integer)',false,'i','e74bbaaf61f67dafbab368b1bbc2d0e4b00eb2c59c46037879ce8cecbd36c8f4'),
    ('public.syntholo_implementation_text_array_valid_v1(jsonb,integer,integer)',false,'i','81ab298aaaf8d866a544e56c806cad89343e497dbe44f8868288bc9ae8a1fa30'),
    ('public.syntholo_implementation_text_array_complete_v1(jsonb)',false,'i','49fc2648c83be7dca35a390004f78a70b16f737d04130c78db22f822aa059f93'),
    ('public.syntholo_implementation_workflow_valid_v1(jsonb)',false,'i','9e326d21117b843001da820538b8f469f1889581ea8dcfe724d56c2f065ee677'),
    ('public.syntholo_implementation_content_valid_v1(text,text,jsonb)',false,'i','b419b7e60eb095ab3330ab04b1108a7bc335eefbf0217b2b1fa8290403b4c245'),
    ('public.syntholo_implementation_workflow_content_match_v1()',false,'v','70b6c6e1a7671f73ea825111d8703fe659e2819dab45dbe6cd16416260e7174d'),
    ('public.syntholo_implementation_immutable_row_v1()',false,'v','ab4bd27fcfb817d98ed81c2fb55cf6af9f2a2825d90e80834a512067b081d27c'),
    ('public.syntholo_implementation_root_head_guard_v1()',false,'v','a69fc07ec351444095cdc9c9f0362cac8e79c16cca131770ba98fc15c52ff932'),
    ('public.syntholo_implementation_seed_workspace_v1(uuid)',true,'v','399dce9e287122808efb11ccf745a331cea21e1f439c4087890e3b7182151229'),
    ('public.syntholo_implementation_list_v1()',true,'s','4b9ccfd2746073fdc3f752242db75b408a4768d7401c32de82096f167b223161'),
    ('public.syntholo_implementation_get_v1(uuid)',true,'s','f4542af69d2125ebe1f30f0ca2042c4afb72dbb68c7b6bf83d7015d78f175f50'),
    ('public.syntholo_implementation_versions_v1(uuid,timestamp with time zone,uuid,integer)',true,'s','031e433e75149129f94ff1f813eecdd338613b173dab359a0385bb1da5cfe160'),
    ('public.syntholo_implementation_recompute_completion_v1(uuid,uuid,text,text,uuid)',true,'v','0480038533cd5ba09d807834b0cfd469540cf539114d01684b4d177dc3d5452c'),
    ('public.syntholo_implementation_save_version_v1(uuid,integer,text,jsonb,text,text)',true,'v','dfa034a1e6d6529bfd22dbd3382f86fff07c816aee27c7cf54c73357466e4867'),
    ('public.syntholo_implementation_record_course_completion_v1(uuid,text)',true,'v','abd145b5fe71c825c78753d526ec06587c1d993bf33d03c2ca5232276d797078'),
    ('public.syntholo_implementation_readiness_v1()',true,'s',NULL)
  ), functions AS (SELECT e.*,p.oid,p.proowner,p.prokind,p.prosecdef,p.provolatile::text actual_volatility,p.proconfig,p.proacl,CASE WHEN p.oid IS NULL THEN '' ELSE pg_get_functiondef(p.oid) END definition,CASE WHEN p.oid IS NULL THEN '' ELSE encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') END actual_body_hash FROM expected_functions e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)),
  actual_function_inventory AS (SELECT p.oid::regprocedure::text signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'syntholo_implementation_%'),
  expected_upstream_functions(signature,body_hash) AS (VALUES ('public.syntholo_canonical_jsonb_text_v1(jsonb)','4bb725f0a9a4a3d80d1df0a89db2611fec36ccdb3459f76df4c52f80f0c6069f')),
  upstream_functions AS (SELECT e.*,p.oid,p.proowner,p.prokind,p.prosecdef,p.provolatile,p.proconfig,CASE WHEN p.oid IS NULL THEN '' ELSE encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') END actual_body_hash FROM expected_upstream_functions e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)),
  expected_runtime_attestation(signature,body_hash) AS (VALUES ('public.syntholo_attest_runtime_capability(text)','20e2df467ba7b3d2c715a0a22ece794298aecadb22aa57b0a2853c2df2835d49')),
  runtime_attestation AS (SELECT e.*,p.oid,p.proowner,p.prokind,p.prosecdef,p.provolatile,p.proconfig,CASE WHEN p.oid IS NULL THEN '' ELSE encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') END actual_body_hash FROM expected_runtime_attestation e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)),
  upstream_owner AS (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.syntholo_content_readiness_v1()')),
  owner AS (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.syntholo_content_readiness_v1()')),
  expected_triggers(table_name,trigger_name,trigger_type,function_signature,when_clause) AS (VALUES
    ('implementation_artifacts','implementation_artifacts_identity_immutable',19,'public.syntholo_implementation_immutable_row_v1()','old.account_idisdistinctfromnew.account_idorold.course_idisdistinctfromnew.course_idorold.seeded_from_account_course_access_idisdistinctfromnew.seeded_from_account_course_access_idorold.seeded_from_course_version_idisdistinctfromnew.seeded_from_course_version_idorold.kindisdistinctfromnew.kindorold.titleisdistinctfromnew.titleorold.created_atisdistinctfromnew.created_at'),
    ('implementation_artifacts','implementation_artifacts_head_guard',19,'public.syntholo_implementation_root_head_guard_v1()',''),('implementation_artifacts','implementation_artifacts_delete_immutable',11,'public.syntholo_implementation_immutable_row_v1()',''),('implementation_artifact_versions','implementation_artifact_versions_immutable',27,'public.syntholo_implementation_immutable_row_v1()',''),('implementation_workflows','implementation_workflows_content_match',7,'public.syntholo_implementation_workflow_content_match_v1()',''),('implementation_workflows','implementation_workflows_immutable',27,'public.syntholo_implementation_immutable_row_v1()',''),('implementation_completions','implementation_completions_immutable',27,'public.syntholo_implementation_immutable_row_v1()',''),('implementation_completion_artifact_snapshots','implementation_completion_artifact_snapshots_immutable',27,'public.syntholo_implementation_immutable_row_v1()',''),('implementation_completion_workflow_snapshots','implementation_completion_workflow_snapshots_immutable',27,'public.syntholo_implementation_immutable_row_v1()','')
  ),
  actual_triggers AS (SELECT c.relname table_name,t.tgname trigger_name,t.tgtype::integer trigger_type,p.oid::regprocedure::text function_signature,regexp_replace(replace(lower(coalesce(substring(pg_get_triggerdef(t.oid,true) from E' WHEN \\((.*)\\) EXECUTE FUNCTION '),'')),'::text',''),'[[:space:]()]','','g') when_clause,t.tgenabled,pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND n.nspname='public' AND c.relname IN (SELECT name FROM required_tables)),
  expected_policies(table_name,policy_name,command_name,role_names,qual,with_check,permissive) AS (SELECT name,name||'_migrator','*',ARRAY['syntholo_migrator']::text[],'true','true',true FROM required_tables),
  actual_policies AS (SELECT c.relname table_name,p.polname policy_name,p.polcmd::text command_name,ARRAY(SELECT r.rolname FROM unnest(p.polroles) role_oid(oid) JOIN pg_roles r ON r.oid=role_oid.oid ORDER BY r.rolname) role_names,lower(coalesce(pg_get_expr(p.polqual,p.polrelid),'')) qual,lower(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')) with_check,p.polpermissive permissive FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN (SELECT name FROM required_tables)),
  expected_table_acl(role_name,table_name,privilege_type,is_grantable) AS (SELECT role.rolname,r.name,privilege,false FROM relations r JOIN pg_roles role ON role.rolname='syntholo_migrator' CROSS JOIN LATERAL unnest(CASE WHEN current_setting('server_version_num')::integer>=170000 THEN ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']::text[] ELSE ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']::text[] END) privilege WHERE role.oid<>r.relowner),
  actual_table_acl AS (SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END role_name,r.name table_name,a.privilege_type,a.is_grantable FROM relations r CROSS JOIN LATERAL aclexplode(coalesce(r.relacl,'{}'::aclitem[])) a WHERE a.grantee<>r.relowner),
  expected_function_acl(signature,role_name,privilege_type,is_grantable) AS (VALUES ('public.syntholo_implementation_seed_workspace_v1(uuid)','syntholo_system_api','EXECUTE',false),('public.syntholo_implementation_list_v1()','syntholo_member_api','EXECUTE',false),('public.syntholo_implementation_get_v1(uuid)','syntholo_member_api','EXECUTE',false),('public.syntholo_implementation_versions_v1(uuid,timestamp with time zone,uuid,integer)','syntholo_member_api','EXECUTE',false),('public.syntholo_implementation_save_version_v1(uuid,integer,text,jsonb,text,text)','syntholo_member_api','EXECUTE',false),('public.syntholo_implementation_record_course_completion_v1(uuid,text)','syntholo_worker','EXECUTE',false),('public.syntholo_implementation_readiness_v1()','syntholo_migrator','EXECUTE',false),('public.syntholo_implementation_readiness_v1()','syntholo_member_api','EXECUTE',false),('public.syntholo_implementation_readiness_v1()','syntholo_staff_api','EXECUTE',false),('public.syntholo_implementation_readiness_v1()','syntholo_worker','EXECUTE',false),('public.syntholo_implementation_readiness_v1()','syntholo_system_api','EXECUTE',false)),
  actual_function_acl AS (SELECT f.signature,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END role_name,a.privilege_type,a.is_grantable FROM functions f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl,'{}'::aclitem[])) a WHERE a.grantee<>f.proowner)
  SELECT '0012_implementation.v1',1786856400000::bigint,j.hash,
    (SELECT count(*)=6 AND bool_and(oid IS NOT NULL AND relkind='r' AND relpersistence='p' AND relowner=(SELECT proowner FROM owner)) FROM relations),
    NOT EXISTS((SELECT name,column_signature FROM required_tables EXCEPT SELECT table_name,column_signature FROM actual_columns) UNION ALL (SELECT table_name,column_signature FROM actual_columns EXCEPT SELECT name,column_signature FROM required_tables))
      AND NOT EXISTS((SELECT table_name,column_name,default_expression FROM expected_defaults EXCEPT SELECT table_name,column_name,default_expression FROM actual_defaults) UNION ALL (SELECT table_name,column_name,default_expression FROM actual_defaults EXCEPT SELECT table_name,column_name,default_expression FROM expected_defaults))
      AND NOT EXISTS(SELECT 1 FROM actual_columns_raw WHERE attidentity<>'' OR attgenerated<>'' OR (type_name='text' AND collation_name<>'default') OR (type_name<>'text' AND attcollation<>0))
      AND NOT EXISTS((SELECT table_name,constraint_name,constraint_type,column_names FROM expected_keys EXCEPT SELECT table_name,constraint_name,constraint_type,column_names FROM actual_keys) UNION ALL (SELECT table_name,constraint_name,constraint_type,column_names FROM actual_keys EXCEPT SELECT table_name,constraint_name,constraint_type,column_names FROM expected_keys)) AND NOT EXISTS(SELECT 1 FROM actual_keys WHERE NOT convalidated OR condeferrable OR condeferred OR definition='')
      AND NOT EXISTS((SELECT table_name,constraint_name,definition FROM expected_checks EXCEPT SELECT table_name,constraint_name,definition FROM actual_checks) UNION ALL (SELECT table_name,constraint_name,definition FROM actual_checks EXCEPT SELECT table_name,constraint_name,definition FROM expected_checks)) AND NOT EXISTS(SELECT 1 FROM expected_checks e LEFT JOIN actual_checks a USING(table_name,constraint_name) WHERE a.constraint_name IS NULL OR NOT a.convalidated OR e.definition<>a.definition)
      AND NOT EXISTS((SELECT table_name,index_name,column_names,index_options,opclasses FROM expected_indexes EXCEPT SELECT table_name,index_name,column_names,index_options,opclasses FROM actual_indexes) UNION ALL (SELECT table_name,index_name,column_names,index_options,opclasses FROM actual_indexes EXCEPT SELECT table_name,index_name,column_names,index_options,opclasses FROM expected_indexes)) AND NOT EXISTS(SELECT 1 FROM actual_indexes WHERE access_method<>'btree' OR indnkeyatts<>indnatts OR indpred IS NOT NULL OR indexprs IS NOT NULL OR indisunique OR NOT indisvalid OR NOT indisready OR definition=''),
    NOT EXISTS((SELECT table_name,trigger_name,trigger_type,function_signature,when_clause FROM expected_triggers EXCEPT SELECT table_name,trigger_name,trigger_type,function_signature,when_clause FROM actual_triggers) UNION ALL (SELECT table_name,trigger_name,trigger_type,function_signature,when_clause FROM actual_triggers EXCEPT SELECT table_name,trigger_name,trigger_type,function_signature,when_clause FROM expected_triggers)) AND NOT EXISTS(SELECT 1 FROM actual_triggers WHERE tgenabled<>'O' OR definition=''),
    (SELECT count(*)=6 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM relations),
    NOT EXISTS((SELECT table_name,policy_name,command_name,role_names,qual,with_check,permissive FROM expected_policies EXCEPT SELECT table_name,policy_name,command_name,role_names,qual,with_check,permissive FROM actual_policies) UNION ALL (SELECT table_name,policy_name,command_name,role_names,qual,with_check,permissive FROM actual_policies EXCEPT SELECT table_name,policy_name,command_name,role_names,qual,with_check,permissive FROM expected_policies)),
    NOT EXISTS((SELECT role_name,table_name,privilege_type,is_grantable FROM expected_table_acl EXCEPT SELECT role_name,table_name,privilege_type,is_grantable FROM actual_table_acl) UNION ALL (SELECT role_name,table_name,privilege_type,is_grantable FROM actual_table_acl EXCEPT SELECT role_name,table_name,privilege_type,is_grantable FROM expected_table_acl)),
    (SELECT count(*)=17 AND bool_and(oid IS NOT NULL AND prokind='f' AND proowner=(SELECT proowner FROM owner) AND prosecdef=security_definer AND actual_volatility=volatility AND proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[] AND (body_hash IS NULL OR actual_body_hash=body_hash)) FROM functions) AND NOT EXISTS((SELECT signature FROM expected_functions EXCEPT SELECT signature FROM actual_function_inventory) UNION ALL (SELECT signature FROM actual_function_inventory EXCEPT SELECT signature FROM expected_functions)) AND (SELECT count(*)=1 AND bool_and(oid IS NOT NULL AND prokind='f' AND proowner=(SELECT proowner FROM upstream_owner) AND NOT prosecdef AND provolatile='i' AND proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[] AND actual_body_hash=body_hash) FROM upstream_functions) AND (SELECT count(*)=1 AND bool_and(oid IS NOT NULL AND prokind='f' AND proowner=(SELECT proowner FROM upstream_owner) AND prosecdef AND provolatile='v' AND proconfig=ARRAY['search_path=pg_catalog, public']::text[] AND actual_body_hash=body_hash) FROM runtime_attestation),
    NOT EXISTS((SELECT signature,role_name,privilege_type,is_grantable FROM expected_function_acl EXCEPT SELECT signature,role_name,privilege_type,is_grantable FROM actual_function_acl) UNION ALL (SELECT signature,role_name,privilege_type,is_grantable FROM actual_function_acl EXCEPT SELECT signature,role_name,privilege_type,is_grantable FROM expected_function_acl)),
    NOT EXISTS(SELECT 1 FROM actual_function_acl WHERE role_name='PUBLIC' AND privilege_type='EXECUTE'),
    EXISTS(SELECT 1 FROM pg_constraint WHERE conname='implementation_versions_source_command_receipt_id_unique') AND position('/v1/member/artifacts/:artifactId/versions' in pg_get_functiondef(to_regprocedure('public.syntholo_implementation_save_version_v1(uuid,integer,text,jsonb,text,text)'))) > 0,
    NOT EXISTS((SELECT table_name,constraint_name,column_names,foreign_table,foreign_column_names FROM expected_fks EXCEPT SELECT table_name,constraint_name,column_names,foreign_table,foreign_column_names FROM actual_fks) UNION ALL (SELECT table_name,constraint_name,column_names,foreign_table,foreign_column_names FROM actual_fks EXCEPT SELECT table_name,constraint_name,column_names,foreign_table,foreign_column_names FROM expected_fks)) AND NOT EXISTS(SELECT 1 FROM actual_fks WHERE NOT convalidated OR confupdtype<>'r' OR confdeltype<>'r' OR confmatchtype<>'s' OR condeferrable OR condeferred OR definition=''),
    NOT EXISTS(SELECT 1 FROM public.account_course_accesses a WHERE a.status='active' AND (SELECT count(*) FROM public.implementation_artifacts i WHERE i.account_id=a.account_id AND i.course_id=a.course_id)<>5)
  FROM drizzle.__drizzle_migrations j WHERE j.created_at=1786856400000;
$f$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.syntholo_certificates_readiness_v1()
RETURNS TABLE(
  contract_version text,migration_created_at bigint,migration_hash text,
  implementation_migration_hash text,implementation_completion_is_authority boolean,font_manifest_hash text,
  table_ready boolean,structure_ready boolean,immutability_ready boolean,rls_ready boolean,policy_ready boolean,
  table_acl_ready boolean,function_ready boolean,function_acl_ready boolean,public_execute_denied boolean,
  receipt_binding_ready boolean,upstream_ready boolean,independence_ready boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
  WITH required_tables(name,column_signature) AS (VALUES
    ('certificate_recipient_name_versions',ARRAY['id:uuid:t','account_id:uuid:t','membership_id:uuid:t','version:integer:t','display_name:text:t','content_hash:text:t','actor_identity_id:uuid:t','source_command_receipt_id:uuid:t','correlation_id:uuid:t','confirmed_at:timestamp(3) with time zone:t']::text[]),
    ('certificate_recipient_name_heads',ARRAY['account_id:uuid:t','membership_id:uuid:t','current_version:integer:t','current_version_id:uuid:t','created_at:timestamp(3) with time zone:t','updated_at:timestamp(3) with time zone:t']::text[]),
    ('certificate_records',ARRAY['id:uuid:t','certificate_prerequisite_id:uuid:t','course_completion_id:uuid:t','account_id:uuid:t','membership_id:uuid:t','enrollment_id:uuid:t','course_id:uuid:t','course_version_id:uuid:t','business_name_snapshot:text:t','course_title_snapshot:text:t','course_version:integer:t','completed_at:timestamp(3) with time zone:t','snapshot_renderable:boolean:t','recipient_name_version_id:uuid:f','recipient_name_version:integer:f','recipient_name_snapshot:text:f','renderer_version:text:t','status:text:t','failure_code:text:f','issued_at:timestamp(3) with time zone:f','created_at:timestamp(3) with time zone:t','updated_at:timestamp(3) with time zone:t']::text[]),
    ('certificate_files',ARRAY['id:uuid:t','certificate_id:uuid:t','course_completion_id:uuid:t','account_id:uuid:t','membership_id:uuid:t','object_key:text:t','access:text:t','content_type:text:t','byte_length:integer:t','sha256:text:t','etag:text:t','renderer_version:text:t','stored_at:timestamp(3) with time zone:t']::text[]),
    ('certificate_delivery_requests',ARRAY['id:uuid:t','certificate_id:uuid:t','account_id:uuid:t','membership_id:uuid:t','staff_identity_id:uuid:t','reason:text:t','source_command_receipt_id:uuid:t','correlation_id:uuid:t','status:text:t','created_at:timestamp(3) with time zone:t']::text[])
  ),
  relations AS (
    SELECT r.name,r.column_signature,c.oid,c.relkind,c.relpersistence,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.relacl
    FROM required_tables r LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||r.name)
  ),
  actual_columns_raw AS (
    SELECT c.relname table_name,a.attname column_name,format_type(a.atttypid,a.atttypmod) type_name,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,
      coalesce(coll.collname,'') collation_name,coalesce(pg_get_expr(d.adbin,d.adrelid),'') default_expression,a.attnum
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_collation coll ON coll.oid=a.attcollation
    WHERE n.nspname='public' AND c.relname IN(SELECT name FROM required_tables) AND a.attnum>0 AND NOT a.attisdropped
  ),
  actual_columns AS (
    SELECT table_name,array_agg(column_name||':'||type_name||':'||CASE WHEN attnotnull THEN 't' ELSE 'f' END ORDER BY attnum) column_signature
    FROM actual_columns_raw GROUP BY table_name
  ),
  expected_defaults(table_name,column_name,default_expression) AS (VALUES
    ('certificate_recipient_name_versions','id','gen_random_uuid()'),
    ('certificate_recipient_name_versions','confirmed_at',E'date_trunc(\'milliseconds\'::text, clock_timestamp())'),
    ('certificate_recipient_name_heads','created_at',E'date_trunc(\'milliseconds\'::text, clock_timestamp())'),
    ('certificate_recipient_name_heads','updated_at',E'date_trunc(\'milliseconds\'::text, clock_timestamp())'),
    ('certificate_records','id','gen_random_uuid()'),
    ('certificate_records','renderer_version',E'\'certificate-pdf.v1\'::text'),
    ('certificate_records','created_at',E'date_trunc(\'milliseconds\'::text, clock_timestamp())'),
    ('certificate_records','updated_at',E'date_trunc(\'milliseconds\'::text, clock_timestamp())'),
    ('certificate_files','id','gen_random_uuid()'),
    ('certificate_files','stored_at',E'date_trunc(\'milliseconds\'::text, clock_timestamp())'),
    ('certificate_delivery_requests','id','gen_random_uuid()'),
    ('certificate_delivery_requests','status',E'\'delivery_pending\'::text'),
    ('certificate_delivery_requests','created_at',E'date_trunc(\'milliseconds\'::text, clock_timestamp())')
  ),
  actual_defaults AS (SELECT table_name,column_name,default_expression FROM actual_columns_raw WHERE default_expression<>''),
  expected_keys(table_name,constraint_name,constraint_type,column_names) AS (VALUES
    ('certificate_recipient_name_versions','certificate_recipient_name_versions_pkey','p',ARRAY['id']::text[]),
    ('certificate_recipient_name_versions','certificate_name_versions_scope_version_unique','u',ARRAY['account_id','membership_id','version']::text[]),
    ('certificate_recipient_name_versions','certificate_name_versions_exact_unique','u',ARRAY['id','account_id','membership_id','version']::text[]),
    ('certificate_recipient_name_versions','certificate_name_versions_snapshot_exact_unique','u',ARRAY['id','account_id','membership_id','version','display_name']::text[]),
    ('certificate_recipient_name_versions','certificate_name_versions_source_receipt_unique','u',ARRAY['source_command_receipt_id']::text[]),
    ('certificate_recipient_name_heads','certificate_recipient_name_heads_pkey','p',ARRAY['account_id','membership_id']::text[]),
    ('certificate_records','certificate_records_pkey','p',ARRAY['id']::text[]),
    ('certificate_records','certificate_records_completion_unique','u',ARRAY['course_completion_id']::text[]),
    ('certificate_records','certificate_records_prerequisite_unique','u',ARRAY['certificate_prerequisite_id']::text[]),
    ('certificate_records','certificate_records_member_exact_unique','u',ARRAY['id','account_id','membership_id']::text[]),
    ('certificate_records','certificate_records_exact_unique','u',ARRAY['id','account_id','membership_id','course_completion_id']::text[]),
    ('certificate_files','certificate_files_pkey','p',ARRAY['id']::text[]),
    ('certificate_files','certificate_files_certificate_unique','u',ARRAY['certificate_id']::text[]),
    ('certificate_files','certificate_files_completion_unique','u',ARRAY['course_completion_id']::text[]),
    ('certificate_files','certificate_files_exact_unique','u',ARRAY['id','certificate_id','account_id','membership_id','course_completion_id']::text[]),
    ('certificate_delivery_requests','certificate_delivery_requests_pkey','p',ARRAY['id']::text[]),
    ('certificate_delivery_requests','certificate_delivery_requests_source_receipt_unique','u',ARRAY['source_command_receipt_id']::text[]),
    ('certificate_delivery_requests','certificate_delivery_requests_exact_unique','u',ARRAY['id','certificate_id','account_id','membership_id']::text[])
  ),
  actual_keys AS (
    SELECT rel.relname table_name,c.conname constraint_name,c.contype::text constraint_type,
      ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ordinal) column_names,
      c.convalidated,c.condeferrable,c.condeferred,pg_get_constraintdef(c.oid,true) definition
    FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid JOIN pg_namespace n ON n.oid=rel.relnamespace
    WHERE n.nspname='public' AND rel.relname IN(SELECT name FROM required_tables) AND c.contype IN('p','u')
  ),
  expected_fks(table_name,constraint_name,column_names,foreign_table,foreign_column_names) AS (VALUES
    ('certificate_recipient_name_versions','certificate_recipient_name_versions_account_id_fkey',ARRAY['account_id']::text[],'accounts',ARRAY['id']::text[]),
    ('certificate_recipient_name_versions','certificate_recipient_name_versi_source_command_receipt_id_fkey',ARRAY['source_command_receipt_id']::text[],'api_command_receipts',ARRAY['id']::text[]),
    ('certificate_recipient_name_versions','certificate_name_versions_membership_actor_fk',ARRAY['membership_id','account_id','actor_identity_id']::text[],'memberships',ARRAY['id','account_id','member_identity_id']::text[]),
    ('certificate_recipient_name_versions','certificate_name_versions_actor_account_fk',ARRAY['actor_identity_id','account_id']::text[],'member_identities',ARRAY['id','account_id']::text[]),
    ('certificate_recipient_name_heads','certificate_recipient_name_heads_account_id_fkey',ARRAY['account_id']::text[],'accounts',ARRAY['id']::text[]),
    ('certificate_recipient_name_heads','certificate_name_heads_membership_account_fk',ARRAY['membership_id','account_id']::text[],'memberships',ARRAY['id','account_id']::text[]),
    ('certificate_recipient_name_heads','certificate_name_heads_current_version_fk',ARRAY['current_version_id','account_id','membership_id','current_version']::text[],'certificate_recipient_name_versions',ARRAY['id','account_id','membership_id','version']::text[]),
    ('certificate_records','certificate_records_account_id_fkey',ARRAY['account_id']::text[],'accounts',ARRAY['id']::text[]),
    ('certificate_records','certificate_records_completion_exact_fk',ARRAY['course_completion_id','account_id','membership_id','enrollment_id','course_id','course_version_id']::text[],'course_completions',ARRAY['id','account_id','membership_id','enrollment_id','course_id','course_version_id']::text[]),
    ('certificate_records','certificate_records_course_version_exact_fk',ARRAY['course_version_id','course_id','course_version']::text[],'course_versions',ARRAY['id','course_id','version']::text[]),
    ('certificate_records','certificate_records_prerequisite_exact_fk',ARRAY['certificate_prerequisite_id','course_completion_id','account_id','membership_id','enrollment_id','course_id','course_version_id']::text[],'certificate_prerequisites',ARRAY['id','course_completion_id','account_id','membership_id','enrollment_id','course_id','course_version_id']::text[]),
    ('certificate_records','certificate_records_recipient_name_version_fk',ARRAY['recipient_name_version_id','account_id','membership_id','recipient_name_version','recipient_name_snapshot']::text[],'certificate_recipient_name_versions',ARRAY['id','account_id','membership_id','version','display_name']::text[]),
    ('certificate_files','certificate_files_record_exact_fk',ARRAY['certificate_id','account_id','membership_id','course_completion_id']::text[],'certificate_records',ARRAY['id','account_id','membership_id','course_completion_id']::text[]),
    ('certificate_delivery_requests','certificate_delivery_requests_staff_identity_id_fkey',ARRAY['staff_identity_id']::text[],'staff_identities',ARRAY['id']::text[]),
    ('certificate_delivery_requests','certificate_delivery_requests_source_command_receipt_id_fkey',ARRAY['source_command_receipt_id']::text[],'api_command_receipts',ARRAY['id']::text[]),
    ('certificate_delivery_requests','certificate_delivery_requests_record_exact_fk',ARRAY['certificate_id','account_id','membership_id']::text[],'certificate_records',ARRAY['id','account_id','membership_id']::text[])
  ),
  actual_fks AS (
    SELECT rel.relname table_name,c.conname constraint_name,
      ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ordinal) column_names,
      foreign_rel.relname foreign_table,
      ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.ordinal) foreign_column_names,
      c.convalidated,c.confupdtype::text,c.confdeltype::text,c.confmatchtype::text,c.condeferrable,c.condeferred,
      source_n.nspname source_schema,foreign_n.nspname foreign_schema,pg_get_constraintdef(c.oid,true) definition
    FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid JOIN pg_namespace source_n ON source_n.oid=rel.relnamespace
    JOIN pg_class foreign_rel ON foreign_rel.oid=c.confrelid JOIN pg_namespace foreign_n ON foreign_n.oid=foreign_rel.relnamespace
    WHERE source_n.nspname='public' AND rel.relname IN(SELECT name FROM required_tables) AND c.contype='f'
  ),
  expected_checks(table_name,constraint_name,definition) AS (VALUES
    ('certificate_recipient_name_versions','certificate_name_versions_version_check','(version>0)'),
    ('certificate_recipient_name_versions','certificate_name_versions_display_name_check','public.syntholo_certificate_recipient_name_valid_v1(display_name)'),
    ('certificate_recipient_name_versions','certificate_name_versions_content_hash_check','public.syntholo_certificate_name_content_hash_valid_v1(display_name,content_hash)'),
    ('certificate_recipient_name_heads','certificate_name_heads_version_check','(current_version>0)'),
    ('certificate_records','certificate_records_renderer_check',E'((renderer_version=\'certificate-pdf.v1\')AND(course_version>0))'),
    ('certificate_records','certificate_records_snapshot_renderability_check','(snapshot_renderable=(public.syntholo_certificate_business_snapshot_renderable_v1(business_name_snapshot)ANDpublic.syntholo_certificate_course_snapshot_renderable_v1(course_title_snapshot)))'),
    ('certificate_records','certificate_records_state_check','public.syntholo_certificate_record_state_valid_v1(snapshot_renderable,recipient_name_version_id,recipient_name_version,recipient_name_snapshot,status,failure_code,issued_at)'),
    ('certificate_files','certificate_files_object_key_check',E'(object_key=((((\'certificates/v1/\'||(account_id))||\'/\')||(course_completion_id))||\'.pdf\'))'),
    ('certificate_files','certificate_files_access_check',E'(access=\'private\')'),
    ('certificate_files','certificate_files_content_type_check',E'(content_type=\'application/pdf\')'),
    ('certificate_files','certificate_files_byte_length_check','((byte_length>=1)AND(byte_length<=26214400))'),
    ('certificate_files','certificate_files_hash_check',E'(sha256~\'^[0-9a-f]{64}$\')'),
    ('certificate_files','certificate_files_etag_check','public.syntholo_certificate_etag_valid_v1(etag)'),
    ('certificate_files','certificate_files_renderer_check',E'(renderer_version=\'certificate-pdf.v1\')'),
    ('certificate_delivery_requests','certificate_delivery_requests_status_check',E'(status=\'delivery_pending\')'),
    ('certificate_delivery_requests','certificate_delivery_requests_reason_check','public.syntholo_certificate_text_valid_v1(reason,2000,true)')
  ),
  actual_checks AS (
    SELECT rel.relname table_name,c.conname constraint_name,
      regexp_replace(replace(pg_get_expr(c.conbin,c.conrelid),'::text',''),'[[:space:]]','','g') definition,c.convalidated
    FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid JOIN pg_namespace n ON n.oid=rel.relnamespace
    WHERE n.nspname='public' AND rel.relname IN(SELECT name FROM required_tables) AND c.contype='c'
  ),
  expected_indexes(table_name,index_name,column_names,index_options,opclasses) AS (VALUES
    ('certificate_recipient_name_versions','certificate_name_versions_history_idx',ARRAY['account_id','membership_id','version']::text[],ARRAY[0,0,3]::smallint[],ARRAY['uuid_ops','uuid_ops','int4_ops']::text[]),
    ('certificate_records','certificate_records_member_history_idx',ARRAY['account_id','membership_id','completed_at','id']::text[],ARRAY[0,0,3,3]::smallint[],ARRAY['uuid_ops','uuid_ops','timestamptz_ops','uuid_ops']::text[]),
    ('certificate_delivery_requests','certificate_delivery_requests_certificate_idx',ARRAY['certificate_id','created_at']::text[],ARRAY[0,0]::smallint[],ARRAY['uuid_ops','timestamptz_ops']::text[])
  ),
  actual_indexes AS (
    SELECT table_rel.relname table_name,index_rel.relname index_name,
      ARRAY(SELECT a.attname FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ordinal) column_names,
      ARRAY(SELECT option FROM unnest(i.indoption::smallint[]) WITH ORDINALITY option_value(option,ordinal) ORDER BY ordinal) index_options,
      ARRAY(SELECT opc.opcname FROM unnest(i.indclass::oid[]) WITH ORDINALITY c(opcoid,ordinal) JOIN pg_opclass opc ON opc.oid=c.opcoid ORDER BY c.ordinal) opclasses,
      am.amname access_method,i.indnkeyatts,i.indnatts,i.indpred,i.indexprs,i.indisunique,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) definition
    FROM pg_index i JOIN pg_class table_rel ON table_rel.oid=i.indrelid JOIN pg_namespace n ON n.oid=table_rel.relnamespace
    JOIN pg_class index_rel ON index_rel.oid=i.indexrelid JOIN pg_am am ON am.oid=index_rel.relam
    WHERE n.nspname='public' AND table_rel.relname IN(SELECT name FROM required_tables)
      AND NOT EXISTS(SELECT 1 FROM pg_constraint constraint_index WHERE constraint_index.conindid=i.indexrelid)
  ),
  expected_triggers(table_name,trigger_name,trigger_type,function_signature,when_clause) AS (VALUES
    ('certificate_recipient_name_versions','certificate_name_versions_immutable',27,'public.syntholo_certificate_immutable_row_v1()',''),
    ('certificate_recipient_name_heads','certificate_name_heads_guard',27,'public.syntholo_certificate_head_guard_v1()',''),
    ('certificate_records','certificate_records_guard',27,'public.syntholo_certificate_record_guard_v1()',''),
    ('certificate_files','certificate_files_immutable',27,'public.syntholo_certificate_immutable_row_v1()',''),
    ('certificate_delivery_requests','certificate_delivery_requests_immutable',27,'public.syntholo_certificate_immutable_row_v1()','')
  ),
  actual_triggers AS (
    SELECT c.relname table_name,t.tgname trigger_name,t.tgtype::integer trigger_type,p.oid::regprocedure::text function_signature,
      regexp_replace(replace(lower(coalesce(substring(pg_get_triggerdef(t.oid,true) from E' WHEN \\((.*)\\) EXECUTE FUNCTION '),'')),'::text',''),'[[:space:]()]','','g') when_clause,
      t.tgenabled,pg_get_triggerdef(t.oid,true) definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE NOT t.tgisinternal AND n.nspname='public' AND c.relname IN(SELECT name FROM required_tables)
  ),
  expected_policies(table_name,policy_name,command_name,role_names,qual,with_check,permissive) AS (
    SELECT name,name||'_migrator','*',ARRAY['syntholo_migrator']::text[],'true','true',true FROM required_tables
  ),
  actual_policies AS (
    SELECT c.relname table_name,p.polname policy_name,p.polcmd::text command_name,
      ARRAY(SELECT CASE WHEN role_oid.oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid.oid) END FROM unnest(p.polroles) role_oid(oid) ORDER BY 1) role_names,
      lower(coalesce(pg_get_expr(p.polqual,p.polrelid),'')) qual,lower(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')) with_check,p.polpermissive permissive
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN(SELECT name FROM required_tables)
  ),
  expected_function_bodies(signature,security_definer,volatility,body_hash) AS (VALUES
    ('public.syntholo_certificate_font_supports_v1(integer)',false,'i','3e86da7e1df46ed5a4b167f324931f07785b84b0b5d6889b321bd36d58810ffe'),
    ('public.syntholo_certificate_forbidden_scalar_v1(integer)',false,'i','b1391c9dd9e51ec2966e8271a24b47b8e3282898abc2fe6f2867dcbcfc391437'),
    ('public.syntholo_certificate_recipient_name_valid_v1(text)',false,'i','84c9cb54b213ea32bd14fbb3462d6cf9f4b05917af78fd43fb327b87cd145894'),
    ('public.syntholo_certificate_business_snapshot_renderable_v1(text)',false,'i','02c585338292990c8ec014c9bcd535ccd433fd8db7028b1e1386511482c962be'),
    ('public.syntholo_certificate_course_snapshot_renderable_v1(text)',false,'i','3e69df32058a3a364d84001c2dcf234bee4093816a1c79513703f9d3cc9f6352'),
    ('public.syntholo_certificate_text_valid_v1(text,integer,boolean)',false,'i','55ba4a8b8a2409467b53a064c899d63a80011acacbb5aa2266e61c3e53309d59'),
    ('public.syntholo_certificate_etag_valid_v1(text)',false,'i','fbfddcbfda567ab08038f2e405dc17151b61647ad25cf23c941c8e15026c8cad'),
    ('public.syntholo_certificate_name_content_hash_valid_v1(text,text)',false,'i','4b3f6f3016590a0cf0ebdc91605be63c3854a258d5bb3d15448ed7643bfc9a6c'),
    ('public.syntholo_certificate_recovery_audit_valid_v1(text,jsonb,uuid,integer,integer)',false,'i','51d2a2934c53fedfcdb04725b20fcc6d0d6140b892032dc3418b339c764fe681'),
    ('public.syntholo_certificate_record_state_valid_v1(boolean,uuid,integer,text,text,text,timestamp with time zone)',false,'i','fae1f8ec432ccd52af348d266e8e8949b7629c74e21704aeee4202ef39fa0d3a'),
    ('public.syntholo_certificate_immutable_row_v1()',false,'v','8dbe3e60d692696db88b78370c77fa7ab5cc71e35cf5666825b820ed9e41959b'),
    ('public.syntholo_certificate_head_guard_v1()',false,'v','df6c4c4115fba4f781567b7bb80896aaa8862089ae928effbfec19589ae3afec'),
    ('public.syntholo_certificate_record_guard_v1()',false,'v','4010ce5b7220139fa186121e479488261a648aed7d7849ae1d910ef2a639bff1'),
    ('public.syntholo_certificate_enqueue_v1(uuid)',true,'v','95743e93c2b3770142360e5efbeda79e2dfe1d7c86e6a90e96484f5718232fd6'),
    ('public.syntholo_certificate_stage_candidate_v1(uuid,text)',true,'v','6284ab5c3640ef1bcf4b688373eb0b7f7ae48bac559de495d826372f7a2dcbbf'),
    ('public.syntholo_certificate_confirm_recipient_name_v1(integer,text,text,text)',true,'v','45ed93f1d1c71b09486a73d9951fad77c1b608d51ee2b935a70e57063d028374'),
    ('public.syntholo_certificate_recipient_name_get_v1()',true,'s','28bc918b884edecafdc4e20d13eea6c64d2084e8a0975bc2df8ed15a4697c031'),
    ('public.syntholo_certificates_list_v1(timestamp with time zone,uuid,integer)',true,'s','14020f126a71ef166d3ae2831f5b2632c1605fd364d211e76cce4e2790db6d6d'),
    ('public.syntholo_certificate_download_fence_v1(uuid)',true,'s','717343a215ad8c2625f83fc00ab6b7937b57f1272137f4370e5f81cd366d7b6b'),
    ('public.syntholo_certificate_load_generation_fence_v1(uuid,text,integer,integer,uuid)',true,'v','6c3f30cc6831d242bab86a541dc2d4380d3028506bdf81aef74c10e6fcded417'),
    ('public.syntholo_certificate_load_issued_file_v1(uuid,text,integer,integer,uuid)',true,'v','c5aa93d35ef75fee13a00c903d3a5480593824fc4ea1483fdff3762a3bd6ecb4'),
    ('public.syntholo_certificate_lock_generation_fence_v1(uuid,text,integer,integer,uuid)',true,'v','04ae23d194c8c7aa8733534dfc30109e0cab268f8101d81849438a66b2625e71'),
    ('public.syntholo_certificate_finalize_v1(uuid,text,integer,integer,uuid,integer,text,text)',true,'v','a80fa31064cc8fb384c3c4038f25de3689877380b099b3e962017eddf2544f1e'),
    ('public.syntholo_certificate_mark_failed_v1(uuid,text,integer,integer,uuid,text)',true,'v','20897ceecdcf5d52caeabd4011a347cde87ebdf4740efe86652a489984d4231b'),
    ('public.syntholo_certificate_storage_retry_candidates_v1(integer)',true,'v','3eed2de0771dbb4cccda17bbd03420b0a2db3e2ee8639df58e1362b65bb417cc'),
    ('public.syntholo_certificate_retry_v1(uuid,uuid,integer,integer,text,integer,text,text)',true,'v','9f52ec977e3bfcf17313676922a8e9a6095336359120c190ac280d461592a381'),
    ('public.syntholo_certificate_recovery_reject_v1(uuid,uuid,integer,integer,text)',true,'v','453003a744bb2fcd1a3965f7cb7db8144bd667fbecca0c5bc2b1fb0589b0ca66'),
    ('public.syntholo_certificate_promote_v1(integer)',true,'v','b808b34bf23b8546689d7bb8ff7517b96d104e1179b6d0a1a70d8ba0cfc058e7'),
    ('public.syntholo_certificate_create_delivery_v1(uuid,text,text,text)',true,'v','3c58a162ff2abea6a25dccb98d315c3190165e0c9a6cae2d0e14403a63550a07'),
    ('public.syntholo_certificates_readiness_v1()',true,'s',NULL)
  ),
  expected_functions AS (
    SELECT signature,security_definer,volatility,
      signature IN(
        'public.syntholo_certificate_font_supports_v1(integer)',
        'public.syntholo_certificate_forbidden_scalar_v1(integer)',
        'public.syntholo_certificate_recipient_name_valid_v1(text)',
        'public.syntholo_certificate_business_snapshot_renderable_v1(text)',
        'public.syntholo_certificate_course_snapshot_renderable_v1(text)',
        'public.syntholo_certificate_etag_valid_v1(text)'
      ) is_strict,
      CASE WHEN signature IN(
        'public.syntholo_certificate_font_supports_v1(integer)',
        'public.syntholo_certificate_forbidden_scalar_v1(integer)',
        'public.syntholo_certificate_recipient_name_valid_v1(text)',
        'public.syntholo_certificate_business_snapshot_renderable_v1(text)',
        'public.syntholo_certificate_course_snapshot_renderable_v1(text)',
        'public.syntholo_certificate_text_valid_v1(text,integer,boolean)',
        'public.syntholo_certificate_etag_valid_v1(text)',
        'public.syntholo_certificate_name_content_hash_valid_v1(text,text)',
        'public.syntholo_certificate_recovery_audit_valid_v1(text,jsonb,uuid,integer,integer)',
        'public.syntholo_certificate_record_state_valid_v1(boolean,uuid,integer,text,text,text,timestamp with time zone)'
      ) THEN 's'::"char" ELSE 'u'::"char" END parallel_safety,body_hash
    FROM expected_function_bodies
  ),
  functions AS (
    SELECT e.*,p.oid,p.proowner,p.prokind,p.prosecdef,p.provolatile::text actual_volatility,p.proisstrict,p.proparallel,p.proconfig,p.proacl,
      CASE WHEN p.oid IS NULL THEN '' ELSE encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') END actual_body_hash
    FROM expected_functions e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)
  ),
  actual_function_inventory AS (
    SELECT p.oid::regprocedure::text signature,p.oid,pg_get_functiondef(p.oid) definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'syntholo_certificate%'
  ),
  owner AS (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.syntholo_content_readiness_v1()')),
  expected_table_acl(role_name,table_name,privilege_type,is_grantable) AS (
    SELECT role.rolname,r.name,privilege,false FROM relations r JOIN pg_roles role ON role.rolname='syntholo_migrator'
    CROSS JOIN LATERAL unnest(CASE WHEN current_setting('server_version_num')::integer>=170000
      THEN ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']::text[]
      ELSE ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']::text[] END) privilege
    WHERE role.oid<>r.relowner
  ),
  actual_table_acl AS (
    SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END role_name,r.name table_name,a.privilege_type,a.is_grantable
    FROM relations r CROSS JOIN LATERAL aclexplode(r.relacl) a WHERE a.grantee<>r.relowner
  ),
  actual_column_acl AS (
    SELECT c.relname table_name,a.attname column_name,
      CASE WHEN grant_row.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(grant_row.grantee) END role_name,
      grant_row.privilege_type,grant_row.is_grantable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid
    CROSS JOIN LATERAL aclexplode(a.attacl) grant_row
    WHERE n.nspname='public' AND c.relname IN(SELECT name FROM required_tables)
      AND a.attnum>0 AND NOT a.attisdropped
  ),
  expected_function_acl(signature,role_name,privilege_type,is_grantable) AS (VALUES
    ('public.syntholo_certificate_confirm_recipient_name_v1(integer,text,text,text)','syntholo_member_api','EXECUTE',false),
    ('public.syntholo_certificate_recipient_name_get_v1()','syntholo_member_api','EXECUTE',false),
    ('public.syntholo_certificates_list_v1(timestamp with time zone,uuid,integer)','syntholo_member_api','EXECUTE',false),
    ('public.syntholo_certificate_download_fence_v1(uuid)','syntholo_member_api','EXECUTE',false),
    ('public.syntholo_certificate_create_delivery_v1(uuid,text,text,text)','syntholo_staff_api','EXECUTE',false),
    ('public.syntholo_certificate_stage_candidate_v1(uuid,text)','syntholo_worker','EXECUTE',false),
    ('public.syntholo_certificate_load_generation_fence_v1(uuid,text,integer,integer,uuid)','syntholo_worker','EXECUTE',false),
    ('public.syntholo_certificate_load_issued_file_v1(uuid,text,integer,integer,uuid)','syntholo_worker','EXECUTE',false),
    ('public.syntholo_certificate_finalize_v1(uuid,text,integer,integer,uuid,integer,text,text)','syntholo_worker','EXECUTE',false),
    ('public.syntholo_certificate_mark_failed_v1(uuid,text,integer,integer,uuid,text)','syntholo_worker','EXECUTE',false),
    ('public.syntholo_certificate_storage_retry_candidates_v1(integer)','syntholo_worker','EXECUTE',false),
    ('public.syntholo_certificate_retry_v1(uuid,uuid,integer,integer,text,integer,text,text)','syntholo_worker','EXECUTE',false),
    ('public.syntholo_certificate_recovery_reject_v1(uuid,uuid,integer,integer,text)','syntholo_worker','EXECUTE',false),
    ('public.syntholo_certificate_promote_v1(integer)','syntholo_worker','EXECUTE',false),
    ('public.syntholo_certificates_readiness_v1()','syntholo_migrator','EXECUTE',false),
    ('public.syntholo_certificates_readiness_v1()','syntholo_member_api','EXECUTE',false),
    ('public.syntholo_certificates_readiness_v1()','syntholo_staff_api','EXECUTE',false),
    ('public.syntholo_certificates_readiness_v1()','syntholo_worker','EXECUTE',false),
    ('public.syntholo_certificates_readiness_v1()','syntholo_system_api','EXECUTE',false)
  ),
  actual_function_acl AS (
    SELECT f.signature,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END role_name,a.privilege_type,a.is_grantable
    FROM functions f CROSS JOIN LATERAL aclexplode(f.proacl) a WHERE a.grantee<>f.proowner
  ),
  upstream_keys(table_name,constraint_name,constraint_type,column_names,definition) AS (VALUES
    ('memberships','memberships_id_account_identity_unique','u',ARRAY['id','account_id','member_identity_id']::text[],'UNIQUE (id, account_id, member_identity_id)'),
    ('certificate_prerequisites','certificate_prerequisites_exact_unique','u',ARRAY['id','course_completion_id','account_id','membership_id','enrollment_id','course_id','course_version_id']::text[],'UNIQUE (id, course_completion_id, account_id, membership_id, enrollment_id, course_id, course_version_id)'),
    ('course_versions','course_versions_certificate_exact_unique','u',ARRAY['id','course_id','version']::text[],'UNIQUE (id, course_id, version)'),
    ('jobs','jobs_idempotency_key_unique','u',ARRAY['idempotency_key']::text[],'UNIQUE (idempotency_key)'),
    ('api_command_receipts','api_command_receipts_scope_key_unique','u',ARRAY['principal_kind','principal_id','method','route_template','idempotency_key']::text[],'UNIQUE (principal_kind, principal_id, method, route_template, idempotency_key)')
  ),
  actual_upstream_keys AS (
    SELECT rel.relname table_name,c.conname constraint_name,c.contype::text constraint_type,
      ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ordinal) column_names,
      pg_get_constraintdef(c.oid,true) definition,c.convalidated,c.condeferrable,c.condeferred
    FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid JOIN pg_namespace n ON n.oid=rel.relnamespace
    WHERE n.nspname='public' AND c.conname IN(SELECT constraint_name FROM upstream_keys)
  ),
  runtime_attestation AS (
    SELECT p.oid,p.proowner,p.prokind,p.prosecdef,p.provolatile,p.proisstrict,p.proparallel,p.proconfig,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') body_hash
    FROM pg_proc p WHERE p.oid=to_regprocedure('public.syntholo_attest_runtime_capability(text)')
  ),
  job_claim_function AS (
    SELECT p.oid,p.proowner,p.prokind,p.prosecdef,p.provolatile,p.proisstrict,p.proparallel,p.proconfig,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') body_hash
    FROM pg_proc p WHERE p.oid=to_regprocedure('public.syntholo_claim_jobs(integer,text,timestamp with time zone,integer)')
  ),
  implementation_readiness_function AS (
    SELECT p.oid,p.proowner,p.prokind,p.prosecdef,p.provolatile,p.proisstrict,p.proparallel,p.proconfig,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') body_hash
    FROM pg_proc p WHERE p.oid=to_regprocedure('public.syntholo_implementation_readiness_v1()')
  ),
  content_readiness_function AS (
    SELECT p.oid,p.proowner,p.prokind,p.prosecdef,p.provolatile,p.proisstrict,p.proparallel,p.proconfig,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') body_hash
    FROM pg_proc p WHERE p.oid=to_regprocedure('public.syntholo_content_readiness_v1()')
  ),
  content_state AS (SELECT * FROM public.syntholo_content_readiness_v1()),
  implementation_state AS (SELECT * FROM public.syntholo_implementation_readiness_v1()),
  migration AS (SELECT created_at,hash FROM drizzle.__drizzle_migrations WHERE created_at=1786942800000)
  SELECT '0013_certificates.v1',migration.created_at,migration.hash,
    'dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9',false,
    '08b07f94c69e07cf51395aaa8057a4f5c2aebd1571fcf50e32baa89e9c881f96',
    (SELECT count(*)=5 AND bool_and(oid IS NOT NULL AND relkind='r' AND relpersistence='p' AND relowner=(SELECT proowner FROM owner)) FROM relations),
    NOT EXISTS((SELECT name,column_signature FROM required_tables EXCEPT SELECT table_name,column_signature FROM actual_columns)
      UNION ALL (SELECT table_name,column_signature FROM actual_columns EXCEPT SELECT name,column_signature FROM required_tables))
      AND NOT EXISTS((SELECT table_name,column_name,default_expression FROM expected_defaults EXCEPT SELECT table_name,column_name,default_expression FROM actual_defaults)
      UNION ALL (SELECT table_name,column_name,default_expression FROM actual_defaults EXCEPT SELECT table_name,column_name,default_expression FROM expected_defaults))
      AND NOT EXISTS(SELECT 1 FROM actual_columns_raw WHERE attidentity<>'' OR attgenerated<>'' OR (type_name='text' AND collation_name<>'default') OR (type_name<>'text' AND attcollation<>0))
      AND NOT EXISTS((SELECT table_name,constraint_name,constraint_type,column_names FROM expected_keys EXCEPT SELECT table_name,constraint_name,constraint_type,column_names FROM actual_keys)
      UNION ALL (SELECT table_name,constraint_name,constraint_type,column_names FROM actual_keys EXCEPT SELECT table_name,constraint_name,constraint_type,column_names FROM expected_keys))
      AND NOT EXISTS(SELECT 1 FROM actual_keys WHERE NOT convalidated OR condeferrable OR condeferred OR definition='')
      AND NOT EXISTS((SELECT table_name,constraint_name,column_names,foreign_table,foreign_column_names FROM expected_fks EXCEPT SELECT table_name,constraint_name,column_names,foreign_table,foreign_column_names FROM actual_fks)
      UNION ALL (SELECT table_name,constraint_name,column_names,foreign_table,foreign_column_names FROM actual_fks EXCEPT SELECT table_name,constraint_name,column_names,foreign_table,foreign_column_names FROM expected_fks))
      AND NOT EXISTS(SELECT 1 FROM actual_fks WHERE NOT convalidated OR confupdtype<>'r' OR confdeltype<>'r' OR confmatchtype<>'s' OR condeferrable OR condeferred OR source_schema<>'public' OR foreign_schema<>'public' OR definition='')
      AND NOT EXISTS((SELECT table_name,constraint_name,definition FROM expected_checks EXCEPT SELECT table_name,constraint_name,definition FROM actual_checks)
      UNION ALL (SELECT table_name,constraint_name,definition FROM actual_checks EXCEPT SELECT table_name,constraint_name,definition FROM expected_checks))
      AND NOT EXISTS(SELECT 1 FROM actual_checks WHERE NOT convalidated)
      AND NOT EXISTS((SELECT table_name,index_name,column_names,index_options,opclasses FROM expected_indexes EXCEPT SELECT table_name,index_name,column_names,index_options,opclasses FROM actual_indexes)
      UNION ALL (SELECT table_name,index_name,column_names,index_options,opclasses FROM actual_indexes EXCEPT SELECT table_name,index_name,column_names,index_options,opclasses FROM expected_indexes))
      AND NOT EXISTS(SELECT 1 FROM actual_indexes WHERE access_method<>'btree' OR indnkeyatts<>indnatts OR indpred IS NOT NULL OR indexprs IS NOT NULL OR indisunique OR NOT indisvalid OR NOT indisready OR definition=''),
    NOT EXISTS((SELECT table_name,trigger_name,trigger_type,function_signature,when_clause FROM expected_triggers EXCEPT SELECT table_name,trigger_name,trigger_type,function_signature,when_clause FROM actual_triggers)
      UNION ALL (SELECT table_name,trigger_name,trigger_type,function_signature,when_clause FROM actual_triggers EXCEPT SELECT table_name,trigger_name,trigger_type,function_signature,when_clause FROM expected_triggers))
      AND NOT EXISTS(SELECT 1 FROM actual_triggers WHERE tgenabled<>'O' OR definition=''),
    (SELECT count(*)=5 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM relations),
    NOT EXISTS((SELECT table_name,policy_name,command_name,role_names,qual,with_check,permissive FROM expected_policies EXCEPT SELECT table_name,policy_name,command_name,role_names,qual,with_check,permissive FROM actual_policies)
      UNION ALL (SELECT table_name,policy_name,command_name,role_names,qual,with_check,permissive FROM actual_policies EXCEPT SELECT table_name,policy_name,command_name,role_names,qual,with_check,permissive FROM expected_policies)),
    NOT EXISTS((SELECT role_name,table_name,privilege_type,is_grantable FROM expected_table_acl EXCEPT SELECT role_name,table_name,privilege_type,is_grantable FROM actual_table_acl)
      UNION ALL (SELECT role_name,table_name,privilege_type,is_grantable FROM actual_table_acl EXCEPT SELECT role_name,table_name,privilege_type,is_grantable FROM expected_table_acl))
      AND NOT EXISTS(SELECT 1 FROM actual_column_acl),
    (SELECT count(*)=30 AND bool_and(oid IS NOT NULL AND prokind='f' AND proowner=(SELECT proowner FROM owner) AND prosecdef=security_definer AND actual_volatility=volatility AND proisstrict=is_strict AND proparallel=parallel_safety AND proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[] AND (body_hash IS NULL OR actual_body_hash=body_hash)) FROM functions)
      AND NOT EXISTS((SELECT signature FROM expected_functions EXCEPT SELECT signature FROM actual_function_inventory)
      UNION ALL (SELECT signature FROM actual_function_inventory EXCEPT SELECT signature FROM expected_functions))
      AND (SELECT count(*)=1 AND bool_and(oid IS NOT NULL AND prokind='f' AND proowner=(SELECT proowner FROM owner) AND prosecdef AND provolatile='v' AND NOT proisstrict AND proparallel='u' AND proconfig=ARRAY['search_path=pg_catalog, public']::text[] AND body_hash='20e2df467ba7b3d2c715a0a22ece794298aecadb22aa57b0a2853c2df2835d49') FROM runtime_attestation)
      AND (SELECT count(*)=1 AND bool_and(oid IS NOT NULL AND prokind='f' AND proowner=(SELECT proowner FROM owner) AND prosecdef AND provolatile='v' AND NOT proisstrict AND proparallel='u' AND proconfig=ARRAY['search_path=pg_catalog, public']::text[] AND body_hash='9ce584d3c189c1a822548071084d24de59f0bfb495c9c73c4a9cf856c2100891') FROM job_claim_function)
      AND (SELECT count(*)=1 AND bool_and(oid IS NOT NULL AND prokind='f' AND proowner=(SELECT proowner FROM owner) AND prosecdef AND provolatile='s' AND NOT proisstrict AND proparallel='u' AND proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[] AND body_hash='468276c0e37e2be0f65185cddbbf40003b484836cafb5d990225793cd3076eda') FROM implementation_readiness_function)
      AND (SELECT count(*)=1 AND bool_and(oid IS NOT NULL AND prokind='f' AND proowner=(SELECT proowner FROM owner) AND prosecdef AND provolatile='s' AND NOT proisstrict AND proparallel='u' AND proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[] AND body_hash='8d8fc5d049c5489c221a768655301e44f4a01873b92a70cfa14466d3f3f81534') FROM content_readiness_function),
    NOT EXISTS((SELECT signature,role_name,privilege_type,is_grantable FROM expected_function_acl EXCEPT SELECT signature,role_name,privilege_type,is_grantable FROM actual_function_acl)
      UNION ALL (SELECT signature,role_name,privilege_type,is_grantable FROM actual_function_acl EXCEPT SELECT signature,role_name,privilege_type,is_grantable FROM expected_function_acl)),
    NOT EXISTS(SELECT 1 FROM actual_function_acl WHERE role_name='PUBLIC' AND privilege_type='EXECUTE'),
    EXISTS(SELECT 1 FROM pg_constraint WHERE conname='certificate_name_versions_source_receipt_unique')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conname='certificate_delivery_requests_source_receipt_unique')
      AND position('/v1/member/certificate-recipient-name' in pg_get_functiondef(to_regprocedure('public.syntholo_certificate_confirm_recipient_name_v1(integer,text,text,text)')))>0
      AND position('/v1/staff/certificates/:certificateId/deliveries' in pg_get_functiondef(to_regprocedure('public.syntholo_certificate_create_delivery_v1(uuid,text,text,text)')))>0,
    NOT EXISTS((SELECT table_name,constraint_name,constraint_type,column_names,definition FROM upstream_keys EXCEPT SELECT table_name,constraint_name,constraint_type,column_names,definition FROM actual_upstream_keys)
      UNION ALL (SELECT table_name,constraint_name,constraint_type,column_names,definition FROM actual_upstream_keys EXCEPT SELECT table_name,constraint_name,constraint_type,column_names,definition FROM upstream_keys))
      AND NOT EXISTS(SELECT 1 FROM actual_upstream_keys WHERE NOT convalidated OR condeferrable OR condeferred)
      AND (SELECT learning_migration_created_at=1786770000000 AND learning_migration_hash='2e37ec9d4bfeee1ad0319ae81172fac4107a87c798bd2f0eed79eb75ee0e2ccf'
        AND object_owner_ready AND object_type_ready AND immutable_triggers_ready AND table_acl_ready AND function_acl_ready AND public_execute_denied
        AND learning_table_ready AND learning_structure_ready AND learning_immutability_ready AND learning_rls_ready AND learning_acl_ready AND learning_function_ready AND learning_public_execute_denied
        FROM content_state),
    (SELECT migration_hash='dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9'
        AND table_ready AND structure_ready AND immutability_ready AND rls_ready AND policy_ready AND table_acl_ready AND function_ready AND function_acl_ready AND public_execute_denied AND receipt_binding_ready AND upstream_fk_ready AND seed_backfill_ready
        FROM implementation_state)
      AND NOT EXISTS(SELECT 1 FROM actual_fks WHERE foreign_table~'(implementation_|entitlement_|commerce_|product_|subscription_|support_|circle_|business_os_|club_subscription_|seat_|account_hold|account_course_access)')
      AND NOT EXISTS(SELECT 1 FROM actual_function_inventory WHERE signature<>'public.syntholo_certificates_readiness_v1()' AND definition~'(implementation_|entitlement_|commerce_|product_|subscription_|support_|circle_|business_os_|club_subscription_|seat_|account_hold|account_course_access)')
  FROM migration
$f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_commerce_catalog_readiness_v1()
RETURNS TABLE(
  contract_version text,
  migration_created_at bigint,
  migration_hash text,
  implementation_migration_hash text,
  certificates_migration_hash text,
  implementation_completion_is_authority boolean,
  table_ready boolean,
  structure_ready boolean,
  immutability_ready boolean,
  rls_ready boolean,
  policy_ready boolean,
  table_acl_ready boolean,
  function_ready boolean,
  function_acl_ready boolean,
  public_execute_denied boolean,
  upstream_ready boolean,
  catalog_ready boolean,
  cleanup_disabled boolean,
  independence_ready boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $readiness$
  WITH required_tables(name) AS (VALUES
    ('offers'),('offer_catalog_versions'),('offer_price_bindings'),
    ('checkout_authorizations'),('checkout_sessions'),('checkout_provider_actions'),
    ('public_business_os_setup_intents'),('stripe_customer_creation_actions'),
    ('business_os_setup_epochs'),('recurring_purchase_intents'),('stripe_customers'),
    ('purchases'),('public_business_os_setup_fulfillments'),
    ('purchase_payment_allocations'),('subscriptions'),('subscription_schedules'),
    ('invoices'),('invoice_line_allocations'),('controlled_payment_authorizations'),
    ('claim_tokens'),('pending_claim_sessions'),('secure_link_deliveries'),
    ('account_onboarding'),('account_onboarding_priorities'),
    ('provider_event_processing'),('provider_event_attempts'),('provider_event_effects')
  ),
  owner AS (
    SELECT proowner FROM pg_proc
    WHERE oid=to_regprocedure('public.syntholo_content_readiness_v1()')
  ),
  relations AS (
    SELECT required.name,c.oid,c.relkind,c.relpersistence,c.relowner,
      c.relrowsecurity,c.relforcerowsecurity,c.relacl
    FROM required_tables required
    LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||required.name)
  ),
  receipt_root_authority AS (
    SELECT c.oid IS NOT NULL AND c.relkind='r' AND c.relpersistence='p'
      AND c.relowner=(SELECT proowner FROM owner)
      AND c.relrowsecurity AND c.relforcerowsecurity
      AND EXISTS(
        SELECT 1 FROM pg_policy policy
        WHERE policy.polrelid=c.oid
          AND policy.polname='provider_event_receipts_migrator'
          AND policy.polcmd='*' AND policy.polpermissive
          AND policy.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='syntholo_migrator')]
          AND pg_get_expr(policy.polqual,policy.polrelid)='true'
          AND pg_get_expr(policy.polwithcheck,policy.polrelid)='true'
      )
      AND (SELECT count(*)=2 FROM pg_trigger trigger_row
        WHERE trigger_row.tgrelid=c.oid AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled='O'
          AND trigger_row.tgfoid=to_regprocedure('public.syntholo_provider_event_receipts_stripe_immutable_v1()'))
      AND EXISTS(SELECT 1 FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid=c.oid
          AND constraint_row.conname='provider_event_receipts_stripe_envelope_check'
          AND constraint_row.contype='c' AND constraint_row.convalidated)
      AND EXISTS(SELECT 1 FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid=c.oid
          AND constraint_row.conname='provider_event_receipts_fulfillment_owner_unique'
          AND constraint_row.contype='u' AND constraint_row.convalidated)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute attribute
        WHERE attribute.attrelid=c.oid AND attribute.attnum>0
          AND NOT attribute.attisdropped AND attribute.attacl IS NOT NULL)
      AND has_table_privilege('syntholo_migrator',c.oid,'SELECT')
      AND has_table_privilege('syntholo_migrator',c.oid,'INSERT')
      AND has_table_privilege('syntholo_migrator',c.oid,'UPDATE')
      AND has_table_privilege('syntholo_migrator',c.oid,'DELETE')
      AND NOT has_table_privilege('syntholo_member_api',c.oid,'SELECT')
      AND NOT has_table_privilege('syntholo_staff_api',c.oid,'SELECT')
      AND NOT has_table_privilege('syntholo_worker',c.oid,'SELECT')
      AND NOT has_table_privilege('syntholo_system_api',c.oid,'SELECT') ready
    FROM pg_class c WHERE c.oid=to_regclass('public.provider_event_receipts')
  ),
  actual_columns AS (
    SELECT relation.name table_name,a.attnum,a.attname,
      format_type(a.atttypid,a.atttypmod) type_name,a.attnotnull,
      a.attidentity,a.attgenerated,
      CASE WHEN a.attcollation=0 THEN '' ELSE coalesce(coll.collname,'') END collation_name,
      coalesce(pg_get_expr(default_value.adbin,default_value.adrelid),'') default_expression
    FROM relations relation
    JOIN pg_attribute a ON a.attrelid=relation.oid
    LEFT JOIN pg_attrdef default_value
      ON default_value.adrelid=a.attrelid AND default_value.adnum=a.attnum
    LEFT JOIN pg_collation coll ON coll.oid=a.attcollation
    WHERE a.attnum>0 AND NOT a.attisdropped
  ),
  actual_defaults AS (
    SELECT table_name,attname,default_expression
    FROM actual_columns WHERE default_expression<>''
  ),
  actual_keys AS (
    SELECT relation.name table_name,constraint_row.conname,constraint_row.contype,
      ARRAY(
        SELECT attribute.attname
        FROM unnest(constraint_row.conkey) WITH ORDINALITY key_column(attnum,ordinal)
        JOIN pg_attribute attribute
          ON attribute.attrelid=constraint_row.conrelid
         AND attribute.attnum=key_column.attnum
        ORDER BY key_column.ordinal
      ) column_names,
      constraint_row.convalidated,constraint_row.condeferrable,
      constraint_row.condeferred,pg_get_constraintdef(constraint_row.oid,true) definition
    FROM relations relation
    JOIN pg_constraint constraint_row ON constraint_row.conrelid=relation.oid
    WHERE constraint_row.contype IN('p','u')
  ),
  actual_fks AS (
    SELECT relation.name table_name,constraint_row.conname,
      ARRAY(
        SELECT attribute.attname
        FROM unnest(constraint_row.conkey) WITH ORDINALITY key_column(attnum,ordinal)
        JOIN pg_attribute attribute
          ON attribute.attrelid=constraint_row.conrelid
         AND attribute.attnum=key_column.attnum
        ORDER BY key_column.ordinal
      ) column_names,
      foreign_relation.relname foreign_table,
      ARRAY(
        SELECT attribute.attname
        FROM unnest(constraint_row.confkey) WITH ORDINALITY key_column(attnum,ordinal)
        JOIN pg_attribute attribute
          ON attribute.attrelid=constraint_row.confrelid
         AND attribute.attnum=key_column.attnum
        ORDER BY key_column.ordinal
      ) foreign_column_names,
      constraint_row.convalidated,constraint_row.confupdtype,
      constraint_row.confdeltype,constraint_row.confmatchtype,
      constraint_row.condeferrable,constraint_row.condeferred,
      pg_get_constraintdef(constraint_row.oid,true) definition
    FROM relations relation
    JOIN pg_constraint constraint_row ON constraint_row.conrelid=relation.oid
    JOIN pg_class foreign_relation ON foreign_relation.oid=constraint_row.confrelid
    WHERE constraint_row.contype='f'
  ),
  actual_checks AS (
    SELECT relation.name table_name,constraint_row.conname,
      constraint_row.convalidated,
      pg_get_constraintdef(constraint_row.oid,true) definition
    FROM relations relation
    JOIN pg_constraint constraint_row ON constraint_row.conrelid=relation.oid
    WHERE constraint_row.contype='c'
  ),
  actual_indexes AS (
    SELECT relation.name table_name,index_relation.relname index_name,
      index_row.indisunique,index_row.indisvalid,index_row.indisready,
      index_row.indnkeyatts,index_row.indnatts,
      pg_get_indexdef(index_row.indexrelid) definition
    FROM relations relation
    JOIN pg_index index_row ON index_row.indrelid=relation.oid
    JOIN pg_class index_relation ON index_relation.oid=index_row.indexrelid
    WHERE NOT EXISTS(
      SELECT 1 FROM pg_constraint constraint_row
      WHERE constraint_row.conindid=index_row.indexrelid
    )
  ),
  actual_triggers AS (
    SELECT relation.name table_name,trigger_row.tgname,trigger_row.tgtype,
      trigger_row.tgenabled,
      format('%I.%I(%s)',function_namespace.nspname,function_row.proname,
        replace(oidvectortypes(function_row.proargtypes),', ',','))
        function_signature,
      pg_get_triggerdef(trigger_row.oid,true) definition
    FROM relations relation
    JOIN pg_trigger trigger_row ON trigger_row.tgrelid=relation.oid
    JOIN pg_proc function_row ON function_row.oid=trigger_row.tgfoid
    JOIN pg_namespace function_namespace
      ON function_namespace.oid=function_row.pronamespace
    WHERE NOT trigger_row.tgisinternal
  ),
  actual_policies AS (
    SELECT relation.name table_name,policy.polname,policy.polcmd,policy.polpermissive,
      ARRAY(
        SELECT CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END
        FROM unnest(policy.polroles) role_oid ORDER BY 1
      ) role_names,
      coalesce(pg_get_expr(policy.polqual,policy.polrelid),'') qual,
      coalesce(pg_get_expr(policy.polwithcheck,policy.polrelid),'') with_check
    FROM relations relation
    JOIN pg_policy policy ON policy.polrelid=relation.oid
  ),
  actual_table_acl AS (
    SELECT relation.name table_name,
      CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END role_name,
      acl.privilege_type,acl.is_grantable
    FROM relations relation
    CROSS JOIN LATERAL aclexplode(relation.relacl) acl
    WHERE acl.grantee<>relation.relowner
  ),
  actual_column_acl AS (
    SELECT relation.name table_name,attribute.attname,
      CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END role_name,
      acl.privilege_type,acl.is_grantable
    FROM relations relation
    JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
    CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
    WHERE attribute.attnum>0 AND NOT attribute.attisdropped
  ),
  actual_function_inventory AS (
    SELECT format('%I.%I(%s)',namespace.nspname,procedure_row.proname,
        replace(oidvectortypes(procedure_row.proargtypes),', ',','))
        signature,
      procedure_row.oid,
      procedure_row.proowner,procedure_row.prokind,procedure_row.prosecdef,
      procedure_row.provolatile,procedure_row.proisstrict,procedure_row.proparallel,
      procedure_row.proconfig,
      encode(sha256(convert_to(procedure_row.prosrc,'UTF8')),'hex') body_hash,
      pg_get_functiondef(procedure_row.oid) definition,procedure_row.proacl
    FROM pg_proc procedure_row
    JOIN pg_namespace namespace ON namespace.oid=procedure_row.pronamespace
    WHERE namespace.nspname='public' AND (
      procedure_row.proname LIKE 'syntholo_commerce%'
      OR procedure_row.proname IN(
        'syntholo_provider_event_receipts_stripe_immutable_v1',
        'syntholo_record_public_business_os_setup_reconciliation',
        'syntholo_cleanup_public_bos_intents_v1'
      )
    )
  ),
  actual_function_acl AS (
    SELECT function_row.signature,
      CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END role_name,
      acl.privilege_type,acl.is_grantable
    FROM actual_function_inventory function_row
    CROSS JOIN LATERAL aclexplode(function_row.proacl) acl
    WHERE acl.grantee<>function_row.proowner
  ),
  structure_fingerprint AS (
    SELECT encode(sha256(convert_to(jsonb_build_object(
      'columns',(SELECT coalesce(jsonb_agg(to_jsonb(row_value) ORDER BY table_name,attnum),'[]'::jsonb) FROM actual_columns row_value),
      'defaults',(SELECT coalesce(jsonb_agg(to_jsonb(row_value) ORDER BY table_name,attname),'[]'::jsonb) FROM actual_defaults row_value),
      'keys',(SELECT coalesce(jsonb_agg(to_jsonb(row_value) ORDER BY table_name,conname),'[]'::jsonb) FROM actual_keys row_value),
      'fks',(SELECT coalesce(jsonb_agg(to_jsonb(row_value) ORDER BY table_name,conname),'[]'::jsonb) FROM actual_fks row_value),
      'checks',(SELECT coalesce(jsonb_agg(to_jsonb(row_value) ORDER BY table_name,conname),'[]'::jsonb) FROM actual_checks row_value),
      'indexes',(SELECT coalesce(jsonb_agg(to_jsonb(row_value) ORDER BY table_name,index_name),'[]'::jsonb) FROM actual_indexes row_value)
    )::text,'UTF8')),'hex') value
  ),
  trigger_fingerprint AS (
    SELECT encode(sha256(convert_to(coalesce(
      jsonb_agg(to_jsonb(row_value) ORDER BY table_name,tgname),'[]'::jsonb
    )::text,'UTF8')),'hex') value FROM actual_triggers row_value
  ),
  policy_fingerprint AS (
    SELECT encode(sha256(convert_to(coalesce(
      jsonb_agg(to_jsonb(row_value) ORDER BY table_name,polname),'[]'::jsonb
    )::text,'UTF8')),'hex') value FROM actual_policies row_value
  ),
  table_acl_fingerprint AS (
    SELECT encode(sha256(convert_to(jsonb_build_object(
      'table',(SELECT coalesce(jsonb_agg(to_jsonb(row_value) ORDER BY table_name,role_name,privilege_type),'[]'::jsonb) FROM actual_table_acl row_value),
      'column',(SELECT coalesce(jsonb_agg(to_jsonb(row_value) ORDER BY table_name,attname,role_name,privilege_type),'[]'::jsonb) FROM actual_column_acl row_value)
    )::text,'UTF8')),'hex') value
  ),
  function_fingerprint AS (
    SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object(
      'signature',signature,'ownerMatches',proowner=(SELECT proowner FROM owner),
      'kind',prokind,'securityDefiner',prosecdef,
      'volatility',provolatile,'strict',proisstrict,'parallel',proparallel,
      'config',proconfig,'bodyHash',body_hash
    ) ORDER BY signature),'[]'::jsonb)::text,'UTF8')),'hex') value
    FROM actual_function_inventory
    WHERE signature<>'public.syntholo_commerce_catalog_readiness_v1()'
  ),
  function_acl_fingerprint AS (
    SELECT encode(sha256(convert_to(coalesce(
      jsonb_agg(to_jsonb(row_value) ORDER BY signature,role_name,privilege_type),'[]'::jsonb
    )::text,'UTF8')),'hex') value FROM actual_function_acl row_value
  ),
  cleanup AS (
    SELECT * FROM actual_function_inventory
    WHERE signature='public.syntholo_cleanup_public_bos_intents_v1(uuid,text,integer,integer,uuid,uuid,integer,integer,uuid,integer)'
  ),
  expected_offers(
    id,code,family,purchase_model,state,display_currency,display_unit_amount,
    display_recurring_unit_amount,readiness_policy,current_catalog_version_id
  ) AS (VALUES
    ('00000000-0000-4000-8000-000000001401'::uuid,'scorecard','scorecard',
      'free','paused','usd',0,NULL::integer,'scorecard.v1',NULL::uuid),
    ('00000000-0000-4000-8000-000000001402'::uuid,'self_paced','academy',
      'one_time','paused','usd',39900,NULL::integer,'academy-content.v1',NULL::uuid),
    ('00000000-0000-4000-8000-000000001403'::uuid,'guided_pilot','academy',
      'one_time','paused','usd',75000,NULL::integer,'pilot-authorization.v1',NULL::uuid),
    ('00000000-0000-4000-8000-000000001404'::uuid,'operator_club_monthly',
      'operator_club','recurring','paused','usd',5900,NULL::integer,
      'academy-eligibility.v1',NULL::uuid),
    ('00000000-0000-4000-8000-000000001405'::uuid,'operator_club_annual',
      'operator_club','recurring','paused','usd',59000,NULL::integer,
      'academy-eligibility.v1',NULL::uuid),
    ('00000000-0000-4000-8000-000000001406'::uuid,'business_os','business_os',
      'two_stage','paused','usd',99900,19900,'business-os-readiness.v1',NULL::uuid)
  ),
  actual_offers AS (
    SELECT id,code,family,purchase_model,state,display_currency,
      display_unit_amount,display_recurring_unit_amount,readiness_policy,
      current_catalog_version_id
    FROM public.offers
  ),
  content_state AS (SELECT * FROM public.syntholo_content_readiness_v1()),
  implementation_state AS (SELECT * FROM public.syntholo_implementation_readiness_v1()),
  certificate_state AS (SELECT * FROM public.syntholo_certificates_readiness_v1()),
  upstream_readiness_functions(signature,body_hash) AS (VALUES
    ('public.syntholo_content_readiness_v1()',
      '8d8fc5d049c5489c221a768655301e44f4a01873b92a70cfa14466d3f3f81534'),
    ('public.syntholo_implementation_readiness_v1()',
      '468276c0e37e2be0f65185cddbbf40003b484836cafb5d990225793cd3076eda'),
    ('public.syntholo_certificates_readiness_v1()',
      '93e28ef4527ae3a3e46a62dcd08ca67eb4ff7adfc61455f419e5a92e0c9e5ba8')
  ),
  actual_upstream_readiness_functions AS (
    SELECT required.signature,required.body_hash expected_body_hash,
      procedure_row.oid,procedure_row.proowner,procedure_row.prokind,
      procedure_row.prosecdef,procedure_row.provolatile,
      procedure_row.proisstrict,procedure_row.proparallel,procedure_row.proconfig,
      encode(sha256(convert_to(procedure_row.prosrc,'UTF8')),'hex') actual_body_hash
    FROM upstream_readiness_functions required
    LEFT JOIN pg_proc procedure_row
      ON procedure_row.oid=to_regprocedure(required.signature)
  ),
  migration AS (
    SELECT max(created_at) created_at,max(hash) hash
    FROM drizzle.__drizzle_migrations WHERE created_at=1787029200000
  )
  SELECT
    '0014_commerce_catalog.v1',migration.created_at,migration.hash,
    'dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9',
    '878a759f41c44e0cbb9cf7492889bdf4d6f0ab087f0e9d7b26865f988fbe1bd9',
    false,
    (SELECT count(*)=27 AND bool_and(
      oid IS NOT NULL AND relkind='r' AND relpersistence='p'
      AND relowner=(SELECT proowner FROM owner)
    ) FROM relations),
    (SELECT value='ad97c05cfd8b8e2da397f32d01d9810718aa6413aa96424deb40e3d6cc65d95d' FROM structure_fingerprint),
    (SELECT value='cc1799b8504f5e3c058684eb29ebd80671888ecb08eff612e103aba369ab8f66' FROM trigger_fingerprint),
    (SELECT count(*)=27 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM relations),
    (SELECT value='3d701bdfccd6b57d202c3f4956dacbf2091f005100fb6147cde1384d8dacd746' FROM policy_fingerprint),
    (SELECT value='826287df3e010c4d15e54e879838e346c64fdcbdb8d88bff057969f279e52ae9' FROM table_acl_fingerprint),
    (SELECT value='5acf41a828b2551bc2fdb21c9bb7e5982a4eaaf649e3764a27784eabcd9b2ce6' FROM function_fingerprint),
    (SELECT value='108638db1b329c1bd029b796c008a3217eaa269703a69dd6a6be40b6a46f14a6' FROM function_acl_fingerprint),
    NOT EXISTS(
      SELECT 1 FROM actual_function_acl
      WHERE role_name='PUBLIC' AND privilege_type='EXECUTE'
    ),
    (
      SELECT learning_migration_hash='2e37ec9d4bfeee1ad0319ae81172fac4107a87c798bd2f0eed79eb75ee0e2ccf'
        AND learning_table_ready AND learning_structure_ready
        AND learning_immutability_ready AND learning_rls_ready
        AND learning_acl_ready AND learning_function_ready
        AND learning_public_execute_denied
      FROM content_state
     ) AND (
      SELECT migration_hash='dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9'
        AND table_ready AND structure_ready AND immutability_ready AND rls_ready
        AND policy_ready AND table_acl_ready AND function_ready
        AND function_acl_ready AND public_execute_denied
        AND receipt_binding_ready AND upstream_fk_ready AND seed_backfill_ready
      FROM implementation_state
    ) AND (
      SELECT migration_hash='878a759f41c44e0cbb9cf7492889bdf4d6f0ab087f0e9d7b26865f988fbe1bd9'
        AND implementation_migration_hash='dabb54d9842c3e06c67e1ef5b17f42312011ffb133275b4dd346afd2465939a9'
        AND implementation_completion_is_authority=false
        AND table_ready AND structure_ready AND immutability_ready AND rls_ready
        AND policy_ready AND table_acl_ready AND function_ready
        AND function_acl_ready AND public_execute_denied
        AND receipt_binding_ready AND upstream_ready AND independence_ready
       FROM certificate_state
     ) AND (SELECT ready FROM receipt_root_authority)
       AND (SELECT count(*)=3 AND bool_and(
         oid IS NOT NULL AND proowner=(SELECT proowner FROM owner)
         AND prokind='f' AND prosecdef AND provolatile='s'
         AND NOT proisstrict AND proparallel='u'
         AND proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
         AND actual_body_hash=expected_body_hash
       ) FROM actual_upstream_readiness_functions),
    NOT EXISTS(
      (SELECT * FROM expected_offers EXCEPT SELECT * FROM actual_offers)
      UNION ALL
      (SELECT * FROM actual_offers EXCEPT SELECT * FROM expected_offers)
    )
      AND NOT EXISTS(SELECT 1 FROM public.offer_catalog_versions)
      AND NOT EXISTS(SELECT 1 FROM public.offer_price_bindings),
    (SELECT count(*)=1 AND bool_and(
      prosecdef AND provolatile='v' AND NOT proisstrict AND proparallel='u'
      AND proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND body_hash='fbe3c7e935d8514a8d6bf2cc3e30234f63055a5dbd65d8b3f7791ef3c76efce8'
      AND NOT has_function_privilege('syntholo_migrator',oid,'EXECUTE')
      AND NOT has_function_privilege('syntholo_member_api',oid,'EXECUTE')
      AND NOT has_function_privilege('syntholo_staff_api',oid,'EXECUTE')
      AND NOT has_function_privilege('syntholo_worker',oid,'EXECUTE')
      AND NOT has_function_privilege('syntholo_system_api',oid,'EXECUTE')
      AND position('COMMERCE_CLEANUP_NOT_ACTIVE' in definition)>0
    ) FROM cleanup),
    NOT EXISTS(
      SELECT 1 FROM actual_fks WHERE foreign_table LIKE 'certificate_%'
    ) AND NOT EXISTS(
      SELECT 1 FROM actual_function_inventory
      WHERE signature<>'public.syntholo_commerce_catalog_readiness_v1()'
        AND definition~'certificate_(records|files|delivery|recipient)'
    )
  FROM migration
  WHERE migration.created_at IS NOT NULL AND migration.hash IS NOT NULL
$readiness$;
REVOKE ALL ON FUNCTION public.syntholo_commerce_catalog_readiness_v1()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_commerce_catalog_readiness_v1()
TO syntholo_migrator,syntholo_member_api,syntholo_staff_api,
  syntholo_worker,syntholo_system_api;
