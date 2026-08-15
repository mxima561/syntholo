import type { MemberActor, StaffActor } from "@syntholo/domain";
import type { ContentPublicationIssue } from "@syntholo/contracts/content";
import type {
  CompleteLessonRequest,
  CompleteLessonResponse,
  MemberCourseResponse,
  MemberLessonProgress,
  MemberLessonResponse,
  ResumeLessonRequest,
} from "@syntholo/contracts/learning";
import type {
  ArtifactDetailResponse,
  ArtifactListResponse,
  ArtifactVersionsResponse,
  SaveArtifactVersionRequest,
  SaveArtifactVersionResponse,
} from "@syntholo/contracts/implementation";
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
    access: {
      getEffectiveAccess(actor: MemberActor, parentDeadline?: number): Promise<unknown>;
    };
    dashboard?: {
      accounts: {
        getById(
          scope: Readonly<{ accountId: string }>,
          id: string,
          parentDeadline?: number,
        ): Promise<Readonly<{ id: string; name: string }> | null>;
      };
      clock: { now(): Date };
    };
    learning?: {
      getDashboardCourse(actor: MemberActor, correlationId: string, parentDeadline?: number): Promise<MemberCourseResponse | null>;
      getCourse(actor: MemberActor, correlationId: string, courseId: string, parentDeadline?: number): Promise<MemberCourseResponse>;
      getLesson(actor: MemberActor, correlationId: string, lessonId: string, parentDeadline?: number): Promise<MemberLessonResponse>;
      getPlaybackTarget(actor: MemberActor, correlationId: string, lessonId: string, parentDeadline?: number): Promise<Readonly<{
        lessonVersionId: string;
        durationSeconds: number;
        mediaState: "waiting" | "preparing" | "ready" | "errored" | "deleted";
        signedPlaybackId: string | null;
      }>>;
      resumeLesson(actor: MemberActor, correlationId: string, lessonId: string, input: ResumeLessonRequest, parentDeadline?: number): Promise<MemberLessonProgress>;
      completeLesson(actor: MemberActor, correlationId: string, lessonId: string, input: CompleteLessonRequest, idempotencyKey: string, parentDeadline?: number): Promise<CompleteLessonResponse>;
    };
    implementation?: {
      list(actor: MemberActor, correlationId: string, parentDeadline?: number): Promise<ArtifactListResponse>;
      get(actor: MemberActor, correlationId: string, artifactId: string, parentDeadline?: number): Promise<ArtifactDetailResponse>;
      versions(actor: MemberActor, correlationId: string, artifactId: string, input: Readonly<{ limit: number; cursor?: string }>, parentDeadline?: number): Promise<ArtifactVersionsResponse>;
      saveVersion(actor: MemberActor, correlationId: string, artifactId: string, input: SaveArtifactVersionRequest, idempotencyKey: string, parentDeadline?: number): Promise<SaveArtifactVersionResponse>;
    };
    playback?: {
      sign(input: Readonly<{ playbackId: string; durationSeconds: number; now: Date }>): Promise<Readonly<{
        playbackToken: string;
        thumbnailToken?: string;
        storyboardToken?: string;
        issuedAt: string;
        refreshAfter: string;
        expiresAt: string;
      }>>;
      clock: { now(): Date };
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
    content?: {
      derivePreview(input: Readonly<{
        actor: StaffActor;
        correlationId: string;
        courseId: string;
        draftRevision?: number;
      }>): Promise<Readonly<{
        draftRevision: number;
        candidateManifestHash: string;
        manifest: Readonly<Record<string, unknown>>;
        publicationIssues: readonly ContentPublicationIssue[];
      }>>;
      materializePreview(input: Readonly<{
        actor: StaffActor;
        correlationId: string;
        courseId: string;
        expectedVersion: number;
        reason: string;
        idempotencyKey: string;
      }>): Promise<Readonly<{
        previewId: string;
        manifestHash: string;
        manifest: Readonly<Record<string, unknown>>;
        publicationIssues: readonly ContentPublicationIssue[];
        createdAt: string;
      }>>;
      publishCourse(input: Readonly<{
        actor: StaffActor;
        correlationId: string;
        courseId: string;
        previewId: string;
        expectedManifestHash: string;
        expectedHeadRevision: number;
        reason: string;
        idempotencyKey: string;
      }>): Promise<Readonly<{
        id: string;
        courseId: string;
        version: number;
        manifestHash: string;
        headRevision: number;
        publishedAt: string;
      }>>;
      publishLesson(input: Readonly<{
        actor: StaffActor;
        correlationId: string;
        lessonId: string;
        expectedVersion: number;
        reason: string;
        idempotencyKey: string;
      }>): Promise<Readonly<{
        id: string;
        lessonId: string;
        courseId: string;
        version: number;
        contentHash: string;
        publishedAt: string;
      }>>;
    };
  };
}

export type AuthComposition =
  | { readonly kind: "enabled"; readonly dependencies: AuthRouteDependencies }
  | { readonly kind: "test-only-disabled" };
