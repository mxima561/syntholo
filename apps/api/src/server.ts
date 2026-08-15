import { pathToFileURL } from "node:url";
import {
  assertDatabaseCapability,
  AccountRepository,
  checkDatabaseReadiness,
  createDatabase,
  MemberIdentityRepository,
  MemberEntitlementReadRepository,
  StaffIdentityRepository,
  StaffLoginAttemptRepository,
  StaffSessionRepository,
  SystemMuxEventRepository,
} from "@syntholo/database";
import {
  createClerkSessionAuthenticator,
  createRemoteWorkosJwks,
  createWorkosStaffClient,
  verifyWorkosAccessToken,
} from "@syntholo/integrations";
import type { FastifyInstance } from "fastify";
import { buildApp, type ApiDependencies } from "./app.js";
import {
  createStaffSessionCrypto,
  parseStaffSessionKeyRing,
} from "./auth/session-crypto.js";
import { parseApiConfig, type ApiConfig, type RuntimeEnvironment } from "./config.js";
import { createMuxWebhookHandler } from "./modules/mux-webhook.js";

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
    await Promise.all([
      assertDatabaseCapability(memberDatabase, "syntholo_member_api"),
      assertDatabaseCapability(staffDatabase, "syntholo_staff_api"),
      assertDatabaseCapability(systemDatabase, "syntholo_system_api"),
    ]);
    const workosJwks = createRemoteWorkosJwks(new URL(config.workosJwksUrl));
    const sessions = new StaffSessionRepository(staffDatabase);
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
            },
            staff: {
              config: {
                environment: config.environment,
                webOrigin: config.webOrigin,
                clientId: config.workosClientId,
                organizationId: config.workosOrganizationId,
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
                  const claims = await verifyWorkosAccessToken(token, {
                    jwks: workosJwks,
                    issuer: config.workosIssuer,
                    clientId: config.workosClientId,
                    organizationId: config.workosOrganizationId,
                    allowedRoles: ["coach", "admin"],
                  });
                  if (claims.role !== "coach" && claims.role !== "admin") {
                    throw new Error("WORKOS_TOKEN_INVALID");
                  }
                  return { ...claims, role: claims.role };
                },
              },
              workos: createWorkosStaffClient({
                apiKey: config.workosApiKey,
                clientId: config.workosClientId,
              }),
              sleep: (milliseconds) =>
                new Promise((resolve) => setTimeout(resolve, milliseconds)),
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
      process.exitCode = 1;
    });
}
