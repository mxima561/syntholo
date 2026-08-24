import { createHash } from "node:crypto";
import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { cache } from "react";
import { ensureDemoAcademyGrants, ensureStudentWorkspace, hasActiveCapability, publicIdFromUuid } from "@syntholo/db";
import { getReadyDb } from "@/lib/db/client";

export type AccountRole = "student";

export type Account = {
  id: string;
  publicId: string;
  email: string;
  firstName: string;
  lastName: string;
  businessName: string;
  jobTitle: string;
  timezone: string;
  role: AccountRole;
  initials: string;
};

const DEMO_STUDENT = {
  clerkId: "demo:maria",
  email: "maria@northstar.example",
  firstName: "Maria",
  lastName: "Chen",
} as const;

export function isClerkConfigured(): boolean {
  return Boolean(
    process.env.CLERK_SECRET_KEY?.trim() &&
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim(),
  );
}

export function canUseDemoStudent(): boolean {
  if (process.env.NODE_ENV === "production") return false;
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
  const id = String(row.id);
  return {
    id,
    publicId: row.public_id ? String(row.public_id) : publicIdFromUuid(id, "STU"),
    email: String(row.email),
    firstName: String(row.first_name ?? ""),
    lastName: String(row.last_name ?? ""),
    businessName: String(row.business_name ?? ""),
    jobTitle: String(row.job_title ?? ""),
    timezone: String(row.timezone || "America/New_York"),
    role: "student",
    initials: initialsFor(String(row.first_name ?? ""), String(row.last_name ?? "")),
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
      first_name = CASE WHEN app_users.first_name = '' THEN EXCLUDED.first_name ELSE app_users.first_name END,
      last_name = CASE WHEN app_users.last_name = '' THEN EXCLUDED.last_name ELSE app_users.last_name END,
      last_seen_at = now()
    RETURNING id, public_id, email, first_name, last_name, business_name, job_title, timezone, role
  `;
  const account = toAccount(row);
  if (!row.public_id) {
    await db`UPDATE app_users SET public_id = ${account.publicId} WHERE id = ${account.id} AND public_id IS NULL`;
  }
  const displayName = `${account.firstName} ${account.lastName}`.trim() || account.email;
  await ensureStudentWorkspace({ userId: account.id, displayName });
  return account;
}

async function ensureDemoStudent(): Promise<Account> {
  const account = await upsertAccount(DEMO_STUDENT);
  await ensureDemoAcademyGrants(account.id);
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

/** Signed-in student with an active academy grant. Unpaid members go to pricing. */
export async function requireAcademyAccount(): Promise<Account> {
  const account = await requireStudentAccount();
  if (canUseDemoStudent()) {
    await ensureDemoAcademyGrants(account.id);
    return account;
  }
  if (await hasActiveCapability(account.id, "academy_course")) return account;
  redirect("/pricing");
}

/** Stable color seed for avatars so each account keeps a consistent look. */
export function avatarHue(accountOrEmail: Account | string): number {
  const seed = typeof accountOrEmail === "string" ? accountOrEmail : accountOrEmail.email;
  return createHash("sha1").update(seed).digest()[0] % 360;
}
