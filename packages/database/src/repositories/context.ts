import type { Actor } from "@syntholo/domain";

export type SystemActor = Readonly<{
  actorId: string;
  kind: "system";
}>;

export type TrustedActor = Actor | SystemActor;

export type TrustedTransactionMetadata = Readonly<{
  accountId: string | null;
  actor: TrustedActor;
  clock: Readonly<{ now(): Date }>;
  correlationId: string;
}>;

export type TransactionGuard = Readonly<{
  assertActive(): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
  assertSettled(): void;
}>;
