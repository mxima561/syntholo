import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const instant = (name: string) => timestamp(name, { precision: 3, withTimezone: true });

export const waitlistSignups = pgTable("waitlist_signups", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  createdAt: instant("created_at").notNull().defaultNow(),
  source: text("source").notNull(),
}, (table) => [
  unique("waitlist_signups_email_unique").on(table.email),
  check(
    "waitlist_signups_email_normalized_check",
    sql`${table.email} = lower(btrim(${table.email}))
      and octet_length(${table.email}) between 3 and 254
      and ${table.email} ~ '^[a-z0-9._%+\\-]+@[a-z0-9.-]+\\.[a-z]{2,}$'
      and position('..' in ${table.email}) = 0`,
  ),
  check("waitlist_signups_source_check", sql`${table.source} = 'school'`),
  check(
    "waitlist_signups_created_at_check",
    sql`isfinite(${table.createdAt}) and ${table.createdAt} = date_trunc('milliseconds', ${table.createdAt})`,
  ),
]);
