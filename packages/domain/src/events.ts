export type DomainEventName =
  | "entitlement.granted.v1"
  | "entitlement.revoked.v1"
  | "purchase.refunded.v1"
  | "job.requested.v1"
  | "scorecard.submitted.v1"
  | "application.submitted.v1";

export type DomainEvent = Readonly<{
  eventName: DomainEventName;
  accountId?: string | null;
  payload: Readonly<Record<string, unknown>>;
}>;
