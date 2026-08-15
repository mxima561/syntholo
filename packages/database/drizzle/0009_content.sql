CREATE TABLE public.courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (octet_length(slug) BETWEEN 1 AND 100 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text NOT NULL CHECK (octet_length(title) BETWEEN 1 AND 255),
  description text NOT NULL CHECK (octet_length(description) BETWEEN 1 AND 10000),
  current_draft_revision integer NOT NULL DEFAULT 1 CHECK (current_draft_revision >= 1),
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp())
);
--> statement-breakpoint
CREATE TABLE public.course_drafts (
  course_id uuid PRIMARY KEY REFERENCES public.courses(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  revision integer NOT NULL CHECK (revision >= 1),
  title text NOT NULL CHECK (octet_length(title) BETWEEN 1 AND 255),
  description text NOT NULL CHECK (octet_length(description) BETWEEN 1 AND 10000),
  updated_by_staff_id uuid NOT NULL REFERENCES public.staff_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE TABLE public.stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  slug text NOT NULL CHECK (octet_length(slug) BETWEEN 1 AND 100 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  CONSTRAINT stages_course_slug_unique UNIQUE(course_id,slug),
  CONSTRAINT stages_id_course_unique UNIQUE(id,course_id)
);
--> statement-breakpoint
CREATE TABLE public.stage_drafts (
  stage_id uuid PRIMARY KEY,
  course_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  title text NOT NULL CHECK (octet_length(title) BETWEEN 1 AND 255),
  description text NOT NULL CHECK (octet_length(description) BETWEEN 1 AND 10000),
  "order" integer NOT NULL CHECK ("order" >= 1),
  updated_by_staff_id uuid NOT NULL REFERENCES public.staff_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  CONSTRAINT stage_drafts_stage_course_fk FOREIGN KEY(stage_id,course_id) REFERENCES public.stages(id,course_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT stage_drafts_course_order_unique UNIQUE(course_id,"order") DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE TABLE public.lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  stage_id uuid NOT NULL,
  slug text NOT NULL CHECK (octet_length(slug) BETWEEN 1 AND 100 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  CONSTRAINT lessons_stage_course_fk FOREIGN KEY(stage_id,course_id) REFERENCES public.stages(id,course_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT lessons_course_slug_unique UNIQUE(course_id,slug),
  CONSTRAINT lessons_id_course_unique UNIQUE(id,course_id)
);
--> statement-breakpoint
CREATE TABLE public.lesson_drafts (
  lesson_id uuid PRIMARY KEY,
  course_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  title text NOT NULL CHECK (octet_length(title) BETWEEN 1 AND 255),
  summary text NOT NULL DEFAULT '' CHECK (octet_length(summary) <= 10000),
  duration_seconds integer CHECK (duration_seconds BETWEEN 1 AND 86400),
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocks)='array' AND octet_length(blocks::text)<=262144),
  transcript jsonb NOT NULL DEFAULT '{"schemaVersion":1,"blocks":[]}'::jsonb CHECK (jsonb_typeof(transcript)='object' AND octet_length(transcript::text)<=1048576),
  media_asset_id uuid,
  stage_order integer NOT NULL CHECK (stage_order >= 1),
  "order" integer NOT NULL CHECK ("order" >= 1),
  required boolean NOT NULL DEFAULT true,
  release_rule jsonb NOT NULL DEFAULT '{"kind":"immediate"}'::jsonb,
  placeholder_detected boolean NOT NULL DEFAULT false,
  updated_by_staff_id uuid NOT NULL REFERENCES public.staff_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  CONSTRAINT lesson_drafts_lesson_course_fk FOREIGN KEY(lesson_id,course_id) REFERENCES public.lessons(id,course_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT lesson_drafts_stage_course_fk FOREIGN KEY(stage_id,course_id) REFERENCES public.stages(id,course_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT lesson_drafts_course_stage_order_unique UNIQUE(course_id,stage_id,"order") DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT lesson_drafts_release_rule_check CHECK (CASE
    WHEN release_rule = '{"kind":"immediate"}'::jsonb THEN true
    WHEN jsonb_typeof(release_rule)='object' AND release_rule - ARRAY['kind','days']::text[] = '{}'::jsonb AND release_rule->>'kind'='elapsed_days' AND jsonb_typeof(release_rule->'days')='number' AND release_rule->>'days' ~ '^(0|[1-9][0-9]{0,2})$' THEN (release_rule->>'days')::integer BETWEEN 0 AND 365
    WHEN jsonb_typeof(release_rule)='object' AND release_rule - ARRAY['kind','at']::text[] = '{}'::jsonb AND release_rule->>'kind'='fixed_at' AND jsonb_typeof(release_rule->'at')='string' AND release_rule->>'at' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$' THEN isfinite((release_rule->>'at')::timestamptz) AND to_char((release_rule->>'at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=release_rule->>'at'
    ELSE false END)
);
--> statement-breakpoint
CREATE TABLE public.lesson_accessibility_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lesson_id uuid NOT NULL REFERENCES public.lessons(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  draft_revision integer NOT NULL CHECK (draft_revision >= 1), draft_hash text NOT NULL CHECK (draft_hash ~ '^[0-9a-f]{64}$'), decision_sequence integer NOT NULL CHECK(decision_sequence>0),
  decision text NOT NULL CHECK(decision IN ('approved','rejected')), reviewer_staff_id uuid NOT NULL REFERENCES public.staff_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  reason text NOT NULL CHECK(octet_length(reason) BETWEEN 1 AND 1000), decided_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT lesson_accessibility_decisions_id_lesson_sequence_unique UNIQUE(id,lesson_id,decision_sequence), CONSTRAINT lesson_accessibility_decisions_lesson_sequence_unique UNIQUE(lesson_id,decision_sequence)
);
--> statement-breakpoint
CREATE TABLE public.lesson_accessibility_review_heads (
  lesson_id uuid PRIMARY KEY REFERENCES public.lessons(id) ON DELETE RESTRICT ON UPDATE RESTRICT, decision_sequence integer NOT NULL DEFAULT 0,
  current_decision_id uuid, current_draft_revision integer, current_draft_hash text, updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT lesson_accessibility_heads_decision_fk FOREIGN KEY(current_decision_id,lesson_id,decision_sequence) REFERENCES public.lesson_accessibility_decisions(id,lesson_id,decision_sequence) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ((decision_sequence=0 AND current_decision_id IS NULL AND current_draft_revision IS NULL AND current_draft_hash IS NULL) OR (decision_sequence>0 AND current_decision_id IS NOT NULL AND current_draft_revision IS NOT NULL AND current_draft_hash ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE public.lesson_disclosure_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lesson_id uuid NOT NULL REFERENCES public.lessons(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  draft_revision integer NOT NULL CHECK(draft_revision>=1), draft_hash text NOT NULL CHECK(draft_hash ~ '^[0-9a-f]{64}$'), decision_sequence integer NOT NULL CHECK(decision_sequence>0),
  decision text NOT NULL CHECK(decision IN ('applicable','not_applicable')), policy_version text NOT NULL CHECK(octet_length(policy_version) BETWEEN 1 AND 64), reviewer_staff_id uuid NOT NULL REFERENCES public.staff_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  reason text NOT NULL CHECK(octet_length(reason) BETWEEN 1 AND 1000), decided_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT lesson_disclosure_decisions_id_lesson_sequence_unique UNIQUE(id,lesson_id,decision_sequence), CONSTRAINT lesson_disclosure_decisions_lesson_sequence_unique UNIQUE(lesson_id,decision_sequence)
);
--> statement-breakpoint
CREATE TABLE public.lesson_disclosure_review_heads (
  lesson_id uuid PRIMARY KEY REFERENCES public.lessons(id) ON DELETE RESTRICT ON UPDATE RESTRICT, decision_sequence integer NOT NULL DEFAULT 0,
  current_decision_id uuid, current_draft_revision integer, current_draft_hash text, updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT lesson_disclosure_heads_decision_fk FOREIGN KEY(current_decision_id,lesson_id,decision_sequence) REFERENCES public.lesson_disclosure_decisions(id,lesson_id,decision_sequence) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ((decision_sequence=0 AND current_decision_id IS NULL AND current_draft_revision IS NULL AND current_draft_hash IS NULL) OR (decision_sequence>0 AND current_decision_id IS NOT NULL AND current_draft_revision IS NOT NULL AND current_draft_hash ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE public.lesson_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lesson_id uuid NOT NULL, course_id uuid NOT NULL, stage_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>=1), title text NOT NULL, summary text NOT NULL, duration_seconds integer NOT NULL CHECK(duration_seconds BETWEEN 300 AND 720),
  blocks jsonb NOT NULL CHECK(jsonb_typeof(blocks)='array'), transcript jsonb NOT NULL CHECK(jsonb_typeof(transcript)='object'), media_asset_id uuid,
  stage_order integer NOT NULL CHECK(stage_order>=1), "order" integer NOT NULL CHECK("order">=1), required boolean NOT NULL, release_rule jsonb NOT NULL,
  accessibility_decision_id uuid NOT NULL, accessibility_decision_sequence integer NOT NULL, disclosure_decision_id uuid NOT NULL, disclosure_decision_sequence integer NOT NULL,
  content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'), published_by_staff_id uuid NOT NULL REFERENCES public.staff_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  publish_reason text NOT NULL CHECK(octet_length(publish_reason) BETWEEN 1 AND 1000), published_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT lesson_versions_lesson_course_fk FOREIGN KEY(lesson_id,course_id) REFERENCES public.lessons(id,course_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT lesson_versions_accessibility_decision_fk FOREIGN KEY(accessibility_decision_id,lesson_id,accessibility_decision_sequence) REFERENCES public.lesson_accessibility_decisions(id,lesson_id,decision_sequence) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT lesson_versions_disclosure_decision_fk FOREIGN KEY(disclosure_decision_id,lesson_id,disclosure_decision_sequence) REFERENCES public.lesson_disclosure_decisions(id,lesson_id,decision_sequence) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT lesson_versions_lesson_version_unique UNIQUE(lesson_id,version), CONSTRAINT lesson_versions_id_lesson_course_unique UNIQUE(id,lesson_id,course_id),
  CONSTRAINT lesson_versions_release_rule_check CHECK (CASE
    WHEN release_rule = '{"kind":"immediate"}'::jsonb THEN true
    WHEN jsonb_typeof(release_rule)='object' AND release_rule - ARRAY['kind','days']::text[] = '{}'::jsonb AND release_rule->>'kind'='elapsed_days' AND jsonb_typeof(release_rule->'days')='number' AND release_rule->>'days' ~ '^(0|[1-9][0-9]{0,2})$' THEN (release_rule->>'days')::integer BETWEEN 0 AND 365
    WHEN jsonb_typeof(release_rule)='object' AND release_rule - ARRAY['kind','at']::text[] = '{}'::jsonb AND release_rule->>'kind'='fixed_at' AND jsonb_typeof(release_rule->'at')='string' AND release_rule->>'at' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$' THEN isfinite((release_rule->>'at')::timestamptz) AND to_char((release_rule->>'at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=release_rule->>'at'
    ELSE false END)
);
--> statement-breakpoint
CREATE TABLE public.course_draft_manifest_entries (
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE RESTRICT ON UPDATE RESTRICT, course_draft_revision integer NOT NULL CHECK(course_draft_revision>=1),
  stage_id uuid NOT NULL, stage_order integer NOT NULL CHECK(stage_order>=1), lesson_id uuid NOT NULL, lesson_order integer NOT NULL CHECK(lesson_order>=1), required boolean NOT NULL, release_rule jsonb NOT NULL,
  selected_lesson_draft_revision integer, selected_lesson_draft_hash text, selected_lesson_version_id uuid, selected_lesson_version_hash text, readiness_revision integer NOT NULL DEFAULT 0 CHECK(readiness_revision>=0),
  PRIMARY KEY(course_id,course_draft_revision,lesson_id), CONSTRAINT course_draft_manifest_order_unique UNIQUE(course_id,course_draft_revision,lesson_order),
  CONSTRAINT course_draft_manifest_lesson_version_fk FOREIGN KEY(selected_lesson_version_id,lesson_id,course_id) REFERENCES public.lesson_versions(id,lesson_id,course_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ((selected_lesson_draft_revision IS NOT NULL AND selected_lesson_draft_hash ~ '^[0-9a-f]{64}$' AND selected_lesson_version_id IS NULL AND selected_lesson_version_hash IS NULL) OR (selected_lesson_draft_revision IS NULL AND selected_lesson_draft_hash IS NULL AND selected_lesson_version_id IS NOT NULL AND selected_lesson_version_hash ~ '^[0-9a-f]{64}$')),
  CONSTRAINT course_draft_manifest_release_rule_check CHECK (CASE
    WHEN release_rule = '{"kind":"immediate"}'::jsonb THEN true
    WHEN jsonb_typeof(release_rule)='object' AND release_rule - ARRAY['kind','days']::text[] = '{}'::jsonb AND release_rule->>'kind'='elapsed_days' AND jsonb_typeof(release_rule->'days')='number' AND release_rule->>'days' ~ '^(0|[1-9][0-9]{0,2})$' THEN (release_rule->>'days')::integer BETWEEN 0 AND 365
    WHEN jsonb_typeof(release_rule)='object' AND release_rule - ARRAY['kind','at']::text[] = '{}'::jsonb AND release_rule->>'kind'='fixed_at' AND jsonb_typeof(release_rule->'at')='string' AND release_rule->>'at' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$' THEN isfinite((release_rule->>'at')::timestamptz) AND to_char((release_rule->>'at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=release_rule->>'at'
    ELSE false END)
);
--> statement-breakpoint
CREATE TABLE public.content_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE RESTRICT ON UPDATE RESTRICT, draft_revision integer NOT NULL CHECK(draft_revision>=1),
  manifest_canonical_json text NOT NULL CHECK(octet_length(manifest_canonical_json) BETWEEN 2 AND 1048576), manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[0-9a-f]{64}$'),
  manifest_projection jsonb NOT NULL CHECK(jsonb_typeof(manifest_projection)='object'), publication_issues jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(publication_issues)='array'),
  created_by_staff_id uuid NOT NULL REFERENCES public.staff_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT, reason text NOT NULL CHECK(octet_length(reason) BETWEEN 1 AND 1000), created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT content_previews_id_course_hash_unique UNIQUE(id,course_id,manifest_hash),
  CHECK (manifest_canonical_json::jsonb = manifest_projection), CHECK (manifest_hash = encode(sha256(convert_to(manifest_canonical_json,'UTF8')),'hex'))
);
--> statement-breakpoint
CREATE TABLE public.course_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE RESTRICT ON UPDATE RESTRICT, version integer NOT NULL CHECK(version>=1),
  title text NOT NULL, description text NOT NULL, manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[0-9a-f]{64}$'), source_preview_id uuid NOT NULL,
  published_by_staff_id uuid NOT NULL REFERENCES public.staff_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT, publish_reason text NOT NULL, published_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT course_versions_source_preview_fk FOREIGN KEY(source_preview_id,course_id,manifest_hash) REFERENCES public.content_previews(id,course_id,manifest_hash) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT course_versions_course_version_unique UNIQUE(course_id,version), CONSTRAINT course_versions_id_course_hash_unique UNIQUE(id,course_id,manifest_hash), CONSTRAINT course_versions_id_course_unique UNIQUE(id,course_id)
);
--> statement-breakpoint
CREATE TABLE public.course_version_lessons (
  course_version_id uuid NOT NULL, course_id uuid NOT NULL, lesson_id uuid NOT NULL, lesson_version_id uuid NOT NULL, stage_id uuid NOT NULL,
  stage_title text NOT NULL, stage_order integer NOT NULL CHECK(stage_order>=1), lesson_order integer NOT NULL CHECK(lesson_order>=1), required boolean NOT NULL, release_rule jsonb NOT NULL,
  PRIMARY KEY(course_version_id,lesson_id), CONSTRAINT course_version_lessons_course_version_fk FOREIGN KEY(course_version_id,course_id) REFERENCES public.course_versions(id,course_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT course_version_lessons_lesson_version_fk FOREIGN KEY(lesson_version_id,lesson_id,course_id) REFERENCES public.lesson_versions(id,lesson_id,course_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT course_version_lessons_exact_membership_unique UNIQUE(course_version_id,course_id,lesson_id,lesson_version_id), CONSTRAINT course_version_lessons_order_unique UNIQUE(course_version_id,lesson_order),
  CONSTRAINT course_version_lessons_release_rule_check CHECK (CASE
    WHEN release_rule = '{"kind":"immediate"}'::jsonb THEN true
    WHEN jsonb_typeof(release_rule)='object' AND release_rule - ARRAY['kind','days']::text[] = '{}'::jsonb AND release_rule->>'kind'='elapsed_days' AND jsonb_typeof(release_rule->'days')='number' AND release_rule->>'days' ~ '^(0|[1-9][0-9]{0,2})$' THEN (release_rule->>'days')::integer BETWEEN 0 AND 365
    WHEN jsonb_typeof(release_rule)='object' AND release_rule - ARRAY['kind','at']::text[] = '{}'::jsonb AND release_rule->>'kind'='fixed_at' AND jsonb_typeof(release_rule->'at')='string' AND release_rule->>'at' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$' THEN isfinite((release_rule->>'at')::timestamptz) AND to_char((release_rule->>'at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=release_rule->>'at'
    ELSE false END)
);
--> statement-breakpoint
CREATE TABLE public.course_heads (
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE RESTRICT ON UPDATE RESTRICT, channel text NOT NULL DEFAULT 'production' CHECK(channel='production'),
  current_course_version_id uuid NOT NULL, manifest_hash text NOT NULL, head_revision integer NOT NULL CHECK(head_revision>0), set_by_staff_id uuid NOT NULL REFERENCES public.staff_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  set_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()), PRIMARY KEY(course_id,channel),
  CONSTRAINT course_heads_version_manifest_fk FOREIGN KEY(current_course_version_id,course_id,manifest_hash) REFERENCES public.course_versions(id,course_id,manifest_hash) ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE TABLE public.content_resource_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lesson_id uuid NOT NULL REFERENCES public.lessons(id) ON DELETE RESTRICT ON UPDATE RESTRICT, lesson_draft_revision integer NOT NULL, revision integer NOT NULL,
  label text NOT NULL, accessible_label text NOT NULL, delivery text NOT NULL CHECK(delivery IN ('external_https','private_blob')), delivery_reference text NOT NULL, mime text NOT NULL, byte_size integer NOT NULL CHECK(byte_size>=0), content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  archived_at timestamptz(3), updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp())
);
--> statement-breakpoint
CREATE TABLE public.lesson_version_resources (
  lesson_version_id uuid NOT NULL REFERENCES public.lesson_versions(id) ON DELETE RESTRICT ON UPDATE RESTRICT, resource_id uuid NOT NULL REFERENCES public.content_resource_drafts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "order" integer NOT NULL, label text NOT NULL, accessible_label text NOT NULL, delivery text NOT NULL, delivery_reference text NOT NULL, mime text NOT NULL, byte_size integer NOT NULL, content_hash text NOT NULL,
  PRIMARY KEY(lesson_version_id,resource_id), CONSTRAINT lesson_version_resources_order_unique UNIQUE(lesson_version_id,"order")
);
--> statement-breakpoint
CREATE TABLE public.resource_delivery_health (delivery_reference text PRIMARY KEY, state text NOT NULL CHECK(state IN ('preparing','ready','unavailable','deleted')), readiness_revision integer NOT NULL DEFAULT 0 CHECK(readiness_revision>=0), safe_error_code text, checked_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()));
--> statement-breakpoint
CREATE TABLE public.content_schedules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_kind text NOT NULL CHECK(target_kind IN ('course','lesson')), target_id uuid NOT NULL, expected_draft_revision integer NOT NULL, expected_draft_hash text NOT NULL CHECK(expected_draft_hash ~ '^[0-9a-f]{64}$'), run_at timestamptz(3) NOT NULL, authorizing_staff_id uuid NOT NULL REFERENCES public.staff_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT, authenticated_at timestamptz(3) NOT NULL, reason text NOT NULL, status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','published','blocked','cancelled')), created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()));
--> statement-breakpoint
CREATE UNIQUE INDEX content_schedules_active_target_hash_unique ON public.content_schedules(target_kind,target_id,expected_draft_hash) WHERE status='scheduled';
--> statement-breakpoint
CREATE TABLE public.content_archives (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_kind text NOT NULL CHECK(target_kind IN ('course','lesson')), target_version_id uuid NOT NULL, staff_id uuid NOT NULL REFERENCES public.staff_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT, reason text NOT NULL, archived_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()), CONSTRAINT content_archives_target_version_unique UNIQUE(target_kind,target_version_id));
--> statement-breakpoint
CREATE TABLE public.content_readiness_evaluations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), course_version_id uuid NOT NULL REFERENCES public.course_versions(id) ON DELETE RESTRICT ON UPDATE RESTRICT, gate_hash text NOT NULL CHECK(gate_hash ~ '^[0-9a-f]{64}$'), issues jsonb NOT NULL CHECK(jsonb_typeof(issues)='array'), passed boolean NOT NULL, evaluator_version text NOT NULL, evaluated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()), CONSTRAINT content_readiness_evaluations_version_hash_unique UNIQUE(course_version_id,gate_hash));
--> statement-breakpoint
CREATE TABLE public.content_readiness_approvals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), evaluation_id uuid NOT NULL UNIQUE REFERENCES public.content_readiness_evaluations(id) ON DELETE RESTRICT ON UPDATE RESTRICT, gate_hash text NOT NULL CHECK(gate_hash ~ '^[0-9a-f]{64}$'), approver_staff_id uuid NOT NULL REFERENCES public.staff_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT, reason text NOT NULL, approved_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()));
--> statement-breakpoint
CREATE TABLE public.api_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), principal_kind text NOT NULL CHECK(principal_kind IN ('anonymous','member','staff','system')), principal_id text NOT NULL, method text NOT NULL, route_template text NOT NULL, idempotency_key text NOT NULL CHECK(octet_length(idempotency_key) BETWEEN 16 AND 128),
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), status text NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed')), response_status integer, response jsonb, expires_at timestamptz(3) NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()), completed_at timestamptz(3),
  CONSTRAINT api_command_receipts_scope_key_unique UNIQUE(principal_kind,principal_id,method,route_template,idempotency_key), CHECK(expires_at >= created_at + interval '30 days'), CHECK((status='in_progress' AND response_status IS NULL AND response IS NULL AND completed_at IS NULL) OR (status='completed' AND response_status BETWEEN 200 AND 599 AND response IS NOT NULL AND completed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX api_command_receipts_expiry_idx ON public.api_command_receipts(expires_at);
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_immutable_row() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $f$ BEGIN RAISE EXCEPTION 'CONTENT_IMMUTABLE'; END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_immutable_row() FROM PUBLIC;
--> statement-breakpoint
DO $immutability$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['lesson_accessibility_decisions','lesson_disclosure_decisions','lesson_versions','content_previews','course_versions','course_version_lessons','lesson_version_resources','content_archives','content_readiness_evaluations','content_readiness_approvals'] LOOP
    EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.syntholo_content_immutable_row()',table_name,table_name);
  END LOOP;
END $immutability$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_create_preview_v1(p_course_id uuid,p_expected_revision integer,p_manifest_canonical_json text,p_manifest_hash text,p_manifest_projection jsonb,p_publication_issues jsonb,p_reason text)
RETURNS public.content_previews LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$ DECLARE draft public.course_drafts; created public.content_previews; actor uuid; correlation uuid; occurred timestamptz(3); BEGIN
  actor := nullif(current_setting('app.actor_id',true),'')::uuid;
  correlation := nullif(current_setting('app.correlation_id',true),'')::uuid;
  occurred := date_trunc('milliseconds',clock_timestamp());
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR correlation IS NULL THEN RAISE EXCEPTION 'CONTENT_STAFF_CONTEXT_REQUIRED'; END IF;
  -- Tranche 0009 cannot derive the complete publication manifest until the
  -- lesson/media authority lands. Never accept caller-asserted readiness.
  RAISE EXCEPTION 'CONTENT_PUBLICATION_PIPELINE_INCOMPLETE' USING ERRCODE='55000';
  SELECT * INTO draft FROM public.course_drafts WHERE course_id=p_course_id FOR UPDATE;
  IF draft.course_id IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
  IF draft.revision<>p_expected_revision THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  IF p_manifest_hash<>encode(sha256(convert_to(p_manifest_canonical_json,'UTF8')),'hex') OR p_manifest_canonical_json::jsonb<>p_manifest_projection THEN RAISE EXCEPTION 'MANIFEST_INVALID'; END IF;
  INSERT INTO public.content_previews(course_id,draft_revision,manifest_canonical_json,manifest_hash,manifest_projection,publication_issues,created_by_staff_id,reason)
  VALUES(p_course_id,p_expected_revision,p_manifest_canonical_json,p_manifest_hash,p_manifest_projection,p_publication_issues,actor,p_reason) RETURNING * INTO created;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at)
  VALUES(gen_random_uuid(),NULL,'staff',actor::text,'content_preview_materialized','course',p_course_id::text,correlation,jsonb_build_object('previewId',created.id::text,'draftRevision',created.draft_revision,'manifestHash',created.manifest_hash),occurred);
  RETURN created;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_create_preview_v1(uuid,integer,text,text,jsonb,jsonb,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_content_create_preview_v1(uuid,integer,text,text,jsonb,jsonb,text) TO syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_publish_course_v1(p_preview_id uuid,p_expected_manifest_hash text,p_expected_head_revision integer,p_reason text)
RETURNS public.course_versions LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$ DECLARE preview public.content_previews; draft public.course_drafts; head public.course_heads; created public.course_versions; actor uuid; correlation uuid; occurred timestamptz(3); event_id uuid; next_version integer; BEGIN
  actor := nullif(current_setting('app.actor_id',true),'')::uuid;
  correlation := nullif(current_setting('app.correlation_id',true),'')::uuid;
  occurred := date_trunc('milliseconds',clock_timestamp()); event_id := gen_random_uuid();
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR correlation IS NULL THEN RAISE EXCEPTION 'CONTENT_STAFF_CONTEXT_REQUIRED'; END IF;
  SELECT * INTO preview FROM public.content_previews WHERE id=p_preview_id FOR UPDATE;
  IF preview.id IS NULL OR preview.manifest_hash<>p_expected_manifest_hash THEN RAISE EXCEPTION 'MANIFEST_CHANGED'; END IF;
  IF jsonb_array_length(preview.publication_issues)<>0 THEN RAISE EXCEPTION 'CONTENT_NOT_READY'; END IF;
  SELECT * INTO draft FROM public.course_drafts WHERE course_id=preview.course_id FOR UPDATE;
  IF draft.revision<>preview.draft_revision THEN RAISE EXCEPTION 'MANIFEST_CHANGED'; END IF;
  SELECT * INTO head FROM public.course_heads WHERE course_id=preview.course_id AND channel='production' FOR UPDATE;
  IF (head.course_id IS NULL AND p_expected_head_revision<>0) OR (head.course_id IS NOT NULL AND head.head_revision<>p_expected_head_revision) THEN RAISE EXCEPTION 'COURSE_HEAD_CHANGED'; END IF;
  IF EXISTS(SELECT 1 FROM public.course_draft_manifest_entries e WHERE e.course_id=preview.course_id AND e.course_draft_revision=preview.draft_revision AND (e.selected_lesson_version_id IS NULL OR e.selected_lesson_version_hash IS DISTINCT FROM (SELECT v.content_hash FROM public.lesson_versions v WHERE v.id=e.selected_lesson_version_id))) THEN RAISE EXCEPTION 'MANIFEST_CHANGED'; END IF;
  SELECT coalesce(max(version),0)+1 INTO next_version FROM public.course_versions WHERE course_id=preview.course_id;
  INSERT INTO public.course_versions(course_id,version,title,description,manifest_hash,source_preview_id,published_by_staff_id,publish_reason) VALUES(preview.course_id,next_version,draft.title,draft.description,preview.manifest_hash,preview.id,actor,p_reason) RETURNING * INTO created;
  INSERT INTO public.course_version_lessons(course_version_id,course_id,lesson_id,lesson_version_id,stage_id,stage_title,stage_order,lesson_order,required,release_rule)
  SELECT created.id,e.course_id,e.lesson_id,e.selected_lesson_version_id,e.stage_id,sd.title,e.stage_order,e.lesson_order,e.required,e.release_rule FROM public.course_draft_manifest_entries e JOIN public.stage_drafts sd ON sd.stage_id=e.stage_id WHERE e.course_id=preview.course_id AND e.course_draft_revision=preview.draft_revision ORDER BY e.lesson_order;
  IF head.course_id IS NULL THEN INSERT INTO public.course_heads(course_id,channel,current_course_version_id,manifest_hash,head_revision,set_by_staff_id) VALUES(preview.course_id,'production',created.id,created.manifest_hash,1,actor);
  ELSE UPDATE public.course_heads SET current_course_version_id=created.id,manifest_hash=created.manifest_hash,head_revision=head.head_revision+1,set_by_staff_id=actor,set_at=date_trunc('milliseconds',clock_timestamp()) WHERE course_id=preview.course_id AND channel='production' AND head_revision=p_expected_head_revision; END IF;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at)
  VALUES(gen_random_uuid(),NULL,'staff',actor::text,'content_course_published','course_version',created.id::text,correlation,jsonb_build_object('courseId',created.course_id::text,'courseVersionId',created.id::text,'manifestHash',created.manifest_hash,'version',created.version),occurred);
  INSERT INTO public.outbox_events(event_id,account_id,actor_type,actor_id,correlation_id,type,aggregate_id,occurred_at,payload,available_at)
  VALUES(event_id,NULL,'staff',actor::text,correlation,'content.course_published.v1',created.course_id::text,occurred,jsonb_build_object('courseId',created.course_id::text,'courseVersionId',created.id::text,'manifestHash',created.manifest_hash),occurred);
  RETURN created;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_publish_course_v1(uuid,text,integer,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_content_publish_course_v1(uuid,text,integer,text) TO syntholo_staff_api;
--> statement-breakpoint
REVOKE ALL ON public.courses,public.course_drafts,public.stages,public.stage_drafts,public.lessons,public.lesson_drafts,public.lesson_accessibility_decisions,public.lesson_accessibility_review_heads,public.lesson_disclosure_decisions,public.lesson_disclosure_review_heads,public.lesson_versions,public.course_draft_manifest_entries,public.content_previews,public.course_versions,public.course_version_lessons,public.course_heads,public.content_resource_drafts,public.lesson_version_resources,public.resource_delivery_health,public.content_schedules,public.content_archives,public.content_readiness_evaluations,public.content_readiness_approvals,public.api_command_receipts FROM syntholo_member_api;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.courses,public.stages,public.lessons TO syntholo_staff_api;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON public.course_drafts,public.stage_drafts,public.lesson_drafts,public.content_resource_drafts TO syntholo_staff_api;
--> statement-breakpoint
GRANT SELECT ON public.lesson_accessibility_decisions,public.lesson_accessibility_review_heads,public.lesson_disclosure_decisions,public.lesson_disclosure_review_heads,public.lesson_versions,public.course_draft_manifest_entries,public.content_previews,public.course_versions,public.course_version_lessons,public.course_heads,public.lesson_version_resources,public.resource_delivery_health,public.content_schedules,public.content_archives,public.content_readiness_evaluations,public.content_readiness_approvals TO syntholo_staff_api;
--> statement-breakpoint
GRANT ALL ON public.courses,public.course_drafts,public.stages,public.stage_drafts,public.lessons,public.lesson_drafts,public.lesson_accessibility_decisions,public.lesson_accessibility_review_heads,public.lesson_disclosure_decisions,public.lesson_disclosure_review_heads,public.lesson_versions,public.course_draft_manifest_entries,public.content_previews,public.course_versions,public.course_version_lessons,public.course_heads,public.content_resource_drafts,public.lesson_version_resources,public.resource_delivery_health,public.content_schedules,public.content_archives,public.content_readiness_evaluations,public.content_readiness_approvals,public.api_command_receipts TO syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_readiness_v1() RETURNS TABLE(
  contract_version text,migration_created_at bigint,migration_hash text,object_count integer,
  object_owner_ready boolean,object_type_ready boolean,immutable_triggers_ready boolean,
  table_acl_ready boolean,function_acl_ready boolean,public_execute_denied boolean,empty_catalog boolean
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
  WITH required(name) AS (VALUES
    ('courses'),('course_drafts'),('stages'),('stage_drafts'),('lessons'),('lesson_drafts'),('lesson_accessibility_decisions'),('lesson_accessibility_review_heads'),('lesson_disclosure_decisions'),('lesson_disclosure_review_heads'),('lesson_versions'),('course_draft_manifest_entries'),('content_previews'),('course_versions'),('course_version_lessons'),('course_heads'),('content_resource_drafts'),('lesson_version_resources'),('resource_delivery_health'),('content_schedules'),('content_archives'),('content_readiness_evaluations'),('content_readiness_approvals'),('api_command_receipts')
  ), relations AS (
    SELECT r.name,c.oid,c.relkind,c.relowner,c.relacl FROM required r
    LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||r.name)
  ), expected_functions(signature,security_definer) AS (VALUES
    ('public.syntholo_content_immutable_row()',false),
    ('public.syntholo_content_create_preview_v1(uuid,integer,text,text,jsonb,jsonb,text)',true),
    ('public.syntholo_content_publish_course_v1(uuid,text,integer,text)',true),
    ('public.syntholo_content_readiness_v1()',true)
  ), content_functions AS (
    SELECT e.signature,e.security_definer,p.oid,p.proowner,p.prokind,p.prosecdef,p.proconfig,p.proacl
    FROM expected_functions e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)
  ), function_owner AS (
    SELECT proowner FROM content_functions WHERE signature='public.syntholo_content_readiness_v1()'
  ), immutable_relations(name) AS (VALUES
    ('lesson_accessibility_decisions'),('lesson_disclosure_decisions'),('lesson_versions'),('content_previews'),('course_versions'),('course_version_lessons'),('lesson_version_resources'),('content_archives'),('content_readiness_evaluations'),('content_readiness_approvals')
  ), expected_triggers(table_name,trigger_name) AS (
    SELECT name,name||'_immutable' FROM immutable_relations
  ), actual_immutable_triggers AS (
    SELECT c.relname table_name,t.tgname trigger_name,t.tgtype,t.tgenabled
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE NOT t.tgisinternal AND t.tgfoid=to_regprocedure('public.syntholo_content_immutable_row()')
  ), staff_table_acl(name,privileges) AS (VALUES
    ('courses',ARRAY['SELECT','INSERT']::text[]),('stages',ARRAY['SELECT','INSERT']::text[]),('lessons',ARRAY['SELECT','INSERT']::text[]),
    ('course_drafts',ARRAY['SELECT','INSERT','UPDATE']::text[]),('stage_drafts',ARRAY['SELECT','INSERT','UPDATE']::text[]),('lesson_drafts',ARRAY['SELECT','INSERT','UPDATE']::text[]),('content_resource_drafts',ARRAY['SELECT','INSERT','UPDATE']::text[]),
    ('lesson_accessibility_decisions',ARRAY['SELECT']::text[]),('lesson_accessibility_review_heads',ARRAY['SELECT']::text[]),('lesson_disclosure_decisions',ARRAY['SELECT']::text[]),('lesson_disclosure_review_heads',ARRAY['SELECT']::text[]),('lesson_versions',ARRAY['SELECT']::text[]),('course_draft_manifest_entries',ARRAY['SELECT']::text[]),('content_previews',ARRAY['SELECT']::text[]),('course_versions',ARRAY['SELECT']::text[]),('course_version_lessons',ARRAY['SELECT']::text[]),('course_heads',ARRAY['SELECT']::text[]),('lesson_version_resources',ARRAY['SELECT']::text[]),('resource_delivery_health',ARRAY['SELECT']::text[]),('content_schedules',ARRAY['SELECT']::text[]),('content_archives',ARRAY['SELECT']::text[]),('content_readiness_evaluations',ARRAY['SELECT']::text[]),('content_readiness_approvals',ARRAY['SELECT']::text[])
  ), expected_table_acl(role_name,table_name,privilege_type) AS (
    SELECT 'syntholo_migrator',r.name,p FROM required r CROSS JOIN LATERAL unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']::text[]) p
    UNION ALL
    SELECT 'syntholo_staff_api',s.name,p FROM staff_table_acl s CROSS JOIN LATERAL unnest(s.privileges) p
  ), actual_table_acl AS (
    SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END role_name,
      c.name table_name,a.privilege_type
    FROM relations c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,'{}'::aclitem[])) a
    WHERE CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
      IN ('PUBLIC','syntholo_migrator','syntholo_member_api','syntholo_staff_api','syntholo_worker','syntholo_system_api')
  ), expected_function_acl(signature,role_name,privilege_type) AS (VALUES
    ('public.syntholo_content_create_preview_v1(uuid,integer,text,text,jsonb,jsonb,text)','syntholo_staff_api','EXECUTE'),
    ('public.syntholo_content_publish_course_v1(uuid,text,integer,text)','syntholo_staff_api','EXECUTE'),
    ('public.syntholo_content_readiness_v1()','syntholo_migrator','EXECUTE'),
    ('public.syntholo_content_readiness_v1()','syntholo_member_api','EXECUTE'),
    ('public.syntholo_content_readiness_v1()','syntholo_staff_api','EXECUTE'),
    ('public.syntholo_content_readiness_v1()','syntholo_worker','EXECUTE'),
    ('public.syntholo_content_readiness_v1()','syntholo_system_api','EXECUTE')
  ), actual_function_acl AS (
    SELECT p.signature,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END role_name,a.privilege_type
    FROM content_functions p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,'{}'::aclitem[])) a
    WHERE CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
      IN ('PUBLIC','syntholo_migrator','syntholo_member_api','syntholo_staff_api','syntholo_worker','syntholo_system_api')
  )
  SELECT '0009_content.v1',1786676400000::bigint,j.hash,
    (SELECT count(*)::integer FROM relations WHERE oid IS NOT NULL),
    (SELECT count(*)=24 AND bool_and(relowner=(SELECT proowner FROM function_owner)) FROM relations)
      AND (SELECT count(*)=4 AND bool_and(proowner=(SELECT proowner FROM function_owner)) FROM content_functions),
    (SELECT count(*)=24 AND bool_and(relkind='r') FROM relations)
      AND (SELECT count(*)=4 AND bool_and(prokind='f') FROM content_functions),
    NOT EXISTS((SELECT table_name,trigger_name FROM expected_triggers EXCEPT SELECT table_name,trigger_name FROM actual_immutable_triggers)
      UNION ALL (SELECT table_name,trigger_name FROM actual_immutable_triggers EXCEPT SELECT table_name,trigger_name FROM expected_triggers))
      AND NOT EXISTS(SELECT 1 FROM actual_immutable_triggers t WHERE t.tgtype<>27 OR t.tgenabled<>'O'),
    NOT EXISTS((SELECT role_name,table_name,privilege_type FROM expected_table_acl EXCEPT SELECT role_name,table_name,privilege_type FROM actual_table_acl)
      UNION ALL (SELECT role_name,table_name,privilege_type FROM actual_table_acl EXCEPT SELECT role_name,table_name,privilege_type FROM expected_table_acl)),
    NOT EXISTS((SELECT signature,role_name,privilege_type FROM expected_function_acl EXCEPT SELECT signature,role_name,privilege_type FROM actual_function_acl)
      UNION ALL (SELECT signature,role_name,privilege_type FROM actual_function_acl EXCEPT SELECT signature,role_name,privilege_type FROM expected_function_acl))
      AND NOT EXISTS(SELECT 1 FROM content_functions p WHERE p.oid IS NULL OR p.prosecdef<>p.security_definer OR p.proconfig<>ARRAY['search_path=pg_catalog, pg_temp']::text[]),
    NOT EXISTS(SELECT 1 FROM content_functions p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,'{}'::aclitem[])) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE'),
    NOT EXISTS(
      SELECT 1 FROM public.courses UNION ALL SELECT 1 FROM public.course_drafts UNION ALL SELECT 1 FROM public.stages UNION ALL SELECT 1 FROM public.stage_drafts
      UNION ALL SELECT 1 FROM public.lessons UNION ALL SELECT 1 FROM public.lesson_drafts UNION ALL SELECT 1 FROM public.lesson_accessibility_decisions
      UNION ALL SELECT 1 FROM public.lesson_accessibility_review_heads UNION ALL SELECT 1 FROM public.lesson_disclosure_decisions UNION ALL SELECT 1 FROM public.lesson_disclosure_review_heads
      UNION ALL SELECT 1 FROM public.lesson_versions UNION ALL SELECT 1 FROM public.course_draft_manifest_entries UNION ALL SELECT 1 FROM public.content_previews
      UNION ALL SELECT 1 FROM public.course_versions UNION ALL SELECT 1 FROM public.course_version_lessons UNION ALL SELECT 1 FROM public.course_heads
      UNION ALL SELECT 1 FROM public.content_resource_drafts UNION ALL SELECT 1 FROM public.lesson_version_resources UNION ALL SELECT 1 FROM public.resource_delivery_health
      UNION ALL SELECT 1 FROM public.content_schedules UNION ALL SELECT 1 FROM public.content_archives UNION ALL SELECT 1 FROM public.content_readiness_evaluations
      UNION ALL SELECT 1 FROM public.content_readiness_approvals UNION ALL SELECT 1 FROM public.api_command_receipts
    )
  FROM drizzle.__drizzle_migrations j WHERE j.created_at=1786676400000;
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_readiness_v1() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_content_readiness_v1() TO syntholo_migrator,syntholo_member_api,syntholo_staff_api,syntholo_worker,syntholo_system_api;
