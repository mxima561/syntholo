import {
  WaitlistRecordSchema,
  WaitlistSubscribeResponseSchema,
  type WaitlistRecord,
  type WaitlistSubscribeResponse,
} from "@syntholo/contracts";
import type { Database } from "../client.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class WaitlistInputError extends Error {
  constructor(message = "WAITLIST_EMAIL_INVALID") {
    super(message);
    this.name = "WaitlistInputError";
  }
}

export type WaitlistSubscribeInput = Readonly<{
  email: string;
  source?: string;
  correlationId: string;
}>;

export class WaitlistRepository {
  constructor(private readonly database: Database) {}

  async subscribe(input: WaitlistSubscribeInput): Promise<WaitlistSubscribeResponse> {
    if (!uuid.test(input.correlationId)) throw new WaitlistInputError();
    const result = await this.run(
      input.correlationId,
      "select public.syntholo_waitlist_subscribe_v1($1,$2) result",
      [input.email, input.source ?? "school"],
      WaitlistSubscribeResponseSchema,
    );
    if (result === null) throw new Error("WAITLIST_SIGNUP_FAILED");
    return result;
  }

  async getByEmail(
    input: Readonly<{ email: string; correlationId: string }>,
  ): Promise<WaitlistRecord | null> {
    if (!uuid.test(input.correlationId)) throw new WaitlistInputError();
    return this.run(
      input.correlationId,
      "select public.syntholo_waitlist_get_by_email_v1($1) result",
      [input.email],
      WaitlistRecordSchema,
    );
  }

  private async run<T>(
    correlationId: string,
    sql: string,
    values: readonly unknown[],
    schema: { parse(value: unknown): T; safeParse(value: unknown): { success: true; data: T } | { success: false } },
  ): Promise<T | null> {
    const client = await this.database.pool.connect();
    let open = false;
    try {
      await client.query("begin");
      open = true;
      await client.query(
        "select set_config('app.actor_kind','system',true), set_config('app.correlation_id',$1,true)",
        [correlationId],
      );
      const result = await client.query<{ result: unknown }>(sql, [...values]);
      const raw = result.rows[0]?.result ?? null;
      if (raw === null) {
        await client.query("commit");
        open = false;
        return null;
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new Error("WAITLIST_SIGNUP_RESULT_INVALID");
      await client.query("commit");
      open = false;
      return Object.freeze(parsed.data);
    } catch (error) {
      if (open) await client.query("rollback").catch(() => undefined);
      if (error instanceof WaitlistInputError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (message.includes("WAITLIST_EMAIL_INVALID") || message.includes("WAITLIST_SOURCE_INVALID")) {
        throw new WaitlistInputError(
          message.includes("WAITLIST_SOURCE_INVALID") ? "WAITLIST_SOURCE_INVALID" : "WAITLIST_EMAIL_INVALID",
        );
      }
      if (error instanceof Error && (
        error.message === "WAITLIST_SIGNUP_FAILED" || error.message === "WAITLIST_SIGNUP_RESULT_INVALID"
      )) {
        throw error;
      }
      throw new Error("WAITLIST_SIGNUP_FAILED");
    } finally {
      client.release();
    }
  }
}
