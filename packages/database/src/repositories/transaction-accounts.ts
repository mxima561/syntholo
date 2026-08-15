import { eq } from "drizzle-orm";
import { canonicalizeAccountName } from "@syntholo/contracts/member-dashboard";
import { accounts } from "../schema/index.js";
import type { DatabaseTransaction } from "../unit-of-work.js";
import type { TransactionGuard, TrustedTransactionMetadata } from "./context.js";

export class TransactionAccountRepository {
  constructor(
    transaction: DatabaseTransaction,
    metadata: TrustedTransactionMetadata,
    guard: TransactionGuard,
  ) {
    state.set(this, { guard, metadata, transaction });
    Object.freeze(this);
  }

  rename(name: string): Promise<string> {
    const { guard, metadata, transaction } = state.get(this)!;
    return guard.run(async () => {
      if (metadata.accountId === null) {
        throw new Error("ACCOUNT_MUTATION_INVALID");
      }
      const canonicalName = canonicalizeAccountName(name);
      const rows = await transaction.update(accounts).set({
        name: canonicalName,
        nameStatus: "confirmed",
      })
        .where(eq(accounts.id, metadata.accountId))
        .returning({ name: accounts.name });
      if (rows.length !== 1) throw new Error("ACCOUNT_NOT_FOUND");
      return rows[0]!.name;
    });
  }

}

const state = new WeakMap<TransactionAccountRepository, Readonly<{
  guard: TransactionGuard;
  metadata: TrustedTransactionMetadata;
  transaction: DatabaseTransaction;
}>>();
