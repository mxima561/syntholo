import { z } from "zod";

const rawSchema = z.object({
  APP_MODE: z.enum(["demo", "production"]).default("demo"),
  APP_URL: z.url().optional(),
  DATABASE_URL: z.string().min(1).optional(),
  NEON_AUTH_BASE_URL: z.string().url().optional(),
  NEON_AUTH_COOKIE_SECRET: z.string().min(32).optional(),
  NEXT_PUBLIC_NEON_AUTH_URL: z.string().url().optional(),
  NEXT_PUBLIC_NEON_DATA_API_URL: z.string().url().optional(),
  NEXT_PUBLIC_NEON_AUTH_GOOGLE: z.enum(["true", "false"]).optional(),
  STRIPE_SECRET_KEY: z
    .string()
    .refine((value) => /^(sk|rk|rkcs)_(test|live)_/.test(value), "Stripe secret keys must start with sk_, rk_, or rkcs_")
    .optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().startsWith("pk_").optional(),
  MUX_TOKEN_ID: z.string().min(1).optional(),
  MUX_TOKEN_SECRET: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().startsWith("re_").optional(),
  RESEND_FROM_EMAIL: z.email().optional(),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.url().optional(),
  BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
});

const groups = [
  ["Stripe", ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]],
  ["Neon Auth", ["NEON_AUTH_BASE_URL", "NEON_AUTH_COOKIE_SECRET", "NEXT_PUBLIC_NEON_AUTH_URL"]],
  ["Neon Data API", ["NEXT_PUBLIC_NEON_DATA_API_URL"]],
  ["Mux", ["MUX_TOKEN_ID", "MUX_TOKEN_SECRET"]],
  ["Resend", ["RESEND_API_KEY", "RESEND_FROM_EMAIL"]],
  ["PostHog", ["NEXT_PUBLIC_POSTHOG_KEY", "NEXT_PUBLIC_POSTHOG_HOST"]],
] as const;

const productionRequired = [
  "DATABASE_URL",
  "NEON_AUTH_BASE_URL",
  "NEON_AUTH_COOKIE_SECRET",
  "NEXT_PUBLIC_NEON_AUTH_URL",
  "NEXT_PUBLIC_NEON_DATA_API_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
] as const;

export function parseRuntimeEnv(input: Record<string, string | undefined>) {
  const normalized = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value === "" || value === undefined ? undefined : value.trim()]),
  );
  const parsed = rawSchema.parse(normalized);
  for (const [label, keys] of groups) {
    const present = keys.filter((key) => Boolean(parsed[key as keyof typeof parsed]));
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
    databaseUrl: parsed.DATABASE_URL,
    neonAuth:
      parsed.NEON_AUTH_BASE_URL && parsed.NEON_AUTH_COOKIE_SECRET && parsed.NEXT_PUBLIC_NEON_AUTH_URL
        ? {
            baseUrl: parsed.NEON_AUTH_BASE_URL,
            publishableAuthUrl: parsed.NEXT_PUBLIC_NEON_AUTH_URL,
            dataApiUrl: parsed.NEXT_PUBLIC_NEON_DATA_API_URL,
          }
        : undefined,
    stripe: parsed.STRIPE_SECRET_KEY && parsed.STRIPE_WEBHOOK_SECRET ? { secretKey: parsed.STRIPE_SECRET_KEY, webhookSecret: parsed.STRIPE_WEBHOOK_SECRET, publishableKey: parsed.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY } : undefined,
    mux: parsed.MUX_TOKEN_ID && parsed.MUX_TOKEN_SECRET ? { tokenId: parsed.MUX_TOKEN_ID, tokenSecret: parsed.MUX_TOKEN_SECRET } : undefined,
    resend: parsed.RESEND_API_KEY && parsed.RESEND_FROM_EMAIL ? { apiKey: parsed.RESEND_API_KEY, fromEmail: parsed.RESEND_FROM_EMAIL } : undefined,
    posthog: parsed.NEXT_PUBLIC_POSTHOG_KEY && parsed.NEXT_PUBLIC_POSTHOG_HOST ? { key: parsed.NEXT_PUBLIC_POSTHOG_KEY, host: parsed.NEXT_PUBLIC_POSTHOG_HOST } : undefined,
    blobToken: parsed.BLOB_READ_WRITE_TOKEN,
  };
}

let cache: ReturnType<typeof parseRuntimeEnv> | undefined;

export function getRuntimeEnv() {
  cache ??= parseRuntimeEnv(process.env);
  return cache;
}
