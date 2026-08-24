import { getReadyDb } from "./client";
import type { Staff, StaffRole, StaffStatus } from "./types";

import { publicIdFromUuid } from "./ids";

function mapStaff(row: Record<string, unknown>): Staff {
  const role = row.role === "instructor" || row.role === "support" || row.role === "admin" ? row.role : "support";
  const status: StaffStatus = row.status === "suspended" ? "suspended" : "active";
  const id = String(row.id);
  return {
    id,
    publicId: row.public_id ? String(row.public_id) : publicIdFromUuid(id, "STF"),
    email: String(row.email),
    role,
    status,
    createdAt: new Date(row.created_at as string | Date),
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at as string | Date) : null,
  };
}

export async function findStaffByEmail(email: string): Promise<Staff | null> {
  const db = await getReadyDb();
  const [row] = await db`
    SELECT id, public_id, email, role, status, created_at, last_seen_at
    FROM staff WHERE email = ${email}
  `;
  return row ? mapStaff(row) : null;
}

export async function touchStaffLastSeen(id: string): Promise<void> {
  const db = await getReadyDb();
  await db`UPDATE staff SET last_seen_at = now() WHERE id = ${id}`;
}

export async function listStaff(): Promise<Staff[]> {
  const db = await getReadyDb();
  const rows = await db`
    SELECT id, public_id, email, role, status, created_at, last_seen_at
    FROM staff ORDER BY created_at
  `;
  return rows.map(mapStaff);
}

export async function insertStaff(input: { email: string; role: StaffRole }): Promise<Staff> {
  const db = await getReadyDb();
  const [row] = await db`
    INSERT INTO staff (email, role, status)
    VALUES (${input.email}, ${input.role}, 'active')
    RETURNING id, public_id, email, role, status, created_at, last_seen_at
  `;
  const mapped = mapStaff(row);
  if (!row.public_id) {
    await db`UPDATE staff SET public_id = ${mapped.publicId} WHERE id = ${mapped.id}`;
  }
  return mapped;
}

export async function updateStaffRole(id: string, role: StaffRole): Promise<Staff | null> {
  const db = await getReadyDb();
  const [row] = await db`
    UPDATE staff SET role = ${role} WHERE id = ${id}
    RETURNING id, public_id, email, role, status, created_at, last_seen_at
  `;
  return row ? mapStaff(row) : null;
}

export async function updateStaffStatus(id: string, status: StaffStatus): Promise<Staff | null> {
  const db = await getReadyDb();
  const [row] = await db`
    UPDATE staff SET status = ${status} WHERE id = ${id}
    RETURNING id, public_id, email, role, status, created_at, last_seen_at
  `;
  return row ? mapStaff(row) : null;
}

export { type Staff, type StaffRole, type StaffStatus };
