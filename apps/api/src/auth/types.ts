import type { MemberActor, StaffActor } from "@syntholo/domain";
import type { ContentPublicationIssue, LessonBlock, Transcript } from "@syntholo/contracts/content";
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
import type {
  CertificateDeliveryResponse,
  CertificateListResponse,
  CertificateRecipientNameResponse,
  ConfirmCertificateRecipientNameRequest,
  CreateCertificateDeliveryRequest,
} from "@syntholo/contracts/learning";
import type { CertificateDownloadFence } from "@syntholo/database";
import type { PrivateCertificateBlobStore } from "@syntholo/integrations";
import type { EncryptedValue, StaffSessionCrypto } from "./session-crypto.js";

export type AuthEnvironment = "local" | "test" | "staging" | "production";

export interface AccessAccessClaims {
  accessUserId: string;
  accessSessionId: string;
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
  accessUserId: string;
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
  accessUserId: string;
  accessSessionId: string;
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
    certificates?: {
      getRecipientName(actor: MemberActor, correlationId: string, parentDeadline?: number): Promise<CertificateRecipientNameResponse>;
      confirmRecipientName(actor: MemberActor, correlationId: string, input: ConfirmCertificateRecipientNameRequest, idempotencyKey: string, parentDeadline?: number): Promise<CertificateRecipientNameResponse>;
      list(actor: MemberActor, correlationId: string, input: Readonly<{ limit: number; cursor?: string }>, parentDeadline?: number): Promise<CertificateListResponse>;
      downloadFence(actor: MemberActor, correlationId: string, certificateId: string, parentDeadline?: number): Promise<CertificateDownloadFence>;
    };
    certificateBlob?: Pick<PrivateCertificateBlobStore, "download">;
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
        claims: AccessAccessClaims;
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
      ): Promise<{ accessSessionId: string } | null>;
    };
    identities: {
      findStaffIdentityByAccessUserId(
        accessUserId: string,
      ): Promise<StaffIdentityRecord | null>;
    };
    tokens: { verify(token: string): Promise<AccessAccessClaims> };
    access: {
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
    certificates?: {
      createDelivery(actor: StaffActor, correlationId: string, certificateId: string, input: CreateCertificateDeliveryRequest, idempotencyKey: string, parentDeadline?: number): Promise<CertificateDeliveryResponse>;
    };
    contentAuthoring?: {
      listCourses(input: Readonly<{ actor: StaffActor; correlationId: string }>): Promise<readonly Readonly<{
        courseId: string; slug: string; title: string; description: string;
        revision: number; published: boolean; createdAt: string; enrolledCount: number;
      }>[]>;
      createCourseDraft(input: Readonly<{
        actor: StaffActor; correlationId: string;
        slug: string; title: string; description: string; idempotencyKey: string;
      }>): Promise<Readonly<{
        courseId: string; slug: string; title: string; description: string;
        revision: number; createdAt: string;
      }>>;
      upsertStageDraft(input: Readonly<{
        actor: StaffActor; correlationId: string;
        courseId: string; stageId?: string; expectedCourseRevision: number;
        slug: string; title: string; description: string; order: number; idempotencyKey: string;
      }>): Promise<Readonly<{
        stageId: string; courseId: string; slug: string; title: string; description: string;
        order: number; revision: number;
      }>>;
      upsertLessonDraft(input: Readonly<{
        actor: StaffActor; correlationId: string;
        courseId: string; stageId: string; lessonId?: string;
        slug: string; title: string; summary: string; durationSeconds: number;
        blocks: readonly LessonBlock[]; transcript: Transcript;
        order: number; required: boolean; idempotencyKey: string;
      }>): Promise<Readonly<{
        lessonId: string; courseId: string; stageId: string; slug: string;
        revision: number; mediaAssetId: string; order: number; required: boolean;
      }>>;
      recordLessonReview(input: Readonly<{
        actor: StaffActor; correlationId: string;
        lessonId: string; expectedRevision: number; reason: string;
      }>): Promise<Readonly<{
        lessonId: string; draftRevision: number; draftHash: string;
        accessibilityDecisionId: string; disclosureDecisionId: string;
      }>>;
      updateCourseDraft(input: Readonly<{
        actor: StaffActor; correlationId: string;
        courseId: string; expectedRevision: number; title: string; description: string; idempotencyKey: string;
      }>): Promise<Readonly<{
        courseId: string; title: string; description: string; revision: number;
      }>>;
      getCourseDraftTree(input: Readonly<{
        actor: StaffActor; correlationId: string; courseId: string;
      }>): Promise<Readonly<{
        courseId: string; slug: string; title: string; description: string; revision: number;
        stages: readonly Readonly<{
          stageId: string; slug: string; title: string; description: string; order: number; revision: number;
          lessons: readonly Readonly<{
            lessonId: string; slug: string; title: string; summary: string; durationSeconds: number;
            blocks: readonly LessonBlock[]; transcript: Transcript; order: number; required: boolean; revision: number;
          }>[];
        }>[];
      }>>;
    };
    mediaUploads?: {
      createUpload(input: Readonly<{
        actor: StaffActor; correlationId: string; lessonId: string;
      }>): Promise<Readonly<{ uploadId: string; url: string }>>;
      finalizeUpload(input: Readonly<{
        actor: StaffActor; correlationId: string;
        lessonId: string; uploadId: string; expectedRevision: number;
      }>): Promise<Readonly<{
        lessonId: string; revision: number; mediaAssetId: string;
        mediaState: "waiting" | "preparing" | "ready" | "errored" | "deleted";
      }>>;
    };
    learningAdmin?: {
      grantEnrollment(input: Readonly<{
        actor: StaffActor; correlationId: string;
        accountId: string; courseId: string; reason: string; idempotencyKey: string;
      }>): Promise<Readonly<{
        enrollmentId: string; accountId: string; courseId: string;
        courseVersionId: string; enrolledAt: string;
      }>>;
    };
    accounts?: {
      list(input: Readonly<{
        actor: StaffActor; correlationId: string; query?: string;
      }>): Promise<readonly Readonly<{
        accountId: string; accountName: string; status: string; ownerEmail: string | null; enrolledCourseCount: number;
      }>[]>;
    };
  };
}

export type AuthComposition =
  | { readonly kind: "enabled"; readonly dependencies: AuthRouteDependencies }
  | { readonly kind: "test-only-disabled" };
