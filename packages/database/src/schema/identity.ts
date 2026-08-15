import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestampWithTimezone = (name: string) =>
  timestamp(name, { withTimezone: true });

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    ownerEstablishedAt: timestamp("owner_established_at", {
      precision: 3,
      withTimezone: true,
    }),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "accounts_status_check",
      sql`${table.status} in ('active', 'suspended', 'deleted')`,
    ),
    check(
      "accounts_name_canonical_check",
      sql`syntholo_account_name_is_canonical(${table.name})`,
    ),
    check(
      "accounts_owner_established_time_check",
      sql`${table.ownerEstablishedAt} is null or (isfinite(${table.ownerEstablishedAt}) and ${table.ownerEstablishedAt} >= '2000-01-01 00:00:00+00'::timestamptz and ${table.ownerEstablishedAt} < '10000-01-01 00:00:00+00'::timestamptz and ${table.ownerEstablishedAt} = date_trunc('milliseconds', ${table.ownerEstablishedAt}))`,
    ),
  ],
);

export const memberIdentities = pgTable(
  "member_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    email: text("email"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("member_identities_provider_user_unique").on(
      table.provider,
      table.providerUserId,
    ),
    unique("member_identities_id_account_unique").on(
      table.id,
      table.accountId,
    ),
    index("member_identities_account_id_idx").on(table.accountId),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    memberIdentityId: uuid("member_identity_id").notNull(),
    role: text("role").notNull().default("teammate"),
    status: text("status").notNull().default("active"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("memberships_account_member_unique").on(
      table.accountId,
      table.memberIdentityId,
    ),
    unique("memberships_id_account_unique").on(table.id, table.accountId),
    unique("memberships_id_account_identity_unique").on(
      table.id,
      table.accountId,
      table.memberIdentityId,
    ),
    foreignKey({
      columns: [table.memberIdentityId, table.accountId],
      foreignColumns: [memberIdentities.id, memberIdentities.accountId],
      name: "memberships_identity_account_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check(
      "memberships_role_check",
      sql`${table.role} in ('owner', 'teammate')`,
    ),
    check(
      "memberships_status_check",
      sql`${table.status} in ('pending', 'active', 'revoked')`,
    ),
    index("memberships_account_status_idx").on(
      table.accountId,
      table.status,
    ),
    uniqueIndex("memberships_one_active_owner_per_account")
      .on(table.accountId)
      .where(sql`${table.role} = 'owner' and ${table.status} = 'active'`),
  ],
);

export const staffIdentities = pgTable(
  "staff_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull().default("workos"),
    providerUserId: text("provider_user_id").notNull(),
    email: text("email"),
    displayName: text("display_name"),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    permissions: text("permissions")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("staff_identities_provider_user_unique").on(
      table.provider,
      table.providerUserId,
    ),
    check(
      "staff_identities_role_check",
      sql`${table.role} in ('coach', 'admin')`,
    ),
    check(
      "staff_identities_status_check",
      sql`${table.status} in ('active', 'suspended', 'disabled')`,
    ),
    check(
      "staff_identities_permissions_no_nulls_check",
      sql`array_position(${table.permissions}, NULL) is null`,
    ),
  ],
);
