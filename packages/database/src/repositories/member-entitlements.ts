import {
  evaluateEntitlements,
  type AccountHold,
  type EffectiveAccess,
  type EntitlementGrant,
  type MemberActor,
  type SeatReservation,
} from "@syntholo/domain";
import type { Database } from "../client.js";

const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function pgCode(error: unknown): string | undefined {
  let value = error;
  while (value instanceof Error) {
    if ("code" in value && typeof value.code === "string") return value.code;
    value = value.cause;
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MEMBER_ACCESS_DATA_INVALID");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("MEMBER_ACCESS_DATA_INVALID");
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("MEMBER_ACCESS_DATA_INVALID");
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function date(value: unknown): Date {
  const result = new Date(text(value));
  if (!Number.isFinite(result.getTime())) throw new Error("MEMBER_ACCESS_DATA_INVALID");
  return result;
}

function nullableDate(value: unknown): Date | null {
  return value === null ? null : date(value);
}

function mapGrant(value: unknown): EntitlementGrant {
  const row = record(value);
  return {
    id: text(row.id),
    accountId: text(row.accountId),
    capability: text(row.capability) as EntitlementGrant["capability"],
    status: text(row.status) as EntitlementGrant["status"],
    sourceKind: text(row.sourceKind) as EntitlementGrant["sourceKind"],
    sourceId: text(row.sourceId),
    offerCode: nullableText(row.offerCode) as EntitlementGrant["offerCode"],
    academySourceId: nullableText(row.academySourceId),
    sourceCreatedAt: date(row.sourceCreatedAt),
    startsAt: date(row.startsAt),
    endsAt: nullableDate(row.endsAt),
  };
}

function mapHold(value: unknown): AccountHold {
  const row = record(value);
  return {
    id: text(row.id),
    accountId: text(row.accountId),
    kind: text(row.kind) as AccountHold["kind"],
    sourceKind: text(row.sourceKind),
    sourceId: text(row.sourceId),
    createdAt: date(row.createdAt),
    releasedAt: nullableDate(row.releasedAt),
  };
}

function mapSeat(value: unknown): SeatReservation {
  const row = record(value);
  if (typeof row.slot !== "number") throw new Error("MEMBER_ACCESS_DATA_INVALID");
  return {
    id: text(row.id),
    accountId: text(row.accountId),
    slot: row.slot as SeatReservation["slot"],
    sourceId: text(row.sourceId),
    state: text(row.state) as SeatReservation["state"],
    membershipId: nullableText(row.membershipId),
    invitationId: nullableText(row.invitationId),
    expiresAt: nullableDate(row.expiresAt),
  };
}

export class MemberAccessUnavailableError extends Error {
  readonly code = "MEMBER_ACCESS_UNAVAILABLE";
  constructor() {
    super("MEMBER_ACCESS_UNAVAILABLE");
    this.name = "MemberAccessUnavailableError";
  }
}

export class MemberEntitlementReadRepository {
  constructor(
    private readonly database: Database,
    private readonly clock: Readonly<{ now(): Date }>,
  ) {}

  async getEffectiveAccess(actor: MemberActor): Promise<EffectiveAccess> {
    if (
      actor.kind !== "member"
      || !canonicalUuid.test(actor.accountId)
      || !canonicalUuid.test(actor.membershipId)
      || !canonicalUuid.test(actor.actorId)
    ) throw new MemberAccessUnavailableError();
    try {
      const client = await this.database.pool.connect();
      let locked = false;
      let transactionOpen = false;
      let destroy = false;
      let snapshot: unknown;
      let evaluated: EffectiveAccess | undefined;
      try {
        await client.query(
          "select pg_advisory_lock_shared(hashtextextended($1,0))",
          [`syntholo-entitlement-account:${actor.accountId}`],
        );
        locked = true;
        await client.query("begin isolation level repeatable read read only");
        transactionOpen = true;
        await client.query(
          `select set_config('app.account_id',$1,true),
                  set_config('app.actor_id',$2,true),
                  set_config('app.actor_kind','member',true),
                  set_config('app.membership_id',$3,true)`,
          [actor.accountId, actor.actorId, actor.membershipId],
        );
        const result = await client.query<{ snapshot: unknown }>(
          `select syntholo_member_entitlement_snapshot($1,$2,$3) as snapshot`,
          [actor.accountId, actor.membershipId, actor.actorId],
        );
        if (result.rows.length !== 1) throw new Error("MEMBER_ACCESS_DATA_INVALID");
        snapshot = result.rows[0]!.snapshot;
        const evaluationNow = new Date(this.clock.now());
        const parsed = record(snapshot);
        evaluated = evaluateEntitlements({
          accountId: actor.accountId,
          now: evaluationNow,
          grants: array(parsed.grants).map(mapGrant),
          holds: array(parsed.holds).map(mapHold),
          seats: array(parsed.seats).map(mapSeat),
        });
        await client.query("commit");
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) {
          await client.query("rollback").catch(() => { destroy = true; });
          transactionOpen = false;
        }
        throw error;
      } finally {
        if (locked) {
          try {
            const unlocked = await client.query<{ unlocked: boolean }>(
              "select pg_advisory_unlock_shared(hashtextextended($1,0)) unlocked",
              [`syntholo-entitlement-account:${actor.accountId}`],
            );
            if (unlocked.rows[0]?.unlocked !== true) destroy = true;
          } catch {
            destroy = true;
          }
        }
        client.release(destroy);
      }
      if (evaluated === undefined) throw new Error("MEMBER_ACCESS_DATA_INVALID");
      return evaluated;
    } catch (error) {
      if (pgCode(error) === "P0002" || error instanceof MemberAccessUnavailableError) {
        throw new MemberAccessUnavailableError();
      }
      if (error instanceof Error && error.message === "MEMBER_ACCESS_DATA_INVALID") {
        throw error;
      }
      throw error;
    }
  }
}
