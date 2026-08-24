import { getReadyDb } from "./client";

export type ActivityActorKind = "student" | "staff" | "system";

export type ActivityEvent = {
  id: string;
  actorKind: ActivityActorKind;
  actorId: string | null;
  actorLabel: string;
  actorPublicId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  summary: string;
  metadata: unknown;
  createdAt: Date;
};

export type ActivityEventInput = {
  actorKind: ActivityActorKind;
  actorId?: string | null;
  actorLabel: string;
  actorPublicId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  summary: string;
  metadata?: unknown;
};

function mapEvent(row: Record<string, unknown>): ActivityEvent {
  const actorKind =
    row.actor_kind === "staff" || row.actor_kind === "system" ? row.actor_kind : "student";
  return {
    id: String(row.id),
    actorKind,
    actorId: row.actor_id ? String(row.actor_id) : null,
    actorLabel: String(row.actor_label ?? ""),
    actorPublicId: row.actor_public_id ? String(row.actor_public_id) : null,
    action: String(row.action),
    targetType: String(row.target_type),
    targetId: String(row.target_id),
    summary: String(row.summary ?? ""),
    metadata: row.metadata,
    createdAt: new Date(row.created_at as string | Date),
  };
}

export async function writeActivityEvent(input: ActivityEventInput): Promise<void> {
  const db = await getReadyDb();
  await db`
    INSERT INTO activity_events (
      actor_kind, actor_id, actor_label, actor_public_id, action, target_type, target_id, summary, metadata
    )
    VALUES (
      ${input.actorKind},
      ${input.actorId ?? null},
      ${input.actorLabel},
      ${input.actorPublicId ?? null},
      ${input.action},
      ${input.targetType},
      ${input.targetId},
      ${input.summary},
      ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
  `;
}

export async function listActivityEvents(input: {
  q?: string;
  action?: string;
  actorId?: string;
  limit?: number;
} = {}): Promise<ActivityEvent[]> {
  const db = await getReadyDb();
  const limit = Math.min(Math.max(input.limit ?? 150, 1), 500);
  const q = input.q?.trim();
  const action = input.action?.trim();
  const actorId = input.actorId?.trim();

  if (q && action && actorId) {
    const like = `%${q}%`;
    const rows = await db`
      SELECT * FROM activity_events
      WHERE action = ${action} AND actor_id = ${actorId}
        AND (
          actor_label ILIKE ${like} OR actor_public_id ILIKE ${like} OR actor_id ILIKE ${like}
          OR summary ILIKE ${like} OR target_id ILIKE ${like} OR action ILIKE ${like}
        )
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(mapEvent);
  }
  if (q && actorId) {
    const like = `%${q}%`;
    const rows = await db`
      SELECT * FROM activity_events
      WHERE actor_id = ${actorId}
        AND (
          actor_label ILIKE ${like} OR actor_public_id ILIKE ${like} OR actor_id ILIKE ${like}
          OR summary ILIKE ${like} OR target_id ILIKE ${like} OR action ILIKE ${like}
        )
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(mapEvent);
  }
  if (q && action) {
    const like = `%${q}%`;
    const rows = await db`
      SELECT * FROM activity_events
      WHERE action = ${action}
        AND (
          actor_label ILIKE ${like} OR actor_public_id ILIKE ${like} OR actor_id ILIKE ${like}
          OR summary ILIKE ${like} OR target_id ILIKE ${like} OR action ILIKE ${like}
        )
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(mapEvent);
  }
  if (action && actorId) {
    const rows = await db`
      SELECT * FROM activity_events
      WHERE action = ${action} AND actor_id = ${actorId}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(mapEvent);
  }
  if (q) {
    const like = `%${q}%`;
    const rows = await db`
      SELECT * FROM activity_events
      WHERE actor_label ILIKE ${like} OR actor_public_id ILIKE ${like} OR actor_id ILIKE ${like}
        OR summary ILIKE ${like} OR target_id ILIKE ${like} OR action ILIKE ${like}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(mapEvent);
  }
  if (action) {
    const rows = await db`
      SELECT * FROM activity_events WHERE action = ${action} ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(mapEvent);
  }
  if (actorId) {
    const rows = await db`
      SELECT * FROM activity_events WHERE actor_id = ${actorId} ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(mapEvent);
  }
  const rows = await db`SELECT * FROM activity_events ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map(mapEvent);
}

export async function listDistinctActivityActions(): Promise<string[]> {
  const db = await getReadyDb();
  const rows = await db`SELECT DISTINCT action FROM activity_events ORDER BY action`;
  return rows.map((row) => String(row.action));
}
