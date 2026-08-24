import { pathToFileURL } from "node:url";
import {
  assertDatabaseCapability,
  attestSystemDatabase,
  AccountRepository,
  checkDatabaseReadiness,
  createDatabase,
  MemberIdentityRepository,
  MemberEntitlementReadRepository,
  MemberCertificatesRepository,
  MemberImplementationRepository,
  MemberLearningRepository,
  StaffIdentityRepository,
  StaffContentCommandRepository,
  StaffContentAuthoringRepository,
  StaffLearningAdminRepository,
  StaffAccountsRepository,
  WaitlistRepository,
  StaffCertificatesRepository,
  StaffLoginAttemptRepository,
  StaffSessionRepository,
  SystemMuxEventRepository,
} from "@syntholo/database";
import {
  createClerkSessionAuthenticator,
  createMuxAssetManagementClient,
  createMuxPlaybackSigner,
  createPrivateCertificateBlobStore,
  createRemoteAccessJwks,
  createStripeAdapter,
  createAccessStaffClient,
  verifyAccessAccessToken,
} from "@syntholo/integrations";
import type { FastifyInstance } from "fastify";
import { buildApp, type ApiDependencies } from "./app.js";
import {
  createStaffSessionCrypto,
  parseStaffSessionKeyRing,
} from "./auth/session-crypto.js";
import {
  diagnoseApiConfig,
  parseApiConfig,
  type ApiConfig,
  type RuntimeEnvironment,
} from "./config.js";
import { createMuxWebhookHandler } from "./modules/mux-webhook.js";
import {
  createStripeWebhookHandler,
  createStripeWebhookRecordPort,
} from "./modules/stripe-webhook.js";

type BuildApp = (dependencies: ApiDependencies) => Promise<FastifyInstance>;
type Listen = (
  app: FastifyInstance,
  address: Readonly<{ host: string; port: number }>,
) => Promise<unknown>;

export type StartApiOptions = Readonly<{
  env?: RuntimeEnvironment;
  build?: BuildApp;
  listen?: Listen;
}>;

async function productionDependencies(config: ApiConfig): Promise<{
  dependencies: ApiDependencies;
  close(): Promise<void>;
}> {
  const memberDatabase = createDatabase({
    url: config.memberDatabaseUrl,
    applicationName: "syntholo-member-api",
  });
  const staffDatabase = createDatabase({
    url: config.staffDatabaseUrl,
    applicationName: "syntholo-staff-api",
  });
  const systemDatabase = createDatabase({
    url: config.systemDatabaseUrl,
    applicationName: "syntholo-system-api",
  });
  try {
    const [, , attestedSystemDatabase] = await Promise.all([
      assertDatabaseCapability(memberDatabase, "syntholo_member_api"),
      assertDatabaseCapability(staffDatabase, "syntholo_staff_api"),
      attestSystemDatabase(systemDatabase),
    ]);
    const accessJwks = createRemoteAccessJwks(new URL(config.accessJwksUrl));
    const sessions = new StaffSessionRepository(staffDatabase);
    const content = new StaffContentCommandRepository(staffDatabase);
    const contentAuthoring = new StaffContentAuthoringRepository(staffDatabase);
    const learningAdmin = new StaffLearningAdminRepository(staffDatabase);
    const staffAccounts = new StaffAccountsRepository(staffDatabase);
    const waitlist = new WaitlistRepository(systemDatabase);
    const certificateBlob = config.certificateBlob === undefined
      ? undefined
      : createPrivateCertificateBlobStore(config.certificateBlob);
    const playbackSigner = config.mux.kind === "configured"
      ? await createMuxPlaybackSigner({
          keyId: config.mux.signingKeyId,
          privateKey: config.mux.signingPrivateKey,
        })
      : undefined;
    const muxUploadClient = config.mux.kind === "configured"
      && config.mux.uploadTokenId !== undefined
      && config.mux.uploadTokenSecret !== undefined
      ? createMuxAssetManagementClient({
          environmentId: config.mux.environmentId,
          tokenId: config.mux.uploadTokenId,
          tokenSecret: config.mux.uploadTokenSecret,
        })
      : undefined;
    const stripeConfig = config.stripe.kind === "configured" ? config.stripe : undefined;
    const stripeProvider = stripeConfig === undefined
      ? undefined
      : createStripeAdapter({
          apiRestrictedKey: stripeConfig.apiRestrictedKey,
          checkoutSuccessUrl: stripeConfig.checkoutSuccessUrl,
          checkoutCancelUrl: stripeConfig.checkoutCancelUrl,
          portalConfigurationId: stripeConfig.portalConfigurationId,
          portalReturnUrl: stripeConfig.portalReturnUrl,
        });
    return {
      dependencies: {
        releaseSha: config.releaseSha,
        logger: config.environment === "production",
        health: {
          dependencies: [
            {
              name: "member-postgres",
              check: () => checkDatabaseReadiness(
                memberDatabase,
                "syntholo_member_api",
              ),
            },
            {
              name: "staff-postgres",
              check: () => checkDatabaseReadiness(
                staffDatabase,
                "syntholo_staff_api",
              ),
            },
            {
              name: "system-postgres",
              check: () => checkDatabaseReadiness(
                systemDatabase,
                "syntholo_system_api",
              ),
            },
          ],
        },
        waitlist: {
          webOrigin: config.webOrigin,
          subscribe: (input) => waitlist.subscribe(input),
        },
        auth: {
          kind: "enabled",
          dependencies: {
            member: {
              webOrigin: config.webOrigin,
              audience: config.clerkAudience,
              authorizedParties: [config.webOrigin],
              clerk: createClerkSessionAuthenticator({
                secretKey: config.clerkSecretKey,
                publishableKey: config.clerkPublishableKey,
              }),
              identities: new MemberIdentityRepository(memberDatabase),
              access: new MemberEntitlementReadRepository(memberDatabase, {
                now: () => new Date(),
              }),
              dashboard: {
                accounts: new AccountRepository(memberDatabase),
                clock: { now: () => new Date() },
              },
              learning: new MemberLearningRepository(memberDatabase),
              implementation: new MemberImplementationRepository(
                memberDatabase,
                config.implementationCursorSecret,
              ),
              ...(certificateBlob === undefined ? {} : {
                certificates: new MemberCertificatesRepository(
                  memberDatabase,
                  config.certificateBlob!.cursorSecret,
                ),
                certificateBlob,
              }),
              ...(playbackSigner === undefined ? {} : {
                playback: {
                  sign: playbackSigner.sign,
                  clock: { now: () => new Date() },
                },
              }),
            },
            staff: {
              config: {
                environment: config.environment,
                webOrigin: config.webOrigin,
                clientId: config.accessClientId,
                organizationId: config.accessOrganizationId,
                callbackUrl: `${config.webOrigin}/v1/staff/auth/callback`,
                defaultReturnTo: "/admin",
                allowedReturnToPrefixes: ["/admin", "/coach"],
                sessionHardTtlSeconds: 28_800,
                loginAttemptTtlSeconds: 300,
                refreshLeaseSeconds: 10,
              },
              clock: { now: () => new Date() },
              sessionCrypto: createStaffSessionCrypto(
                parseStaffSessionKeyRing(config.sessionEncryptionKeys),
              ),
              loginAttempts: new StaffLoginAttemptRepository(staffDatabase),
              sessions,
              identities: new StaffIdentityRepository(staffDatabase),
              tokens: {
                verify: async (token) => {
                  const claims = await verifyAccessAccessToken(token, {
                    jwks: accessJwks,
                    issuer: config.accessIssuer,
                    clientId: config.accessClientId,
                    organizationId: config.accessOrganizationId,
                    allowedRoles: ["coach", "admin"],
                  });
                  if (claims.role !== "coach" && claims.role !== "admin") {
                    throw new Error("REMOVED_TOKEN_INVALID");
                  }
                  return { ...claims, role: claims.role };
                },
              },
              access: createAccessStaffClient({
                apiKey: config.accessApiKey,
                clientId: config.accessClientId,
              }),
              sleep: (milliseconds) =>
                new Promise((resolve) => setTimeout(resolve, milliseconds)),
              content: {
                derivePreview: ({ actor, ...input }) => content.getPreview({ actorId: actor.actorId, ...input }),
                materializePreview: ({ actor, ...input }) => content.createPreview({ actorId: actor.actorId, ...input }),
                publishCourse: ({ actor, ...input }) => content.publishCourse({ actorId: actor.actorId, ...input }),
                publishLesson: ({ actor, ...input }) => content.publishLesson({ actorId: actor.actorId, ...input }),
              },
              contentAuthoring: {
                listCourses: ({ actor, ...input }) => contentAuthoring.listCourses({ actorId: actor.actorId, ...input }),
                createCourseDraft: ({ actor, ...input }) => contentAuthoring.createCourseDraft({ actorId: actor.actorId, ...input }),
                upsertStageDraft: ({ actor, ...input }) => contentAuthoring.upsertStageDraft({ actorId: actor.actorId, ...input }),
                upsertLessonDraft: ({ actor, ...input }) => contentAuthoring.upsertLessonDraft({ actorId: actor.actorId, ...input }),
                recordLessonReview: ({ actor, ...input }) => contentAuthoring.recordLessonReview({ actorId: actor.actorId, ...input }),
                updateCourseDraft: ({ actor, ...input }) => contentAuthoring.updateCourseDraft({ actorId: actor.actorId, ...input }),
                getCourseDraftTree: ({ actor, ...input }) => contentAuthoring.getCourseDraftTree({ actorId: actor.actorId, ...input }),
              },
              ...(muxUploadClient !== undefined && config.mux.kind === "configured" ? {
                mediaUploads: {
                  createUpload: async ({ lessonId }: { lessonId: string }) => {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 10_000);
                    try {
                      // lessonId isn't sent to Mux: the direct-upload URL isn't scoped
                      // to a lesson, the browser/finalize call re-associates it after.
                      void lessonId;
                      return await muxUploadClient.createDirectUpload(
                        { corsOrigin: config.webOrigin },
                        controller.signal,
                      );
                    } finally {
                      clearTimeout(timeout);
                    }
                  },
                  finalizeUpload: async ({ actor, correlationId, lessonId, uploadId, expectedRevision }) => {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 10_000);
                    let upload: Awaited<ReturnType<typeof muxUploadClient.retrieveUpload>>;
                    try {
                      upload = await muxUploadClient.retrieveUpload(uploadId, controller.signal);
                    } finally {
                      clearTimeout(timeout);
                    }
                    if (upload.status === "errored" || upload.status === "cancelled") {
                      throw new Error("MUX_UPLOAD_FAILED");
                    }
                    if (upload.status !== "asset_created" || upload.assetId === null) {
                      throw new Error("MUX_UPLOAD_NOT_READY");
                    }
                    return contentAuthoring.attachLessonMedia({
                      actorId: actor.actorId, correlationId, lessonId, expectedRevision,
                      environmentId: config.mux.kind === "configured" ? config.mux.environmentId : "",
                      providerAssetId: upload.assetId,
                      idempotencyKey: `mux-upload:${uploadId}`,
                    });
                  },
                },
              } : {}),
              learningAdmin: {
                grantEnrollment: ({ actor, ...input }) => learningAdmin.grantEnrollment({ actorId: actor.actorId, ...input }),
              },
              accounts: {
                list: ({ actor, ...input }) => staffAccounts.listAccounts({ actorId: actor.actorId, ...input }),
              },
              ...(certificateBlob === undefined ? {} : {
                certificates: new StaffCertificatesRepository(staffDatabase),
              }),
            },
          },
        },
        mux: config.mux.kind === "configured" ? {
          kind: "enabled",
          handler: createMuxWebhookHandler({
            actorId: "mux-webhook",
            environmentId: config.mux.environmentId,
            repository: new SystemMuxEventRepository(systemDatabase),
            secret: config.mux.webhookSecret,
            clock: { now: () => new Date() },
          }),
        } : { kind: "disabled" },
        stripe: stripeConfig !== undefined && stripeProvider !== undefined ? {
          kind: "enabled",
          provider: stripeProvider,
          handler: createStripeWebhookHandler({
            binding: stripeConfig.endpointBinding,
            clock: { now: () => new Date() },
            endpointSecrets: stripeConfig.webhookSecrets,
            record: createStripeWebhookRecordPort({
              binding: stripeConfig.endpointBinding,
              clock: { now: () => new Date() },
              database: attestedSystemDatabase,
            }),
          }),
        } : { kind: "disabled" },
        close: async () =>
          Promise.all([memberDatabase.close(), staffDatabase.close(), systemDatabase.close()]).then(
            () => undefined,
          ),
      },
      close: async () => Promise.all([memberDatabase.close(), staffDatabase.close(), systemDatabase.close()]).then(() => undefined),
    };
  } catch (error) {
    await Promise.allSettled([memberDatabase.close(), staffDatabase.close(), systemDatabase.close()]);
    throw error;
  }
}

export async function startApi(options: StartApiOptions = {}): Promise<FastifyInstance> {
  const config = parseApiConfig(options.env ?? process.env);
  const composed = await productionDependencies(config);
  let app: FastifyInstance | undefined;
  try {
    app = await (options.build ?? buildApp)(composed.dependencies);
    const listen = options.listen ?? ((instance, address) => instance.listen(address));
    await listen(app, { host: config.host, port: config.port });
    return app;
  } catch (error) {
    if (app) {
      await app.close().catch(() => undefined);
    } else {
      await composed.close();
    }
    throw error;
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isMainModule()) {
  void startApi()
    .then((app) => {
      const stop = () => void app.close().catch(() => { process.exitCode = 1; });
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch(() => {
      process.stderr.write("API_STARTUP_FAILED\n");
      // Variable names only; never their values. See diagnoseApiConfig.
      for (const issue of diagnoseApiConfig(process.env)) {
        process.stderr.write(`API_CONFIG_ISSUE ${issue}\n`);
      }
      process.exitCode = 1;
    });
}
