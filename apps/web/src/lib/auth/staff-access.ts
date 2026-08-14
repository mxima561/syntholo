import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createServerStaffApiClient } from "@/lib/api/client";
import { parseWebApiConfig } from "@/lib/api/config";
import { isDemoMode } from "@/lib/config/mode";

const StaffActorSchema = z.object({
  kind: z.literal("staff"),
  actorId: z.string().min(1),
  workosUserId: z.string().min(1),
  staffId: z.string().min(1),
  role: z.enum(["coach", "admin"]),
  permissions: z.array(z.string()),
  authenticatedAt: z.string().min(1),
}).strict();

type CookieStore = Readonly<{
  getAll(name: string): readonly { value: string }[];
}>;

export async function resolveProductionAdminAccess(input: Readonly<{
  apiUpstreamOrigin: string;
  cookieName: string;
  cookieStore: CookieStore;
  fetch?: typeof fetch;
}>): Promise<boolean> {
  try {
    const request = createServerStaffApiClient({
      apiUpstreamOrigin: input.apiUpstreamOrigin,
      cookieName: input.cookieName,
      fetch: input.fetch,
    });
    const response = await request("/v1/staff/whoami", input.cookieStore);
    if (!response.ok) return false;
    const actor = StaffActorSchema.safeParse(await response.json());
    return actor.success && actor.data.role === "admin";
  } catch {
    return false;
  }
}

const hasProductionAdminAccess = cache(async (): Promise<boolean> => {
  const config = parseWebApiConfig(process.env);
  return resolveProductionAdminAccess({
    apiUpstreamOrigin: config.apiUpstreamOrigin,
    cookieName: config.staffCookieName,
    cookieStore: await cookies(),
  });
});

export async function requireAdminAccess(): Promise<void> {
  if (isDemoMode()) return;
  if (!(await hasProductionAdminAccess())) {
    redirect("/v1/staff/auth/sign-in?returnTo=%2Fadmin");
  }
}
