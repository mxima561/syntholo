import { z } from "zod";

const rawSchema = z.object({
  APP_MODE: z.enum(["demo", "production"]).default("demo"),
  APP_URL: z.url().optional(),
  MONGODB_URI: z.string().min(1).optional(),
  MONGODB_DATABASE: z.string().min(1).optional(),
  WORKOS_API_KEY: z.string().min(1).optional(),
  WORKOS_CLIENT_ID: z.string().min(1).optional(),
  WORKOS_COOKIE_PASSWORD: z.string().min(32).optional(),
  STRIPE_SECRET_KEY: z.string().startsWith("sk_").optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().startsWith("pk_").optional(),
  MUX_TOKEN_ID: z.string().min(1).optional(),
  MUX_TOKEN_SECRET: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().startsWith("re_").optional(),
  RESEND_FROM_EMAIL: z.email().optional(),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.url().optional(),
  BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
  HIGHLEVEL_API_KEY: z.string().min(1).optional(),
  HIGHLEVEL_LOCATION_ID: z.string().min(1).optional(),
});

const groups = [
  ["Stripe", ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]],
  ["MongoDB", ["MONGODB_URI", "MONGODB_DATABASE"]],
  ["WorkOS", ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD"]],
  ["Mux", ["MUX_TOKEN_ID", "MUX_TOKEN_SECRET"]],
  ["Resend", ["RESEND_API_KEY", "RESEND_FROM_EMAIL"]],
  ["PostHog", ["NEXT_PUBLIC_POSTHOG_KEY", "NEXT_PUBLIC_POSTHOG_HOST"]],
  ["HighLevel", ["HIGHLEVEL_API_KEY", "HIGHLEVEL_LOCATION_ID"]],
] as const;

const productionRequired = [
  "MONGODB_URI", "MONGODB_DATABASE", "WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD",
  "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "MUX_TOKEN_ID", "MUX_TOKEN_SECRET", "RESEND_API_KEY",
  "RESEND_FROM_EMAIL", "NEXT_PUBLIC_POSTHOG_KEY", "NEXT_PUBLIC_POSTHOG_HOST", "BLOB_READ_WRITE_TOKEN",
] as const;

export function parseRuntimeEnv(input: Record<string, string | undefined>) {
  const parsed = rawSchema.parse(input);
  for (const [label, keys] of groups) {
    const present = keys.filter((key) => Boolean(parsed[key]));
    if (present.length > 0 && present.length < keys.length) {
      throw new Error(`${label} configuration is partial. Configure ${keys.join(", ")} together.`);
    }
  }
  if (parsed.APP_MODE === "production") {
    const missing = productionRequired.filter((key) => !parsed[key]);
    if (missing.length > 0) throw new Error(`Production mode is missing required integrations: ${missing.join(", ")}.`);
  }

  const configuredCount = productionRequired.filter((key) => Boolean(parsed[key])).length;
  return {
    mode: parsed.APP_MODE,
    appUrl: parsed.APP_URL ?? "http://localhost:3000",
    vendorsConfigured: configuredCount === productionRequired.length,
    mongodb: parsed.MONGODB_URI && parsed.MONGODB_DATABASE ? { uri: parsed.MONGODB_URI, database: parsed.MONGODB_DATABASE } : undefined,
    workos: parsed.WORKOS_API_KEY && parsed.WORKOS_CLIENT_ID && parsed.WORKOS_COOKIE_PASSWORD ? { apiKey: parsed.WORKOS_API_KEY, clientId: parsed.WORKOS_CLIENT_ID, cookiePassword: parsed.WORKOS_COOKIE_PASSWORD } : undefined,
    stripe: parsed.STRIPE_SECRET_KEY && parsed.STRIPE_WEBHOOK_SECRET ? { secretKey: parsed.STRIPE_SECRET_KEY, webhookSecret: parsed.STRIPE_WEBHOOK_SECRET, publishableKey: parsed.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY } : undefined,
    mux: parsed.MUX_TOKEN_ID && parsed.MUX_TOKEN_SECRET ? { tokenId: parsed.MUX_TOKEN_ID, tokenSecret: parsed.MUX_TOKEN_SECRET } : undefined,
    resend: parsed.RESEND_API_KEY && parsed.RESEND_FROM_EMAIL ? { apiKey: parsed.RESEND_API_KEY, fromEmail: parsed.RESEND_FROM_EMAIL } : undefined,
    posthog: parsed.NEXT_PUBLIC_POSTHOG_KEY && parsed.NEXT_PUBLIC_POSTHOG_HOST ? { key: parsed.NEXT_PUBLIC_POSTHOG_KEY, host: parsed.NEXT_PUBLIC_POSTHOG_HOST } : undefined,
    blobToken: parsed.BLOB_READ_WRITE_TOKEN,
    highlevel: parsed.HIGHLEVEL_API_KEY && parsed.HIGHLEVEL_LOCATION_ID ? { apiKey: parsed.HIGHLEVEL_API_KEY, locationId: parsed.HIGHLEVEL_LOCATION_ID } : undefined,
  };
}

let cache: ReturnType<typeof parseRuntimeEnv> | undefined;

export function getRuntimeEnv() {
  cache ??= parseRuntimeEnv(process.env);
  return cache;
}
