import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { cache } from "react";

export type AccountRole = "admin" | "student";

export type Account = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: AccountRole;
  initials: string;
};

export function isWorkosConfigured(): boolean {
  return Boolean(
    process.env.WORKOS_API_KEY?.trim() &&
      process.env.WORKOS_CLIENT_ID?.trim() &&
      process.env.WORKOS_COOKIE_PASSWORD?.trim(),
  );
}

function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function initialsFor(firstName: string, lastName: string): string {
  const first = firstName.trim()[0] ?? "";
  const last = lastName.trim()[0] ?? "";
  const fallback = `${first}${last}`.toUpperCase();
  return fallback || "S";
}

async function upsertAccount(input: {
  workosId: string;
  email: string;
  firstName: string;
  lastName: string;
}): Promise<Account> {
  const { getReadyDb } = await import("@/lib/db/client");
  const db = await getReadyDb();
  const email = input.email.toLowerCase();
  const shouldBeAdmin = adminEmails().has(email);

  const [row] = await db`
    INSERT INTO app_users (workos_id, email, first_name, last_name, role)
    VALUES (${input.workosId}, ${email}, ${input.firstName}, ${input.lastName}, ${shouldBeAdmin ? "admin" : "student"})
    ON CONFLICT (email) DO UPDATE SET
      workos_id = EXCLUDED.workos_id,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      role = CASE WHEN ${shouldBeAdmin} THEN 'admin' ELSE app_users.role END,
      last_seen_at = now()
    RETURNING id, email, first_name, last_name, role
  `;

  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role as AccountRole,
    initials: initialsFor(row.first_name, row.last_name),
  };
}

/**
 * Resolves the signed-in visitor against the local database.
 * Returns null when nobody is signed in or WorkOS is not configured yet.
 */
export const getCurrentAccount = cache(async (): Promise<Account | null> => {
  if (!isWorkosConfigured()) return null;

  let workosUser: {
    id: string;
    email: string | null | undefined;
    firstName: string | null | undefined;
    lastName: string | null | undefined;
  };

  try {
    const { auth } = await import("@workos-inc/authkit-nextjs");
    const authResult = await auth();
    if (!authResult?.user) return null;
    workosUser = authResult.user;
  } catch {
    return null;
  }

  const email = workosUser.email?.trim();
  if (!email) return null;

  try {
    return await upsertAccount({
      workosId: workosUser.id,
      email,
      firstName: workosUser.firstName?.trim() || "",
      lastName: workosUser.lastName?.trim() || "",
    });
  } catch {
    return null;
  }
});

export async function requireStudentAccount(): Promise<Account> {
  const account = await getCurrentAccount();
  if (!account) redirect("/signin");
  return account;
}

export async function requireAdminAccount(): Promise<Account> {
  const account = await getCurrentAccount();
  if (!account) redirect("/signin");
  if (account.role !== "admin") redirect("/learn");
  return account;
}

/** Stable color seed for avatars so each account keeps a consistent look. */
export function avatarHue(accountOrEmail: Account | string): number {
  const seed = typeof accountOrEmail === "string" ? accountOrEmail : accountOrEmail.email;
  return createHash("sha1").update(seed).digest()[0] % 360;
}
