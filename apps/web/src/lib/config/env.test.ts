import { describe, expect, it } from "vitest";
import { parseRuntimeEnv } from "./env";

describe("parseRuntimeEnv", () => {
  it("allows demo mode without vendor credentials", () => {
    expect(parseRuntimeEnv({ APP_MODE: "demo" })).toEqual({
      appUrl: "http://localhost:3000",
      clerkPublishableKey: undefined,
      mode: "demo",
      posthog: undefined,
    });
  });

  it("never silently defaults a production Node runtime to demo mode", () => {
    expect(() => parseRuntimeEnv({ NODE_ENV: "production" })).toThrow(
      /configured explicitly/i,
    );
  });

  it.each([
    "DATABASE_URL",
    "DATABASE_DIRECT_URL",
    "MEMBER_DATABASE_URL",
    "CLERK_SECRET_KEY",
    "REMOVED_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_API_RESTRICTED_KEY",
    "STRIPE_WORKER_READ_RESTRICTED_KEY",
    "STRIPE_WORKER_ACTION_RESTRICTED_KEY",
    "STRIPE_WEBHOOK_CURRENT_SECRET",
    "MUX_TOKEN_SECRET",
    "RESEND_API_KEY",
    "BLOB_READ_WRITE_TOKEN",
    "HIGHLEVEL_API_KEY",
    "POSTHOG_PERSONAL_API_KEY",
    "OPENAI_API_KEY",
    "NEXT_PUBLIC_OPENAI_API_KEY",
  ])("rejects the privileged web environment key %s even when blank", (key) => {
    expect(() => parseRuntimeEnv({ APP_MODE: "demo", [key]: "" })).toThrow(
      "WEB_ENV_FORBIDDEN_KEY",
    );
  });

  it("preserves only public PostHog configuration", () => {
    expect(parseRuntimeEnv({
      APP_MODE: "demo",
      NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com",
      NEXT_PUBLIC_POSTHOG_KEY: "ph_public",
    }).posthog).toEqual({
      host: "https://us.i.posthog.com",
      key: "ph_public",
    });
  });

  it("requires Clerk and an exact canonical URL in production", () => {
    expect(() => parseRuntimeEnv({ APP_MODE: "production" })).toThrow(
      "WEB_ENV_INVALID",
    );
    expect(parseRuntimeEnv({
      APP_MODE: "production",
      APP_URL: "https://app.syntholo.test",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_test",
    })).toMatchObject({
      appUrl: "https://app.syntholo.test",
      clerkPublishableKey: "pk_live_test",
      mode: "production",
    });
  });
});
