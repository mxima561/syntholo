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
});

export function parseWebApiConfig(environment: Record<string, string | undefined>) {
  try {
    const parsed = schema.parse(environment);
    if (
      environment.NODE_ENV === "production" &&
      environment.APP_MODE === undefined
    ) {
      throw new Error("production mode required");
    }
    const production = parsed.APP_MODE === "production";
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
