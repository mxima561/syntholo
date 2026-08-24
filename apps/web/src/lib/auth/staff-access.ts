import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createServerStaffApiClient } from "@/lib/api/client";
import { parseWebApiConfig } from "@/lib/api/config";

const StaffActorSchema = z.object({
  kind: z.literal("staff"),
  actorId: z.string().min(1),
  accessUserId: z.string().min(1),
  staffId: z.string().min(1),
  role: z.enum(["coach", "admin"]),
  permissions: z.array(z.string()),
  authenticatedAt: z.string().min(1),
}).strict();

type CookieStore = Readonly<{
  getAll(name: string): readonly { value: string }[];
}>;

export type AdminAccessResolution =
  | "authorized"
  | "unauthenticated"
  | "forbidden"
  | "unavailable";

export async function resolveProductionAdminAccess(input: Readonly<{
  apiUpstreamOrigin: string;
  cookieName: string;
  cookieStore: CookieStore;
  fetch?: typeof fetch;
}>): Promise<AdminAccessResolution> {
  let cookieValues: readonly { value: string }[];
  try {
    cookieValues = input.cookieStore.getAll(input.cookieName);
  } catch {
    return "unavailable";
  }
  if (
    cookieValues.length !== 1
    || !/^[A-Za-z0-9_-]{43}$/u.test(cookieValues[0]?.value ?? "")
  ) {
    return "unauthenticated";
  }
  try {
    const request = createServerStaffApiClient({
      apiUpstreamOrigin: input.apiUpstreamOrigin,
      cookieName: input.cookieName,
      fetch: input.fetch,
    });
    const response = await request("/v1/staff/whoami", input.cookieStore);
    if (response.status === 401) return "unauthenticated";
    if (response.status === 403) return "forbidden";
    if (!response.ok) return "unavailable";
    const actor = StaffActorSchema.safeParse(await response.json());
    if (!actor.success) return "unavailable";
    return actor.data.role === "admin" ? "authorized" : "forbidden";
  } catch {
    return "unavailable";
  }
}

const productionAdminAccess = cache(async (): Promise<AdminAccessResolution> => {
  try {
    const config = parseWebApiConfig(process.env);
    return resolveProductionAdminAccess({
      apiUpstreamOrigin: config.apiUpstreamOrigin,
      cookieName: config.staffCookieName,
      cookieStore: await cookies(),
    });
  } catch {
    return "unavailable";
  }
});

export async function requireAdminAccess(): Promise<
  "authorized" | "forbidden" | "unavailable"
> {
  const resolution = await productionAdminAccess();
  if (resolution === "unauthenticated") {
    redirect("/v1/staff/auth/sign-in?returnTo=%2Fadmin");
  }
  return resolution;
}
