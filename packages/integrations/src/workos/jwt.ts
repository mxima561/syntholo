import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_PERMISSION_COUNT = 256;
const CLOCK_TOLERANCE_SECONDS = 5;
const MAX_DATE_SECONDS = 8_640_000_000_000;

export interface VerifiedWorkosAccessClaims {
  readonly workosUserId: string;
  readonly workosSessionId: string;
  readonly tokenId: string;
  readonly clientId: string;
  readonly organizationId: string;
  readonly role: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly issuedAt: Date;
  readonly authenticatedAt: Date;
  readonly expiresAt: Date;
}

export interface WorkosTokenVerificationOptions {
  readonly jwks: JWTVerifyGetKey;
  readonly issuer: string;
  readonly clientId: string;
  readonly organizationId: string;
  readonly allowedRoles: readonly string[];
  readonly now?: Date;
}

export function createWorkosJwks(jwks: JSONWebKeySet): JWTVerifyGetKey {
  return createLocalJWKSet(jwks);
}

export function createRemoteWorkosJwks(url: URL): JWTVerifyGetKey {
  if (url.protocol !== "https:") {
    throw new Error("WORKOS_JWKS_URL_INVALID");
  }
  return createRemoteJWKSet(url, {
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });
}

function requiredString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH
  ) {
    throw new Error("invalid claim");
  }
  return value;
}

function requiredTimestamp(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > MAX_DATE_SECONDS
  ) {
    throw new Error("invalid timestamp");
  }
  return Number(value);
}

function stringList(value: unknown, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_PERMISSION_COUNT) {
    throw new Error("invalid list");
  }
  const values = value.map(requiredString);
  if ((!allowEmpty && values.length === 0) || new Set(values).size !== values.length) {
    throw new Error("invalid list");
  }
  return Object.freeze(values);
}

export async function verifyWorkosAccessToken(
  token: string,
  options: WorkosTokenVerificationOptions,
): Promise<VerifiedWorkosAccessClaims> {
  try {
    if (token.length === 0 || token.length > 16_384) {
      throw new Error("invalid token");
    }
    const now = options.now ?? new Date();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const { payload } = await jwtVerify(token, options.jwks, {
      algorithms: ["RS256"],
      currentDate: now,
      issuer: options.issuer,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });

    if (payload.act !== undefined) throw new Error("impersonation denied");
    const workosUserId = requiredString(payload.sub);
    const workosSessionId = requiredString(payload.sid);
    const tokenId = requiredString(payload.jti);
    const clientId = requiredString(payload.client_id);
    const organizationId = requiredString(payload.org_id);
    const role = requiredString(payload.role);
    const roles = stringList(payload.roles, false);
    const permissions = stringList(payload.permissions, true);
    const issuedAt = requiredTimestamp(payload.iat);
    const authenticatedAt = requiredTimestamp(payload.auth_time);
    const expiresAt = requiredTimestamp(payload.exp);

    if (
      clientId !== options.clientId ||
      organizationId !== options.organizationId ||
      !options.allowedRoles.includes(role) ||
      roles.length !== 1 ||
      roles[0] !== role ||
      issuedAt > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
      authenticatedAt > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
      authenticatedAt > issuedAt ||
      expiresAt <= nowSeconds
    ) {
      throw new Error("invalid claims");
    }

    return Object.freeze({
      workosUserId,
      workosSessionId,
      tokenId,
      clientId,
      organizationId,
      role,
      roles,
      permissions,
      issuedAt: new Date(issuedAt * 1_000),
      authenticatedAt: new Date(authenticatedAt * 1_000),
      expiresAt: new Date(expiresAt * 1_000),
    });
  } catch {
    throw new Error("WORKOS_TOKEN_INVALID");
  }
}
