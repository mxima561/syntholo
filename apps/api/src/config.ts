import { z } from "zod";
import {
  decodeMuxSigningPrivateKey,
  parseStripeApiEnvironment,
} from "@syntholo/integrations";
import { parseStaffSessionKeyRing } from "./auth/session-crypto.js";
import {
  parseCommercePayloadKeyRing,
  type CommercePayloadKeyRing,
} from "./modules/commerce/payload-crypto.js";
import { artifactReleaseSha } from "./release.js";

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const optionalNonemptyString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim().length === 0 ? undefined : value,
  z.string().trim().min(1).optional(),
);

function exactUrl(value: string, kind: "origin" | "https-url" | "issuer"): string {
  const url = new URL(value);
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (kind === "origin" &&
      (!/^https?:$/u.test(url.protocol) || url.pathname !== "/" || url.search !== "")) ||
    (kind !== "origin" && url.protocol !== "https:") ||
    (kind === "issuer" && url.search !== "")
  ) {
    throw new Error("invalid URL");
  }
  return kind === "origin" ? url.origin : kind === "issuer" ? value : url.toString();
}

const ApiEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().max(65_535).default(4_000),
  DATABASE_URL: optionalNonemptyString,
  MEMBER_DATABASE_URL: optionalNonemptyString,
  STAFF_DATABASE_URL: optionalNonemptyString,
  SYSTEM_DATABASE_URL: optionalNonemptyString,
  RELEASE_SHA: z.string().trim().regex(/^[0-9a-f]{40}$/u).optional(),
  WEB_ORIGIN: optionalNonemptyString,
  CLERK_SECRET_KEY: optionalNonemptyString,
  CLERK_PUBLISHABLE_KEY: optionalNonemptyString,
  CLERK_AUDIENCE: optionalNonemptyString,
  REMOVED_API_KEY: optionalNonemptyString,
  REMOVED_CLIENT_ID: optionalNonemptyString,
  REMOVED_ORGANIZATION_ID: optionalNonemptyString,
  REMOVED_ISSUER: optionalNonemptyString,
  REMOVED_JWKS_URL: optionalNonemptyString,
  STAFF_SESSION_ENCRYPTION_KEYS: optionalNonemptyString,
  IMPLEMENTATION_CURSOR_SECRET: optionalNonemptyString,
  CERTIFICATE_CURSOR_SECRET: optionalNonemptyString,
  CERTIFICATE_BLOB_ENABLED: z.enum(["true", "false"]).default("false"),
  CERTIFICATE_BLOB_ENVIRONMENT: z.enum(["staging", "production"]).optional(),
  CERTIFICATE_BLOB_TOKEN: optionalNonemptyString,
  CERTIFICATE_BLOB_STAGING_STORE_ID: z.string().trim().regex(/^[A-Za-z0-9]{3,64}$/u).optional(),
  CERTIFICATE_BLOB_PRODUCTION_STORE_ID: z.string().trim().regex(/^[A-Za-z0-9]{3,64}$/u).optional(),
  CERTIFICATE_BLOB_OPERATION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(15_000),
  DEPLOYMENT_ENVIRONMENT: z.enum(["staging", "production"]).optional(),
  MUX_CONTENT_ENABLED: z.enum(["true", "false"]).default("false"),
  MUX_ENVIRONMENT_ID: optionalNonemptyString,
  MUX_WEBHOOK_SECRET: optionalNonemptyString,
  MUX_SIGNING_KEY_ID: optionalNonemptyString,
  MUX_SIGNING_PRIVATE_KEY: optionalNonemptyString,
  MUX_RECONCILE_TOKEN_ID: optionalNonemptyString,
  MUX_RECONCILE_TOKEN_SECRET: optionalNonemptyString,
  STRIPE_COMMERCE_ENABLED: z.enum(["true", "false"]).default("false"),
  COMMERCE_PAYLOAD_KEYS: optionalNonemptyString,
});

export type ApiConfig = Readonly<{
  environment: "local" | "test" | "production";
  host: string;
  port: number;
  memberDatabaseUrl: string;
  staffDatabaseUrl: string;
  systemDatabaseUrl: string;
  releaseSha: string;
  webOrigin: string;
  clerkSecretKey: string;
  clerkPublishableKey: string;
  clerkAudience: string;
  accessApiKey: string;
  accessClientId: string;
  accessOrganizationId: string;
  accessIssuer: string;
  accessJwksUrl: string;
  sessionEncryptionKeys: string;
  implementationCursorSecret: string;
  certificateBlob?: Readonly<{
    enabled: true;
    environment: "staging" | "production";
    token: string;
    storeIds: Readonly<{ staging: string; production: string }>;
    operationTimeoutMs: number;
    cursorSecret: string;
  }>;
  mux: Readonly<{ kind: "disabled" }> | Readonly<{
    kind: "configured";
    environmentId: string;
    webhookSecret: string;
    signingKeyId: string;
    signingPrivateKey: string;
    uploadTokenId?: string;
    uploadTokenSecret?: string;
  }>;
  stripe: Readonly<{ kind: "disabled" }> | (Readonly<{ kind: "configured" }>
    & ReturnType<typeof parseStripeApiEnvironment>);
  commercePayloadKeys?: CommercePayloadKeyRing;
}>;

/**
 * Names the configuration variables that fail their own validation, so an
 * operator can fix a misconfigured deployment without a debugging cycle.
 *
 * It reports variable NAMES and nothing else: a value that fails validation is
 * frequently a malformed secret, and echoing it would move that secret into the
 * deployment log. Callers must keep it that way.
 */
export function diagnoseApiConfig(
  environment: RuntimeEnvironment,
  embeddedReleaseSha: string | undefined = artifactReleaseSha,
): readonly string[] {
  const issues: string[] = [];
  const present = (key: string): boolean => {
    const value = environment[key];
    return typeof value === "string" && value.trim().length > 0;
  };

  for (const key of [
    "MEMBER_DATABASE_URL", "STAFF_DATABASE_URL", "SYSTEM_DATABASE_URL",
    "RELEASE_SHA", "WEB_ORIGIN", "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY",
    "CLERK_AUDIENCE", "REMOVED_API_KEY", "REMOVED_CLIENT_ID",
    "REMOVED_ORGANIZATION_ID", "REMOVED_ISSUER", "REMOVED_JWKS_URL",
    "STAFF_SESSION_ENCRYPTION_KEYS", "IMPLEMENTATION_CURSOR_SECRET",
  ]) if (!present(key)) issues.push(`MISSING:${key}`);

  if (
    embeddedReleaseSha !== undefined
    && environment.RELEASE_SHA !== embeddedReleaseSha
  ) issues.push("MISMATCH:RELEASE_SHA");

  const stripeEnabled = environment.STRIPE_COMMERCE_ENABLED === "true";
  if (stripeEnabled) {
    if (environment.DEPLOYMENT_ENVIRONMENT === undefined) {
      issues.push("MISSING:DEPLOYMENT_ENVIRONMENT");
    }
    for (const key of [
      "STRIPE_API_RESTRICTED_KEY", "STRIPE_RECEIVER_ACCOUNT_ID",
      "STRIPE_PORTAL_CONFIGURATION_ID", "STRIPE_CHECKOUT_SUCCESS_URL",
      "STRIPE_CHECKOUT_CANCEL_URL", "STRIPE_PORTAL_RETURN_URL",
      "STRIPE_WEBHOOK_CURRENT_KEY_ID", "STRIPE_WEBHOOK_CURRENT_SECRET",
      "STRIPE_EXPECTED_LIVEMODE", "STRIPE_EXPECTED_EVENT_ACCOUNT",
      "STRIPE_EXPECTED_EVENT_CONTEXT", "STRIPE_API_VERSION",
    ]) if (!present(key)) issues.push(`MISSING:${key}`);
    try {
      parseStripeApiEnvironment(environment, { nodeEnv: environment.NODE_ENV });
    } catch {
      issues.push("INVALID:STRIPE_ENVIRONMENT");
    }
  }

  const payloadKeys = environment.COMMERCE_PAYLOAD_KEYS;
  if (stripeEnabled !== (payloadKeys !== undefined)) {
    issues.push("PAIRING:STRIPE_COMMERCE_ENABLED+COMMERCE_PAYLOAD_KEYS");
  } else if (payloadKeys !== undefined) {
    try {
      parseCommercePayloadKeyRing(payloadKeys);
    } catch {
      issues.push("INVALID:COMMERCE_PAYLOAD_KEYS");
    }
  }

  return Object.freeze(issues);
}

export function parseApiConfig(
  environment: RuntimeEnvironment,
  embeddedReleaseSha: string | undefined = artifactReleaseSha,
): ApiConfig {
  try {
    const result = ApiEnvironmentSchema.parse(environment);
    const required = {
      memberDatabaseUrl:
        result.NODE_ENV === "production"
          ? result.MEMBER_DATABASE_URL
          : result.MEMBER_DATABASE_URL ?? result.DATABASE_URL,
      staffDatabaseUrl:
        result.NODE_ENV === "production"
          ? result.STAFF_DATABASE_URL
          : result.STAFF_DATABASE_URL ?? result.DATABASE_URL,
      systemDatabaseUrl: result.SYSTEM_DATABASE_URL,
      releaseSha: result.RELEASE_SHA,
      webOrigin: result.WEB_ORIGIN,
      clerkSecretKey: result.CLERK_SECRET_KEY,
      clerkPublishableKey: result.CLERK_PUBLISHABLE_KEY,
      clerkAudience: result.CLERK_AUDIENCE,
      accessApiKey: result.REMOVED_API_KEY,
      accessClientId: result.REMOVED_CLIENT_ID,
      accessOrganizationId: result.REMOVED_ORGANIZATION_ID,
      accessIssuer: result.REMOVED_ISSUER,
      accessJwksUrl: result.REMOVED_JWKS_URL,
      sessionEncryptionKeys: result.STAFF_SESSION_ENCRYPTION_KEYS,
      implementationCursorSecret: result.IMPLEMENTATION_CURSOR_SECRET,
    };
    if (Object.values(required).some((value) => value === undefined)) {
      throw new Error("missing config");
    }
    if (Buffer.byteLength(required.implementationCursorSecret as string, "utf8") < 32) {
      throw new Error("implementation cursor secret is too short");
    }
    if (
      embeddedReleaseSha !== undefined
      && (!/^[0-9a-f]{40}$/u.test(embeddedReleaseSha)
        || required.releaseSha !== embeddedReleaseSha)
    ) {
      throw new Error("release mismatch");
    }
    if (new Set([
      required.memberDatabaseUrl,
      required.staffDatabaseUrl,
      required.systemDatabaseUrl,
    ]).size !== 3) {
      throw new Error("database capabilities must use distinct credentials");
    }
    const stripeEnabled = result.STRIPE_COMMERCE_ENABLED === "true";
    const stripeKeys = Object.keys(environment).filter(
      (key) => key.startsWith("STRIPE_") && key !== "STRIPE_COMMERCE_ENABLED"
        && environment[key] !== undefined,
    );
    if ((!stripeEnabled && stripeKeys.length !== 0)
      || (stripeEnabled && result.DEPLOYMENT_ENVIRONMENT === undefined)) {
      throw new Error("Stripe configuration invalid");
    }
    const stripe = stripeEnabled
      ? parseStripeApiEnvironment(environment, { nodeEnv: result.NODE_ENV })
      : undefined;
    // Commerce commands seal buyer contact details and claim tokens before they
    // reach PostgreSQL, so the key ring is mandatory exactly when commerce runs
    // and forbidden otherwise: an unused key in the environment is a key that
    // can leak without ever being noticed.
    if (stripeEnabled === (result.COMMERCE_PAYLOAD_KEYS === undefined)) {
      throw new Error("commerce payload keys must accompany commerce");
    }
    const commercePayloadKeys = result.COMMERCE_PAYLOAD_KEYS === undefined
      ? undefined
      : parseCommercePayloadKeyRing(result.COMMERCE_PAYLOAD_KEYS);
    if (stripe !== undefined && stripe.endpointBinding.expectedLivemode
      && result.DEPLOYMENT_ENVIRONMENT !== "production") {
      throw new Error("Stripe environment invalid");
    }
    const muxEnabled = result.MUX_CONTENT_ENABLED === "true";
    const muxValues = [
      result.MUX_ENVIRONMENT_ID,
      result.MUX_WEBHOOK_SECRET,
      result.MUX_SIGNING_KEY_ID,
      result.MUX_SIGNING_PRIVATE_KEY,
    ];
    const signingPrivateKey = result.MUX_SIGNING_PRIVATE_KEY === undefined
      ? undefined
      : decodeMuxSigningPrivateKey(result.MUX_SIGNING_PRIVATE_KEY);
    if ((!muxEnabled && muxValues.some((value) => value !== undefined))
      || (muxEnabled && muxValues.some((value) => value === undefined))
      || (result.MUX_ENVIRONMENT_ID !== undefined
        && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(result.MUX_ENVIRONMENT_ID))
      || (result.MUX_WEBHOOK_SECRET !== undefined && result.MUX_WEBHOOK_SECRET.length < 16)
      || (result.MUX_SIGNING_KEY_ID !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(result.MUX_SIGNING_KEY_ID))) {
      throw new Error("Mux configuration invalid");
    }
    const hasUploadTokenId = result.MUX_RECONCILE_TOKEN_ID !== undefined;
    const hasUploadTokenSecret = result.MUX_RECONCILE_TOKEN_SECRET !== undefined;
    if (hasUploadTokenId !== hasUploadTokenSecret
      || (hasUploadTokenId && !muxEnabled)
      || (result.MUX_RECONCILE_TOKEN_ID !== undefined
        && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(result.MUX_RECONCILE_TOKEN_ID))
      || (result.MUX_RECONCILE_TOKEN_SECRET !== undefined && result.MUX_RECONCILE_TOKEN_SECRET.length < 16)) {
      throw new Error("Mux upload token configuration invalid");
    }
    const certificateBlobEnabled = result.CERTIFICATE_BLOB_ENABLED === "true";
    const certificateBlobValues = [
      result.CERTIFICATE_BLOB_ENVIRONMENT,
      result.CERTIFICATE_BLOB_TOKEN,
      result.CERTIFICATE_BLOB_STAGING_STORE_ID,
      result.CERTIFICATE_BLOB_PRODUCTION_STORE_ID,
      result.CERTIFICATE_CURSOR_SECRET,
    ];
    const configuredCertificateBlobValues = certificateBlobValues.filter((value) => value !== undefined).length;
    if ((configuredCertificateBlobValues !== 0 && configuredCertificateBlobValues !== certificateBlobValues.length)
      || (certificateBlobEnabled && configuredCertificateBlobValues !== certificateBlobValues.length)
      || (certificateBlobEnabled
        && result.DEPLOYMENT_ENVIRONMENT !== result.CERTIFICATE_BLOB_ENVIRONMENT)
      || (result.CERTIFICATE_CURSOR_SECRET !== undefined
        && Buffer.byteLength(result.CERTIFICATE_CURSOR_SECRET, "utf8") < 32)
      || (result.CERTIFICATE_BLOB_STAGING_STORE_ID !== undefined
        && result.CERTIFICATE_BLOB_STAGING_STORE_ID === result.CERTIFICATE_BLOB_PRODUCTION_STORE_ID)) {
      throw new Error("certificate Blob configuration invalid");
    }
    parseStaffSessionKeyRing(required.sessionEncryptionKeys as string);
    const webOrigin = exactUrl(required.webOrigin as string, "origin");
    const accessIssuer = exactUrl(required.accessIssuer as string, "issuer");
    const accessJwksUrl = exactUrl(required.accessJwksUrl as string, "https-url");
    if (result.NODE_ENV === "production" && !webOrigin.startsWith("https://")) {
      throw new Error("production origin requires https");
    }
    return Object.freeze({
      environment:
        result.NODE_ENV === "development" ? "local" : result.NODE_ENV,
      host: result.HOST,
      port: result.PORT,
      memberDatabaseUrl: required.memberDatabaseUrl as string,
      staffDatabaseUrl: required.staffDatabaseUrl as string,
      systemDatabaseUrl: required.systemDatabaseUrl as string,
      releaseSha: required.releaseSha as string,
      clerkSecretKey: required.clerkSecretKey as string,
      clerkPublishableKey: required.clerkPublishableKey as string,
      clerkAudience: required.clerkAudience as string,
      accessApiKey: required.accessApiKey as string,
      accessClientId: required.accessClientId as string,
      accessOrganizationId: required.accessOrganizationId as string,
      sessionEncryptionKeys: required.sessionEncryptionKeys as string,
      implementationCursorSecret: required.implementationCursorSecret as string,
      ...(certificateBlobEnabled ? {
        certificateBlob: Object.freeze({
          enabled: true as const,
          environment: result.CERTIFICATE_BLOB_ENVIRONMENT!,
          token: result.CERTIFICATE_BLOB_TOKEN!,
          storeIds: Object.freeze({
            staging: result.CERTIFICATE_BLOB_STAGING_STORE_ID!,
            production: result.CERTIFICATE_BLOB_PRODUCTION_STORE_ID!,
          }),
          operationTimeoutMs: result.CERTIFICATE_BLOB_OPERATION_TIMEOUT_MS,
          cursorSecret: result.CERTIFICATE_CURSOR_SECRET!,
        }),
      } : {}),
      webOrigin,
      accessIssuer,
      accessJwksUrl,
      mux: muxEnabled ? Object.freeze({
        kind: "configured" as const,
        environmentId: result.MUX_ENVIRONMENT_ID as string,
        webhookSecret: result.MUX_WEBHOOK_SECRET as string,
        signingKeyId: result.MUX_SIGNING_KEY_ID as string,
        signingPrivateKey: signingPrivateKey as string,
        ...(result.MUX_RECONCILE_TOKEN_ID !== undefined ? {
          uploadTokenId: result.MUX_RECONCILE_TOKEN_ID,
          uploadTokenSecret: result.MUX_RECONCILE_TOKEN_SECRET,
        } : {}),
      }) : Object.freeze({ kind: "disabled" as const }),
      stripe: stripe === undefined
        ? Object.freeze({ kind: "disabled" as const })
        : Object.freeze({ kind: "configured" as const, ...stripe }),
      ...(commercePayloadKeys === undefined ? {} : { commercePayloadKeys }),
    });
  } catch {
    throw new Error("API_CONFIG_INVALID");
  }
}
