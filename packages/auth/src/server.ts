import { createNeonAuth } from "@neondatabase/auth/next/server";
import { isNeonAuthConfigured, neonAuthBaseUrl, neonAuthCookieSecret } from "./config";

export type NeonAuthUser = {
  id: string;
  email: string;
  name: string;
};

type NeonAuthInstance = ReturnType<typeof createNeonAuth>;

let authInstance: NeonAuthInstance | null | undefined;

export function getNeonAuth(): NeonAuthInstance | null {
  if (!isNeonAuthConfigured()) return null;
  if (authInstance) return authInstance;
  authInstance = createNeonAuth({
    baseUrl: neonAuthBaseUrl(),
    cookies: {
      secret: neonAuthCookieSecret(),
    },
  });
  return authInstance;
}

function readEmail(user: Record<string, unknown>): string {
  const direct = user.email;
  if (typeof direct === "string" && direct.trim()) return direct.trim().toLowerCase();
  const nested = user.emailAddress ?? user.primaryEmail;
  if (typeof nested === "string" && nested.trim()) return nested.trim().toLowerCase();
  return "";
}

export function extractAccessToken(session: unknown): string | null {
  if (!session || typeof session !== "object") return null;
  const root = session as Record<string, unknown>;
  const nested = root.session;
  const bags = [root, nested && typeof nested === "object" ? (nested as Record<string, unknown>) : null];
  for (const bag of bags) {
    if (!bag) continue;
    for (const key of ["token", "accessToken", "access_token"]) {
      const value = bag[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    const tokenSet = bag.tokenSet;
    if (tokenSet && typeof tokenSet === "object") {
      const access = (tokenSet as Record<string, unknown>).accessToken ?? (tokenSet as Record<string, unknown>).access_token;
      if (typeof access === "string" && access.trim()) return access.trim();
    }
  }
  return null;
}

export async function getNeonAuthUser(): Promise<NeonAuthUser | null> {
  const auth = getNeonAuth();
  if (!auth) return null;
  const result = await auth.getSession();
  const payload = (result && typeof result === "object" && "data" in result ? result.data : result) as
    | { user?: Record<string, unknown>; session?: { user?: Record<string, unknown> } }
    | null
    | undefined;
  const user = payload?.user ?? payload?.session?.user;
  if (!user || typeof user !== "object") return null;
  const id = typeof user.id === "string" ? user.id : "";
  const email = readEmail(user);
  if (!id || !email) return null;
  const name = typeof user.name === "string" ? user.name : "";
  return { id, email, name };
}

export async function getNeonAccessToken(): Promise<string | null> {
  const auth = getNeonAuth();
  if (!auth) return null;
  const result = await auth.getSession();
  return extractAccessToken(result) ?? extractAccessToken((result as { data?: unknown })?.data);
}
