import { z } from "zod";
import { parseStaffSessionKeyRing } from "./auth/session-crypto.js";

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
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().max(65_535).default(4_000),
  DATABASE_URL: optionalNonemptyString,
  MEMBER_DATABASE_URL: optionalNonemptyString,
  STAFF_DATABASE_URL: optionalNonemptyString,
  RELEASE_SHA: optionalNonemptyString,
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
});

export type ApiConfig = Readonly<{
  environment: "local" | "test" | "production";
  host: string;
  port: number;
  memberDatabaseUrl: string;
  staffDatabaseUrl: string;
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
}>;

export function parseApiConfig(environment: RuntimeEnvironment): ApiConfig {
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
    };
    if (Object.values(required).some((value) => value === undefined)) {
      throw new Error("missing config");
    }
    if (required.memberDatabaseUrl === required.staffDatabaseUrl) {
      throw new Error("database capabilities must use distinct credentials");
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
      releaseSha: required.releaseSha as string,
      clerkSecretKey: required.clerkSecretKey as string,
      clerkPublishableKey: required.clerkPublishableKey as string,
      clerkAudience: required.clerkAudience as string,
      workosApiKey: required.workosApiKey as string,
      workosClientId: required.workosClientId as string,
      workosOrganizationId: required.workosOrganizationId as string,
      sessionEncryptionKeys: required.sessionEncryptionKeys as string,
      webOrigin,
      workosIssuer,
      workosJwksUrl,
    });
  } catch {
    throw new Error("API_CONFIG_INVALID");
  }
}
