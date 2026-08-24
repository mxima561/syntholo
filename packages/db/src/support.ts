import type { DatabaseClient } from "./client";
import { withStaffScope, withUserAccountScope } from "./scope";

export type SupportThreadSummary = {
  id: string;
  userId: string;
  accountId: string;
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

function mapSummary(row: Record<string, unknown>): SupportThreadSummary {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    accountId: String(row.account_id ?? ""),
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

export function assertOwnedThread(thread: { accountId: string } | null | undefined, accountId: string) {
  if (!thread || thread.accountId !== accountId) {
    const error = new Error("Support thread not found");
    error.name = "SupportThreadNotFound";
    throw error;
  }
}

export async function ensureWelcomeThread(userId: string, firstName: string) {
  await withUserAccountScope(userId, async (db, membership) => {
    const [existing] = await db`
      SELECT id FROM support_threads WHERE account_id = ${membership.accountId} LIMIT 1
    `;
    if (existing) return;

    const [thread] = await db`
      INSERT INTO support_threads (account_id, user_id, subject, category, status)
      VALUES (${membership.accountId}, ${userId}, ${`Welcome to Syntholo${firstName ? `, ${firstName}` : ""}`}, 'course', 'waiting_on_customer')
      RETURNING id
    `;
    await db`
      INSERT INTO support_messages (account_id, thread_id, author_id, author_name, author_role, body)
      VALUES (${membership.accountId}, ${thread.id}, NULL, 'Naomi Reed', 'coach',
        ${"Welcome! I am your implementation coach. Use this inbox any time you want a second opinion on a lesson action, your AI policy, or a workflow before you launch it. I reply within two U.S. business days."})
    `;
  });
}

export async function listThreadsForUser(userId: string): Promise<SupportThreadSummary[]> {
  return withUserAccountScope(userId, async (db, membership) => {
    const rows = await db.unsafe(`${threadSelect} WHERE t.account_id = $1 ORDER BY t.updated_at DESC`, [
      membership.accountId,
    ]);
    return rows.map(mapSummary);
  });
}

export async function listAllThreads(): Promise<SupportThreadSummary[]> {
  return withStaffScope(async (db) => {
    const rows = await db.unsafe(`${threadSelect} ORDER BY
      CASE WHEN t.status IN ('new', 'waiting_on_coach') THEN 0 ELSE 1 END, t.updated_at DESC`);
    return rows.map(mapSummary);
  });
}

async function loadMessages(db: DatabaseClient, threadId: string): Promise<SupportMessageRecord[]> {
  const rows = await db`
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

export async function getThreadMessages(threadId: string, ownerUserId?: string): Promise<SupportMessageRecord[]> {
  if (ownerUserId) {
    return withUserAccountScope(ownerUserId, async (db, membership) => {
      const [thread] = await db`SELECT account_id FROM support_threads WHERE id = ${threadId}`;
      assertOwnedThread(thread ? { accountId: String(thread.account_id) } : null, membership.accountId);
      return loadMessages(db, threadId);
    });
  }
  return withStaffScope((db) => loadMessages(db, threadId));
}

export async function createSupportThread(input: {
  userId: string;
  subject: string;
  category?: SupportThreadSummary["category"];
  firstMessage: string;
  authorName: string;
}) {
  return withUserAccountScope(input.userId, async (db, membership) => {
    const [thread] = await db`
      INSERT INTO support_threads (account_id, user_id, subject, category, status)
      VALUES (${membership.accountId}, ${input.userId}, ${input.subject}, ${input.category ?? "course"}, 'waiting_on_coach')
      RETURNING id
    `;
    await db`
      INSERT INTO support_messages (account_id, thread_id, author_id, author_name, author_role, body)
      VALUES (${membership.accountId}, ${thread.id}, ${input.userId}, ${input.authorName}, 'customer', ${input.firstMessage})
    `;
    return String(thread.id);
  });
}

export async function addCustomerReply(input: { threadId: string; userId: string; authorName: string; body: string }) {
  await withUserAccountScope(input.userId, async (db, membership) => {
    const [thread] = await db`SELECT account_id FROM support_threads WHERE id = ${input.threadId}`;
    assertOwnedThread(thread ? { accountId: String(thread.account_id) } : null, membership.accountId);
    await db`
      INSERT INTO support_messages (account_id, thread_id, author_id, author_name, author_role, body)
      VALUES (${membership.accountId}, ${input.threadId}, ${input.userId}, ${input.authorName}, 'customer', ${input.body})
    `;
    await db`
      UPDATE support_threads SET status = 'waiting_on_coach', updated_at = now() WHERE id = ${input.threadId}
    `;
  });
}

export async function addCoachReply(input: { threadId: string; coachName: string; body: string }) {
  await withStaffScope(async (db) => {
    const [thread] = await db`SELECT account_id FROM support_threads WHERE id = ${input.threadId}`;
    if (!thread) return;
    await db`
      INSERT INTO support_messages (account_id, thread_id, author_id, author_name, author_role, body)
      VALUES (${thread.account_id}, ${input.threadId}, NULL, ${input.coachName}, 'coach', ${input.body})
    `;
    await db`
      UPDATE support_threads SET status = 'waiting_on_customer', updated_at = now() WHERE id = ${input.threadId}
    `;
  });
}

export async function updateThreadStatus(threadId: string, status: SupportThreadSummary["status"]) {
  await withStaffScope(async (db) => {
    await db`UPDATE support_threads SET status = ${status}, updated_at = now() WHERE id = ${threadId}`;
  });
}
