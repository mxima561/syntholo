import { getReadyDb } from "./client";
import { writeActivityEvent } from "./activity";
import {
  ARTIFACT_STARTERS,
  DEFAULT_SOFTWARE_CHECKLIST,
  DEFAULT_SOFTWARE_CHECKS,
} from "./catalog";

export type ArtifactKind =
  | "readiness_map"
  | "ai_policy"
  | "workflow_portfolio"
  | "enablement_checklist"
  | "roadmap";

export type ArtifactRecord = {
  id: string;
  userId: string;
  kind: ArtifactKind;
  title: string;
  status: "not_started" | "draft" | "final";
  version: number;
  body: string;
  reviewStatus: "none" | "requested" | "feedback_ready";
  updatedBy: string;
  updatedAt: Date;
};

export type WorkflowEngine = "growth" | "client" | "management";
export type WorkflowStatus = "draft" | "testing" | "live" | "paused";

export type WorkflowRecord = {
  id: string;
  userId: string;
  name: string;
  engine: WorkflowEngine;
  problem: string;
  trigger: string;
  owner: string;
  approvedTools: string[];
  steps: string[];
  humanReviewPoint: string;
  safetyNotes: string;
  baseline: string;
  target: string;
  status: WorkflowStatus;
  launchDate: Date | null;
  updatedAt: Date;
};

export type LiveSessionRecord = {
  id: string;
  title: string;
  description: string;
  region: string;
  hostName: string;
  startsAt: Date;
  endsAt: Date | null;
  status: "scheduled" | "live" | "completed" | "canceled";
  capacity: number;
  joinUrl: string | null;
  recordingUrl: string | null;
  rsvpCount: number;
  reservedByViewer: boolean;
};

export type CourseTemplate = {
  id: string;
  title: string;
  description: string;
  filename: string;
  body: string;
};

export type SoftwareChecklistItem = { id: string; label: string; complete: boolean };

export type SoftwareAccountRecord = {
  id: string;
  userId: string;
  status: "pending_onboarding" | "provisioning" | "active" | "paused" | "canceled";
  checklist: SoftwareChecklistItem[];
  notes: string;
  checks: string[];
  provisioningStartedAt: Date | null;
  provisioningDueAt: Date | null;
  updatedAt: Date;
  studentName?: string;
  studentEmail?: string;
  studentPublicId?: string;
};

export type CommunityComment = {
  id: string;
  postId: string;
  authorId: string | null;
  authorName: string;
  initials: string;
  body: string;
  createdAt: Date;
};

export type CommunityReport = {
  id: string;
  postId: string;
  reporterId: string | null;
  reason: string;
  status: "open" | "reviewed" | "dismissed";
  createdAt: Date;
  postTitle?: string;
};

export type ScorecardSubmission = {
  id: string;
  email: string;
  firstName: string;
  businessName: string;
  country: string;
  overallScore: number;
  band: string;
  createdAt: Date;
};

export type CertificateRecord = {
  id: string;
  userId: string;
  courseId: string;
  issuedAt: Date;
};

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [];
}

function mapArtifact(row: Record<string, unknown>): ArtifactRecord {
  const kind = String(row.kind) as ArtifactKind;
  const status = row.status === "final" || row.status === "draft" ? row.status : "not_started";
  const reviewStatus = row.review_status === "requested" || row.review_status === "feedback_ready" ? row.review_status : "none";
  return {
    id: String(row.id),
    userId: String(row.user_id),
    kind,
    title: String(row.title),
    status,
    version: Number(row.version),
    body: String(row.body ?? ""),
    reviewStatus,
    updatedBy: String(row.updated_by ?? ""),
    updatedAt: new Date(row.updated_at as string | Date),
  };
}

function mapWorkflow(row: Record<string, unknown>): WorkflowRecord {
  const engine = row.engine === "client" || row.engine === "management" ? row.engine : "growth";
  const status =
    row.status === "testing" || row.status === "live" || row.status === "paused" ? row.status : "draft";
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    engine,
    problem: String(row.problem ?? ""),
    trigger: String(row.trigger ?? ""),
    owner: String(row.owner ?? ""),
    approvedTools: asStringArray(row.approved_tools),
    steps: asStringArray(row.steps),
    humanReviewPoint: String(row.human_review_point ?? ""),
    safetyNotes: String(row.safety_notes ?? ""),
    baseline: String(row.baseline ?? ""),
    target: String(row.target ?? ""),
    status,
    launchDate: row.launch_date ? new Date(row.launch_date as string | Date) : null,
    updatedAt: new Date(row.updated_at as string | Date),
  };
}

export async function ensureStudentWorkspace(input: {
  userId: string;
  displayName: string;
}): Promise<void> {
  const db = await getReadyDb();
  const [existing] = await db`SELECT COUNT(*)::int AS count FROM artifacts WHERE user_id = ${input.userId}`;
  if (existing.count === 0) {
    for (const starter of ARTIFACT_STARTERS) {
      await db`
        INSERT INTO artifacts (user_id, kind, title, status, body, updated_by)
        VALUES (${input.userId}, ${starter.kind}, ${starter.title}, 'not_started', ${starter.body}, ${input.displayName})
      `;
    }
  }
  const [workflows] = await db`SELECT COUNT(*)::int AS count FROM workflows WHERE user_id = ${input.userId}`;
  if (workflows.count === 0) {
    const starters: Array<{ name: string; engine: WorkflowEngine }> = [
      { name: "Growth workflow", engine: "growth" },
      { name: "Client workflow", engine: "client" },
      { name: "Management workflow", engine: "management" },
    ];
    for (const starter of starters) {
      await db`
        INSERT INTO workflows (user_id, name, engine, owner, human_review_point)
        VALUES (
          ${input.userId}, ${starter.name}, ${starter.engine}, ${input.displayName},
          ${"Named owner reviews the output before it goes to a client or the team."}
        )
      `;
    }
  }
  const [software] = await db`SELECT id FROM software_accounts WHERE user_id = ${input.userId}`;
  if (!software) {
    await db`
      INSERT INTO software_accounts (user_id, status, checklist_json, checks_json)
      VALUES (
        ${input.userId},
        'pending_onboarding',
        ${JSON.stringify(DEFAULT_SOFTWARE_CHECKLIST)}::jsonb,
        ${JSON.stringify([])}::jsonb
      )
    `;
  }
}

export async function listArtifacts(userId: string): Promise<ArtifactRecord[]> {
  const db = await getReadyDb();
  const rows = await db`SELECT * FROM artifacts WHERE user_id = ${userId} ORDER BY created_at`;
  return rows.map(mapArtifact);
}

export async function saveArtifact(input: {
  artifactId: string;
  userId: string;
  body: string;
  updatedBy: string;
  finalize?: boolean;
  requestReview?: boolean;
}): Promise<ArtifactRecord | null> {
  const db = await getReadyDb();
  const status = input.finalize ? "final" : "draft";
  const reviewStatus = input.requestReview ? "requested" : undefined;
  const [row] = reviewStatus
    ? await db`
        UPDATE artifacts
        SET body = ${input.body}, status = ${status}, version = version + 1,
            review_status = ${reviewStatus}, updated_by = ${input.updatedBy}, updated_at = now()
        WHERE id = ${input.artifactId} AND user_id = ${input.userId}
        RETURNING *
      `
    : await db`
        UPDATE artifacts
        SET body = ${input.body}, status = ${status}, version = version + 1,
            updated_by = ${input.updatedBy}, updated_at = now()
        WHERE id = ${input.artifactId} AND user_id = ${input.userId}
        RETURNING *
      `;
  return row ? mapArtifact(row) : null;
}

export async function listWorkflows(userId: string): Promise<WorkflowRecord[]> {
  const db = await getReadyDb();
  const rows = await db`SELECT * FROM workflows WHERE user_id = ${userId} ORDER BY created_at`;
  return rows.map(mapWorkflow);
}

export async function createWorkflow(input: {
  userId: string;
  name: string;
  engine: WorkflowEngine;
  owner: string;
}): Promise<WorkflowRecord> {
  const db = await getReadyDb();
  const [row] = await db`
    INSERT INTO workflows (user_id, name, engine, owner)
    VALUES (${input.userId}, ${input.name}, ${input.engine}, ${input.owner})
    RETURNING *
  `;
  return mapWorkflow(row);
}

export async function updateWorkflow(input: {
  workflowId: string;
  userId: string;
  name: string;
  problem: string;
  owner: string;
  humanReviewPoint: string;
  baseline: string;
  target: string;
  approvedTools: string;
}): Promise<WorkflowRecord | null> {
  const db = await getReadyDb();
  const tools = input.approvedTools.split(",").map((item) => item.trim()).filter(Boolean);
  const [row] = await db`
    UPDATE workflows SET
      name = ${input.name},
      problem = ${input.problem},
      owner = ${input.owner},
      human_review_point = ${input.humanReviewPoint},
      baseline = ${input.baseline},
      target = ${input.target},
      approved_tools = ${tools},
      updated_at = now()
    WHERE id = ${input.workflowId} AND user_id = ${input.userId}
    RETURNING *
  `;
  return row ? mapWorkflow(row) : null;
}

export async function setWorkflowStatus(input: {
  workflowId: string;
  userId: string;
  status: WorkflowStatus;
}): Promise<WorkflowRecord | null> {
  const db = await getReadyDb();
  const launchDate = input.status === "live" ? new Date() : null;
  const [row] = await db`
    UPDATE workflows
    SET status = ${input.status}, launch_date = COALESCE(${launchDate}, launch_date), updated_at = now()
    WHERE id = ${input.workflowId} AND user_id = ${input.userId}
    RETURNING *
  `;
  return row ? mapWorkflow(row) : null;
}

export async function listLiveSessions(viewerId?: string | null): Promise<LiveSessionRecord[]> {
  const db = await getReadyDb();
  const rows = viewerId
    ? await db`
        SELECT s.*,
          (SELECT COUNT(*)::int FROM session_rsvps r WHERE r.session_id = s.id) AS rsvp_count,
          EXISTS (SELECT 1 FROM session_rsvps r WHERE r.session_id = s.id AND r.user_id = ${viewerId}) AS reserved
        FROM live_sessions s
        ORDER BY s.starts_at
      `
    : await db`
        SELECT s.*,
          (SELECT COUNT(*)::int FROM session_rsvps r WHERE r.session_id = s.id) AS rsvp_count,
          FALSE AS reserved
        FROM live_sessions s
        ORDER BY s.starts_at
      `;
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    region: String(row.region),
    hostName: String(row.host_name),
    startsAt: new Date(row.starts_at as string | Date),
    endsAt: row.ends_at ? new Date(row.ends_at as string | Date) : null,
    status: String(row.status) as LiveSessionRecord["status"],
    capacity: Number(row.capacity),
    joinUrl: row.join_url ? String(row.join_url) : null,
    recordingUrl: row.recording_url ? String(row.recording_url) : null,
    rsvpCount: Number(row.rsvp_count),
    reservedByViewer: Boolean(row.reserved),
  }));
}

export async function rsvpLiveSession(sessionId: string, userId: string): Promise<boolean> {
  const db = await getReadyDb();
  const inserted = await db`
    INSERT INTO session_rsvps (session_id, user_id)
    VALUES (${sessionId}, ${userId})
    ON CONFLICT DO NOTHING
    RETURNING session_id
  `;
  return inserted.length > 0;
}

export async function createLiveSession(input: {
  title: string;
  description: string;
  region: string;
  hostName: string;
  startsAt: Date;
  endsAt: Date;
  joinUrl?: string;
}): Promise<string> {
  const db = await getReadyDb();
  const [row] = await db`
    INSERT INTO live_sessions (title, description, region, host_name, starts_at, ends_at, join_url, status, capacity)
    VALUES (
      ${input.title}, ${input.description}, ${input.region}, ${input.hostName},
      ${input.startsAt}, ${input.endsAt}, ${input.joinUrl ?? null}, 'scheduled', 100
    )
    RETURNING id
  `;
  return String(row.id);
}

export async function listCourseTemplates(): Promise<CourseTemplate[]> {
  const db = await getReadyDb();
  const rows = await db`SELECT id, title, description, filename, body FROM course_templates ORDER BY title`;
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    filename: String(row.filename),
    body: String(row.body),
  }));
}

export async function getCourseTemplate(id: string): Promise<CourseTemplate | null> {
  const db = await getReadyDb();
  const [row] = await db`SELECT id, title, description, filename, body FROM course_templates WHERE id = ${id}`;
  if (!row) return null;
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    filename: String(row.filename),
    body: String(row.body),
  };
}

export async function getSoftwareAccount(userId: string): Promise<SoftwareAccountRecord | null> {
  const db = await getReadyDb();
  const [row] = await db`SELECT * FROM software_accounts WHERE user_id = ${userId}`;
  return row ? mapSoftware(row) : null;
}

function mapSoftware(row: Record<string, unknown>): SoftwareAccountRecord {
  const status = String(row.status) as SoftwareAccountRecord["status"];
  return {
    id: String(row.id),
    userId: String(row.user_id),
    status,
    checklist: Array.isArray(row.checklist_json) ? (row.checklist_json as SoftwareChecklistItem[]) : [...DEFAULT_SOFTWARE_CHECKLIST],
    notes: String(row.notes ?? ""),
    checks: asStringArray(row.checks_json),
    provisioningStartedAt: row.provisioning_started_at ? new Date(row.provisioning_started_at as string | Date) : null,
    provisioningDueAt: row.provisioning_due_at ? new Date(row.provisioning_due_at as string | Date) : null,
    updatedAt: new Date(row.updated_at as string | Date),
    studentName: row.student_name ? String(row.student_name) : undefined,
    studentEmail: row.student_email ? String(row.student_email) : undefined,
    studentPublicId: row.student_public_id ? String(row.student_public_id) : undefined,
  };
}

export async function listSoftwareAccounts(): Promise<SoftwareAccountRecord[]> {
  const db = await getReadyDb();
  const rows = await db`
    SELECT s.*,
      trim(u.first_name || ' ' || u.last_name) AS student_name,
      u.email AS student_email,
      u.public_id AS student_public_id
    FROM software_accounts s
    JOIN app_users u ON u.id = s.user_id
    ORDER BY s.updated_at DESC
  `;
  return rows.map(mapSoftware);
}

export async function toggleSoftwareChecklist(userId: string, itemId: string): Promise<SoftwareAccountRecord | null> {
  const account = await getSoftwareAccount(userId);
  if (!account) return null;
  const checklist = account.checklist.map((item) =>
    item.id === itemId ? { ...item, complete: !item.complete } : item,
  );
  const db = await getReadyDb();
  const [row] = await db`
    UPDATE software_accounts
    SET checklist_json = ${JSON.stringify(checklist)}::jsonb, updated_at = now()
    WHERE user_id = ${userId}
    RETURNING *
  `;
  return row ? mapSoftware(row) : null;
}

export async function submitSoftwareProvisioning(userId: string): Promise<SoftwareAccountRecord | null> {
  const account = await getSoftwareAccount(userId);
  if (!account) return null;
  const complete = account.checklist.every((item) => item.complete);
  if (!complete) return account;
  const started = new Date();
  const due = new Date(started.getTime() + 5 * 24 * 60 * 60 * 1000);
  const db = await getReadyDb();
  const [row] = await db`
    UPDATE software_accounts
    SET status = 'provisioning', provisioning_started_at = ${started}, provisioning_due_at = ${due}, updated_at = now()
    WHERE user_id = ${userId}
    RETURNING *
  `;
  return row ? mapSoftware(row) : null;
}

export async function saveSoftwareNote(accountId: string, note: string): Promise<void> {
  const db = await getReadyDb();
  await db`
    UPDATE software_accounts
    SET notes = CASE WHEN notes = '' THEN ${note} ELSE notes || E'\n\n' || ${note} END, updated_at = now()
    WHERE id = ${accountId}
  `;
}

export async function toggleSoftwareLaunchCheck(accountId: string, check: string): Promise<SoftwareAccountRecord | null> {
  const db = await getReadyDb();
  const [current] = await db`SELECT * FROM software_accounts WHERE id = ${accountId}`;
  if (!current) return null;
  const existing = asStringArray(current.checks_json);
  const next = existing.includes(check) ? existing.filter((item) => item !== check) : [...existing, check];
  const allPassed = DEFAULT_SOFTWARE_CHECKS.every((item) => next.includes(item));
  const [row] = await db`
    UPDATE software_accounts
    SET checks_json = ${JSON.stringify(next)}::jsonb,
        status = CASE WHEN ${allPassed} THEN 'active' ELSE status END,
        updated_at = now()
    WHERE id = ${accountId}
    RETURNING *
  `;
  return row ? mapSoftware(row) : null;
}

export async function listCommentsForPosts(postIds: string[]): Promise<CommunityComment[]> {
  if (postIds.length === 0) return [];
  const db = await getReadyDb();
  const rows = await db`
    SELECT * FROM community_comments WHERE post_id IN ${db(postIds)} ORDER BY created_at
  `;
  return rows.map((row) => ({
    id: String(row.id),
    postId: String(row.post_id),
    authorId: row.author_id ? String(row.author_id) : null,
    authorName: String(row.author_name),
    initials: String(row.initials ?? ""),
    body: String(row.body),
    createdAt: new Date(row.created_at as string | Date),
  }));
}

export async function addCommunityComment(input: {
  postId: string;
  authorId: string;
  authorName: string;
  initials: string;
  body: string;
}): Promise<CommunityComment> {
  const db = await getReadyDb();
  const [row] = await db`
    INSERT INTO community_comments (post_id, author_id, author_name, initials, body)
    VALUES (${input.postId}, ${input.authorId}, ${input.authorName}, ${input.initials}, ${input.body})
    RETURNING *
  `;
  await db`UPDATE community_posts SET comment_count = comment_count + 1 WHERE id = ${input.postId}`;
  return {
    id: String(row.id),
    postId: String(row.post_id),
    authorId: row.author_id ? String(row.author_id) : null,
    authorName: String(row.author_name),
    initials: String(row.initials ?? ""),
    body: String(row.body),
    createdAt: new Date(row.created_at as string | Date),
  };
}

export async function reportCommunityPost(postId: string, reporterId: string, reason: string): Promise<void> {
  const db = await getReadyDb();
  await db`
    INSERT INTO community_reports (post_id, reporter_id, reason)
    VALUES (${postId}, ${reporterId}, ${reason})
  `;
}

export async function listCommunityReports(): Promise<CommunityReport[]> {
  const db = await getReadyDb();
  const rows = await db`
    SELECT r.*, p.title AS post_title
    FROM community_reports r
    JOIN community_posts p ON p.id = r.post_id
    WHERE r.status = 'open'
    ORDER BY r.created_at DESC
  `;
  return rows.map((row) => ({
    id: String(row.id),
    postId: String(row.post_id),
    reporterId: row.reporter_id ? String(row.reporter_id) : null,
    reason: String(row.reason),
    status: "open",
    createdAt: new Date(row.created_at as string | Date),
    postTitle: String(row.post_title),
  }));
}

export async function listAllCommunityPosts() {
  const db = await getReadyDb();
  return db`SELECT * FROM community_posts ORDER BY created_at DESC LIMIT 100`;
}

export async function setCommunityPostStatus(postId: string, status: "published" | "hidden"): Promise<void> {
  const db = await getReadyDb();
  await db`UPDATE community_posts SET status = ${status} WHERE id = ${postId}`;
}

export async function resolveCommunityReport(reportId: string): Promise<void> {
  const db = await getReadyDb();
  await db`UPDATE community_reports SET status = 'reviewed' WHERE id = ${reportId}`;
}

export async function saveScorecard(input: {
  userId?: string | null;
  email: string;
  firstName: string;
  businessName: string;
  country: string;
  overallScore: number;
  band: string;
  answers: Record<string, number>;
  marketingConsent: boolean;
}): Promise<string> {
  const db = await getReadyDb();
  const [row] = await db`
    INSERT INTO scorecard_submissions (
      user_id, email, first_name, business_name, country, overall_score, band, answers_json, marketing_consent
    )
    VALUES (
      ${input.userId ?? null}, ${input.email.toLowerCase()}, ${input.firstName}, ${input.businessName},
      ${input.country}, ${input.overallScore}, ${input.band}, ${JSON.stringify(input.answers)}::jsonb,
      ${input.marketingConsent}
    )
    RETURNING id
  `;
  await writeActivityEvent({
    actorKind: input.userId ? "student" : "system",
    actorId: input.userId ?? null,
    actorLabel: `${input.firstName} <${input.email}>`,
    action: "scorecard_submitted",
    targetType: "scorecard",
    targetId: String(row.id),
    summary: `${input.firstName} submitted a readiness scorecard (${input.band}, ${input.overallScore})`,
    metadata: { band: input.band, overallScore: input.overallScore, businessName: input.businessName },
  });
  return String(row.id);
}

export async function listScorecards(limit = 50): Promise<ScorecardSubmission[]> {
  const db = await getReadyDb();
  const rows = await db`
    SELECT id, email, first_name, business_name, country, overall_score, band, created_at
    FROM scorecard_submissions ORDER BY created_at DESC LIMIT ${limit}
  `;
  return rows.map((row) => ({
    id: String(row.id),
    email: String(row.email),
    firstName: String(row.first_name),
    businessName: String(row.business_name),
    country: String(row.country),
    overallScore: Number(row.overall_score),
    band: String(row.band),
    createdAt: new Date(row.created_at as string | Date),
  }));
}

export async function issueCertificateIfEligible(userId: string, courseId: string): Promise<CertificateRecord | null> {
  const db = await getReadyDb();
  const [progress] = await db`
    SELECT
      (SELECT COUNT(*)::int FROM lessons WHERE course_id = ${courseId} AND required AND is_published) AS required_count,
      (SELECT COUNT(*)::int FROM lesson_progress lp
        JOIN lessons l ON l.id = lp.lesson_id
        WHERE lp.user_id = ${userId} AND lp.status = 'completed' AND l.course_id = ${courseId} AND l.required) AS completed_count
  `;
  if (!progress || Number(progress.completed_count) < Number(progress.required_count) || Number(progress.required_count) === 0) {
    return null;
  }
  const [row] = await db`
    INSERT INTO certificates (user_id, course_id)
    VALUES (${userId}, ${courseId})
    ON CONFLICT (user_id, course_id) DO UPDATE SET issued_at = certificates.issued_at
    RETURNING id, user_id, course_id, issued_at
  `;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    courseId: String(row.course_id),
    issuedAt: new Date(row.issued_at as string | Date),
  };
}

export async function getCertificate(userId: string, courseId: string): Promise<CertificateRecord | null> {
  const db = await getReadyDb();
  const [row] = await db`
    SELECT id, user_id, course_id, issued_at FROM certificates WHERE user_id = ${userId} AND course_id = ${courseId}
  `;
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    courseId: String(row.course_id),
    issuedAt: new Date(row.issued_at as string | Date),
  };
}

export async function updateStudentProfile(input: {
  userId: string;
  firstName: string;
  lastName: string;
  businessName: string;
  jobTitle: string;
  timezone: string;
}): Promise<void> {
  const db = await getReadyDb();
  await db`
    UPDATE app_users
    SET first_name = ${input.firstName}, last_name = ${input.lastName},
        business_name = ${input.businessName}, job_title = ${input.jobTitle},
        timezone = ${input.timezone}, last_seen_at = now()
    WHERE id = ${input.userId}
  `;
}

export { DEFAULT_SOFTWARE_CHECKS, COURSE_TEMPLATES } from "./catalog";
