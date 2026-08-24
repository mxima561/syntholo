export type SupportThreadSummary = {
  id: string;
  userId: string;
  studentName: string;
  studentEmail: string;
  subject: string;
  category: "course" | "workflow" | "artifact_review" | "tool_selection";
  status: "new" | "assigned" | "waiting_on_coach" | "waiting_on_customer" | "resolved" | "closed";
  coachName: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  lastMessage: string;
};

export type SupportMessageRecord = {
  id: string;
  authorId: string | null;
  authorName: string;
  authorRole: "coach" | "customer";
  body: string;
  createdAt: Date;
};

async function db() {
  const { getReadyDb } = await import("@/lib/db/client");
  return getReadyDb();
}

/** Creates the coach welcome thread for a brand-new student. Idempotent. */
export async function ensureWelcomeThread(userId: string, firstName: string) {
  const database = await db();
  const [existing] = await database`SELECT id FROM support_threads WHERE user_id = ${userId} LIMIT 1`;
  if (existing) return;

  const [thread] = await database`
    INSERT INTO support_threads (user_id, subject, category, status)
    VALUES (${userId}, ${`Welcome to Syntholo${firstName ? `, ${firstName}` : ""}`}, 'course', 'waiting_on_customer')
    RETURNING id
  `;
  await database`
    INSERT INTO support_messages (thread_id, author_id, author_name, author_role, body)
    VALUES (${thread.id}, NULL, 'Naomi Reed', 'coach',
      ${"Welcome! I am your implementation coach. Use this inbox any time you want a second opinion on a lesson action, your AI policy, or a workflow before you launch it. I reply within two U.S. business days."})
  `;
}

function mapSummary(row: Record<string, unknown>): SupportThreadSummary {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    studentName: String(row.studentName ?? ""),
    studentEmail: String(row.studentEmail ?? ""),
    subject: String(row.subject),
    category: row.category as SupportThreadSummary["category"],
    status: row.status as SupportThreadSummary["status"],
    coachName: String(row.coach_name),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    messageCount: Number(row.message_count),
    lastMessage: String(row.last_message ?? ""),
  };
}

const threadSelect = `
  SELECT t.*, u.first_name || ' ' || u.last_name AS "studentName", u.email AS "studentEmail",
    (SELECT COUNT(*)::int FROM support_messages m WHERE m.thread_id = t.id) AS message_count,
    (SELECT m.body FROM support_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
  FROM support_threads t JOIN app_users u ON u.id = t.user_id
`;

export async function listThreadsForUser(userId: string): Promise<SupportThreadSummary[]> {
  const database = await db();
  const rows = await database.unsafe(`${threadSelect} WHERE t.user_id = $1 ORDER BY t.updated_at DESC`, [userId]);
  return rows.map(mapSummary);
}

export async function listAllThreads(): Promise<SupportThreadSummary[]> {
  const database = await db();
  const rows = await database.unsafe(`${threadSelect} ORDER BY
    CASE WHEN t.status IN ('new', 'waiting_on_coach') THEN 0 ELSE 1 END, t.updated_at DESC`);
  return rows.map(mapSummary);
}

export function assertOwnedThread(thread: { userId: string } | null | undefined, userId: string) {
  if (!thread || thread.userId !== userId) {
    const error = new Error("Support thread not found");
    error.name = "SupportThreadNotFound";
    throw error;
  }
}

export async function getThreadMessages(threadId: string, ownerUserId?: string): Promise<SupportMessageRecord[]> {
  const database = await db();
  if (ownerUserId) {
    const [thread] = await database`SELECT user_id FROM support_threads WHERE id = ${threadId}`;
    assertOwnedThread(thread ? { userId: String(thread.user_id) } : null, ownerUserId);
  }
  const rows = await database`
    SELECT id, author_id AS "authorId", author_name AS "authorName", author_role AS "authorRole", body, created_at AS "createdAt"
    FROM support_messages WHERE thread_id = ${threadId} ORDER BY created_at
  `;
  return rows.map((row) => ({
    id: String(row.id),
    authorId: row.authorId ? String(row.authorId) : null,
    authorName: String(row.authorName),
    authorRole: row.authorRole as "coach" | "customer",
    body: String(row.body),
    createdAt: new Date(row.createdAt as string),
  }));
}

export async function createSupportThread(input: {
  userId: string;
  subject: string;
  category?: SupportThreadSummary["category"];
  firstMessage: string;
  authorName: string;
}) {
  const database = await db();
  const [thread] = await database`
    INSERT INTO support_threads (user_id, subject, category, status)
    VALUES (${input.userId}, ${input.subject}, ${input.category ?? "course"}, 'waiting_on_coach')
    RETURNING id
  `;
  await database`
    INSERT INTO support_messages (thread_id, author_id, author_name, author_role, body)
    VALUES (${thread.id}, ${input.userId}, ${input.authorName}, 'customer', ${input.firstMessage})
  `;
  return String(thread.id);
}

async function insertAndTouch(input: {
  threadId: string;
  authorId: string | null;
  authorName: string;
  authorRole: "coach" | "customer";
  body: string;
  nextStatus: SupportThreadSummary["status"];
}) {
  const database = await db();
  await database`
    INSERT INTO support_messages (thread_id, author_id, author_name, author_role, body)
    VALUES (${input.threadId}, ${input.authorId}, ${input.authorName}, ${input.authorRole}, ${input.body})
  `;
  await database`
    UPDATE support_threads SET status = ${input.nextStatus}, updated_at = now() WHERE id = ${input.threadId}
  `;
}

export async function addCustomerReply(input: { threadId: string; userId: string; authorName: string; body: string }) {
  const database = await db();
  const [thread] = await database`SELECT user_id FROM support_threads WHERE id = ${input.threadId}`;
  assertOwnedThread(thread ? { userId: String(thread.user_id) } : null, input.userId);
  await insertAndTouch({
    threadId: input.threadId,
    authorId: input.userId,
    authorName: input.authorName,
    authorRole: "customer",
    body: input.body,
    nextStatus: "waiting_on_coach",
  });
}

export async function addCoachReply(input: { threadId: string; coachName: string; body: string }) {
  await insertAndTouch({
    threadId: input.threadId,
    authorId: null,
    authorName: input.coachName,
    authorRole: "coach",
    body: input.body,
    nextStatus: "waiting_on_customer",
  });
}

export async function updateThreadStatus(threadId: string, status: SupportThreadSummary["status"]) {
  const database = await db();
  await database`UPDATE support_threads SET status = ${status}, updated_at = now() WHERE id = ${threadId}`;
}
