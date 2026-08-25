import { createHash, randomBytes } from "node:crypto";
import { ACADEMY_SEAT_LIMIT, assertCanInviteAcademySeat, assertHoldClear, evaluateEntitlements, reservedSeatsFromCount } from "@syntholo/domain";
import { type DatabaseClient } from "./client";
import { ENTITLEMENT_CONSTRAINT_SQL, HOLD_SCHEMA_SQL, listAccountHolds } from "./holds";
import { normalizeSchoolRole, type SchoolRole } from "./permissions";
import {
  APP_USERS_RLS_SQL,
  CATALOG_RLS_SQL,
  DATA_API_GRANT_SQL,
  PRIVILEGED_TABLE_RLS_SQL,
  RLS_HELPER_SQL,
  rlsPoliciesSql,
} from "./rls";
import { withAccountScope, withSystemScope } from "./scope";

export const ACCOUNT_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS slug TEXT`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS logo_url TEXT`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES app_users(id)`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
  `UPDATE accounts SET slug = 'acct-' || substr(replace(id::text, '-', ''), 1, 12) WHERE slug IS NULL OR slug = ''`,
  `CREATE UNIQUE INDEX IF NOT EXISTS accounts_slug_uidx ON accounts (slug) WHERE slug IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'teammate', 'school_admin', 'teacher', 'student')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE memberships ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
  `ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check`,
  `UPDATE memberships SET role = 'student' WHERE role IN ('teammate', 'member', 'viewer')`,
  `DO $$ BEGIN
    ALTER TABLE memberships ADD CONSTRAINT memberships_role_check
      CHECK (role IN ('owner', 'school_admin', 'teacher', 'student'));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,
  `CREATE INDEX IF NOT EXISTS memberships_account_idx ON memberships (account_id) WHERE status = 'active'`,
  `CREATE TABLE IF NOT EXISTS invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email CITEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    invited_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
];

const CUSTOMER_TABLES = [
  "artifacts",
  "workflows",
  "support_threads",
  "support_messages",
  "entitlement_grants",
  "purchases",
  "software_accounts",
  "enrollments",
  "lesson_progress",
  "certificates",
  "session_rsvps",
  "memberships",
  "invitations",
  "account_holds",
] as const;

const PRIVILEGED_WRITE_TABLES = new Set(["entitlement_grants", "purchases", "accounts", "account_holds"]);

export type MembershipRole = SchoolRole;

export type MembershipRecord = {
  id: string;
  accountId: string;
  userId: string;
  role: MembershipRole;
  status: "active" | "removed";
};

export type SeatMember = MembershipRecord & {
  email: string;
  firstName: string;
  lastName: string;
};

export type InvitationRecord = {
  id: string;
  accountId: string;
  email: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: Date;
};

export type InvitationPreview = {
  email: string;
  accountName: string;
  expiresAt: Date;
  status: InvitationRecord["status"];
};

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function mapMembership(row: Record<string, unknown>): MembershipRecord {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    userId: String(row.user_id),
    role: normalizeSchoolRole(row.role),
    status: row.status === "removed" ? "removed" : "active",
  };
}

export async function listMembershipsForUser(userId: string, db?: DatabaseClient): Promise<MembershipRecord[]> {
  if (!db) return withSystemScope((sql) => listMembershipsForUser(userId, sql));
  const rows = await db`
    SELECT id, account_id, user_id, role, status
    FROM memberships WHERE user_id = ${userId} AND status = 'active'
    ORDER BY created_at
  `;
  return rows.map(mapMembership);
}

export async function findMembershipByUserId(userId: string, db?: DatabaseClient): Promise<MembershipRecord | null> {
  if (!db) return withSystemScope((sql) => findMembershipByUserId(userId, sql));
  const memberships = await listMembershipsForUser(userId, db);
  if (memberships.length === 0) return null;
  const [user] = await db`SELECT active_account_id FROM app_users WHERE id = ${userId}`;
  const activeId = user?.active_account_id ? String(user.active_account_id) : "";
  return memberships.find((row) => row.accountId === activeId) ?? memberships[0] ?? null;
}

export async function setActiveAccount(
  userId: string,
  accountId: string,
  db?: DatabaseClient,
): Promise<MembershipRecord> {
  if (!db) return withSystemScope((sql) => setActiveAccount(userId, accountId, sql));
  const memberships = await listMembershipsForUser(userId, db);
  const membership = memberships.find((row) => row.accountId === accountId);
  if (!membership) throw new Error("You are not a member of that academy account.");
  await db`UPDATE app_users SET active_account_id = ${accountId}, updated_at = now() WHERE id = ${userId}`;
  return membership;
}

export async function ensureAccountForUser(
  userId: string,
  input: { name?: string } = {},
  db?: DatabaseClient,
): Promise<MembershipRecord> {
  if (!db) return withSystemScope((sql) => ensureAccountForUser(userId, input, sql));
  const existing = await findMembershipByUserId(userId, db);
  if (existing) return existing;

  const [user] = await db`SELECT email, business_name, first_name, last_name FROM app_users WHERE id = ${userId}`;
  const name =
    input.name?.trim() ||
    String(user?.business_name ?? "").trim() ||
    `${user?.first_name ?? ""} ${user?.last_name ?? ""}`.trim() ||
    String(user?.email ?? "Academy account");
  const slug = `acct-${userId.replaceAll("-", "").slice(0, 12)}`;

  const [account] = await db`
    INSERT INTO accounts (name, slug, created_by_user_id)
    VALUES (${name}, ${slug}, ${userId})
    RETURNING id
  `;
  const [membership] = await db`
    INSERT INTO memberships (account_id, user_id, role, status)
    VALUES (${account.id}, ${userId}, 'owner', 'active')
    RETURNING id, account_id, user_id, role, status
  `;
  await db`UPDATE app_users SET active_account_id = ${account.id}, updated_at = now() WHERE id = ${userId}`;
  return mapMembership(membership);
}

async function addAccountIdColumns(db: DatabaseClient) {
  for (const table of CUSTOMER_TABLES) {
    if (table === "memberships" || table === "invitations" || table === "account_holds") continue;
    await db.unsafe(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id)`);
  }
}

async function backfillAccountIds(db: DatabaseClient) {
  const users = await db`SELECT id FROM app_users`;
  for (const user of users) {
    await ensureAccountForUser(String(user.id), {}, db);
  }

  const fromUser = [
    ["artifacts", "user_id"],
    ["workflows", "user_id"],
    ["support_threads", "user_id"],
    ["entitlement_grants", "user_id"],
    ["purchases", "user_id"],
    ["software_accounts", "user_id"],
    ["enrollments", "user_id"],
    ["lesson_progress", "user_id"],
    ["certificates", "user_id"],
    ["session_rsvps", "user_id"],
  ] as const;
  for (const [table, column] of fromUser) {
    await db.unsafe(`
      UPDATE ${table} AS t
      SET account_id = m.account_id
      FROM memberships m
      WHERE m.user_id = t.${column} AND t.account_id IS NULL AND m.status = 'active'
    `);
  }
  await db.unsafe(`
    UPDATE support_messages AS m
    SET account_id = t.account_id
    FROM support_threads t
    WHERE t.id = m.thread_id AND m.account_id IS NULL
  `);
}

async function applyUniqueIndexes(db: DatabaseClient) {
  await db.unsafe(`ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_user_id_kind_key`);
  await db.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS artifacts_account_kind_uidx
    ON artifacts (account_id, kind) WHERE account_id IS NOT NULL
  `);
  await db.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS software_accounts_account_uidx
    ON software_accounts (account_id) WHERE account_id IS NOT NULL
  `);
  await db.unsafe(`ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_user_id_key`);
  await db.unsafe(`DROP INDEX IF EXISTS memberships_active_user_uidx`);
  await db.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS memberships_account_user_uidx
    ON memberships (account_id, user_id)
  `);
}

async function enableCustomerRls(db: DatabaseClient) {
  for (const statement of RLS_HELPER_SQL) {
    await db.unsafe(statement);
  }
  await db.unsafe(APP_USERS_RLS_SQL);
  await db.unsafe(rlsPoliciesSql("accounts", "id", true));
  for (const table of CUSTOMER_TABLES) {
    await db.unsafe(rlsPoliciesSql(table, "account_id", PRIVILEGED_WRITE_TABLES.has(table)));
  }
  await db.unsafe(CATALOG_RLS_SQL);
  await db.unsafe(PRIVILEGED_TABLE_RLS_SQL);
  await db.unsafe(DATA_API_GRANT_SQL);
  await db.unsafe(`
    DO $$ BEGIN
      ALTER TABLE courses
        ADD CONSTRAINT courses_school_id_fkey FOREIGN KEY (school_id) REFERENCES accounts(id);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
  await db.unsafe(`
    DO $$ BEGIN
      ALTER TABLE app_users
        ADD CONSTRAINT app_users_active_account_id_fkey FOREIGN KEY (active_account_id) REFERENCES accounts(id);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
}

async function evaluateSeatAccess(accountId: string, db: DatabaseClient) {
  const holds = await listAccountHolds(accountId, db);
  const occupied = await occupiedSeatCount(accountId, db);
  return evaluateEntitlements({
    accountId,
    now: new Date(),
    grants: [],
    holds,
    seats: reservedSeatsFromCount(occupied),
  });
}

export async function bootstrapAccountModel(db: DatabaseClient) {
  for (const statement of ACCOUNT_SCHEMA_SQL) {
    await db.unsafe(statement);
  }
  for (const statement of HOLD_SCHEMA_SQL) {
    await db.unsafe(statement);
  }
  for (const statement of ENTITLEMENT_CONSTRAINT_SQL) {
    await db.unsafe(statement);
  }
  await addAccountIdColumns(db);
  await withSystemScope(async (tx) => {
    await backfillAccountIds(tx);
  }, db);
  await applyUniqueIndexes(db);
  await enableCustomerRls(db);
}

export async function listMemberships(accountId: string): Promise<MembershipRecord[]> {
  return withAccountScope(accountId, async (db) => {
    const rows = await db`
      SELECT id, account_id, user_id, role, status
      FROM memberships WHERE account_id = ${accountId} AND status = 'active'
      ORDER BY created_at
    `;
    return rows.map(mapMembership);
  });
}

export async function listSeatMembers(accountId: string): Promise<SeatMember[]> {
  return withAccountScope(accountId, async (db) => {
    const rows = await db`
      SELECT m.id, m.account_id, m.user_id, m.role, m.status,
        u.email, u.first_name, u.last_name
      FROM memberships m
      JOIN app_users u ON u.id = m.user_id
      WHERE m.account_id = ${accountId} AND m.status = 'active'
      ORDER BY m.created_at
    `;
    return rows.map((row) => ({
      ...mapMembership(row),
      email: String(row.email),
      firstName: String(row.first_name ?? ""),
      lastName: String(row.last_name ?? ""),
    }));
  });
}

export async function listPendingInvitations(accountId: string): Promise<InvitationRecord[]> {
  return withAccountScope(accountId, async (db) => {
    const rows = await db`
      SELECT id, account_id, email, status, expires_at
      FROM invitations
      WHERE account_id = ${accountId} AND status = 'pending' AND expires_at > now()
      ORDER BY created_at
    `;
    return rows.map((row) => ({
      id: String(row.id),
      accountId: String(row.account_id),
      email: String(row.email),
      status: "pending" as const,
      expiresAt: new Date(row.expires_at as string),
    }));
  });
}

export async function occupiedSeatCount(accountId: string, db: DatabaseClient) {
  const [members] = await db`
    SELECT COUNT(*)::int AS count FROM memberships WHERE account_id = ${accountId} AND status = 'active'
  `;
  const [invites] = await db`
    SELECT COUNT(*)::int AS count FROM invitations
    WHERE account_id = ${accountId} AND status = 'pending' AND expires_at > now()
  `;
  return Number(members.count) + Number(invites.count);
}

export async function inviteTeammate(input: {
  accountId: string;
  email: string;
  invitedBy: string;
}): Promise<{ token: string; invitation: InvitationRecord }> {
  const email = input.email.trim().toLowerCase();
  return withAccountScope(input.accountId, async (db) => {
    const access = await evaluateSeatAccess(input.accountId, db);
    assertHoldClear(access, "seat_changes");
    assertCanInviteAcademySeat(access.reservedSeats);
    const [duplicate] = await db`
      SELECT id FROM invitations
      WHERE account_id = ${input.accountId} AND email = ${email} AND status = 'pending' AND expires_at > now()
    `;
    if (duplicate) throw new Error("That email already has a pending invitation.");
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [row] = await db`
      INSERT INTO invitations (account_id, email, token_hash, invited_by, expires_at)
      VALUES (${input.accountId}, ${email}, ${hashToken(token)}, ${input.invitedBy}, ${expiresAt})
      RETURNING id, account_id, email, status, expires_at
    `;
    return {
      token,
      invitation: {
        id: String(row.id),
        accountId: String(row.account_id),
        email: String(row.email),
        status: "pending",
        expiresAt: new Date(row.expires_at as string),
      },
    };
  });
}

export async function revokeInvitation(accountId: string, invitationId: string) {
  return withAccountScope(accountId, async (db) => {
    assertHoldClear(await evaluateSeatAccess(accountId, db), "seat_changes");
    await db`
      UPDATE invitations SET status = 'revoked'
      WHERE id = ${invitationId} AND account_id = ${accountId} AND status = 'pending'
    `;
  });
}

export async function revokeMembership(accountId: string, membershipId: string) {
  return withAccountScope(accountId, async (db) => {
    assertHoldClear(await evaluateSeatAccess(accountId, db), "seat_changes");
    const [target] = await db`
      SELECT id, role FROM memberships WHERE id = ${membershipId} AND account_id = ${accountId} AND status = 'active'
    `;
    if (!target) return;
    if (target.role === "owner") {
      const [owners] = await db`
        SELECT COUNT(*)::int AS count FROM memberships
        WHERE account_id = ${accountId} AND status = 'active' AND role = 'owner'
      `;
      if (Number(owners.count) <= 1) throw new Error("Cannot remove the last owner.");
    }
    await db`UPDATE memberships SET status = 'removed' WHERE id = ${membershipId}`;
  });
}

export async function getInvitationPreview(token: string): Promise<InvitationPreview | null> {
  const tokenHash = hashToken(token);
  return withSystemScope(async (db) => {
    const [invite] = await db`
      SELECT i.email, i.status, i.expires_at, a.name AS account_name
      FROM invitations i
      JOIN accounts a ON a.id = i.account_id
      WHERE i.token_hash = ${tokenHash}
    `;
    if (!invite) return null;
    return {
      email: String(invite.email),
      accountName: String(invite.account_name ?? "Academy account"),
      expiresAt: new Date(invite.expires_at as string),
      status: invite.status as InvitationRecord["status"],
    };
  });
}

export async function acceptInvitation(token: string, userId: string): Promise<MembershipRecord> {
  const tokenHash = hashToken(token);
  return withSystemScope(async (db) => {
    const [invite] = await db`
      SELECT id, account_id, email, status, expires_at
      FROM invitations WHERE token_hash = ${tokenHash}
    `;
    if (!invite || invite.status !== "pending" || new Date(invite.expires_at as string) <= new Date()) {
      throw new Error("This invitation is not valid.");
    }
    const accountId = String(invite.account_id);
    const [user] = await db`SELECT email FROM app_users WHERE id = ${userId}`;
    if (user && String(user.email).toLowerCase() !== String(invite.email).toLowerCase()) {
      throw new Error("Sign in with the invited email address to accept this seat.");
    }
    const memberships = await listMembershipsForUser(userId, db);
    const already = memberships.find((row) => row.accountId === accountId);
    if (already) {
      await db`UPDATE invitations SET status = 'accepted' WHERE id = ${invite.id}`;
      await db`UPDATE app_users SET active_account_id = ${accountId}, updated_at = now() WHERE id = ${userId}`;
      return already;
    }
    const occupied = await occupiedSeatCount(accountId, db);
    if (occupied > ACADEMY_SEAT_LIMIT) {
      throw new Error("This academy account already has three seats.");
    }
    const [membership] = await db`
      INSERT INTO memberships (account_id, user_id, role, status)
      VALUES (${accountId}, ${userId}, 'student', 'active')
      ON CONFLICT (account_id, user_id) DO UPDATE SET status = 'active', role = EXCLUDED.role, updated_at = now()
      RETURNING id, account_id, user_id, role, status
    `;
    await db`UPDATE invitations SET status = 'accepted' WHERE id = ${invite.id}`;
    await db`UPDATE app_users SET active_account_id = ${accountId}, updated_at = now() WHERE id = ${userId}`;
    return mapMembership(membership);
  });
}
