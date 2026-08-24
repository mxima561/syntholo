import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { staffIdentities } from "./identity.js";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const timestampWithTimezone = (name: string) =>
  timestamp(name, { withTimezone: true });

export const staffSessions = pgTable(
  "staff_sessions",
  {
    sessionHash: bytea("session_hash").primaryKey(),
    previousSessionHash: bytea("previous_session_hash"),
    staffIdentityId: uuid("staff_identity_id")
      .notNull()
      .references(() => staffIdentities.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    accessUserId: text("removed_user_id").notNull(),
    accessSessionId: text("removed_session_id").notNull().unique(),
    organizationId: text("organization_id").notNull(),
    providerRoles: text("provider_roles").array().notNull(),
    providerPermissions: text("provider_permissions")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    tokenCiphertext: bytea("token_ciphertext").notNull(),
    tokenIv: bytea("token_iv").notNull(),
    tokenTag: bytea("token_tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    accessTokenExpiresAt: timestampWithTimezone("access_token_expires_at").notNull(),
    hardExpiresAt: timestampWithTimezone("hard_expires_at").notNull(),
    authenticatedAt: timestampWithTimezone("authenticated_at").notNull(),
    refreshVersion: integer("refresh_version").notNull().default(0),
    refreshLeaseId: text("refresh_lease_id"),
    refreshLeaseExpiresAt: timestampWithTimezone("refresh_lease_expires_at"),
    revokedAt: timestampWithTimezone("revoked_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("staff_sessions_hash_length_check", sql`octet_length(${table.sessionHash}) = 32`),
    check("staff_sessions_previous_hash_length_check", sql`${table.previousSessionHash} is null or octet_length(${table.previousSessionHash}) = 32`),
    check("staff_sessions_iv_length_check", sql`octet_length(${table.tokenIv}) = 12`),
    check("staff_sessions_tag_length_check", sql`octet_length(${table.tokenTag}) = 16`),
    check("staff_sessions_ciphertext_length_check", sql`octet_length(${table.tokenCiphertext}) between 1 and 140000`),
    check("staff_sessions_key_version_check", sql`${table.keyVersion} > 0`),
    check("staff_sessions_refresh_version_check", sql`${table.refreshVersion} >= 0`),
    check("staff_sessions_roles_check", sql`cardinality(${table.providerRoles}) = 1 and array_position(${table.providerRoles}, NULL) is null`),
    check("staff_sessions_permissions_check", sql`array_position(${table.providerPermissions}, NULL) is null`),
    check("staff_sessions_expiry_check", sql`${table.hardExpiresAt} > ${table.createdAt}`),
    check("staff_sessions_lease_pair_check", sql`(${table.refreshLeaseId} is null) = (${table.refreshLeaseExpiresAt} is null)`),
    index("staff_sessions_staff_identity_idx").on(table.staffIdentityId),
    index("staff_sessions_hard_expiry_idx").on(table.hardExpiresAt),
    index("staff_sessions_active_idx").on(table.sessionHash, table.revokedAt),
    index("staff_sessions_previous_hash_idx").on(table.previousSessionHash),
  ],
);

export const staffLoginAttempts = pgTable(
  "staff_login_attempts",
  {
    stateHash: bytea("state_hash").primaryKey(),
    browserNonceHash: bytea("browser_nonce_hash").notNull().unique(),
    verifierCiphertext: bytea("verifier_ciphertext").notNull(),
    verifierIv: bytea("verifier_iv").notNull(),
    verifierTag: bytea("verifier_tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    priorSessionHash: bytea("prior_session_hash"),
    returnTo: text("return_to").notNull(),
    expiresAt: timestampWithTimezone("expires_at").notNull(),
    consumedAt: timestampWithTimezone("consumed_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  },
  (table) => [
    check("staff_login_attempts_state_hash_check", sql`octet_length(${table.stateHash}) = 32`),
    check("staff_login_attempts_nonce_hash_check", sql`octet_length(${table.browserNonceHash}) = 32`),
    check("staff_login_attempts_prior_hash_check", sql`${table.priorSessionHash} is null or octet_length(${table.priorSessionHash}) = 32`),
    check("staff_login_attempts_iv_check", sql`octet_length(${table.verifierIv}) = 12`),
    check("staff_login_attempts_tag_check", sql`octet_length(${table.verifierTag}) = 16`),
    check("staff_login_attempts_ciphertext_check", sql`octet_length(${table.verifierCiphertext}) between 1 and 4096`),
    check("staff_login_attempts_key_version_check", sql`${table.keyVersion} > 0`),
    check("staff_login_attempts_return_to_check", sql`octet_length(${table.returnTo}) between 1 and 2048`),
    check("staff_login_attempts_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    index("staff_login_attempts_expiry_idx").on(table.expiresAt),
  ],
);
