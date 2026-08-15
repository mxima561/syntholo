import type { ApplyMuxEventInput, MuxEventApplyResult } from "@syntholo/database";
import { verifyAndParseMuxWebhook } from "@syntholo/integrations";

type MuxEventApplyPort = Readonly<{
  apply(input: ApplyMuxEventInput): Promise<MuxEventApplyResult>;
}>;

export function createMuxWebhookHandler(dependencies: Readonly<{
  actorId: string;
  environmentId: string;
  repository: MuxEventApplyPort;
  secret: string;
  clock: Readonly<{ now(): Date }>;
}>): (request: Readonly<{
  correlationId: string;
  rawBody: Buffer | undefined;
  signature: string;
}>) => Promise<Readonly<{ received: true }>> {
  return async (request) => {
    if (!Buffer.isBuffer(request.rawBody)) {
      throw new Error("MUX_WEBHOOK_RAW_BODY_REQUIRED");
    }
    const event = verifyAndParseMuxWebhook({
      rawBody: request.rawBody,
      signature: request.signature,
      secret: dependencies.secret,
      expectedEnvironmentId: dependencies.environmentId,
      now: dependencies.clock.now(),
    });
    await dependencies.repository.apply({
      actorId: dependencies.actorId,
      correlationId: request.correlationId,
      expectedEnvironmentId: dependencies.environmentId,
      event,
    });
    return Object.freeze({ received: true as const });
  };
}
