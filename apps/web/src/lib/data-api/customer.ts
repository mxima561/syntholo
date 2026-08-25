import { getNeonAccessToken } from "@syntholo/auth/server";
import { createNeonDataClient, type NeonDataClient } from "@syntholo/auth/neon";
import { isNeonDataApiConfigured } from "@syntholo/auth/config";

/**
 * Customer-facing Data API client bound to the current Neon Auth JWT.
 * Privileged tables are not granted to `authenticated`; those stay on postgres.js.
 */
export async function getCustomerDataClient(): Promise<NeonDataClient | null> {
  if (!isNeonDataApiConfigured()) return null;
  const token = await getNeonAccessToken();
  if (!token) return null;
  return createNeonDataClient(token);
}

export async function dataApiUpdateProfile(input: {
  neonUserId: string;
  firstName: string;
  lastName: string;
  businessName: string;
  jobTitle: string;
  timezone: string;
}): Promise<boolean> {
  const client = await getCustomerDataClient();
  if (!client) return false;
  const { error } = await client
    .from("app_users")
    .update({
      first_name: input.firstName,
      last_name: input.lastName,
      display_name: `${input.firstName} ${input.lastName}`.trim(),
      business_name: input.businessName,
      job_title: input.jobTitle,
      timezone: input.timezone,
    })
    .eq("neon_user_id", input.neonUserId);
  if (error) throw new Error(error.message);
  return true;
}

export async function dataApiSetLessonProgress(input: {
  accountId: string;
  userId: string;
  lessonId: string;
  complete: boolean;
}): Promise<boolean> {
  const client = await getCustomerDataClient();
  if (!client) return false;
  const payload = {
    account_id: input.accountId,
    user_id: input.userId,
    lesson_id: input.lessonId,
    status: input.complete ? "completed" : "not_started",
    completed_at: input.complete ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await client.from("lesson_progress").upsert(payload);
  if (error) throw new Error(error.message);
  return true;
}

export async function dataApiListMemberships(neonUserId: string) {
  const client = await getCustomerDataClient();
  if (!client) return null;
  const { data, error } = await client
    .from("app_users")
    .select("id, memberships:memberships(id, account_id, role, status, accounts:accounts(id, name, slug))")
    .eq("neon_user_id", neonUserId)
    .eq("memberships.status", "active");
  if (error) throw new Error(error.message);
  return data;
}
