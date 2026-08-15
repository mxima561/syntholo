CREATE FUNCTION public.syntholo_implementation_text_valid_v1(p_value text,p_max_bytes integer)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $f$
  SELECT octet_length(p_value)<=p_max_bytes
    AND p_value !~ '^[\t\n\v\f\r    -     　﻿]'
    AND p_value !~ '[\t\n\v\f\r    -     　﻿]$'
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_text_valid_v1(text,integer) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_text_complete_v1(p_value text,p_max_bytes integer)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $f$
  SELECT public.syntholo_implementation_text_valid_v1(p_value,p_max_bytes) AND octet_length(p_value)>0
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_text_complete_v1(text,integer) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_text_array_valid_v1(p_value jsonb,p_max_items integer,p_max_bytes integer)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $f$
  SELECT jsonb_typeof(p_value)='array' AND jsonb_array_length(p_value) BETWEEN 0 AND p_max_items
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_value) item WHERE jsonb_typeof(item)<>'string' OR NOT public.syntholo_implementation_text_valid_v1(item#>>'{}',p_max_bytes))
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_text_array_valid_v1(jsonb,integer,integer) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_text_array_complete_v1(p_value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $f$
  SELECT public.syntholo_implementation_text_array_valid_v1(p_value,50,2000)
    AND jsonb_array_length(p_value)>0
    AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_value) item
      WHERE NOT public.syntholo_implementation_text_complete_v1(item#>>'{}',2000)
    )
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_text_array_complete_v1(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_workflow_valid_v1(p_value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $f$
DECLARE lifecycle text; test_state text; launch text; scalar_name text;
BEGIN
  IF jsonb_typeof(p_value)<>'object'
    OR p_value-ARRAY['name','engine','problem','trigger','owner','approvedTools','steps','humanReviewPoint','safetyNotes','baseline','target','lifecycleState','testStatus','launchDate']::text[]<>'{}'::jsonb
    OR NOT (p_value ?& ARRAY['name','engine','problem','trigger','owner','approvedTools','steps','humanReviewPoint','safetyNotes','baseline','target','lifecycleState','testStatus','launchDate'])
  THEN RETURN false; END IF;
  FOREACH scalar_name IN ARRAY ARRAY['name','engine','problem','trigger','owner','humanReviewPoint','safetyNotes','baseline','target','lifecycleState','testStatus'] LOOP
    IF jsonb_typeof(p_value->scalar_name)<>'string' THEN RETURN false; END IF;
  END LOOP;
  IF NOT public.syntholo_implementation_text_valid_v1(p_value->>'name',255) OR NOT public.syntholo_implementation_text_valid_v1(p_value->>'owner',255) OR NOT public.syntholo_implementation_text_valid_v1(p_value->>'baseline',255) OR NOT public.syntholo_implementation_text_valid_v1(p_value->>'target',255)
    OR NOT public.syntholo_implementation_text_valid_v1(p_value->>'problem',2000) OR NOT public.syntholo_implementation_text_valid_v1(p_value->>'trigger',2000) OR NOT public.syntholo_implementation_text_valid_v1(p_value->>'humanReviewPoint',2000) OR NOT public.syntholo_implementation_text_valid_v1(p_value->>'safetyNotes',2000) THEN RETURN false; END IF;
  IF p_value->>'engine' NOT IN ('growth','client','management')
    OR p_value->>'lifecycleState' NOT IN ('draft','testing','live','paused')
    OR p_value->>'testStatus' NOT IN ('not_started','in_progress','passed','failed')
    OR NOT public.syntholo_implementation_text_array_valid_v1(p_value->'approvedTools',25,255)
    OR NOT public.syntholo_implementation_text_array_valid_v1(p_value->'steps',25,2000)
  THEN RETURN false; END IF;
  lifecycle:=p_value->>'lifecycleState'; test_state:=p_value->>'testStatus'; launch:=p_value->>'launchDate';
  IF jsonb_typeof(p_value->'launchDate') NOT IN ('null','string') THEN RETURN false; END IF;
  IF launch IS NOT NULL AND (launch !~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$' OR substring(launch,1,4)='0000' OR to_char(to_date(launch,'YYYY-MM-DD'),'YYYY-MM-DD')<>launch) THEN RETURN false; END IF;
  IF lifecycle='live' AND (
    test_state<>'passed' OR launch IS NULL
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['name','problem','trigger','owner','humanReviewPoint','safetyNotes','baseline','target']) k WHERE NOT public.syntholo_implementation_text_complete_v1(p_value->>k,2000))
    OR NOT public.syntholo_implementation_text_array_complete_v1(p_value->'approvedTools')
    OR NOT public.syntholo_implementation_text_array_complete_v1(p_value->'steps')
  ) THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_workflow_valid_v1(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_content_valid_v1(p_kind text,p_state text,p_value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $f$
DECLARE item jsonb; complete boolean:=true;
BEGIN
  IF p_kind NOT IN ('readiness_map','ai_policy','workflow_portfolio','enablement_checklist','roadmap')
    OR p_state NOT IN ('draft','final') OR jsonb_typeof(p_value)<>'object' OR p_value->>'kind'<>p_kind
  THEN RETURN false; END IF;
  CASE p_kind
    WHEN 'readiness_map' THEN
      IF p_value-ARRAY['kind','priorities','notes']::text[]<>'{}'::jsonb OR NOT (p_value ?& ARRAY['kind','priorities','notes'])
        OR jsonb_typeof(p_value->'notes')<>'string' OR NOT public.syntholo_implementation_text_valid_v1(p_value->>'notes',2000)
        OR jsonb_typeof(p_value->'priorities')<>'array' OR jsonb_array_length(p_value->'priorities')>25 THEN RETURN false; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(p_value->'priorities') LOOP
        IF jsonb_typeof(item)<>'object' OR item-ARRAY['opportunity','currentState','targetOutcome','owner']::text[]<>'{}'::jsonb OR NOT (item ?& ARRAY['opportunity','currentState','targetOutcome','owner'])
          OR jsonb_typeof(item->'opportunity')<>'string' OR NOT public.syntholo_implementation_text_valid_v1(item->>'opportunity',255) OR jsonb_typeof(item->'owner')<>'string' OR NOT public.syntholo_implementation_text_valid_v1(item->>'owner',255)
          OR jsonb_typeof(item->'currentState')<>'string' OR NOT public.syntholo_implementation_text_valid_v1(item->>'currentState',2000) OR jsonb_typeof(item->'targetOutcome')<>'string' OR NOT public.syntholo_implementation_text_valid_v1(item->>'targetOutcome',2000)
        THEN RETURN false; END IF;
        complete:=complete AND public.syntholo_implementation_text_complete_v1(item->>'opportunity',255) AND public.syntholo_implementation_text_complete_v1(item->>'owner',255) AND public.syntholo_implementation_text_complete_v1(item->>'currentState',2000) AND public.syntholo_implementation_text_complete_v1(item->>'targetOutcome',2000);
      END LOOP;
      complete:=complete AND public.syntholo_implementation_text_complete_v1(p_value->>'notes',2000) AND jsonb_array_length(p_value->'priorities')>0;
    WHEN 'ai_policy' THEN
      IF p_value-ARRAY['kind','purpose','approvedUses','prohibitedUses','humanReviewRules']::text[]<>'{}'::jsonb OR NOT (p_value ?& ARRAY['kind','purpose','approvedUses','prohibitedUses','humanReviewRules'])
        OR jsonb_typeof(p_value->'purpose')<>'string' OR NOT public.syntholo_implementation_text_valid_v1(p_value->>'purpose',2000) THEN RETURN false; END IF;
      FOREACH item IN ARRAY ARRAY[p_value->'approvedUses',p_value->'prohibitedUses',p_value->'humanReviewRules'] LOOP
        IF NOT public.syntholo_implementation_text_array_valid_v1(item,25,255) THEN RETURN false; END IF;
        complete:=complete AND public.syntholo_implementation_text_array_complete_v1(item);
      END LOOP;
      complete:=complete AND public.syntholo_implementation_text_complete_v1(p_value->>'purpose',2000);
    WHEN 'workflow_portfolio' THEN
      IF p_value-ARRAY['kind','workflows']::text[]<>'{}'::jsonb OR NOT (p_value ?& ARRAY['kind','workflows'])
        OR jsonb_typeof(p_value->'workflows')<>'array' OR jsonb_array_length(p_value->'workflows')>3 THEN RETURN false; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(p_value->'workflows') LOOP
        IF NOT public.syntholo_implementation_workflow_valid_v1(item) THEN RETURN false; END IF;
        complete:=complete
          AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['name','problem','trigger','owner','humanReviewPoint','safetyNotes','baseline','target']) k WHERE NOT public.syntholo_implementation_text_complete_v1(item->>k,2000))
          AND public.syntholo_implementation_text_array_complete_v1(item->'approvedTools')
          AND public.syntholo_implementation_text_array_complete_v1(item->'steps');
      END LOOP;
      complete:=complete AND jsonb_array_length(p_value->'workflows')=3;
    WHEN 'enablement_checklist' THEN
      IF p_value-ARRAY['kind','owner','items']::text[]<>'{}'::jsonb OR NOT (p_value ?& ARRAY['kind','owner','items'])
        OR jsonb_typeof(p_value->'owner')<>'string' OR NOT public.syntholo_implementation_text_valid_v1(p_value->>'owner',255)
        OR jsonb_typeof(p_value->'items')<>'array' OR jsonb_array_length(p_value->'items')>50 THEN RETURN false; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(p_value->'items') LOOP
        IF jsonb_typeof(item)<>'object' OR item-ARRAY['label','complete']::text[]<>'{}'::jsonb OR NOT (item ?& ARRAY['label','complete'])
          OR jsonb_typeof(item->'label')<>'string' OR NOT public.syntholo_implementation_text_valid_v1(item->>'label',2000) OR jsonb_typeof(item->'complete')<>'boolean' THEN RETURN false; END IF;
        complete:=complete AND public.syntholo_implementation_text_complete_v1(item->>'label',2000);
      END LOOP;
      complete:=complete AND public.syntholo_implementation_text_complete_v1(p_value->>'owner',255) AND jsonb_array_length(p_value->'items')>0;
    WHEN 'roadmap' THEN
      IF p_value-ARRAY['kind','objective','milestones']::text[]<>'{}'::jsonb OR NOT (p_value ?& ARRAY['kind','objective','milestones'])
        OR jsonb_typeof(p_value->'objective')<>'string' OR NOT public.syntholo_implementation_text_valid_v1(p_value->>'objective',2000)
        OR jsonb_typeof(p_value->'milestones')<>'array' OR jsonb_array_length(p_value->'milestones')>25 THEN RETURN false; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(p_value->'milestones') LOOP
        IF jsonb_typeof(item)<>'object' OR item-ARRAY['horizon','outcome','owner']::text[]<>'{}'::jsonb OR NOT (item ?& ARRAY['horizon','outcome','owner'])
          OR jsonb_typeof(item->'horizon')<>'string' OR item->>'horizon' NOT IN ('30_days','60_days','90_days')
          OR jsonb_typeof(item->'outcome')<>'string' OR NOT public.syntholo_implementation_text_valid_v1(item->>'outcome',2000) OR jsonb_typeof(item->'owner')<>'string' OR NOT public.syntholo_implementation_text_valid_v1(item->>'owner',255) THEN RETURN false; END IF;
        complete:=complete AND public.syntholo_implementation_text_complete_v1(item->>'outcome',2000) AND public.syntholo_implementation_text_complete_v1(item->>'owner',255);
      END LOOP;
      complete:=complete AND public.syntholo_implementation_text_complete_v1(p_value->>'objective',2000) AND jsonb_array_length(p_value->'milestones')>0;
  END CASE;
  RETURN p_state='draft' OR complete;
EXCEPTION WHEN others THEN RETURN false;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_content_valid_v1(text,text,jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE public.implementation_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  seeded_from_account_course_access_id uuid NOT NULL, seeded_from_course_version_id uuid NOT NULL,
  kind text NOT NULL CONSTRAINT implementation_artifacts_kind_check CHECK(kind IN ('readiness_map','ai_policy','workflow_portfolio','enablement_checklist','roadmap')),
  title text NOT NULL CONSTRAINT implementation_artifacts_title_check CHECK(octet_length(btrim(title)) BETWEEN 1 AND 255),
  current_version integer NOT NULL DEFAULT 0, current_version_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()), updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT implementation_artifacts_seed_access_fk FOREIGN KEY(seeded_from_account_course_access_id,account_id,course_id,seeded_from_course_version_id) REFERENCES public.account_course_accesses(id,account_id,course_id,course_version_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT implementation_artifacts_account_course_kind_unique UNIQUE(account_id,course_id,kind),
  CONSTRAINT implementation_artifacts_exact_unique UNIQUE(id,account_id,course_id),
  CONSTRAINT implementation_artifacts_kind_exact_unique UNIQUE(id,account_id,course_id,kind),
  CONSTRAINT implementation_artifacts_head_check CHECK((current_version=0 AND current_version_id IS NULL) OR (current_version>0 AND current_version_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE public.implementation_artifact_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, course_id uuid NOT NULL, artifact_id uuid NOT NULL, kind text NOT NULL,
  version integer NOT NULL CONSTRAINT implementation_versions_version_check CHECK(version>0), state text NOT NULL CONSTRAINT implementation_versions_state_check CHECK(state IN ('draft','final')),
  content jsonb NOT NULL, canonical_json text NOT NULL CONSTRAINT implementation_versions_canonical_size_check CHECK(octet_length(canonical_json) BETWEEN 2 AND 1048576),
  content_hash text NOT NULL CONSTRAINT implementation_versions_hash_check CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  creator_membership_id uuid NOT NULL, source_command_receipt_id uuid NOT NULL REFERENCES public.api_command_receipts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT implementation_versions_artifact_exact_fk FOREIGN KEY(artifact_id,account_id,course_id,kind) REFERENCES public.implementation_artifacts(id,account_id,course_id,kind) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT implementation_versions_creator_account_fk FOREIGN KEY(creator_membership_id,account_id) REFERENCES public.memberships(id,account_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT implementation_versions_artifact_version_unique UNIQUE(artifact_id,version),
  CONSTRAINT implementation_versions_source_command_receipt_id_unique UNIQUE(source_command_receipt_id),
  CONSTRAINT implementation_versions_exact_unique UNIQUE(account_id,artifact_id,id),
  CONSTRAINT implementation_versions_course_exact_unique UNIQUE(id,account_id,course_id,artifact_id),
  CONSTRAINT implementation_versions_kind_exact_unique UNIQUE(id,account_id,course_id,artifact_id,kind),
  CONSTRAINT implementation_versions_head_unique UNIQUE(id,account_id,course_id,artifact_id,kind,version),
  CONSTRAINT implementation_versions_content_check CHECK(content->>'kind'=kind AND public.syntholo_implementation_content_valid_v1(kind,state,content)),
  CONSTRAINT implementation_versions_canonical_check CHECK(canonical_json=public.syntholo_canonical_jsonb_text_v1(content)),
  CONSTRAINT implementation_versions_hash_parity_check CHECK(content_hash=encode(sha256(convert_to(canonical_json,'UTF8')),'hex'))
);
--> statement-breakpoint
CREATE INDEX implementation_versions_history_idx ON public.implementation_artifact_versions(artifact_id,created_at DESC,id DESC);
--> statement-breakpoint
ALTER TABLE public.implementation_artifacts ADD CONSTRAINT implementation_artifacts_current_version_fk FOREIGN KEY(current_version_id,account_id,course_id,id,kind,current_version) REFERENCES public.implementation_artifact_versions(id,account_id,course_id,artifact_id,kind,version) ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
CREATE TABLE public.implementation_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, course_id uuid NOT NULL, artifact_id uuid NOT NULL, artifact_version_id uuid NOT NULL, artifact_kind text NOT NULL DEFAULT 'workflow_portfolio',
  ordinal integer NOT NULL CONSTRAINT implementation_workflows_ordinal_check CHECK(ordinal BETWEEN 1 AND 3),
  name text NOT NULL, engine text NOT NULL CONSTRAINT implementation_workflows_engine_check CHECK(engine IN ('growth','client','management')),
  problem text NOT NULL, trigger text NOT NULL, owner text NOT NULL, approved_tools jsonb NOT NULL, steps jsonb NOT NULL,
  human_review_point text NOT NULL, safety_notes text NOT NULL, baseline text NOT NULL, target text NOT NULL,
  lifecycle_state text NOT NULL CONSTRAINT implementation_workflows_lifecycle_check CHECK(lifecycle_state IN ('draft','testing','live','paused')),
  test_status text NOT NULL CONSTRAINT implementation_workflows_test_check CHECK(test_status IN ('not_started','in_progress','passed','failed')), launch_date date,
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT implementation_workflows_version_exact_fk FOREIGN KEY(artifact_version_id,account_id,course_id,artifact_id,artifact_kind) REFERENCES public.implementation_artifact_versions(id,account_id,course_id,artifact_id,kind) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT implementation_workflows_version_ordinal_unique UNIQUE(artifact_version_id,ordinal),
  CONSTRAINT implementation_workflows_exact_unique UNIQUE(account_id,artifact_id,id),
  CONSTRAINT implementation_workflows_version_exact_unique UNIQUE(account_id,course_id,artifact_id,artifact_version_id,id),
  CONSTRAINT implementation_workflows_artifact_kind_check CHECK(artifact_kind='workflow_portfolio'),
  CONSTRAINT implementation_workflows_text_check CHECK(public.syntholo_implementation_text_valid_v1(name,255) AND public.syntholo_implementation_text_valid_v1(problem,2000) AND public.syntholo_implementation_text_valid_v1(trigger,2000) AND public.syntholo_implementation_text_valid_v1(owner,255) AND public.syntholo_implementation_text_valid_v1(human_review_point,2000) AND public.syntholo_implementation_text_valid_v1(safety_notes,2000) AND public.syntholo_implementation_text_valid_v1(baseline,255) AND public.syntholo_implementation_text_valid_v1(target,255)),
  CONSTRAINT implementation_workflows_arrays_check CHECK(public.syntholo_implementation_text_array_valid_v1(approved_tools,25,255) AND public.syntholo_implementation_text_array_valid_v1(steps,25,2000)),
  CONSTRAINT implementation_workflows_live_check CHECK(lifecycle_state<>'live' OR (test_status='passed' AND launch_date IS NOT NULL AND public.syntholo_implementation_text_complete_v1(name,255) AND public.syntholo_implementation_text_complete_v1(problem,2000) AND public.syntholo_implementation_text_complete_v1(trigger,2000) AND public.syntholo_implementation_text_complete_v1(owner,255) AND public.syntholo_implementation_text_complete_v1(human_review_point,2000) AND public.syntholo_implementation_text_complete_v1(safety_notes,2000) AND public.syntholo_implementation_text_complete_v1(baseline,255) AND public.syntholo_implementation_text_complete_v1(target,255) AND public.syntholo_implementation_text_array_complete_v1(approved_tools) AND public.syntholo_implementation_text_array_complete_v1(steps)))
);
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_workflow_content_match_v1() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $f$
DECLARE expected jsonb;
BEGIN
  SELECT content->'workflows'->(NEW.ordinal-1) INTO expected FROM public.implementation_artifact_versions WHERE id=NEW.artifact_version_id AND account_id=NEW.account_id AND course_id=NEW.course_id AND artifact_id=NEW.artifact_id AND kind=NEW.artifact_kind;
  IF expected IS NULL OR expected<>jsonb_build_object('name',NEW.name,'engine',NEW.engine,'problem',NEW.problem,'trigger',NEW.trigger,'owner',NEW.owner,'approvedTools',NEW.approved_tools,'steps',NEW.steps,'humanReviewPoint',NEW.human_review_point,'safetyNotes',NEW.safety_notes,'baseline',NEW.baseline,'target',NEW.target,'lifecycleState',NEW.lifecycle_state,'testStatus',NEW.test_status,'launchDate',NEW.launch_date::text) THEN
    RAISE EXCEPTION 'IMPLEMENTATION_WORKFLOW_CONTENT_MISMATCH';
  END IF;
  RETURN NEW;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_workflow_content_match_v1() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER implementation_workflows_content_match BEFORE INSERT ON public.implementation_workflows FOR EACH ROW EXECUTE FUNCTION public.syntholo_implementation_workflow_content_match_v1();
--> statement-breakpoint
CREATE TABLE public.implementation_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, course_id uuid NOT NULL, course_completion_id uuid NOT NULL,
  membership_id uuid NOT NULL, enrollment_id uuid NOT NULL, course_version_id uuid NOT NULL,
  completed_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT implementation_completions_course_completion_fk FOREIGN KEY(course_completion_id,account_id,membership_id,enrollment_id,course_id,course_version_id) REFERENCES public.course_completions(id,account_id,membership_id,enrollment_id,course_id,course_version_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT implementation_completions_account_course_unique UNIQUE(account_id,course_id),
  CONSTRAINT implementation_completions_exact_unique UNIQUE(id,account_id,course_id)
);
--> statement-breakpoint
CREATE INDEX course_completions_implementation_lookup_idx ON public.course_completions(account_id,course_id,completed_at,id);
--> statement-breakpoint
CREATE TABLE public.implementation_completion_artifact_snapshots (
  completion_id uuid NOT NULL, account_id uuid NOT NULL, course_id uuid NOT NULL, artifact_id uuid NOT NULL, artifact_version_id uuid NOT NULL, kind text NOT NULL,
  CONSTRAINT implementation_completion_artifact_snapshots_pkey PRIMARY KEY(completion_id,artifact_id),
  CONSTRAINT implementation_completion_artifacts_completion_fk FOREIGN KEY(completion_id,account_id,course_id) REFERENCES public.implementation_completions(id,account_id,course_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT implementation_completion_artifacts_version_fk FOREIGN KEY(artifact_version_id,account_id,course_id,artifact_id,kind) REFERENCES public.implementation_artifact_versions(id,account_id,course_id,artifact_id,kind) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT implementation_completion_artifacts_kind_unique UNIQUE(completion_id,kind),
  CONSTRAINT implementation_completion_artifacts_version_unique UNIQUE(completion_id,artifact_id,artifact_version_id),
  CONSTRAINT implementation_completion_artifacts_kind_check CHECK(kind IN ('readiness_map','ai_policy','workflow_portfolio','enablement_checklist','roadmap'))
);
--> statement-breakpoint
CREATE TABLE public.implementation_completion_workflow_snapshots (
  completion_id uuid NOT NULL, account_id uuid NOT NULL, course_id uuid NOT NULL, artifact_id uuid NOT NULL, artifact_version_id uuid NOT NULL, workflow_id uuid NOT NULL,
  CONSTRAINT implementation_completion_workflow_snapshots_pkey PRIMARY KEY(completion_id,workflow_id),
  CONSTRAINT implementation_completion_workflows_completion_fk FOREIGN KEY(completion_id,account_id,course_id) REFERENCES public.implementation_completions(id,account_id,course_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT implementation_completion_workflows_artifact_snapshot_fk FOREIGN KEY(completion_id,artifact_id,artifact_version_id) REFERENCES public.implementation_completion_artifact_snapshots(completion_id,artifact_id,artifact_version_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT implementation_completion_workflows_workflow_fk FOREIGN KEY(account_id,course_id,artifact_id,artifact_version_id,workflow_id) REFERENCES public.implementation_workflows(account_id,course_id,artifact_id,artifact_version_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_immutable_row_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $f$ BEGIN RAISE EXCEPTION 'IMPLEMENTATION_IMMUTABLE'; END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_immutable_row_v1() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_root_head_guard_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $f$
BEGIN
  IF NEW.current_version<>OLD.current_version+1 OR NEW.current_version_id IS NULL OR NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'IMPLEMENTATION_HEAD_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_root_head_guard_v1() FROM PUBLIC;
--> statement-breakpoint
DO $immutability$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['implementation_artifact_versions','implementation_workflows','implementation_completions','implementation_completion_artifact_snapshots','implementation_completion_workflow_snapshots'] LOOP
    EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.syntholo_implementation_immutable_row_v1()',table_name,table_name);
  END LOOP;
  CREATE TRIGGER implementation_artifacts_identity_immutable BEFORE UPDATE ON public.implementation_artifacts FOR EACH ROW WHEN (OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.course_id IS DISTINCT FROM NEW.course_id OR OLD.seeded_from_account_course_access_id IS DISTINCT FROM NEW.seeded_from_account_course_access_id OR OLD.seeded_from_course_version_id IS DISTINCT FROM NEW.seeded_from_course_version_id OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.title IS DISTINCT FROM NEW.title OR OLD.created_at IS DISTINCT FROM NEW.created_at) EXECUTE FUNCTION public.syntholo_implementation_immutable_row_v1();
  CREATE TRIGGER implementation_artifacts_head_guard BEFORE UPDATE ON public.implementation_artifacts FOR EACH ROW EXECUTE FUNCTION public.syntholo_implementation_root_head_guard_v1();
  CREATE TRIGGER implementation_artifacts_delete_immutable BEFORE DELETE ON public.implementation_artifacts FOR EACH ROW EXECUTE FUNCTION public.syntholo_implementation_immutable_row_v1();
END $immutability$;
--> statement-breakpoint
ALTER TABLE public.implementation_artifacts ENABLE ROW LEVEL SECURITY; ALTER TABLE public.implementation_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.implementation_artifact_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE public.implementation_artifact_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.implementation_workflows ENABLE ROW LEVEL SECURITY; ALTER TABLE public.implementation_workflows FORCE ROW LEVEL SECURITY;
ALTER TABLE public.implementation_completions ENABLE ROW LEVEL SECURITY; ALTER TABLE public.implementation_completions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.implementation_completion_artifact_snapshots ENABLE ROW LEVEL SECURITY; ALTER TABLE public.implementation_completion_artifact_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE public.implementation_completion_workflow_snapshots ENABLE ROW LEVEL SECURITY; ALTER TABLE public.implementation_completion_workflow_snapshots FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY implementation_artifacts_migrator ON public.implementation_artifacts FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY implementation_artifact_versions_migrator ON public.implementation_artifact_versions FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY implementation_workflows_migrator ON public.implementation_workflows FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY implementation_completions_migrator ON public.implementation_completions FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY implementation_completion_artifact_snapshots_migrator ON public.implementation_completion_artifact_snapshots FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY implementation_completion_workflow_snapshots_migrator ON public.implementation_completion_workflow_snapshots FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
--> statement-breakpoint
GRANT ALL ON public.implementation_artifacts,public.implementation_artifact_versions,public.implementation_workflows,public.implementation_completions,public.implementation_completion_artifact_snapshots,public.implementation_completion_workflow_snapshots TO syntholo_migrator;
REVOKE ALL ON public.implementation_artifacts,public.implementation_artifact_versions,public.implementation_workflows,public.implementation_completions,public.implementation_completion_artifact_snapshots,public.implementation_completion_workflow_snapshots FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker,syntholo_system_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_seed_workspace_v1(p_account_course_access_id uuid) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE source public.account_course_accesses; inserted_count integer;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF current_setting('app.actor_kind',true)<>'system' OR nullif(current_setting('app.actor_id',true),'') IS NULL OR nullif(current_setting('app.correlation_id',true),'')::uuid IS NULL THEN RAISE EXCEPTION 'IMPLEMENTATION_SYSTEM_CONTEXT_REQUIRED'; END IF;
  SELECT * INTO source FROM public.account_course_accesses WHERE id=p_account_course_access_id AND status='active' FOR SHARE;
  IF source.id IS NULL THEN RAISE EXCEPTION 'IMPLEMENTATION_ACCESS_INVALID'; END IF;
  INSERT INTO public.implementation_artifacts(account_id,course_id,seeded_from_account_course_access_id,seeded_from_course_version_id,kind,title)
  SELECT source.account_id,source.course_id,source.id,source.course_version_id,v.kind,v.title FROM (VALUES
    ('readiness_map','Readiness and opportunity map'),('ai_policy','Team AI policy'),('workflow_portfolio','Workflow portfolio'),('enablement_checklist','Team enablement checklist'),('roadmap','90-day roadmap')
  ) v(kind,title) ON CONFLICT(account_id,course_id,kind) DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  IF (SELECT count(*) FROM public.implementation_artifacts WHERE account_id=source.account_id AND course_id=source.course_id)<>5 THEN RAISE EXCEPTION 'IMPLEMENTATION_SEED_INTEGRITY'; END IF;
  RETURN CASE WHEN inserted_count=0 THEN 'duplicate' ELSE 'seeded' END;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_seed_workspace_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_implementation_seed_workspace_v1(uuid) TO syntholo_system_api;
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
WITH source AS (
  SELECT DISTINCT ON (account_id,course_id) id,account_id,course_id,course_version_id FROM public.account_course_accesses WHERE status='active' ORDER BY account_id,course_id,created_at,id
)
INSERT INTO public.implementation_artifacts(account_id,course_id,seeded_from_account_course_access_id,seeded_from_course_version_id,kind,title)
SELECT source.account_id,source.course_id,source.id,source.course_version_id,v.kind,v.title FROM source CROSS JOIN (VALUES
  ('readiness_map','Readiness and opportunity map'),('ai_policy','Team AI policy'),('workflow_portfolio','Workflow portfolio'),('enablement_checklist','Team enablement checklist'),('roadmap','90-day roadmap')
) v(kind,title) ON CONFLICT(account_id,course_id,kind) DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_list_v1() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor_account uuid:=nullif(current_setting('app.account_id',true),'')::uuid; actor_membership uuid:=nullif(current_setting('app.membership_id',true),'')::uuid; actor_identity uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; actor_course uuid; active_count integer; result jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api');
  IF current_setting('app.actor_kind',true)<>'member' OR actor_account IS NULL OR actor_membership IS NULL OR actor_identity IS NULL OR nullif(current_setting('app.correlation_id',true),'')::uuid IS NULL THEN RAISE EXCEPTION 'IMPLEMENTATION_MEMBER_CONTEXT_REQUIRED'; END IF;
  SELECT count(DISTINCT a.course_id),(array_agg(DISTINCT a.course_id ORDER BY a.course_id))[1] INTO active_count,actor_course FROM public.implementation_artifacts a JOIN public.enrollments e ON e.account_id=a.account_id AND e.course_id=a.course_id AND e.membership_id=actor_membership AND e.status='active' JOIN public.memberships m ON m.id=e.membership_id AND m.account_id=e.account_id AND m.member_identity_id=actor_identity AND m.status='active' JOIN public.account_course_accesses aca ON aca.id=e.account_course_access_id AND aca.account_id=e.account_id AND aca.course_id=e.course_id AND aca.course_version_id=e.course_version_id AND aca.status='active' WHERE a.account_id=actor_account;
  IF active_count<>1 THEN RAISE EXCEPTION 'IMPLEMENTATION_NOT_FOUND'; END IF;
  SELECT jsonb_build_object('schemaVersion',1,'items',jsonb_agg(jsonb_build_object('id',a.id,'kind',a.kind,'title',a.title,'currentVersion',a.current_version,'currentState',v.state,'currentVersionId',a.current_version_id,'updatedAt',CASE WHEN v.id IS NULL THEN NULL ELSE to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'authorLabel',CASE WHEN v.id IS NULL THEN NULL WHEN v.creator_membership_id=actor_membership THEN 'You' ELSE 'A teammate' END) ORDER BY array_position(ARRAY['readiness_map','ai_policy','workflow_portfolio','enablement_checklist','roadmap'],a.kind)),'nextCursor',NULL,'implementationCompletion',jsonb_build_object('completed',c.id IS NOT NULL,'completedAt',CASE WHEN c.id IS NULL THEN NULL ELSE to_char(c.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END)) INTO result FROM public.implementation_artifacts a LEFT JOIN public.implementation_artifact_versions v ON v.id=a.current_version_id LEFT JOIN public.implementation_completions c ON c.account_id=a.account_id AND c.course_id=a.course_id WHERE a.account_id=actor_account AND a.course_id=actor_course GROUP BY c.id,c.completed_at;
  IF jsonb_array_length(result->'items')<>5 THEN RAISE EXCEPTION 'IMPLEMENTATION_NOT_FOUND'; END IF;
  RETURN result;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_list_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_implementation_list_v1() TO syntholo_member_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_get_v1(p_artifact_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor_account uuid:=nullif(current_setting('app.account_id',true),'')::uuid; actor_membership uuid:=nullif(current_setting('app.membership_id',true),'')::uuid; actor_identity uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; root public.implementation_artifacts; version_row public.implementation_artifact_versions;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api');
  IF current_setting('app.actor_kind',true)<>'member' OR actor_account IS NULL OR actor_membership IS NULL OR actor_identity IS NULL OR nullif(current_setting('app.correlation_id',true),'')::uuid IS NULL THEN RAISE EXCEPTION 'IMPLEMENTATION_MEMBER_CONTEXT_REQUIRED'; END IF;
  SELECT a.* INTO root FROM public.implementation_artifacts a WHERE a.id=p_artifact_id AND a.account_id=actor_account;
  IF root.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.enrollments e JOIN public.memberships m ON m.id=e.membership_id AND m.account_id=e.account_id AND m.member_identity_id=actor_identity AND m.status='active' JOIN public.account_course_accesses aca ON aca.id=e.account_course_access_id AND aca.account_id=e.account_id AND aca.course_id=e.course_id AND aca.course_version_id=e.course_version_id AND aca.status='active' WHERE e.account_id=actor_account AND e.membership_id=actor_membership AND e.course_id=root.course_id AND e.status='active') THEN RAISE EXCEPTION 'IMPLEMENTATION_NOT_FOUND'; END IF;
  IF root.current_version_id IS NOT NULL THEN SELECT * INTO version_row FROM public.implementation_artifact_versions WHERE id=root.current_version_id; END IF;
  RETURN jsonb_build_object('schemaVersion',1,'artifact',jsonb_build_object('id',root.id,'kind',root.kind,'title',root.title,'currentVersion',root.current_version,'currentState',version_row.state,'currentVersionId',root.current_version_id,'updatedAt',CASE WHEN version_row.id IS NULL THEN NULL ELSE to_char(version_row.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'authorLabel',CASE WHEN version_row.id IS NULL THEN NULL WHEN version_row.creator_membership_id=actor_membership THEN 'You' ELSE 'A teammate' END),'content',version_row.content);
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_get_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_implementation_get_v1(uuid) TO syntholo_member_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_versions_v1(p_artifact_id uuid,p_before_created_at timestamptz,p_before_id uuid,p_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor_account uuid:=nullif(current_setting('app.account_id',true),'')::uuid; actor_membership uuid:=nullif(current_setting('app.membership_id',true),'')::uuid; actor_identity uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; root public.implementation_artifacts; result jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api');
  IF current_setting('app.actor_kind',true)<>'member' OR actor_account IS NULL OR actor_membership IS NULL OR actor_identity IS NULL OR nullif(current_setting('app.correlation_id',true),'')::uuid IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR ((p_before_created_at IS NULL)<>(p_before_id IS NULL)) THEN RAISE EXCEPTION 'IMPLEMENTATION_MEMBER_CONTEXT_REQUIRED'; END IF;
  SELECT a.* INTO root FROM public.implementation_artifacts a WHERE a.id=p_artifact_id AND a.account_id=actor_account;
  IF root.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.enrollments e JOIN public.memberships m ON m.id=e.membership_id AND m.account_id=e.account_id AND m.member_identity_id=actor_identity AND m.status='active' JOIN public.account_course_accesses aca ON aca.id=e.account_course_access_id AND aca.account_id=e.account_id AND aca.course_id=e.course_id AND aca.course_version_id=e.course_version_id AND aca.status='active' WHERE e.account_id=actor_account AND e.membership_id=actor_membership AND e.course_id=root.course_id AND e.status='active') THEN RAISE EXCEPTION 'IMPLEMENTATION_NOT_FOUND'; END IF;
  WITH page AS (SELECT v.* FROM public.implementation_artifact_versions v WHERE v.artifact_id=root.id AND (p_before_created_at IS NULL OR (v.created_at,v.id)<(p_before_created_at,p_before_id)) ORDER BY v.created_at DESC,v.id DESC LIMIT p_limit+1), visible AS (SELECT * FROM page ORDER BY created_at DESC,id DESC LIMIT p_limit)
  SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'version',v.version,'state',v.state,'contentHash',v.content_hash,'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'authorLabel',CASE WHEN v.creator_membership_id=actor_membership THEN 'You' ELSE 'A teammate' END) ORDER BY v.created_at DESC,v.id DESC) FROM visible v),'[]'::jsonb),'hasMore',(SELECT count(*)>p_limit FROM page),'nextCreatedAt',(SELECT to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM visible v ORDER BY v.created_at,v.id LIMIT 1),'nextId',(SELECT v.id FROM visible v ORDER BY v.created_at,v.id LIMIT 1)) INTO result;
  RETURN result;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_versions_v1(uuid,timestamptz,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_implementation_versions_v1(uuid,timestamptz,uuid,integer) TO syntholo_member_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_recompute_completion_v1(p_account_id uuid,p_course_id uuid,p_actor_type text,p_actor_id text,p_correlation_id uuid) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE personal public.course_completions; created public.implementation_completions; final_count integer; live_count integer; locked_root_count integer; portfolio_artifact uuid; portfolio_version uuid; now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); event_id uuid;
BEGIN
  IF p_actor_type NOT IN ('member','system') OR p_actor_id IS NULL OR octet_length(p_actor_id) NOT BETWEEN 1 AND 255 OR p_correlation_id IS NULL THEN RAISE EXCEPTION 'IMPLEMENTATION_RECOMPUTE_CONTEXT_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('implementation:completion:'||p_account_id::text||':'||p_course_id::text,0));
  SELECT * INTO created FROM public.implementation_completions WHERE account_id=p_account_id AND course_id=p_course_id;
  IF created.id IS NOT NULL THEN RETURN created.id; END IF;
  PERFORM id FROM public.implementation_artifacts WHERE account_id=p_account_id AND course_id=p_course_id ORDER BY kind,id FOR SHARE;
  GET DIAGNOSTICS locked_root_count=ROW_COUNT;
  IF locked_root_count<>5 THEN RETURN NULL; END IF;
  SELECT * INTO personal FROM public.course_completions WHERE account_id=p_account_id AND course_id=p_course_id ORDER BY completed_at,id LIMIT 1;
  IF personal.id IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO final_count FROM public.implementation_artifacts a JOIN public.implementation_artifact_versions v ON v.id=a.current_version_id AND v.account_id=a.account_id AND v.course_id=a.course_id AND v.artifact_id=a.id AND v.version=a.current_version WHERE a.account_id=p_account_id AND a.course_id=p_course_id AND v.state='final';
  IF final_count<>5 THEN RETURN NULL; END IF;
  SELECT a.id,v.id INTO portfolio_artifact,portfolio_version FROM public.implementation_artifacts a JOIN public.implementation_artifact_versions v ON v.id=a.current_version_id AND v.account_id=a.account_id AND v.course_id=a.course_id AND v.artifact_id=a.id AND v.version=a.current_version WHERE a.account_id=p_account_id AND a.course_id=p_course_id AND a.kind='workflow_portfolio' AND v.state='final';
  IF portfolio_artifact IS NULL OR portfolio_version IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO live_count FROM public.implementation_workflows w WHERE w.account_id=p_account_id AND w.course_id=p_course_id AND w.artifact_id=portfolio_artifact AND w.artifact_version_id=portfolio_version AND w.lifecycle_state='live' AND w.test_status='passed' AND w.launch_date IS NOT NULL;
  IF live_count<>3 OR (SELECT count(*) FROM public.implementation_workflows w WHERE w.artifact_version_id=portfolio_version)<>3 THEN RETURN NULL; END IF;
  INSERT INTO public.implementation_completions(account_id,course_id,course_completion_id,membership_id,enrollment_id,course_version_id,completed_at) VALUES(p_account_id,p_course_id,personal.id,personal.membership_id,personal.enrollment_id,personal.course_version_id,now_at) ON CONFLICT(account_id,course_id) DO NOTHING RETURNING * INTO created;
  IF created.id IS NULL THEN SELECT * INTO created FROM public.implementation_completions WHERE account_id=p_account_id AND course_id=p_course_id; RETURN created.id; END IF;
  INSERT INTO public.implementation_completion_artifact_snapshots(completion_id,account_id,course_id,artifact_id,artifact_version_id,kind) SELECT created.id,a.account_id,a.course_id,a.id,a.current_version_id,a.kind FROM public.implementation_artifacts a WHERE a.account_id=p_account_id AND a.course_id=p_course_id ORDER BY a.kind;
  INSERT INTO public.implementation_completion_workflow_snapshots(completion_id,account_id,course_id,artifact_id,artifact_version_id,workflow_id) SELECT created.id,w.account_id,w.course_id,w.artifact_id,w.artifact_version_id,w.id FROM public.implementation_workflows w WHERE w.artifact_version_id=portfolio_version ORDER BY w.ordinal;
  IF (SELECT count(*) FROM public.implementation_completion_artifact_snapshots WHERE completion_id=created.id)<>5 OR (SELECT count(*) FROM public.implementation_completion_workflow_snapshots WHERE completion_id=created.id)<>3 THEN RAISE EXCEPTION 'IMPLEMENTATION_COMPLETION_INTEGRITY'; END IF;
  event_id:=gen_random_uuid();
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at) VALUES(gen_random_uuid(),p_account_id,p_actor_type,p_actor_id,'implementation_program_completed','implementation_completion',created.id::text,p_correlation_id,jsonb_build_object('completionId',created.id,'courseId',created.course_id,'courseCompletionId',created.course_completion_id),now_at);
  INSERT INTO public.outbox_events(event_id,account_id,type,aggregate_id,payload,schema_version,status,attempts,available_at,created_at,occurred_at,actor_type,actor_id,correlation_id,max_attempts,claim_generation) VALUES(event_id,p_account_id,'implementation.program_completed.v1',created.id::text,jsonb_build_object('completionId',created.id,'courseId',created.course_id,'courseCompletionId',created.course_completion_id),1,'pending',0,now_at,now_at,now_at,p_actor_type,p_actor_id,p_correlation_id,10,0);
  RETURN created.id;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_recompute_completion_v1(uuid,uuid,text,text,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_save_version_v1(p_artifact_id uuid,p_expected_version integer,p_state text,p_content jsonb,p_idempotency_key text,p_request_hash text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor_account uuid:=nullif(current_setting('app.account_id',true),'')::uuid; actor_membership uuid:=nullif(current_setting('app.membership_id',true),'')::uuid; actor_identity uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid; root public.implementation_artifacts; receipt public.api_command_receipts; inserted_receipt uuid; created public.implementation_artifact_versions; canonical text; derived_hash text; expected_request_hash text; now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); completion_id uuid; completion_at timestamptz; response_payload jsonb; workflow jsonb; ordinal integer:=0; event_id uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api');
  IF current_setting('app.actor_kind',true)<>'member' OR actor_account IS NULL OR actor_membership IS NULL OR actor_identity IS NULL OR correlation IS NULL THEN RAISE EXCEPTION 'IMPLEMENTATION_MEMBER_CONTEXT_REQUIRED'; END IF;
  SELECT a.* INTO root FROM public.implementation_artifacts a WHERE a.id=p_artifact_id AND a.account_id=actor_account;
  IF root.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.enrollments e JOIN public.memberships m ON m.id=e.membership_id AND m.account_id=e.account_id AND m.member_identity_id=actor_identity AND m.status='active' JOIN public.account_course_accesses aca ON aca.id=e.account_course_access_id AND aca.account_id=e.account_id AND aca.course_id=e.course_id AND aca.course_version_id=e.course_version_id AND aca.status='active' WHERE e.account_id=actor_account AND e.membership_id=actor_membership AND e.course_id=root.course_id AND e.status='active') THEN RAISE EXCEPTION 'IMPLEMENTATION_NOT_FOUND'; END IF;
  PERFORM 1 FROM public.memberships m JOIN public.enrollments e ON e.membership_id=m.id AND e.account_id=m.account_id JOIN public.account_course_accesses aca ON aca.id=e.account_course_access_id AND aca.account_id=e.account_id AND aca.course_id=e.course_id AND aca.course_version_id=e.course_version_id WHERE m.id=actor_membership AND m.account_id=actor_account AND m.member_identity_id=actor_identity AND m.status='active' AND e.course_id=root.course_id AND e.status='active' AND aca.status='active' FOR SHARE OF m,e,aca;
  IF NOT FOUND THEN RAISE EXCEPTION 'IMPLEMENTATION_NOT_FOUND'; END IF;
  IF p_expected_version NOT BETWEEN 0 AND 2147483646 OR p_state NOT IN ('draft','final') OR p_content->>'kind'<>root.kind OR NOT public.syntholo_implementation_content_valid_v1(root.kind,p_state,p_content) OR p_idempotency_key !~ '^[A-Za-z0-9._~-]{16,128}$' OR p_request_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'IMPLEMENTATION_COMMAND_INVALID'; END IF;
  canonical:=public.syntholo_canonical_jsonb_text_v1(p_content); derived_hash:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
  expected_request_hash:=encode(sha256(convert_to(public.syntholo_canonical_jsonb_text_v1(jsonb_build_object('artifactId',p_artifact_id,'expectedVersion',p_expected_version,'state',p_state,'content',p_content)),'UTF8')),'hex');
  IF p_request_hash<>expected_request_hash THEN RAISE EXCEPTION 'IMPLEMENTATION_COMMAND_INVALID'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('implementation:receipt:member:'||actor_identity::text||':POST:/v1/member/artifacts/:artifactId/versions:'||p_idempotency_key,0)) THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS'; END IF;
  INSERT INTO public.api_command_receipts(principal_kind,principal_id,method,route_template,idempotency_key,request_hash,status,expires_at,created_at) VALUES('member',actor_identity::text,'POST','/v1/member/artifacts/:artifactId/versions',p_idempotency_key,p_request_hash,'in_progress',now_at+interval '30 days',now_at) ON CONFLICT(principal_kind,principal_id,method,route_template,idempotency_key) DO NOTHING RETURNING id INTO inserted_receipt;
  SELECT * INTO receipt FROM public.api_command_receipts WHERE principal_kind='member' AND principal_id=actor_identity::text AND method='POST' AND route_template='/v1/member/artifacts/:artifactId/versions' AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF receipt.id IS NULL OR receipt.request_hash<>p_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'; END IF;
  IF receipt.status='completed' THEN RETURN receipt.response; END IF;
  IF inserted_receipt IS NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('implementation:completion:'||root.account_id::text||':'||root.course_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('implementation:artifact:'||root.id::text,0));
  SELECT * INTO root FROM public.implementation_artifacts WHERE id=root.id FOR UPDATE;
  IF root.current_version<>p_expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING DETAIL=root.current_version::text; END IF;
  INSERT INTO public.implementation_artifact_versions(account_id,course_id,artifact_id,kind,version,state,content,canonical_json,content_hash,creator_membership_id,source_command_receipt_id,created_at) VALUES(root.account_id,root.course_id,root.id,root.kind,root.current_version+1,p_state,p_content,canonical,derived_hash,actor_membership,receipt.id,now_at) RETURNING * INTO created;
  IF root.kind='workflow_portfolio' THEN
    FOR workflow IN SELECT value FROM jsonb_array_elements(p_content->'workflows') LOOP ordinal:=ordinal+1; INSERT INTO public.implementation_workflows(account_id,course_id,artifact_id,artifact_version_id,ordinal,name,engine,problem,trigger,owner,approved_tools,steps,human_review_point,safety_notes,baseline,target,lifecycle_state,test_status,launch_date,created_at) VALUES(root.account_id,root.course_id,root.id,created.id,ordinal,workflow->>'name',workflow->>'engine',workflow->>'problem',workflow->>'trigger',workflow->>'owner',workflow->'approvedTools',workflow->'steps',workflow->>'humanReviewPoint',workflow->>'safetyNotes',workflow->>'baseline',workflow->>'target',workflow->>'lifecycleState',workflow->>'testStatus',(workflow->>'launchDate')::date,now_at); END LOOP;
  END IF;
  UPDATE public.implementation_artifacts SET current_version=created.version,current_version_id=created.id,updated_at=now_at WHERE id=root.id;
  completion_id:=public.syntholo_implementation_recompute_completion_v1(root.account_id,root.course_id,'member',actor_identity::text,correlation);
  IF completion_id IS NOT NULL THEN SELECT completed_at INTO completion_at FROM public.implementation_completions WHERE id=completion_id; END IF;
  event_id:=gen_random_uuid();
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at) VALUES(gen_random_uuid(),root.account_id,'member',actor_identity::text,'implementation_artifact_version_saved','implementation_artifact_version',created.id::text,correlation,jsonb_build_object('artifactId',root.id,'artifactVersionId',created.id,'version',created.version,'state',created.state),now_at);
  INSERT INTO public.outbox_events(event_id,account_id,type,aggregate_id,payload,schema_version,status,attempts,available_at,created_at,occurred_at,actor_type,actor_id,correlation_id,max_attempts,claim_generation) VALUES(event_id,root.account_id,'implementation.artifact_version_saved.v1',created.id::text,jsonb_build_object('artifactId',root.id,'artifactVersionId',created.id,'version',created.version,'state',created.state),1,'pending',0,now_at,now_at,now_at,'member',actor_identity::text,correlation,10,0);
  response_payload:=jsonb_build_object('schemaVersion',1,'artifact',jsonb_build_object('id',root.id,'kind',root.kind,'title',root.title,'currentVersion',created.version,'currentState',created.state,'currentVersionId',created.id,'updatedAt',to_char(created.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'authorLabel','You'),'version',jsonb_build_object('id',created.id,'version',created.version,'state',created.state,'contentHash',created.content_hash,'createdAt',to_char(created.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'authorLabel','You'),'content',created.content,'implementationCompletion',jsonb_build_object('completed',completion_id IS NOT NULL,'completedAt',CASE WHEN completion_id IS NULL THEN NULL ELSE to_char(completion_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END));
  UPDATE public.api_command_receipts AS command_receipt SET status='completed',response_status=201,response=response_payload,completed_at=now_at WHERE command_receipt.id=receipt.id;
  RETURN response_payload;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_save_version_v1(uuid,integer,text,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_implementation_save_version_v1(uuid,integer,text,jsonb,text,text) TO syntholo_member_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_record_course_completion_v1(p_event_id uuid,p_handler_name text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE source_event public.outbox_events; personal public.course_completions; existing uuid; recomputed uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_worker');
  IF p_event_id IS NULL OR p_handler_name<>'implementation.completion_recompute' THEN RAISE EXCEPTION 'IMPLEMENTATION_EVENT_INPUT_INVALID'; END IF;
  SELECT * INTO source_event FROM public.outbox_events o WHERE o.event_id=p_event_id AND o.type='learning.course_completed.v1' AND o.schema_version=1 AND o.actor_type='member' AND o.correlation_id IS NOT NULL AND jsonb_typeof(o.payload)='object' AND o.payload ?& ARRAY['courseCompletionId','accountId','membershipId','enrollmentId','courseId','courseVersionId'] AND o.payload-ARRAY['courseCompletionId','accountId','membershipId','enrollmentId','courseId','courseVersionId']::text[]='{}'::jsonb AND o.account_id=CASE WHEN o.payload->>'accountId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN (o.payload->>'accountId')::uuid ELSE NULL END AND o.aggregate_id=o.payload->>'courseCompletionId';
  IF source_event.event_id IS NULL THEN RAISE EXCEPTION 'IMPLEMENTATION_EVENT_INPUT_INVALID'; END IF;
  SELECT c.* INTO personal FROM public.course_completions c JOIN public.memberships member_identity ON member_identity.id=c.membership_id AND member_identity.account_id=c.account_id WHERE c.id=CASE WHEN source_event.payload->>'courseCompletionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN (source_event.payload->>'courseCompletionId')::uuid ELSE NULL END AND source_event.account_id=c.account_id AND source_event.actor_id=member_identity.member_identity_id::text AND source_event.payload->>'accountId'=c.account_id::text AND source_event.payload->>'membershipId'=c.membership_id::text AND source_event.payload->>'enrollmentId'=c.enrollment_id::text AND source_event.payload->>'courseId'=c.course_id::text AND source_event.payload->>'courseVersionId'=c.course_version_id::text;
  IF personal.id IS NULL THEN RAISE EXCEPTION 'IMPLEMENTATION_EVENT_INPUT_INVALID'; END IF;
  SELECT id INTO existing FROM public.implementation_completions WHERE account_id=personal.account_id AND course_id=personal.course_id;
  recomputed:=public.syntholo_implementation_recompute_completion_v1(personal.account_id,personal.course_id,'system','implementation-worker',source_event.correlation_id);
  RETURN CASE WHEN existing IS NOT NULL OR recomputed IS NULL THEN 'duplicate' ELSE 'recorded' END;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_implementation_record_course_completion_v1(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_implementation_record_course_completion_v1(uuid,text) TO syntholo_worker;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_implementation_readiness_v1() RETURNS TABLE(
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
  expected_runtime_attestation(signature,body_hash) AS (VALUES ('public.syntholo_attest_runtime_capability(text)','d09fc0427dba8e1cd0fcb23cfd0933859749de01c50a9ccf340087dfef046717')),
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
REVOKE ALL ON FUNCTION public.syntholo_implementation_readiness_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_implementation_readiness_v1() TO syntholo_migrator,syntholo_member_api,syntholo_staff_api,syntholo_worker,syntholo_system_api;
