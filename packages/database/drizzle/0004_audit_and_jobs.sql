DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM audit_events
    WHERE octet_length(COALESCE(actor_id, 'legacy_migration')) NOT BETWEEN 1 AND 255
       OR octet_length(action) NOT BETWEEN 1 AND 255
       OR octet_length(target_type) NOT BETWEEN 1 AND 255
       OR (target_id IS NOT NULL AND octet_length(target_id) NOT BETWEEN 1 AND 255)
       OR octet_length(payload::text) > 16384
  ) OR EXISTS (
    SELECT 1 FROM outbox_events
    WHERE schema_version <> 1 OR octet_length(type) NOT BETWEEN 1 AND 255
       OR octet_length(aggregate_id) NOT BETWEEN 1 AND 255
       OR (last_error_code IS NOT NULL AND octet_length(last_error_code) NOT BETWEEN 1 AND 64)
       OR octet_length(payload::text) > 65536 OR attempts > 100
  ) OR EXISTS (
    SELECT 1 FROM jobs
    WHERE octet_length(queue) NOT BETWEEN 1 AND 64
       OR octet_length(type) NOT BETWEEN 1 AND 255
       OR octet_length(payload::text) > 65536 OR max_attempts > 100
       OR attempts > 100 OR priority NOT BETWEEN -1000 AND 1000
       OR (worker_id IS NOT NULL AND octet_length(worker_id) NOT BETWEEN 1 AND 128)
       OR (last_error_code IS NOT NULL AND octet_length(last_error_code) NOT BETWEEN 1 AND 64)
       OR (last_error_message IS NOT NULL AND octet_length(last_error_message) NOT BETWEEN 1 AND 255)
  ) THEN
    RAISE EXCEPTION 'SYNTHOLO_0004_LEGACY_DATA_PREFLIGHT_FAILED' USING ERRCODE = '23514';
  END IF;
END;
$preflight$;
--> statement-breakpoint
ALTER TABLE audit_events
  ALTER COLUMN actor_id SET DEFAULT 'legacy_migration',
  ALTER COLUMN correlation_id SET DEFAULT '00000000-0000-4000-8000-000000000000';
--> statement-breakpoint
UPDATE audit_events
SET actor_id = COALESCE(actor_id, 'legacy_migration'),
    correlation_id = COALESCE(correlation_id, '00000000-0000-4000-8000-000000000000');
--> statement-breakpoint
ALTER TABLE audit_events
  ALTER COLUMN actor_id SET NOT NULL,
  ALTER COLUMN correlation_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE audit_events
  ALTER COLUMN actor_id DROP DEFAULT,
  ALTER COLUMN correlation_id DROP DEFAULT,
  ALTER COLUMN occurred_at DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_actor_id_length_check
    CHECK (octet_length(actor_id) BETWEEN 1 AND 255),
  ADD CONSTRAINT audit_events_action_length_check
    CHECK (octet_length(action) BETWEEN 1 AND 255),
  ADD CONSTRAINT audit_events_target_type_length_check
    CHECK (octet_length(target_type) BETWEEN 1 AND 255),
  ADD CONSTRAINT audit_events_target_id_length_check
    CHECK (target_id IS NULL OR octet_length(target_id) BETWEEN 1 AND 255),
  ADD CONSTRAINT audit_events_payload_size_check
    CHECK (octet_length(payload::text) <= 16384);
--> statement-breakpoint
CREATE FUNCTION public.prevent_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'SYNTHOLO_AUDIT_APPEND_ONLY' USING ERRCODE = '55000';
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prevent_audit_mutation() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only_rows
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_mutation();
--> statement-breakpoint
ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_append_only_rows;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_audit_mutation();
--> statement-breakpoint
ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_append_only_truncate;
--> statement-breakpoint
ALTER TABLE outbox_events ADD COLUMN event_id uuid;
UPDATE outbox_events SET event_id = id;
ALTER TABLE outbox_events ALTER COLUMN event_id SET NOT NULL;
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_pkey;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (event_id);
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_legacy_id_unique UNIQUE (id);
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_identity_check CHECK (id = event_id);
--> statement-breakpoint
CREATE FUNCTION public.syntholo_sync_outbox_event_identity()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.event_id IS NULL THEN
    NEW.event_id := NEW.id;
  ELSE
    NEW.id := NEW.event_id;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.syntholo_sync_outbox_event_identity() FROM PUBLIC;
CREATE TRIGGER outbox_events_identity_compatibility
  BEFORE INSERT ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION public.syntholo_sync_outbox_event_identity();
--> statement-breakpoint
ALTER TABLE outbox_events
  ADD COLUMN occurred_at timestamp with time zone,
  ADD COLUMN actor_type text,
  ADD COLUMN actor_id text,
  ADD COLUMN correlation_id uuid,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 10,
  ADD COLUMN worker_id text,
  ADD COLUMN lease_expires_at timestamp with time zone,
  ADD COLUMN claim_token uuid,
  ADD COLUMN claim_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN dead_lettered_at timestamp with time zone,
  ADD COLUMN last_error_message text;
--> statement-breakpoint
UPDATE outbox_events SET
  occurred_at = created_at,
  actor_type = 'system',
  actor_id = 'legacy_migration',
  correlation_id = '00000000-0000-4000-8000-000000000000'
WHERE occurred_at IS NULL;
UPDATE outbox_events SET
  max_attempts = LEAST(100, GREATEST(max_attempts, attempts, 1)),
  attempts = LEAST(attempts, 100);
UPDATE outbox_events SET
  status = 'pending', worker_id = NULL, claimed_at = NULL,
  lease_expires_at = NULL, claim_token = NULL, published_at = NULL,
  dead_lettered_at = NULL
WHERE status IN ('pending', 'processing');
UPDATE outbox_events SET
  max_attempts = LEAST(100, GREATEST(max_attempts, attempts, 1)),
  attempts = LEAST(attempts, 100),
  published_at = GREATEST(COALESCE(published_at, created_at), created_at),
  dead_lettered_at = NULL
WHERE status = 'published';
UPDATE outbox_events SET published_at = NULL,
  dead_lettered_at = GREATEST(created_at, occurred_at)
WHERE status = 'dead_letter';
--> statement-breakpoint
ALTER TABLE outbox_events
  ALTER COLUMN occurred_at SET NOT NULL,
  ALTER COLUMN actor_type SET NOT NULL,
  ALTER COLUMN actor_id SET NOT NULL,
  ALTER COLUMN correlation_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_schema_version_check;
--> statement-breakpoint
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_schema_version_check CHECK (schema_version = 1),
  ADD CONSTRAINT outbox_events_actor_type_check
    CHECK (actor_type IN ('member', 'staff', 'system')),
  ADD CONSTRAINT outbox_events_actor_id_length_check
    CHECK (octet_length(actor_id) BETWEEN 1 AND 255),
  ADD CONSTRAINT outbox_events_type_length_check
    CHECK (octet_length(type) BETWEEN 1 AND 255),
  ADD CONSTRAINT outbox_events_aggregate_id_length_check
    CHECK (octet_length(aggregate_id) BETWEEN 1 AND 255),
  ADD CONSTRAINT outbox_events_attempt_bounds_check
    CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 100 AND attempts <= max_attempts),
  ADD CONSTRAINT outbox_events_claim_generation_check CHECK (claim_generation >= 0),
  ADD CONSTRAINT outbox_events_worker_id_length_check
    CHECK (worker_id IS NULL OR octet_length(worker_id) BETWEEN 1 AND 128),
  ADD CONSTRAINT outbox_events_error_code_length_check
    CHECK (last_error_code IS NULL OR octet_length(last_error_code) BETWEEN 1 AND 64),
  ADD CONSTRAINT outbox_events_error_message_length_check
    CHECK (last_error_message IS NULL OR octet_length(last_error_message) BETWEEN 1 AND 255),
  ADD CONSTRAINT outbox_events_payload_size_check
    CHECK (octet_length(payload::text) <= 65536),
  ADD CONSTRAINT outbox_events_state_fields_check CHECK (
    (status = 'pending' AND worker_id IS NULL AND claimed_at IS NULL
      AND lease_expires_at IS NULL AND claim_token IS NULL AND published_at IS NULL
      AND dead_lettered_at IS NULL)
    OR
    (status = 'processing' AND worker_id IS NOT NULL AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL AND claim_token IS NOT NULL
      AND published_at IS NULL AND dead_lettered_at IS NULL
      AND lease_expires_at > claimed_at)
    OR
    (status = 'published' AND published_at IS NOT NULL AND published_at >= occurred_at
      AND dead_lettered_at IS NULL AND lease_expires_at IS NULL AND claim_token IS NULL)
    OR
    (status = 'dead_letter' AND published_at IS NULL AND dead_lettered_at IS NOT NULL
      AND dead_lettered_at >= occurred_at
      AND lease_expires_at IS NULL AND claim_token IS NULL)
  );
--> statement-breakpoint
DROP INDEX outbox_events_claim_idx;
--> statement-breakpoint
CREATE INDEX outbox_events_claim_idx
  ON outbox_events (available_at, created_at, event_id)
  WHERE status IN ('pending', 'processing');
CREATE INDEX outbox_events_recovery_idx
  ON outbox_events (lease_expires_at, event_id)
  WHERE status = 'processing';
--> statement-breakpoint
ALTER TABLE jobs
  ADD COLUMN idempotency_key text,
  ADD COLUMN source_actor_type text,
  ADD COLUMN source_actor_id text,
  ADD COLUMN correlation_id uuid,
  ADD COLUMN lease_expires_at timestamp with time zone,
  ADD COLUMN claim_token uuid,
  ADD COLUMN claim_generation integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE jobs SET
  idempotency_key = 'legacy:' || id::text,
  source_actor_type = 'system',
  source_actor_id = 'legacy_migration',
  correlation_id = '00000000-0000-4000-8000-000000000000'
WHERE idempotency_key IS NULL;
--> statement-breakpoint
ALTER TABLE jobs
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN source_actor_type SET NOT NULL,
  ALTER COLUMN source_actor_id SET NOT NULL,
  ALTER COLUMN correlation_id SET NOT NULL;
ALTER TABLE jobs ALTER COLUMN idempotency_key SET DEFAULT gen_random_uuid()::text;
--> statement-breakpoint
UPDATE jobs SET
  status = 'queued', worker_id = NULL, claimed_at = NULL,
  lease_expires_at = NULL, claim_token = NULL, completed_at = NULL
WHERE status IN ('queued', 'running');
UPDATE outbox_events SET
  max_attempts = LEAST(100, GREATEST(max_attempts, attempts, 1)),
  attempts = LEAST(attempts, 100),
  published_at = CASE WHEN status = 'published' THEN COALESCE(published_at, created_at) ELSE NULL END,
  dead_lettered_at = CASE WHEN status = 'dead_letter'
    THEN GREATEST(created_at, occurred_at) ELSE NULL END
WHERE status IN ('published', 'dead_letter');
UPDATE jobs SET
  max_attempts = GREATEST(max_attempts, attempts, 1),
  completed_at = GREATEST(
    COALESCE(completed_at, updated_at), COALESCE(claimed_at, updated_at)
  )
WHERE status IN ('completed', 'dead_letter');
ALTER TABLE jobs
  ADD CONSTRAINT jobs_idempotency_key_unique UNIQUE (idempotency_key),
  ADD CONSTRAINT jobs_source_actor_type_check
    CHECK (source_actor_type IN ('member', 'staff', 'system')),
  ADD CONSTRAINT jobs_source_actor_id_length_check
    CHECK (octet_length(source_actor_id) BETWEEN 1 AND 255),
  ADD CONSTRAINT jobs_idempotency_key_length_check
    CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  ADD CONSTRAINT jobs_queue_length_check
    CHECK (octet_length(queue) BETWEEN 1 AND 64),
  ADD CONSTRAINT jobs_type_length_check
    CHECK (octet_length(type) BETWEEN 1 AND 255),
  ADD CONSTRAINT jobs_worker_id_length_check
    CHECK (worker_id IS NULL OR octet_length(worker_id) BETWEEN 1 AND 128),
  ADD CONSTRAINT jobs_claim_generation_check CHECK (claim_generation >= 0),
  ADD CONSTRAINT jobs_priority_check CHECK (priority BETWEEN -1000 AND 1000),
  ADD CONSTRAINT jobs_max_attempts_upper_check CHECK (max_attempts BETWEEN 1 AND 100),
  ADD CONSTRAINT jobs_error_code_length_check
    CHECK (last_error_code IS NULL OR octet_length(last_error_code) BETWEEN 1 AND 64),
  ADD CONSTRAINT jobs_error_message_length_check
    CHECK (last_error_message IS NULL OR octet_length(last_error_message) BETWEEN 1 AND 255),
  ADD CONSTRAINT jobs_payload_size_check CHECK (octet_length(payload::text) <= 65536),
  ADD CONSTRAINT jobs_state_fields_check CHECK (
    (status = 'queued' AND worker_id IS NULL AND lease_expires_at IS NULL
      AND claim_token IS NULL AND completed_at IS NULL AND claimed_at IS NULL)
    OR
    (status = 'running' AND worker_id IS NOT NULL AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL AND claim_token IS NOT NULL
      AND completed_at IS NULL AND lease_expires_at > claimed_at)
    OR
    (status IN ('completed', 'dead_letter') AND completed_at IS NOT NULL
      AND lease_expires_at IS NULL AND claim_token IS NULL
      AND (claimed_at IS NULL OR completed_at >= claimed_at))
  );
--> statement-breakpoint
DROP INDEX jobs_claim_idx;
--> statement-breakpoint
CREATE INDEX jobs_claim_idx
  ON jobs (priority DESC NULLS LAST, run_at, id)
  WHERE status IN ('queued', 'running');
CREATE INDEX jobs_recovery_idx
  ON jobs (lease_expires_at, id)
  WHERE status = 'running';
--> statement-breakpoint
CREATE TABLE job_attempts (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  attempt integer NOT NULL,
  claim_generation integer NOT NULL,
  claim_token uuid NOT NULL,
  worker_id text NOT NULL,
  started_at timestamp with time zone NOT NULL,
  lease_expires_at timestamp with time zone NOT NULL,
  finished_at timestamp with time zone,
  outcome text NOT NULL DEFAULT 'running',
  error_code text,
  error_message text,
  PRIMARY KEY (job_id, attempt, claim_generation),
  CONSTRAINT job_attempts_claim_token_unique UNIQUE (claim_token),
  CONSTRAINT job_attempts_attempt_check CHECK (attempt > 0),
  CONSTRAINT job_attempts_generation_check CHECK (claim_generation > 0),
  CONSTRAINT job_attempts_worker_id_check
    CHECK (octet_length(worker_id) BETWEEN 1 AND 128),
  CONSTRAINT job_attempts_outcome_check
    CHECK (outcome IN ('running', 'completed', 'retry', 'dead_letter', 'lease_expired')),
  CONSTRAINT job_attempts_error_code_check
    CHECK (error_code IS NULL OR octet_length(error_code) BETWEEN 1 AND 64),
  CONSTRAINT job_attempts_error_message_check
    CHECK (error_message IS NULL OR octet_length(error_message) BETWEEN 1 AND 255),
  CONSTRAINT job_attempts_time_check CHECK (
    lease_expires_at > started_at
    AND (finished_at IS NULL OR finished_at >= started_at)
  ),
  CONSTRAINT job_attempts_finish_check CHECK (
    (outcome = 'running' AND finished_at IS NULL)
    OR (outcome <> 'running' AND finished_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX job_attempts_account_started_idx
  ON job_attempts (account_id, started_at DESC);
--> statement-breakpoint
CREATE TABLE event_handler_receipts (
  handler_name text NOT NULL,
  event_id uuid NOT NULL REFERENCES outbox_events(event_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  status text NOT NULL,
  worker_id text NOT NULL,
  attempt integer NOT NULL,
  claim_generation integer NOT NULL,
  claim_token uuid NOT NULL,
  lease_expires_at timestamp with time zone,
  started_at timestamp with time zone NOT NULL,
  completed_at timestamp with time zone,
  updated_at timestamp with time zone NOT NULL,
  PRIMARY KEY (handler_name, event_id),
  CONSTRAINT event_handler_receipts_claim_token_unique UNIQUE (claim_token),
  CONSTRAINT event_handler_receipts_handler_check
    CHECK (octet_length(handler_name) BETWEEN 1 AND 128),
  CONSTRAINT event_handler_receipts_worker_check
    CHECK (octet_length(worker_id) BETWEEN 1 AND 128),
  CONSTRAINT event_handler_receipts_status_check
    CHECK (status IN ('processing', 'retryable', 'completed')),
  CONSTRAINT event_handler_receipts_attempt_check CHECK (attempt > 0),
  CONSTRAINT event_handler_receipts_generation_check CHECK (claim_generation > 0),
  CONSTRAINT event_handler_receipts_state_check CHECK (
    (status = 'processing' AND lease_expires_at IS NOT NULL
      AND lease_expires_at > started_at AND completed_at IS NULL)
    OR (status = 'retryable' AND lease_expires_at IS NULL
      AND completed_at IS NULL)
    OR (status = 'completed' AND lease_expires_at IS NULL
      AND completed_at IS NOT NULL AND completed_at >= started_at)
  ),
  CONSTRAINT event_handler_receipts_updated_check CHECK (
    updated_at >= started_at
  )
);
--> statement-breakpoint
CREATE INDEX event_handler_receipts_recovery_idx
  ON event_handler_receipts (lease_expires_at, handler_name, event_id)
  WHERE status = 'processing';
--> statement-breakpoint
CREATE FUNCTION public.enforce_job_attempt_account()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE parent_account uuid;
BEGIN
  SELECT account_id INTO parent_account FROM public.jobs WHERE id = NEW.job_id;
  IF NOT FOUND OR NEW.account_id IS DISTINCT FROM parent_account THEN
    RAISE EXCEPTION 'SYNTHOLO_JOB_ATTEMPT_ACCOUNT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION public.enforce_handler_receipt_account()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE parent_account uuid;
DECLARE job_account uuid;
BEGIN
  SELECT account_id INTO parent_account FROM public.outbox_events WHERE event_id = NEW.event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SYNTHOLO_HANDLER_RECEIPT_ACCOUNT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  SELECT account_id INTO job_account FROM public.jobs WHERE id = NEW.job_id;
  IF NOT FOUND OR NEW.account_id IS DISTINCT FROM parent_account
     OR NEW.account_id IS DISTINCT FROM job_account THEN
    RAISE EXCEPTION 'SYNTHOLO_HANDLER_RECEIPT_ACCOUNT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.enforce_job_attempt_account() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_handler_receipt_account() FROM PUBLIC;
CREATE TRIGGER job_attempts_parent_account
  BEFORE INSERT OR UPDATE OF job_id, account_id ON job_attempts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_job_attempt_account();
CREATE TRIGGER event_handler_receipts_parent_account
  BEFORE INSERT OR UPDATE OF event_id, job_id, account_id ON event_handler_receipts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_handler_receipt_account();
--> statement-breakpoint
CREATE FUNCTION public.syntholo_claim_jobs(
  p_limit integer, p_worker text, p_now timestamptz, p_lease_ms integer)
RETURNS SETOF public.jobs
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
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
    WHERE (j.status = 'queued' AND j.run_at <= p_now)
       OR (j.status = 'running' AND j.lease_expires_at <= p_now)
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
$function$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_complete_job(
  p_job uuid, p_worker text, p_attempt integer, p_generation integer,
  p_token uuid, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_job IS NULL OR p_worker IS NULL
     OR octet_length(p_worker) NOT BETWEEN 1 AND 128
     OR p_attempt IS NULL OR p_attempt < 1
     OR p_generation IS NULL OR p_generation < 1
     OR p_token IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'SYNTHOLO_JOB_TRANSITION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE public.jobs SET status='completed', completed_at=p_now,
    lease_expires_at=NULL, claim_token=NULL, updated_at=p_now
  WHERE id=p_job AND status='running' AND worker_id=p_worker
    AND attempts=p_attempt AND claim_generation=p_generation AND claim_token=p_token
    AND claimed_at <= p_now AND lease_expires_at > p_now;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.job_attempts SET outcome='completed', finished_at=p_now
  WHERE job_id=p_job AND attempt=p_attempt AND claim_generation=p_generation
    AND claim_token=p_token AND outcome='running';
  IF NOT FOUND THEN RAISE EXCEPTION 'SYNTHOLO_JOB_ATTEMPT_TRANSITION_FAILED'; END IF;
  RETURN true;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_extend_job_lease(
  p_job uuid, p_worker text, p_attempt integer, p_generation integer,
  p_token uuid, p_now timestamptz, p_lease_ms integer)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE new_expiry timestamptz;
BEGIN
  IF p_job IS NULL OR p_worker IS NULL
     OR octet_length(p_worker) NOT BETWEEN 1 AND 128
     OR p_attempt IS NULL OR p_attempt < 1
     OR p_generation IS NULL OR p_generation < 1 OR p_token IS NULL
     OR p_now IS NULL OR p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1 AND 3600000 THEN
    RAISE EXCEPTION 'SYNTHOLO_JOB_TRANSITION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  new_expiry := p_now + p_lease_ms * interval '1 millisecond';
  UPDATE public.jobs SET lease_expires_at = new_expiry, updated_at = p_now
  WHERE id=p_job AND status='running' AND worker_id=p_worker
    AND attempts=p_attempt AND claim_generation=p_generation AND claim_token=p_token
    AND claimed_at <= p_now AND lease_expires_at > p_now;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE public.job_attempts SET lease_expires_at = new_expiry
  WHERE job_id=p_job AND attempt=p_attempt AND claim_generation=p_generation
    AND claim_token=p_token AND outcome='running';
  IF NOT FOUND THEN RAISE EXCEPTION 'SYNTHOLO_JOB_ATTEMPT_TRANSITION_FAILED'; END IF;
  RETURN new_expiry;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_fail_job(
  p_job uuid, p_worker text, p_attempt integer, p_generation integer,
  p_token uuid, p_now timestamptz, p_code text, p_message text, p_run_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  terminal boolean;
  safe_message text;
  live public.jobs%ROWTYPE;
BEGIN
  IF p_job IS NULL OR p_worker IS NULL
     OR octet_length(p_worker) NOT BETWEEN 1 AND 128
     OR p_attempt IS NULL OR p_attempt < 1
     OR p_generation IS NULL OR p_generation < 1
     OR p_token IS NULL OR p_now IS NULL OR p_code IS NULL
     OR p_message IS NULL
     OR (p_run_at IS NOT NULL AND (
       p_run_at <= p_now OR p_run_at > p_now + interval '1 hour'
     )) THEN
    RAISE EXCEPTION 'SYNTHOLO_JOB_TRANSITION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  safe_message := CASE p_code
    WHEN 'JOB_DEPENDENCY_UNAVAILABLE' THEN 'Job dependency unavailable'
    WHEN 'JOB_HANDLER_FAILED' THEN 'Job handler failed'
    WHEN 'JOB_INPUT_INVALID' THEN 'Job input invalid'
    ELSE NULL
  END;
  IF safe_message IS NULL OR p_message <> safe_message THEN
    RAISE EXCEPTION 'SYNTHOLO_JOB_TRANSITION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO live FROM public.jobs
  WHERE id=p_job AND status='running' AND worker_id=p_worker
    AND attempts=p_attempt AND claim_generation=p_generation AND claim_token=p_token
    AND claimed_at <= p_now AND lease_expires_at > p_now
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  terminal := p_run_at IS NULL OR live.attempts >= live.max_attempts;
  UPDATE public.jobs SET status=CASE WHEN terminal THEN 'dead_letter' ELSE 'queued' END,
    run_at=COALESCE(p_run_at, run_at), completed_at=CASE WHEN terminal THEN p_now ELSE NULL END,
    worker_id=CASE WHEN terminal THEN worker_id ELSE NULL END,
    claimed_at=CASE WHEN terminal THEN claimed_at ELSE NULL END,
    lease_expires_at=NULL, claim_token=NULL, last_error_code=p_code,
    last_error_message=safe_message, updated_at=p_now
  WHERE id=live.id AND status='running' AND claim_token=live.claim_token;
  UPDATE public.job_attempts SET outcome=CASE WHEN terminal THEN 'dead_letter' ELSE 'retry' END,
    finished_at=p_now, error_code=p_code, error_message=safe_message
  WHERE job_id=p_job AND attempt=p_attempt AND claim_generation=p_generation
    AND claim_token=p_token AND outcome='running';
  IF NOT FOUND THEN RAISE EXCEPTION 'SYNTHOLO_JOB_ATTEMPT_TRANSITION_FAILED'; END IF;
  RETURN true;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_claim_outbox(
  p_limit integer, p_worker text, p_now timestamptz, p_lease_ms integer)
RETURNS SETOF public.outbox_events
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_worker IS NULL OR octet_length(p_worker) NOT BETWEEN 1 AND 128
     OR p_now IS NULL OR p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1 AND 3600000 THEN
    RAISE EXCEPTION 'SYNTHOLO_OUTBOX_CLAIM_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH eligible AS MATERIALIZED (
    SELECT o.event_id
    FROM public.outbox_events o
    WHERE (o.status = 'pending' AND o.available_at <= p_now)
       OR (o.status = 'processing' AND o.lease_expires_at <= p_now)
    ORDER BY o.available_at, o.created_at, o.event_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), exhausted AS (
    UPDATE public.outbox_events o SET
      status = 'dead_letter', lease_expires_at = NULL, claim_token = NULL,
      dead_lettered_at = GREATEST(p_now, o.occurred_at), published_at = NULL,
      last_error_code = 'OUTBOX_LEASE_EXPIRED',
      last_error_message = 'Outbox lease expired'
    FROM eligible e
    WHERE o.event_id = e.event_id AND o.attempts >= o.max_attempts
    RETURNING o.event_id
  ), claimed AS (
    UPDATE public.outbox_events o SET
      status = 'processing', worker_id = p_worker, claimed_at = p_now,
      lease_expires_at = p_now + p_lease_ms * interval '1 millisecond',
      claim_token = gen_random_uuid(), claim_generation = o.claim_generation + 1,
      attempts = o.attempts + 1
    FROM eligible e
    WHERE o.event_id = e.event_id AND o.attempts < o.max_attempts
      AND NOT EXISTS (SELECT 1 FROM exhausted x WHERE x.event_id = o.event_id)
    RETURNING o.*
  )
  SELECT c.* FROM claimed c ORDER BY c.available_at, c.created_at, c.event_id;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_dispatch_outbox(
  p_event uuid, p_worker text, p_attempt integer, p_generation integer,
  p_token uuid, p_now timestamptz, p_handlers text[])
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  source public.outbox_events%ROWTYPE;
  handler text;
  inserted_count integer := 0;
  job_id uuid;
BEGIN
  IF p_event IS NULL OR p_worker IS NULL
     OR octet_length(p_worker) NOT BETWEEN 1 AND 128
     OR p_attempt IS NULL OR p_attempt < 1
     OR p_generation IS NULL OR p_generation < 1
     OR p_token IS NULL OR p_now IS NULL OR p_handlers IS NULL
     OR cardinality(p_handlers) NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'SYNTHOLO_OUTBOX_TRANSITION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_handlers) h
    WHERE h IS NULL OR octet_length(h) NOT BETWEEN 1 AND 128
       OR h !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ) OR (SELECT count(*) FROM unnest(p_handlers) h)
       <> (SELECT count(DISTINCT h) FROM unnest(p_handlers) h) THEN
    RAISE EXCEPTION 'SYNTHOLO_OUTBOX_TRANSITION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO source FROM public.outbox_events
  WHERE event_id = p_event AND status = 'processing' AND worker_id = p_worker
    AND attempts = p_attempt AND claim_generation = p_generation
    AND claim_token = p_token AND claimed_at <= p_now AND lease_expires_at > p_now
  FOR UPDATE;
  IF NOT FOUND THEN RETURN -1; END IF;

  FOR handler IN SELECT h FROM unnest(p_handlers) h ORDER BY h LOOP
    SELECT (
      substr(hash,1,8)||'-'||substr(hash,9,4)||'-4'||substr(hash,14,3)||'-8'||
      substr(hash,18,3)||'-'||substr(hash,21,12)
    )::uuid INTO job_id
    FROM (SELECT md5(p_event::text || ':' || handler) AS hash) deterministic;
    INSERT INTO public.jobs
      (id, account_id, source_actor_type, source_actor_id, correlation_id,
       queue, type, idempotency_key, payload, run_at)
    VALUES
      (job_id, source.account_id, source.actor_type, source.actor_id,
       source.correlation_id, 'events', 'foundation.domain_event_handler.v1',
       'event:' || handler || ':' || p_event::text,
       jsonb_build_object('eventId', p_event::text, 'handlerName', handler), source.occurred_at)
    ON CONFLICT (idempotency_key) DO NOTHING;
    IF FOUND THEN inserted_count := inserted_count + 1; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = job_id
        AND j.idempotency_key = 'event:' || handler || ':' || p_event::text
        AND j.account_id IS NOT DISTINCT FROM source.account_id
        AND j.source_actor_type = source.actor_type
        AND j.source_actor_id = source.actor_id
        AND j.correlation_id = source.correlation_id
        AND j.queue = 'events' AND j.priority = 0 AND j.max_attempts = 5
        AND j.run_at = source.occurred_at
        AND j.type = 'foundation.domain_event_handler.v1'
        AND j.payload = jsonb_build_object('eventId', p_event::text, 'handlerName', handler)
    ) THEN
      RAISE EXCEPTION 'SYNTHOLO_OUTBOX_JOB_CONFLICT' USING ERRCODE = '23505';
    END IF;
  END LOOP;

  UPDATE public.outbox_events SET
    status = 'published', published_at = p_now,
    lease_expires_at = NULL, claim_token = NULL
  WHERE event_id = p_event AND status = 'processing' AND worker_id = p_worker
    AND attempts = p_attempt AND claim_generation = p_generation AND claim_token = p_token;
  RETURN inserted_count;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_fail_outbox(
  p_event uuid, p_worker text, p_attempt integer, p_generation integer,
  p_token uuid, p_now timestamptz, p_run_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  terminal boolean := p_run_at IS NULL;
  live public.outbox_events%ROWTYPE;
BEGIN
  IF p_event IS NULL OR p_worker IS NULL
     OR octet_length(p_worker) NOT BETWEEN 1 AND 128
     OR p_attempt IS NULL OR p_attempt < 1
     OR p_generation IS NULL OR p_generation < 1
     OR p_token IS NULL OR p_now IS NULL
     OR (p_run_at IS NOT NULL AND (p_run_at <= p_now OR p_run_at > p_now + interval '1 hour')) THEN
    RAISE EXCEPTION 'SYNTHOLO_OUTBOX_TRANSITION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO live FROM public.outbox_events
  WHERE event_id = p_event AND status = 'processing' AND worker_id = p_worker
    AND attempts = p_attempt AND claim_generation = p_generation AND claim_token = p_token
    AND claimed_at <= p_now AND lease_expires_at > p_now
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_run_at IS NOT NULL AND live.attempts >= live.max_attempts THEN
    RAISE EXCEPTION 'SYNTHOLO_OUTBOX_TRANSITION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE public.outbox_events SET
    status = CASE WHEN terminal THEN 'dead_letter' ELSE 'pending' END,
    available_at = COALESCE(p_run_at, available_at),
    worker_id = CASE WHEN terminal THEN worker_id ELSE NULL END,
    claimed_at = CASE WHEN terminal THEN claimed_at ELSE NULL END,
    lease_expires_at = NULL, claim_token = NULL,
    dead_lettered_at = CASE WHEN terminal THEN GREATEST(p_now, occurred_at) ELSE NULL END,
    last_error_code = 'OUTBOX_DISPATCH_FAILED',
    last_error_message = 'Outbox dispatch failed'
  WHERE event_id = p_event AND status = 'processing' AND worker_id = p_worker
    AND attempts = p_attempt AND claim_generation = p_generation AND claim_token = p_token
    AND claimed_at <= p_now AND lease_expires_at > p_now;
  RETURN FOUND;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_acquire_handler_receipt(
  p_job uuid, p_worker text, p_job_attempt integer, p_job_generation integer,
  p_job_token uuid, p_now timestamptz, p_lease_ms integer)
RETURNS TABLE(kind text, account_id uuid, attempt integer, claim_generation integer,
  claim_token uuid, lease_expires_at timestamptz, event_id uuid, handler_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  receipt public.event_handler_receipts%ROWTYPE;
  source public.jobs%ROWTYPE;
  event public.outbox_events%ROWTYPE;
  inserted_token uuid;
  source_event uuid;
  source_handler text;
  receipt_expiry timestamptz;
BEGIN
  IF p_job IS NULL OR p_worker IS NULL
     OR octet_length(p_worker) NOT BETWEEN 1 AND 128
     OR p_job_attempt IS NULL OR p_job_attempt < 1
     OR p_job_generation IS NULL OR p_job_generation < 1 OR p_job_token IS NULL
     OR p_now IS NULL
     OR p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1 AND 3600000 THEN
    RAISE EXCEPTION 'SYNTHOLO_HANDLER_RECEIPT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO source FROM public.jobs j
  WHERE j.id = p_job AND j.status = 'running' AND j.worker_id = p_worker
    AND j.attempts = p_job_attempt AND j.claim_generation = p_job_generation
    AND j.claim_token = p_job_token AND j.claimed_at <= p_now
    AND j.lease_expires_at > p_now
  FOR UPDATE;
  IF NOT FOUND OR source.type <> 'foundation.domain_event_handler.v1'
     OR jsonb_typeof(source.payload) <> 'object'
     OR NOT (source.payload ? 'eventId') OR NOT (source.payload ? 'handlerName')
     OR (SELECT count(*) FROM jsonb_object_keys(source.payload)) <> 2 THEN
    RAISE EXCEPTION 'SYNTHOLO_HANDLER_JOB_FENCE_INVALID' USING ERRCODE = '42501';
  END IF;
  BEGIN
    source_event := (source.payload->>'eventId')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'SYNTHOLO_HANDLER_JOB_FENCE_INVALID' USING ERRCODE = '42501';
  END;
  source_handler := source.payload->>'handlerName';
  IF source_handler IS NULL OR octet_length(source_handler) NOT BETWEEN 1 AND 128
     OR source_handler !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' THEN
    RAISE EXCEPTION 'SYNTHOLO_HANDLER_JOB_FENCE_INVALID' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO event FROM public.outbox_events o WHERE o.event_id = source_event;
  IF NOT FOUND OR event.account_id IS DISTINCT FROM source.account_id
     OR event.actor_type IS DISTINCT FROM source.source_actor_type
     OR event.actor_id IS DISTINCT FROM source.source_actor_id
     OR event.correlation_id IS DISTINCT FROM source.correlation_id
     OR event.status <> 'published' THEN
    RAISE EXCEPTION 'SYNTHOLO_HANDLER_JOB_FENCE_INVALID' USING ERRCODE = '42501';
  END IF;
  receipt_expiry := LEAST(
    source.lease_expires_at,
    p_now + p_lease_ms * interval '1 millisecond'
  );

  INSERT INTO public.event_handler_receipts
    (handler_name, event_id, job_id, account_id, status, worker_id, attempt,
     claim_generation, claim_token, lease_expires_at, started_at, updated_at)
  VALUES (source_handler, source_event, source.id, source.account_id,
    'processing', p_worker, 1, 1, gen_random_uuid(), receipt_expiry, p_now, p_now)
  ON CONFLICT ON CONSTRAINT event_handler_receipts_pkey DO NOTHING
  RETURNING event_handler_receipts.claim_token INTO inserted_token;

  SELECT * INTO receipt FROM public.event_handler_receipts r
    WHERE r.handler_name = source_handler AND r.event_id = source_event FOR UPDATE;
  IF receipt.job_id IS DISTINCT FROM source.id THEN
    RAISE EXCEPTION 'SYNTHOLO_HANDLER_JOB_FENCE_INVALID' USING ERRCODE = '42501';
  END IF;
  IF receipt.status = 'completed' THEN
    RETURN QUERY SELECT 'completed'::text, receipt.account_id, receipt.attempt,
      receipt.claim_generation, receipt.claim_token, receipt.lease_expires_at,
      receipt.event_id, receipt.handler_name;
    RETURN;
  END IF;
  IF inserted_token IS NULL THEN
    IF receipt.status = 'processing' AND receipt.lease_expires_at > p_now THEN
      RETURN QUERY SELECT 'busy'::text, receipt.account_id, receipt.attempt,
        receipt.claim_generation, receipt.claim_token, receipt.lease_expires_at,
        receipt.event_id, receipt.handler_name;
      RETURN;
    END IF;
    UPDATE public.event_handler_receipts r SET
      worker_id = p_worker, attempt = r.attempt + 1,
      claim_generation = r.claim_generation + 1, claim_token = gen_random_uuid(),
      status = 'processing', lease_expires_at = receipt_expiry,
      started_at = p_now, completed_at = NULL, updated_at = p_now
    WHERE r.handler_name = source_handler AND r.event_id = source_event
    RETURNING * INTO receipt;
  END IF;
  RETURN QUERY SELECT 'acquired'::text, receipt.account_id, receipt.attempt,
    receipt.claim_generation, receipt.claim_token, receipt.lease_expires_at,
    receipt.event_id, receipt.handler_name;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_complete_handler_receipt(
  p_handler text, p_event uuid, p_job uuid, p_worker text,
  p_job_attempt integer, p_job_generation integer, p_job_token uuid,
  p_attempt integer, p_generation integer, p_token uuid, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE source public.jobs%ROWTYPE;
BEGIN
  IF p_handler IS NULL OR octet_length(p_handler) NOT BETWEEN 1 AND 128
     OR p_event IS NULL OR p_job IS NULL OR p_worker IS NULL
     OR octet_length(p_worker) NOT BETWEEN 1 AND 128
     OR p_job_attempt IS NULL OR p_job_attempt < 1
     OR p_job_generation IS NULL OR p_job_generation < 1 OR p_job_token IS NULL
     OR p_attempt IS NULL OR p_attempt < 1 OR p_generation IS NULL OR p_generation < 1
     OR p_token IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'SYNTHOLO_HANDLER_RECEIPT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO source FROM public.jobs j
  WHERE j.id = p_job AND j.status = 'running' AND j.worker_id = p_worker
    AND j.attempts = p_job_attempt AND j.claim_generation = p_job_generation
    AND j.claim_token = p_job_token AND j.claimed_at <= p_now
    AND j.lease_expires_at > p_now
  FOR UPDATE;
  IF NOT FOUND OR source.type <> 'foundation.domain_event_handler.v1'
     OR source.payload->>'eventId' IS DISTINCT FROM p_event::text
     OR source.payload->>'handlerName' IS DISTINCT FROM p_handler THEN
    RETURN false;
  END IF;
  UPDATE public.event_handler_receipts SET status = 'completed', completed_at = p_now,
    lease_expires_at = NULL, updated_at = p_now
  WHERE handler_name = p_handler AND event_id = p_event AND job_id = p_job
    AND account_id IS NOT DISTINCT FROM source.account_id AND status = 'processing'
    AND worker_id = p_worker AND attempt = p_attempt
    AND claim_generation = p_generation AND claim_token = p_token
    AND started_at <= p_now AND lease_expires_at > p_now;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.audit_events
    (id, account_id, actor_type, actor_id, action, target_type, target_id,
     correlation_id, payload, occurred_at)
  VALUES (
    gen_random_uuid(), source.account_id, 'system', p_worker,
    'handler_delivery_completed', 'outbox_event', p_event::text,
    source.correlation_id,
    jsonb_build_object(
      'eventId', p_event::text,
      'handlerName', p_handler,
      'outcome', 'completed'
    ),
    p_now
  );
  RETURN true;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_abandon_handler_receipt(
  p_handler text, p_event uuid, p_job uuid, p_worker text,
  p_job_attempt integer, p_job_generation integer, p_job_token uuid,
  p_attempt integer, p_generation integer, p_token uuid, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE source public.jobs%ROWTYPE;
BEGIN
  IF p_handler IS NULL OR octet_length(p_handler) NOT BETWEEN 1 AND 128
     OR p_event IS NULL OR p_job IS NULL OR p_worker IS NULL
     OR octet_length(p_worker) NOT BETWEEN 1 AND 128
     OR p_job_attempt IS NULL OR p_job_attempt < 1
     OR p_job_generation IS NULL OR p_job_generation < 1 OR p_job_token IS NULL
     OR p_attempt IS NULL OR p_attempt < 1 OR p_generation IS NULL OR p_generation < 1
     OR p_token IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'SYNTHOLO_HANDLER_RECEIPT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO source FROM public.jobs j
  WHERE j.id = p_job AND j.status = 'running' AND j.worker_id = p_worker
    AND j.attempts = p_job_attempt AND j.claim_generation = p_job_generation
    AND j.claim_token = p_job_token AND j.claimed_at <= p_now
    AND j.lease_expires_at > p_now
  FOR UPDATE;
  IF NOT FOUND OR source.type <> 'foundation.domain_event_handler.v1'
     OR source.payload->>'eventId' IS DISTINCT FROM p_event::text
     OR source.payload->>'handlerName' IS DISTINCT FROM p_handler THEN
    RETURN false;
  END IF;
  UPDATE public.event_handler_receipts SET status = 'retryable',
    lease_expires_at = NULL, updated_at = GREATEST(p_now, started_at)
  WHERE handler_name = p_handler AND event_id = p_event AND job_id = p_job
    AND status = 'processing' AND worker_id = p_worker AND attempt = p_attempt
    AND claim_generation = p_generation AND claim_token = p_token
    AND started_at <= p_now AND lease_expires_at > p_now;
  RETURN FOUND;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_quarantine_job_payload(
  p_job uuid, p_worker text, p_attempt integer, p_generation integer, p_token uuid,
  p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_job IS NULL OR p_worker IS NULL OR p_attempt IS NULL OR p_generation IS NULL
     OR p_token IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'SYNTHOLO_JOB_TRANSITION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE public.jobs SET payload = '{}'::jsonb,
    status = 'dead_letter', completed_at = p_now,
    lease_expires_at = NULL, claim_token = NULL,
    last_error_code = 'JOB_INPUT_INVALID', last_error_message = 'Job input invalid',
    updated_at = p_now
  WHERE id = p_job AND status = 'running' AND worker_id = p_worker
    AND attempts = p_attempt AND claim_generation = p_generation AND claim_token = p_token
    AND claimed_at <= p_now AND lease_expires_at > p_now;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.job_attempts SET outcome = 'dead_letter', finished_at = p_now,
    error_code = 'JOB_INPUT_INVALID', error_message = 'Job input invalid'
  WHERE job_id = p_job AND attempt = p_attempt AND claim_generation = p_generation
    AND claim_token = p_token AND outcome = 'running';
  IF NOT FOUND THEN RAISE EXCEPTION 'SYNTHOLO_JOB_ATTEMPT_TRANSITION_FAILED'; END IF;
  RETURN FOUND;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_enqueue_outbox_once(
  p_event uuid, p_account uuid, p_actor_type text, p_actor_id text,
  p_correlation uuid, p_type text, p_aggregate text, p_occurred timestamptz,
  p_payload jsonb)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE existing public.outbox_events%ROWTYPE;
DECLARE expected_kind text := current_setting('app.actor_kind', true);
DECLARE expected_actor text := current_setting('app.actor_id', true);
DECLARE expected_account uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
DECLARE expected_correlation uuid := NULLIF(current_setting('app.correlation_id', true), '')::uuid;
DECLARE member_session boolean := pg_has_role(session_user, 'syntholo_member_api', 'USAGE');
DECLARE staff_session boolean := pg_has_role(session_user, 'syntholo_staff_api', 'USAGE');
BEGIN
  IF expected_kind IS NULL OR expected_kind NOT IN ('member', 'staff')
     OR expected_actor IS NULL OR expected_actor = ''
     OR expected_correlation IS NULL
     OR (member_session = staff_session)
     OR (member_session AND expected_kind <> 'member')
     OR (staff_session AND expected_kind <> 'staff')
     OR (expected_kind = 'member' AND expected_account IS NULL)
     OR p_event IS NULL OR p_actor_type IS NULL OR p_actor_id IS NULL
     OR p_correlation IS NULL OR p_type IS NULL OR p_aggregate IS NULL
     OR p_occurred IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR octet_length(p_actor_id) NOT BETWEEN 1 AND 255
     OR octet_length(p_type) NOT BETWEEN 1 AND 255
     OR octet_length(p_aggregate) NOT BETWEEN 1 AND 255
     OR octet_length(p_payload::text) > 65536
     OR p_actor_type IS DISTINCT FROM expected_kind
     OR p_actor_id IS DISTINCT FROM expected_actor
     OR p_account IS DISTINCT FROM expected_account
     OR p_correlation IS DISTINCT FROM expected_correlation THEN
    RAISE EXCEPTION 'SYNTHOLO_OUTBOX_CONTEXT_INVALID' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.outbox_events
    (event_id, account_id, actor_type, actor_id, correlation_id, type,
     aggregate_id, occurred_at, payload, available_at)
  VALUES (p_event, p_account, p_actor_type, p_actor_id, p_correlation, p_type,
    p_aggregate, p_occurred, p_payload, p_occurred)
  ON CONFLICT (event_id) DO NOTHING;
  IF FOUND THEN RETURN 'inserted'; END IF;
  SELECT * INTO existing FROM public.outbox_events WHERE event_id = p_event;
  IF existing.account_id IS NOT DISTINCT FROM p_account
     AND existing.actor_type = p_actor_type AND existing.actor_id = p_actor_id
     AND existing.correlation_id = p_correlation AND existing.type = p_type
     AND existing.aggregate_id = p_aggregate AND existing.occurred_at = p_occurred
     AND existing.payload = p_payload AND existing.schema_version = 1 THEN
    RETURN 'existing';
  END IF;
  RAISE EXCEPTION 'SYNTHOLO_OUTBOX_EVENT_CONFLICT' USING ERRCODE = '23505';
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_claim_jobs(integer,text,timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.syntholo_complete_job(uuid,text,integer,integer,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.syntholo_extend_job_lease(uuid,text,integer,integer,uuid,timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.syntholo_fail_job(uuid,text,integer,integer,uuid,timestamptz,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.syntholo_claim_outbox(integer,text,timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.syntholo_dispatch_outbox(uuid,text,integer,integer,uuid,timestamptz,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.syntholo_fail_outbox(uuid,text,integer,integer,uuid,timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.syntholo_acquire_handler_receipt(uuid,text,integer,integer,uuid,timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.syntholo_complete_handler_receipt(text,uuid,uuid,text,integer,integer,uuid,integer,integer,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.syntholo_abandon_handler_receipt(text,uuid,uuid,text,integer,integer,uuid,integer,integer,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.syntholo_quarantine_job_payload(uuid,text,integer,integer,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.syntholo_enqueue_outbox_once(uuid,uuid,text,text,uuid,text,text,timestamptz,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_claim_jobs(integer,text,timestamptz,integer) TO syntholo_worker, syntholo_migrator;
GRANT EXECUTE ON FUNCTION public.syntholo_complete_job(uuid,text,integer,integer,uuid,timestamptz) TO syntholo_worker, syntholo_migrator;
GRANT EXECUTE ON FUNCTION public.syntholo_extend_job_lease(uuid,text,integer,integer,uuid,timestamptz,integer) TO syntholo_worker, syntholo_migrator;
GRANT EXECUTE ON FUNCTION public.syntholo_fail_job(uuid,text,integer,integer,uuid,timestamptz,text,text,timestamptz) TO syntholo_worker, syntholo_migrator;
GRANT EXECUTE ON FUNCTION public.syntholo_claim_outbox(integer,text,timestamptz,integer) TO syntholo_worker, syntholo_migrator;
GRANT EXECUTE ON FUNCTION public.syntholo_dispatch_outbox(uuid,text,integer,integer,uuid,timestamptz,text[]) TO syntholo_worker, syntholo_migrator;
GRANT EXECUTE ON FUNCTION public.syntholo_fail_outbox(uuid,text,integer,integer,uuid,timestamptz,timestamptz) TO syntholo_worker, syntholo_migrator;
GRANT EXECUTE ON FUNCTION public.syntholo_acquire_handler_receipt(uuid,text,integer,integer,uuid,timestamptz,integer) TO syntholo_worker, syntholo_migrator;
GRANT EXECUTE ON FUNCTION public.syntholo_complete_handler_receipt(text,uuid,uuid,text,integer,integer,uuid,integer,integer,uuid,timestamptz) TO syntholo_worker, syntholo_migrator;
GRANT EXECUTE ON FUNCTION public.syntholo_abandon_handler_receipt(text,uuid,uuid,text,integer,integer,uuid,integer,integer,uuid,timestamptz) TO syntholo_worker, syntholo_migrator;
GRANT EXECUTE ON FUNCTION public.syntholo_quarantine_job_payload(uuid,text,integer,integer,uuid,timestamptz) TO syntholo_worker, syntholo_migrator;
GRANT EXECUTE ON FUNCTION public.syntholo_enqueue_outbox_once(uuid,uuid,text,text,uuid,text,text,timestamptz,jsonb) TO syntholo_member_api, syntholo_staff_api;
--> statement-breakpoint
CREATE TRIGGER job_attempts_account_id_immutable
  BEFORE UPDATE OF account_id ON job_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_account_id_update();
--> statement-breakpoint
CREATE TRIGGER event_handler_receipts_account_id_immutable
  BEFORE UPDATE OF account_id ON event_handler_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_account_id_update();
--> statement-breakpoint
ALTER TABLE job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE event_handler_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_handler_receipts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY job_attempts_staff_read ON job_attempts
  FOR SELECT TO syntholo_staff_api USING (true);
CREATE POLICY job_attempts_worker_read ON job_attempts
  FOR SELECT TO syntholo_worker USING (true);
CREATE POLICY job_attempts_migrator_admin ON job_attempts
  FOR ALL TO syntholo_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY event_handler_receipts_staff_read ON event_handler_receipts
  FOR SELECT TO syntholo_staff_api USING (true);
CREATE POLICY event_handler_receipts_worker_read ON event_handler_receipts
  FOR SELECT TO syntholo_worker USING (true);
CREATE POLICY event_handler_receipts_migrator_admin ON event_handler_receipts
  FOR ALL TO syntholo_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
DROP POLICY outbox_events_worker_update ON outbox_events;
DROP POLICY jobs_worker_update ON jobs;
DROP POLICY outbox_events_worker_insert ON outbox_events;
DROP POLICY jobs_worker_insert ON jobs;
DROP POLICY audit_events_worker_insert ON audit_events;
DROP POLICY audit_events_worker_read ON audit_events;
DROP POLICY outbox_events_worker_read ON outbox_events;
DROP POLICY jobs_worker_read ON jobs;
DROP POLICY job_attempts_worker_read ON job_attempts;
DROP POLICY event_handler_receipts_worker_read ON event_handler_receipts;
CREATE POLICY audit_events_member_insert ON audit_events
  FOR INSERT TO syntholo_member_api
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND actor_type = 'member'
    AND actor_id = current_setting('app.actor_id', true)
    AND correlation_id = NULLIF(current_setting('app.correlation_id', true), '')::uuid
  );
CREATE POLICY outbox_events_member_insert ON outbox_events
  FOR INSERT TO syntholo_member_api
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND actor_type = 'member'
    AND actor_id = current_setting('app.actor_id', true)
    AND correlation_id = NULLIF(current_setting('app.correlation_id', true), '')::uuid
    AND status = 'pending' AND attempts = 0 AND claim_generation = 0
    AND worker_id IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL
    AND claim_token IS NULL AND published_at IS NULL AND dead_lettered_at IS NULL
    AND last_error_code IS NULL AND last_error_message IS NULL
  );
CREATE POLICY audit_events_staff_insert ON audit_events
  FOR INSERT TO syntholo_staff_api WITH CHECK (
    actor_type = 'staff' AND actor_id = current_setting('app.actor_id', true)
    AND correlation_id = NULLIF(current_setting('app.correlation_id', true), '')::uuid
  );
CREATE POLICY outbox_events_staff_insert ON outbox_events
  FOR INSERT TO syntholo_staff_api WITH CHECK (
    actor_type = 'staff' AND actor_id = current_setting('app.actor_id', true)
    AND correlation_id = NULLIF(current_setting('app.correlation_id', true), '')::uuid
    AND status = 'pending' AND attempts = 0 AND claim_generation = 0
    AND worker_id IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL
    AND claim_token IS NULL AND published_at IS NULL AND dead_lettered_at IS NULL
    AND last_error_code IS NULL AND last_error_message IS NULL
  );
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE job_attempts, event_handler_receipts FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_events FROM
  PUBLIC, syntholo_migrator, syntholo_member_api, syntholo_staff_api, syntholo_worker;
REVOKE UPDATE ON TABLE jobs, outbox_events FROM syntholo_worker;
REVOKE INSERT ON TABLE audit_events, outbox_events, jobs FROM syntholo_worker;
REVOKE SELECT ON TABLE audit_events, outbox_events, jobs, job_attempts,
  event_handler_receipts FROM syntholo_worker;
REVOKE INSERT, UPDATE ON TABLE job_attempts, event_handler_receipts FROM syntholo_worker;
GRANT ALL PRIVILEGES ON TABLE job_attempts, event_handler_receipts TO syntholo_migrator;
GRANT INSERT ON TABLE audit_events, outbox_events TO syntholo_member_api;
GRANT INSERT ON TABLE audit_events, outbox_events TO syntholo_staff_api;
GRANT SELECT ON TABLE job_attempts, event_handler_receipts TO syntholo_staff_api;
GRANT EXECUTE ON FUNCTION public.prevent_audit_mutation() TO syntholo_migrator;
