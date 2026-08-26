import { getReadyDb } from "./client";
import { withSystemScope } from "./scope";
import { publicIdFromUuid } from "./ids";
import { normalizePlatformAdminRole, type PlatformAdminRole } from "./permissions";
import type { Staff, StaffRole, StaffStatus } from "./types";

export type { Staff, StaffRole, StaffStatus };

function mapStaff(row: Record<string, unknown>): Staff {
  const role = normalizePlatformAdminRole(row.role);
  const status: StaffStatus = row.status === "suspended" ? "suspended" : "active";
  const id = String(row.id);
  return {
    id,
    publicId: row.public_id ? String(row.public_id) : publicIdFromUuid(id, "STF"),
    email: String(row.email),
    role,
    status,
    neonUserId: row.neon_user_id ? String(row.neon_user_id) : null,
    createdAt: new Date(row.created_at as string | Date),
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at as string | Date) : null,
  };
}

async function upsertPlatformAdmin(staff: Staff) {
  const db = await getReadyDb();
  await db`
    INSERT INTO platform_admins (staff_id, user_id, role, status)
    VALUES (${staff.id}, ${staff.neonUserId}, ${staff.role}, ${staff.status})
    ON CONFLICT (staff_id) DO UPDATE SET
      user_id = COALESCE(EXCLUDED.user_id, platform_admins.user_id),
      role = EXCLUDED.role,
      status = EXCLUDED.status,
      updated_at = now()
  `;
}

export async function findActiveStaffForIdentity(input: {
  email: string;
  neonUserId?: string | null;
}): Promise<Staff | null> {
  const email = input.email.trim().toLowerCase();
  const neonUserId = input.neonUserId?.trim() || null;
  if (!email && !neonUserId) return null;
  return withSystemScope(async (db) => {
    const [row] = await db`
      SELECT s.id, s.public_id, s.email, s.role, s.status, s.neon_user_id, s.created_at, s.last_seen_at
      FROM staff s
      WHERE s.status = 'active'
        AND (
          (${email} <> '' AND lower(s.email::text) = ${email})
          OR (${neonUserId}::text IS NOT NULL AND s.neon_user_id = ${neonUserId})
          OR (
            ${neonUserId}::text IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM platform_admins pa
              WHERE pa.staff_id = s.id
                AND pa.status = 'active'
                AND pa.user_id = ${neonUserId}
            )
          )
        )
      LIMIT 1
    `;
    return row ? mapStaff(row) : null;
  });
}

export async function isActiveStaffIdentity(input: {
  email: string;
  neonUserId?: string | null;
}): Promise<boolean> {
  return Boolean(await findActiveStaffForIdentity(input));
}

export async function findStaffByEmail(email: string): Promise<Staff | null> {
  const normalized = email.trim().toLowerCase();
  const db = await getReadyDb();
  const [row] = await db`
    SELECT id, public_id, email, role, status, neon_user_id, created_at, last_seen_at
    FROM staff WHERE lower(email::text) = ${normalized}
  `;
  return row ? mapStaff(row) : null;
}

export async function findStaffByNeonUserId(neonUserId: string): Promise<Staff | null> {
  const db = await getReadyDb();
  const [row] = await db`
    SELECT id, public_id, email, role, status, neon_user_id, created_at, last_seen_at
    FROM staff WHERE neon_user_id = ${neonUserId}
  `;
  if (row) return mapStaff(row);
  const [linked] = await db`
    SELECT s.id, s.public_id, s.email, s.role, s.status, s.neon_user_id, s.created_at, s.last_seen_at
    FROM platform_admins p
    JOIN staff s ON s.id = p.staff_id
    WHERE p.user_id = ${neonUserId}
  `;
  return linked ? mapStaff(linked) : null;
}

export async function bindStaffNeonUserId(staffId: string, neonUserId: string): Promise<Staff | null> {
  const db = await getReadyDb();
  const [row] = await db`
    UPDATE staff SET neon_user_id = ${neonUserId}, updated_at = now()
    WHERE id = ${staffId} AND (neon_user_id IS NULL OR neon_user_id = ${neonUserId})
    RETURNING id, public_id, email, role, status, neon_user_id, created_at, last_seen_at
  `;
  if (!row) return null;
  const staff = mapStaff(row);
  await upsertPlatformAdmin(staff);
  return staff;
}

export async function touchStaffLastSeen(id: string): Promise<void> {
  const db = await getReadyDb();
  await db`UPDATE staff SET last_seen_at = now(), updated_at = now() WHERE id = ${id}`;
}

export async function listStaff(): Promise<Staff[]> {
  const db = await getReadyDb();
  const rows = await db`
    SELECT id, public_id, email, role, status, neon_user_id, created_at, last_seen_at
    FROM staff ORDER BY created_at
  `;
  return rows.map(mapStaff);
}

export async function insertStaff(input: { email: string; role: StaffRole }): Promise<Staff> {
  const db = await getReadyDb();
  const role = normalizePlatformAdminRole(input.role);
  const [row] = await db`
    INSERT INTO staff (email, role, status)
    VALUES (${input.email}, ${role}, 'active')
    RETURNING id, public_id, email, role, status, neon_user_id, created_at, last_seen_at
  `;
  const mapped = mapStaff(row);
  if (!row.public_id) {
    await db`UPDATE staff SET public_id = ${mapped.publicId} WHERE id = ${mapped.id}`;
  }
  await upsertPlatformAdmin(mapped);
  return mapped;
}

export async function updateStaffRole(id: string, role: StaffRole): Promise<Staff | null> {
  const db = await getReadyDb();
  const normalized = normalizePlatformAdminRole(role);
  const [row] = await db`
    UPDATE staff SET role = ${normalized}, updated_at = now() WHERE id = ${id}
    RETURNING id, public_id, email, role, status, neon_user_id, created_at, last_seen_at
  `;
  if (!row) return null;
  const staff = mapStaff(row);
  await upsertPlatformAdmin(staff);
  return staff;
}

export async function updateStaffStatus(id: string, status: StaffStatus): Promise<Staff | null> {
  const db = await getReadyDb();
  const [row] = await db`
    UPDATE staff SET status = ${status}, updated_at = now() WHERE id = ${id}
    RETURNING id, public_id, email, role, status, neon_user_id, created_at, last_seen_at
  `;
  if (!row) return null;
  const staff = mapStaff(row);
  await upsertPlatformAdmin(staff);
  return staff;
}

export type { PlatformAdminRole };
