import { createHash } from "node:crypto";
import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getReadyDb } from "@/lib/db/client";
import {
  ensureEnrollment,
  getCompletedLessonIds,
  getPrimaryCourse,
  setLessonProgress,
} from "@/lib/server/courses";

export type AccountRole = "student";

export type Account = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: AccountRole;
  initials: string;
};

const DEMO_STUDENT = {
  clerkId: "demo:maria",
  email: "maria@northstar.example",
  firstName: "Maria",
  lastName: "Chen",
} as const;

const DEMO_COMPLETED_LESSON_IDS = [
  "diagnose-1",
  "diagnose-2",
  "diagnose-3",
  "rules-1",
  "rules-2",
  "rules-3",
  "growth-1",
] as const;

export function isClerkConfigured(): boolean {
  return Boolean(
    process.env.CLERK_SECRET_KEY?.trim() &&
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim(),
  );
}

export function canUseDemoStudent(): boolean {
  const mode = process.env.APP_MODE?.trim() || "demo";
  return !isClerkConfigured() && mode === "demo";
}

export function initialsFor(firstName: string, lastName: string): string {
  const first = firstName.trim()[0] ?? "";
  const last = lastName.trim()[0] ?? "";
  const fallback = `${first}${last}`.toUpperCase();
  return fallback || "S";
}

function toAccount(row: Record<string, unknown>): Account {
  return {
    id: String(row.id),
    email: String(row.email),
    firstName: String(row.first_name),
    lastName: String(row.last_name),
    role: "student",
    initials: initialsFor(String(row.first_name), String(row.last_name)),
  };
}

async function upsertAccount(input: {
  clerkId: string;
  email: string;
  firstName: string;
  lastName: string;
}): Promise<Account> {
  const db = await getReadyDb();
  const email = input.email.toLowerCase();

  const [row] = await db`
    INSERT INTO app_users (clerk_id, email, first_name, last_name, role)
    VALUES (${input.clerkId}, ${email}, ${input.firstName}, ${input.lastName}, 'student')
    ON CONFLICT (email) DO UPDATE SET
      clerk_id = EXCLUDED.clerk_id,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      last_seen_at = now()
    RETURNING id, email, first_name, last_name, role
  `;

  return toAccount(row);
}

async function seedDemoProgress(userId: string) {
  const course = await getPrimaryCourse();
  if (!course) return;
  await ensureEnrollment(userId, course.id);
  const completed = await getCompletedLessonIds(userId);
  if (completed.length > 0) return;
  for (const lessonId of DEMO_COMPLETED_LESSON_IDS) {
    await setLessonProgress(userId, lessonId, true);
  }
}

async function ensureDemoStudent(): Promise<Account> {
  const account = await upsertAccount(DEMO_STUDENT);
  await seedDemoProgress(account.id);
  return account;
}

/**
 * Resolves the signed-in Clerk visitor against the local database.
 * Returns null when nobody is signed in or Clerk is not configured yet.
 * Never writes staff rows and never persists student PII to Clerk metadata.
 */
export const getCurrentAccount = cache(async (): Promise<Account | null> => {
  if (!isClerkConfigured()) return null;

  try {
    const user = await currentUser();
    if (!user) return null;

    const email = user.primaryEmailAddress?.emailAddress?.trim();
    if (!email) return null;

    return await upsertAccount({
      clerkId: user.id,
      email,
      firstName: user.firstName?.trim() || "",
      lastName: user.lastName?.trim() || "",
    });
  } catch {
    return null;
  }
});

export async function requireStudentAccount(): Promise<Account> {
  const account = await getCurrentAccount();
  if (account) return account;
  if (canUseDemoStudent()) {
    try {
      return await ensureDemoStudent();
    } catch {
      redirect("/signin");
    }
  }
  redirect("/signin");
}

/** Stable color seed for avatars so each account keeps a consistent look. */
export function avatarHue(accountOrEmail: Account | string): number {
  const seed = typeof accountOrEmail === "string" ? accountOrEmail : accountOrEmail.email;
  return createHash("sha1").update(seed).digest()[0] % 360;
}
