import { createHash, randomBytes } from "node:crypto";
import { ACADEMY_SEAT_LIMIT, assertCanInviteAcademySeat } from "@syntholo/domain";
import { type DatabaseClient } from "./client";
import { withAccountScope, withSystemScope } from "./scope";

export const ACCOUNT_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'teammate')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
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
] as const;

const PRIVILEGED_WRITE_TABLES = new Set(["entitlement_grants", "purchases", "accounts"]);

export type MembershipRole = "owner" | "teammate";

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
    role: row.role === "owner" ? "owner" : "teammate",
    status: row.status === "removed" ? "removed" : "active",
  };
}

export async function findMembershipByUserId(userId: string, db?: DatabaseClient): Promise<MembershipRecord | null> {
  if (!db) return withSystemScope((sql) => findMembershipByUserId(userId, sql));
  const [row] = await db`
    SELECT id, account_id, user_id, role, status
    FROM memberships WHERE user_id = ${userId} AND status = 'active'
  `;
  return row ? mapMembership(row) : null;
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

  const [account] = await db`
    INSERT INTO accounts (name) VALUES (${name}) RETURNING id
  `;
  const [membership] = await db`
    INSERT INTO memberships (account_id, user_id, role, status)
    VALUES (${account.id}, ${userId}, 'owner', 'active')
    RETURNING id, account_id, user_id, role, status
  `;
  return mapMembership(membership);
}

async function addAccountIdColumns(db: DatabaseClient) {
  for (const table of CUSTOMER_TABLES) {
    if (table === "memberships" || table === "invitations") continue;
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
  await db.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS memberships_active_user_uidx
    ON memberships (user_id) WHERE status = 'active'
  `);
}

function rlsPoliciesSql(table: string, matchColumn: string, privilegedWrite: boolean) {
  const bypass = `current_setting('app.actor_kind', true) IN ('staff', 'system')`;
  const member = `${matchColumn}::text = NULLIF(current_setting('app.account_id', true), '')`;
  const selectUsing = `(${bypass} OR ${member})`;
  const writeCheck = privilegedWrite ? bypass : selectUsing;
  return `
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS ${table}_isolation ON ${table};
    DROP POLICY IF EXISTS ${table}_select ON ${table};
    DROP POLICY IF EXISTS ${table}_insert ON ${table};
    DROP POLICY IF EXISTS ${table}_update ON ${table};
    DROP POLICY IF EXISTS ${table}_delete ON ${table};
    CREATE POLICY ${table}_select ON ${table} FOR SELECT USING (${selectUsing});
    CREATE POLICY ${table}_insert ON ${table} FOR INSERT WITH CHECK (${writeCheck});
    CREATE POLICY ${table}_update ON ${table} FOR UPDATE USING (${writeCheck}) WITH CHECK (${writeCheck});
    CREATE POLICY ${table}_delete ON ${table} FOR DELETE USING (${writeCheck});
  `;
}

async function enableCustomerRls(db: DatabaseClient) {
  await db.unsafe(rlsPoliciesSql("accounts", "id", true));
  for (const table of CUSTOMER_TABLES) {
    await db.unsafe(rlsPoliciesSql(table, "account_id", PRIVILEGED_WRITE_TABLES.has(table)));
  }
}

export async function bootstrapAccountModel(db: DatabaseClient) {
  for (const statement of ACCOUNT_SCHEMA_SQL) {
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
    const occupied = await occupiedSeatCount(input.accountId, db);
    assertCanInviteAcademySeat(occupied);
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
    await db`
      UPDATE invitations SET status = 'revoked'
      WHERE id = ${invitationId} AND account_id = ${accountId} AND status = 'pending'
    `;
  });
}

export async function revokeMembership(accountId: string, membershipId: string) {
  return withAccountScope(accountId, async (db) => {
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
    const existing = await findMembershipByUserId(userId, db);
    const [invite] = await db`
      SELECT id, account_id, email, status, expires_at
      FROM invitations WHERE token_hash = ${tokenHash}
    `;
    if (!invite || invite.status !== "pending" || new Date(invite.expires_at as string) <= new Date()) {
      throw new Error("This invitation is not valid.");
    }
    const accountId = String(invite.account_id);
    if (existing && existing.accountId !== accountId) {
      const [memberCount] = await db`
        SELECT COUNT(*)::int AS count FROM memberships
        WHERE account_id = ${existing.accountId} AND status = 'active'
      `;
      const [pendingInvites] = await db`
        SELECT COUNT(*)::int AS count FROM invitations
        WHERE account_id = ${existing.accountId} AND status = 'pending' AND expires_at > now()
      `;
      const soloOwner =
        existing.role === "owner" && Number(memberCount.count) === 1 && Number(pendingInvites.count) === 0;
      if (!soloOwner) {
        throw new Error("This student already belongs to another academy account.");
      }
      await db`UPDATE memberships SET status = 'removed' WHERE id = ${existing.id}`;
    }
    if (existing && existing.accountId === accountId) {
      await db`UPDATE invitations SET status = 'accepted' WHERE id = ${invite.id}`;
      return existing;
    }
    const occupied = await occupiedSeatCount(accountId, db);
    if (occupied > ACADEMY_SEAT_LIMIT) {
      throw new Error("This academy account already has three seats.");
    }
    const [membership] = await db`
      INSERT INTO memberships (account_id, user_id, role, status)
      VALUES (${accountId}, ${userId}, 'teammate', 'active')
      RETURNING id, account_id, user_id, role, status
    `;
    await db`UPDATE invitations SET status = 'accepted' WHERE id = ${invite.id}`;
    return mapMembership(membership);
  });
}
