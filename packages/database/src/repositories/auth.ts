import type { MemberActor } from "@syntholo/domain";
import type { Database } from "../client.js";

export interface EncryptedDatabaseValue {
  keyVersion: number;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export interface DatabaseLoginAttempt {
  stateHash: Buffer;
  browserNonceHash: Buffer;
  encryptedCodeVerifier: EncryptedDatabaseValue;
  priorSessionHash: Buffer | null;
  returnTo: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface DatabaseAccessClaims {
  accessUserId: string;
  accessSessionId: string;
  organizationId: string;
  roles: readonly string[];
  permissions: readonly string[];
  expiresAt: Date;
  authenticatedAt: Date;
}

export interface DatabaseStaffSession {
  sessionHash: Buffer;
  staffIdentityId: string;
  accessUserId: string;
  accessSessionId: string;
  organizationId: string;
  providerRoles: readonly string[];
  providerPermissions: readonly string[];
  encryptedTokens: EncryptedDatabaseValue;
  accessTokenExpiresAt: Date;
  hardExpiresAt: Date;
  authenticatedAt: Date;
  refreshVersion: number;
  refreshLeaseId: string | null;
  refreshLeaseExpiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DatabaseStaffIdentity {
  actorId: string;
  accessUserId: string;
  staffId: string;
  role: "coach" | "admin";
  permissions: readonly string[];
}

type LoginRow = {
  state_hash: Buffer;
  browser_nonce_hash: Buffer;
  verifier_ciphertext: Buffer;
  verifier_iv: Buffer;
  verifier_tag: Buffer;
  key_version: number;
  prior_session_hash: Buffer | null;
  return_to: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
};

type SessionRow = {
  session_hash: Buffer;
  previous_session_hash: Buffer | null;
  staff_identity_id: string;
  removed_user_id: string;
  removed_session_id: string;
  organization_id: string;
  provider_roles: string[];
  provider_permissions: string[];
  token_ciphertext: Buffer;
  token_iv: Buffer;
  token_tag: Buffer;
  key_version: number;
  access_token_expires_at: Date;
  hard_expires_at: Date;
  authenticated_at: Date;
  refresh_version: number;
  refresh_lease_id: string | null;
  refresh_lease_expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const sessionColumns = `
  session_hash, previous_session_hash, staff_identity_id, removed_user_id, removed_session_id,
  organization_id, provider_roles, provider_permissions, token_ciphertext,
  token_iv, token_tag, key_version, access_token_expires_at, hard_expires_at,
  authenticated_at, refresh_version, refresh_lease_id,
  refresh_lease_expires_at, revoked_at, created_at, updated_at`;

function mapLogin(row: LoginRow): DatabaseLoginAttempt {
  return {
    stateHash: row.state_hash,
    browserNonceHash: row.browser_nonce_hash,
    encryptedCodeVerifier: {
      keyVersion: row.key_version,
      iv: row.verifier_iv,
      ciphertext: row.verifier_ciphertext,
      tag: row.verifier_tag,
    },
    priorSessionHash: row.prior_session_hash,
    returnTo: row.return_to,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

function mapSession(row: SessionRow): DatabaseStaffSession {
  return {
    sessionHash: row.session_hash,
    staffIdentityId: row.staff_identity_id,
    accessUserId: row.removed_user_id,
    accessSessionId: row.removed_session_id,
    organizationId: row.organization_id,
    providerRoles: row.provider_roles,
    providerPermissions: row.provider_permissions,
    encryptedTokens: {
      keyVersion: row.key_version,
      iv: row.token_iv,
      ciphertext: row.token_ciphertext,
      tag: row.token_tag,
    },
    accessTokenExpiresAt: row.access_token_expires_at,
    hardExpiresAt: row.hard_expires_at,
    authenticatedAt: row.authenticated_at,
    refreshVersion: row.refresh_version,
    refreshLeaseId: row.refresh_lease_id,
    refreshLeaseExpiresAt: row.refresh_lease_expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MemberIdentityRepository {
  constructor(private readonly database: Database) {}

  async findMemberActorByClerkUserId(clerkUserId: string): Promise<MemberActor | null> {
    const result = await this.database.pool.query<{
      actor_id: string;
      account_id: string;
      membership_id: string;
      role: "owner" | "teammate";
    }>("select * from member_actor_for_clerk_user($1)", [clerkUserId]);
    const row = result.rows[0];
    if (!row || (row.role !== "owner" && row.role !== "teammate")) return null;
    return Object.freeze({
      kind: "member",
      actorId: row.actor_id,
      clerkUserId,
      accountId: row.account_id,
      membershipId: row.membership_id,
      role: row.role,
      authenticatedAt: new Date(0),
    });
  }
}

export class StaffIdentityRepository {
  constructor(private readonly database: Database) {}

  async findStaffIdentityByAccessUserId(
    accessUserId: string,
  ): Promise<DatabaseStaffIdentity | null> {
    const result = await this.database.pool.query<{
      id: string;
      provider_user_id: string;
      role: string;
      permissions: string[];
    }>(
      `select id, provider_user_id, role, permissions
       from staff_identities
       where provider = 'access' and provider_user_id = $1 and status = 'active'
       limit 1`,
      [accessUserId],
    );
    const row = result.rows[0];
    if (!row || (row.role !== "coach" && row.role !== "admin")) return null;
    return Object.freeze({
      actorId: row.id,
      accessUserId: row.provider_user_id,
      staffId: row.id,
      role: row.role,
      permissions: Object.freeze([...row.permissions]),
    });
  }
}

export class StaffLoginAttemptRepository {
  constructor(private readonly database: Database) {}

  async create(record: DatabaseLoginAttempt): Promise<void> {
    const created = await this.database.pool.query<{ staff_create_login_attempt: boolean }>(
      "select staff_create_login_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        record.stateHash,
        record.browserNonceHash,
        record.encryptedCodeVerifier.ciphertext,
        record.encryptedCodeVerifier.iv,
        record.encryptedCodeVerifier.tag,
        record.encryptedCodeVerifier.keyVersion,
        record.priorSessionHash,
        record.returnTo,
        record.expiresAt,
      ],
    );
    if (created.rows[0]?.staff_create_login_attempt !== true) {
      throw new Error("STAFF_LOGIN_ATTEMPT_REJECTED");
    }
  }

  async consume(input: {
    stateHash: Buffer;
    browserNonceHash: Buffer;
    now: Date;
  }): Promise<DatabaseLoginAttempt | null> {
    void input.now;
    const result = await this.database.pool.query<LoginRow>(
      "select * from staff_consume_login_attempt($1, $2)",
      [input.stateHash, input.browserNonceHash],
    );
    return result.rows[0] ? mapLogin(result.rows[0]) : null;
  }
}

export class StaffSessionRepository {
  constructor(private readonly database: Database) {}

  async create(
    record: DatabaseStaffSession,
    expectedPriorSessionHash: Buffer | null = null,
  ): Promise<void> {
    const issued = await this.database.pool.query<{ staff_rotate_session: boolean }>(
        `select staff_rotate_session($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          expectedPriorSessionHash,
          record.sessionHash,
          record.staffIdentityId,
          record.accessUserId,
          record.accessSessionId,
          record.organizationId,
          record.providerRoles,
          record.providerPermissions,
          record.encryptedTokens.ciphertext,
          record.encryptedTokens.iv,
          record.encryptedTokens.tag,
          record.encryptedTokens.keyVersion,
          record.accessTokenExpiresAt,
          record.hardExpiresAt,
          record.authenticatedAt,
        ],
      );
    if (issued.rows[0]?.staff_rotate_session !== true) {
      throw new Error("STAFF_SESSION_ISSUE_REJECTED");
    }
  }

  async findByHash(sessionHash: Buffer): Promise<DatabaseStaffSession | null> {
    const result = await this.database.pool.query<SessionRow>(
      `select ${sessionColumns} from staff_sessions where session_hash=$1 limit 1`,
      [sessionHash],
    );
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async tryAcquireRefresh(input: {
    sessionHash: Buffer;
    expectedVersion: number;
    leaseId: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<DatabaseStaffSession | null> {
    const result = await this.database.pool.query<SessionRow>(
      `select ${sessionColumns} from staff_acquire_refresh($1,$2,$3,$4)`,
      [
        input.sessionHash,
        input.expectedVersion,
        input.leaseId,
        Math.max(1, Math.ceil((input.leaseExpiresAt.getTime() - input.now.getTime()) / 1000)),
      ],
    );
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async completeRefresh(input: {
    sessionHash: Buffer;
    leaseId: string;
    expectedVersion: number;
    encryptedTokens: EncryptedDatabaseValue;
    claims: DatabaseAccessClaims;
    now: Date;
  }): Promise<DatabaseStaffSession | null> {
    const result = await this.database.pool.query<SessionRow>(
      `select ${sessionColumns} from staff_complete_refresh($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.sessionHash,
        input.leaseId,
        input.expectedVersion,
        input.encryptedTokens.ciphertext,
        input.encryptedTokens.iv,
        input.encryptedTokens.tag,
        input.encryptedTokens.keyVersion,
        input.claims.expiresAt,
        input.claims.authenticatedAt,
        input.claims.roles,
        input.claims.permissions,
      ],
    );
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async releaseRefresh(input: {
    sessionHash: Buffer;
    leaseId: string;
    now: Date;
  }): Promise<void> {
    void input.now;
    await this.database.pool.query(
      "select staff_release_refresh($1, $2)",
      [input.sessionHash, input.leaseId],
    );
  }

  async revoke(
    sessionHash: Buffer,
    revokedAt: Date,
  ): Promise<{ accessSessionId: string } | null> {
    void revokedAt;
    const result = await this.database.pool.query<{ removed_session_id: string }>(
      "select * from staff_revoke_session($1)",
      [sessionHash],
    );
    const row = result.rows[0];
    return row ? { accessSessionId: row.removed_session_id } : null;
  }
}
