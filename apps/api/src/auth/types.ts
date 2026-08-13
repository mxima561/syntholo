import type { MemberActor } from "@syntholo/domain";
import type { EncryptedValue, StaffSessionCrypto } from "./session-crypto.js";

export type AuthEnvironment = "local" | "test" | "staging" | "production";

export interface WorkosAccessClaims {
  workosUserId: string;
  workosSessionId: string;
  tokenId: string;
  clientId: string;
  organizationId: string;
  role: "coach" | "admin";
  roles: readonly string[];
  permissions: readonly string[];
  issuedAt: Date;
  authenticatedAt: Date;
  expiresAt: Date;
}

export interface StaffIdentityRecord {
  actorId: string;
  workosUserId: string;
  staffId: string;
  role: "coach" | "admin";
  permissions: readonly string[];
}

export interface LoginAttemptRecord {
  stateHash: Buffer;
  browserNonceHash: Buffer;
  encryptedCodeVerifier: EncryptedValue;
  priorSessionHash: Buffer | null;
  returnTo: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface StaffSessionRecord {
  sessionHash: Buffer;
  staffIdentityId: string;
  workosUserId: string;
  workosSessionId: string;
  organizationId: string;
  providerRoles: readonly string[];
  providerPermissions: readonly string[];
  encryptedTokens: EncryptedValue;
  accessTokenExpiresAt: Date;
  hardExpiresAt: Date;
  authenticatedAt: Date;
  refreshVersion: number;
  refreshLeaseId: string | null;
  refreshLeaseExpiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthRouteDependencies {
  member: {
    webOrigin: string;
    audience: string;
    authorizedParties: readonly string[];
    clerk: {
      authenticateRequest(
        request: Request,
        options: {
          acceptsToken: "session_token";
          audience: string;
          authorizedParties: readonly string[];
        },
      ): Promise<{
        userId: string;
        firstFactorVerifiedAt: Date | null;
        authorizedParty: string;
      } | null>;
    };
    identities: {
      findMemberActorByClerkUserId(
        clerkUserId: string,
      ): Promise<MemberActor | null>;
    };
  };
  staff: {
    config: {
      environment: AuthEnvironment;
      webOrigin: string;
      clientId: string;
      organizationId: string;
      callbackUrl: string;
      defaultReturnTo: string;
      allowedReturnToPrefixes: readonly string[];
      sessionHardTtlSeconds: number;
      loginAttemptTtlSeconds: number;
      refreshLeaseSeconds: number;
    };
    clock: { now(): Date };
    sessionCrypto: StaffSessionCrypto;
    loginAttempts: {
      create(record: LoginAttemptRecord): Promise<void>;
      consume(input: {
        stateHash: Buffer;
        browserNonceHash: Buffer;
        now: Date;
      }): Promise<LoginAttemptRecord | null>;
    };
    sessions: {
      create(
        record: StaffSessionRecord,
        expectedPriorSessionHash?: Buffer | null,
      ): Promise<void>;
      findByHash(sessionHash: Buffer): Promise<StaffSessionRecord | null>;
      tryAcquireRefresh(input: {
        sessionHash: Buffer;
        expectedVersion: number;
        leaseId: string;
        now: Date;
        leaseExpiresAt: Date;
      }): Promise<StaffSessionRecord | null>;
      completeRefresh(input: {
        sessionHash: Buffer;
        leaseId: string;
        expectedVersion: number;
        encryptedTokens: EncryptedValue;
        claims: WorkosAccessClaims;
        now: Date;
      }): Promise<StaffSessionRecord | null>;
      releaseRefresh(input: {
        sessionHash: Buffer;
        leaseId: string;
        now: Date;
      }): Promise<void>;
      revoke(
        sessionHash: Buffer,
        revokedAt: Date,
      ): Promise<{ workosSessionId: string } | null>;
    };
    identities: {
      findStaffIdentityByWorkosUserId(
        workosUserId: string,
      ): Promise<StaffIdentityRecord | null>;
    };
    tokens: { verify(token: string): Promise<WorkosAccessClaims> };
    workos: {
      createAuthorizationUrl(input: {
        state: string;
        clientId: string;
        organizationId: string;
        redirectUri: string;
        maxAge?: number;
      }): Promise<{ url: string; codeVerifier: string }>;
      authenticateWithCode(input: {
        code: string;
        codeVerifier: string;
        clientId: string;
      }): Promise<{ accessToken: string; refreshToken: string }>;
      authenticateWithRefreshToken(input: {
        refreshToken: string;
        clientId: string;
      }): Promise<{ accessToken: string; refreshToken: string }>;
      revokeSession(input: { sessionId: string }): Promise<void>;
    };
    sleep(milliseconds: number): Promise<void>;
  };
}

export type AuthComposition =
  | { readonly kind: "enabled"; readonly dependencies: AuthRouteDependencies }
  | { readonly kind: "test-only-disabled" };
