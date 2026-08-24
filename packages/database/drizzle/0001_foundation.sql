CREATE TABLE "accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "accounts_status_check"
    CHECK ("status" IN ('active', 'suspended', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "member_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "provider_user_id" text NOT NULL,
  "email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "member_identities_provider_user_unique"
    UNIQUE ("provider", "provider_user_id"),
  CONSTRAINT "member_identities_id_account_unique"
    UNIQUE ("id", "account_id"),
  CONSTRAINT "member_identities_account_id_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE TABLE "memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "member_identity_id" uuid NOT NULL,
  "role" text DEFAULT 'teammate' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "memberships_account_member_unique"
    UNIQUE ("account_id", "member_identity_id"),
  CONSTRAINT "memberships_role_check"
    CHECK ("role" IN ('owner', 'teammate')),
  CONSTRAINT "memberships_status_check"
    CHECK ("status" IN ('pending', 'active', 'revoked')),
  CONSTRAINT "memberships_account_id_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "memberships_identity_account_fk"
    FOREIGN KEY ("member_identity_id", "account_id")
    REFERENCES "member_identities"("id", "account_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE TABLE "staff_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text DEFAULT 'access' NOT NULL,
  "provider_user_id" text NOT NULL,
  "email" text,
  "display_name" text,
  "role" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "permissions" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "staff_identities_provider_user_unique"
    UNIQUE ("provider", "provider_user_id"),
  CONSTRAINT "staff_identities_role_check"
    CHECK ("role" IN ('coach', 'admin')),
  CONSTRAINT "staff_identities_status_check"
    CHECK ("status" IN ('active', 'suspended', 'disabled')),
  CONSTRAINT "staff_identities_permissions_no_nulls_check"
    CHECK (array_position("permissions", NULL) IS NULL)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid,
  "actor_type" text NOT NULL,
  "actor_id" text,
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text,
  "correlation_id" uuid,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audit_events_actor_type_check"
    CHECK ("actor_type" IN ('member', 'staff', 'system')),
  CONSTRAINT "audit_events_payload_object_check"
    CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "audit_events_account_id_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid,
  "type" text NOT NULL,
  "aggregate_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "claimed_at" timestamp with time zone,
  "published_at" timestamp with time zone,
  "last_error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "outbox_events_schema_version_check"
    CHECK ("schema_version" > 0),
  CONSTRAINT "outbox_events_status_check"
    CHECK ("status" IN ('pending', 'processing', 'published', 'dead_letter')),
  CONSTRAINT "outbox_events_attempts_check"
    CHECK ("attempts" >= 0),
  CONSTRAINT "outbox_events_payload_object_check"
    CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "outbox_events_account_id_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE TABLE "jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid,
  "queue" text DEFAULT 'default' NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "run_at" timestamp with time zone DEFAULT now() NOT NULL,
  "claimed_at" timestamp with time zone,
  "worker_id" text,
  "completed_at" timestamp with time zone,
  "last_error_code" text,
  "last_error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "jobs_status_check"
    CHECK ("status" IN ('queued', 'running', 'completed', 'dead_letter')),
  CONSTRAINT "jobs_attempts_check"
    CHECK ("attempts" >= 0),
  CONSTRAINT "jobs_max_attempts_check"
    CHECK ("max_attempts" > 0 AND "attempts" <= "max_attempts"),
  CONSTRAINT "jobs_payload_object_check"
    CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "jobs_account_id_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE TABLE "provider_event_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "status" text DEFAULT 'received' NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone,
  "last_error_code" text,
  CONSTRAINT "provider_event_receipts_provider_event_unique"
    UNIQUE ("provider", "provider_event_id"),
  CONSTRAINT "provider_event_receipts_status_check"
    CHECK ("status" IN ('received', 'processing', 'processed', 'failed')),
  CONSTRAINT "provider_event_receipts_payload_object_check"
    CHECK (jsonb_typeof("payload") = 'object')
);
--> statement-breakpoint
CREATE INDEX "member_identities_account_id_idx"
  ON "member_identities" ("account_id");
--> statement-breakpoint
CREATE INDEX "memberships_account_status_idx"
  ON "memberships" ("account_id", "status");
--> statement-breakpoint
CREATE INDEX "audit_events_account_occurred_idx"
  ON "audit_events" ("account_id", "occurred_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "outbox_events_claim_idx"
  ON "outbox_events" ("available_at", "created_at", "id")
  WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX "jobs_claim_idx"
  ON "jobs" ("priority" DESC NULLS LAST, "run_at", "id")
  WHERE "status" = 'queued';
--> statement-breakpoint
CREATE INDEX "provider_event_receipts_status_received_idx"
  ON "provider_event_receipts" ("status", "received_at");
--> statement-breakpoint
CREATE FUNCTION "prevent_account_id_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'account_id is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "member_identities_account_id_immutable"
  BEFORE UPDATE OF "account_id" ON "member_identities"
  FOR EACH ROW EXECUTE FUNCTION "prevent_account_id_update"();
--> statement-breakpoint
CREATE TRIGGER "memberships_account_id_immutable"
  BEFORE UPDATE OF "account_id" ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION "prevent_account_id_update"();
--> statement-breakpoint
CREATE TRIGGER "audit_events_account_id_immutable"
  BEFORE UPDATE OF "account_id" ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "prevent_account_id_update"();
--> statement-breakpoint
CREATE TRIGGER "outbox_events_account_id_immutable"
  BEFORE UPDATE OF "account_id" ON "outbox_events"
  FOR EACH ROW EXECUTE FUNCTION "prevent_account_id_update"();
--> statement-breakpoint
CREATE TRIGGER "jobs_account_id_immutable"
  BEFORE UPDATE OF "account_id" ON "jobs"
  FOR EACH ROW EXECUTE FUNCTION "prevent_account_id_update"();
