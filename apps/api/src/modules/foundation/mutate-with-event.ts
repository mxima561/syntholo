import type {
  AuditEventInput,
  TransactionContext,
  UnitOfWork,
} from "@syntholo/database";
import type { DomainEventInput, JsonObject } from "@syntholo/domain";

export type MutationRecords<
  TType extends string,
  TPayload extends JsonObject,
> = Readonly<{
  audit: AuditEventInput;
  event: DomainEventInput<TType, TPayload>;
}>;

export function mutateWithEvent<
  TResult,
  TType extends string,
  TPayload extends JsonObject,
>(
  unitOfWork: UnitOfWork,
  records: MutationRecords<TType, TPayload>,
  mutate: (transaction: TransactionContext) => Promise<TResult>,
): Promise<TResult> {
  return unitOfWork.transaction(async (transaction) => {
    const result = await mutate(transaction);
    await transaction.audit.append(records.audit);
    await transaction.outbox.enqueue(transaction.outbox.create(records.event));
    return result;
  });
}
