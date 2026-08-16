import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  attestStripeCredentialFingerprints,
  parseStripeApiEnvironment,
  parseStripeWorkerEnvironment,
} from "./stripe-config.js";

const shapedApiKey = ["rk", "test", "A".repeat(24)].join("_");
const shapedWorkerReadKey = ["rk", "test", "B".repeat(24)].join("_");
const shapedWorkerActionKey = ["rk", "test", "C".repeat(24)].join("_");
const shapedWebhookSecret = ["whsec", "D".repeat(32)].join("_");
const shapedPreviousWebhookSecret = ["whsec", "E".repeat(32)].join("_");

const apiEnvironment = {
  STRIPE_API_RESTRICTED_KEY: shapedApiKey,
  STRIPE_RECEIVER_ACCOUNT_ID: "acct_test",
  STRIPE_PORTAL_CONFIGURATION_ID: "bpc_test",
  STRIPE_CHECKOUT_SUCCESS_URL: "https://app.syntholo.com/claim",
  STRIPE_CHECKOUT_CANCEL_URL: "https://app.syntholo.com/pricing",
  STRIPE_PORTAL_RETURN_URL: "https://app.syntholo.com/learn/settings/billing",
  STRIPE_WEBHOOK_CURRENT_KEY_ID: "stripe_webhook_2026_08",
  STRIPE_WEBHOOK_CURRENT_SECRET: shapedWebhookSecret,
  STRIPE_WEBHOOK_PREVIOUS_KEY_ID: "stripe_webhook_2026_07",
  STRIPE_WEBHOOK_PREVIOUS_SECRET: shapedPreviousWebhookSecret,
  STRIPE_EXPECTED_LIVEMODE: "false",
  STRIPE_EXPECTED_EVENT_ACCOUNT: "null",
  STRIPE_EXPECTED_EVENT_CONTEXT: "null",
  STRIPE_API_VERSION: "2026-06-24.dahlia",
};

const workerEnvironment = {
  STRIPE_WORKER_READ_RESTRICTED_KEY: shapedWorkerReadKey,
  STRIPE_WORKER_ACTION_RESTRICTED_KEY: shapedWorkerActionKey,
  STRIPE_RECEIVER_ACCOUNT_ID: "acct_test",
  STRIPE_EXPECTED_LIVEMODE: "false",
  STRIPE_API_VERSION: "2026-06-24.dahlia",
};

const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

describe("Stripe least-privilege server environments", () => {
  it("parses only API authority plus an explicit dual-secret endpoint keyring", () => {
    const parsed = parseStripeApiEnvironment(apiEnvironment, { nodeEnv: "production" });
    expect(parsed).toEqual({
      apiRestrictedKey: shapedApiKey,
      checkoutSuccessUrl: "https://app.syntholo.com/claim",
      checkoutCancelUrl: "https://app.syntholo.com/pricing",
      portalConfigurationId: "bpc_test",
      portalReturnUrl: "https://app.syntholo.com/learn/settings/billing",
      endpointBinding: {
        receiverAccountId: "acct_test",
        expectedLivemode: false,
        expectedApiVersion: "2026-06-24.dahlia",
        expectedEventAccount: null,
        expectedEventContext: null,
      },
      webhookSecrets: [
        { keyId: "stripe_webhook_2026_08", secret: shapedWebhookSecret },
        { keyId: "stripe_webhook_2026_07", secret: shapedPreviousWebhookSecret },
      ],
    });
    expect(parsed).not.toHaveProperty("workerReadRestrictedKey");
    expect(parsed).not.toHaveProperty("workerActionRestrictedKey");
  });

  it("parses only the worker read/action authorities", () => {
    const parsed = parseStripeWorkerEnvironment(workerEnvironment, { nodeEnv: "production" });
    expect(parsed).toEqual({
      workerReadRestrictedKey: shapedWorkerReadKey,
      workerActionRestrictedKey: shapedWorkerActionKey,
      receiverAccountId: "acct_test",
      expectedLivemode: false,
      apiVersion: "2026-06-24.dahlia",
    });
    expect(parsed).not.toHaveProperty("apiRestrictedKey");
    expect(parsed).not.toHaveProperty("webhookSecrets");
  });

  it("fails closed when a service process contains another service's raw authority", () => {
    expect(() => parseStripeApiEnvironment({
      ...apiEnvironment,
      STRIPE_WORKER_READ_RESTRICTED_KEY: shapedWorkerReadKey,
    }, { nodeEnv: "production" })).toThrowError(new Error("STRIPE_API_CONFIG_INVALID"));
    expect(() => parseStripeApiEnvironment({
      ...apiEnvironment,
      STRIPE_RECEIVER_ACCOUNT_ID: "wrong_account",
    }, { nodeEnv: "production" })).toThrowError(new Error("STRIPE_API_CONFIG_INVALID"));
    expect(() => parseStripeApiEnvironment({
      ...apiEnvironment,
      STRIPE_PORTAL_CONFIGURATION_ID: "wrong_portal",
    }, { nodeEnv: "production" })).toThrowError(new Error("STRIPE_API_CONFIG_INVALID"));
    expect(() => parseStripeWorkerEnvironment({
      ...workerEnvironment,
      STRIPE_API_RESTRICTED_KEY: shapedApiKey,
    }, { nodeEnv: "production" })).toThrowError(new Error("STRIPE_WORKER_CONFIG_INVALID"));
    expect(() => parseStripeWorkerEnvironment({
      ...workerEnvironment,
      STRIPE_WEBHOOK_CURRENT_SECRET: shapedWebhookSecret,
    }, { nodeEnv: "production" })).toThrowError(new Error("STRIPE_WORKER_CONFIG_INVALID"));
    expect(() => parseStripeWorkerEnvironment({
      ...workerEnvironment,
      STRIPE_CHECKOUT_SUCCESS_URL: "https://app.syntholo.com/claim",
    }, { nodeEnv: "production" })).toThrowError(new Error("STRIPE_WORKER_CONFIG_INVALID"));
  });

  it("attests deployment isolation using fingerprints rather than co-locating raw keys", () => {
    expect(attestStripeCredentialFingerprints({
      api: fingerprint(shapedApiKey),
      workerRead: fingerprint(shapedWorkerReadKey),
      workerAction: fingerprint(shapedWorkerActionKey),
    })).toEqual({ isolated: true });
    expect(() => attestStripeCredentialFingerprints({
      api: fingerprint(shapedApiKey),
      workerRead: fingerprint(shapedApiKey),
      workerAction: fingerprint(shapedWorkerActionKey),
    })).toThrowError(new Error("STRIPE_CREDENTIAL_ISOLATION_INVALID"));
  });

  it("rejects unpinned versions and incomplete webhook rotations", () => {
    expect(() => parseStripeApiEnvironment({ ...apiEnvironment, STRIPE_API_VERSION: "2026-07-29.clover" }, {
      nodeEnv: "production",
    })).toThrowError(new Error("STRIPE_API_CONFIG_INVALID"));
    expect(() => parseStripeApiEnvironment({ ...apiEnvironment, STRIPE_WEBHOOK_PREVIOUS_SECRET: undefined }, {
      nodeEnv: "production",
    })).toThrowError(new Error("STRIPE_API_CONFIG_INVALID"));
    expect(() => parseStripeWorkerEnvironment({ ...workerEnvironment, STRIPE_API_VERSION: "latest" }, {
      nodeEnv: "production",
    })).toThrowError(new Error("STRIPE_WORKER_CONFIG_INVALID"));
    expect(() => parseStripeApiEnvironment({
      ...apiEnvironment,
      STRIPE_CHECKOUT_SUCCESS_URL: "https://attacker.test/claim",
    }, { nodeEnv: "production" })).toThrowError(new Error("STRIPE_API_CONFIG_INVALID"));
  });

  it("binds every restricted credential to the configured test/live mode", () => {
    const liveApiKey = ["rk", "live", "L".repeat(24)].join("_");
    const liveWorkerReadKey = ["rk", "live", "M".repeat(24)].join("_");
    const liveWorkerActionKey = ["rk", "live", "N".repeat(24)].join("_");
    expect(() => parseStripeApiEnvironment({
      ...apiEnvironment,
      STRIPE_API_RESTRICTED_KEY: liveApiKey,
    }, { nodeEnv: "production" })).toThrowError(new Error("STRIPE_API_CONFIG_INVALID"));
    expect(() => parseStripeApiEnvironment({
      ...apiEnvironment,
      STRIPE_EXPECTED_LIVEMODE: "true",
    }, { nodeEnv: "production" })).toThrowError(new Error("STRIPE_API_CONFIG_INVALID"));
    expect(() => parseStripeWorkerEnvironment({
      ...workerEnvironment,
      STRIPE_WORKER_READ_RESTRICTED_KEY: liveWorkerReadKey,
    }, { nodeEnv: "production" })).toThrowError(new Error("STRIPE_WORKER_CONFIG_INVALID"));
    expect(() => parseStripeWorkerEnvironment({
      ...workerEnvironment,
      STRIPE_EXPECTED_LIVEMODE: "true",
    }, { nodeEnv: "production" })).toThrowError(new Error("STRIPE_WORKER_CONFIG_INVALID"));
    expect(parseStripeWorkerEnvironment({
      ...workerEnvironment,
      STRIPE_WORKER_READ_RESTRICTED_KEY: liveWorkerReadKey,
      STRIPE_WORKER_ACTION_RESTRICTED_KEY: liveWorkerActionKey,
      STRIPE_EXPECTED_LIVEMODE: "true",
    }, { nodeEnv: "production" })).toMatchObject({ expectedLivemode: true });
  });

  it("allows deterministic fake credentials only behind the matching test-only service switch", () => {
    const fakeApi = {
      ...apiEnvironment,
      STRIPE_API_RESTRICTED_KEY: "syntholo_test_fake_api",
      STRIPE_WEBHOOK_CURRENT_SECRET: "syntholo_test_fake_webhook_current",
      STRIPE_WEBHOOK_PREVIOUS_KEY_ID: undefined,
      STRIPE_WEBHOOK_PREVIOUS_SECRET: undefined,
      STRIPE_TEST_FAKE: "1",
    };
    const fakeWorker = {
      ...workerEnvironment,
      STRIPE_WORKER_READ_RESTRICTED_KEY: "syntholo_test_fake_worker_read",
      STRIPE_WORKER_ACTION_RESTRICTED_KEY: "syntholo_test_fake_worker_action",
      STRIPE_TEST_FAKE: "1",
    };
    expect(parseStripeApiEnvironment(fakeApi, { nodeEnv: "test" })).toMatchObject({
      apiRestrictedKey: "syntholo_test_fake_api",
    });
    expect(parseStripeWorkerEnvironment(fakeWorker, { nodeEnv: "test" })).toMatchObject({
      workerReadRestrictedKey: "syntholo_test_fake_worker_read",
    });
    expect(() => parseStripeApiEnvironment({
      ...fakeApi,
      STRIPE_EXPECTED_LIVEMODE: "true",
    }, { nodeEnv: "test" })).toThrowError(new Error("STRIPE_API_CONFIG_INVALID"));
    expect(() => parseStripeWorkerEnvironment({
      ...fakeWorker,
      STRIPE_EXPECTED_LIVEMODE: "true",
    }, { nodeEnv: "test" })).toThrowError(new Error("STRIPE_WORKER_CONFIG_INVALID"));
    expect(() => parseStripeApiEnvironment(fakeApi, { nodeEnv: "production" })).toThrowError(
      new Error("STRIPE_API_CONFIG_INVALID"),
    );
    expect(() => parseStripeWorkerEnvironment(fakeWorker, { nodeEnv: "production" })).toThrowError(
      new Error("STRIPE_WORKER_CONFIG_INVALID"),
    );
  });
});
