import { z } from "zod";
import { decodeMuxSigningPrivateKey } from "@syntholo/integrations";
import { parseStaffSessionKeyRing } from "./auth/session-crypto.js";
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
  WORKOS_API_KEY: optionalNonemptyString,
  WORKOS_CLIENT_ID: optionalNonemptyString,
  WORKOS_ORGANIZATION_ID: optionalNonemptyString,
  WORKOS_ISSUER: optionalNonemptyString,
  WORKOS_JWKS_URL: optionalNonemptyString,
  STAFF_SESSION_ENCRYPTION_KEYS: optionalNonemptyString,
  IMPLEMENTATION_CURSOR_SECRET: optionalNonemptyString,
  MUX_CONTENT_ENABLED: z.enum(["true", "false"]).default("false"),
  MUX_ENVIRONMENT_ID: optionalNonemptyString,
  MUX_WEBHOOK_SECRET: optionalNonemptyString,
  MUX_SIGNING_KEY_ID: optionalNonemptyString,
  MUX_SIGNING_PRIVATE_KEY: optionalNonemptyString,
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
  workosApiKey: string;
  workosClientId: string;
  workosOrganizationId: string;
  workosIssuer: string;
  workosJwksUrl: string;
  sessionEncryptionKeys: string;
  implementationCursorSecret: string;
  mux: Readonly<{ kind: "disabled" }> | Readonly<{
    kind: "configured";
    environmentId: string;
    webhookSecret: string;
    signingKeyId: string;
    signingPrivateKey: string;
  }>;
}>;

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
      workosApiKey: result.WORKOS_API_KEY,
      workosClientId: result.WORKOS_CLIENT_ID,
      workosOrganizationId: result.WORKOS_ORGANIZATION_ID,
      workosIssuer: result.WORKOS_ISSUER,
      workosJwksUrl: result.WORKOS_JWKS_URL,
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
    parseStaffSessionKeyRing(required.sessionEncryptionKeys as string);
    const webOrigin = exactUrl(required.webOrigin as string, "origin");
    const workosIssuer = exactUrl(required.workosIssuer as string, "issuer");
    const workosJwksUrl = exactUrl(required.workosJwksUrl as string, "https-url");
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
      workosApiKey: required.workosApiKey as string,
      workosClientId: required.workosClientId as string,
      workosOrganizationId: required.workosOrganizationId as string,
      sessionEncryptionKeys: required.sessionEncryptionKeys as string,
      implementationCursorSecret: required.implementationCursorSecret as string,
      webOrigin,
      workosIssuer,
      workosJwksUrl,
      mux: muxEnabled ? Object.freeze({
        kind: "configured" as const,
        environmentId: result.MUX_ENVIRONMENT_ID as string,
        webhookSecret: result.MUX_WEBHOOK_SECRET as string,
        signingKeyId: result.MUX_SIGNING_KEY_ID as string,
        signingPrivateKey: signingPrivateKey as string,
      }) : Object.freeze({ kind: "disabled" as const }),
    });
  } catch {
    throw new Error("API_CONFIG_INVALID");
  }
}
