import { z } from "zod";

function exactOrigin(value: string, secure: boolean): string {
  const url = new URL(value);
  if (
    (secure && url.protocol !== "https:") ||
    (!secure && url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("invalid origin");
  }
  return url.origin;
}

const schema = z.object({
  APP_MODE: z.enum(["demo", "production"]).default("demo"),
  WEB_ORIGIN: z.string().optional(),
  API_UPSTREAM_ORIGIN: z.string().optional(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
}).strict();

const allowedKeys = [
  "API_UPSTREAM_ORIGIN",
  "APP_MODE",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "VERCEL_ENV",
  "WEB_ORIGIN",
] as const;

const forbiddenKey = /^(?:(?:DATABASE_(?:DIRECT_|POOLED_)?URL|TEST_DATABASE_URL|(?:MEMBER|STAFF|SYSTEM|WORKER)_DATABASE_URL|WORKOS_.+|STRIPE_(?:SECRET|WEBHOOK).+|MUX_(?:TOKEN|SIGNING).+|RESEND_(?:API|SECRET).+|BLOB_(?:READ_WRITE|WRITE).+|HIGHLEVEL_.+)|.*(?:SECRET(?:_KEY)?|API_KEY|PRIVATE_KEY|WRITE_TOKEN))$/u;

export function parseWebApiConfig(environment: Record<string, string | undefined>) {
  try {
    if (Object.keys(environment).some((key) => forbiddenKey.test(key))) {
      throw new Error("forbidden key");
    }
    const selected = Object.fromEntries(
      allowedKeys.flatMap((key) =>
        environment[key] === undefined ? [] : [[key, environment[key]]]
      ),
    );
    const parsed = schema.parse(selected);
    if (
      environment.NODE_ENV === "production" &&
      environment.APP_MODE === undefined
    ) {
      throw new Error("production mode required");
    }
    const production = parsed.APP_MODE === "production";
    if (
      parsed.VERCEL_ENV === "preview"
      && (production
        || parsed.API_UPSTREAM_ORIGIN !== undefined
        || parsed.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY !== undefined)
    ) {
      throw new Error("preview production linkage forbidden");
    }
    if (
      production &&
      (!parsed.WEB_ORIGIN || !parsed.API_UPSTREAM_ORIGIN || !parsed.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)
    ) {
      throw new Error("missing production config");
    }
    const webOrigin = exactOrigin(parsed.WEB_ORIGIN ?? "http://localhost:3000", production);
    const apiUpstreamOrigin = exactOrigin(
      parsed.API_UPSTREAM_ORIGIN ?? "http://localhost:4000",
      production,
    );
    if (webOrigin === apiUpstreamOrigin) throw new Error("origins must differ");
    return Object.freeze({
      mode: parsed.APP_MODE,
      webOrigin,
      apiUpstreamOrigin,
      clerkPublishableKey: parsed.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      staffCookieName: production
        ? "__Host-syntholo_staff_session"
        : "syntholo_local_staff_session",
      rewrite: {
        source: "/v1/:path*",
        destination: `${apiUpstreamOrigin}/v1/:path*`,
      },
    });
  } catch {
    throw new Error("WEB_API_CONFIG_INVALID");
  }
}
