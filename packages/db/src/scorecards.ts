import { createHash, randomBytes } from "node:crypto";
import { normalizeAttribution, type Attribution } from "@syntholo/domain";
import type { DatabaseClient } from "./client";
import { appendAudit, enqueueOutbox } from "./outbox";
import { withSystemScope } from "./scope";
import { writeActivityEvent } from "./activity";

export const SCORECARD_REPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SCORECARD_SCHEMA_SQL = [
  `ALTER TABLE scorecard_submissions ADD COLUMN IF NOT EXISTS report_token_hash TEXT`,
  `ALTER TABLE scorecard_submissions ADD COLUMN IF NOT EXISTS report_expires_at TIMESTAMPTZ`,
  `ALTER TABLE scorecard_submissions ADD COLUMN IF NOT EXISTS attribution_json JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE scorecard_submissions ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS scorecard_report_token_hash_idx ON scorecard_submissions (report_token_hash) WHERE report_token_hash IS NOT NULL`,
];

export type PublicScorecardReport = {
  overallScore: number;
  band: string;
  answers: Record<string, number>;
  expiresAt: string;
};

export type PersistedScorecard = {
  id: string;
  reportToken: string;
  expiresAt: Date;
};

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function asAnswers(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, Number(item)]),
  );
}

export async function bootstrapScorecardModel(db: DatabaseClient) {
  for (const statement of SCORECARD_SCHEMA_SQL) {
    await db.unsafe(statement);
  }
}

export async function persistScorecardLead(input: {
  userId?: string | null;
  email: string;
  firstName: string;
  businessName: string;
  country: string;
  overallScore: number;
  band: string;
  answers: Record<string, number>;
  marketingConsent: boolean;
  attribution?: Attribution;
}): Promise<PersistedScorecard> {
  const reportToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SCORECARD_REPORT_TTL_MS);
  const attribution = normalizeAttribution(input.attribution);
  const marketingConsent = input.marketingConsent === true;
  const email = input.email.toLowerCase();

  const saved = await withSystemScope(async (db) => {
    const [row] = await db`
      INSERT INTO scorecard_submissions (
        user_id, email, first_name, business_name, country, overall_score, band, answers_json, marketing_consent,
        report_token_hash, report_expires_at, attribution_json
      )
      VALUES (
        ${input.userId ?? null}, ${email}, ${input.firstName}, ${input.businessName},
        ${input.country}, ${input.overallScore}, ${input.band}, ${JSON.stringify(input.answers)}::jsonb,
        ${marketingConsent}, ${hashToken(reportToken)}, ${expiresAt}, ${JSON.stringify(attribution)}::jsonb
      )
      RETURNING id
    `;
    const id = String(row.id);
    await appendAudit(db, {
      actorKind: "system",
      actorId: email,
      action: "scorecard.submitted",
      targetType: "scorecard",
      targetId: id,
      payload: { band: input.band, overallScore: input.overallScore, marketingConsent },
    });
    await enqueueOutbox(db, {
      eventName: "scorecard.submitted.v1",
      payload: { scorecardId: id, marketingConsent },
    });
    return { id };
  });

  await writeActivityEvent({
    actorKind: input.userId ? "student" : "system",
    actorId: input.userId ?? null,
    actorLabel: `${input.firstName} <${email}>`,
    action: "scorecard_submitted",
    targetType: "scorecard",
    targetId: saved.id,
    summary: `${input.firstName} submitted a readiness scorecard (${input.band}, ${input.overallScore})`,
    metadata: { band: input.band, overallScore: input.overallScore, businessName: input.businessName },
  });

  return { id: saved.id, reportToken, expiresAt };
}

export async function getPublicScorecardReport(reportToken: string): Promise<PublicScorecardReport | null> {
  return withSystemScope(async (db) => {
    const [row] = await db`
      SELECT overall_score, band, answers_json, report_expires_at
      FROM scorecard_submissions
      WHERE report_token_hash = ${hashToken(reportToken)}
    `;
    if (!row) return null;
    const expiresAt = new Date(row.report_expires_at as string | Date);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) return null;
    return {
      overallScore: Number(row.overall_score),
      band: String(row.band),
      answers: asAnswers(row.answers_json),
      expiresAt: expiresAt.toISOString(),
    };
  });
}

export async function attachScorecardsForVerifiedEmail(email: string, accountId: string, db: DatabaseClient) {
  await db`
    UPDATE scorecard_submissions
    SET account_id = ${accountId}
    WHERE lower(email) = ${email.toLowerCase()} AND account_id IS NULL
  `;
}
