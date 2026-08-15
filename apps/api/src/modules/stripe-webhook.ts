import type { StripeEndpointBinding, StripeWebhookSecret } from "@syntholo/integrations";
import { verifyAndNormalizeStripeWebhook } from "@syntholo/integrations";
import { createSystemUnitOfWork, type SystemDatabase } from "@syntholo/database";

type StripeVerification = ReturnType<typeof verifyAndNormalizeStripeWebhook>;
type StripeEnvelope = StripeVerification["envelope"];

export type StripeWebhookRecordPort = (input: Readonly<{
  correlationId: string;
  envelope: StripeEnvelope;
  eventObjectValid: boolean;
  signal: AbortSignal;
}>) => Promise<Readonly<{
  replayed: boolean;
  receiptId: string;
  status: "received" | "processing" | "processed" | "failed_retryable" | "failed_terminal";
}>>;

export function createStripeWebhookRecordPort(dependencies: Readonly<{
  binding: StripeEndpointBinding;
  clock: Readonly<{ now(): Date }>;
  database: SystemDatabase;
}>): StripeWebhookRecordPort {
  return ({ correlationId, envelope, eventObjectValid, signal }) => {
    if (signal.aborted) return Promise.reject(new Error("COMMERCE_PROVIDER_EVENT_RETRYABLE"));
    return createSystemUnitOfWork(dependencies.database, {
      accountId: null,
      actor: { kind: "system", actorId: "commerce-webhook.v1" },
      clock: dependencies.clock,
      correlationId,
    }).transaction((transaction) => transaction.commerce.recordProviderEvent({
      providerEventId: envelope.eventId,
      eventType: envelope.eventType,
      livemode: envelope.livemode,
      apiVersion: envelope.apiVersion,
      providerCreatedAt: new Date(envelope.providerCreatedAt),
      dataObjectType: envelope.dataObjectType,
      dataObjectId: envelope.dataObjectId,
      eventObjectValid,
      receiverStripeAccountId: envelope.receiverAccountId,
      eventAccount: envelope.eventAccount,
      eventContext: envelope.eventContext,
      rawBodySha256: envelope.rawBodySha256,
      expectedLivemode: dependencies.binding.expectedLivemode,
      expectedApiVersion: dependencies.binding.expectedApiVersion,
      expectedReceiverStripeAccountId: dependencies.binding.receiverAccountId,
    }));
  };
}

export function createStripeWebhookHandler(dependencies: Readonly<{
  binding: StripeEndpointBinding;
  clock: Readonly<{ now(): Date }>;
  endpointSecrets: readonly StripeWebhookSecret[];
  record: StripeWebhookRecordPort;
  verify?: typeof verifyAndNormalizeStripeWebhook;
}>): (request: Readonly<{
  correlationId: string;
  rawBody: Buffer | undefined;
  signal: AbortSignal;
  signature: string;
}>) => Promise<Readonly<{ received: true }>> {
  const verify = dependencies.verify ?? verifyAndNormalizeStripeWebhook;
  return async (request) => {
    if (request.signal.aborted) throw new Error("COMMERCE_PROVIDER_EVENT_RETRYABLE");
    if (!Buffer.isBuffer(request.rawBody)) throw new Error("WEBHOOK_SIGNATURE_INVALID");
    const verified = verify({
      rawBody: request.rawBody,
      signature: request.signature,
      endpointSecrets: dependencies.endpointSecrets,
      binding: dependencies.binding,
      now: dependencies.clock.now(),
    });
    const recorded = await dependencies.record({
      correlationId: request.correlationId,
      envelope: verified.envelope,
      eventObjectValid: verified.envelope.objectTypeValid,
      signal: request.signal,
    });
    if (recorded.status === "processing" || recorded.status === "failed_retryable") {
      throw new Error("COMMERCE_PROVIDER_EVENT_RETRYABLE");
    }
    return Object.freeze({ received: true as const });
  };
}
