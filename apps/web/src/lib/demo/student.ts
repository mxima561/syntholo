import { ensureDemoAcademyGrants } from "@syntholo/db";
import { upsertAccount, type Account } from "@/lib/server/accounts";

/** Local unsigned-student identity. Not Northstar course fixtures. */
export const DEMO_STUDENT = {
  clerkId: "demo:maria",
  email: "maria@northstar.example",
  firstName: "Maria",
  lastName: "Chen",
} as const;

export async function ensureDemoStudent(): Promise<Account> {
  const account = await upsertAccount(DEMO_STUDENT);
  await ensureDemoAcademyGrants(account.accountId, account.id);
  return account;
}
