-- Task 8 certificate authority. implementationCompletionIsAuthority=false.
ALTER TABLE public.memberships
  ADD CONSTRAINT memberships_id_account_identity_unique
  UNIQUE(id,account_id,member_identity_id);
--> statement-breakpoint
ALTER TABLE public.certificate_prerequisites
  ADD CONSTRAINT certificate_prerequisites_exact_unique
  UNIQUE(id,course_completion_id,account_id,membership_id,enrollment_id,course_id,course_version_id);
--> statement-breakpoint
ALTER TABLE public.course_versions
  ADD CONSTRAINT course_versions_certificate_exact_unique UNIQUE(id,course_id,version);
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
CREATE OR REPLACE FUNCTION public.syntholo_claim_jobs(
  p_limit integer, p_worker text, p_now timestamptz, p_lease_ms integer)
RETURNS SETOF public.jobs
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $claim$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_worker IS NULL OR octet_length(p_worker) NOT BETWEEN 1 AND 128
     OR p_now IS NULL
     OR p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1 AND 3600000 THEN
    RAISE EXCEPTION 'SYNTHOLO_JOB_CLAIM_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH eligible AS MATERIALIZED (
    SELECT j.id
    FROM public.jobs j
    WHERE ((j.status = 'queued' AND j.run_at <= p_now)
       OR (j.status = 'running' AND j.lease_expires_at <= p_now))
      AND (j.type <> 'learning.course_completed.certificate.v1'
        OR p_worker ~ '-certificate-v1$')
    ORDER BY j.priority DESC, j.run_at, j.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), expired AS (
    UPDATE public.job_attempts a SET
      outcome = 'lease_expired', finished_at = p_now
    FROM public.jobs j, eligible e
    WHERE j.id = e.id AND j.status = 'running' AND a.job_id = j.id
      AND a.attempt = j.attempts AND a.claim_generation = j.claim_generation
      AND a.claim_token = j.claim_token AND a.outcome = 'running'
    RETURNING a.job_id
  ), exhausted AS (
    UPDATE public.jobs j SET
      status = 'dead_letter', completed_at = p_now,
      lease_expires_at = NULL, claim_token = NULL,
      worker_id = CASE WHEN j.status = 'queued' THEN NULL ELSE j.worker_id END,
      claimed_at = CASE WHEN j.status = 'queued' THEN NULL ELSE j.claimed_at END,
      last_error_code = CASE WHEN j.status = 'queued'
        THEN 'JOB_ATTEMPTS_EXHAUSTED' ELSE 'JOB_LEASE_EXPIRED' END,
      last_error_message = CASE WHEN j.status = 'queued'
        THEN 'Job attempts exhausted' ELSE 'Job lease expired' END,
      updated_at = p_now
    FROM eligible e
    WHERE j.id = e.id AND j.attempts >= j.max_attempts
      AND (j.status = 'queued' OR EXISTS (SELECT 1 FROM expired x WHERE x.job_id = j.id))
    RETURNING j.id
  ), claimed AS (
    UPDATE public.jobs j SET
      status = 'running', worker_id = p_worker, claimed_at = p_now,
      lease_expires_at = p_now + p_lease_ms * interval '1 millisecond',
      claim_token = gen_random_uuid(), claim_generation = j.claim_generation + 1,
      attempts = j.attempts + 1, updated_at = p_now
    FROM eligible e
    WHERE j.id = e.id AND j.attempts < j.max_attempts
      AND NOT EXISTS (SELECT 1 FROM exhausted x WHERE x.id = j.id)
      AND (j.status = 'queued' OR EXISTS (
        SELECT 1 FROM expired x WHERE x.job_id = j.id
      ))
    RETURNING j.*
  ), attempts AS (
    INSERT INTO public.job_attempts
      (job_id, account_id, attempt, claim_generation, claim_token, worker_id,
       started_at, lease_expires_at)
    SELECT c.id, c.account_id, c.attempts, c.claim_generation, c.claim_token,
           c.worker_id, c.claimed_at, c.lease_expires_at
    FROM claimed c
    RETURNING job_id
  )
  SELECT c.* FROM claimed c JOIN attempts a ON a.job_id = c.id
  ORDER BY c.priority DESC, c.run_at, c.id;
END;
$claim$;
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
  expected_runtime_attestation(signature,body_hash) AS (VALUES ('public.syntholo_attest_runtime_capability(text)','41aa3e6a5d7a634c9332ec616c8931b7fc8fa15fa91db13cd3e0eb0f7c1536b6')),
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
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_font_supports_v1(p_codepoint integer)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path=pg_catalog,pg_temp AS $f$
  SELECT p_codepoint BETWEEN 0 AND 55295
    OR p_codepoint BETWEEN 63744 AND 65533
    OR p_codepoint BETWEEN 65536 AND 72543
    OR p_codepoint BETWEEN 72704 AND 73727
    OR p_codepoint BETWEEN 74650 AND 74751
    OR p_codepoint=74863
    OR p_codepoint BETWEEN 74869 AND 74879
    OR p_codepoint BETWEEN 75076 AND 77823
    OR p_codepoint BETWEEN 78895 AND 82943
    OR p_codepoint BETWEEN 83527 AND 92159
    OR p_codepoint BETWEEN 92729 AND 94207
    OR p_codepoint BETWEEN 100344 AND 100351
    OR p_codepoint BETWEEN 101120 AND 101631
    OR p_codepoint BETWEEN 101641 AND 131069
    OR p_codepoint BETWEEN 917504 AND 917631
    OR p_codepoint BETWEEN 917760 AND 917999
$f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_forbidden_scalar_v1(p_codepoint integer)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path=pg_catalog,pg_temp AS $f$
  SELECT p_codepoint=127 OR p_codepoint BETWEEN 0 AND 31
    OR p_codepoint BETWEEN 128 AND 159 OR p_codepoint IN(1564,8206,8207)
    OR p_codepoint BETWEEN 8234 AND 8238 OR p_codepoint BETWEEN 8294 AND 8297
    OR p_codepoint BETWEEN 64976 AND 65007
    OR mod(p_codepoint,65536) IN(65534,65535)
$f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_recipient_name_valid_v1(p_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path=pg_catalog,pg_temp AS $f$
  SELECT p_value=normalize(p_value,NFC)
    AND char_length(p_value) BETWEEN 1 AND 120
    AND octet_length(p_value) BETWEEN 1 AND 480
    AND p_value=btrim(p_value,' ')
    AND position('  ' in p_value)=0
    AND NOT EXISTS(
      SELECT 1 FROM generate_series(1,char_length(p_value)) p(i)
      CROSS JOIN LATERAL (VALUES(ascii(substr(p_value,p.i,1)))) scalar(cp)
      WHERE public.syntholo_certificate_forbidden_scalar_v1(scalar.cp)
        OR scalar.cp IN(160,5760,8232,8233,8239,8287,12288)
        OR scalar.cp BETWEEN 8192 AND 8202
        OR NOT public.syntholo_certificate_font_supports_v1(scalar.cp)
    )
$f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_business_snapshot_renderable_v1(p_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path=pg_catalog,pg_temp AS $f$
  SELECT public.syntholo_account_name_is_canonical(p_value)
    AND NOT EXISTS(
      SELECT 1 FROM generate_series(1,char_length(p_value)) p(i)
      WHERE NOT public.syntholo_certificate_font_supports_v1(ascii(substr(p_value,p.i,1)))
    )
$f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_course_snapshot_renderable_v1(p_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path=pg_catalog,pg_temp AS $f$
  SELECT p_value=normalize(p_value,NFC)
    AND char_length(p_value) BETWEEN 1 AND 255
    AND octet_length(p_value) BETWEEN 1 AND 1020
    AND NOT EXISTS(
      SELECT 1 FROM generate_series(1,char_length(p_value)) p(i)
      CROSS JOIN LATERAL (VALUES(ascii(substr(p_value,p.i,1)))) scalar(cp)
      WHERE public.syntholo_certificate_forbidden_scalar_v1(scalar.cp)
        OR NOT public.syntholo_certificate_font_supports_v1(scalar.cp)
    )
$f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_text_valid_v1(p_value text,p_max_bytes integer,p_nonblank boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path=pg_catalog,pg_temp AS $f$
  SELECT p_value IS NOT NULL AND p_max_bytes BETWEEN 1 AND 1048576
    AND p_value=normalize(p_value,NFC)
    AND octet_length(p_value) BETWEEN CASE WHEN p_nonblank THEN 1 ELSE 0 END AND p_max_bytes
    AND (p_value='' OR (
      ascii(substr(p_value,1,1)) NOT IN(9,10,11,12,13,32,160,5760,8232,8233,8239,8287,12288,65279)
      AND NOT ascii(substr(p_value,1,1)) BETWEEN 8192 AND 8202
      AND ascii(substr(p_value,char_length(p_value),1)) NOT IN(9,10,11,12,13,32,160,5760,8232,8233,8239,8287,12288,65279)
      AND NOT ascii(substr(p_value,char_length(p_value),1)) BETWEEN 8192 AND 8202
    ))
$f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_etag_valid_v1(p_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $f$
  SELECT octet_length(p_value) BETWEEN 1 AND 255 AND p_value!~'^W/' AND NOT EXISTS(
    SELECT 1 FROM generate_series(0,octet_length(p_value)-1) p(i)
    WHERE get_byte(convert_to(p_value,'UTF8'),p.i)<>33
      AND get_byte(convert_to(p_value,'UTF8'),p.i) NOT BETWEEN 35 AND 91
      AND get_byte(convert_to(p_value,'UTF8'),p.i) NOT BETWEEN 93 AND 126
  )
$f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_name_content_hash_valid_v1(p_display_name text,p_content_hash text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $f$
  SELECT p_display_name IS NOT NULL AND p_content_hash IS NOT NULL
    AND p_content_hash ~ '^[0-9a-f]{64}$'
    AND p_content_hash=encode(sha256(convert_to('certificate-recipient-name.v1'||chr(10)||p_display_name,'UTF8')),'hex')
$f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_recovery_audit_valid_v1(p_action text,p_payload jsonb,p_job_id uuid,p_attempt integer,p_generation integer)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $f$
  SELECT p_action IS NOT NULL AND p_payload IS NOT NULL AND p_job_id IS NOT NULL
    AND p_attempt IS NOT NULL AND p_attempt>0 AND p_generation IS NOT NULL AND p_generation>0
    AND p_payload->>'failureCode'='storage_failed' AND p_payload->>'jobId'=p_job_id::text
    AND jsonb_typeof(p_payload->'attempt')='number' AND p_payload->>'attempt'=p_attempt::text
    AND jsonb_typeof(p_payload->'claimGeneration')='number' AND p_payload->>'claimGeneration'=p_generation::text
    AND CASE p_action
      WHEN 'certificate_storage_retry_authorized' THEN
        p_payload->>'objectState' IN('absent','matching')
        AND jsonb_typeof(p_payload->'byteLength')='number'
        AND CASE WHEN p_payload->>'byteLength'~'^[1-9][0-9]{0,7}$'
          THEN (p_payload->>'byteLength')::integer BETWEEN 1 AND 26214400 ELSE false END
        AND p_payload->>'sha256'~'^[0-9a-f]{64}$'
        AND CASE WHEN p_payload->>'objectState'='absent' THEN
          ARRAY(SELECT key FROM jsonb_object_keys(p_payload) key ORDER BY key)=ARRAY['attempt','byteLength','claimGeneration','failureCode','jobId','objectState','sha256']::text[]
        ELSE public.syntholo_certificate_etag_valid_v1(p_payload->>'etag') IS TRUE
          AND ARRAY(SELECT key FROM jsonb_object_keys(p_payload) key ORDER BY key)=ARRAY['attempt','byteLength','claimGeneration','etag','failureCode','jobId','objectState','sha256']::text[] END
      WHEN 'certificate_storage_retry_rejected' THEN
        p_payload->>'reason' IN('object_mismatch','provider_shape_invalid','render_authority_invalid')
        AND ARRAY(SELECT key FROM jsonb_object_keys(p_payload) key ORDER BY key)=ARRAY['attempt','claimGeneration','failureCode','jobId','reason']::text[]
      ELSE false
    END
$f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_record_state_valid_v1(p_snapshot_renderable boolean,p_recipient_name_version_id uuid,p_recipient_name_version integer,p_recipient_name_snapshot text,p_status text,p_failure_code text,p_issued_at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $f$
  SELECT
    (p_status='awaiting_recipient_name' AND p_recipient_name_version_id IS NULL AND p_recipient_name_version IS NULL AND p_recipient_name_snapshot IS NULL AND p_failure_code IS NULL AND p_issued_at IS NULL)
    OR (p_status='pending' AND p_snapshot_renderable AND p_recipient_name_version_id IS NOT NULL AND p_recipient_name_version>0 AND p_recipient_name_snapshot IS NOT NULL AND p_failure_code IS NULL AND p_issued_at IS NULL)
    OR (p_status='failed' AND p_recipient_name_version_id IS NOT NULL AND p_recipient_name_version>0 AND p_recipient_name_snapshot IS NOT NULL AND p_issued_at IS NULL AND ((p_snapshot_renderable AND p_failure_code IN('render_failed','storage_failed')) OR (NOT p_snapshot_renderable AND p_failure_code='snapshot_not_renderable')))
    OR (p_status='issued' AND p_snapshot_renderable AND p_recipient_name_version_id IS NOT NULL AND p_recipient_name_version>0 AND p_recipient_name_snapshot IS NOT NULL AND p_failure_code IS NULL AND p_issued_at IS NOT NULL)
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_certificate_font_supports_v1(integer),public.syntholo_certificate_forbidden_scalar_v1(integer),public.syntholo_certificate_recipient_name_valid_v1(text),public.syntholo_certificate_business_snapshot_renderable_v1(text),public.syntholo_certificate_course_snapshot_renderable_v1(text),public.syntholo_certificate_text_valid_v1(text,integer,boolean),public.syntholo_certificate_etag_valid_v1(text),public.syntholo_certificate_name_content_hash_valid_v1(text,text),public.syntholo_certificate_recovery_audit_valid_v1(text,jsonb,uuid,integer,integer),public.syntholo_certificate_record_state_valid_v1(boolean,uuid,integer,text,text,text,timestamptz) FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE public.certificate_recipient_name_versions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  membership_id uuid NOT NULL, version integer NOT NULL, display_name text NOT NULL, content_hash text NOT NULL,
  actor_identity_id uuid NOT NULL, source_command_receipt_id uuid NOT NULL REFERENCES public.api_command_receipts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  correlation_id uuid NOT NULL, confirmed_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT certificate_name_versions_membership_actor_fk FOREIGN KEY(membership_id,account_id,actor_identity_id) REFERENCES public.memberships(id,account_id,member_identity_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT certificate_name_versions_actor_account_fk FOREIGN KEY(actor_identity_id,account_id) REFERENCES public.member_identities(id,account_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT certificate_name_versions_scope_version_unique UNIQUE(account_id,membership_id,version),
  CONSTRAINT certificate_name_versions_exact_unique UNIQUE(id,account_id,membership_id,version),
  CONSTRAINT certificate_name_versions_snapshot_exact_unique UNIQUE(id,account_id,membership_id,version,display_name),
  CONSTRAINT certificate_name_versions_source_receipt_unique UNIQUE(source_command_receipt_id),
  CONSTRAINT certificate_name_versions_version_check CHECK(version>0),
  CONSTRAINT certificate_name_versions_display_name_check CHECK(public.syntholo_certificate_recipient_name_valid_v1(display_name)),
  CONSTRAINT certificate_name_versions_content_hash_check CHECK(public.syntholo_certificate_name_content_hash_valid_v1(display_name,content_hash))
);
--> statement-breakpoint
CREATE INDEX certificate_name_versions_history_idx ON public.certificate_recipient_name_versions(account_id,membership_id,version DESC);
--> statement-breakpoint
CREATE TABLE public.certificate_recipient_name_heads(
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT, membership_id uuid NOT NULL,
  current_version integer NOT NULL,current_version_id uuid NOT NULL,created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT certificate_recipient_name_heads_pkey PRIMARY KEY(account_id,membership_id),
  CONSTRAINT certificate_name_heads_membership_account_fk FOREIGN KEY(membership_id,account_id) REFERENCES public.memberships(id,account_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT certificate_name_heads_current_version_fk FOREIGN KEY(current_version_id,account_id,membership_id,current_version) REFERENCES public.certificate_recipient_name_versions(id,account_id,membership_id,version) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT certificate_name_heads_version_check CHECK(current_version>0)
);
--> statement-breakpoint
CREATE TABLE public.certificate_records(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), certificate_prerequisite_id uuid NOT NULL,course_completion_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,membership_id uuid NOT NULL,enrollment_id uuid NOT NULL,course_id uuid NOT NULL,course_version_id uuid NOT NULL,
  business_name_snapshot text NOT NULL,course_title_snapshot text NOT NULL,course_version integer NOT NULL,completed_at timestamptz(3) NOT NULL,snapshot_renderable boolean NOT NULL,
  recipient_name_version_id uuid,recipient_name_version integer,recipient_name_snapshot text,renderer_version text NOT NULL DEFAULT 'certificate-pdf.v1',status text NOT NULL,failure_code text,issued_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT certificate_records_completion_exact_fk FOREIGN KEY(course_completion_id,account_id,membership_id,enrollment_id,course_id,course_version_id) REFERENCES public.course_completions(id,account_id,membership_id,enrollment_id,course_id,course_version_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT certificate_records_course_version_exact_fk FOREIGN KEY(course_version_id,course_id,course_version) REFERENCES public.course_versions(id,course_id,version) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT certificate_records_prerequisite_exact_fk FOREIGN KEY(certificate_prerequisite_id,course_completion_id,account_id,membership_id,enrollment_id,course_id,course_version_id) REFERENCES public.certificate_prerequisites(id,course_completion_id,account_id,membership_id,enrollment_id,course_id,course_version_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT certificate_records_recipient_name_version_fk FOREIGN KEY(recipient_name_version_id,account_id,membership_id,recipient_name_version,recipient_name_snapshot) REFERENCES public.certificate_recipient_name_versions(id,account_id,membership_id,version,display_name) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT certificate_records_completion_unique UNIQUE(course_completion_id),CONSTRAINT certificate_records_prerequisite_unique UNIQUE(certificate_prerequisite_id),
  CONSTRAINT certificate_records_member_exact_unique UNIQUE(id,account_id,membership_id),CONSTRAINT certificate_records_exact_unique UNIQUE(id,account_id,membership_id,course_completion_id),
  CONSTRAINT certificate_records_renderer_check CHECK(renderer_version='certificate-pdf.v1' AND course_version>0),
  CONSTRAINT certificate_records_snapshot_renderability_check CHECK(snapshot_renderable=(public.syntholo_certificate_business_snapshot_renderable_v1(business_name_snapshot) AND public.syntholo_certificate_course_snapshot_renderable_v1(course_title_snapshot))),
  CONSTRAINT certificate_records_state_check CHECK(public.syntholo_certificate_record_state_valid_v1(snapshot_renderable,recipient_name_version_id,recipient_name_version,recipient_name_snapshot,status,failure_code,issued_at))
);
--> statement-breakpoint
CREATE INDEX certificate_records_member_history_idx ON public.certificate_records(account_id,membership_id,completed_at DESC,id DESC);
--> statement-breakpoint
CREATE TABLE public.certificate_files(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),certificate_id uuid NOT NULL,course_completion_id uuid NOT NULL,account_id uuid NOT NULL,membership_id uuid NOT NULL,
  object_key text NOT NULL,access text NOT NULL,content_type text NOT NULL,byte_length integer NOT NULL,sha256 text NOT NULL,etag text NOT NULL,renderer_version text NOT NULL,stored_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT certificate_files_record_exact_fk FOREIGN KEY(certificate_id,account_id,membership_id,course_completion_id) REFERENCES public.certificate_records(id,account_id,membership_id,course_completion_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT certificate_files_certificate_unique UNIQUE(certificate_id),CONSTRAINT certificate_files_completion_unique UNIQUE(course_completion_id),CONSTRAINT certificate_files_exact_unique UNIQUE(id,certificate_id,account_id,membership_id,course_completion_id),
  CONSTRAINT certificate_files_object_key_check CHECK(object_key='certificates/v1/'||account_id::text||'/'||course_completion_id::text||'.pdf'),
  CONSTRAINT certificate_files_access_check CHECK(access='private'),CONSTRAINT certificate_files_content_type_check CHECK(content_type='application/pdf'),
  CONSTRAINT certificate_files_byte_length_check CHECK(byte_length BETWEEN 1 AND 26214400),CONSTRAINT certificate_files_hash_check CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT certificate_files_etag_check CHECK(public.syntholo_certificate_etag_valid_v1(etag)),CONSTRAINT certificate_files_renderer_check CHECK(renderer_version='certificate-pdf.v1')
);
--> statement-breakpoint
CREATE TABLE public.certificate_delivery_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),certificate_id uuid NOT NULL,account_id uuid NOT NULL,membership_id uuid NOT NULL,
  staff_identity_id uuid NOT NULL REFERENCES public.staff_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,reason text NOT NULL,
  source_command_receipt_id uuid NOT NULL REFERENCES public.api_command_receipts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,correlation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'delivery_pending',created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT certificate_delivery_requests_record_exact_fk FOREIGN KEY(certificate_id,account_id,membership_id) REFERENCES public.certificate_records(id,account_id,membership_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT certificate_delivery_requests_source_receipt_unique UNIQUE(source_command_receipt_id),CONSTRAINT certificate_delivery_requests_exact_unique UNIQUE(id,certificate_id,account_id,membership_id),
  CONSTRAINT certificate_delivery_requests_status_check CHECK(status='delivery_pending'),CONSTRAINT certificate_delivery_requests_reason_check CHECK(public.syntholo_certificate_text_valid_v1(reason,2000,true))
);
--> statement-breakpoint
CREATE INDEX certificate_delivery_requests_certificate_idx ON public.certificate_delivery_requests(certificate_id,created_at);
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_immutable_row_v1() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $f$ BEGIN RAISE EXCEPTION 'CERTIFICATE_IMMUTABLE'; END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_head_guard_v1() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $f$
BEGIN
  IF TG_OP='DELETE' OR NEW.account_id<>OLD.account_id OR NEW.membership_id<>OLD.membership_id OR NEW.created_at<>OLD.created_at
    OR NEW.current_version<>OLD.current_version+1 OR NEW.current_version_id=OLD.current_version_id OR NEW.updated_at<=OLD.updated_at
  THEN RAISE EXCEPTION 'CERTIFICATE_NAME_HEAD_IMMUTABLE'; END IF;
  RETURN NEW;
END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_record_guard_v1() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $f$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CERTIFICATE_RECORD_IMMUTABLE'; END IF;
  IF ROW(NEW.id,NEW.certificate_prerequisite_id,NEW.course_completion_id,NEW.account_id,NEW.membership_id,NEW.enrollment_id,NEW.course_id,NEW.course_version_id,NEW.business_name_snapshot,NEW.course_title_snapshot,NEW.course_version,NEW.completed_at,NEW.snapshot_renderable,NEW.renderer_version,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.certificate_prerequisite_id,OLD.course_completion_id,OLD.account_id,OLD.membership_id,OLD.enrollment_id,OLD.course_id,OLD.course_version_id,OLD.business_name_snapshot,OLD.course_title_snapshot,OLD.course_version,OLD.completed_at,OLD.snapshot_renderable,OLD.renderer_version,OLD.created_at)
  THEN RAISE EXCEPTION 'CERTIFICATE_RECORD_IMMUTABLE'; END IF;
  IF OLD.status='awaiting_recipient_name' AND OLD.recipient_name_version_id IS NULL AND NEW.recipient_name_version_id IS NOT NULL
    AND ((OLD.snapshot_renderable AND NEW.status='pending' AND NEW.failure_code IS NULL)
      OR (NOT OLD.snapshot_renderable AND NEW.status='failed' AND NEW.failure_code='snapshot_not_renderable'))
  THEN RETURN NEW; END IF;
  IF OLD.status='pending' AND NEW.status IN('issued','failed') AND NEW.recipient_name_version_id=OLD.recipient_name_version_id AND NEW.recipient_name_snapshot=OLD.recipient_name_snapshot THEN RETURN NEW; END IF;
  IF OLD.status='failed' AND OLD.failure_code='storage_failed' AND NEW.status='pending' AND current_setting('app.certificate_transition',true)='retry_storage' AND NEW.failure_code IS NULL AND NEW.recipient_name_version_id=OLD.recipient_name_version_id THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'CERTIFICATE_TRANSITION_INVALID';
END $f$;
--> statement-breakpoint
CREATE TRIGGER certificate_name_versions_immutable BEFORE UPDATE OR DELETE ON public.certificate_recipient_name_versions FOR EACH ROW EXECUTE FUNCTION public.syntholo_certificate_immutable_row_v1();
CREATE TRIGGER certificate_name_heads_guard BEFORE UPDATE OR DELETE ON public.certificate_recipient_name_heads FOR EACH ROW EXECUTE FUNCTION public.syntholo_certificate_head_guard_v1();
CREATE TRIGGER certificate_records_guard BEFORE UPDATE OR DELETE ON public.certificate_records FOR EACH ROW EXECUTE FUNCTION public.syntholo_certificate_record_guard_v1();
CREATE TRIGGER certificate_files_immutable BEFORE UPDATE OR DELETE ON public.certificate_files FOR EACH ROW EXECUTE FUNCTION public.syntholo_certificate_immutable_row_v1();
CREATE TRIGGER certificate_delivery_requests_immutable BEFORE UPDATE OR DELETE ON public.certificate_delivery_requests FOR EACH ROW EXECUTE FUNCTION public.syntholo_certificate_immutable_row_v1();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_certificate_immutable_row_v1(),public.syntholo_certificate_head_guard_v1(),public.syntholo_certificate_record_guard_v1() FROM PUBLIC;
--> statement-breakpoint
DO $rls$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['certificate_recipient_name_versions','certificate_recipient_name_heads','certificate_records','certificate_files','certificate_delivery_requests'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true)',table_name||'_migrator',table_name);
  END LOOP;
END $rls$;
--> statement-breakpoint
REVOKE ALL ON public.certificate_recipient_name_versions,public.certificate_recipient_name_heads,public.certificate_records,public.certificate_files,public.certificate_delivery_requests FROM PUBLIC,syntholo_member_api,syntholo_staff_api,syntholo_worker,syntholo_system_api;
GRANT ALL ON public.certificate_recipient_name_versions,public.certificate_recipient_name_heads,public.certificate_records,public.certificate_files,public.certificate_delivery_requests TO syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_enqueue_v1(p_certificate_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE target record; inserted_id uuid; existing public.jobs; expected_payload jsonb;
BEGIN
  SELECT r.*,o.actor_type source_actor_type,o.actor_id source_actor_id,o.correlation_id source_correlation_id
  INTO target
  FROM public.certificate_records r
  JOIN public.outbox_events o ON o.type='learning.course_completed.v1' AND o.schema_version=1
    AND o.aggregate_id=r.course_completion_id::text AND o.account_id=r.account_id
    AND o.payload=jsonb_build_object('courseCompletionId',r.course_completion_id::text,'accountId',r.account_id::text,'membershipId',r.membership_id::text,'enrollmentId',r.enrollment_id::text,'courseId',r.course_id::text,'courseVersionId',r.course_version_id::text)
  JOIN public.memberships m ON m.id=r.membership_id AND m.account_id=r.account_id
    AND o.actor_type='member' AND o.actor_id=m.member_identity_id::text
  WHERE r.id=p_certificate_id AND r.status='pending'
  FOR SHARE OF r,o,m;
  IF target.id IS NULL THEN RETURN false; END IF;
  expected_payload:=jsonb_build_object('certificateId',target.id::text,'courseCompletionId',target.course_completion_id::text);
  INSERT INTO public.jobs(account_id,source_actor_type,source_actor_id,correlation_id,queue,type,idempotency_key,payload,status,priority,attempts,max_attempts,run_at,claim_generation,created_at,updated_at)
  VALUES(target.account_id,target.source_actor_type,target.source_actor_id,target.source_correlation_id,'default','learning.course_completed.certificate.v1','certificate:'||target.course_completion_id::text,expected_payload,'queued',0,0,5,date_trunc('milliseconds',clock_timestamp()),0,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()))
  ON CONFLICT(idempotency_key) DO NOTHING RETURNING id INTO inserted_id;
  IF inserted_id IS NOT NULL THEN RETURN true; END IF;
  SELECT * INTO existing FROM public.jobs WHERE idempotency_key='certificate:'||target.course_completion_id::text FOR SHARE;
  IF existing.id IS NULL OR existing.account_id<>target.account_id OR existing.source_actor_type<>target.source_actor_type
    OR existing.source_actor_id<>target.source_actor_id OR existing.correlation_id<>target.source_correlation_id
    OR existing.queue<>'default' OR existing.type<>'learning.course_completed.certificate.v1'
    OR existing.payload<>expected_payload OR existing.priority<>0 OR existing.max_attempts<>5
  THEN RAISE EXCEPTION 'CERTIFICATE_JOB_RECONCILIATION_REQUIRED'; END IF;
  RETURN false;
END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_stage_candidate_v1(p_event_id uuid,p_handler_name text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE source record; name record; created public.certificate_records; renderable boolean; expected_keys text[]:=ARRAY['accountId','courseCompletionId','courseId','courseVersionId','enrollmentId','membershipId'];
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_worker');
  IF p_event_id IS NULL OR p_handler_name IS DISTINCT FROM 'learning.certificate_prerequisite_record' THEN RAISE EXCEPTION 'CERTIFICATE_EVENT_INPUT_INVALID'; END IF;
  SELECT o.*,c.id completion_id,c.account_id completion_account_id,c.membership_id completion_membership_id,c.enrollment_id completion_enrollment_id,c.course_id completion_course_id,c.course_version_id completion_course_version_id,c.completed_at,
    p.id prerequisite_id,a.name business_name,cv.title course_title,cv.version course_version,m.member_identity_id
  INTO source FROM public.outbox_events o
  JOIN public.course_completions c ON o.aggregate_id=c.id::text
  JOIN public.certificate_prerequisites p ON p.course_completion_id=c.id AND ROW(p.account_id,p.membership_id,p.enrollment_id,p.course_id,p.course_version_id)=ROW(c.account_id,c.membership_id,c.enrollment_id,c.course_id,c.course_version_id)
  JOIN public.accounts a ON a.id=c.account_id JOIN public.course_versions cv ON cv.id=c.course_version_id AND cv.course_id=c.course_id
  JOIN public.memberships m ON m.id=c.membership_id AND m.account_id=c.account_id
  WHERE o.event_id=p_event_id AND o.type='learning.course_completed.v1' AND o.schema_version=1 AND o.account_id=c.account_id AND o.aggregate_id=c.id::text
    AND o.actor_type='member' AND o.actor_id=m.member_identity_id::text
    AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(o.payload) key)=expected_keys
    AND o.payload=jsonb_build_object('courseCompletionId',c.id::text,'accountId',c.account_id::text,'membershipId',c.membership_id::text,'enrollmentId',c.enrollment_id::text,'courseId',c.course_id::text,'courseVersionId',c.course_version_id::text);
  IF source.completion_id IS NULL THEN RAISE EXCEPTION 'CERTIFICATE_EVENT_INPUT_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('certificate-recipient-name-scope.v1'),hashtext(source.completion_account_id::text||':'||source.completion_membership_id::text));
  SELECT v.* INTO name FROM public.certificate_recipient_name_heads h JOIN public.certificate_recipient_name_versions v ON ROW(v.id,v.account_id,v.membership_id,v.version)=ROW(h.current_version_id,h.account_id,h.membership_id,h.current_version) WHERE h.account_id=source.completion_account_id AND h.membership_id=source.completion_membership_id;
  renderable:=public.syntholo_certificate_business_snapshot_renderable_v1(source.business_name) AND public.syntholo_certificate_course_snapshot_renderable_v1(source.course_title);
  INSERT INTO public.certificate_records(certificate_prerequisite_id,course_completion_id,account_id,membership_id,enrollment_id,course_id,course_version_id,business_name_snapshot,course_title_snapshot,course_version,completed_at,snapshot_renderable,recipient_name_version_id,recipient_name_version,recipient_name_snapshot,status,failure_code)
  VALUES(source.prerequisite_id,source.completion_id,source.completion_account_id,source.completion_membership_id,source.completion_enrollment_id,source.completion_course_id,source.completion_course_version_id,source.business_name,source.course_title,source.course_version,source.completed_at,renderable,name.id,name.version,name.display_name,CASE WHEN name.id IS NULL THEN 'awaiting_recipient_name' WHEN renderable THEN 'pending' ELSE 'failed' END,CASE WHEN name.id IS NOT NULL AND NOT renderable THEN 'snapshot_not_renderable' END)
  ON CONFLICT(course_completion_id) DO NOTHING RETURNING * INTO created;
  IF created.id IS NULL THEN
    SELECT * INTO created FROM public.certificate_records WHERE course_completion_id=source.completion_id;
    IF ROW(created.certificate_prerequisite_id,created.account_id,created.membership_id,created.enrollment_id,created.course_id,created.course_version_id,created.business_name_snapshot,created.course_title_snapshot,created.course_version,created.completed_at)
      IS DISTINCT FROM ROW(source.prerequisite_id,source.completion_account_id,source.completion_membership_id,source.completion_enrollment_id,source.completion_course_id,source.completion_course_version_id,source.business_name,source.course_title,source.course_version,source.completed_at) THEN RAISE EXCEPTION 'CERTIFICATE_CANDIDATE_CONFLICT'; END IF;
    RETURN 'duplicate';
  END IF;
  IF created.status='pending' THEN PERFORM public.syntholo_certificate_enqueue_v1(created.id); END IF;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at) VALUES(gen_random_uuid(),created.account_id,'member',source.actor_id,'certificate_candidate_staged','certificate',created.id::text,source.correlation_id,jsonb_build_object('courseCompletionId',created.course_completion_id::text,'status',created.status),date_trunc('milliseconds',clock_timestamp()));
  RETURN 'recorded';
END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_confirm_recipient_name_v1(p_expected_version integer,p_display_name text,p_idempotency_key text,p_request_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor uuid;actor_account uuid;actor_membership uuid;correlation uuid;principal text;receipt public.api_command_receipts;head public.certificate_recipient_name_heads;created public.certificate_recipient_name_versions;now_at timestamptz(3);computed_hash text;response_payload jsonb;record_id uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api');
  actor:=nullif(current_setting('app.actor_id',true),'')::uuid;actor_account:=nullif(current_setting('app.account_id',true),'')::uuid;actor_membership:=nullif(current_setting('app.membership_id',true),'')::uuid;correlation:=nullif(current_setting('app.correlation_id',true),'')::uuid;now_at:=date_trunc('milliseconds',clock_timestamp());
  IF current_setting('app.actor_kind',true)<>'member' OR actor IS NULL OR actor_account IS NULL OR actor_membership IS NULL OR correlation IS NULL OR p_expected_version IS NULL OR p_expected_version NOT BETWEEN 0 AND 2147483646 OR public.syntholo_certificate_recipient_name_valid_v1(p_display_name) IS DISTINCT FROM true OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._~-]{16,128}$' OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'CERTIFICATE_COMMAND_INVALID'; END IF;
  PERFORM 1 FROM public.memberships m WHERE m.id=actor_membership AND m.account_id=actor_account AND m.member_identity_id=actor AND m.status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CERTIFICATE_NOT_FOUND'; END IF;
  principal:=actor::text||':'||actor_account::text||':'||actor_membership::text;
  PERFORM pg_advisory_xact_lock(hashtext('certificate-recipient-name-scope.v1'),hashtext(actor_account::text||':'||actor_membership::text));
  computed_hash:=encode(sha256(convert_to(public.syntholo_canonical_jsonb_text_v1(jsonb_build_object('routeVersion','certificate-recipient-name.v1','accountId',actor_account::text,'membershipId',actor_membership::text,'expectedVersion',p_expected_version,'displayName',p_display_name)),'UTF8')),'hex');
  IF computed_hash<>p_request_hash THEN RAISE EXCEPTION 'CERTIFICATE_COMMAND_INVALID'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('certificate-recipient-name.v1'),hashtext(principal||':'||p_idempotency_key)) THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS'; END IF;
  SELECT * INTO receipt FROM public.api_command_receipts WHERE principal_kind='member' AND principal_id=principal AND method='PUT' AND route_template='/v1/member/certificate-recipient-name' AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF receipt.id IS NOT NULL THEN IF receipt.request_hash<>p_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'; END IF; IF receipt.status='completed' THEN RETURN receipt.response; END IF; RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS'; END IF;
  INSERT INTO public.api_command_receipts(principal_kind,principal_id,method,route_template,idempotency_key,request_hash,status,expires_at,created_at) VALUES('member',principal,'PUT','/v1/member/certificate-recipient-name',p_idempotency_key,p_request_hash,'in_progress',now_at+interval '30 days',now_at) RETURNING * INTO receipt;
  SELECT * INTO head FROM public.certificate_recipient_name_heads WHERE account_id=actor_account AND membership_id=actor_membership FOR UPDATE;
  IF coalesce(head.current_version,0)<>p_expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  INSERT INTO public.certificate_recipient_name_versions(account_id,membership_id,version,display_name,content_hash,actor_identity_id,source_command_receipt_id,correlation_id,confirmed_at)
  VALUES(actor_account,actor_membership,p_expected_version+1,p_display_name,encode(sha256(convert_to('certificate-recipient-name.v1'||chr(10)||p_display_name,'UTF8')),'hex'),actor,receipt.id,correlation,now_at) RETURNING * INTO created;
  IF head.account_id IS NULL THEN INSERT INTO public.certificate_recipient_name_heads(account_id,membership_id,current_version,current_version_id,created_at,updated_at) VALUES(actor_account,actor_membership,created.version,created.id,now_at,now_at);
  ELSE UPDATE public.certificate_recipient_name_heads SET current_version=created.version,current_version_id=created.id,updated_at=greatest(now_at,head.updated_at + interval '1 millisecond') WHERE account_id=actor_account AND membership_id=actor_membership; END IF;
  FOR record_id IN UPDATE public.certificate_records SET recipient_name_version_id=created.id,recipient_name_version=created.version,recipient_name_snapshot=created.display_name,status=CASE WHEN snapshot_renderable THEN 'pending' ELSE 'failed' END,failure_code=CASE WHEN snapshot_renderable THEN NULL ELSE 'snapshot_not_renderable' END,updated_at=now_at WHERE account_id=actor_account AND membership_id=actor_membership AND status='awaiting_recipient_name' RETURNING id LOOP
    PERFORM public.syntholo_certificate_enqueue_v1(record_id);
  END LOOP;
  response_payload:=jsonb_build_object('schemaVersion',1,'recipientName',jsonb_build_object('version',created.version,'displayName',created.display_name,'confirmedAt',to_char(created.confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  UPDATE public.api_command_receipts AS command_receipt SET status='completed',response_status=200,response=response_payload,completed_at=now_at WHERE command_receipt.id=receipt.id;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at) VALUES(gen_random_uuid(),actor_account,'member',actor::text,'certificate_recipient_name_confirmed','membership',actor_membership::text,correlation,jsonb_build_object('recipientNameVersionId',created.id::text,'version',created.version),now_at);
  RETURN response_payload;
END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_recipient_name_get_v1() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor uuid;actor_account uuid;actor_membership uuid;name record;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api');
  actor:=nullif(current_setting('app.actor_id',true),'')::uuid;actor_account:=nullif(current_setting('app.account_id',true),'')::uuid;actor_membership:=nullif(current_setting('app.membership_id',true),'')::uuid;
  IF current_setting('app.actor_kind',true)<>'member' OR NOT EXISTS(SELECT 1 FROM public.memberships m WHERE m.id=actor_membership AND m.account_id=actor_account AND m.member_identity_id=actor AND m.status='active') THEN RAISE EXCEPTION 'CERTIFICATE_NOT_FOUND'; END IF;
  SELECT v.version,v.display_name,v.confirmed_at INTO name FROM public.certificate_recipient_name_heads h JOIN public.certificate_recipient_name_versions v ON ROW(v.id,v.account_id,v.membership_id,v.version)=ROW(h.current_version_id,h.account_id,h.membership_id,h.current_version) WHERE h.account_id=actor_account AND h.membership_id=actor_membership;
  RETURN jsonb_build_object('schemaVersion',1,'recipientName',CASE WHEN name.version IS NULL THEN NULL ELSE jsonb_build_object('version',name.version,'displayName',name.display_name,'confirmedAt',to_char(name.confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END);
END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificates_list_v1(p_before_completed timestamptz,p_before_id uuid,p_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor uuid;actor_account uuid;actor_membership uuid;result jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api');
  actor:=nullif(current_setting('app.actor_id',true),'')::uuid;actor_account:=nullif(current_setting('app.account_id',true),'')::uuid;actor_membership:=nullif(current_setting('app.membership_id',true),'')::uuid;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 101 OR (p_before_completed IS NULL)<>(p_before_id IS NULL) OR current_setting('app.actor_kind',true)<>'member' OR NOT EXISTS(SELECT 1 FROM public.memberships m WHERE m.id=actor_membership AND m.account_id=actor_account AND m.member_identity_id=actor AND m.status='active') THEN RAISE EXCEPTION 'CERTIFICATE_NOT_FOUND'; END IF;
  SELECT coalesce(jsonb_agg(item ORDER BY completed_at DESC,id DESC),'[]'::jsonb) INTO result FROM(SELECT r.completed_at,r.id,jsonb_build_object('id',r.id::text,'courseCompletionId',r.course_completion_id::text,'status',r.status,'snapshotRenderable',r.snapshot_renderable,'recipientName',r.recipient_name_snapshot,'businessName',CASE WHEN r.snapshot_renderable THEN r.business_name_snapshot END,'courseTitle',CASE WHEN r.snapshot_renderable THEN r.course_title_snapshot END,'courseVersion',r.course_version,'completedAt',to_char(r.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'issuedAt',CASE WHEN r.issued_at IS NULL THEN NULL ELSE to_char(r.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'failureCode',r.failure_code) item FROM public.certificate_records r WHERE r.account_id=actor_account AND r.membership_id=actor_membership AND (p_before_completed IS NULL OR (r.completed_at,r.id)<(p_before_completed,p_before_id)) ORDER BY r.completed_at DESC,r.id DESC LIMIT p_limit) q;
  RETURN result;
END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_download_fence_v1(p_certificate_id uuid) RETURNS public.certificate_files LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor uuid;actor_account uuid;actor_membership uuid;file public.certificate_files;
BEGIN PERFORM public.syntholo_attest_runtime_capability('syntholo_member_api'); actor:=nullif(current_setting('app.actor_id',true),'')::uuid;actor_account:=nullif(current_setting('app.account_id',true),'')::uuid;actor_membership:=nullif(current_setting('app.membership_id',true),'')::uuid;
  SELECT f.* INTO file FROM public.certificate_files f JOIN public.certificate_records r ON r.id=f.certificate_id AND r.account_id=f.account_id AND r.membership_id=f.membership_id WHERE f.certificate_id=p_certificate_id AND f.account_id=actor_account AND f.membership_id=actor_membership AND r.status='issued' AND current_setting('app.actor_kind',true)='member' AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.id=actor_membership AND m.account_id=actor_account AND m.member_identity_id=actor AND m.status='active');
  IF file.id IS NULL THEN RAISE EXCEPTION 'CERTIFICATE_NOT_FOUND'; END IF; RETURN file; END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_load_generation_fence_v1(p_job_id uuid,p_worker_id text,p_attempt integer,p_generation integer,p_claim_token uuid) RETURNS public.certificate_records LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE target public.certificate_records;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_worker');
  SELECT r.* INTO target
  FROM public.jobs j
  JOIN public.job_attempts ja ON ja.job_id=j.id AND ja.account_id=j.account_id
    AND ja.worker_id=p_worker_id AND ja.attempt=p_attempt AND ja.claim_generation=p_generation
    AND ja.claim_token=p_claim_token AND ja.outcome='running' AND ja.finished_at IS NULL
    AND ja.started_at=j.claimed_at AND ja.lease_expires_at=j.lease_expires_at
  JOIN public.certificate_records r ON j.payload->>'certificateId'=r.id::text
  JOIN public.outbox_events o ON o.type='learning.course_completed.v1' AND o.schema_version=1
    AND o.aggregate_id=r.course_completion_id::text AND o.account_id=r.account_id
    AND o.payload=jsonb_build_object('courseCompletionId',r.course_completion_id::text,'accountId',r.account_id::text,'membershipId',r.membership_id::text,'enrollmentId',r.enrollment_id::text,'courseId',r.course_id::text,'courseVersionId',r.course_version_id::text)
  JOIN public.memberships m ON m.id=r.membership_id AND m.account_id=r.account_id
    AND o.actor_type='member' AND o.actor_id=m.member_identity_id::text
  WHERE p_worker_id~'-certificate-v1$' AND j.id=p_job_id AND j.account_id=r.account_id AND j.source_actor_type=o.actor_type
    AND j.source_actor_id=o.actor_id AND j.correlation_id=o.correlation_id
    AND j.queue='default' AND j.type='learning.course_completed.certificate.v1'
    AND j.priority=0 AND j.max_attempts=5
    AND j.idempotency_key='certificate:'||r.course_completion_id::text
    AND j.payload=jsonb_build_object('certificateId',r.id::text,'courseCompletionId',r.course_completion_id::text)
    AND j.status='running' AND j.worker_id=p_worker_id AND j.claimed_at<=clock_timestamp()
    AND j.attempts=p_attempt AND j.claim_generation=p_generation
    AND j.claim_token=p_claim_token AND j.lease_expires_at>clock_timestamp() AND r.status IN('pending','issued','failed')
  FOR SHARE OF j,ja,r,o,m;
  IF target.id IS NULL THEN RAISE EXCEPTION 'CERTIFICATE_JOB_FENCE_INVALID'; END IF;
  RETURN target;
END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_load_issued_file_v1(p_job_id uuid,p_worker_id text,p_attempt integer,p_generation integer,p_claim_token uuid) RETURNS public.certificate_files LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE file public.certificate_files;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_worker');
  SELECT f.* INTO file
  FROM public.jobs j
  JOIN public.job_attempts ja ON ja.job_id=j.id AND ja.account_id=j.account_id
    AND ja.worker_id=p_worker_id AND ja.attempt=p_attempt AND ja.claim_generation=p_generation
    AND ja.claim_token=p_claim_token AND ja.outcome='running' AND ja.finished_at IS NULL
    AND ja.started_at=j.claimed_at AND ja.lease_expires_at=j.lease_expires_at
  JOIN public.certificate_records r ON j.payload->>'certificateId'=r.id::text
  JOIN public.certificate_files f ON f.certificate_id=r.id AND f.account_id=r.account_id AND f.membership_id=r.membership_id AND f.course_completion_id=r.course_completion_id
  JOIN public.outbox_events o ON o.type='learning.course_completed.v1' AND o.schema_version=1
    AND o.aggregate_id=r.course_completion_id::text AND o.account_id=r.account_id
    AND o.payload=jsonb_build_object('courseCompletionId',r.course_completion_id::text,'accountId',r.account_id::text,'membershipId',r.membership_id::text,'enrollmentId',r.enrollment_id::text,'courseId',r.course_id::text,'courseVersionId',r.course_version_id::text)
  JOIN public.memberships m ON m.id=r.membership_id AND m.account_id=r.account_id AND o.actor_type='member' AND o.actor_id=m.member_identity_id::text
  WHERE p_worker_id~'-certificate-v1$' AND j.id=p_job_id AND j.account_id=r.account_id AND j.source_actor_type=o.actor_type AND j.source_actor_id=o.actor_id AND j.correlation_id=o.correlation_id
    AND j.queue='default' AND j.type='learning.course_completed.certificate.v1' AND j.idempotency_key='certificate:'||r.course_completion_id::text
    AND j.priority=0 AND j.max_attempts=5
    AND j.payload=jsonb_build_object('certificateId',r.id::text,'courseCompletionId',r.course_completion_id::text)
    AND j.status='running' AND j.worker_id=p_worker_id AND j.claimed_at<=clock_timestamp()
    AND j.attempts=p_attempt AND j.claim_generation=p_generation AND j.claim_token=p_claim_token AND j.lease_expires_at>clock_timestamp()
    AND r.status='issued' AND f.object_key='certificates/v1/'||r.account_id::text||'/'||r.course_completion_id::text||'.pdf'
    AND f.access='private' AND f.content_type='application/pdf' AND f.renderer_version=r.renderer_version
  FOR SHARE OF j,ja,r,f,o,m;
  IF file.id IS NULL THEN RAISE EXCEPTION 'CERTIFICATE_JOB_FENCE_INVALID'; END IF;
  RETURN file;
END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_lock_generation_fence_v1(p_job_id uuid,p_worker_id text,p_attempt integer,p_generation integer,p_claim_token uuid) RETURNS public.certificate_records LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE target public.certificate_records;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_worker');
  SELECT r.* INTO target
  FROM public.jobs j
  JOIN public.job_attempts ja ON ja.job_id=j.id AND ja.account_id=j.account_id
    AND ja.worker_id=p_worker_id AND ja.attempt=p_attempt AND ja.claim_generation=p_generation
    AND ja.claim_token=p_claim_token AND ja.outcome='running' AND ja.finished_at IS NULL
    AND ja.started_at=j.claimed_at AND ja.lease_expires_at=j.lease_expires_at
  JOIN public.certificate_records r ON j.payload->>'certificateId'=r.id::text
  JOIN public.outbox_events o ON o.type='learning.course_completed.v1' AND o.schema_version=1
    AND o.aggregate_id=r.course_completion_id::text AND o.account_id=r.account_id
    AND o.payload=jsonb_build_object('courseCompletionId',r.course_completion_id::text,'accountId',r.account_id::text,'membershipId',r.membership_id::text,'enrollmentId',r.enrollment_id::text,'courseId',r.course_id::text,'courseVersionId',r.course_version_id::text)
  JOIN public.memberships m ON m.id=r.membership_id AND m.account_id=r.account_id
    AND o.actor_type='member' AND o.actor_id=m.member_identity_id::text
  WHERE p_worker_id~'-certificate-v1$' AND j.id=p_job_id AND j.account_id=r.account_id AND j.source_actor_type=o.actor_type
    AND j.source_actor_id=o.actor_id AND j.correlation_id=o.correlation_id
    AND j.queue='default' AND j.type='learning.course_completed.certificate.v1'
    AND j.priority=0 AND j.max_attempts=5
    AND j.idempotency_key='certificate:'||r.course_completion_id::text
    AND j.payload=jsonb_build_object('certificateId',r.id::text,'courseCompletionId',r.course_completion_id::text)
    AND j.status='running' AND j.worker_id=p_worker_id AND j.claimed_at<=clock_timestamp()
    AND j.attempts=p_attempt AND j.claim_generation=p_generation
    AND j.claim_token=p_claim_token AND j.lease_expires_at>clock_timestamp()
    AND r.status IN('pending','issued','failed')
  FOR UPDATE OF j,ja,r;
  IF target.id IS NULL THEN RAISE EXCEPTION 'CERTIFICATE_JOB_FENCE_INVALID'; END IF;
  RETURN target;
END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_finalize_v1(p_job_id uuid,p_worker_id text,p_attempt integer,p_generation integer,p_claim_token uuid,p_byte_length integer,p_sha256 text,p_etag text)
RETURNS public.certificate_files LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE target public.certificate_records;file public.certificate_files;now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp());
BEGIN IF p_byte_length IS NULL OR p_byte_length NOT BETWEEN 1 AND 26214400 OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' OR public.syntholo_certificate_etag_valid_v1(p_etag) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CERTIFICATE_FINALIZE_INPUT_INVALID'; END IF; target:=public.syntholo_certificate_lock_generation_fence_v1(p_job_id,p_worker_id,p_attempt,p_generation,p_claim_token);
  IF target.status='issued' THEN SELECT * INTO file FROM public.certificate_files WHERE certificate_id=target.id FOR SHARE; IF file.id IS NULL OR ROW(file.byte_length,file.sha256,file.etag,file.object_key,file.access,file.content_type,file.renderer_version) IS DISTINCT FROM ROW(p_byte_length,p_sha256,p_etag,'certificates/v1/'||target.account_id::text||'/'||target.course_completion_id::text||'.pdf','private','application/pdf',target.renderer_version) THEN RAISE EXCEPTION 'CERTIFICATE_JOB_ACK_MISMATCH'; END IF; RETURN file; END IF;
  IF target.status<>'pending' THEN RAISE EXCEPTION 'CERTIFICATE_JOB_ACK_MISMATCH'; END IF;
  INSERT INTO public.certificate_files(certificate_id,course_completion_id,account_id,membership_id,object_key,access,content_type,byte_length,sha256,etag,renderer_version,stored_at) VALUES(target.id,target.course_completion_id,target.account_id,target.membership_id,'certificates/v1/'||target.account_id::text||'/'||target.course_completion_id::text||'.pdf','private','application/pdf',p_byte_length,p_sha256,p_etag,target.renderer_version,now_at) ON CONFLICT(certificate_id) DO NOTHING RETURNING * INTO file;
  IF file.id IS NULL THEN RAISE EXCEPTION 'CERTIFICATE_JOB_ACK_MISMATCH'; END IF;
  UPDATE public.certificate_records SET status='issued',failure_code=NULL,issued_at=now_at,updated_at=now_at WHERE id=target.id AND status='pending'; RETURN file; END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_mark_failed_v1(p_job_id uuid,p_worker_id text,p_attempt integer,p_generation integer,p_claim_token uuid,p_failure_code text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$ DECLARE target public.certificate_records; BEGIN IF p_failure_code IS NULL OR p_failure_code NOT IN('render_failed','storage_failed') THEN RAISE EXCEPTION 'CERTIFICATE_FAILURE_INVALID'; END IF; target:=public.syntholo_certificate_lock_generation_fence_v1(p_job_id,p_worker_id,p_attempt,p_generation,p_claim_token); IF target.status='failed' THEN IF target.failure_code<>p_failure_code THEN RAISE EXCEPTION 'CERTIFICATE_JOB_ACK_MISMATCH'; END IF; RETURN 'failed'; END IF; IF target.status<>'pending' THEN RAISE EXCEPTION 'CERTIFICATE_JOB_ACK_MISMATCH'; END IF; UPDATE public.certificate_records SET status='failed',failure_code=p_failure_code,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=target.id; RETURN 'failed'; END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_storage_retry_candidates_v1(p_limit integer) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE candidates jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_worker');
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'CERTIFICATE_RETRY_INPUT_INVALID'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(candidate)),'[]'::jsonb) INTO candidates FROM (
    SELECT r.*,j.id recovery_job_id,j.attempts recovery_attempt,j.claim_generation recovery_claim_generation
    FROM public.certificate_records r
    JOIN public.jobs j ON j.payload->>'certificateId'=r.id::text
    JOIN public.job_attempts ja ON ja.job_id=j.id AND ja.account_id=j.account_id AND ja.attempt=j.attempts AND ja.claim_generation=j.claim_generation
      AND ja.outcome='dead_letter' AND ja.finished_at IS NOT NULL AND ja.worker_id~'-certificate-v1$'
      AND j.worker_id=ja.worker_id AND j.claimed_at=ja.started_at AND j.completed_at=ja.finished_at
      AND j.last_error_code=ja.error_code AND j.last_error_message=ja.error_message
      AND ja.error_code='JOB_HANDLER_FAILED' AND ja.error_message='Job handler failed'
    JOIN public.outbox_events o ON o.type='learning.course_completed.v1' AND o.schema_version=1 AND o.aggregate_id=r.course_completion_id::text AND o.account_id=r.account_id
      AND o.payload=jsonb_build_object('courseCompletionId',r.course_completion_id::text,'accountId',r.account_id::text,'membershipId',r.membership_id::text,'enrollmentId',r.enrollment_id::text,'courseId',r.course_id::text,'courseVersionId',r.course_version_id::text)
    JOIN public.memberships m ON m.id=r.membership_id AND m.account_id=r.account_id AND o.actor_type='member' AND o.actor_id=m.member_identity_id::text
    WHERE j.account_id=r.account_id AND j.source_actor_type=o.actor_type AND j.source_actor_id=o.actor_id AND j.correlation_id=o.correlation_id
      AND j.queue='default' AND j.type='learning.course_completed.certificate.v1' AND j.idempotency_key='certificate:'||r.course_completion_id::text
      AND j.priority=0 AND j.max_attempts=5 AND j.attempts<j.max_attempts
      AND j.payload=jsonb_build_object('certificateId',r.id::text,'courseCompletionId',r.course_completion_id::text)
      AND j.status='dead_letter' AND j.claim_token IS NULL AND j.lease_expires_at IS NULL
      AND r.status='failed' AND r.failure_code='storage_failed'
      AND NOT EXISTS(SELECT 1 FROM public.certificate_files f WHERE f.certificate_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM public.audit_events a
        WHERE a.account_id=r.account_id AND a.actor_type='system' AND a.actor_id='certificate-recovery.v1'
          AND a.correlation_id=o.correlation_id AND a.action='certificate_storage_retry_authorized'
          AND a.target_type='certificate' AND a.target_id=r.id::text
          AND a.payload->>'jobId'=j.id::text AND a.payload->>'attempt'=j.attempts::text
          AND a.payload->>'claimGeneration'=j.claim_generation::text
          AND public.syntholo_certificate_recovery_audit_valid_v1(a.action,a.payload,j.id,j.attempts,j.claim_generation))
      AND NOT EXISTS(SELECT 1 FROM public.audit_events a
        WHERE a.account_id=r.account_id AND a.actor_type='system' AND a.actor_id='certificate-recovery.v1'
          AND a.correlation_id=o.correlation_id AND a.action='certificate_storage_retry_rejected'
          AND a.target_type='certificate' AND a.target_id=r.id::text
          AND a.payload->>'jobId'=j.id::text AND a.payload->>'attempt'=j.attempts::text
          AND a.payload->>'claimGeneration'=j.claim_generation::text
          AND public.syntholo_certificate_recovery_audit_valid_v1(a.action,a.payload,j.id,j.attempts,j.claim_generation))
    ORDER BY r.updated_at,r.id
    FOR SHARE OF r,j,ja,o,m SKIP LOCKED
    LIMIT p_limit
  ) candidate;
  RETURN candidates;
END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_retry_v1(p_certificate_id uuid,p_job_id uuid,p_failed_attempt integer,p_failed_generation integer,p_object_state text,p_byte_length integer,p_sha256 text,p_etag text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE target public.certificate_records;job public.jobs;correlation uuid;now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp());prior_action text;prior_payload jsonb;expected_payload jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_worker');
  IF p_certificate_id IS NULL OR p_job_id IS NULL OR p_failed_attempt IS NULL OR p_failed_attempt<1
    OR p_failed_generation IS NULL OR p_failed_generation<1 OR p_object_state IS NULL OR p_object_state NOT IN('absent','matching')
    OR p_byte_length IS NULL OR p_byte_length NOT BETWEEN 1 AND 26214400 OR p_sha256 IS NULL OR p_sha256!~'^[0-9a-f]{64}$'
    OR (p_object_state='absent' AND p_etag IS NOT NULL)
    OR (p_object_state='matching' AND public.syntholo_certificate_etag_valid_v1(p_etag) IS DISTINCT FROM true)
  THEN RAISE EXCEPTION 'CERTIFICATE_RETRY_INPUT_INVALID'; END IF;
  expected_payload:=jsonb_strip_nulls(jsonb_build_object('failureCode','storage_failed','jobId',p_job_id::text,
    'attempt',p_failed_attempt,'claimGeneration',p_failed_generation,'objectState',p_object_state,
    'byteLength',p_byte_length,'sha256',p_sha256,'etag',p_etag));
  SELECT r.* INTO target
  FROM public.jobs j
  JOIN public.certificate_records r ON r.id=p_certificate_id AND j.id=p_job_id AND j.payload->>'certificateId'=r.id::text
  JOIN public.job_attempts ja ON ja.job_id=j.id AND ja.account_id=j.account_id AND ja.attempt=j.attempts AND ja.claim_generation=j.claim_generation
    AND ja.outcome='dead_letter' AND ja.finished_at IS NOT NULL AND ja.worker_id~'-certificate-v1$'
    AND j.worker_id=ja.worker_id AND j.claimed_at=ja.started_at AND j.completed_at=ja.finished_at
    AND j.last_error_code=ja.error_code AND j.last_error_message=ja.error_message
    AND ja.error_code='JOB_HANDLER_FAILED' AND ja.error_message='Job handler failed'
  JOIN public.outbox_events o ON o.type='learning.course_completed.v1' AND o.schema_version=1 AND o.aggregate_id=r.course_completion_id::text AND o.account_id=r.account_id
    AND o.payload=jsonb_build_object('courseCompletionId',r.course_completion_id::text,'accountId',r.account_id::text,'membershipId',r.membership_id::text,'enrollmentId',r.enrollment_id::text,'courseId',r.course_id::text,'courseVersionId',r.course_version_id::text)
  JOIN public.memberships m ON m.id=r.membership_id AND m.account_id=r.account_id AND o.actor_type='member' AND o.actor_id=m.member_identity_id::text
  WHERE j.account_id=r.account_id AND j.source_actor_type=o.actor_type AND j.source_actor_id=o.actor_id AND j.correlation_id=o.correlation_id
    AND j.queue='default' AND j.type='learning.course_completed.certificate.v1' AND j.idempotency_key='certificate:'||r.course_completion_id::text
    AND j.priority=0 AND j.max_attempts=5 AND j.attempts=p_failed_attempt AND j.claim_generation=p_failed_generation
    AND j.attempts<j.max_attempts
    AND j.payload=jsonb_build_object('certificateId',r.id::text,'courseCompletionId',r.course_completion_id::text)
    AND j.status='dead_letter' AND j.claim_token IS NULL AND j.lease_expires_at IS NULL AND r.status='failed' AND r.failure_code='storage_failed'
  FOR UPDATE OF j,r,ja;
  IF target.id IS NULL THEN
    SELECT a.action,a.payload INTO prior_action,prior_payload
      FROM public.certificate_records r JOIN public.jobs j ON j.id=p_job_id AND j.account_id=r.account_id
      JOIN public.outbox_events o ON o.type='learning.course_completed.v1' AND o.schema_version=1
        AND o.aggregate_id=r.course_completion_id::text AND o.account_id=r.account_id
        AND o.payload=jsonb_build_object('courseCompletionId',r.course_completion_id::text,'accountId',r.account_id::text,'membershipId',r.membership_id::text,'enrollmentId',r.enrollment_id::text,'courseId',r.course_id::text,'courseVersionId',r.course_version_id::text)
      JOIN public.memberships m ON m.id=r.membership_id AND m.account_id=r.account_id
        AND o.actor_type='member' AND o.actor_id=m.member_identity_id::text
      JOIN public.audit_events a ON a.account_id=r.account_id
        AND a.actor_type='system' AND a.actor_id='certificate-recovery.v1' AND a.correlation_id=o.correlation_id
        AND a.action IN('certificate_storage_retry_authorized','certificate_storage_retry_rejected')
        AND a.target_type='certificate' AND a.target_id=r.id::text
      WHERE r.id=p_certificate_id AND j.source_actor_type=o.actor_type AND j.source_actor_id=o.actor_id AND j.correlation_id=o.correlation_id
        AND j.queue='default' AND j.type='learning.course_completed.certificate.v1'
        AND j.priority=0 AND j.max_attempts=5 AND j.idempotency_key='certificate:'||r.course_completion_id::text
        AND j.payload=jsonb_build_object('certificateId',r.id::text,'courseCompletionId',r.course_completion_id::text)
        AND a.payload->>'jobId'=p_job_id::text
        AND a.payload->>'attempt'=p_failed_attempt::text
        AND a.payload->>'claimGeneration'=p_failed_generation::text
        AND public.syntholo_certificate_recovery_audit_valid_v1(a.action,a.payload,p_job_id,p_failed_attempt,p_failed_generation)
      ORDER BY a.occurred_at,a.id LIMIT 1;
    IF prior_action='certificate_storage_retry_authorized' AND prior_payload=expected_payload THEN RETURN 'duplicate'; END IF;
    IF prior_action IS NOT NULL THEN RETURN 'prior_decision'; END IF;
    RAISE EXCEPTION 'CERTIFICATE_RETRY_RECONCILIATION_REQUIRED';
  END IF;
  SELECT * INTO job FROM public.jobs WHERE id=p_job_id;
  correlation:=job.correlation_id;
  IF EXISTS(SELECT 1 FROM public.audit_events a WHERE a.target_type='certificate' AND a.target_id=target.id::text
    AND a.action IN('certificate_storage_retry_authorized','certificate_storage_retry_rejected')
    AND a.payload->>'jobId'=job.id::text AND a.payload->>'attempt'=p_failed_attempt::text
    AND a.payload->>'claimGeneration'=p_failed_generation::text
    AND (a.account_id=target.account_id AND a.actor_type='system' AND a.actor_id='certificate-recovery.v1'
      AND a.correlation_id=correlation
      AND public.syntholo_certificate_recovery_audit_valid_v1(a.action,a.payload,job.id,p_failed_attempt,p_failed_generation)) IS DISTINCT FROM true)
  THEN RAISE EXCEPTION 'CERTIFICATE_RETRY_RECONCILIATION_REQUIRED'; END IF;
  SELECT a.action,a.payload INTO prior_action,prior_payload FROM public.audit_events a
  WHERE a.account_id=target.account_id AND a.actor_type='system' AND a.actor_id='certificate-recovery.v1'
    AND a.correlation_id=correlation AND a.target_type='certificate' AND a.target_id=target.id::text
    AND a.action IN('certificate_storage_retry_authorized','certificate_storage_retry_rejected')
    AND a.payload->>'jobId'=job.id::text AND a.payload->>'attempt'=p_failed_attempt::text
    AND a.payload->>'claimGeneration'=p_failed_generation::text
    AND public.syntholo_certificate_recovery_audit_valid_v1(a.action,a.payload,job.id,p_failed_attempt,p_failed_generation)
  ORDER BY a.occurred_at,a.id LIMIT 1;
  IF prior_action='certificate_storage_retry_authorized' AND prior_payload=expected_payload THEN RETURN 'duplicate'; END IF;
  IF prior_action IS NOT NULL THEN RETURN 'prior_decision'; END IF;
  IF EXISTS(SELECT 1 FROM public.certificate_files WHERE certificate_id=target.id) THEN RAISE EXCEPTION 'CERTIFICATE_RETRY_RECONCILIATION_REQUIRED'; END IF;
  PERFORM set_config('app.certificate_transition','retry_storage',true);
  UPDATE public.certificate_records SET status='pending',failure_code=NULL,updated_at=now_at WHERE id=target.id;
  UPDATE public.jobs SET status='queued',run_at=now_at,claimed_at=NULL,worker_id=NULL,lease_expires_at=NULL,claim_token=NULL,completed_at=NULL,last_error_code=NULL,last_error_message=NULL,updated_at=now_at WHERE id=job.id;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at) VALUES(gen_random_uuid(),target.account_id,'system','certificate-recovery.v1','certificate_storage_retry_authorized','certificate',target.id::text,correlation,expected_payload,now_at);
  RETURN 'pending';
END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_recovery_reject_v1(p_certificate_id uuid,p_job_id uuid,p_failed_attempt integer,p_failed_generation integer,p_reason text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE target public.certificate_records;job public.jobs;correlation uuid;now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp());prior_action text;prior_payload jsonb;expected_payload jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_worker');
  IF p_certificate_id IS NULL OR p_job_id IS NULL OR p_failed_attempt IS NULL OR p_failed_attempt<1
    OR p_failed_generation IS NULL OR p_failed_generation<1 OR p_reason IS NULL
    OR p_reason NOT IN('object_mismatch','provider_shape_invalid','render_authority_invalid')
  THEN RAISE EXCEPTION 'CERTIFICATE_RETRY_INPUT_INVALID'; END IF;
  expected_payload:=jsonb_build_object('failureCode','storage_failed','jobId',p_job_id::text,
    'attempt',p_failed_attempt,'claimGeneration',p_failed_generation,'reason',p_reason);
  SELECT r.* INTO target
  FROM public.jobs j
  JOIN public.certificate_records r ON r.id=p_certificate_id AND j.id=p_job_id AND j.payload->>'certificateId'=r.id::text
  JOIN public.job_attempts ja ON ja.job_id=j.id AND ja.account_id=j.account_id AND ja.attempt=j.attempts AND ja.claim_generation=j.claim_generation
    AND ja.outcome='dead_letter' AND ja.finished_at IS NOT NULL AND ja.worker_id~'-certificate-v1$'
    AND j.worker_id=ja.worker_id AND j.claimed_at=ja.started_at AND j.completed_at=ja.finished_at
    AND j.last_error_code=ja.error_code AND j.last_error_message=ja.error_message
    AND ja.error_code='JOB_HANDLER_FAILED' AND ja.error_message='Job handler failed'
  JOIN public.outbox_events o ON o.type='learning.course_completed.v1' AND o.schema_version=1 AND o.aggregate_id=r.course_completion_id::text AND o.account_id=r.account_id
    AND o.payload=jsonb_build_object('courseCompletionId',r.course_completion_id::text,'accountId',r.account_id::text,'membershipId',r.membership_id::text,'enrollmentId',r.enrollment_id::text,'courseId',r.course_id::text,'courseVersionId',r.course_version_id::text)
  JOIN public.memberships m ON m.id=r.membership_id AND m.account_id=r.account_id AND o.actor_type='member' AND o.actor_id=m.member_identity_id::text
  WHERE j.account_id=r.account_id AND j.source_actor_type=o.actor_type AND j.source_actor_id=o.actor_id AND j.correlation_id=o.correlation_id
    AND j.queue='default' AND j.type='learning.course_completed.certificate.v1' AND j.idempotency_key='certificate:'||r.course_completion_id::text
    AND j.priority=0 AND j.max_attempts=5 AND j.attempts=p_failed_attempt AND j.claim_generation=p_failed_generation
    AND j.attempts<j.max_attempts AND j.payload=jsonb_build_object('certificateId',r.id::text,'courseCompletionId',r.course_completion_id::text)
    AND j.status='dead_letter' AND j.claim_token IS NULL AND j.lease_expires_at IS NULL AND r.status='failed' AND r.failure_code='storage_failed'
  FOR UPDATE OF j,r,ja;
  IF target.id IS NULL THEN
    SELECT a.action,a.payload INTO prior_action,prior_payload
      FROM public.certificate_records r JOIN public.jobs j ON j.id=p_job_id AND j.account_id=r.account_id
      JOIN public.outbox_events o ON o.type='learning.course_completed.v1' AND o.schema_version=1
        AND o.aggregate_id=r.course_completion_id::text AND o.account_id=r.account_id
        AND o.payload=jsonb_build_object('courseCompletionId',r.course_completion_id::text,'accountId',r.account_id::text,'membershipId',r.membership_id::text,'enrollmentId',r.enrollment_id::text,'courseId',r.course_id::text,'courseVersionId',r.course_version_id::text)
      JOIN public.memberships m ON m.id=r.membership_id AND m.account_id=r.account_id
        AND o.actor_type='member' AND o.actor_id=m.member_identity_id::text
      JOIN public.audit_events a ON a.account_id=r.account_id
        AND a.actor_type='system' AND a.actor_id='certificate-recovery.v1' AND a.correlation_id=o.correlation_id
        AND a.action IN('certificate_storage_retry_authorized','certificate_storage_retry_rejected')
        AND a.target_type='certificate' AND a.target_id=r.id::text
      WHERE r.id=p_certificate_id AND j.source_actor_type=o.actor_type AND j.source_actor_id=o.actor_id AND j.correlation_id=o.correlation_id
        AND j.queue='default' AND j.type='learning.course_completed.certificate.v1'
        AND j.priority=0 AND j.max_attempts=5 AND j.idempotency_key='certificate:'||r.course_completion_id::text
        AND j.payload=jsonb_build_object('certificateId',r.id::text,'courseCompletionId',r.course_completion_id::text)
        AND a.payload->>'jobId'=p_job_id::text
        AND a.payload->>'attempt'=p_failed_attempt::text
        AND a.payload->>'claimGeneration'=p_failed_generation::text
        AND public.syntholo_certificate_recovery_audit_valid_v1(a.action,a.payload,p_job_id,p_failed_attempt,p_failed_generation)
      ORDER BY a.occurred_at,a.id LIMIT 1;
    IF prior_action='certificate_storage_retry_rejected' AND prior_payload=expected_payload THEN RETURN 'duplicate'; END IF;
    IF prior_action IS NOT NULL THEN RETURN 'prior_decision'; END IF;
    RAISE EXCEPTION 'CERTIFICATE_RETRY_RECONCILIATION_REQUIRED';
  END IF;
  SELECT * INTO job FROM public.jobs WHERE id=p_job_id;
  correlation:=job.correlation_id;
  IF EXISTS(SELECT 1 FROM public.audit_events a WHERE a.target_type='certificate' AND a.target_id=target.id::text
    AND a.action IN('certificate_storage_retry_authorized','certificate_storage_retry_rejected')
    AND a.payload->>'jobId'=job.id::text AND a.payload->>'attempt'=p_failed_attempt::text
    AND a.payload->>'claimGeneration'=p_failed_generation::text
    AND (a.account_id=target.account_id AND a.actor_type='system' AND a.actor_id='certificate-recovery.v1'
      AND a.correlation_id=correlation
      AND public.syntholo_certificate_recovery_audit_valid_v1(a.action,a.payload,job.id,p_failed_attempt,p_failed_generation)) IS DISTINCT FROM true)
  THEN RAISE EXCEPTION 'CERTIFICATE_RETRY_RECONCILIATION_REQUIRED'; END IF;
  SELECT a.action,a.payload INTO prior_action,prior_payload FROM public.audit_events a
  WHERE a.account_id=target.account_id AND a.actor_type='system' AND a.actor_id='certificate-recovery.v1'
    AND a.correlation_id=correlation AND a.target_type='certificate' AND a.target_id=target.id::text
    AND a.action IN('certificate_storage_retry_authorized','certificate_storage_retry_rejected')
    AND a.payload->>'jobId'=job.id::text AND a.payload->>'attempt'=p_failed_attempt::text
    AND a.payload->>'claimGeneration'=p_failed_generation::text
    AND public.syntholo_certificate_recovery_audit_valid_v1(a.action,a.payload,job.id,p_failed_attempt,p_failed_generation)
  ORDER BY a.occurred_at,a.id LIMIT 1;
  IF prior_action='certificate_storage_retry_rejected' AND prior_payload=expected_payload THEN RETURN 'duplicate'; END IF;
  IF prior_action IS NOT NULL THEN RETURN 'prior_decision'; END IF;
  IF EXISTS(SELECT 1 FROM public.certificate_files WHERE certificate_id=target.id)
  THEN RAISE EXCEPTION 'CERTIFICATE_RETRY_RECONCILIATION_REQUIRED'; END IF;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at)
  VALUES(gen_random_uuid(),target.account_id,'system','certificate-recovery.v1','certificate_storage_retry_rejected','certificate',target.id::text,correlation,
    expected_payload,now_at);
  RETURN 'rejected';
END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_promote_v1(p_limit integer) RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE candidate record;binding record;stage_result text;promoted integer:=0;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_worker');
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'CERTIFICATE_PROMOTE_INVALID'; END IF;

  FOR candidate IN
    SELECT o.event_id
    FROM public.outbox_events o
    JOIN public.certificate_prerequisites p ON o.type='learning.course_completed.v1' AND o.schema_version=1 AND o.aggregate_id=p.course_completion_id::text
    LEFT JOIN public.certificate_records r ON r.course_completion_id=p.course_completion_id
    WHERE r.id IS NULL
    ORDER BY o.created_at,o.event_id
    LIMIT p_limit
  LOOP
    stage_result:=public.syntholo_certificate_stage_candidate_v1(candidate.event_id,'learning.certificate_prerequisite_record');
    IF stage_result='recorded' THEN
      INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at)
      SELECT gen_random_uuid(),o.account_id,'system','certificate-promoter.v1','certificate_historical_candidate','course_completion',o.aggregate_id,o.correlation_id,jsonb_build_object('eventId',o.event_id::text),date_trunc('milliseconds',clock_timestamp())
      FROM public.outbox_events o WHERE o.event_id=candidate.event_id;
      promoted:=promoted+1;
    END IF;
  END LOOP;

  FOR candidate IN
    SELECT r.id,r.account_id,r.membership_id
    FROM public.certificate_records r
    WHERE r.status='awaiting_recipient_name'
    ORDER BY r.created_at,r.id
    LIMIT greatest(0,p_limit-promoted)
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('certificate-recipient-name-scope.v1'),hashtext(candidate.account_id::text||':'||candidate.membership_id::text));
    SELECT r.id,h.current_version_id,v.version,v.display_name,r.snapshot_renderable INTO binding
    FROM public.certificate_records r
    JOIN public.certificate_recipient_name_heads h ON h.account_id=r.account_id AND h.membership_id=r.membership_id
    JOIN public.certificate_recipient_name_versions v ON v.id=h.current_version_id AND v.account_id=h.account_id AND v.membership_id=h.membership_id AND v.version=h.current_version
    WHERE r.id=candidate.id AND r.status='awaiting_recipient_name'
    FOR UPDATE OF r;
    IF binding.id IS NOT NULL THEN
      UPDATE public.certificate_records SET recipient_name_version_id=binding.current_version_id,recipient_name_version=binding.version,recipient_name_snapshot=binding.display_name,status=CASE WHEN binding.snapshot_renderable THEN 'pending' ELSE 'failed' END,failure_code=CASE WHEN binding.snapshot_renderable THEN NULL ELSE 'snapshot_not_renderable' END,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=binding.id;
      IF binding.snapshot_renderable THEN PERFORM public.syntholo_certificate_enqueue_v1(binding.id); END IF;
      promoted:=promoted+1;
    END IF;
  END LOOP;
  RETURN promoted;
END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificate_create_delivery_v1(p_certificate_id uuid,p_reason text,p_idempotency_key text,p_request_hash text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor uuid;correlation uuid;target public.certificate_records;receipt public.api_command_receipts;principal text;computed text;now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp());response_payload jsonb:=jsonb_build_object('status','delivery_pending');
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  correlation:=nullif(current_setting('app.correlation_id',true),'')::uuid;
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR correlation IS NULL THEN RAISE EXCEPTION 'CERTIFICATE_NOT_FOUND'; END IF;
  PERFORM 1 FROM public.staff_identities s WHERE s.id=actor AND s.status='active' AND s.role='admin' AND 'certificates:deliver'=ANY(s.permissions) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CERTIFICATE_NOT_FOUND'; END IF;
  SELECT r.* INTO target FROM public.certificate_records r JOIN public.certificate_files f ON f.certificate_id=r.id AND f.account_id=r.account_id AND f.membership_id=r.membership_id AND f.course_completion_id=r.course_completion_id WHERE r.id=p_certificate_id AND r.status='issued' FOR SHARE OF r,f;
  IF target.id IS NULL OR public.syntholo_certificate_text_valid_v1(p_reason,2000,true) IS DISTINCT FROM true OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._~-]{16,128}$' OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'CERTIFICATE_NOT_FOUND'; END IF;
  principal:=actor::text;
  computed:=encode(sha256(convert_to(public.syntholo_canonical_jsonb_text_v1(jsonb_build_object('routeVersion','certificate-delivery.v1','certificateId',target.id::text,'reason',p_reason)),'UTF8')),'hex');
  IF computed<>p_request_hash THEN RAISE EXCEPTION 'CERTIFICATE_COMMAND_INVALID'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('certificate-delivery.v1'),hashtext(principal||':'||p_idempotency_key)) THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS'; END IF;
  SELECT * INTO receipt FROM public.api_command_receipts WHERE principal_kind='staff' AND principal_id=principal AND method='POST' AND route_template='/v1/staff/certificates/:certificateId/deliveries' AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF receipt.id IS NOT NULL THEN IF receipt.request_hash<>p_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'; END IF; IF receipt.status='completed' THEN RETURN receipt.response; END IF; RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS'; END IF;
  INSERT INTO public.api_command_receipts(principal_kind,principal_id,method,route_template,idempotency_key,request_hash,status,expires_at,created_at) VALUES('staff',principal,'POST','/v1/staff/certificates/:certificateId/deliveries',p_idempotency_key,p_request_hash,'in_progress',now_at+interval '30 days',now_at) RETURNING * INTO receipt;
  INSERT INTO public.certificate_delivery_requests(certificate_id,account_id,membership_id,staff_identity_id,reason,source_command_receipt_id,correlation_id,created_at) VALUES(target.id,target.account_id,target.membership_id,actor,p_reason,receipt.id,correlation,now_at);
  UPDATE public.api_command_receipts AS command_receipt SET status='completed',response_status=202,response=response_payload,completed_at=now_at WHERE command_receipt.id=receipt.id;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at) VALUES(gen_random_uuid(),target.account_id,'staff',actor::text,'certificate_delivery_requested','certificate',target.id::text,correlation,jsonb_build_object('status','delivery_pending'),now_at);
  RETURN response_payload;
END $f$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_certificates_readiness_v1()
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
      AND (SELECT count(*)=1 AND bool_and(oid IS NOT NULL AND prokind='f' AND proowner=(SELECT proowner FROM owner) AND prosecdef AND provolatile='v' AND NOT proisstrict AND proparallel='u' AND proconfig=ARRAY['search_path=pg_catalog, public']::text[] AND body_hash='41aa3e6a5d7a634c9332ec616c8931b7fc8fa15fa91db13cd3e0eb0f7c1536b6') FROM runtime_attestation)
      AND (SELECT count(*)=1 AND bool_and(oid IS NOT NULL AND prokind='f' AND proowner=(SELECT proowner FROM owner) AND prosecdef AND provolatile='v' AND NOT proisstrict AND proparallel='u' AND proconfig=ARRAY['search_path=pg_catalog, public']::text[] AND body_hash='9ce584d3c189c1a822548071084d24de59f0bfb495c9c73c4a9cf856c2100891') FROM job_claim_function)
      AND (SELECT count(*)=1 AND bool_and(oid IS NOT NULL AND prokind='f' AND proowner=(SELECT proowner FROM owner) AND prosecdef AND provolatile='s' AND NOT proisstrict AND proparallel='u' AND proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[] AND body_hash='3df9c2312c471e16a3554a11b5e99facc4c9a0ce692134031a2902514bd4c9c3') FROM implementation_readiness_function)
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
REVOKE ALL ON FUNCTION public.syntholo_certificate_enqueue_v1(uuid),public.syntholo_certificate_stage_candidate_v1(uuid,text),public.syntholo_certificate_confirm_recipient_name_v1(integer,text,text,text),public.syntholo_certificate_recipient_name_get_v1(),public.syntholo_certificates_list_v1(timestamptz,uuid,integer),public.syntholo_certificate_download_fence_v1(uuid),public.syntholo_certificate_load_generation_fence_v1(uuid,text,integer,integer,uuid),public.syntholo_certificate_load_issued_file_v1(uuid,text,integer,integer,uuid),public.syntholo_certificate_lock_generation_fence_v1(uuid,text,integer,integer,uuid),public.syntholo_certificate_finalize_v1(uuid,text,integer,integer,uuid,integer,text,text),public.syntholo_certificate_mark_failed_v1(uuid,text,integer,integer,uuid,text),public.syntholo_certificate_storage_retry_candidates_v1(integer),public.syntholo_certificate_retry_v1(uuid,uuid,integer,integer,text,integer,text,text),public.syntholo_certificate_recovery_reject_v1(uuid,uuid,integer,integer,text),public.syntholo_certificate_promote_v1(integer),public.syntholo_certificate_create_delivery_v1(uuid,text,text,text),public.syntholo_certificates_readiness_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_certificate_confirm_recipient_name_v1(integer,text,text,text),public.syntholo_certificate_recipient_name_get_v1(),public.syntholo_certificates_list_v1(timestamptz,uuid,integer),public.syntholo_certificate_download_fence_v1(uuid) TO syntholo_member_api;
GRANT EXECUTE ON FUNCTION public.syntholo_certificate_create_delivery_v1(uuid,text,text,text) TO syntholo_staff_api;
GRANT EXECUTE ON FUNCTION public.syntholo_certificate_stage_candidate_v1(uuid,text),public.syntholo_certificate_load_generation_fence_v1(uuid,text,integer,integer,uuid),public.syntholo_certificate_load_issued_file_v1(uuid,text,integer,integer,uuid),public.syntholo_certificate_finalize_v1(uuid,text,integer,integer,uuid,integer,text,text),public.syntholo_certificate_mark_failed_v1(uuid,text,integer,integer,uuid,text),public.syntholo_certificate_storage_retry_candidates_v1(integer),public.syntholo_certificate_retry_v1(uuid,uuid,integer,integer,text,integer,text,text),public.syntholo_certificate_recovery_reject_v1(uuid,uuid,integer,integer,text),public.syntholo_certificate_promote_v1(integer) TO syntholo_worker;
GRANT EXECUTE ON FUNCTION public.syntholo_certificates_readiness_v1() TO syntholo_migrator,syntholo_member_api,syntholo_staff_api,syntholo_worker,syntholo_system_api;
