import { timingSafeEqual } from "node:crypto";
import type { StaffActor } from "@syntholo/domain";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../plugins/error-handler.js";
import {
  generateOpaqueSessionId,
  hashOpaqueSessionId,
} from "./session-crypto.js";
import type {
  AuthRouteDependencies,
  LoginAttemptRecord,
  StaffIdentityRecord,
  StaffSessionRecord,
  WorkosAccessClaims,
} from "./types.js";

const REFRESH_SKEW_MS = 30_000;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{43}$/u;

type StaffDependencies = AuthRouteDependencies["staff"];

function unauthenticated(): never {
  throw new AppError("UNAUTHENTICATED", 401, "Authentication required");
}

function invalidRequest(): never {
  throw new AppError("INVALID_AUTH_REQUEST", 400, "Invalid authentication request");
}

function providerUnavailable(): never {
  throw new AppError(
    "AUTH_PROVIDER_UNAVAILABLE",
    503,
    "Authentication provider unavailable",
  );
}

function rawHeaderValues(request: FastifyRequest, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.raw.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function isSecureEnvironment(environment: StaffDependencies["config"]["environment"]): boolean {
  return environment === "production" || environment === "staging";
}

export function staffCookieNames(environment: StaffDependencies["config"]["environment"]): {
  session: string;
  login: string;
} {
  return isSecureEnvironment(environment)
    ? {
        session: "__Host-syntholo_staff_session",
        login: "__Host-syntholo_staff_login",
      }
    : {
        session: "syntholo_local_staff_session",
        login: "syntholo_local_staff_login",
      };
}

function cookieValues(request: FastifyRequest, name: string): string[] {
  const results: string[] = [];
  for (const header of rawHeaderValues(request, "cookie")) {
    for (const piece of header.split(";")) {
      const separator = piece.indexOf("=");
      if (separator < 0) continue;
      if (piece.slice(0, separator).trim() === name) {
        results.push(piece.slice(separator + 1).trim());
      }
    }
  }
  return results;
}

function oneCookie(
  request: FastifyRequest,
  name: string,
  required: boolean,
): string | null {
  const values = cookieValues(request, name);
  if (values.length === 0 && !required) return null;
  if (values.length !== 1 || !COOKIE_VALUE.test(values[0] ?? "")) {
    unauthenticated();
  }
  return values[0] as string;
}

function serializedCookie(input: {
  name: string;
  value: string;
  secure: boolean;
  maxAge: number;
}): string {
  return `${input.name}=${input.value}; Max-Age=${input.maxAge}; Path=/; HttpOnly; SameSite=Lax${input.secure ? "; Secure" : ""}`;
}

function clearCookie(name: string, secure: boolean): string {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function safeReturnTo(value: unknown, dependencies: StaffDependencies): string {
  const returnTo = value === undefined ? dependencies.config.defaultReturnTo : value;
  if (typeof returnTo !== "string" || returnTo.length === 0 || returnTo.length > 2_048) {
    invalidRequest();
  }
  if (!returnTo.startsWith("/") || returnTo.startsWith("//") || returnTo.includes("\\")) {
    invalidRequest();
  }
  let parsed: URL;
  try {
    parsed = new URL(returnTo, dependencies.config.webOrigin);
  } catch {
    invalidRequest();
  }
  if (
    parsed.origin !== dependencies.config.webOrigin ||
    `${parsed.pathname}${parsed.search}${parsed.hash}` !== returnTo ||
    !dependencies.config.allowedReturnToPrefixes.some(
      (prefix) =>
        parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`),
    )
  ) {
    invalidRequest();
  }
  return returnTo;
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function validateProviderIdentity(
  claims: WorkosAccessClaims,
  identity: StaffIdentityRecord,
  config: StaffDependencies["config"],
): void {
  if (
    claims.clientId !== config.clientId ||
    claims.organizationId !== config.organizationId ||
    claims.workosUserId !== identity.workosUserId ||
    claims.role !== identity.role ||
    claims.roles.length !== 1 ||
    claims.roles[0] !== identity.role ||
    !equalStrings(claims.permissions, identity.permissions)
  ) {
    unauthenticated();
  }
}

function validateStoredClaims(
  claims: WorkosAccessClaims,
  session: StaffSessionRecord,
  config: StaffDependencies["config"],
): void {
  if (
    claims.clientId !== config.clientId ||
    claims.organizationId !== session.organizationId ||
    claims.organizationId !== config.organizationId ||
    claims.workosUserId !== session.workosUserId ||
    claims.workosSessionId !== session.workosSessionId ||
    claims.role !== session.providerRoles[0] ||
    claims.roles.length !== 1 ||
    !equalStrings(claims.roles, session.providerRoles) ||
    !equalStrings(claims.permissions, session.providerPermissions)
  ) {
    unauthenticated();
  }
}

function tokenBinding(session: StaffSessionRecord) {
  return {
    sessionHash: session.sessionHash,
    staffIdentityId: session.staffIdentityId,
    workosSessionId: session.workosSessionId,
  };
}

type ErrorShape = {
  code?: unknown;
  error?: unknown;
  status?: unknown;
  response?: unknown;
  name?: unknown;
};

function isTerminalRefreshFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const shape = error as ErrorShape;
  if (shape.error === "invalid_grant") return true;
  if (shape.code === "invalid_grant") return true;
  if (typeof shape.response === "object" && shape.response !== null) {
    return (shape.response as { data?: { error?: unknown } }).data?.error === "invalid_grant";
  }
  return false;
}

async function refreshSession(
  session: StaffSessionRecord,
  dependencies: StaffDependencies,
  now: Date,
): Promise<StaffSessionRecord> {
  const leaseId = generateOpaqueSessionId();
  const acquired = await dependencies.sessions.tryAcquireRefresh({
    sessionHash: session.sessionHash,
    expectedVersion: session.refreshVersion,
    leaseId,
    now,
    leaseExpiresAt: new Date(
      now.getTime() + dependencies.config.refreshLeaseSeconds * 1_000,
    ),
  });
  if (!acquired) {
    const observations = dependencies.config.refreshLeaseSeconds * 10 + 1;
    for (let attempt = 0; attempt < observations; attempt += 1) {
      await dependencies.sleep(100);
      const observed = await dependencies.sessions.findByHash(session.sessionHash);
      if (!observed || observed.revokedAt !== null || observed.hardExpiresAt <= now) {
        unauthenticated();
      }
      if (
        observed.refreshVersion > session.refreshVersion &&
        observed.accessTokenExpiresAt > now
      ) {
        return observed;
      }
    }
    providerUnavailable();
  }

  try {
    const currentTokens = dependencies.sessionCrypto.decryptTokenBundle(
      acquired.encryptedTokens,
      tokenBinding(acquired),
    );
    const refreshedTokens = await dependencies.workos.authenticateWithRefreshToken({
      refreshToken: currentTokens.refreshToken,
      clientId: dependencies.config.clientId,
    });
    const claims = await dependencies.tokens.verify(refreshedTokens.accessToken);
    validateStoredClaims(claims, acquired, dependencies.config);
    if (
      claims.expiresAt <= now ||
      claims.authenticatedAt.getTime() !== acquired.authenticatedAt.getTime()
    ) {
      unauthenticated();
    }
    const encryptedTokens = dependencies.sessionCrypto.encryptTokenBundle(
      refreshedTokens,
      tokenBinding(acquired),
    );
    const completionTime = dependencies.clock.now();
    const completed = await dependencies.sessions.completeRefresh({
      sessionHash: acquired.sessionHash,
      leaseId,
      expectedVersion: acquired.refreshVersion,
      encryptedTokens,
      claims,
      now: completionTime,
    });
    if (
      !completed ||
      completed.revokedAt !== null ||
      completed.hardExpiresAt <= completionTime ||
      completed.accessTokenExpiresAt <= completionTime
    ) unauthenticated();
    return completed;
  } catch (error) {
    if (isTerminalRefreshFailure(error)) {
      await dependencies.sessions.revoke(session.sessionHash, now);
      unauthenticated();
    }
    await dependencies.sessions.releaseRefresh({
      sessionHash: session.sessionHash,
      leaseId,
      now,
    });
    if (error instanceof AppError) throw error;
    providerUnavailable();
  }
}

export async function authenticateStaff(
  request: FastifyRequest,
  dependencies: StaffDependencies,
): Promise<StaffActor> {
  if (rawHeaderValues(request, "authorization").length !== 0) unauthenticated();
  const names = staffCookieNames(dependencies.config.environment);
  const rawSession = oneCookie(request, names.session, true) as string;
  const sessionHash = hashOpaqueSessionId(rawSession);
  const now = dependencies.clock.now();
  let session = await dependencies.sessions.findByHash(sessionHash);
  if (!session || session.revokedAt !== null || session.hardExpiresAt <= now) {
    unauthenticated();
  }
  if (session.accessTokenExpiresAt <= new Date(now.getTime() + REFRESH_SKEW_MS)) {
    session = await refreshSession(session, dependencies, now);
  }
  if (session.revokedAt !== null || session.hardExpiresAt <= now) unauthenticated();
  let claims: WorkosAccessClaims;
  try {
    const tokens = dependencies.sessionCrypto.decryptTokenBundle(
      session.encryptedTokens,
      tokenBinding(session),
    );
    claims = await dependencies.tokens.verify(tokens.accessToken);
  } catch {
    unauthenticated();
  }
  validateStoredClaims(claims, session, dependencies.config);
  if (claims.expiresAt <= now) unauthenticated();
  const identity = await dependencies.identities.findStaffIdentityByWorkosUserId(
    claims.workosUserId,
  );
  if (!identity || identity.actorId !== session.staffIdentityId) unauthenticated();
  validateProviderIdentity(claims, identity, dependencies.config);
  const finalNow = dependencies.clock.now();
  if (session.hardExpiresAt <= finalNow || claims.expiresAt <= finalNow) {
    unauthenticated();
  }
  return Object.freeze({
    kind: "staff",
    actorId: identity.actorId,
    workosUserId: identity.workosUserId,
    staffId: identity.staffId,
    role: identity.role,
    permissions: Object.freeze([...identity.permissions]),
    authenticatedAt: new Date(claims.authenticatedAt),
  });
}

export async function beginStaffSignIn(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: StaffDependencies,
): Promise<FastifyReply> {
  const rawUrl = new URL(request.raw.url ?? "/", dependencies.config.webOrigin);
  const returnToValues = rawUrl.searchParams.getAll("returnTo");
  if (returnToValues.length > 1) invalidRequest();
  const returnTo = safeReturnTo(returnToValues[0], dependencies);
  const state = generateOpaqueSessionId();
  const browserNonce = generateOpaqueSessionId();
  const stateHash = hashOpaqueSessionId(state);
  const browserNonceHash = hashOpaqueSessionId(browserNonce);
  const names = staffCookieNames(dependencies.config.environment);
  const priorRawSession = oneCookie(request, names.session, false);
  const priorSessionHash =
    priorRawSession === null ? null : hashOpaqueSessionId(priorRawSession);
  if (priorSessionHash) {
    const priorSession = await dependencies.sessions.findByHash(priorSessionHash);
    const current = dependencies.clock.now();
    if (
      !priorSession ||
      priorSession.revokedAt !== null ||
      priorSession.hardExpiresAt <= current
    ) {
      unauthenticated();
    }
  }
  const authorization = await dependencies.workos.createAuthorizationUrl({
    state,
    clientId: dependencies.config.clientId,
    organizationId: dependencies.config.organizationId,
    redirectUri: dependencies.config.callbackUrl,
    ...(priorSessionHash === null ? {} : { maxAge: 0 }),
  });
  const now = dependencies.clock.now();
  const record: LoginAttemptRecord = {
    stateHash,
    browserNonceHash,
    encryptedCodeVerifier: dependencies.sessionCrypto.encryptSecret(
      authorization.codeVerifier,
      `syntholo-staff-login-v1:${stateHash.toString("base64url")}`,
    ),
    priorSessionHash,
    returnTo,
    expiresAt: new Date(
      now.getTime() + dependencies.config.loginAttemptTtlSeconds * 1_000,
    ),
    consumedAt: null,
    createdAt: now,
  };
  await dependencies.loginAttempts.create(record);
  void reply.header(
    "set-cookie",
    serializedCookie({
      name: names.login,
      value: browserNonce,
      secure: isSecureEnvironment(dependencies.config.environment),
      maxAge: dependencies.config.loginAttemptTtlSeconds,
    }),
  );
  return reply.redirect(authorization.url, 302);
}

function callbackParameters(request: FastifyRequest, webOrigin: string): {
  code: string;
  state: string;
} {
  const parameters = new URL(request.raw.url ?? "/", webOrigin).searchParams;
  const code = parameters.getAll("code");
  const state = parameters.getAll("state");
  const error = parameters.getAll("error");
  if (
    code.length !== 1 ||
    state.length !== 1 ||
    error.length !== 0 ||
    !code[0] ||
    !COOKIE_VALUE.test(state[0] ?? "")
  ) {
    invalidRequest();
  }
  return { code: code[0], state: state[0] as string };
}

export async function completeStaffSignIn(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: StaffDependencies,
): Promise<FastifyReply> {
  const names = staffCookieNames(dependencies.config.environment);
  const secure = isSecureEnvironment(dependencies.config.environment);
  void reply.header("set-cookie", clearCookie(names.login, secure));
  const { code, state } = callbackParameters(request, dependencies.config.webOrigin);
  const loginNonce = oneCookie(request, names.login, true) as string;
  const stateHash = hashOpaqueSessionId(state);
  const attempt = await dependencies.loginAttempts.consume({
    stateHash,
    browserNonceHash: hashOpaqueSessionId(loginNonce),
    now: dependencies.clock.now(),
  });
  if (!attempt) unauthenticated();
  const codeVerifier = dependencies.sessionCrypto.decryptSecret(
    attempt.encryptedCodeVerifier,
    `syntholo-staff-login-v1:${stateHash.toString("base64url")}`,
  );
  let tokens: { accessToken: string; refreshToken: string };
  let claims: WorkosAccessClaims;
  try {
    tokens = await dependencies.workos.authenticateWithCode({
      code,
      codeVerifier,
      clientId: dependencies.config.clientId,
    });
    claims = await dependencies.tokens.verify(tokens.accessToken);
  } catch {
    unauthenticated();
  }
  const identity = await dependencies.identities.findStaffIdentityByWorkosUserId(
    claims.workosUserId,
  );
  if (!identity) unauthenticated();
  validateProviderIdentity(claims, identity, dependencies.config);
  const now = dependencies.clock.now();
  const rawSession = generateOpaqueSessionId();
  const sessionHash = hashOpaqueSessionId(rawSession);
  const record: StaffSessionRecord = {
    sessionHash,
    staffIdentityId: identity.actorId,
    workosUserId: claims.workosUserId,
    workosSessionId: claims.workosSessionId,
    organizationId: claims.organizationId,
    providerRoles: Object.freeze([...claims.roles]),
    providerPermissions: Object.freeze([...claims.permissions]),
    encryptedTokens: { keyVersion: 0, iv: Buffer.alloc(0), ciphertext: Buffer.alloc(0), tag: Buffer.alloc(0) },
    accessTokenExpiresAt: claims.expiresAt,
    hardExpiresAt: new Date(now.getTime() + dependencies.config.sessionHardTtlSeconds * 1_000),
    authenticatedAt: claims.authenticatedAt,
    refreshVersion: 0,
    refreshLeaseId: null,
    refreshLeaseExpiresAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  record.encryptedTokens = dependencies.sessionCrypto.encryptTokenBundle(tokens, tokenBinding(record));

  const priorRawSession = oneCookie(request, names.session, false);
  if (attempt.priorSessionHash) {
    if (
      !priorRawSession ||
      !hashesEqual(hashOpaqueSessionId(priorRawSession), attempt.priorSessionHash)
    ) {
      unauthenticated();
    }
  }
  try {
    await dependencies.sessions.create(record, attempt.priorSessionHash);
  } catch {
    unauthenticated();
  }
  void reply.header("set-cookie", [
    clearCookie(names.login, secure),
    serializedCookie({
      name: names.session,
      value: rawSession,
      secure,
      maxAge: dependencies.config.sessionHardTtlSeconds,
    }),
  ]);
  return reply.redirect(attempt.returnTo, 302);
}

function requireUnsafeBrowserRequest(
  request: FastifyRequest,
  dependencies: StaffDependencies,
): void {
  const origins = rawHeaderValues(request, "origin");
  const csrf = rawHeaderValues(request, "x-syntholo-csrf");
  const contentTypes = rawHeaderValues(request, "content-type");
  if (
    origins.length !== 1 ||
    origins[0] !== dependencies.config.webOrigin ||
    csrf.length !== 1 ||
    csrf[0] !== "1" ||
    contentTypes.length !== 1 ||
    contentTypes[0]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new AppError("CSRF_REJECTED", 403, "Request rejected");
  }
}

export async function signOutStaff(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: StaffDependencies,
): Promise<FastifyReply> {
  requireUnsafeBrowserRequest(request, dependencies);
  const names = staffCookieNames(dependencies.config.environment);
  const rawSession = oneCookie(request, names.session, false);
  void reply.header(
    "set-cookie",
    clearCookie(names.session, isSecureEnvironment(dependencies.config.environment)),
  );
  if (rawSession) {
    const revoked = await dependencies.sessions.revoke(
      hashOpaqueSessionId(rawSession),
      dependencies.clock.now(),
    );
    if (revoked) {
      try {
        await dependencies.workos.revokeSession({ sessionId: revoked.workosSessionId });
      } catch {
        // Local revocation is authoritative; provider revocation is best effort.
      }
    }
  }
  return reply.status(204).send();
}

export function hashesEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
