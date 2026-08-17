import { describe, expect, it } from "vitest";
import { diagnoseApiConfig } from "./config.js";

const releaseSha = "0123456789abcdef0123456789abcdef01234567";
const secret = "NOT-A-REAL-KEY-CANARY-VALUE-0000";

function baseEnvironment(): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    MEMBER_DATABASE_URL: "postgres://member:password@example.test/db",
    STAFF_DATABASE_URL: "postgres://staff:password@example.test/db",
    SYSTEM_DATABASE_URL: "postgres://system:password@example.test/db",
    RELEASE_SHA: releaseSha,
    WEB_ORIGIN: "https://app.syntholo.test",
    CLERK_SECRET_KEY: "sk_clerk_test",
    CLERK_PUBLISHABLE_KEY: "pk_clerk_test",
    CLERK_AUDIENCE: "syntholo-member-api",
    WORKOS_API_KEY: "sk_workos_test",
    WORKOS_CLIENT_ID: "client_staff",
    WORKOS_ORGANIZATION_ID: "org_staff",
    WORKOS_ISSUER: "https://api.workos.test",
    WORKOS_JWKS_URL: "https://api.workos.test/sso/jwks/client_staff",
    STAFF_SESSION_ENCRYPTION_KEYS: `1:${Buffer.alloc(32, 5).toString("base64url")}`,
    IMPLEMENTATION_CURSOR_SECRET: "implementation-cursor-secret-at-least-32-bytes",
  };
}

describe("diagnoseApiConfig", () => {
  it("reports nothing when the environment is complete", () => {
    expect(diagnoseApiConfig(baseEnvironment(), releaseSha)).toEqual([]);
  });

  it("names a missing variable without inventing others", () => {
    const environment = { ...baseEnvironment(), WORKOS_API_KEY: undefined };

    expect(diagnoseApiConfig(environment, releaseSha)).toEqual([
      "MISSING:WORKOS_API_KEY",
    ]);
  });

  it("flags a release identity that does not match the built artifact", () => {
    expect(diagnoseApiConfig(baseEnvironment(), "f".repeat(40)))
      .toContain("MISMATCH:RELEASE_SHA");
  });

  it("flags commerce enabled without a payload key ring, and the reverse", () => {
    expect(
      diagnoseApiConfig(
        { ...baseEnvironment(), STRIPE_COMMERCE_ENABLED: "true" },
        releaseSha,
      ),
    ).toContain("PAIRING:STRIPE_COMMERCE_ENABLED+COMMERCE_PAYLOAD_KEYS");
    expect(
      diagnoseApiConfig(
        { ...baseEnvironment(), COMMERCE_PAYLOAD_KEYS: "contact-k1:short" },
        releaseSha,
      ),
    ).toContain("PAIRING:STRIPE_COMMERCE_ENABLED+COMMERCE_PAYLOAD_KEYS");
  });

  it("flags a malformed Stripe environment", () => {
    const issues = diagnoseApiConfig({
      ...baseEnvironment(),
      STRIPE_COMMERCE_ENABLED: "true",
      DEPLOYMENT_ENVIRONMENT: "production",
      COMMERCE_PAYLOAD_KEYS: `contact-k1:${Buffer.alloc(32, 7).toString("base64url")}`,
      STRIPE_API_RESTRICTED_KEY: `"${secret}"`,
      STRIPE_RECEIVER_ACCOUNT_ID: "acct_test",
      STRIPE_PORTAL_CONFIGURATION_ID: "bpc_test",
      STRIPE_CHECKOUT_SUCCESS_URL: "https://app.syntholo.test/claim",
      STRIPE_CHECKOUT_CANCEL_URL: "https://app.syntholo.test/pricing",
      STRIPE_PORTAL_RETURN_URL: "https://app.syntholo.test/learn/settings/billing",
      STRIPE_WEBHOOK_CURRENT_KEY_ID: "stripe-webhook-current",
      STRIPE_WEBHOOK_CURRENT_SECRET: `whsec_${"b".repeat(24)}`,
      STRIPE_EXPECTED_LIVEMODE: "false",
      STRIPE_EXPECTED_EVENT_ACCOUNT: "null",
      STRIPE_EXPECTED_EVENT_CONTEXT: "null",
      STRIPE_API_VERSION: "2026-06-24.dahlia",
    }, releaseSha);

    expect(issues).toContain("INVALID:STRIPE_ENVIRONMENT");
    // The quoted key is exactly the failure mode operators hit; it must never
    // appear in the diagnostic output.
    expect(issues.join(" ")).not.toContain("CANARY");
  });
});
