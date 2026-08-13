import type { MemberActor, StaffActor } from "@syntholo/domain";
import { memberActor, staffActor } from "@syntholo/testing";
import { describe, expect, it, vi } from "vitest";
import { buildApp, type ApiDependencies } from "../app.js";
import {
  authorize,
  requireAdmin,
  requireCoach,
  requireMember,
  requireRecentAuth,
} from "./authorize.js";
import {
  createStaffSessionCrypto,
  hashOpaqueSessionId,
  parseStaffSessionKeyRing,
} from "./session-crypto.js";
import type {
  AuthRouteDependencies,
  LoginAttemptRecord,
  StaffIdentityRecord,
  StaffSessionRecord,
  WorkosAccessClaims,
} from "./types.js";

const now = new Date("2026-08-13T12:00:00.000Z");
const key = Buffer.alloc(32, 4).toString("base64url");
const sessionCrypto = createStaffSessionCrypto(
  parseStaffSessionKeyRing(`1:${key}`),
);

const workosClaims = (
  patch: Partial<WorkosAccessClaims> = {},
): WorkosAccessClaims => ({
  workosUserId: "workos_user_staff",
  workosSessionId: "workos_session_staff",
  tokenId: "workos_token_staff",
  clientId: "client_staff",
  organizationId: "org_staff",
  role: "admin",
  roles: ["admin"],
  permissions: ["content:publish"],
  issuedAt: new Date(now.getTime() - 30_000),
  authenticatedAt: new Date(now.getTime() - 120_000),
  expiresAt: new Date(now.getTime() + 300_000),
  ...patch,
});

class MemoryLoginAttempts {
  readonly records: LoginAttemptRecord[] = [];

  async create(record: LoginAttemptRecord): Promise<void> {
    this.records.push(record);
  }

  async consume(input: {
    stateHash: Buffer;
    browserNonceHash: Buffer;
    now: Date;
  }): Promise<LoginAttemptRecord | null> {
    const record = this.records.find(
      (candidate) =>
        candidate.consumedAt === null &&
        candidate.expiresAt > input.now &&
        candidate.stateHash.equals(input.stateHash) &&
        candidate.browserNonceHash.equals(input.browserNonceHash),
    );
    if (!record) return null;
    record.consumedAt = input.now;
    return record;
  }
}

class MemoryStaffSessions {
  readonly records: StaffSessionRecord[] = [];

  async create(
    record: StaffSessionRecord,
    expectedPriorSessionHash: Buffer | null = null,
  ): Promise<void> {
    const existingIndex =
      expectedPriorSessionHash === null
        ? -1
        : this.records.findIndex((candidate) =>
            candidate.sessionHash.equals(expectedPriorSessionHash),
          );
    if (
      existingIndex >= 0 &&
      this.records[existingIndex]?.staffIdentityId === record.staffIdentityId &&
      this.records[existingIndex]?.workosUserId === record.workosUserId &&
      this.records[existingIndex]?.organizationId === record.organizationId &&
      this.records[existingIndex]?.revokedAt === null &&
      this.records[existingIndex]?.refreshLeaseId === null
    ) {
      this.records.splice(existingIndex, 1, record);
      return;
    }
    if (expectedPriorSessionHash !== null) {
      throw new Error("STAFF_SESSION_ROTATION_REJECTED");
    }
    const sameSidIndex = this.records.findIndex(
      (candidate) =>
        candidate.workosSessionId === record.workosSessionId &&
        candidate.revokedAt === null,
    );
    if (sameSidIndex >= 0) {
      this.records.splice(sameSidIndex, 1, record);
      return;
    }
    this.records.push(record);
  }

  async findByHash(sessionHash: Buffer): Promise<StaffSessionRecord | null> {
    return (
      this.records.find((record) => record.sessionHash.equals(sessionHash)) ??
      null
    );
  }

  async tryAcquireRefresh(input: {
    sessionHash: Buffer;
    expectedVersion: number;
    leaseId: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<StaffSessionRecord | null> {
    const record = await this.findByHash(input.sessionHash);
    if (
      !record ||
      record.refreshVersion !== input.expectedVersion ||
      (record.refreshLeaseExpiresAt !== null &&
        record.refreshLeaseExpiresAt > input.now)
    ) {
      return null;
    }
    record.refreshLeaseId = input.leaseId;
    record.refreshLeaseExpiresAt = input.leaseExpiresAt;
    return record;
  }

  async completeRefresh(input: {
    sessionHash: Buffer;
    leaseId: string;
    expectedVersion: number;
    encryptedTokens: StaffSessionRecord["encryptedTokens"];
    claims: WorkosAccessClaims;
    now: Date;
  }): Promise<StaffSessionRecord | null> {
    const record = await this.findByHash(input.sessionHash);
    if (
      !record ||
      record.refreshLeaseId !== input.leaseId ||
      record.refreshVersion !== input.expectedVersion ||
      record.revokedAt !== null ||
      record.refreshLeaseExpiresAt === null ||
      record.refreshLeaseExpiresAt <= input.now ||
      record.hardExpiresAt <= input.now
    ) {
      return null;
    }
    record.encryptedTokens = input.encryptedTokens;
    record.accessTokenExpiresAt = input.claims.expiresAt;
    record.authenticatedAt = input.claims.authenticatedAt;
    record.providerRoles = [...input.claims.roles];
    record.providerPermissions = [...input.claims.permissions];
    record.refreshVersion += 1;
    record.refreshLeaseId = null;
    record.refreshLeaseExpiresAt = null;
    record.updatedAt = input.now;
    return record;
  }

  async releaseRefresh(input: {
    sessionHash: Buffer;
    leaseId: string;
    now: Date;
  }): Promise<void> {
    const record = await this.findByHash(input.sessionHash);
    if (record?.refreshLeaseId === input.leaseId) {
      record.refreshLeaseId = null;
      record.refreshLeaseExpiresAt = null;
      record.updatedAt = input.now;
    }
  }

  async revoke(
    sessionHash: Buffer,
    revokedAt: Date,
  ): Promise<{ workosSessionId: string } | null> {
    const record = await this.findByHash(sessionHash);
    if (!record) return null;
    record.revokedAt ??= revokedAt;
    return { workosSessionId: record.workosSessionId };
  }
}

function authFakes(options: {
  environment?: "local" | "test" | "staging" | "production";
  member?: MemberActor | null;
  staff?: StaffIdentityRecord | null;
  claims?: WorkosAccessClaims;
} = {}) {
  const loginAttempts = new MemoryLoginAttempts();
  const staffSessions = new MemoryStaffSessions();
  const clerk = {
    authenticateRequest: vi.fn(async (request: Request) =>
      request.headers.get("authorization") === "Bearer clerk-member-token"
        ? {
            userId: "clerk_user_member",
            authenticatedAt: new Date(now.getTime() - 60_000),
            authorizedParty: "https://app.syntholo.test",
          }
        : null,
    ),
  };
  const createAuthorizationUrl = vi.fn(
    async (input: { state: string }) => ({
      url: `https://auth.syntholo.test/authorize?state=${input.state}`,
      codeVerifier: "v".repeat(64),
    }),
  );
  const authenticateWithCode = vi.fn(async () => ({
    accessToken: "workos-access-token",
    refreshToken: "workos-refresh-token",
  }));
  const authenticateWithRefreshToken = vi.fn(async () => ({
    accessToken: "workos-refreshed-access-token",
    refreshToken: "workos-refreshed-refresh-token",
  }));
  const revokeSession = vi.fn(async () => undefined);
  const claims = options.claims ?? workosClaims();
  const staffIdentity =
    options.staff === undefined
      ? {
          actorId: "staff_identity_1",
          workosUserId: "workos_user_staff",
          staffId: "staff_identity_1",
          role: "admin" as const,
          permissions: ["content:publish"],
        }
      : options.staff;
  const dependencies: AuthRouteDependencies = {
    member: {
      webOrigin: "https://app.syntholo.test",
      audience: "syntholo-member-api",
      authorizedParties: ["https://app.syntholo.test"],
      clerk,
      identities: {
        findMemberActorByClerkUserId: vi.fn(async () =>
          options.member === undefined
            ? memberActor({
                actorId: "member_identity_1",
                clerkUserId: "clerk_user_member",
                accountId: "00000000-0000-4000-8000-000000000001",
                membershipId: "00000000-0000-4000-8000-000000000002",
                authenticatedAt: new Date(now.getTime() - 60_000),
              })
            : options.member,
        ),
      },
    },
    staff: {
      config: {
        environment: options.environment ?? "production",
        webOrigin: "https://app.syntholo.test",
        clientId: "client_staff",
        organizationId: "org_staff",
        callbackUrl:
          "https://app.syntholo.test/v1/staff/auth/callback",
        defaultReturnTo: "/admin",
        allowedReturnToPrefixes: ["/admin", "/coach"],
        sessionHardTtlSeconds: 3_600,
        loginAttemptTtlSeconds: 300,
        refreshLeaseSeconds: 5,
      },
      clock: { now: () => now },
      sessionCrypto,
      loginAttempts,
      sessions: staffSessions,
      identities: {
        findStaffIdentityByWorkosUserId: vi.fn(async () => staffIdentity),
      },
      tokens: {
        verify: vi.fn(async (token: string) => {
          if (
            token !== "workos-access-token" &&
            token !== "workos-refreshed-access-token"
          ) {
            throw new Error("WORKOS_TOKEN_INVALID");
          }
          return claims;
        }),
      },
      workos: {
        createAuthorizationUrl,
        authenticateWithCode,
        authenticateWithRefreshToken,
        revokeSession,
      },
      sleep: async () => undefined,
    },
  };

  return {
    dependencies,
    clerk,
    loginAttempts,
    staffSessions,
    createAuthorizationUrl,
    authenticateWithCode,
    authenticateWithRefreshToken,
    revokeSession,
    claims,
    staffIdentity,
  };
}

function appDependencies(auth: AuthRouteDependencies): ApiDependencies {
  return {
    releaseSha: "test",
    logger: false,
    health: { dependencies: [] },
    auth: { kind: "enabled", dependencies: auth },
  };
}

async function createStoredSession(
  fakes: ReturnType<typeof authFakes>,
  input: {
    rawCookie?: string;
    accessTokenExpiresAt?: Date;
    revokedAt?: Date | null;
    hardExpiresAt?: Date;
  } = {},
): Promise<string> {
  const rawCookie = input.rawCookie ?? Buffer.alloc(32, 9).toString("base64url");
  const sessionHash = hashOpaqueSessionId(rawCookie);
  const encryptedTokens = sessionCrypto.encryptTokenBundle(
    {
      accessToken: "workos-access-token",
      refreshToken: "workos-refresh-token",
    },
    {
      sessionHash,
      staffIdentityId: "staff_identity_1",
      workosSessionId: "workos_session_staff",
    },
  );
  await fakes.staffSessions.create({
    sessionHash,
    staffIdentityId: "staff_identity_1",
    workosUserId: "workos_user_staff",
    workosSessionId: "workos_session_staff",
    organizationId: "org_staff",
    providerRoles: ["admin"],
    providerPermissions: ["content:publish"],
    encryptedTokens,
    accessTokenExpiresAt:
      input.accessTokenExpiresAt ?? new Date(now.getTime() + 300_000),
    hardExpiresAt: input.hardExpiresAt ?? new Date(now.getTime() + 3_600_000),
    authenticatedAt: new Date(now.getTime() - 120_000),
    refreshVersion: 0,
    refreshLeaseId: null,
    refreshLeaseExpiresAt: null,
    revokedAt: input.revokedAt ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return rawCookie;
}

describe("separate member and staff authentication", () => {
  it("maps one Clerk bearer through the active database identity", async () => {
    const fakes = authFakes();
    const app = await buildApp(appDependencies(fakes.dependencies));

    const response = await app.inject({
      url: "/v1/member/whoami",
      headers: { authorization: "Bearer clerk-member-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: "member",
      clerkUserId: "clerk_user_member",
      accountId: "00000000-0000-4000-8000-000000000001",
      membershipId: "00000000-0000-4000-8000-000000000002",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.vary).toContain("Authorization");
    expect(fakes.clerk.authenticateRequest).toHaveBeenCalledWith(
      expect.any(Request),
      {
        acceptsToken: "session_token",
        audience: "syntholo-member-api",
        authorizedParties: ["https://app.syntholo.test"],
      },
    );
    await app.close();
  });

  it.each([
    ["anonymous", {}],
    ["WorkOS token", { authorization: "Bearer workos-access-token" }],
    [
      "staff cookie",
      { cookie: "__Host-syntholo_staff_session=opaque-staff" },
    ],
    [
      "mixed member and staff credentials",
      {
        authorization: "Bearer clerk-member-token",
        cookie: "__Host-syntholo_staff_session=opaque-staff",
      },
    ],
  ])("rejects %s on the member boundary", async (_case, headers) => {
    const fakes = authFakes();
    const app = await buildApp(appDependencies(fakes.dependencies));
    const response = await app.inject({
      url: "/v1/member/whoami",
      headers,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHENTICATED");
    await app.close();
  });

  it("rejects Clerk cookie-only and duplicate bearer credentials", async () => {
    const fakes = authFakes();
    const app = await buildApp(appDependencies(fakes.dependencies));
    const cookieOnly = await app.inject({
      url: "/v1/member/whoami",
      headers: { cookie: "__session=clerk-member-token" },
    });
    const duplicate = await app.inject({
      url: "/v1/member/whoami",
      headers: {
        authorization:
          "Bearer clerk-member-token, Bearer clerk-member-token",
      },
    });
    expect(cookieOnly.statusCode).toBe(401);
    expect(duplicate.statusCode).toBe(401);
    expect(fakes.clerk.authenticateRequest).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an unknown or inactive internal member identity", async () => {
    const fakes = authFakes({ member: null });
    const app = await buildApp(appDependencies(fakes.dependencies));
    const response = await app.inject({
      url: "/v1/member/whoami",
      headers: { authorization: "Bearer clerk-member-token" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.payload).not.toContain("clerk_user_member");
    await app.close();
  });

  it("accepts only the exact opaque staff cookie on staff routes", async () => {
    const fakes = authFakes();
    const cookie = await createStoredSession(fakes);
    const app = await buildApp(appDependencies(fakes.dependencies));

    const response = await app.inject({
      url: "/v1/staff/whoami",
      headers: { cookie: `__Host-syntholo_staff_session=${cookie}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      kind: "staff",
      actorId: "staff_identity_1",
      workosUserId: "workos_user_staff",
      staffId: "staff_identity_1",
      role: "admin",
      permissions: ["content:publish"],
      authenticatedAt: "2026-08-13T11:58:00.000Z",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.vary).toContain("Cookie");
    await app.close();
  });

  it("rechecks expiry with a fresh clock after provider and identity I/O", async () => {
    const fakes = authFakes();
    const cookie = await createStoredSession(fakes, {
      hardExpiresAt: new Date(now.getTime() + 1_000),
    });
    fakes.dependencies.staff.clock.now = vi
      .fn()
      .mockReturnValueOnce(now)
      .mockReturnValue(new Date(now.getTime() + 2_000));
    const app = await buildApp(appDependencies(fakes.dependencies));
    const response = await app.inject({
      url: "/v1/staff/whoami",
      headers: { cookie: `__Host-syntholo_staff_session=${cookie}` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it.each([
    ["anonymous", {}],
    ["raw WorkOS bearer", { authorization: "Bearer workos-access-token" }],
    ["Clerk bearer", { authorization: "Bearer clerk-member-token" }],
    [
      "mixed bearer and cookie",
      {
        authorization: "Bearer clerk-member-token",
        cookie: `__Host-syntholo_staff_session=${Buffer.alloc(32, 9).toString("base64url")}`,
      },
    ],
    [
      "duplicate cookie",
      {
        cookie:
          "__Host-syntholo_staff_session=a; __Host-syntholo_staff_session=b",
      },
    ],
  ])("rejects %s on the staff boundary", async (_case, headers) => {
    const fakes = authFakes();
    const app = await buildApp(appDependencies(fakes.dependencies));
    const response = await app.inject({
      url: "/v1/staff/whoami",
      headers,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHENTICATED");
    await app.close();
  });

  it("rejects token/database role or permission disagreement", async () => {
    const fakes = authFakes({
      staff: {
        actorId: "staff_identity_1",
        workosUserId: "workos_user_staff",
        staffId: "staff_identity_1",
        role: "coach",
        permissions: [],
      },
    });
    const cookie = await createStoredSession(fakes);
    const app = await buildApp(appDependencies(fakes.dependencies));
    const response = await app.inject({
      url: "/v1/staff/whoami",
      headers: { cookie: `__Host-syntholo_staff_session=${cookie}` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("staff OAuth transaction and browser controls", () => {
  it.each([
    ["production", "__Host-syntholo_staff_login", true],
    ["local", "syntholo_local_staff_login", false],
  ] as const)(
    "uses a one-time PKCE attempt and %s host-only cookie",
    async (environment, loginCookieName, secure) => {
      const fakes = authFakes({ environment });
      const app = await buildApp(appDependencies(fakes.dependencies));
      const signIn = await app.inject({
        url: "/v1/staff/auth/sign-in?returnTo=%2Fadmin%2Fcontent",
      });

      expect(signIn.statusCode).toBe(302);
      expect(signIn.headers.location).toMatch(
        /^https:\/\/auth\.syntholo\.test\/authorize\?state=/u,
      );
      const loginCookie = String(signIn.headers["set-cookie"]);
      expect(loginCookie).toContain(`${loginCookieName}=`);
      expect(loginCookie).toContain("HttpOnly");
      expect(loginCookie).toContain("SameSite=Lax");
      expect(loginCookie).toContain("Path=/");
      expect(loginCookie.includes("Secure")).toBe(secure);
      expect(loginCookie).not.toContain("Domain=");
      expect(fakes.loginAttempts.records).toHaveLength(1);
      expect(fakes.loginAttempts.records[0]?.stateHash).toHaveLength(32);
      expect(fakes.loginAttempts.records[0]?.browserNonceHash).toHaveLength(32);
      expect(fakes.loginAttempts.records[0]?.encryptedCodeVerifier.ciphertext)
        .not.toContain(Buffer.from("v".repeat(32)));

      const state = new URL(String(signIn.headers.location)).searchParams.get(
        "state",
      );
      const cookiePair = loginCookie.split(";", 1)[0];
      const callback = await app.inject({
        url: `/v1/staff/auth/callback?code=code_staff&state=${state}`,
        headers: { cookie: cookiePair },
      });

      expect(callback.statusCode).toBe(302);
      expect(callback.headers["referrer-policy"]).toBe("no-referrer");
      expect(callback.headers.location).toBe("/admin/content");
      const callbackCookies = callback.headers["set-cookie"];
      const serialized = Array.isArray(callbackCookies)
        ? callbackCookies.join("\n")
        : String(callbackCookies);
      const sessionCookieName =
        environment === "production"
          ? "__Host-syntholo_staff_session"
          : "syntholo_local_staff_session";
      expect(serialized).toContain(`${sessionCookieName}=`);
      expect(serialized).toContain(`${loginCookieName}=;`);
      expect(serialized).not.toContain("workos-access-token");
      expect(serialized).not.toContain("workos-refresh-token");
      expect(serialized).not.toContain("Domain=");
      expect(fakes.staffSessions.records).toHaveLength(1);
      expect(fakes.loginAttempts.records[0]?.consumedAt).toEqual(now);

      const replay = await app.inject({
        url: `/v1/staff/auth/callback?code=code_staff&state=${state}`,
        headers: { cookie: cookiePair },
      });
      expect(replay.statusCode).toBe(401);
      expect(fakes.authenticateWithCode).toHaveBeenCalledTimes(1);
      await app.close();
    },
  );

  it("rejects an expired login attempt before code exchange", async () => {
    const fakes = authFakes();
    const app = await buildApp(appDependencies(fakes.dependencies));
    const signIn = await app.inject({ url: "/v1/staff/auth/sign-in" });
    const state = new URL(String(signIn.headers.location)).searchParams.get("state");
    const cookiePair = String(signIn.headers["set-cookie"]).split(";", 1)[0];
    const attempt = fakes.loginAttempts.records[0];
    if (!attempt) throw new Error("LOGIN_ATTEMPT_MISSING");
    attempt.expiresAt = now;
    const callback = await app.inject({
      url: `/v1/staff/auth/callback?code=code_staff&state=${state}`,
      headers: { cookie: cookiePair },
    });
    expect(callback.statusCode).toBe(401);
    expect(fakes.authenticateWithCode).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    "/%2Fattacker.test",
    "//attacker.test/path",
    "https://attacker.test/path",
    "/not-allowed",
  ])("rejects open return redirect %s", async (returnTo) => {
    const fakes = authFakes();
    const app = await buildApp(appDependencies(fakes.dependencies));
    const response = await app.inject({
      url: `/v1/staff/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`,
    });
    expect(response.statusCode).toBe(400);
    expect(fakes.createAuthorizationUrl).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    "/v1/staff/auth/callback?code=one&code=two&state=state",
    "/v1/staff/auth/callback?code=one&state=one&state=two",
    "/v1/staff/auth/callback?error=access_denied&state=state",
  ])("rejects terminal callback input and clears login state", async (url) => {
    const fakes = authFakes();
    const app = await buildApp(appDependencies(fakes.dependencies));
    const response = await app.inject({ url });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(String(response.headers["set-cookie"])).toContain(
      "__Host-syntholo_staff_login=;",
    );
    expect(fakes.authenticateWithCode).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["missing origin", {}],
    ["wrong origin", { origin: "https://attacker.test" }],
    ["missing CSRF", { origin: "https://app.syntholo.test" }],
    [
      "simple content type",
      {
        origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1",
        "content-type": "text/plain",
      },
    ],
  ])("rejects unsafe staff sign-out with %s", async (_case, headers) => {
    const fakes = authFakes();
    const cookie = await createStoredSession(fakes);
    const app = await buildApp(appDependencies(fakes.dependencies));
    const response = await app.inject({
      method: "POST",
      url: "/v1/staff/auth/sign-out",
      headers: {
        cookie: `__Host-syntholo_staff_session=${cookie}`,
        ...headers,
      },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(fakes.revokeSession).not.toHaveBeenCalled();
    await app.close();
  });

  it("revokes locally and clears the exact cookie before provider sign-out", async () => {
    const fakes = authFakes();
    const cookie = await createStoredSession(fakes);
    fakes.revokeSession.mockRejectedValueOnce(
      new Error("provider-secret-timeout"),
    );
    const app = await buildApp(appDependencies(fakes.dependencies));
    const response = await app.inject({
      method: "POST",
      url: "/v1/staff/auth/sign-out",
      headers: {
        cookie: `__Host-syntholo_staff_session=${cookie}`,
        origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1",
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers["set-cookie"])).toContain(
      "__Host-syntholo_staff_session=;",
    );
    expect(String(response.headers["set-cookie"])).toContain("Secure");
    expect(String(response.headers["set-cookie"])).toContain("Path=/");
    expect(String(response.headers["set-cookie"])).not.toContain("Domain=");
    expect(fakes.staffSessions.records[0]?.revokedAt).toEqual(now);
    expect(response.payload).not.toContain("provider-secret");
    await app.close();
  });

  it("keeps sign-out idempotent for an already revoked cookie", async () => {
    const fakes = authFakes();
    const cookie = await createStoredSession(fakes);
    const app = await buildApp(appDependencies(fakes.dependencies));
    const request = {
      method: "POST" as const,
      url: "/v1/staff/auth/sign-out",
      headers: {
        cookie: `__Host-syntholo_staff_session=${cookie}`,
        origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1",
        "content-type": "application/json",
      },
      payload: {},
    };
    expect((await app.inject(request)).statusCode).toBe(204);
    expect((await app.inject(request)).statusCode).toBe(204);
    await app.close();
  });

  it("rotates an authenticated reauth session and fences sign-out", async () => {
    const fakes = authFakes();
    const oldCookie = await createStoredSession(fakes);
    const app = await buildApp(appDependencies(fakes.dependencies));
    const signIn = await app.inject({
      url: "/v1/staff/auth/sign-in",
      headers: { cookie: `__Host-syntholo_staff_session=${oldCookie}` },
    });
    expect(fakes.createAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({ maxAge: 0 }),
    );
    const loginPair = String(signIn.headers["set-cookie"]).split(";", 1)[0];
    const state = new URL(String(signIn.headers.location)).searchParams.get("state");
    const callback = await app.inject({
      url: `/v1/staff/auth/callback?code=code_staff&state=${state}`,
      headers: {
        cookie: `${loginPair}; __Host-syntholo_staff_session=${oldCookie}`,
      },
    });
    expect(callback.statusCode).toBe(302);
    const cookies = Array.isArray(callback.headers["set-cookie"])
      ? callback.headers["set-cookie"]
      : [String(callback.headers["set-cookie"])];
    const newCookie = cookies
      .find((value) => value.startsWith("__Host-syntholo_staff_session="))
      ?.split(";", 1)[0]
      ?.split("=", 2)[1];
    expect(newCookie).toBeTruthy();
    expect(
      (await app.inject({
        url: "/v1/staff/whoami",
        headers: { cookie: `__Host-syntholo_staff_session=${oldCookie}` },
      })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({
        url: "/v1/staff/whoami",
        headers: { cookie: `__Host-syntholo_staff_session=${newCookie}` },
      })).statusCode,
    ).toBe(200);
    await app.close();
  });

  it("rotates the opaque cookie when reauth returns a new WorkOS session", async () => {
    const fakes = authFakes({
      claims: workosClaims({ workosSessionId: "workos_session_reauthenticated" }),
    });
    const oldCookie = await createStoredSession(fakes);
    const app = await buildApp(appDependencies(fakes.dependencies));
    const signIn = await app.inject({
      url: "/v1/staff/auth/sign-in",
      headers: { cookie: `__Host-syntholo_staff_session=${oldCookie}` },
    });
    const state = new URL(String(signIn.headers.location)).searchParams.get("state");
    const loginPair = String(signIn.headers["set-cookie"]).split(";", 1)[0];
    const callback = await app.inject({
      url: `/v1/staff/auth/callback?code=code_staff&state=${state}`,
      headers: { cookie: `${loginPair}; __Host-syntholo_staff_session=${oldCookie}` },
    });

    expect(callback.statusCode).toBe(302);
    expect(fakes.staffSessions.records[0]?.workosSessionId).toBe(
      "workos_session_reauthenticated",
    );
    const callbackCookies = Array.isArray(callback.headers["set-cookie"])
      ? callback.headers["set-cookie"]
      : [String(callback.headers["set-cookie"])];
    const newCookie = callbackCookies
      .find((value) => value.startsWith("__Host-syntholo_staff_session="))
      ?.split(";", 1)[0]
      ?.split("=", 2)[1];
    expect(
      (await app.inject({
        url: "/v1/staff/whoami",
        headers: { cookie: `__Host-syntholo_staff_session=${oldCookie}` },
      })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({
        url: "/v1/staff/whoami",
        headers: { cookie: `__Host-syntholo_staff_session=${newCookie}` },
      })).statusCode,
    ).toBe(200);
    await app.close();
  });

  it("recovers the same WorkOS session after only the local cookie is lost", async () => {
    const fakes = authFakes();
    const lostCookie = await createStoredSession(fakes);
    const app = await buildApp(appDependencies(fakes.dependencies));
    const signIn = await app.inject({ url: "/v1/staff/auth/sign-in" });
    const state = new URL(String(signIn.headers.location)).searchParams.get("state");
    const loginPair = String(signIn.headers["set-cookie"]).split(";", 1)[0];
    const callback = await app.inject({
      url: `/v1/staff/auth/callback?code=code_staff&state=${state}`,
      headers: { cookie: loginPair },
    });
    const callbackCookies = Array.isArray(callback.headers["set-cookie"])
      ? callback.headers["set-cookie"]
      : [String(callback.headers["set-cookie"])];
    const replacement = callbackCookies
      .find((value) => value.startsWith("__Host-syntholo_staff_session="))
      ?.split(";", 1)[0]
      ?.split("=", 2)[1];

    expect(callback.statusCode).toBe(302);
    expect(
      (await app.inject({
        url: "/v1/staff/whoami",
        headers: { cookie: `__Host-syntholo_staff_session=${lostCookie}` },
      })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({
        url: "/v1/staff/whoami",
        headers: { cookie: `__Host-syntholo_staff_session=${replacement}` },
      })).statusCode,
    ).toBe(200);
    await app.close();
  });

  it("lets sign-out fence an outstanding reauth callback", async () => {
    const fakes = authFakes();
    const oldCookie = await createStoredSession(fakes);
    const app = await buildApp(appDependencies(fakes.dependencies));
    const signIn = await app.inject({
      url: "/v1/staff/auth/sign-in",
      headers: { cookie: `__Host-syntholo_staff_session=${oldCookie}` },
    });
    const state = new URL(String(signIn.headers.location)).searchParams.get("state");
    const loginPair = String(signIn.headers["set-cookie"]).split(";", 1)[0];
    expect(
      (await app.inject({
        method: "POST",
        url: "/v1/staff/auth/sign-out",
        headers: {
          cookie: `__Host-syntholo_staff_session=${oldCookie}`,
          origin: "https://app.syntholo.test",
          "x-syntholo-csrf": "1",
          "content-type": "application/json",
        },
        payload: {},
      })).statusCode,
    ).toBe(204);
    const callback = await app.inject({
      url: `/v1/staff/auth/callback?code=code_staff&state=${state}`,
      headers: { cookie: `${loginPair}; __Host-syntholo_staff_session=${oldCookie}` },
    });
    expect(callback.statusCode).toBe(401);
    expect(fakes.staffSessions.records[0]?.revokedAt).toEqual(now);
    await app.close();
  });

  it("refreshes once with CAS and treats real WorkOS invalid_grant as terminal", async () => {
    const fakes = authFakes();
    const cookie = await createStoredSession(fakes, {
      accessTokenExpiresAt: new Date(now.getTime() - 1),
    });
    const app = await buildApp(appDependencies(fakes.dependencies));
    const refreshed = await app.inject({
      url: "/v1/staff/whoami",
      headers: { cookie: `__Host-syntholo_staff_session=${cookie}` },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(fakes.staffSessions.records[0]?.refreshVersion).toBe(1);
    await app.close();

    const terminal = authFakes();
    const terminalCookie = await createStoredSession(terminal, {
      accessTokenExpiresAt: new Date(now.getTime() - 1),
    });
    terminal.authenticateWithRefreshToken.mockRejectedValueOnce(
      Object.assign(new Error("provider detail"), { error: "invalid_grant" }),
    );
    const terminalApp = await buildApp(appDependencies(terminal.dependencies));
    const denied = await terminalApp.inject({
      url: "/v1/staff/whoami",
      headers: { cookie: `__Host-syntholo_staff_session=${terminalCookie}` },
    });
    expect(denied.statusCode).toBe(401);
    expect(terminal.staffSessions.records[0]?.revokedAt).toEqual(now);
    expect(denied.payload).not.toContain("provider detail");
    await terminalApp.close();
  });

  it("cannot complete an in-flight refresh after local sign-out", async () => {
    const fakes = authFakes();
    const cookie = await createStoredSession(fakes, {
      accessTokenExpiresAt: new Date(now.getTime() - 1),
    });
    let resolveRefresh!: (tokens: { accessToken: string; refreshToken: string }) => void;
    fakes.authenticateWithRefreshToken.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRefresh = resolve; }),
    );
    const app = await buildApp(appDependencies(fakes.dependencies));
    const refreshing = app.inject({
      url: "/v1/staff/whoami",
      headers: { cookie: `__Host-syntholo_staff_session=${cookie}` },
    });
    await vi.waitFor(() => {
      expect(fakes.authenticateWithRefreshToken).toHaveBeenCalledTimes(1);
    });
    const signedOut = await app.inject({
      method: "POST",
      url: "/v1/staff/auth/sign-out",
      headers: {
        cookie: `__Host-syntholo_staff_session=${cookie}`,
        origin: "https://app.syntholo.test",
        "x-syntholo-csrf": "1",
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(signedOut.statusCode).toBe(204);
    resolveRefresh({
      accessToken: "workos-refreshed-access-token",
      refreshToken: "workos-refreshed-refresh-token",
    });
    expect((await refreshing).statusCode).toBe(401);
    expect(fakes.staffSessions.records[0]?.revokedAt).toEqual(now);
    await app.close();
  });

  it("never lets refresh advance auth_time into recent authentication", async () => {
    const fakes = authFakes({
      claims: workosClaims({ authenticatedAt: new Date(now.getTime() - 10_000) }),
    });
    const cookie = await createStoredSession(fakes, {
      accessTokenExpiresAt: new Date(now.getTime() - 1),
    });
    const app = await buildApp(appDependencies(fakes.dependencies));
    const response = await app.inject({
      url: "/v1/staff/whoami",
      headers: { cookie: `__Host-syntholo_staff_session=${cookie}` },
    });
    expect(response.statusCode).toBe(401);
    expect(fakes.staffSessions.records[0]?.authenticatedAt).toEqual(
      new Date(now.getTime() - 120_000),
    );
    await app.close();
  });

  it.each([
    ["network", new Error("network-token-secret")],
    ["timeout", Object.assign(new Error("timeout-token-secret"), { status: 408 })],
    ["rate limit", Object.assign(new Error("rate-token-secret"), { status: 429 })],
    ["provider 5xx", Object.assign(new Error("provider-token-secret"), { status: 503 })],
  ])("preserves the local session on transient %s refresh failure", async (_case, failure) => {
    const fakes = authFakes();
    const cookie = await createStoredSession(fakes, {
      accessTokenExpiresAt: new Date(now.getTime() - 1),
    });
    fakes.authenticateWithRefreshToken.mockRejectedValueOnce(failure);
    const app = await buildApp(appDependencies(fakes.dependencies));
    const response = await app.inject({
      url: "/v1/staff/whoami",
      headers: { cookie: `__Host-syntholo_staff_session=${cookie}` },
    });
    expect(response.statusCode).toBe(503);
    expect(fakes.staffSessions.records[0]?.revokedAt).toBeNull();
    expect(response.payload).not.toContain("token-secret");
    await app.close();
  });

  it("does not emit callback credentials in production request logs", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fakes = authFakes();
    const app = await buildApp({ ...appDependencies(fakes.dependencies), logger: true });
    await app.inject({
      url: "/v1/staff/auth/callback?code=callback-code-secret&state=callback-state-secret",
      headers: { cookie: "provider-cookie-secret=value" },
    });
    const output = stdout.mock.calls.flat().join("\n");
    expect(output).not.toContain("callback-code-secret");
    expect(output).not.toContain("callback-state-secret");
    expect(output).not.toContain("provider-cookie-secret");
    stdout.mockRestore();
    await app.close();
  });

  it("does not emit credentialed browser CORS", async () => {
    const fakes = authFakes();
    const app = await buildApp(appDependencies(fakes.dependencies));
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/staff/whoami",
      headers: { origin: "https://app.syntholo.test" },
    });
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});

describe("authorization and recent authentication", () => {
  it.each([
    [memberActor({ role: "teammate" }), { role: "owner" as const }],
    [staffActor({ role: "coach" }), { role: "admin" as const }],
    [
      staffActor({ role: "admin", permissions: [] }),
      { permission: "content:publish" },
    ],
  ])("denies an actor outside route authorization", (actor, requirement) => {
    expect(() => authorize(actor, requirement)).toThrow("FORBIDDEN");
  });

  it("returns immutable, narrowed actor projections", () => {
    const member = requireMember(memberActor());
    const coach = requireCoach(staffActor({ role: "coach" }));
    const admin = requireAdmin(staffActor({ role: "admin" }));
    expect(Object.isFrozen(member)).toBe(true);
    expect(Object.isFrozen(coach)).toBe(true);
    expect(Object.isFrozen(admin.permissions)).toBe(true);
  });

  it.each([
    [new Date(now.getTime() - 301_000), "stale"],
    [undefined, "missing"],
    [new Date("invalid"), "invalid"],
  ])("rejects %s authentication time", (authenticatedAt, _case) => {
    void _case;
    const actor = {
      ...staffActor({ role: "admin" }),
      authenticatedAt,
    } as unknown as StaffActor;
    expect(() => requireRecentAuth(actor, 300, now)).toThrow(
      "RECENT_AUTH_REQUIRED",
    );
  });

  it("uses auth_time recency rather than refreshed token issue time", () => {
    const actor = staffActor({
      role: "admin",
      authenticatedAt: new Date(now.getTime() - 299_000),
    });
    const narrowed = requireRecentAuth(actor, 300, now);
    expect(narrowed).toEqual(actor);
    expect(narrowed).not.toBe(actor);
    expect(Object.isFrozen(narrowed)).toBe(true);
  });
});
