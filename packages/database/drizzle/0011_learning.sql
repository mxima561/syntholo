CREATE TABLE public.account_course_accesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  entitlement_source_id uuid NOT NULL,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  course_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CONSTRAINT account_course_accesses_status_check CHECK(status IN ('active','revoked')),
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT account_course_accesses_source_account_fk FOREIGN KEY(entitlement_source_id,account_id) REFERENCES public.entitlement_sources(id,account_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT account_course_accesses_version_course_fk FOREIGN KEY(course_version_id,course_id) REFERENCES public.course_versions(id,course_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT account_course_accesses_exact_unique UNIQUE(id,account_id,course_id,course_version_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX account_course_accesses_active_source_version_unique ON public.account_course_accesses(account_id,entitlement_source_id,course_id,course_version_id) WHERE status='active';
--> statement-breakpoint
CREATE TABLE public.enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  account_course_access_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  course_id uuid NOT NULL,
  course_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CONSTRAINT enrollments_status_check CHECK(status IN ('active','revoked')),
  enrolled_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  revoked_at timestamptz(3),
  CONSTRAINT enrollments_membership_account_fk FOREIGN KEY(membership_id,account_id) REFERENCES public.memberships(id,account_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT enrollments_access_exact_fk FOREIGN KEY(account_course_access_id,account_id,course_id,course_version_id) REFERENCES public.account_course_accesses(id,account_id,course_id,course_version_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT enrollments_exact_unique UNIQUE(id,account_id,membership_id,course_id,course_version_id),
  CONSTRAINT enrollments_transition_target_unique UNIQUE(id,account_id,membership_id,course_id),
  CONSTRAINT enrollments_status_time_check CHECK((status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX enrollments_one_active_course_unique ON public.enrollments(account_id,membership_id,course_id) WHERE status='active';
--> statement-breakpoint
CREATE TABLE public.enrollment_version_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, membership_id uuid NOT NULL, course_id uuid NOT NULL,
  from_enrollment_id uuid NOT NULL, to_enrollment_id uuid NOT NULL UNIQUE,
  actor_type text NOT NULL CONSTRAINT enrollment_transitions_actor_check CHECK(actor_type IN ('member','staff','system')), actor_id text NOT NULL,
  reason text NOT NULL CONSTRAINT enrollment_transitions_reason_check CHECK(octet_length(reason) BETWEEN 1 AND 1000), transitioned_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT enrollment_transitions_from_fk FOREIGN KEY(from_enrollment_id,account_id,membership_id,course_id) REFERENCES public.enrollments(id,account_id,membership_id,course_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT enrollment_transitions_to_fk FOREIGN KEY(to_enrollment_id,account_id,membership_id,course_id) REFERENCES public.enrollments(id,account_id,membership_id,course_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT enrollment_transitions_distinct_check CHECK(from_enrollment_id<>to_enrollment_id)
);
--> statement-breakpoint
CREATE TABLE public.lesson_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, membership_id uuid NOT NULL,
  enrollment_id uuid NOT NULL, course_id uuid NOT NULL, course_version_id uuid NOT NULL,
  lesson_id uuid NOT NULL, lesson_version_id uuid NOT NULL,
  last_path text NOT NULL CONSTRAINT lesson_progress_last_path_check CHECK(last_path IN ('video','transcript')),
  video_seconds integer, transcript_block_id text,
  revision integer NOT NULL DEFAULT 1 CONSTRAINT lesson_progress_revision_check CHECK(revision>=1),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT lesson_progress_enrollment_fk FOREIGN KEY(enrollment_id,account_id,membership_id,course_id,course_version_id) REFERENCES public.enrollments(id,account_id,membership_id,course_id,course_version_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT lesson_progress_manifest_fk FOREIGN KEY(course_version_id,course_id,lesson_id,lesson_version_id) REFERENCES public.course_version_lessons(course_version_id,course_id,lesson_id,lesson_version_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT lesson_progress_enrollment_lesson_unique UNIQUE(enrollment_id,lesson_id),
  CONSTRAINT lesson_progress_position_check CHECK((last_path='video' AND video_seconds BETWEEN 0 AND 86400 AND transcript_block_id IS NULL) OR (last_path='transcript' AND video_seconds IS NULL AND octet_length(transcript_block_id) BETWEEN 1 AND 128))
);
--> statement-breakpoint
CREATE INDEX lesson_progress_actor_idx ON public.lesson_progress(account_id,membership_id);
--> statement-breakpoint
ALTER TABLE public.lesson_versions ADD COLUMN source_draft_revision integer CONSTRAINT lesson_versions_source_draft_revision_check CHECK(source_draft_revision IS NULL OR source_draft_revision>0);
CREATE UNIQUE INDEX lesson_versions_source_draft_unique ON public.lesson_versions(lesson_id,source_draft_revision) WHERE source_draft_revision IS NOT NULL;
--> statement-breakpoint
CREATE TABLE public.lesson_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, membership_id uuid NOT NULL,
  enrollment_id uuid NOT NULL, course_id uuid NOT NULL, course_version_id uuid NOT NULL,
  lesson_id uuid NOT NULL, lesson_version_id uuid NOT NULL,
  method text NOT NULL CONSTRAINT lesson_completions_method_check CHECK(method IN ('video','transcript','mixed')),
  source_command_receipt_id uuid NOT NULL UNIQUE REFERENCES public.api_command_receipts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  completed_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT lesson_completions_enrollment_fk FOREIGN KEY(enrollment_id,account_id,membership_id,course_id,course_version_id) REFERENCES public.enrollments(id,account_id,membership_id,course_id,course_version_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT lesson_completions_manifest_fk FOREIGN KEY(course_version_id,course_id,lesson_id,lesson_version_id) REFERENCES public.course_version_lessons(course_version_id,course_id,lesson_id,lesson_version_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT lesson_completions_enrollment_lesson_unique UNIQUE(enrollment_id,lesson_id),
  CONSTRAINT lesson_completions_exact_unique UNIQUE(id,account_id,membership_id,enrollment_id,course_id,course_version_id)
);
--> statement-breakpoint
CREATE TABLE public.course_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, membership_id uuid NOT NULL,
  enrollment_id uuid NOT NULL, course_id uuid NOT NULL, course_version_id uuid NOT NULL,
  required_lesson_set_hash text NOT NULL CONSTRAINT course_completions_hash_check CHECK(required_lesson_set_hash ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT course_completions_enrollment_fk FOREIGN KEY(enrollment_id,account_id,membership_id,course_id,course_version_id) REFERENCES public.enrollments(id,account_id,membership_id,course_id,course_version_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT course_completions_enrollment_unique UNIQUE(enrollment_id),
  CONSTRAINT course_completions_exact_unique UNIQUE(id,account_id,membership_id,enrollment_id,course_id,course_version_id)
);
--> statement-breakpoint
CREATE TABLE public.certificate_prerequisites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), course_completion_id uuid NOT NULL UNIQUE,
  account_id uuid NOT NULL, membership_id uuid NOT NULL, enrollment_id uuid NOT NULL, course_id uuid NOT NULL, course_version_id uuid NOT NULL,
  recorded_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT certificate_prerequisites_completion_fk FOREIGN KEY(course_completion_id,account_id,membership_id,enrollment_id,course_id,course_version_id) REFERENCES public.course_completions(id,account_id,membership_id,enrollment_id,course_id,course_version_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE FUNCTION public.syntholo_learning_immutable_row() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $f$ BEGIN RAISE EXCEPTION 'LEARNING_IMMUTABLE'; END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_learning_immutable_row() FROM PUBLIC;
--> statement-breakpoint
DO $immutability$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['enrollment_version_transitions','lesson_completions','course_completions','certificate_prerequisites'] LOOP
    EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.syntholo_learning_immutable_row()',table_name,table_name);
  END LOOP;
  CREATE TRIGGER enrollments_identity_immutable BEFORE UPDATE ON public.enrollments FOR EACH ROW WHEN (OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.account_course_access_id IS DISTINCT FROM NEW.account_course_access_id OR OLD.membership_id IS DISTINCT FROM NEW.membership_id OR OLD.course_id IS DISTINCT FROM NEW.course_id OR OLD.course_version_id IS DISTINCT FROM NEW.course_version_id OR OLD.enrolled_at IS DISTINCT FROM NEW.enrolled_at) EXECUTE FUNCTION public.syntholo_learning_immutable_row();
  CREATE TRIGGER account_course_accesses_identity_immutable BEFORE UPDATE ON public.account_course_accesses FOR EACH ROW WHEN (OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.entitlement_source_id IS DISTINCT FROM NEW.entitlement_source_id OR OLD.course_id IS DISTINCT FROM NEW.course_id OR OLD.course_version_id IS DISTINCT FROM NEW.course_version_id OR OLD.created_at IS DISTINCT FROM NEW.created_at) EXECUTE FUNCTION public.syntholo_learning_immutable_row();
  CREATE TRIGGER lesson_progress_identity_immutable BEFORE UPDATE ON public.lesson_progress FOR EACH ROW WHEN (OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.membership_id IS DISTINCT FROM NEW.membership_id OR OLD.enrollment_id IS DISTINCT FROM NEW.enrollment_id OR OLD.course_id IS DISTINCT FROM NEW.course_id OR OLD.course_version_id IS DISTINCT FROM NEW.course_version_id OR OLD.lesson_id IS DISTINCT FROM NEW.lesson_id OR OLD.lesson_version_id IS DISTINCT FROM NEW.lesson_version_id) EXECUTE FUNCTION public.syntholo_learning_immutable_row();
END $immutability$;
--> statement-breakpoint
ALTER TABLE public.account_course_accesses ENABLE ROW LEVEL SECURITY; ALTER TABLE public.account_course_accesses FORCE ROW LEVEL SECURITY;
ALTER TABLE public.enrollments ENABLE ROW LEVEL SECURITY; ALTER TABLE public.enrollments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.enrollment_version_transitions ENABLE ROW LEVEL SECURITY; ALTER TABLE public.enrollment_version_transitions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.lesson_progress ENABLE ROW LEVEL SECURITY; ALTER TABLE public.lesson_progress FORCE ROW LEVEL SECURITY;
ALTER TABLE public.lesson_completions ENABLE ROW LEVEL SECURITY; ALTER TABLE public.lesson_completions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.course_completions ENABLE ROW LEVEL SECURITY; ALTER TABLE public.course_completions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.certificate_prerequisites ENABLE ROW LEVEL SECURITY; ALTER TABLE public.certificate_prerequisites FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY account_course_accesses_member_read ON public.account_course_accesses FOR SELECT TO syntholo_member_api USING(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
CREATE POLICY account_course_accesses_migrator ON public.account_course_accesses FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY enrollments_member_read ON public.enrollments FOR SELECT TO syntholo_member_api USING(account_id=nullif(current_setting('app.account_id',true),'')::uuid AND membership_id=nullif(current_setting('app.membership_id',true),'')::uuid);
CREATE POLICY enrollments_migrator ON public.enrollments FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY enrollment_transitions_member_read ON public.enrollment_version_transitions FOR SELECT TO syntholo_member_api USING(account_id=nullif(current_setting('app.account_id',true),'')::uuid AND membership_id=nullif(current_setting('app.membership_id',true),'')::uuid);
CREATE POLICY enrollment_transitions_migrator ON public.enrollment_version_transitions FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY lesson_progress_member_all ON public.lesson_progress FOR ALL TO syntholo_member_api USING(account_id=nullif(current_setting('app.account_id',true),'')::uuid AND membership_id=nullif(current_setting('app.membership_id',true),'')::uuid) WITH CHECK(account_id=nullif(current_setting('app.account_id',true),'')::uuid AND membership_id=nullif(current_setting('app.membership_id',true),'')::uuid);
CREATE POLICY lesson_progress_migrator ON public.lesson_progress FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY lesson_completions_member_read ON public.lesson_completions FOR SELECT TO syntholo_member_api USING(account_id=nullif(current_setting('app.account_id',true),'')::uuid AND membership_id=nullif(current_setting('app.membership_id',true),'')::uuid);
CREATE POLICY lesson_completions_migrator ON public.lesson_completions FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY course_completions_member_read ON public.course_completions FOR SELECT TO syntholo_member_api USING(account_id=nullif(current_setting('app.account_id',true),'')::uuid AND membership_id=nullif(current_setting('app.membership_id',true),'')::uuid);
CREATE POLICY course_completions_migrator ON public.course_completions FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY certificate_prerequisites_member_read ON public.certificate_prerequisites FOR SELECT TO syntholo_member_api USING(account_id=nullif(current_setting('app.account_id',true),'')::uuid AND membership_id=nullif(current_setting('app.membership_id',true),'')::uuid);
CREATE POLICY certificate_prerequisites_worker ON public.certificate_prerequisites FOR ALL TO syntholo_worker USING(true) WITH CHECK(true);
CREATE POLICY certificate_prerequisites_migrator ON public.certificate_prerequisites FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
--> statement-breakpoint
GRANT SELECT ON public.account_course_accesses,public.enrollments,public.enrollment_version_transitions,public.lesson_progress,public.lesson_completions,public.course_completions,public.certificate_prerequisites TO syntholo_member_api;
GRANT SELECT,INSERT ON public.certificate_prerequisites TO syntholo_worker;
GRANT ALL ON public.account_course_accesses,public.enrollments,public.enrollment_version_transitions,public.lesson_progress,public.lesson_completions,public.course_completions,public.certificate_prerequisites TO syntholo_migrator;
REVOKE ALL ON public.account_course_accesses,public.enrollments,public.enrollment_version_transitions,public.lesson_progress,public.lesson_completions,public.course_completions,public.certificate_prerequisites FROM syntholo_staff_api,syntholo_system_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_canonical_jsonb_text_v1(p_value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $f$
DECLARE kind text:=jsonb_typeof(p_value); result text;
BEGIN
  IF kind='object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.syntholo_canonical_jsonb_text_v1(value),',' ORDER BY key),'')||'}' INTO result FROM jsonb_each(p_value); RETURN result; END IF;
  IF kind='array' THEN SELECT '['||coalesce(string_agg(public.syntholo_canonical_jsonb_text_v1(value),',' ORDER BY ordinal),'')||']' INTO result FROM jsonb_array_elements(p_value) WITH ORDINALITY item(value,ordinal); RETURN result; END IF;
  RETURN p_value::text;
END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_learning_available_at_v1(p_release_rule jsonb,p_enrolled_at timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $f$
  SELECT CASE p_release_rule->>'kind' WHEN 'immediate' THEN p_enrolled_at WHEN 'elapsed_days' THEN p_enrolled_at+make_interval(days=>(p_release_rule->>'days')::integer) WHEN 'fixed_at' THEN (p_release_rule->>'at')::timestamptz ELSE NULL END
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_learning_available_at_v1(jsonb,timestamptz) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_learning_get_course_v1(p_course_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor_account uuid:=nullif(current_setting('app.account_id',true),'')::uuid; actor_membership uuid:=nullif(current_setting('app.membership_id',true),'')::uuid; actor_identity uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid; enrollment public.enrollments; active_count integer; now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); result jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api');
  IF current_setting('app.actor_kind',true)<>'member' OR actor_account IS NULL OR actor_membership IS NULL OR actor_identity IS NULL OR correlation IS NULL OR nullif(current_setting('app.actor_role',true),'') IS NULL OR nullif(current_setting('app.authenticated_at',true),'')::timestamptz IS NULL THEN RAISE EXCEPTION 'LEARNING_MEMBER_CONTEXT_REQUIRED'; END IF;
  SELECT count(*),(array_agg(e.id ORDER BY e.id))[1] INTO active_count,enrollment.id FROM public.enrollments e JOIN public.memberships m ON m.id=e.membership_id AND m.account_id=e.account_id AND m.member_identity_id=actor_identity AND m.status='active' JOIN public.account_course_accesses aca ON aca.id=e.account_course_access_id AND aca.account_id=e.account_id AND aca.course_id=e.course_id AND aca.course_version_id=e.course_version_id AND aca.status='active' WHERE e.account_id=actor_account AND e.membership_id=actor_membership AND e.course_id=p_course_id AND e.status='active';
  IF active_count=0 THEN RAISE EXCEPTION 'ACADEMY_ENROLLMENT_MISSING'; ELSIF active_count<>1 THEN RAISE EXCEPTION 'LEARNING_ENROLLMENT_INTEGRITY'; END IF;
  SELECT e.* INTO enrollment FROM public.enrollments e JOIN public.memberships m ON m.id=e.membership_id AND m.account_id=e.account_id AND m.member_identity_id=actor_identity AND m.status='active' JOIN public.account_course_accesses aca ON aca.id=e.account_course_access_id AND aca.account_id=e.account_id AND aca.course_id=e.course_id AND aca.course_version_id=e.course_version_id AND aca.status='active' WHERE e.id=enrollment.id;
  WITH rows AS (
    SELECT cvl.stage_id,cvl.stage_title,cvl.stage_order,cvl.lesson_id,cvl.lesson_version_id,cvl.lesson_order,cvl.required,cvl.release_rule,lv.title,lv.summary,lv.duration_seconds,
      public.syntholo_learning_available_at_v1(cvl.release_rule,enrollment.enrolled_at) available_at,
      CASE WHEN lc.id IS NOT NULL THEN 'completed' WHEN lp.id IS NOT NULL THEN 'in_progress' ELSE 'not_started' END progress
    FROM public.course_version_lessons cvl JOIN public.lesson_versions lv ON lv.id=cvl.lesson_version_id
    LEFT JOIN public.lesson_progress lp ON lp.enrollment_id=enrollment.id AND lp.lesson_id=cvl.lesson_id
    LEFT JOIN public.lesson_completions lc ON lc.enrollment_id=enrollment.id AND lc.lesson_id=cvl.lesson_id
    WHERE cvl.course_version_id=enrollment.course_version_id
  ), stages AS (
    SELECT stage_id,stage_title,stage_order,jsonb_agg(jsonb_build_object('id',lesson_id,'lessonVersionId',lesson_version_id,'order',lesson_order,'required',required,'title',title,'summary',summary,'durationSeconds',duration_seconds,'releaseRule',release_rule,'availability',CASE WHEN available_at<=now_at THEN 'available' ELSE 'locked' END,'availableAt',to_char(available_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'progress',progress) ORDER BY lesson_order,lesson_id) lessons FROM rows GROUP BY stage_id,stage_title,stage_order
  ), counts AS (SELECT count(*) FILTER(WHERE required AND progress='completed')::integer completed_required FROM rows)
  SELECT jsonb_build_object('schemaVersion',1,'enrollmentId',enrollment.id,'course',jsonb_build_object('id',cv.course_id,'versionId',cv.id,'title',cv.title,'description',cv.description),'stages',coalesce((SELECT jsonb_agg(jsonb_build_object('id',stage_id,'title',stage_title,'order',stage_order,'lessons',lessons) ORDER BY stage_order,stage_id) FROM stages),'[]'::jsonb),'progress',jsonb_build_object('completedRequired',(SELECT completed_required FROM counts),'requiredTotal',18,'percent',floor((SELECT completed_required FROM counts)*100.0/18)::integer)) INTO result FROM public.course_versions cv WHERE cv.id=enrollment.course_version_id;
  IF result IS NULL THEN RAISE EXCEPTION 'LEARNING_ENROLLMENT_INTEGRITY'; END IF;
  RETURN result;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_learning_get_course_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_learning_get_course_v1(uuid) TO syntholo_member_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_learning_get_lesson_v1(p_lesson_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor_account uuid:=nullif(current_setting('app.account_id',true),'')::uuid; actor_membership uuid:=nullif(current_setting('app.membership_id',true),'')::uuid; actor_identity uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid; target record; active_count integer; now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); available_at timestamptz; result jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api');
  IF current_setting('app.actor_kind',true)<>'member' OR actor_account IS NULL OR actor_membership IS NULL OR actor_identity IS NULL OR correlation IS NULL OR nullif(current_setting('app.actor_role',true),'') IS NULL OR nullif(current_setting('app.authenticated_at',true),'')::timestamptz IS NULL THEN RAISE EXCEPTION 'LEARNING_MEMBER_CONTEXT_REQUIRED'; END IF;
  SELECT count(*) INTO active_count FROM public.enrollments e JOIN public.memberships m ON m.id=e.membership_id AND m.account_id=e.account_id AND m.member_identity_id=actor_identity AND m.status='active' JOIN public.account_course_accesses aca ON aca.id=e.account_course_access_id AND aca.account_id=e.account_id AND aca.course_id=e.course_id AND aca.course_version_id=e.course_version_id AND aca.status='active' JOIN public.course_version_lessons cvl ON cvl.course_version_id=e.course_version_id AND cvl.course_id=e.course_id WHERE e.account_id=actor_account AND e.membership_id=actor_membership AND e.status='active' AND cvl.lesson_id=p_lesson_id;
  IF active_count=0 THEN RAISE EXCEPTION 'LEARNING_LESSON_NOT_FOUND'; ELSIF active_count<>1 THEN RAISE EXCEPTION 'LEARNING_ENROLLMENT_INTEGRITY'; END IF;
  SELECT e.id enrollment_id,e.course_id,e.course_version_id,e.enrolled_at,cvl.lesson_version_id,cvl.lesson_order,cvl.release_rule,lv.* INTO target FROM public.enrollments e JOIN public.memberships m ON m.id=e.membership_id AND m.account_id=e.account_id AND m.member_identity_id=actor_identity AND m.status='active' JOIN public.account_course_accesses aca ON aca.id=e.account_course_access_id AND aca.account_id=e.account_id AND aca.course_id=e.course_id AND aca.course_version_id=e.course_version_id AND aca.status='active' JOIN public.course_version_lessons cvl ON cvl.course_version_id=e.course_version_id AND cvl.course_id=e.course_id JOIN public.lesson_versions lv ON lv.id=cvl.lesson_version_id WHERE e.account_id=actor_account AND e.membership_id=actor_membership AND e.status='active' AND cvl.lesson_id=p_lesson_id;
  available_at:=public.syntholo_learning_available_at_v1(target.release_rule,target.enrolled_at);
  IF available_at>now_at THEN RAISE EXCEPTION 'LESSON_NOT_RELEASED' USING DETAIL=to_char(available_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'); END IF;
  SELECT jsonb_build_object('schemaVersion',1,'enrollmentId',target.enrollment_id,'courseVersionId',target.course_version_id,'lessonId',p_lesson_id,'lessonVersionId',target.lesson_version_id,'title',target.title,'summary',target.summary,'durationSeconds',target.duration_seconds,'blocks',target.blocks,'transcript',target.transcript,
    'resources',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.resource_id,'label',r.label,'accessibleLabel',r.accessible_label,'delivery',r.delivery,'mime',r.mime,'byteSize',r.byte_size,'availability',coalesce(h.state,'unavailable')) ORDER BY r."order",r.resource_id) FROM public.lesson_version_resources r LEFT JOIN public.resource_delivery_health h ON h.delivery_reference=r.delivery_reference WHERE r.lesson_version_id=target.lesson_version_id),'[]'::jsonb),
    'progress',CASE WHEN lc.id IS NOT NULL THEN jsonb_build_object('revision',lp.revision,'state','completed','lastPath',lp.last_path,'position',CASE lp.last_path WHEN 'video' THEN jsonb_build_object('seconds',lp.video_seconds) WHEN 'transcript' THEN jsonb_build_object('blockId',lp.transcript_block_id) ELSE NULL END) WHEN lp.id IS NOT NULL THEN jsonb_build_object('revision',lp.revision,'state','in_progress','lastPath',lp.last_path,'position',CASE lp.last_path WHEN 'video' THEN jsonb_build_object('seconds',lp.video_seconds) ELSE jsonb_build_object('blockId',lp.transcript_block_id) END) ELSE jsonb_build_object('revision',NULL,'state','not_started','lastPath',NULL,'position',NULL) END,
    'previousRequiredLessonId',(SELECT prev.lesson_id FROM public.course_version_lessons prev WHERE prev.course_version_id=target.course_version_id AND prev.required AND prev.lesson_order<target.lesson_order AND public.syntholo_learning_available_at_v1(prev.release_rule,target.enrolled_at)<=now_at ORDER BY prev.lesson_order DESC LIMIT 1),
    'nextRequiredLessonId',(SELECT nxt.lesson_id FROM public.course_version_lessons nxt WHERE nxt.course_version_id=target.course_version_id AND nxt.required AND nxt.lesson_order>target.lesson_order AND public.syntholo_learning_available_at_v1(nxt.release_rule,target.enrolled_at)<=now_at ORDER BY nxt.lesson_order LIMIT 1)) INTO result
  FROM (SELECT 1) one LEFT JOIN public.lesson_progress lp ON lp.enrollment_id=target.enrollment_id AND lp.lesson_id=p_lesson_id LEFT JOIN public.lesson_completions lc ON lc.enrollment_id=target.enrollment_id AND lc.lesson_id=p_lesson_id;
  RETURN result;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_learning_get_lesson_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_learning_get_lesson_v1(uuid) TO syntholo_member_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_learning_get_playback_target_v1(p_lesson_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor_account uuid:=nullif(current_setting('app.account_id',true),'')::uuid; actor_membership uuid:=nullif(current_setting('app.membership_id',true),'')::uuid; actor_identity uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid; target record; row_count integer; now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp());
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api');
  IF current_setting('app.actor_kind',true)<>'member' OR actor_account IS NULL OR actor_membership IS NULL OR actor_identity IS NULL OR correlation IS NULL OR nullif(current_setting('app.actor_role',true),'') IS NULL OR nullif(current_setting('app.authenticated_at',true),'')::timestamptz IS NULL THEN RAISE EXCEPTION 'LEARNING_MEMBER_CONTEXT_REQUIRED'; END IF;
  SELECT count(*) INTO row_count FROM public.enrollments e JOIN public.memberships m ON m.id=e.membership_id AND m.account_id=e.account_id AND m.member_identity_id=actor_identity AND m.status='active' JOIN public.account_course_accesses aca ON aca.id=e.account_course_access_id AND aca.account_id=e.account_id AND aca.course_id=e.course_id AND aca.course_version_id=e.course_version_id AND aca.status='active' JOIN public.course_version_lessons cvl ON cvl.course_version_id=e.course_version_id AND cvl.course_id=e.course_id WHERE e.account_id=actor_account AND e.membership_id=actor_membership AND e.status='active' AND cvl.lesson_id=p_lesson_id;
  IF row_count=0 THEN RAISE EXCEPTION 'LEARNING_LESSON_NOT_FOUND'; ELSIF row_count<>1 THEN RAISE EXCEPTION 'LEARNING_ENROLLMENT_INTEGRITY'; END IF;
  SELECT e.enrolled_at,cvl.release_rule,cvl.lesson_version_id,lv.duration_seconds,a.state,a.signed_policy_playback_id INTO target FROM public.enrollments e JOIN public.memberships m ON m.id=e.membership_id AND m.account_id=e.account_id AND m.member_identity_id=actor_identity AND m.status='active' JOIN public.account_course_accesses aca ON aca.id=e.account_course_access_id AND aca.account_id=e.account_id AND aca.course_id=e.course_id AND aca.course_version_id=e.course_version_id AND aca.status='active' JOIN public.course_version_lessons cvl ON cvl.course_version_id=e.course_version_id AND cvl.course_id=e.course_id JOIN public.lesson_versions lv ON lv.id=cvl.lesson_version_id LEFT JOIN public.content_media_assets a ON a.id=lv.media_asset_id WHERE e.account_id=actor_account AND e.membership_id=actor_membership AND e.status='active' AND cvl.lesson_id=p_lesson_id;
  IF public.syntholo_learning_available_at_v1(target.release_rule,target.enrolled_at)>now_at THEN RAISE EXCEPTION 'LESSON_NOT_RELEASED' USING DETAIL=to_char(public.syntholo_learning_available_at_v1(target.release_rule,target.enrolled_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'); END IF;
  RETURN jsonb_build_object('lessonVersionId',target.lesson_version_id,'durationSeconds',target.duration_seconds,'mediaState',coalesce(target.state,'waiting'),'signedPlaybackId',target.signed_policy_playback_id);
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_learning_get_playback_target_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_learning_get_playback_target_v1(uuid) TO syntholo_member_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_learning_resume_lesson_v1(p_lesson_id uuid,p_expected_version integer,p_path text,p_video_seconds integer,p_transcript_block_id text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor_account uuid:=nullif(current_setting('app.account_id',true),'')::uuid; actor_membership uuid:=nullif(current_setting('app.membership_id',true),'')::uuid; actor_identity uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid; target record; progress public.lesson_progress; completion public.lesson_completions; row_count integer; available_at timestamptz; now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp());
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api');
  IF current_setting('app.actor_kind',true)<>'member' OR actor_account IS NULL OR actor_membership IS NULL OR actor_identity IS NULL OR correlation IS NULL OR nullif(current_setting('app.actor_role',true),'') IS NULL OR nullif(current_setting('app.authenticated_at',true),'')::timestamptz IS NULL OR p_expected_version<0 OR p_path NOT IN ('video','transcript') THEN RAISE EXCEPTION 'LEARNING_MEMBER_CONTEXT_REQUIRED'; END IF;
  SELECT e.*,cvl.lesson_version_id,cvl.release_rule,lv.duration_seconds,lv.transcript INTO target FROM public.enrollments e JOIN public.memberships m ON m.id=e.membership_id AND m.account_id=e.account_id AND m.member_identity_id=actor_identity AND m.status='active' JOIN public.account_course_accesses aca ON aca.id=e.account_course_access_id AND aca.account_id=e.account_id AND aca.course_id=e.course_id AND aca.course_version_id=e.course_version_id AND aca.status='active' JOIN public.course_version_lessons cvl ON cvl.course_version_id=e.course_version_id AND cvl.course_id=e.course_id JOIN public.lesson_versions lv ON lv.id=cvl.lesson_version_id WHERE e.account_id=actor_account AND e.membership_id=actor_membership AND e.status='active' AND cvl.lesson_id=p_lesson_id FOR UPDATE OF e,m,aca;
  GET DIAGNOSTICS row_count=ROW_COUNT; IF row_count=0 THEN RAISE EXCEPTION 'LEARNING_LESSON_NOT_FOUND'; ELSIF row_count<>1 THEN RAISE EXCEPTION 'LEARNING_ENROLLMENT_INTEGRITY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('learning:resume:'||target.id::text||':'||p_lesson_id::text,0));
  available_at:=public.syntholo_learning_available_at_v1(target.release_rule,target.enrolled_at); IF available_at>now_at THEN RAISE EXCEPTION 'LESSON_NOT_RELEASED' USING DETAIL=to_char(available_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'); END IF;
  SELECT * INTO completion FROM public.lesson_completions WHERE enrollment_id=target.id AND lesson_id=p_lesson_id FOR UPDATE;
  SELECT * INTO progress FROM public.lesson_progress WHERE enrollment_id=target.id AND lesson_id=p_lesson_id FOR UPDATE;
  IF completion.id IS NOT NULL THEN RETURN jsonb_build_object('revision',progress.revision,'state','completed','lastPath',progress.last_path,'position',CASE progress.last_path WHEN 'video' THEN jsonb_build_object('seconds',progress.video_seconds) WHEN 'transcript' THEN jsonb_build_object('blockId',progress.transcript_block_id) ELSE NULL END); END IF;
  IF p_path='video' AND (p_video_seconds IS NULL OR p_video_seconds<0 OR p_video_seconds>target.duration_seconds OR p_transcript_block_id IS NOT NULL) THEN RAISE EXCEPTION 'LEARNING_RESUME_INVALID'; END IF;
  IF p_path='transcript' AND (p_video_seconds IS NOT NULL OR p_transcript_block_id IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(target.transcript->'blocks') b WHERE b->>'blockId'=p_transcript_block_id)) THEN RAISE EXCEPTION 'LEARNING_RESUME_INVALID'; END IF;
  IF progress.id IS NOT NULL AND ROW(progress.last_path,progress.video_seconds,progress.transcript_block_id) IS NOT DISTINCT FROM ROW(p_path,p_video_seconds,p_transcript_block_id) THEN RETURN jsonb_build_object('revision',progress.revision,'state','in_progress','lastPath',progress.last_path,'position',CASE progress.last_path WHEN 'video' THEN jsonb_build_object('seconds',progress.video_seconds) ELSE jsonb_build_object('blockId',progress.transcript_block_id) END); END IF;
  IF (progress.id IS NULL AND p_expected_version<>0) OR (progress.id IS NOT NULL AND progress.revision<>p_expected_version) THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  IF progress.id IS NULL THEN
    INSERT INTO public.lesson_progress(account_id,membership_id,enrollment_id,course_id,course_version_id,lesson_id,lesson_version_id,last_path,video_seconds,transcript_block_id,revision,updated_at) VALUES(actor_account,actor_membership,target.id,target.course_id,target.course_version_id,p_lesson_id,target.lesson_version_id,p_path,p_video_seconds,p_transcript_block_id,1,now_at) RETURNING * INTO progress;
  ELSIF ROW(progress.last_path,progress.video_seconds,progress.transcript_block_id) IS DISTINCT FROM ROW(p_path,p_video_seconds,p_transcript_block_id) THEN
    UPDATE public.lesson_progress SET last_path=p_path,video_seconds=p_video_seconds,transcript_block_id=p_transcript_block_id,revision=revision+1,updated_at=now_at WHERE id=progress.id RETURNING * INTO progress;
  END IF;
  RETURN jsonb_build_object('revision',progress.revision,'state','in_progress','lastPath',progress.last_path,'position',CASE progress.last_path WHEN 'video' THEN jsonb_build_object('seconds',progress.video_seconds) ELSE jsonb_build_object('blockId',progress.transcript_block_id) END);
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_learning_resume_lesson_v1(uuid,integer,text,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_learning_resume_lesson_v1(uuid,integer,text,integer,text) TO syntholo_member_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_learning_complete_lesson_v1(p_lesson_id uuid,p_method text,p_idempotency_key text,p_request_hash text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor_account uuid:=nullif(current_setting('app.account_id',true),'')::uuid; actor_membership uuid:=nullif(current_setting('app.membership_id',true),'')::uuid; actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid; target record; receipt public.api_command_receipts; completion public.lesson_completions; course_completion public.course_completions; row_count integer; available_at timestamptz; now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); required_count integer; completed_count integer; required_hash text; next_lesson uuid; response_payload jsonb; event_id uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api');
  IF current_setting('app.actor_kind',true)<>'member' OR actor_account IS NULL OR actor_membership IS NULL OR actor IS NULL OR correlation IS NULL OR nullif(current_setting('app.actor_role',true),'') IS NULL OR nullif(current_setting('app.authenticated_at',true),'')::timestamptz IS NULL OR p_method NOT IN ('video','transcript','mixed') OR p_idempotency_key IS NULL OR octet_length(p_idempotency_key) NOT BETWEEN 16 AND 128 OR p_request_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'LEARNING_COMPLETE_INVALID'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.memberships m WHERE m.id=actor_membership AND m.account_id=actor_account AND m.member_identity_id=actor AND m.status='active') THEN RAISE EXCEPTION 'LEARNING_COMPLETE_INVALID'; END IF;
  SELECT e.*,cvl.lesson_version_id,cvl.lesson_order,cvl.release_rule INTO target FROM public.enrollments e JOIN public.memberships m ON m.id=e.membership_id AND m.account_id=e.account_id AND m.member_identity_id=actor AND m.status='active' JOIN public.account_course_accesses aca ON aca.id=e.account_course_access_id AND aca.account_id=e.account_id AND aca.course_id=e.course_id AND aca.course_version_id=e.course_version_id AND aca.status='active' JOIN public.course_version_lessons cvl ON cvl.course_version_id=e.course_version_id AND cvl.course_id=e.course_id WHERE e.account_id=actor_account AND e.membership_id=actor_membership AND e.status='active' AND cvl.lesson_id=p_lesson_id FOR UPDATE OF e,m,aca;
  GET DIAGNOSTICS row_count=ROW_COUNT; IF row_count=0 THEN RAISE EXCEPTION 'LEARNING_LESSON_NOT_FOUND'; ELSIF row_count<>1 THEN RAISE EXCEPTION 'LEARNING_ENROLLMENT_INTEGRITY'; END IF;
  INSERT INTO public.api_command_receipts(principal_kind,principal_id,method,route_template,idempotency_key,request_hash,status,expires_at,created_at) VALUES('member',actor_membership::text,'POST','/v1/member/lessons/:lessonId/complete',p_idempotency_key,p_request_hash,'in_progress',now_at+interval '30 days',now_at) ON CONFLICT(principal_kind,principal_id,method,route_template,idempotency_key) DO NOTHING;
  SELECT * INTO receipt FROM public.api_command_receipts WHERE principal_kind='member' AND principal_id=actor_membership::text AND method='POST' AND route_template='/v1/member/lessons/:lessonId/complete' AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF receipt.id IS NULL OR receipt.request_hash<>p_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'; END IF;
  IF receipt.status='completed' THEN RETURN receipt.response; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('learning:completion:enrollment:'||target.id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('learning:resume:'||target.id::text||':'||p_lesson_id::text,0));
  available_at:=public.syntholo_learning_available_at_v1(target.release_rule,target.enrolled_at); IF available_at>now_at THEN RAISE EXCEPTION 'LESSON_NOT_RELEASED' USING DETAIL=to_char(available_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'); END IF;
  SELECT * INTO completion FROM public.lesson_completions WHERE enrollment_id=target.id AND lesson_id=p_lesson_id FOR UPDATE;
  IF completion.id IS NULL THEN
    INSERT INTO public.lesson_completions(account_id,membership_id,enrollment_id,course_id,course_version_id,lesson_id,lesson_version_id,method,source_command_receipt_id,completed_at) VALUES(actor_account,actor_membership,target.id,target.course_id,target.course_version_id,p_lesson_id,target.lesson_version_id,p_method,receipt.id,now_at) RETURNING * INTO completion;
    INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at) VALUES(gen_random_uuid(),actor_account,'member',actor::text,'learning_lesson_completed','lesson_completion',completion.id::text,correlation,jsonb_build_object('enrollmentId',target.id::text,'courseVersionId',target.course_version_id::text,'lessonId',p_lesson_id::text,'lessonVersionId',target.lesson_version_id::text,'method',completion.method),now_at);
  END IF;
  SELECT count(*) INTO required_count FROM public.course_version_lessons WHERE course_version_id=target.course_version_id AND required;
  SELECT count(*) INTO completed_count FROM public.lesson_completions lc JOIN public.course_version_lessons cvl ON cvl.course_version_id=lc.course_version_id AND cvl.lesson_id=lc.lesson_id AND cvl.lesson_version_id=lc.lesson_version_id AND cvl.required WHERE lc.enrollment_id=target.id;
  IF required_count=18 AND completed_count=18 THEN
    SELECT encode(sha256(convert_to(public.syntholo_canonical_jsonb_text_v1(coalesce(jsonb_agg(lesson_id ORDER BY lesson_id),'[]'::jsonb)),'UTF8')),'hex') INTO required_hash FROM public.course_version_lessons WHERE course_version_id=target.course_version_id AND required;
    INSERT INTO public.course_completions(account_id,membership_id,enrollment_id,course_id,course_version_id,required_lesson_set_hash,completed_at) VALUES(actor_account,actor_membership,target.id,target.course_id,target.course_version_id,required_hash,now_at) ON CONFLICT(enrollment_id) DO NOTHING RETURNING * INTO course_completion;
    IF course_completion.id IS NOT NULL THEN
      event_id:=gen_random_uuid();
      INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at) VALUES(gen_random_uuid(),actor_account,'member',actor::text,'learning_course_completed','course_completion',course_completion.id::text,correlation,jsonb_build_object('enrollmentId',target.id::text,'courseVersionId',target.course_version_id::text,'requiredLessonSetHash',required_hash),now_at);
      INSERT INTO public.outbox_events(event_id,account_id,type,aggregate_id,payload,schema_version,status,attempts,available_at,created_at,occurred_at,actor_type,actor_id,correlation_id,max_attempts,claim_generation) VALUES(event_id,actor_account,'learning.course_completed.v1',course_completion.id::text,jsonb_build_object('courseCompletionId',course_completion.id::text,'accountId',actor_account::text,'membershipId',actor_membership::text,'enrollmentId',target.id::text,'courseId',target.course_id::text,'courseVersionId',target.course_version_id::text),1,'pending',0,now_at,now_at,now_at,'member',actor::text,correlation,10,0);
    ELSE SELECT * INTO course_completion FROM public.course_completions WHERE enrollment_id=target.id; END IF;
  END IF;
  SELECT cvl.lesson_id INTO next_lesson FROM public.course_version_lessons cvl LEFT JOIN public.lesson_completions lc ON lc.enrollment_id=target.id AND lc.lesson_id=cvl.lesson_id WHERE cvl.course_version_id=target.course_version_id AND cvl.required AND lc.id IS NULL AND public.syntholo_learning_available_at_v1(cvl.release_rule,target.enrolled_at)<=now_at ORDER BY cvl.lesson_order LIMIT 1;
  response_payload:=jsonb_build_object('schemaVersion',1,'lessonCompletion',jsonb_build_object('id',completion.id,'lessonVersionId',completion.lesson_version_id,'method',completion.method,'completedAt',to_char(completion.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'courseCompletion',CASE WHEN course_completion.id IS NULL THEN NULL ELSE jsonb_build_object('id',course_completion.id,'courseVersionId',course_completion.course_version_id,'completedAt',to_char(course_completion.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END,'nextRequiredLessonId',next_lesson);
  UPDATE public.api_command_receipts AS command_receipt SET status='completed',response_status=200,response=response_payload,completed_at=now_at WHERE command_receipt.id=receipt.id;
  RETURN response_payload;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_learning_complete_lesson_v1(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_learning_complete_lesson_v1(uuid,text,text,text) TO syntholo_member_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_learning_record_certificate_prerequisite_v1(p_event_id uuid,p_handler_name text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE source record; inserted_id uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_worker');
  IF p_event_id IS NULL OR p_handler_name<>'learning.certificate_prerequisite_record' THEN RAISE EXCEPTION 'LEARNING_PREREQUISITE_INPUT_INVALID'; END IF;
  SELECT o.payload,c.* INTO source FROM public.outbox_events o JOIN public.course_completions c ON c.id=CASE WHEN o.payload->>'courseCompletionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN (o.payload->>'courseCompletionId')::uuid ELSE NULL END
  WHERE o.event_id=p_event_id AND o.type='learning.course_completed.v1' AND o.payload->>'accountId'=c.account_id::text AND o.payload->>'membershipId'=c.membership_id::text AND o.payload->>'enrollmentId'=c.enrollment_id::text AND o.payload->>'courseId'=c.course_id::text AND o.payload->>'courseVersionId'=c.course_version_id::text;
  IF source.id IS NULL THEN RAISE EXCEPTION 'LEARNING_PREREQUISITE_INPUT_INVALID'; END IF;
  INSERT INTO public.certificate_prerequisites(course_completion_id,account_id,membership_id,enrollment_id,course_id,course_version_id)
  VALUES(source.id,source.account_id,source.membership_id,source.enrollment_id,source.course_id,source.course_version_id)
  ON CONFLICT(course_completion_id) DO NOTHING RETURNING id INTO inserted_id;
  RETURN CASE WHEN inserted_id IS NULL THEN 'duplicate' ELSE 'recorded' END;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_learning_record_certificate_prerequisite_v1(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_learning_record_certificate_prerequisite_v1(uuid,text) TO syntholo_worker;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_canonical_jsonb_text_v1(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_lesson_draft_hash_v1(p_lesson_id uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
  SELECT encode(sha256(convert_to(public.syntholo_canonical_jsonb_text_v1(jsonb_build_object('lessonId',d.lesson_id,'revision',d.revision,'title',d.title,'summary',d.summary,'durationSeconds',d.duration_seconds,'blocks',d.blocks,'transcript',d.transcript,'mediaAssetId',d.media_asset_id,'stageOrder',d.stage_order,'order',d."order",'required',d.required,'releaseRule',d.release_rule,'placeholderDetected',d.placeholder_detected,'resources',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'revision',r.revision,'label',r.label,'accessibleLabel',r.accessible_label,'delivery',r.delivery,'deliveryReference',r.delivery_reference,'mime',r.mime,'byteSize',r.byte_size,'contentHash',r.content_hash) ORDER BY r.id) FROM public.content_resource_drafts r WHERE r.lesson_id=d.lesson_id AND r.lesson_draft_revision=d.revision AND r.archived_at IS NULL),'[]'::jsonb))),'UTF8')),'hex') FROM public.lesson_drafts d WHERE d.lesson_id=p_lesson_id
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_lesson_draft_hash_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_lesson_draft_hash_v1(uuid) TO syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_nonblank_v1(p_value text,p_min integer,p_max integer) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $f$
  SELECT coalesce(p_value IS NOT NULL AND octet_length(p_value) BETWEEN p_min AND p_max AND p_value !~ '^[[:space:]   -     　﻿]*$',false)
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_nonblank_v1(text,integer,integer) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_https_url_valid_v1(p_url text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $f$
  SELECT coalesce(p_url IS NOT NULL AND octet_length(p_url) BETWEEN 9 AND 2048 AND p_url ~ '^https://[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+(?:/[A-Za-z0-9._~!$&''()*+,;=:@%/?#-]*)?$',false)
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_https_url_valid_v1(text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_document_valid_v1(p_document jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $f$
  WITH RECURSIVE nodes(value,parent_type) AS (
    SELECT child,'doc'::text FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_document->'content')='array' THEN p_document->'content' ELSE '[]'::jsonb END) child
    UNION ALL
    SELECT child,n.value->>'type' FROM nodes n CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(n.value->'content')='array' THEN n.value->'content' ELSE '[]'::jsonb END) child
  )
  SELECT coalesce(jsonb_typeof(p_document)='object' AND p_document ?& ARRAY['type','content'] AND p_document-ARRAY['type','content']::text[]='{}'::jsonb AND p_document->>'type'='doc' AND jsonb_typeof(p_document->'content')='array' AND jsonb_array_length(p_document->'content')<=500 AND octet_length(p_document::text)<=65536
    AND NOT EXISTS(SELECT 1 FROM nodes n WHERE jsonb_typeof(n.value)<>'object' OR n.value->>'type' NOT IN ('paragraph','heading','blockquote','list_item','bullet_list','ordered_list','code_block','text','hard_break')
      OR CASE n.value->>'type'
        WHEN 'paragraph' THEN NOT (n.value ?& ARRAY['type','content']) OR n.value-ARRAY['type','content']::text[]<>'{}'::jsonb OR jsonb_typeof(n.value->'content')<>'array' OR jsonb_array_length(n.value->'content')>500 OR n.parent_type NOT IN ('doc','blockquote','list_item')
        WHEN 'heading' THEN NOT (n.value ?& ARRAY['type','level','content']) OR n.value-ARRAY['type','level','content']::text[]<>'{}'::jsonb OR n.value->>'level' NOT IN ('2','3') OR jsonb_typeof(n.value->'content')<>'array' OR jsonb_array_length(n.value->'content') NOT BETWEEN 1 AND 100 OR n.parent_type<>'doc'
        WHEN 'blockquote' THEN NOT (n.value ?& ARRAY['type','content']) OR n.value-ARRAY['type','content']::text[]<>'{}'::jsonb OR jsonb_typeof(n.value->'content')<>'array' OR jsonb_array_length(n.value->'content') NOT BETWEEN 1 AND 100 OR n.parent_type NOT IN ('doc','list_item')
        WHEN 'list_item' THEN NOT (n.value ?& ARRAY['type','content']) OR n.value-ARRAY['type','content']::text[]<>'{}'::jsonb OR jsonb_typeof(n.value->'content')<>'array' OR jsonb_array_length(n.value->'content') NOT BETWEEN 1 AND 100 OR n.parent_type NOT IN ('bullet_list','ordered_list')
        WHEN 'bullet_list' THEN NOT (n.value ?& ARRAY['type','content']) OR n.value-ARRAY['type','content']::text[]<>'{}'::jsonb OR jsonb_typeof(n.value->'content')<>'array' OR jsonb_array_length(n.value->'content') NOT BETWEEN 1 AND 200 OR n.parent_type<>'doc'
        WHEN 'ordered_list' THEN NOT (n.value ?& ARRAY['type','content']) OR n.value-ARRAY['type','start','content']::text[]<>'{}'::jsonb OR jsonb_typeof(n.value->'content')<>'array' OR jsonb_array_length(n.value->'content') NOT BETWEEN 1 AND 200 OR (n.value ? 'start' AND (jsonb_typeof(n.value->'start')<>'number' OR (n.value->>'start')::numeric<>trunc((n.value->>'start')::numeric) OR (n.value->>'start')::numeric NOT BETWEEN 1 AND 10000)) OR n.parent_type<>'doc'
        WHEN 'code_block' THEN NOT (n.value ?& ARRAY['type','text']) OR n.value-ARRAY['type','language','text']::text[]<>'{}'::jsonb OR jsonb_typeof(n.value->'text')<>'string' OR octet_length(n.value->>'text') NOT BETWEEN 1 AND 20000 OR (n.value ? 'language' AND (jsonb_typeof(n.value->'language')<>'string' OR n.value->>'language' !~ '^[A-Za-z0-9_+-]{1,32}$')) OR n.parent_type<>'doc'
        WHEN 'text' THEN NOT (n.value ?& ARRAY['type','text']) OR n.value-ARRAY['type','text','marks']::text[]<>'{}'::jsonb OR jsonb_typeof(n.value->'text')<>'string' OR octet_length(n.value->>'text') NOT BETWEEN 1 AND 20000 OR n.parent_type NOT IN ('paragraph','heading') OR (n.value ? 'marks' AND (jsonb_typeof(n.value->'marks')<>'array' OR jsonb_array_length(n.value->'marks')>4 OR EXISTS(SELECT 1 FROM jsonb_array_elements(n.value->'marks') m WHERE jsonb_typeof(m)<>'object' OR NOT (m ? 'type') OR m->>'type' NOT IN ('bold','italic','code','link') OR CASE WHEN m->>'type'='link' THEN NOT (m ?& ARRAY['type','href']) OR m-ARRAY['type','href']::text[]<>'{}'::jsonb OR NOT public.syntholo_content_https_url_valid_v1(m->>'href') ELSE m-ARRAY['type']::text[]<>'{}'::jsonb END) OR EXISTS(SELECT 1 FROM jsonb_array_elements(n.value->'marks') m GROUP BY m->>'type' HAVING count(*)>1)))
        WHEN 'hard_break' THEN NOT (n.value ? 'type') OR n.value<>jsonb_build_object('type','hard_break') OR n.parent_type NOT IN ('paragraph','heading')
        ELSE true END)
  ,false)
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_document_valid_v1(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_blocks_valid_v1(p_blocks jsonb,p_transcript jsonb,p_media_asset_id uuid) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $f$
  SELECT coalesce(jsonb_typeof(p_blocks)='array' AND jsonb_array_length(p_blocks) BETWEEN 1 AND 100 AND octet_length(p_blocks::text)<=262144
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_blocks) b WHERE jsonb_typeof(b)<>'object' OR NOT (b ?& ARRAY['type','blockId']) OR b->>'type' NOT IN ('rich_text','callout','checklist','action','resource_list','recommendation','disclosure','video') OR coalesce(b->>'blockId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    AND (SELECT count(*)=count(DISTINCT b->>'blockId') FROM jsonb_array_elements(p_blocks) b)
    AND (SELECT count(*)=1 FROM jsonb_array_elements(p_blocks) b WHERE b->>'type'='video' AND b->>'mediaAssetId'=p_media_asset_id::text) AND (SELECT count(*)=1 FROM jsonb_array_elements(p_blocks) b WHERE b->>'type'='video')
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_blocks) b WHERE b->>'type'='action')
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_blocks) b WHERE CASE b->>'type'
      WHEN 'video' THEN NOT (b ?& ARRAY['type','blockId','mediaAssetId']) OR b-ARRAY['type','blockId','mediaAssetId']::text[]<>'{}'::jsonb OR jsonb_typeof(b->'mediaAssetId')<>'string' OR b->>'mediaAssetId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      WHEN 'action' THEN NOT (b ?& ARRAY['type','blockId','title','instructions']) OR b-ARRAY['type','blockId','title','instructions','outputKind']::text[]<>'{}'::jsonb OR jsonb_typeof(b->'title')<>'string' OR NOT public.syntholo_content_nonblank_v1(b->>'title',1,255) OR jsonb_typeof(b->'instructions')<>'string' OR NOT public.syntholo_content_nonblank_v1(b->>'instructions',1,10000) OR (b ? 'outputKind' AND (jsonb_typeof(b->'outputKind')<>'string' OR NOT public.syntholo_content_nonblank_v1(b->>'outputKind',1,64)))
      WHEN 'resource_list' THEN NOT (b ?& ARRAY['type','blockId','resourceIds']) OR b-ARRAY['type','blockId','resourceIds']::text[]<>'{}'::jsonb OR jsonb_typeof(b->'resourceIds')<>'array' OR jsonb_array_length(b->'resourceIds') NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(b->'resourceIds') r WHERE jsonb_typeof(r)<>'string' OR trim(both '"' from r::text) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') OR (SELECT count(*)<>count(DISTINCT r::text) FROM jsonb_array_elements(b->'resourceIds') r)
      WHEN 'rich_text' THEN NOT (b ?& ARRAY['type','blockId','document']) OR b-ARRAY['type','blockId','document']::text[]<>'{}'::jsonb OR NOT public.syntholo_content_document_valid_v1(b->'document')
      WHEN 'callout' THEN NOT (b ?& ARRAY['type','blockId','tone','document']) OR b-ARRAY['type','blockId','tone','document']::text[]<>'{}'::jsonb OR b->>'tone' NOT IN ('info','warning') OR NOT public.syntholo_content_document_valid_v1(b->'document')
      WHEN 'checklist' THEN NOT (b ?& ARRAY['type','blockId','title','items']) OR b-ARRAY['type','blockId','title','items']::text[]<>'{}'::jsonb OR jsonb_typeof(b->'title')<>'string' OR NOT public.syntholo_content_nonblank_v1(b->>'title',1,255) OR jsonb_typeof(b->'items')<>'array' OR jsonb_array_length(b->'items') NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(b->'items') i WHERE NOT public.syntholo_content_nonblank_v1(i,1,500)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(b->'items') i WHERE jsonb_typeof(i)<>'string')
      WHEN 'recommendation' THEN NOT (b ?& ARRAY['type','blockId','title','rationale']) OR b-ARRAY['type','blockId','title','rationale','externalHttpsUrl']::text[]<>'{}'::jsonb OR jsonb_typeof(b->'title')<>'string' OR NOT public.syntholo_content_nonblank_v1(b->>'title',1,255) OR jsonb_typeof(b->'rationale')<>'string' OR NOT public.syntholo_content_nonblank_v1(b->>'rationale',1,5000) OR (b ? 'externalHttpsUrl' AND NOT public.syntholo_content_https_url_valid_v1(b->>'externalHttpsUrl'))
      WHEN 'disclosure' THEN NOT (b ?& ARRAY['type','blockId','disclosureKind','policyVersion','document']) OR b-ARRAY['type','blockId','disclosureKind','policyVersion','document']::text[]<>'{}'::jsonb OR jsonb_typeof(b->'disclosureKind')<>'string' OR NOT public.syntholo_content_nonblank_v1(b->>'disclosureKind',1,64) OR jsonb_typeof(b->'policyVersion')<>'string' OR NOT public.syntholo_content_nonblank_v1(b->>'policyVersion',1,64) OR NOT public.syntholo_content_document_valid_v1(b->'document')
      ELSE true END)
    AND jsonb_typeof(p_transcript)='object' AND p_transcript ?& ARRAY['schemaVersion','blocks'] AND p_transcript-ARRAY['schemaVersion','blocks']::text[]='{}'::jsonb AND p_transcript->'schemaVersion'='1'::jsonb AND jsonb_typeof(p_transcript->'blocks')='array' AND jsonb_array_length(p_transcript->'blocks') BETWEEN 1 AND 1000 AND octet_length(p_transcript::text)<=1048576
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_transcript->'blocks') b WHERE jsonb_typeof(b)<>'object' OR NOT (b ?& ARRAY['blockId','text']) OR b-ARRAY['blockId','text']::text[]<>'{}'::jsonb OR jsonb_typeof(b->'blockId')<>'string' OR coalesce(b->>'blockId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR jsonb_typeof(b->'text')<>'string' OR NOT public.syntholo_content_nonblank_v1(b->>'text',1,20000))
    AND (SELECT count(*)=count(DISTINCT b->>'blockId') FROM jsonb_array_elements(p_transcript->'blocks') b)
  ,false)
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_blocks_valid_v1(jsonb,jsonb,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_lesson_issues_v1(p_lesson_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
  WITH candidate AS (
    SELECT d.*,a.state media_state,a.signed_policy_playback_id,a.duration_milliseconds,
      EXISTS(SELECT 1 FROM public.content_media_tracks t WHERE t.media_asset_id=d.media_asset_id AND t.kind='captions' AND lower(t.language) LIKE 'en%' AND t.closed_captions AND t.state='ready') captions_ready,
      EXISTS(SELECT 1 FROM public.content_resource_drafts r JOIN public.resource_delivery_health h ON h.delivery_reference=r.delivery_reference WHERE r.lesson_id=d.lesson_id AND r.lesson_draft_revision=d.revision AND r.archived_at IS NULL AND h.state='ready') resource_ready,
      public.syntholo_lesson_draft_hash_v1(d.lesson_id) draft_hash,
      ah.current_decision_id accessibility_id,ah.current_draft_revision accessibility_revision,ah.current_draft_hash accessibility_hash,ad.decision accessibility_decision,
      dh.current_decision_id disclosure_id,dh.current_draft_revision disclosure_revision,dh.current_draft_hash disclosure_hash,dd.decision disclosure_decision,dd.policy_version disclosure_policy_version,
      (btrim(d.summary)~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)' OR d.blocks::text~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)' OR d.transcript::text~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)' OR EXISTS(SELECT 1 FROM public.content_resource_drafts r WHERE r.lesson_id=d.lesson_id AND r.lesson_draft_revision=d.revision AND r.archived_at IS NULL AND (r.label~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)' OR r.accessible_label~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)'))) derived_placeholder,
      NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.blocks) b CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN b->>'type'='resource_list' AND jsonb_typeof(b->'resourceIds')='array' THEN b->'resourceIds' ELSE '[]'::jsonb END) rid LEFT JOIN public.content_resource_drafts r ON r.id=CASE WHEN trim(both '"' from rid::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN trim(both '"' from rid::text)::uuid ELSE NULL END AND r.lesson_id=d.lesson_id AND r.lesson_draft_revision=d.revision AND r.archived_at IS NULL WHERE b->>'type'='resource_list' AND r.id IS NULL)
      AND NOT EXISTS(SELECT 1 FROM public.content_resource_drafts r WHERE r.lesson_id=d.lesson_id AND r.lesson_draft_revision=d.revision AND r.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.blocks) b CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN b->>'type'='resource_list' AND jsonb_typeof(b->'resourceIds')='array' THEN b->'resourceIds' ELSE '[]'::jsonb END) rid WHERE trim(both '"' from rid::text)=r.id::text)) resource_refs_valid
    FROM public.lesson_drafts d LEFT JOIN public.content_media_assets a ON a.id=d.media_asset_id
    LEFT JOIN public.lesson_accessibility_review_heads ah ON ah.lesson_id=d.lesson_id LEFT JOIN public.lesson_accessibility_decisions ad ON ad.id=ah.current_decision_id
    LEFT JOIN public.lesson_disclosure_review_heads dh ON dh.lesson_id=d.lesson_id LEFT JOIN public.lesson_disclosure_decisions dd ON dd.id=dh.current_decision_id
    WHERE d.lesson_id=p_lesson_id
  ), issues AS (
    SELECT code,field FROM candidate c CROSS JOIN LATERAL (VALUES
      ('TITLE_REQUIRED','title',NOT public.syntholo_content_nonblank_v1(c.title,1,255) OR c.title~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)'),
      ('SUMMARY_REQUIRED','summary',NOT public.syntholo_content_nonblank_v1(c.summary,1,10000)),
      ('DURATION_OUT_OF_RANGE','durationSeconds',c.duration_seconds IS NULL OR c.duration_seconds NOT BETWEEN 300 AND 720),
      ('VIDEO_NOT_READY','mediaAssetId',c.media_asset_id IS NULL OR c.media_state<>'ready' OR (SELECT count(*) FROM jsonb_array_elements(c.blocks) b WHERE b->>'type'='video')<>1 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.blocks) b WHERE b->>'type'='video' AND b->>'mediaAssetId'=c.media_asset_id::text)),
      ('SIGNED_PLAYBACK_REQUIRED','mediaAssetId',c.signed_policy_playback_id IS NULL),
      ('CAPTIONS_REQUIRED','captions',NOT c.captions_ready),
      ('TRANSCRIPT_REQUIRED','transcript',jsonb_typeof(c.transcript->'blocks') IS DISTINCT FROM 'array' OR jsonb_array_length(coalesce(c.transcript->'blocks','[]'::jsonb))=0),
      ('ACTION_REQUIRED','blocks',NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.blocks) b WHERE b->>'type'='action')),
      ('RESOURCE_REQUIRED','resources',NOT c.resource_ready OR EXISTS(SELECT 1 FROM public.content_resource_drafts r LEFT JOIN public.resource_delivery_health h ON h.delivery_reference=r.delivery_reference WHERE r.lesson_id=c.lesson_id AND r.lesson_draft_revision=c.revision AND r.archived_at IS NULL AND (h.delivery_reference IS NULL OR h.state<>'ready' OR NOT public.syntholo_content_nonblank_v1(r.label,1,255) OR NOT public.syntholo_content_nonblank_v1(r.accessible_label,1,255) OR octet_length(r.mime) NOT BETWEEN 3 AND 255 OR r.mime !~ '^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$' OR r.byte_size NOT BETWEEN 0 AND 26214400 OR (r.delivery='external_https' AND NOT public.syntholo_content_https_url_valid_v1(r.delivery_reference)) OR (r.delivery='private_blob' AND (octet_length(r.delivery_reference) NOT BETWEEN 1 AND 1024 OR r.delivery_reference !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$' OR r.delivery_reference LIKE '/%' OR r.delivery_reference LIKE '%..%'))))),
      ('ACCESSIBILITY_REVIEW_REQUIRED','accessibilityDecision',c.accessibility_id IS NULL OR c.accessibility_revision<>c.revision OR c.accessibility_hash<>c.draft_hash OR c.accessibility_decision<>'approved'),
      ('DISCLOSURE_DECISION_REQUIRED','disclosureDecision',c.disclosure_id IS NULL OR c.disclosure_revision<>c.revision OR c.disclosure_hash<>c.draft_hash OR c.disclosure_decision NOT IN ('applicable','not_applicable') OR (c.disclosure_decision='applicable' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.blocks) b WHERE b->>'type'='disclosure' AND b->>'policyVersion'=c.disclosure_policy_version))),
      ('PLACEHOLDER_CONTENT','content',c.placeholder_detected OR c.derived_placeholder OR NOT public.syntholo_content_blocks_valid_v1(c.blocks,c.transcript,c.media_asset_id) OR NOT c.resource_refs_valid),
      ('DURATION_OUT_OF_RANGE','durationSeconds',c.duration_milliseconds IS NULL OR c.duration_seconds IS NULL OR abs(c.duration_milliseconds-c.duration_seconds::bigint*1000)>5000)
    ) issue(code,field,blocked) WHERE blocked
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('code',code,'field',field,'lessonId',p_lesson_id) ORDER BY code,field),'[]'::jsonb) FROM issues
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_lesson_issues_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_content_lesson_issues_v1(uuid) TO syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_publish_lesson_v1(p_lesson_id uuid,p_expected_revision integer,p_reason text) RETURNS public.lesson_versions LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE draft public.lesson_drafts; lesson public.lessons; course_revision integer; issues jsonb; created public.lesson_versions; actor uuid; correlation uuid; next_version integer; draft_hash text; accessibility_head public.lesson_accessibility_review_heads; disclosure_head public.lesson_disclosure_review_heads; event_id uuid:=gen_random_uuid(); occurred timestamptz(3):=date_trunc('milliseconds',clock_timestamp());
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  actor:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation:=nullif(current_setting('app.correlation_id',true),'')::uuid;
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR correlation IS NULL OR p_reason IS NULL OR octet_length(p_reason) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'CONTENT_STAFF_CONTEXT_REQUIRED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('content:lesson:'||p_lesson_id::text,0));
  SELECT * INTO lesson FROM public.lessons WHERE id=p_lesson_id FOR UPDATE;
  SELECT * INTO draft FROM public.lesson_drafts WHERE lesson_id=p_lesson_id FOR UPDATE;
  IF lesson.id IS NULL OR draft.lesson_id IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
  IF draft.revision<>p_expected_revision THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  IF EXISTS(SELECT 1 FROM public.lesson_versions WHERE lesson_id=p_lesson_id AND source_draft_revision=draft.revision) THEN RAISE EXCEPTION 'LESSON_DRAFT_ALREADY_PUBLISHED'; END IF;
  IF draft.media_asset_id IS NOT NULL THEN PERFORM 1 FROM public.content_media_assets WHERE id=draft.media_asset_id FOR UPDATE; PERFORM 1 FROM public.content_media_tracks WHERE media_asset_id=draft.media_asset_id ORDER BY id FOR UPDATE; END IF;
  PERFORM 1 FROM public.content_resource_drafts WHERE lesson_id=p_lesson_id AND lesson_draft_revision=draft.revision ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.resource_delivery_health h JOIN public.content_resource_drafts r ON r.delivery_reference=h.delivery_reference WHERE r.lesson_id=p_lesson_id AND r.lesson_draft_revision=draft.revision AND r.archived_at IS NULL ORDER BY h.delivery_reference FOR UPDATE OF h;
  SELECT * INTO accessibility_head FROM public.lesson_accessibility_review_heads WHERE lesson_id=p_lesson_id FOR UPDATE;
  SELECT * INTO disclosure_head FROM public.lesson_disclosure_review_heads WHERE lesson_id=p_lesson_id FOR UPDATE;
  issues:=public.syntholo_content_lesson_issues_v1(p_lesson_id);
  IF jsonb_array_length(issues)<>0 THEN RAISE EXCEPTION 'CONTENT_NOT_READY' USING DETAIL=issues::text; END IF;
  draft_hash:=public.syntholo_lesson_draft_hash_v1(p_lesson_id);
  SELECT coalesce(max(version),0)+1 INTO next_version FROM public.lesson_versions WHERE lesson_id=p_lesson_id;
  INSERT INTO public.lesson_versions(lesson_id,course_id,stage_id,version,title,summary,duration_seconds,blocks,transcript,media_asset_id,stage_order,"order",required,release_rule,accessibility_decision_id,accessibility_decision_sequence,disclosure_decision_id,disclosure_decision_sequence,content_hash,published_by_staff_id,publish_reason,published_at,source_draft_revision)
  VALUES(draft.lesson_id,draft.course_id,draft.stage_id,next_version,draft.title,draft.summary,draft.duration_seconds,draft.blocks,draft.transcript,draft.media_asset_id,draft.stage_order,draft."order",draft.required,draft.release_rule,accessibility_head.current_decision_id,accessibility_head.decision_sequence,disclosure_head.current_decision_id,disclosure_head.decision_sequence,draft_hash,actor,p_reason,occurred,draft.revision) RETURNING * INTO created;
  INSERT INTO public.lesson_version_resources(lesson_version_id,resource_id,"order",label,accessible_label,delivery,delivery_reference,mime,byte_size,content_hash)
  SELECT created.id,r.id,row_number() OVER(ORDER BY r.id),r.label,r.accessible_label,r.delivery,r.delivery_reference,r.mime,r.byte_size,r.content_hash FROM public.content_resource_drafts r JOIN public.resource_delivery_health h ON h.delivery_reference=r.delivery_reference AND h.state='ready' WHERE r.lesson_id=p_lesson_id AND r.lesson_draft_revision=draft.revision AND r.archived_at IS NULL ORDER BY r.id;
  SELECT current_draft_revision INTO course_revision FROM public.courses WHERE id=draft.course_id FOR UPDATE;
  INSERT INTO public.course_draft_manifest_entries(course_id,course_draft_revision,stage_id,stage_order,lesson_id,lesson_order,required,release_rule,selected_lesson_version_id,selected_lesson_version_hash,readiness_revision)
  VALUES(draft.course_id,course_revision,draft.stage_id,draft.stage_order,draft.lesson_id,draft."order",draft.required,draft.release_rule,created.id,created.content_hash,0)
  ON CONFLICT(course_id,course_draft_revision,lesson_id) DO UPDATE SET stage_id=excluded.stage_id,stage_order=excluded.stage_order,lesson_order=excluded.lesson_order,required=excluded.required,release_rule=excluded.release_rule,selected_lesson_draft_revision=NULL,selected_lesson_draft_hash=NULL,selected_lesson_version_id=excluded.selected_lesson_version_id,selected_lesson_version_hash=excluded.selected_lesson_version_hash,readiness_revision=excluded.readiness_revision;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at) VALUES(gen_random_uuid(),NULL,'staff',actor::text,'content_lesson_published','lesson_version',created.id::text,correlation,jsonb_build_object('courseId',created.course_id::text,'lessonId',created.lesson_id::text,'lessonVersionId',created.id::text,'contentHash',created.content_hash,'version',created.version),occurred);
  INSERT INTO public.outbox_events(event_id,account_id,type,aggregate_id,payload,schema_version,status,attempts,available_at,created_at,occurred_at,actor_type,actor_id,correlation_id,max_attempts,claim_generation) VALUES(event_id,NULL,'content.lesson_published.v1',created.lesson_id::text,jsonb_build_object('courseId',created.course_id::text,'lessonId',created.lesson_id::text,'lessonVersionId',created.id::text,'contentHash',created.content_hash),1,'pending',0,occurred,occurred,occurred,'staff',actor::text,correlation,10,0);
  RETURN created;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_publish_lesson_v1(uuid,integer,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.syntholo_content_publish_lesson_v1(uuid,integer,text) FROM syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_publish_lesson_v2(p_lesson_id uuid,p_expected_revision integer,p_reason text,p_idempotency_key text,p_request_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); receipt public.api_command_receipts; published public.lesson_versions; response_payload jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR p_idempotency_key IS NULL OR octet_length(p_idempotency_key) NOT BETWEEN 16 AND 128 OR p_idempotency_key !~ '^[!-~]+$' OR p_request_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'CONTENT_COMMAND_INVALID'; END IF;
  INSERT INTO public.api_command_receipts(principal_kind,principal_id,method,route_template,idempotency_key,request_hash,status,expires_at,created_at)
  VALUES('staff',actor::text,'POST','/v1/staff/content/lessons/:lessonId/publications',p_idempotency_key,p_request_hash,'in_progress',now_at+interval '30 days',now_at)
  ON CONFLICT(principal_kind,principal_id,method,route_template,idempotency_key) DO NOTHING;
  SELECT * INTO receipt FROM public.api_command_receipts WHERE principal_kind='staff' AND principal_id=actor::text AND method='POST' AND route_template='/v1/staff/content/lessons/:lessonId/publications' AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF receipt.id IS NULL OR receipt.request_hash<>p_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'; END IF;
  IF receipt.status='completed' THEN RETURN receipt.response; END IF;
  published:=public.syntholo_content_publish_lesson_v1(p_lesson_id,p_expected_revision,p_reason);
  response_payload:=jsonb_build_object('id',published.id,'lessonId',published.lesson_id,'courseId',published.course_id,'version',published.version,'contentHash',published.content_hash,'publishedAt',to_char(published.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  UPDATE public.api_command_receipts AS command_receipt SET status='completed',response_status=201,response=response_payload,completed_at=now_at WHERE command_receipt.id=receipt.id;
  RETURN response_payload;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_publish_lesson_v2(uuid,integer,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_content_publish_lesson_v2(uuid,integer,text,text,text) TO syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_manifest_projection_v1(p_course_id uuid,p_draft_revision integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
  WITH lesson_rows AS (
    SELECT e.stage_id,e.stage_order,sd.title stage_title,e.lesson_id,e.lesson_order,e.required,e.release_rule,v.id lesson_version_id,v.content_hash,v.title,v.summary,v.duration_seconds,v.media_asset_id,
      a.signed_policy_playback_id,a.state media_state,a.readiness_revision asset_readiness_revision,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.id,'providerTrackId',t.provider_track_id,'readinessRevision',t.readiness_revision) ORDER BY t.id) FROM public.content_media_tracks t WHERE t.media_asset_id=v.media_asset_id AND t.kind='captions'),'[]'::jsonb) captions,
      coalesce((SELECT jsonb_agg(jsonb_build_object('resourceId',r.resource_id,'order',r."order",'label',r.label,'accessibleLabel',r.accessible_label,'delivery',r.delivery,'mime',r.mime,'byteSize',r.byte_size,'contentHash',r.content_hash,'deliveryState',h.state,'readinessRevision',h.readiness_revision) ORDER BY r."order",r.resource_id) FROM public.lesson_version_resources r LEFT JOIN public.resource_delivery_health h ON h.delivery_reference=r.delivery_reference WHERE r.lesson_version_id=v.id),'[]'::jsonb) resources
    FROM public.course_draft_manifest_entries e JOIN public.stage_drafts sd ON sd.stage_id=e.stage_id JOIN public.lesson_versions v ON v.id=e.selected_lesson_version_id JOIN public.content_media_assets a ON a.id=v.media_asset_id
    WHERE e.course_id=p_course_id AND e.course_draft_revision=p_draft_revision
  ), stages AS (
    SELECT stage_id,stage_order,stage_title,jsonb_agg(jsonb_build_object('id',lesson_id,'order',lesson_order,'required',required,'releaseRule',release_rule,'lessonVersionId',lesson_version_id,'contentHash',content_hash,'title',title,'summary',summary,'durationSeconds',duration_seconds,'mediaAssetId',media_asset_id,'signedPlaybackId',signed_policy_playback_id,'mediaState',media_state,'assetReadinessRevision',asset_readiness_revision,'captions',captions,'resources',resources) ORDER BY lesson_order,lesson_id) lessons FROM lesson_rows GROUP BY stage_id,stage_order,stage_title
  ) SELECT jsonb_build_object('schemaVersion',1,'course',jsonb_build_object('id',c.id,'draftRevision',d.revision,'title',d.title,'description',d.description),'stages',coalesce((SELECT jsonb_agg(jsonb_build_object('id',stage_id,'title',stage_title,'order',stage_order,'lessons',lessons) ORDER BY stage_order,stage_id) FROM stages),'[]'::jsonb)) FROM public.courses c JOIN public.course_drafts d ON d.course_id=c.id WHERE c.id=p_course_id AND d.revision=p_draft_revision
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_manifest_projection_v1(uuid,integer) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_manifest_issues_v1(p_course_id uuid,p_draft_revision integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
  WITH entries AS (
    SELECT e.*,s.slug stage_slug,l.slug lesson_slug,v.media_asset_id,v.duration_seconds,a.state media_state,a.signed_policy_playback_id,a.duration_milliseconds
    FROM public.course_draft_manifest_entries e
    LEFT JOIN public.stages s ON s.id=e.stage_id AND s.course_id=e.course_id
    LEFT JOIN public.lessons l ON l.id=e.lesson_id AND l.course_id=e.course_id
    LEFT JOIN public.lesson_versions v ON v.id=e.selected_lesson_version_id AND v.lesson_id=e.lesson_id AND v.course_id=e.course_id AND v.content_hash=e.selected_lesson_version_hash
    LEFT JOIN public.content_media_assets a ON a.id=v.media_asset_id
    WHERE e.course_id=p_course_id AND e.course_draft_revision=p_draft_revision
  ), expected(stage_order,lesson_order,stage_slug,lesson_slug) AS (VALUES
    (1,1,'diagnose','diagnose-1'),(1,2,'diagnose','diagnose-2'),(1,3,'diagnose','diagnose-3'),
    (2,4,'rules','rules-1'),(2,5,'rules','rules-2'),(2,6,'rules','rules-3'),
    (3,7,'growth','growth-1'),(3,8,'growth','growth-2'),(3,9,'growth','growth-3'),
    (4,10,'client','client-1'),(4,11,'client','client-2'),(4,12,'client','client-3'),
    (5,13,'management','management-1'),(5,14,'management','management-2'),(5,15,'management','management-3'),
    (6,16,'launch','launch-1'),(6,17,'launch','launch-2'),(6,18,'launch','launch-3')
  ), structural AS (
    SELECT array_agg(lesson_slug ORDER BY lesson_order) FILTER(WHERE required) lesson_slugs,array_agg(DISTINCT stage_slug ORDER BY stage_slug) stage_slugs,
      count(*) FILTER(WHERE required) required_count,count(*) entry_count,count(*) FILTER(WHERE selected_lesson_version_id IS NOT NULL) exact_version_count,
      count(DISTINCT lesson_order) FILTER(WHERE required) required_order_count,min(lesson_order) FILTER(WHERE required) first_order,max(lesson_order) FILTER(WHERE required) last_order,
      count(*) FILTER(WHERE required AND EXISTS(SELECT 1 FROM expected x WHERE x.stage_order=entries.stage_order AND x.lesson_order=entries.lesson_order AND x.stage_slug=entries.stage_slug AND x.lesson_slug=entries.lesson_slug)) mapping_count
    FROM entries
  ), issues AS (
    SELECT 0 sort_group,NULL::uuid lesson_id,'PLACEHOLDER_CONTENT'::text code,'manifest'::text field FROM structural WHERE NOT (required_count=18 AND entry_count=exact_version_count AND required_order_count=18 AND first_order=1 AND last_order=18 AND mapping_count=18 AND lesson_slugs=ARRAY['diagnose-1','diagnose-2','diagnose-3','rules-1','rules-2','rules-3','growth-1','growth-2','growth-3','client-1','client-2','client-3','management-1','management-2','management-3','launch-1','launch-2','launch-3']::text[] AND stage_slugs=ARRAY['client','diagnose','growth','launch','management','rules']::text[])
    UNION ALL SELECT 0,NULL::uuid,'TITLE_REQUIRED','course.title' FROM public.course_drafts d WHERE d.course_id=p_course_id AND d.revision=p_draft_revision AND (NOT public.syntholo_content_nonblank_v1(d.title,1,255) OR d.title~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)')
    UNION ALL SELECT 0,NULL::uuid,'SUMMARY_REQUIRED','course.description' FROM public.course_drafts d WHERE d.course_id=p_course_id AND d.revision=p_draft_revision AND (NOT public.syntholo_content_nonblank_v1(d.description,1,10000) OR d.description~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)')
    UNION ALL SELECT 0,NULL::uuid,'TITLE_REQUIRED','stage.title' FROM public.stage_drafts sd WHERE sd.course_id=p_course_id AND (NOT public.syntholo_content_nonblank_v1(sd.title,1,255) OR sd.title~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)') AND EXISTS(SELECT 1 FROM entries e WHERE e.stage_id=sd.stage_id)
    UNION ALL SELECT 1,lesson_id,'PLACEHOLDER_CONTENT','lessonVersionId' FROM entries WHERE selected_lesson_version_id IS NULL
    UNION ALL SELECT 2,lesson_id,'VIDEO_NOT_READY','mediaAssetId' FROM entries WHERE selected_lesson_version_id IS NOT NULL AND (media_asset_id IS NULL OR media_state<>'ready')
    UNION ALL SELECT 3,lesson_id,'SIGNED_PLAYBACK_REQUIRED','mediaAssetId' FROM entries WHERE selected_lesson_version_id IS NOT NULL AND signed_policy_playback_id IS NULL
    UNION ALL SELECT 4,lesson_id,'DURATION_OUT_OF_RANGE','durationSeconds' FROM entries WHERE selected_lesson_version_id IS NOT NULL AND (duration_milliseconds IS NULL OR abs(duration_milliseconds-duration_seconds::bigint*1000)>5000)
    UNION ALL SELECT 5,e.lesson_id,'CAPTIONS_REQUIRED','captions' FROM entries e WHERE e.selected_lesson_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.content_media_tracks t WHERE t.media_asset_id=e.media_asset_id AND t.kind='captions' AND lower(t.language) LIKE 'en%' AND t.closed_captions AND t.state='ready')
    UNION ALL SELECT 6,e.lesson_id,'RESOURCE_REQUIRED','resources' FROM entries e WHERE e.selected_lesson_version_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM public.lesson_version_resources r WHERE r.lesson_version_id=e.selected_lesson_version_id) OR EXISTS(SELECT 1 FROM public.lesson_version_resources r LEFT JOIN public.resource_delivery_health h ON h.delivery_reference=r.delivery_reference WHERE r.lesson_version_id=e.selected_lesson_version_id AND (h.delivery_reference IS NULL OR h.state<>'ready')))
    UNION ALL SELECT 7,e.lesson_id,'PLACEHOLDER_CONTENT','archive' FROM entries e WHERE EXISTS(SELECT 1 FROM public.content_archives a WHERE a.target_kind='lesson' AND a.target_version_id=e.selected_lesson_version_id)
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('code',code,'field',field,'lessonId',lesson_id) ORDER BY sort_group,lesson_id,code,field),'[]'::jsonb) FROM issues
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_manifest_issues_v1(uuid,integer) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_manifest_ready_v1(p_course_id uuid,p_draft_revision integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
  SELECT jsonb_array_length(public.syntholo_content_manifest_issues_v1(p_course_id,p_draft_revision))=0
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_manifest_ready_v1(uuid,integer) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_get_preview_v1(p_course_id uuid,p_draft_revision integer DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE selected_revision integer; projection jsonb; issues jsonb; canonical text; candidate_hash text; actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR correlation IS NULL OR (p_draft_revision IS NOT NULL AND p_draft_revision<1) THEN RAISE EXCEPTION 'CONTENT_STAFF_CONTEXT_REQUIRED'; END IF;
  SELECT d.revision INTO selected_revision FROM public.course_drafts d WHERE d.course_id=p_course_id AND (p_draft_revision IS NULL OR d.revision=p_draft_revision);
  IF selected_revision IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
  projection:=public.syntholo_content_manifest_projection_v1(p_course_id,selected_revision);
  IF projection IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
  issues:=public.syntholo_content_manifest_issues_v1(p_course_id,selected_revision);
  canonical:=public.syntholo_canonical_jsonb_text_v1(projection);
  candidate_hash:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
  RETURN jsonb_build_object('draftRevision',selected_revision,'candidateManifestHash',candidate_hash,'manifest',projection,'publicationIssues',issues);
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_get_preview_v1(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_content_get_preview_v1(uuid,integer) TO syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_create_preview_v2(p_course_id uuid,p_expected_revision integer,p_reason text) RETURNS public.content_previews LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE draft public.course_drafts; projection jsonb; canonical text; hash text; issues jsonb:='[]'::jsonb; created public.content_previews; actor uuid; correlation uuid; occurred timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); required_count integer; stage_count integer;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  actor:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation:=nullif(current_setting('app.correlation_id',true),'')::uuid;
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR correlation IS NULL OR p_reason IS NULL OR octet_length(p_reason) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'CONTENT_STAFF_CONTEXT_REQUIRED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('content:course:'||p_course_id::text,0));
  SELECT * INTO draft FROM public.course_drafts WHERE course_id=p_course_id FOR UPDATE;
  IF draft.course_id IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
  IF draft.revision<>p_expected_revision THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('content:lesson:'||lesson_id::text,0)) FROM public.course_draft_manifest_entries WHERE course_id=p_course_id AND course_draft_revision=p_expected_revision ORDER BY lesson_id;
  PERFORM 1 FROM public.stage_drafts sd JOIN public.course_draft_manifest_entries e ON e.stage_id=sd.stage_id WHERE e.course_id=p_course_id AND e.course_draft_revision=p_expected_revision ORDER BY sd.stage_id FOR UPDATE OF sd;
  PERFORM 1 FROM public.course_draft_manifest_entries WHERE course_id=p_course_id AND course_draft_revision=p_expected_revision ORDER BY lesson_id FOR UPDATE;
  PERFORM 1 FROM public.lesson_versions v JOIN public.course_draft_manifest_entries e ON e.selected_lesson_version_id=v.id WHERE e.course_id=p_course_id AND e.course_draft_revision=p_expected_revision ORDER BY v.id FOR UPDATE OF v;
  PERFORM 1 FROM public.content_media_assets a JOIN public.lesson_versions v ON v.media_asset_id=a.id JOIN public.course_draft_manifest_entries e ON e.selected_lesson_version_id=v.id WHERE e.course_id=p_course_id AND e.course_draft_revision=p_expected_revision ORDER BY a.id FOR UPDATE OF a;
  PERFORM 1 FROM public.content_media_tracks t JOIN public.lesson_versions v ON v.media_asset_id=t.media_asset_id JOIN public.course_draft_manifest_entries e ON e.selected_lesson_version_id=v.id WHERE e.course_id=p_course_id AND e.course_draft_revision=p_expected_revision ORDER BY t.id FOR UPDATE OF t;
  PERFORM 1 FROM public.resource_delivery_health h JOIN public.lesson_version_resources r ON r.delivery_reference=h.delivery_reference JOIN public.course_draft_manifest_entries e ON e.selected_lesson_version_id=r.lesson_version_id WHERE e.course_id=p_course_id AND e.course_draft_revision=p_expected_revision ORDER BY h.delivery_reference FOR UPDATE OF h;
  PERFORM 1 FROM public.content_archives a JOIN public.course_draft_manifest_entries e ON a.target_kind='lesson' AND a.target_version_id=e.selected_lesson_version_id WHERE e.course_id=p_course_id AND e.course_draft_revision=p_expected_revision ORDER BY a.target_version_id FOR UPDATE OF a;
  projection:=public.syntholo_content_manifest_projection_v1(p_course_id,p_expected_revision);
  IF projection IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
  SELECT count(*) FILTER(WHERE e.required),count(DISTINCT e.stage_id) INTO required_count,stage_count FROM public.course_draft_manifest_entries e WHERE e.course_id=p_course_id AND e.course_draft_revision=p_expected_revision;
  issues:=public.syntholo_content_manifest_issues_v1(p_course_id,p_expected_revision);
  canonical:=public.syntholo_canonical_jsonb_text_v1(projection); hash:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
  INSERT INTO public.content_previews(course_id,draft_revision,manifest_canonical_json,manifest_hash,manifest_projection,publication_issues,created_by_staff_id,reason,created_at) VALUES(p_course_id,p_expected_revision,canonical,hash,projection,issues,actor,p_reason,occurred) RETURNING * INTO created;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at) VALUES(gen_random_uuid(),NULL,'staff',actor::text,'content_preview_materialized','course',p_course_id::text,correlation,jsonb_build_object('previewId',created.id::text,'draftRevision',created.draft_revision,'manifestHash',created.manifest_hash),occurred);
  RETURN created;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_create_preview_v2(uuid,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.syntholo_content_create_preview_v1(uuid,integer,text,text,jsonb,jsonb,text) FROM syntholo_staff_api;
REVOKE ALL ON FUNCTION public.syntholo_content_create_preview_v2(uuid,integer,text) FROM syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_create_preview_v3(p_course_id uuid,p_expected_revision integer,p_reason text,p_idempotency_key text,p_request_hash text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); receipt public.api_command_receipts; created public.content_previews; response_payload jsonb; claimed boolean;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR p_idempotency_key IS NULL OR octet_length(p_idempotency_key) NOT BETWEEN 16 AND 128 OR p_idempotency_key !~ '^[!-~]+$' OR p_request_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'CONTENT_COMMAND_INVALID'; END IF;
  INSERT INTO public.api_command_receipts(principal_kind,principal_id,method,route_template,idempotency_key,request_hash,status,expires_at,created_at)
  VALUES('staff',actor::text,'POST','/v1/staff/content/courses/:courseId/previews',p_idempotency_key,p_request_hash,'in_progress',now_at+interval '30 days',now_at)
  ON CONFLICT(principal_kind,principal_id,method,route_template,idempotency_key) DO NOTHING
  RETURNING * INTO receipt;
  claimed:=FOUND;
  IF NOT claimed THEN
    SELECT * INTO receipt FROM public.api_command_receipts WHERE principal_kind='staff' AND principal_id=actor::text AND method='POST' AND route_template='/v1/staff/content/courses/:courseId/previews' AND idempotency_key=p_idempotency_key FOR UPDATE;
    IF receipt.id IS NULL OR receipt.request_hash<>p_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'; END IF;
    IF receipt.status='completed' THEN RETURN receipt.response; END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS';
  END IF;
  created:=public.syntholo_content_create_preview_v2(p_course_id,p_expected_revision,p_reason);
  response_payload:=jsonb_build_object('previewId',created.id,'manifestHash',created.manifest_hash,'manifest',created.manifest_projection,'publicationIssues',created.publication_issues,'createdAt',to_char(created.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  UPDATE public.api_command_receipts AS command_receipt SET status='completed',response_status=201,response=response_payload,completed_at=now_at WHERE command_receipt.id=receipt.id;
  RETURN response_payload;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_create_preview_v3(uuid,integer,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_content_create_preview_v3(uuid,integer,text,text,text) TO syntholo_staff_api;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.syntholo_content_publish_course_v1(p_preview_id uuid,p_expected_manifest_hash text,p_expected_head_revision integer,p_reason text)
RETURNS public.course_versions LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE preview public.content_previews; draft public.course_drafts; head public.course_heads; created public.course_versions; actor uuid; correlation uuid; occurred timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); event_id uuid:=gen_random_uuid(); next_version integer; projection jsonb; canonical text; derived_hash text; required_count integer; stage_count integer;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  actor:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation:=nullif(current_setting('app.correlation_id',true),'')::uuid;
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR correlation IS NULL OR p_reason IS NULL OR octet_length(p_reason) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'CONTENT_STAFF_CONTEXT_REQUIRED'; END IF;
  SELECT * INTO preview FROM public.content_previews WHERE id=p_preview_id FOR UPDATE;
  IF preview.id IS NULL OR preview.manifest_hash<>p_expected_manifest_hash THEN RAISE EXCEPTION 'MANIFEST_CHANGED'; END IF;
  IF EXISTS(SELECT 1 FROM public.course_versions WHERE source_preview_id=preview.id) THEN RAISE EXCEPTION 'PREVIEW_ALREADY_PUBLISHED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('content:course:'||preview.course_id::text,0));
  SELECT * INTO draft FROM public.course_drafts WHERE course_id=preview.course_id FOR UPDATE;
  IF draft.course_id IS NULL OR draft.revision<>preview.draft_revision THEN RAISE EXCEPTION 'MANIFEST_CHANGED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('content:lesson:'||lesson_id::text,0)) FROM public.course_draft_manifest_entries WHERE course_id=preview.course_id AND course_draft_revision=preview.draft_revision ORDER BY lesson_id;
  PERFORM 1 FROM public.stage_drafts sd JOIN public.course_draft_manifest_entries e ON e.stage_id=sd.stage_id WHERE e.course_id=preview.course_id AND e.course_draft_revision=preview.draft_revision ORDER BY sd.stage_id FOR UPDATE OF sd;
  PERFORM 1 FROM public.course_draft_manifest_entries WHERE course_id=preview.course_id AND course_draft_revision=preview.draft_revision ORDER BY lesson_id FOR UPDATE;
  PERFORM 1 FROM public.lesson_versions v JOIN public.course_draft_manifest_entries e ON e.selected_lesson_version_id=v.id WHERE e.course_id=preview.course_id AND e.course_draft_revision=preview.draft_revision ORDER BY v.id FOR UPDATE OF v;
  PERFORM 1 FROM public.content_media_assets a JOIN public.lesson_versions v ON v.media_asset_id=a.id JOIN public.course_draft_manifest_entries e ON e.selected_lesson_version_id=v.id WHERE e.course_id=preview.course_id AND e.course_draft_revision=preview.draft_revision ORDER BY a.id FOR UPDATE OF a;
  PERFORM 1 FROM public.content_media_tracks t JOIN public.lesson_versions v ON v.media_asset_id=t.media_asset_id JOIN public.course_draft_manifest_entries e ON e.selected_lesson_version_id=v.id WHERE e.course_id=preview.course_id AND e.course_draft_revision=preview.draft_revision ORDER BY t.id FOR UPDATE OF t;
  PERFORM 1 FROM public.resource_delivery_health h JOIN public.lesson_version_resources r ON r.delivery_reference=h.delivery_reference JOIN public.course_draft_manifest_entries e ON e.selected_lesson_version_id=r.lesson_version_id WHERE e.course_id=preview.course_id AND e.course_draft_revision=preview.draft_revision ORDER BY h.delivery_reference FOR UPDATE OF h;
  PERFORM 1 FROM public.content_archives a JOIN public.course_draft_manifest_entries e ON a.target_kind='lesson' AND a.target_version_id=e.selected_lesson_version_id WHERE e.course_id=preview.course_id AND e.course_draft_revision=preview.draft_revision ORDER BY a.target_version_id FOR UPDATE OF a;
  projection:=public.syntholo_content_manifest_projection_v1(preview.course_id,preview.draft_revision); canonical:=public.syntholo_canonical_jsonb_text_v1(projection); derived_hash:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
  IF derived_hash<>preview.manifest_hash OR canonical<>preview.manifest_canonical_json OR projection<>preview.manifest_projection THEN RAISE EXCEPTION 'MANIFEST_CHANGED'; END IF;
  IF jsonb_array_length(preview.publication_issues)<>0 OR NOT public.syntholo_content_manifest_ready_v1(preview.course_id,preview.draft_revision) THEN RAISE EXCEPTION 'CONTENT_NOT_READY' USING DETAIL=public.syntholo_content_manifest_issues_v1(preview.course_id,preview.draft_revision)::text; END IF;
  SELECT count(*) FILTER(WHERE required),count(DISTINCT stage_id) INTO required_count,stage_count FROM public.course_draft_manifest_entries WHERE course_id=preview.course_id AND course_draft_revision=preview.draft_revision;
  IF required_count<>18 OR stage_count<>6 THEN RAISE EXCEPTION 'CONTENT_NOT_READY'; END IF;
  SELECT * INTO head FROM public.course_heads WHERE course_id=preview.course_id AND channel='production' FOR UPDATE;
  IF (head.course_id IS NULL AND p_expected_head_revision<>0) OR (head.course_id IS NOT NULL AND head.head_revision<>p_expected_head_revision) THEN RAISE EXCEPTION 'COURSE_HEAD_CHANGED'; END IF;
  SELECT coalesce(max(version),0)+1 INTO next_version FROM public.course_versions WHERE course_id=preview.course_id;
  INSERT INTO public.course_versions(course_id,version,title,description,manifest_hash,source_preview_id,published_by_staff_id,publish_reason,published_at) VALUES(preview.course_id,next_version,draft.title,draft.description,preview.manifest_hash,preview.id,actor,p_reason,occurred) RETURNING * INTO created;
  INSERT INTO public.course_version_lessons(course_version_id,course_id,lesson_id,lesson_version_id,stage_id,stage_title,stage_order,lesson_order,required,release_rule)
  SELECT created.id,e.course_id,e.lesson_id,e.selected_lesson_version_id,e.stage_id,sd.title,e.stage_order,e.lesson_order,e.required,e.release_rule FROM public.course_draft_manifest_entries e JOIN public.stage_drafts sd ON sd.stage_id=e.stage_id WHERE e.course_id=preview.course_id AND e.course_draft_revision=preview.draft_revision ORDER BY e.lesson_order;
  IF head.course_id IS NULL THEN
    INSERT INTO public.course_heads(course_id,channel,current_course_version_id,manifest_hash,head_revision,set_by_staff_id,set_at) VALUES(preview.course_id,'production',created.id,created.manifest_hash,1,actor,occurred);
  ELSE
    UPDATE public.course_heads SET current_course_version_id=created.id,manifest_hash=created.manifest_hash,head_revision=head.head_revision+1,set_by_staff_id=actor,set_at=occurred WHERE course_id=preview.course_id AND channel='production' AND head_revision=p_expected_head_revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'COURSE_HEAD_CHANGED'; END IF;
  END IF;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at) VALUES(gen_random_uuid(),NULL,'staff',actor::text,'content_course_published','course_version',created.id::text,correlation,jsonb_build_object('courseId',created.course_id::text,'courseVersionId',created.id::text,'manifestHash',created.manifest_hash,'version',created.version),occurred);
  INSERT INTO public.outbox_events(event_id,account_id,type,aggregate_id,payload,schema_version,status,attempts,available_at,created_at,occurred_at,actor_type,actor_id,correlation_id,max_attempts,claim_generation) VALUES(event_id,NULL,'content.course_published.v1',created.course_id::text,jsonb_build_object('courseId',created.course_id::text,'courseVersionId',created.id::text,'manifestHash',created.manifest_hash),1,'pending',0,occurred,occurred,occurred,'staff',actor::text,correlation,10,0);
  RETURN created;
END $f$;
--> statement-breakpoint
ALTER TABLE public.course_versions ADD CONSTRAINT course_versions_source_preview_unique UNIQUE(source_preview_id);
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.syntholo_content_publish_course_v1(uuid,text,integer,text) FROM syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_publish_course_v2(p_preview_id uuid,p_expected_manifest_hash text,p_expected_head_revision integer,p_reason text,p_idempotency_key text,p_request_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); receipt public.api_command_receipts; published public.course_versions; head_revision integer; response_payload jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR p_idempotency_key IS NULL OR octet_length(p_idempotency_key) NOT BETWEEN 16 AND 128 OR p_idempotency_key !~ '^[!-~]+$' OR p_request_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'CONTENT_COMMAND_INVALID'; END IF;
  INSERT INTO public.api_command_receipts(principal_kind,principal_id,method,route_template,idempotency_key,request_hash,status,expires_at,created_at)
  VALUES('staff',actor::text,'POST','/v1/staff/content/courses/:courseId/publications',p_idempotency_key,p_request_hash,'in_progress',now_at+interval '30 days',now_at)
  ON CONFLICT(principal_kind,principal_id,method,route_template,idempotency_key) DO NOTHING;
  SELECT * INTO receipt FROM public.api_command_receipts WHERE principal_kind='staff' AND principal_id=actor::text AND method='POST' AND route_template='/v1/staff/content/courses/:courseId/publications' AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF receipt.id IS NULL OR receipt.request_hash<>p_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'; END IF;
  IF receipt.status='completed' THEN RETURN receipt.response; END IF;
  published:=public.syntholo_content_publish_course_v1(p_preview_id,p_expected_manifest_hash,p_expected_head_revision,p_reason);
  SELECT h.head_revision INTO head_revision FROM public.course_heads h WHERE h.course_id=published.course_id AND h.channel='production';
  response_payload:=jsonb_build_object('id',published.id,'courseId',published.course_id,'version',published.version,'manifestHash',published.manifest_hash,'headRevision',head_revision,'publishedAt',to_char(published.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  UPDATE public.api_command_receipts AS command_receipt SET status='completed',response_status=201,response=response_payload,completed_at=now_at WHERE command_receipt.id=receipt.id;
  RETURN response_payload;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_publish_course_v2(uuid,text,integer,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_content_publish_course_v2(uuid,text,integer,text,text,text) TO syntholo_staff_api;
--> statement-breakpoint
DROP FUNCTION public.syntholo_content_readiness_v1();
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_readiness_v1() RETURNS TABLE(
  contract_version text,migration_created_at bigint,migration_hash text,object_count integer,
  object_owner_ready boolean,object_type_ready boolean,immutable_triggers_ready boolean,
  table_acl_ready boolean,function_acl_ready boolean,public_execute_denied boolean,empty_catalog boolean,
  learning_contract_version text,learning_migration_created_at bigint,learning_migration_hash text,
  learning_table_ready boolean,learning_structure_ready boolean,learning_immutability_ready boolean,
  learning_rls_ready boolean,learning_acl_ready boolean,
  learning_function_ready boolean,learning_public_execute_denied boolean
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
  WITH required(name) AS (VALUES
    ('courses'),('course_drafts'),('stages'),('stage_drafts'),('lessons'),('lesson_drafts'),('lesson_accessibility_decisions'),('lesson_accessibility_review_heads'),('lesson_disclosure_decisions'),('lesson_disclosure_review_heads'),('lesson_versions'),('course_draft_manifest_entries'),('content_previews'),('course_versions'),('course_version_lessons'),('course_heads'),('content_resource_drafts'),('lesson_version_resources'),('resource_delivery_health'),('content_schedules'),('content_archives'),('content_readiness_evaluations'),('content_readiness_approvals'),('api_command_receipts')
  ), relations AS (
    SELECT r.name,c.oid,c.relkind,c.relowner,c.relacl FROM required r LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||r.name)
  ), expected_functions(signature,security_definer) AS (VALUES
    ('public.syntholo_content_immutable_row()',false),
    ('public.syntholo_content_create_preview_v1(uuid,integer,text,text,jsonb,jsonb,text)',true),
    ('public.syntholo_content_publish_course_v1(uuid,text,integer,text)',true),
    ('public.syntholo_content_readiness_v1()',true),
    ('public.syntholo_lesson_draft_hash_v1(uuid)',true),
    ('public.syntholo_content_nonblank_v1(text,integer,integer)',false),
    ('public.syntholo_content_https_url_valid_v1(text)',false),
    ('public.syntholo_content_document_valid_v1(jsonb)',false),
    ('public.syntholo_content_blocks_valid_v1(jsonb,jsonb,uuid)',false),
    ('public.syntholo_content_lesson_issues_v1(uuid)',true),
    ('public.syntholo_content_publish_lesson_v1(uuid,integer,text)',true),
    ('public.syntholo_content_publish_lesson_v2(uuid,integer,text,text,text)',true),
    ('public.syntholo_content_manifest_projection_v1(uuid,integer)',true),
    ('public.syntholo_content_manifest_issues_v1(uuid,integer)',true),
    ('public.syntholo_content_manifest_ready_v1(uuid,integer)',true),
    ('public.syntholo_content_get_preview_v1(uuid,integer)',true),
    ('public.syntholo_content_create_preview_v2(uuid,integer,text)',true),
    ('public.syntholo_content_create_preview_v3(uuid,integer,text,text,text)',true),
    ('public.syntholo_content_publish_course_v2(uuid,text,integer,text,text,text)',true)
  ), content_functions AS (
    SELECT e.signature,e.security_definer,p.oid,p.proowner,p.prokind,p.prosecdef,p.proconfig,p.proacl FROM expected_functions e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)
  ), function_owner AS (
    SELECT proowner FROM content_functions WHERE signature='public.syntholo_content_readiness_v1()'
  ), immutable_relations(name) AS (VALUES
    ('lesson_accessibility_decisions'),('lesson_disclosure_decisions'),('lesson_versions'),('content_previews'),('course_versions'),('course_version_lessons'),('lesson_version_resources'),('content_archives'),('content_readiness_evaluations'),('content_readiness_approvals')
  ), expected_triggers(table_name,trigger_name) AS (
    SELECT name,name||'_immutable' FROM immutable_relations
  ), actual_immutable_triggers AS (
    SELECT c.relname table_name,t.tgname trigger_name,t.tgtype,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND t.tgfoid=to_regprocedure('public.syntholo_content_immutable_row()')
  ), staff_table_acl(name,privileges) AS (VALUES
    ('courses',ARRAY['SELECT','INSERT']::text[]),('stages',ARRAY['SELECT','INSERT']::text[]),('lessons',ARRAY['SELECT','INSERT']::text[]),
    ('course_drafts',ARRAY['SELECT','INSERT','UPDATE']::text[]),('stage_drafts',ARRAY['SELECT','INSERT','UPDATE']::text[]),('lesson_drafts',ARRAY['SELECT','INSERT','UPDATE']::text[]),('content_resource_drafts',ARRAY['SELECT','INSERT','UPDATE']::text[]),
    ('lesson_accessibility_decisions',ARRAY['SELECT']::text[]),('lesson_accessibility_review_heads',ARRAY['SELECT']::text[]),('lesson_disclosure_decisions',ARRAY['SELECT']::text[]),('lesson_disclosure_review_heads',ARRAY['SELECT']::text[]),('lesson_versions',ARRAY['SELECT']::text[]),('course_draft_manifest_entries',ARRAY['SELECT']::text[]),('content_previews',ARRAY['SELECT']::text[]),('course_versions',ARRAY['SELECT']::text[]),('course_version_lessons',ARRAY['SELECT']::text[]),('course_heads',ARRAY['SELECT']::text[]),('lesson_version_resources',ARRAY['SELECT']::text[]),('resource_delivery_health',ARRAY['SELECT']::text[]),('content_schedules',ARRAY['SELECT']::text[]),('content_archives',ARRAY['SELECT']::text[]),('content_readiness_evaluations',ARRAY['SELECT']::text[]),('content_readiness_approvals',ARRAY['SELECT']::text[])
  ), expected_table_acl(role_name,table_name,privilege_type) AS (
    SELECT 'syntholo_migrator',r.name,p FROM required r CROSS JOIN LATERAL unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']::text[]) p
    UNION ALL SELECT 'syntholo_staff_api',s.name,p FROM staff_table_acl s CROSS JOIN LATERAL unnest(s.privileges) p
  ), actual_table_acl AS (
    SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END role_name,c.name table_name,a.privilege_type
    FROM relations c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,'{}'::aclitem[])) a
    WHERE CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END IN ('PUBLIC','syntholo_migrator','syntholo_member_api','syntholo_staff_api','syntholo_worker','syntholo_system_api')
  ), expected_function_acl(signature,role_name,privilege_type) AS (VALUES
    ('public.syntholo_lesson_draft_hash_v1(uuid)','syntholo_staff_api','EXECUTE'),
    ('public.syntholo_content_lesson_issues_v1(uuid)','syntholo_staff_api','EXECUTE'),
    ('public.syntholo_content_publish_lesson_v2(uuid,integer,text,text,text)','syntholo_staff_api','EXECUTE'),
    ('public.syntholo_content_get_preview_v1(uuid,integer)','syntholo_staff_api','EXECUTE'),
    ('public.syntholo_content_create_preview_v3(uuid,integer,text,text,text)','syntholo_staff_api','EXECUTE'),
    ('public.syntholo_content_publish_course_v2(uuid,text,integer,text,text,text)','syntholo_staff_api','EXECUTE'),
    ('public.syntholo_content_readiness_v1()','syntholo_migrator','EXECUTE'),
    ('public.syntholo_content_readiness_v1()','syntholo_member_api','EXECUTE'),
    ('public.syntholo_content_readiness_v1()','syntholo_staff_api','EXECUTE'),
    ('public.syntholo_content_readiness_v1()','syntholo_worker','EXECUTE'),
    ('public.syntholo_content_readiness_v1()','syntholo_system_api','EXECUTE')
  ), actual_function_acl AS (
    SELECT p.signature,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END role_name,a.privilege_type
    FROM content_functions p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,'{}'::aclitem[])) a
    WHERE CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END IN ('PUBLIC','syntholo_migrator','syntholo_member_api','syntholo_staff_api','syntholo_worker','syntholo_system_api')
  ), learning_required(name) AS (VALUES
    ('account_course_accesses'),('enrollments'),('enrollment_version_transitions'),('lesson_progress'),('lesson_completions'),('course_completions'),('certificate_prerequisites')
  ), learning_relations AS (
    SELECT r.name,c.oid,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity FROM learning_required r LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||r.name)
  ), expected_learning_policies_raw(table_name,policy_name,permissive,command_name,role_names,qual,with_check) AS (VALUES
    ('account_course_accesses','account_course_accesses_member_read',true,'r',ARRAY['syntholo_member_api']::text[],E'account_id=nullif(current_setting(\'app.account_id\',true),\'\')::uuid',E''),
    ('account_course_accesses','account_course_accesses_migrator',true,'*',ARRAY['syntholo_migrator']::text[],E'true',E'true'),
    ('enrollments','enrollments_member_read',true,'r',ARRAY['syntholo_member_api']::text[],E'account_id=nullif(current_setting(\'app.account_id\',true),\'\')::uuid AND membership_id=nullif(current_setting(\'app.membership_id\',true),\'\')::uuid',E''),
    ('enrollments','enrollments_migrator',true,'*',ARRAY['syntholo_migrator']::text[],E'true',E'true'),
    ('enrollment_version_transitions','enrollment_transitions_member_read',true,'r',ARRAY['syntholo_member_api']::text[],E'account_id=nullif(current_setting(\'app.account_id\',true),\'\')::uuid AND membership_id=nullif(current_setting(\'app.membership_id\',true),\'\')::uuid',E''),
    ('enrollment_version_transitions','enrollment_transitions_migrator',true,'*',ARRAY['syntholo_migrator']::text[],E'true',E'true'),
    ('lesson_progress','lesson_progress_member_all',true,'*',ARRAY['syntholo_member_api']::text[],E'account_id=nullif(current_setting(\'app.account_id\',true),\'\')::uuid AND membership_id=nullif(current_setting(\'app.membership_id\',true),\'\')::uuid',E'account_id=nullif(current_setting(\'app.account_id\',true),\'\')::uuid AND membership_id=nullif(current_setting(\'app.membership_id\',true),\'\')::uuid'),
    ('lesson_progress','lesson_progress_migrator',true,'*',ARRAY['syntholo_migrator']::text[],E'true',E'true'),
    ('lesson_completions','lesson_completions_member_read',true,'r',ARRAY['syntholo_member_api']::text[],E'account_id=nullif(current_setting(\'app.account_id\',true),\'\')::uuid AND membership_id=nullif(current_setting(\'app.membership_id\',true),\'\')::uuid',E''),
    ('lesson_completions','lesson_completions_migrator',true,'*',ARRAY['syntholo_migrator']::text[],E'true',E'true'),
    ('course_completions','course_completions_member_read',true,'r',ARRAY['syntholo_member_api']::text[],E'account_id=nullif(current_setting(\'app.account_id\',true),\'\')::uuid AND membership_id=nullif(current_setting(\'app.membership_id\',true),\'\')::uuid',E''),
    ('course_completions','course_completions_migrator',true,'*',ARRAY['syntholo_migrator']::text[],E'true',E'true'),
    ('certificate_prerequisites','certificate_prerequisites_member_read',true,'r',ARRAY['syntholo_member_api']::text[],E'account_id=nullif(current_setting(\'app.account_id\',true),\'\')::uuid AND membership_id=nullif(current_setting(\'app.membership_id\',true),\'\')::uuid',E''),
    ('certificate_prerequisites','certificate_prerequisites_worker',true,'*',ARRAY['syntholo_worker']::text[],E'true',E'true'),
    ('certificate_prerequisites','certificate_prerequisites_migrator',true,'*',ARRAY['syntholo_migrator']::text[],E'true',E'true')
  ), expected_learning_policies AS (
    SELECT table_name,policy_name,permissive,command_name,role_names,
      regexp_replace(replace(lower(qual),'::text',''),'[[:space:]()]','','g') qual,
      regexp_replace(replace(lower(with_check),'::text',''),'[[:space:]()]','','g') with_check
    FROM expected_learning_policies_raw
  ), actual_learning_policies AS (
    SELECT c.relname table_name,p.polname policy_name,p.polpermissive permissive,p.polcmd::text command_name,
      ARRAY(SELECT r.rolname FROM unnest(p.polroles) AS role_oid(oid) JOIN pg_roles r ON r.oid=role_oid.oid ORDER BY r.rolname) role_names,
      regexp_replace(replace(lower(coalesce(pg_get_expr(p.polqual,p.polrelid),'')),'::text',''),'[[:space:]()]','','g') qual,
      regexp_replace(replace(lower(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')),'::text',''),'[[:space:]()]','','g') with_check
    FROM pg_policy p JOIN learning_relations required_relation ON required_relation.oid=p.polrelid JOIN pg_class c ON c.oid=p.polrelid
  ), expected_learning_fks(table_name,constraint_name,column_names,foreign_table,foreign_column_names) AS (VALUES
    ('account_course_accesses','account_course_accesses_account_id_fkey',ARRAY['account_id']::text[],'accounts',ARRAY['id']::text[]),
    ('account_course_accesses','account_course_accesses_course_id_fkey',ARRAY['course_id']::text[],'courses',ARRAY['id']::text[]),
    ('account_course_accesses','account_course_accesses_source_account_fk',ARRAY['entitlement_source_id','account_id']::text[],'entitlement_sources',ARRAY['id','account_id']::text[]),
    ('account_course_accesses','account_course_accesses_version_course_fk',ARRAY['course_version_id','course_id']::text[],'course_versions',ARRAY['id','course_id']::text[]),
    ('enrollments','enrollments_membership_account_fk',ARRAY['membership_id','account_id']::text[],'memberships',ARRAY['id','account_id']::text[]),
    ('enrollments','enrollments_access_exact_fk',ARRAY['account_course_access_id','account_id','course_id','course_version_id']::text[],'account_course_accesses',ARRAY['id','account_id','course_id','course_version_id']::text[]),
    ('enrollment_version_transitions','enrollment_transitions_from_fk',ARRAY['from_enrollment_id','account_id','membership_id','course_id']::text[],'enrollments',ARRAY['id','account_id','membership_id','course_id']::text[]),
    ('enrollment_version_transitions','enrollment_transitions_to_fk',ARRAY['to_enrollment_id','account_id','membership_id','course_id']::text[],'enrollments',ARRAY['id','account_id','membership_id','course_id']::text[]),
    ('lesson_progress','lesson_progress_enrollment_fk',ARRAY['enrollment_id','account_id','membership_id','course_id','course_version_id']::text[],'enrollments',ARRAY['id','account_id','membership_id','course_id','course_version_id']::text[]),
    ('lesson_progress','lesson_progress_manifest_fk',ARRAY['course_version_id','course_id','lesson_id','lesson_version_id']::text[],'course_version_lessons',ARRAY['course_version_id','course_id','lesson_id','lesson_version_id']::text[]),
    ('lesson_completions','lesson_completions_source_command_receipt_id_fkey',ARRAY['source_command_receipt_id']::text[],'api_command_receipts',ARRAY['id']::text[]),
    ('lesson_completions','lesson_completions_enrollment_fk',ARRAY['enrollment_id','account_id','membership_id','course_id','course_version_id']::text[],'enrollments',ARRAY['id','account_id','membership_id','course_id','course_version_id']::text[]),
    ('lesson_completions','lesson_completions_manifest_fk',ARRAY['course_version_id','course_id','lesson_id','lesson_version_id']::text[],'course_version_lessons',ARRAY['course_version_id','course_id','lesson_id','lesson_version_id']::text[]),
    ('course_completions','course_completions_enrollment_fk',ARRAY['enrollment_id','account_id','membership_id','course_id','course_version_id']::text[],'enrollments',ARRAY['id','account_id','membership_id','course_id','course_version_id']::text[]),
    ('certificate_prerequisites','certificate_prerequisites_completion_fk',ARRAY['course_completion_id','account_id','membership_id','enrollment_id','course_id','course_version_id']::text[],'course_completions',ARRAY['id','account_id','membership_id','enrollment_id','course_id','course_version_id']::text[])
  ), actual_learning_fks AS (
    SELECT source.relname table_name,c.conname constraint_name,
      ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY key(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=key.attnum ORDER BY key.ordinal) column_names,
      target.relname foreign_table,
      ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY key(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=key.attnum ORDER BY key.ordinal) foreign_column_names,
      c.confupdtype,c.confdeltype,c.convalidated
    FROM pg_constraint c JOIN pg_class source ON source.oid=c.conrelid JOIN pg_namespace source_namespace ON source_namespace.oid=source.relnamespace
      JOIN pg_class target ON target.oid=c.confrelid JOIN pg_namespace target_namespace ON target_namespace.oid=target.relnamespace
    WHERE c.contype='f' AND source_namespace.nspname='public' AND target_namespace.nspname='public'
      AND c.conname IN (SELECT constraint_name FROM expected_learning_fks)
  ), expected_learning_uniques(table_name,constraint_name,column_names) AS (VALUES
    ('account_course_accesses','account_course_accesses_exact_unique',ARRAY['id','account_id','course_id','course_version_id']::text[]),
    ('enrollments','enrollments_exact_unique',ARRAY['id','account_id','membership_id','course_id','course_version_id']::text[]),
    ('enrollments','enrollments_transition_target_unique',ARRAY['id','account_id','membership_id','course_id']::text[]),
    ('enrollment_version_transitions','enrollment_version_transitions_to_enrollment_id_key',ARRAY['to_enrollment_id']::text[]),
    ('lesson_progress','lesson_progress_enrollment_lesson_unique',ARRAY['enrollment_id','lesson_id']::text[]),
    ('lesson_completions','lesson_completions_source_command_receipt_id_key',ARRAY['source_command_receipt_id']::text[]),
    ('lesson_completions','lesson_completions_enrollment_lesson_unique',ARRAY['enrollment_id','lesson_id']::text[]),
    ('lesson_completions','lesson_completions_exact_unique',ARRAY['id','account_id','membership_id','enrollment_id','course_id','course_version_id']::text[]),
    ('course_completions','course_completions_enrollment_unique',ARRAY['enrollment_id']::text[]),
    ('course_completions','course_completions_exact_unique',ARRAY['id','account_id','membership_id','enrollment_id','course_id','course_version_id']::text[]),
    ('certificate_prerequisites','certificate_prerequisites_course_completion_id_key',ARRAY['course_completion_id']::text[]),
    ('course_versions','course_versions_source_preview_unique',ARRAY['source_preview_id']::text[])
  ), expected_learning_primary_keys(table_name,constraint_name,column_names) AS (VALUES
    ('account_course_accesses','account_course_accesses_pkey',ARRAY['id']::text[]),('enrollments','enrollments_pkey',ARRAY['id']::text[]),
    ('enrollment_version_transitions','enrollment_version_transitions_pkey',ARRAY['id']::text[]),('lesson_progress','lesson_progress_pkey',ARRAY['id']::text[]),
    ('lesson_completions','lesson_completions_pkey',ARRAY['id']::text[]),('course_completions','course_completions_pkey',ARRAY['id']::text[]),
    ('certificate_prerequisites','certificate_prerequisites_pkey',ARRAY['id']::text[])
  ), actual_learning_primary_keys AS (
    SELECT rel.relname table_name,c.conname constraint_name,
      ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY key(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=key.attnum ORDER BY key.ordinal) column_names,
      c.convalidated
    FROM pg_constraint c JOIN learning_relations required_relation ON required_relation.oid=c.conrelid JOIN pg_class rel ON rel.oid=c.conrelid
    WHERE c.contype='p'
  ), actual_learning_uniques AS (
    SELECT rel.relname table_name,c.conname constraint_name,
      ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY key(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=key.attnum ORDER BY key.ordinal) column_names,
      c.convalidated
    FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid JOIN pg_namespace relation_namespace ON relation_namespace.oid=rel.relnamespace
    WHERE c.contype='u' AND relation_namespace.nspname='public' AND c.conname IN (SELECT constraint_name FROM expected_learning_uniques)
  ), expected_learning_checks(table_name,constraint_name,definition) AS (VALUES
    ('account_course_accesses','account_course_accesses_status_check',E'(status=any(array[\'active\',\'revoked\']))'),
    ('enrollments','enrollments_status_check',E'(status=any(array[\'active\',\'revoked\']))'),
    ('enrollments','enrollments_status_time_check',E'(((status=\'active\')and(revoked_atisnull))or((status=\'revoked\')and(revoked_atisnotnull)))'),
    ('enrollment_version_transitions','enrollment_transitions_actor_check',E'(actor_type=any(array[\'member\',\'staff\',\'system\']))'),
    ('enrollment_version_transitions','enrollment_transitions_reason_check',E'((octet_length(reason)>=1)and(octet_length(reason)<=1000))'),
    ('enrollment_version_transitions','enrollment_transitions_distinct_check',E'(from_enrollment_id<>to_enrollment_id)'),
    ('lesson_progress','lesson_progress_last_path_check',E'(last_path=any(array[\'video\',\'transcript\']))'),
    ('lesson_progress','lesson_progress_revision_check',E'(revision>=1)'),
    ('lesson_progress','lesson_progress_position_check',E'(((last_path=\'video\')and((video_seconds>=0)and(video_seconds<=86400))and(transcript_block_idisnull))or((last_path=\'transcript\')and(video_secondsisnull)and((octet_length(transcript_block_id)>=1)and(octet_length(transcript_block_id)<=128))))'),
    ('lesson_versions','lesson_versions_source_draft_revision_check',E'((source_draft_revisionisnull)or(source_draft_revision>0))'),
    ('lesson_completions','lesson_completions_method_check',E'(method=any(array[\'video\',\'transcript\',\'mixed\']))'),
    ('course_completions','course_completions_hash_check',E'(required_lesson_set_hash~\'^[0-9a-f]{64}$\')')
  ), actual_learning_checks AS (
    SELECT rel.relname table_name,c.conname constraint_name,
      regexp_replace(replace(lower(pg_get_expr(c.conbin,c.conrelid)),'::text',''),'[[:space:]]','','g') definition,c.convalidated
    FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid JOIN pg_namespace relation_namespace ON relation_namespace.oid=rel.relnamespace
    WHERE c.contype='c' AND relation_namespace.nspname='public' AND c.conname IN (SELECT constraint_name FROM expected_learning_checks)
  ), expected_learning_columns(table_name,column_name,type_name,is_not_null) AS (VALUES
    ('lesson_versions','source_draft_revision','integer',false),
    ('course_versions','source_preview_id','uuid',true),
    ('lesson_completions','source_command_receipt_id','uuid',true)
  ), actual_learning_columns AS (
    SELECT rel.relname table_name,a.attname column_name,a.atttypid::regtype::text type_name,a.attnotnull is_not_null
    FROM pg_attribute a JOIN pg_class rel ON rel.oid=a.attrelid JOIN pg_namespace relation_namespace ON relation_namespace.oid=rel.relnamespace
    WHERE NOT a.attisdropped AND relation_namespace.nspname='public' AND (rel.relname,a.attname) IN (SELECT table_name,column_name FROM expected_learning_columns)
  ), expected_learning_indexes(table_name,index_name,column_names,is_unique,predicate) AS (VALUES
    ('account_course_accesses','account_course_accesses_active_source_version_unique',ARRAY['account_id','entitlement_source_id','course_id','course_version_id']::text[],true,E'(status=\'active\')'),
    ('enrollments','enrollments_one_active_course_unique',ARRAY['account_id','membership_id','course_id']::text[],true,E'(status=\'active\')'),
    ('lesson_progress','lesson_progress_actor_idx',ARRAY['account_id','membership_id']::text[],false,E''),
    ('lesson_versions','lesson_versions_source_draft_unique',ARRAY['lesson_id','source_draft_revision']::text[],true,E'(source_draft_revisionisnotnull)')
  ), actual_learning_indexes AS (
    SELECT table_rel.relname table_name,index_rel.relname index_name,
      ARRAY(SELECT a.attname FROM unnest(i.indkey::smallint[]) WITH ORDINALITY key(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum ORDER BY key.ordinal) column_names,
      i.indisunique is_unique,regexp_replace(replace(lower(coalesce(pg_get_expr(i.indpred,i.indrelid),'')),'::text',''),'[[:space:]]','','g') predicate,
      i.indisvalid,i.indisready
    FROM pg_index i JOIN pg_class table_rel ON table_rel.oid=i.indrelid JOIN pg_namespace table_namespace ON table_namespace.oid=table_rel.relnamespace
      JOIN pg_class index_rel ON index_rel.oid=i.indexrelid JOIN pg_namespace index_namespace ON index_namespace.oid=index_rel.relnamespace
    WHERE table_namespace.nspname='public' AND index_namespace.nspname='public' AND index_rel.relname IN (SELECT index_name FROM expected_learning_indexes)
  ), expected_learning_triggers_raw(table_name,trigger_name,trigger_type,when_clause) AS (VALUES
    ('enrollment_version_transitions','enrollment_version_transitions_immutable',27,E''),
    ('lesson_completions','lesson_completions_immutable',27,E''),('course_completions','course_completions_immutable',27,E''),
    ('certificate_prerequisites','certificate_prerequisites_immutable',27,E''),
    ('enrollments','enrollments_identity_immutable',19,E'OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.account_course_access_id IS DISTINCT FROM NEW.account_course_access_id OR OLD.membership_id IS DISTINCT FROM NEW.membership_id OR OLD.course_id IS DISTINCT FROM NEW.course_id OR OLD.course_version_id IS DISTINCT FROM NEW.course_version_id OR OLD.enrolled_at IS DISTINCT FROM NEW.enrolled_at'),
    ('account_course_accesses','account_course_accesses_identity_immutable',19,E'OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.entitlement_source_id IS DISTINCT FROM NEW.entitlement_source_id OR OLD.course_id IS DISTINCT FROM NEW.course_id OR OLD.course_version_id IS DISTINCT FROM NEW.course_version_id OR OLD.created_at IS DISTINCT FROM NEW.created_at'),
    ('lesson_progress','lesson_progress_identity_immutable',19,E'OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.membership_id IS DISTINCT FROM NEW.membership_id OR OLD.enrollment_id IS DISTINCT FROM NEW.enrollment_id OR OLD.course_id IS DISTINCT FROM NEW.course_id OR OLD.course_version_id IS DISTINCT FROM NEW.course_version_id OR OLD.lesson_id IS DISTINCT FROM NEW.lesson_id OR OLD.lesson_version_id IS DISTINCT FROM NEW.lesson_version_id')
  ), expected_learning_triggers AS (
    SELECT table_name,trigger_name,trigger_type,regexp_replace(replace(lower(when_clause),'::text',''),'[[:space:]()]','','g') when_clause FROM expected_learning_triggers_raw
  ), actual_learning_triggers AS (
    SELECT rel.relname table_name,t.tgname trigger_name,t.tgtype::integer trigger_type,
      regexp_replace(replace(lower(coalesce(substring(pg_get_triggerdef(t.oid,true) from E' WHEN \\((.*)\\) EXECUTE FUNCTION '),'')),'::text',''),'[[:space:]()]','','g') when_clause,t.tgenabled,
      p.oid=to_regprocedure('public.syntholo_learning_immutable_row()') correct_function
    FROM pg_trigger t JOIN learning_relations required_relation ON required_relation.oid=t.tgrelid JOIN pg_class rel ON rel.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE NOT t.tgisinternal
  ), expected_learning_table_acl(role_name,table_name,privilege_type) AS (
    SELECT 'syntholo_migrator',r.name,p FROM learning_required r CROSS JOIN LATERAL unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']::text[]) p
    UNION ALL SELECT 'syntholo_member_api',r.name,'SELECT' FROM learning_required r
    UNION ALL SELECT 'syntholo_worker','certificate_prerequisites',p FROM unnest(ARRAY['SELECT','INSERT']::text[]) p
  ), actual_learning_table_acl AS (
    SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END role_name,c.name table_name,a.privilege_type
    FROM learning_relations c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,'{}'::aclitem[])) a
    WHERE CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END IN ('PUBLIC','syntholo_migrator','syntholo_member_api','syntholo_staff_api','syntholo_worker','syntholo_system_api')
  ), expected_learning_functions(signature,security_definer) AS (VALUES
    ('public.syntholo_learning_immutable_row()',false),
    ('public.syntholo_canonical_jsonb_text_v1(jsonb)',false),
    ('public.syntholo_learning_available_at_v1(jsonb,timestamp with time zone)',false),
    ('public.syntholo_learning_get_course_v1(uuid)',true),
    ('public.syntholo_learning_get_lesson_v1(uuid)',true),
    ('public.syntholo_learning_get_playback_target_v1(uuid)',true),
    ('public.syntholo_learning_resume_lesson_v1(uuid,integer,text,integer,text)',true),
    ('public.syntholo_learning_complete_lesson_v1(uuid,text,text,text)',true),
    ('public.syntholo_learning_record_certificate_prerequisite_v1(uuid,text)',true)
  ), learning_functions AS (
    SELECT e.signature,e.security_definer,p.oid,p.proowner,p.prokind,p.prosecdef,p.proconfig,p.proacl FROM expected_learning_functions e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)
  ), expected_learning_function_acl(signature,role_name,privilege_type) AS (VALUES
    ('public.syntholo_learning_get_course_v1(uuid)','syntholo_member_api','EXECUTE'),
    ('public.syntholo_learning_get_lesson_v1(uuid)','syntholo_member_api','EXECUTE'),
    ('public.syntholo_learning_get_playback_target_v1(uuid)','syntholo_member_api','EXECUTE'),
    ('public.syntholo_learning_resume_lesson_v1(uuid,integer,text,integer,text)','syntholo_member_api','EXECUTE'),
    ('public.syntholo_learning_complete_lesson_v1(uuid,text,text,text)','syntholo_member_api','EXECUTE'),
    ('public.syntholo_learning_record_certificate_prerequisite_v1(uuid,text)','syntholo_worker','EXECUTE')
  ), actual_learning_function_acl AS (
    SELECT f.signature,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END role_name,a.privilege_type
    FROM learning_functions f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl,'{}'::aclitem[])) a
    WHERE CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END IN ('PUBLIC','syntholo_migrator','syntholo_member_api','syntholo_staff_api','syntholo_worker','syntholo_system_api')
  )
  SELECT '0009_content.v1',1786676400000::bigint,j.hash,
    (SELECT count(*)::integer FROM relations WHERE oid IS NOT NULL),
    (SELECT count(*)=24 AND bool_and(relowner=(SELECT proowner FROM function_owner)) FROM relations) AND (SELECT count(*)=19 AND bool_and(proowner=(SELECT proowner FROM function_owner)) FROM content_functions),
    (SELECT count(*)=24 AND bool_and(relkind='r') FROM relations) AND (SELECT count(*)=19 AND bool_and(prokind='f') FROM content_functions),
    NOT EXISTS((SELECT table_name,trigger_name FROM expected_triggers EXCEPT SELECT table_name,trigger_name FROM actual_immutable_triggers) UNION ALL (SELECT table_name,trigger_name FROM actual_immutable_triggers EXCEPT SELECT table_name,trigger_name FROM expected_triggers)) AND NOT EXISTS(SELECT 1 FROM actual_immutable_triggers t WHERE t.tgtype<>27 OR t.tgenabled<>'O'),
    NOT EXISTS((SELECT role_name,table_name,privilege_type FROM expected_table_acl EXCEPT SELECT role_name,table_name,privilege_type FROM actual_table_acl) UNION ALL (SELECT role_name,table_name,privilege_type FROM actual_table_acl EXCEPT SELECT role_name,table_name,privilege_type FROM expected_table_acl)),
    NOT EXISTS((SELECT signature,role_name,privilege_type FROM expected_function_acl EXCEPT SELECT signature,role_name,privilege_type FROM actual_function_acl) UNION ALL (SELECT signature,role_name,privilege_type FROM actual_function_acl EXCEPT SELECT signature,role_name,privilege_type FROM expected_function_acl)) AND NOT EXISTS(SELECT 1 FROM content_functions p WHERE p.oid IS NULL OR p.prosecdef<>p.security_definer OR p.proconfig<>ARRAY['search_path=pg_catalog, pg_temp']::text[]),
    NOT EXISTS(SELECT 1 FROM content_functions p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,'{}'::aclitem[])) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE'),
    NOT EXISTS(SELECT 1 FROM public.courses UNION ALL SELECT 1 FROM public.course_drafts UNION ALL SELECT 1 FROM public.stages UNION ALL SELECT 1 FROM public.stage_drafts UNION ALL SELECT 1 FROM public.lessons UNION ALL SELECT 1 FROM public.lesson_drafts UNION ALL SELECT 1 FROM public.lesson_accessibility_decisions UNION ALL SELECT 1 FROM public.lesson_accessibility_review_heads UNION ALL SELECT 1 FROM public.lesson_disclosure_decisions UNION ALL SELECT 1 FROM public.lesson_disclosure_review_heads UNION ALL SELECT 1 FROM public.lesson_versions UNION ALL SELECT 1 FROM public.course_draft_manifest_entries UNION ALL SELECT 1 FROM public.content_previews UNION ALL SELECT 1 FROM public.course_versions UNION ALL SELECT 1 FROM public.course_version_lessons UNION ALL SELECT 1 FROM public.course_heads UNION ALL SELECT 1 FROM public.content_resource_drafts UNION ALL SELECT 1 FROM public.lesson_version_resources UNION ALL SELECT 1 FROM public.resource_delivery_health UNION ALL SELECT 1 FROM public.content_schedules UNION ALL SELECT 1 FROM public.content_archives UNION ALL SELECT 1 FROM public.content_readiness_evaluations UNION ALL SELECT 1 FROM public.content_readiness_approvals UNION ALL SELECT 1 FROM public.api_command_receipts),
    '0011_learning.v1',1786770000000::bigint,j11.hash,
    (SELECT count(*)=7 AND bool_and(oid IS NOT NULL AND relkind='r' AND relowner=(SELECT proowner FROM function_owner)) FROM learning_relations),
    NOT EXISTS((SELECT table_name,constraint_name,column_names,foreign_table,foreign_column_names FROM expected_learning_fks EXCEPT SELECT table_name,constraint_name,column_names,foreign_table,foreign_column_names FROM actual_learning_fks) UNION ALL (SELECT table_name,constraint_name,column_names,foreign_table,foreign_column_names FROM actual_learning_fks EXCEPT SELECT table_name,constraint_name,column_names,foreign_table,foreign_column_names FROM expected_learning_fks))
      AND NOT EXISTS(SELECT 1 FROM actual_learning_fks WHERE NOT convalidated OR confupdtype<>'r' OR confdeltype<>'r')
      AND NOT EXISTS((SELECT table_name,constraint_name,column_names FROM expected_learning_uniques EXCEPT SELECT table_name,constraint_name,column_names FROM actual_learning_uniques) UNION ALL (SELECT table_name,constraint_name,column_names FROM actual_learning_uniques EXCEPT SELECT table_name,constraint_name,column_names FROM expected_learning_uniques))
      AND NOT EXISTS(SELECT 1 FROM actual_learning_uniques WHERE NOT convalidated)
      AND NOT EXISTS((SELECT table_name,constraint_name,column_names FROM expected_learning_primary_keys EXCEPT SELECT table_name,constraint_name,column_names FROM actual_learning_primary_keys) UNION ALL (SELECT table_name,constraint_name,column_names FROM actual_learning_primary_keys EXCEPT SELECT table_name,constraint_name,column_names FROM expected_learning_primary_keys))
      AND NOT EXISTS(SELECT 1 FROM actual_learning_primary_keys WHERE NOT convalidated)
      AND NOT EXISTS((SELECT table_name,constraint_name,definition FROM expected_learning_checks EXCEPT SELECT table_name,constraint_name,definition FROM actual_learning_checks) UNION ALL (SELECT table_name,constraint_name,definition FROM actual_learning_checks EXCEPT SELECT table_name,constraint_name,definition FROM expected_learning_checks))
      AND NOT EXISTS(SELECT 1 FROM actual_learning_checks WHERE NOT convalidated)
      AND NOT EXISTS((SELECT table_name,index_name,column_names,is_unique,predicate FROM expected_learning_indexes EXCEPT SELECT table_name,index_name,column_names,is_unique,predicate FROM actual_learning_indexes) UNION ALL (SELECT table_name,index_name,column_names,is_unique,predicate FROM actual_learning_indexes EXCEPT SELECT table_name,index_name,column_names,is_unique,predicate FROM expected_learning_indexes))
      AND NOT EXISTS(SELECT 1 FROM actual_learning_indexes WHERE NOT indisvalid OR NOT indisready)
      AND NOT EXISTS((SELECT table_name,column_name,type_name,is_not_null FROM expected_learning_columns EXCEPT SELECT table_name,column_name,type_name,is_not_null FROM actual_learning_columns) UNION ALL (SELECT table_name,column_name,type_name,is_not_null FROM actual_learning_columns EXCEPT SELECT table_name,column_name,type_name,is_not_null FROM expected_learning_columns)),
    NOT EXISTS((SELECT table_name,trigger_name,trigger_type,when_clause FROM expected_learning_triggers EXCEPT SELECT table_name,trigger_name,trigger_type,when_clause FROM actual_learning_triggers) UNION ALL (SELECT table_name,trigger_name,trigger_type,when_clause FROM actual_learning_triggers EXCEPT SELECT table_name,trigger_name,trigger_type,when_clause FROM expected_learning_triggers))
      AND NOT EXISTS(SELECT 1 FROM actual_learning_triggers WHERE tgenabled<>'O' OR NOT correct_function),
    (SELECT count(*)=7 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM learning_relations) AND NOT EXISTS((SELECT table_name,policy_name,permissive,command_name,role_names,qual,with_check FROM expected_learning_policies EXCEPT SELECT table_name,policy_name,permissive,command_name,role_names,qual,with_check FROM actual_learning_policies) UNION ALL (SELECT table_name,policy_name,permissive,command_name,role_names,qual,with_check FROM actual_learning_policies EXCEPT SELECT table_name,policy_name,permissive,command_name,role_names,qual,with_check FROM expected_learning_policies)),
    NOT EXISTS((SELECT role_name,table_name,privilege_type FROM expected_learning_table_acl EXCEPT SELECT role_name,table_name,privilege_type FROM actual_learning_table_acl) UNION ALL (SELECT role_name,table_name,privilege_type FROM actual_learning_table_acl EXCEPT SELECT role_name,table_name,privilege_type FROM expected_learning_table_acl)),
    (SELECT count(*)=9 AND bool_and(oid IS NOT NULL AND prokind='f' AND proowner=(SELECT proowner FROM function_owner) AND prosecdef=security_definer AND proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]) FROM learning_functions) AND NOT EXISTS((SELECT signature,role_name,privilege_type FROM expected_learning_function_acl EXCEPT SELECT signature,role_name,privilege_type FROM actual_learning_function_acl) UNION ALL (SELECT signature,role_name,privilege_type FROM actual_learning_function_acl EXCEPT SELECT signature,role_name,privilege_type FROM expected_learning_function_acl)),
    NOT EXISTS(SELECT 1 FROM learning_functions f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl,'{}'::aclitem[])) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
  FROM drizzle.__drizzle_migrations j CROSS JOIN drizzle.__drizzle_migrations j11 WHERE j.created_at=1786676400000 AND j11.created_at=1786770000000;
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_readiness_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_content_readiness_v1() TO syntholo_migrator,syntholo_member_api,syntholo_staff_api,syntholo_worker,syntholo_system_api;
