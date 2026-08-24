import { getReadyDb } from "./client";
import type { AdminAuditLog } from "./types";
import { writeActivityEvent } from "./activity";

export type AdminAuditInput = {
  actorStaffId: string;
  action: string;
  targetType: string;
  targetId: string;
  before: unknown;
  after: unknown;
  ip?: string | null;
  userAgent?: string | null;
};

export async function writeAdminAudit(input: AdminAuditInput): Promise<AdminAuditLog> {
  const db = await getReadyDb();
  const [row] = await db`
    INSERT INTO admin_audit_log (
      actor_staff_id, action, target_type, target_id, before_json, after_json, ip, user_agent
    )
    VALUES (
      ${input.actorStaffId},
      ${input.action},
      ${input.targetType},
      ${input.targetId},
      ${JSON.stringify(input.before)}::jsonb,
      ${JSON.stringify(input.after)}::jsonb,
      ${input.ip ?? null},
      ${input.userAgent ?? null}
    )
    RETURNING id, actor_staff_id, action, target_type, target_id, before_json, after_json, ip, user_agent, created_at
  `;
  const [staff] = await db`SELECT email, public_id FROM staff WHERE id = ${input.actorStaffId}`;
  await writeActivityEvent({
    actorKind: "staff",
    actorId: input.actorStaffId,
    actorLabel: staff ? String(staff.email) : "staff",
    actorPublicId: staff?.public_id ? String(staff.public_id) : null,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    summary: `${staff ? String(staff.email) : "Staff"} ${input.action.replaceAll("_", " ")} ${input.targetType} ${input.targetId}`,
    metadata: { before: input.before, after: input.after },
  });
  return {
    id: String(row.id),
    actorStaffId: String(row.actor_staff_id),
    action: String(row.action),
    targetType: String(row.target_type),
    targetId: String(row.target_id),
    beforeJson: row.before_json,
    afterJson: row.after_json,
    ip: row.ip ? String(row.ip) : null,
    userAgent: row.user_agent ? String(row.user_agent) : null,
    createdAt: new Date(row.created_at),
  };
}

export async function listAuditForTarget(targetType: string, targetId: string): Promise<AdminAuditLog[]> {
  const db = await getReadyDb();
  const rows = await db`
    SELECT id, actor_staff_id, action, target_type, target_id, before_json, after_json, ip, user_agent, created_at
    FROM admin_audit_log
    WHERE target_type = ${targetType} AND target_id = ${targetId}
    ORDER BY created_at
  `;
  return rows.map((row) => ({
    id: String(row.id),
    actorStaffId: String(row.actor_staff_id),
    action: String(row.action),
    targetType: String(row.target_type),
    targetId: String(row.target_id),
    beforeJson: row.before_json,
    afterJson: row.after_json,
    ip: row.ip ? String(row.ip) : null,
    userAgent: row.user_agent ? String(row.user_agent) : null,
    createdAt: new Date(row.created_at),
  }));
}
