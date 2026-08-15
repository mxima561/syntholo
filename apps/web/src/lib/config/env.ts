import { z } from "zod";

const allowedKeys = [
  "APP_MODE",
  "APP_URL",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_POSTHOG_HOST",
  "NEXT_PUBLIC_POSTHOG_KEY",
] as const;

const forbiddenKey = /^(?:(?:DATABASE_(?:DIRECT_|POOLED_)?URL|TEST_DATABASE_URL|(?:MEMBER|STAFF|SYSTEM|WORKER)_DATABASE_URL|WORKOS_.+|STRIPE_.+|MUX_(?:TOKEN|SIGNING).+|RESEND_(?:API|SECRET).+|BLOB_(?:READ_WRITE|WRITE).+|HIGHLEVEL_.+)|.*(?:SECRET(?:_KEY)?|API_KEY|PRIVATE_KEY|WRITE_TOKEN))$/u;

const WebEnvironmentSchema = z.object({
  APP_MODE: z.enum(["demo", "production"]).default("demo"),
  APP_URL: z.url().default("http://localhost:3000"),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().startsWith("pk_").optional(),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.url().optional(),
}).strict();

function exactOrigin(value: string, secure: boolean): string {
  const url = new URL(value);
  if (
    (secure ? url.protocol !== "https:" : !["http:", "https:"].includes(url.protocol))
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("invalid origin");
  }
  return url.origin;
}

export function parseRuntimeEnv(input: Record<string, string | undefined>) {
  for (const key of Object.keys(input)) {
    if (forbiddenKey.test(key)) throw new Error("WEB_ENV_FORBIDDEN_KEY");
  }
  if (input.NODE_ENV === "production" && input.APP_MODE === undefined) {
    throw new Error("Production mode must be configured explicitly.");
  }
  try {
    const selected = Object.fromEntries(
      allowedKeys.flatMap((key) => input[key] === undefined ? [] : [[key, input[key]]]),
    );
    const parsed = WebEnvironmentSchema.parse(selected);
    const production = parsed.APP_MODE === "production";
    if (production && parsed.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY === undefined) {
      throw new Error("clerk required");
    }
    const hasPosthogKey = parsed.NEXT_PUBLIC_POSTHOG_KEY !== undefined;
    const hasPosthogHost = parsed.NEXT_PUBLIC_POSTHOG_HOST !== undefined;
    if (hasPosthogKey !== hasPosthogHost) throw new Error("posthog partial");

    return Object.freeze({
      appUrl: exactOrigin(parsed.APP_URL, production),
      clerkPublishableKey: parsed.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      mode: parsed.APP_MODE,
      posthog: hasPosthogKey && hasPosthogHost
        ? Object.freeze({
            host: parsed.NEXT_PUBLIC_POSTHOG_HOST as string,
            key: parsed.NEXT_PUBLIC_POSTHOG_KEY as string,
          })
        : undefined,
    });
  } catch {
    throw new Error("WEB_ENV_INVALID");
  }
}

let cache: ReturnType<typeof parseRuntimeEnv> | undefined;

export function getRuntimeEnv() {
  cache ??= parseRuntimeEnv(process.env);
  return cache;
}
