import { normalizeAttribution, transitionApplication, type ApplicationStatus, type Attribution } from "@syntholo/domain";
import type { DatabaseClient } from "./client";
import { appendAudit, enqueueOutbox } from "./outbox";
import { withStaffScope, withSystemScope } from "./scope";

export const PILOT_APPLICATION_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS pilot_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email CITEXT NOT NULL,
    first_name TEXT NOT NULL,
    business_name TEXT NOT NULL,
    country TEXT NOT NULL,
    goals TEXT NOT NULL DEFAULT '',
    marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
    attribution_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'needs_information', 'approved', 'declined', 'checkout_sent', 'purchased')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
];

export type PilotApplicationRecord = {
  id: string;
  email: string;
  status: ApplicationStatus;
};

export async function bootstrapPilotApplicationModel(db: DatabaseClient) {
  for (const statement of PILOT_APPLICATION_SCHEMA_SQL) {
    await db.unsafe(statement);
  }
}

export async function submitPilotApplication(input: {
  email: string;
  firstName: string;
  businessName: string;
  country: string;
  goals: string;
  marketingConsent: boolean;
  attribution?: Attribution;
}): Promise<PilotApplicationRecord> {
  const attribution = normalizeAttribution(input.attribution);
  const marketingConsent = input.marketingConsent === true;
  const email = input.email.toLowerCase();

  return withSystemScope(async (db) => {
    const [row] = await db`
      INSERT INTO pilot_applications (
        email, first_name, business_name, country, goals, marketing_consent, attribution_json, status
      )
      VALUES (
        ${email}, ${input.firstName}, ${input.businessName}, ${input.country}, ${input.goals},
        ${marketingConsent}, ${JSON.stringify(attribution)}::jsonb, 'submitted'
      )
      RETURNING id, email, status
    `;
    const id = String(row.id);
    await appendAudit(db, {
      actorKind: "system",
      actorId: email,
      action: "application.submitted",
      targetType: "pilot_application",
      targetId: id,
      payload: { marketingConsent },
    });
    await enqueueOutbox(db, {
      eventName: "application.submitted.v1",
      payload: { applicationId: id },
    });
    return { id, email: String(row.email), status: "submitted" };
  });
}

export async function reviewPilotApplication(input: {
  applicationId: string;
  nextStatus: ApplicationStatus;
  staffId: string;
}): Promise<PilotApplicationRecord> {
  return withStaffScope(async (db) => {
    const [existing] = await db`SELECT id, email, status FROM pilot_applications WHERE id = ${input.applicationId}`;
    if (!existing) throw new Error("APPLICATION_NOT_FOUND");
    const next = transitionApplication(String(existing.status) as ApplicationStatus, input.nextStatus);
    const [row] = await db`
      UPDATE pilot_applications
      SET status = ${next}, updated_at = now()
      WHERE id = ${input.applicationId}
      RETURNING id, email, status
    `;
    await appendAudit(db, {
      actorKind: "staff",
      actorId: input.staffId,
      action: "application.reviewed",
      targetType: "pilot_application",
      targetId: String(row.id),
      payload: { from: existing.status, to: next },
    });
    return { id: String(row.id), email: String(row.email), status: next };
  });
}
