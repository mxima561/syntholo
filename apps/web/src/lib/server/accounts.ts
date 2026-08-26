import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { cache } from "react";
import {
  ensureAccountForUser,
  ensureDemoAcademyGrants,
  ensureStudentWorkspace,
  listMembershipsForUser,
  loadEffectiveAccess,
  publicIdFromUuid,
  recordIdentityMigration,
  setActiveAccount,
  withSystemScope,
  type MembershipRole,
} from "@syntholo/db";
import type { EffectiveAccess } from "@syntholo/domain";
import { isNeonAuthConfigured } from "@syntholo/auth/config";
import { getNeonAuthUser } from "@syntholo/auth/server";
import { getReadyDb } from "@/lib/db/client";
import { asAcademyUnavailable, isAcademyUnavailableError } from "@/lib/db/unavailable";

export type AccountRole = "student";
export type { MembershipRole };

export type Account = {
  id: string;
  neonUserId: string | null;
  accountId: string;
  membershipId: string;
  membershipRole: MembershipRole;
  memberships: Array<{ accountId: string; membershipId: string; role: MembershipRole; name: string }>;
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

export function canUseDemoStudent(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const mode = process.env.APP_MODE?.trim() || "demo";
  return !isNeonAuthConfigured() && mode === "demo";
}

export function initialsFor(firstName: string, lastName: string): string {
  const first = firstName.trim()[0] ?? "";
  const last = lastName.trim()[0] ?? "";
  const fallback = `${first}${last}`.toUpperCase();
  return fallback || "S";
}

async function toAccount(row: Record<string, unknown>): Promise<Account> {
  const id = String(row.id);
  const membership = await withSystemScope((db) => ensureAccountForUser(id, {}, db));
  const memberships = await withSystemScope(async (db) => {
    const rows = await listMembershipsForUser(id, db);
    if (rows.length === 0) return [];
    const ids = rows.map((item) => item.accountId);
    const names = await db`SELECT id, name FROM accounts WHERE id IN ${db(ids)}`;
    const nameById = new Map(names.map((item) => [String(item.id), String(item.name ?? "Academy account")]));
    return rows.map((item) => ({
      accountId: item.accountId,
      membershipId: item.id,
      role: item.role,
      name: nameById.get(item.accountId) ?? "Academy account",
    }));
  });
  return {
    id,
    neonUserId: row.neon_user_id ? String(row.neon_user_id) : null,
    accountId: membership.accountId,
    membershipId: membership.id,
    membershipRole: membership.role,
    memberships,
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

export async function upsertAccount(input: {
  neonUserId: string;
  email: string;
  firstName: string;
  lastName: string;
}): Promise<Account> {
  try {
    const db = await getReadyDb();
    const email = input.email.toLowerCase();
    const displayName = `${input.firstName} ${input.lastName}`.trim();

    const [existing] = await db`
      SELECT id, clerk_id, neon_user_id FROM app_users WHERE email = ${email} OR neon_user_id = ${input.neonUserId}
    `;
    const [row] = await db`
      INSERT INTO app_users (neon_user_id, email, first_name, last_name, role, display_name)
      VALUES (${input.neonUserId}, ${email}, ${input.firstName}, ${input.lastName}, 'student', ${displayName})
      ON CONFLICT (email) DO UPDATE SET
        neon_user_id = EXCLUDED.neon_user_id,
        first_name = CASE WHEN app_users.first_name = '' THEN EXCLUDED.first_name ELSE app_users.first_name END,
        last_name = CASE WHEN app_users.last_name = '' THEN EXCLUDED.last_name ELSE app_users.last_name END,
        display_name = CASE WHEN app_users.display_name = '' THEN EXCLUDED.display_name ELSE app_users.display_name END,
        last_seen_at = now(),
        updated_at = now()
      RETURNING id, public_id, email, first_name, last_name, business_name, job_title, timezone, role, neon_user_id, clerk_id
    `;
    if (existing?.clerk_id && input.neonUserId) {
      await recordIdentityMigration({
        clerkId: String(existing.clerk_id),
        neonUserId: input.neonUserId,
        appUserId: String(row.id),
      });
    }
    const account = await toAccount(row);
    if (!row.public_id) {
      await db`UPDATE app_users SET public_id = ${account.publicId} WHERE id = ${account.id} AND public_id IS NULL`;
    }
    await ensureStudentWorkspace({ userId: account.id, displayName: displayName || account.email });
    return account;
  } catch (error) {
    throw asAcademyUnavailable(error);
  }
}

/**
 * Resolves the signed-in Neon Auth visitor against the local profile table.
 * Returns null when nobody is signed in or Neon Auth is not configured yet.
 * Never writes staff/platform_admins rows.
 */
export const getCurrentAccount = cache(async (): Promise<Account | null> => {
  if (!isNeonAuthConfigured()) return null;

  try {
    const user = await getNeonAuthUser();
    if (!user) return null;
    const [firstName, ...rest] = user.name.trim().split(/\s+/);
    return await upsertAccount({
      neonUserId: user.id,
      email: user.email,
      firstName: firstName || "",
      lastName: rest.join(" "),
    });
  } catch (error) {
    if (isAcademyUnavailableError(error)) throw error;
    return null;
  }
});

export async function requireStudentAccount(): Promise<Account> {
  const account = await getCurrentAccount();
  if (account) return account;
  if (canUseDemoStudent()) {
    const { ensureDemoStudent } = await import("@/lib/demo/student");
    try {
      return await ensureDemoStudent();
    } catch (error) {
      throw asAcademyUnavailable(error);
    }
  }
  redirect("/signin");
}

export const getAccountAccess = cache(async (): Promise<{ account: Account; access: EffectiveAccess }> => {
  const account = await requireStudentAccount();
  try {
    if (canUseDemoStudent()) {
      await ensureDemoAcademyGrants(account.accountId, account.id);
    }
    const access = await loadEffectiveAccess(account.accountId);
    return { account, access };
  } catch (error) {
    throw asAcademyUnavailable(error);
  }
});

export async function requireAcademyAccess(): Promise<{ account: Account; access: EffectiveAccess }> {
  const result = await getAccountAccess();
  if (!result.access.capabilities.academy_course) redirect("/pricing");
  return result;
}

export async function requireAcademyAccount(): Promise<Account> {
  const { account } = await requireAcademyAccess();
  return account;
}

export async function switchAcademyAccount(accountId: string): Promise<Account> {
  const account = await requireStudentAccount();
  await setActiveAccount(account.id, accountId);
  const refreshed = await getCurrentAccount();
  return refreshed ?? account;
}

export function avatarHue(accountOrEmail: Account | string): number {
  const seed = typeof accountOrEmail === "string" ? accountOrEmail : accountOrEmail.email;
  return createHash("sha1").update(seed).digest()[0] % 360;
}
