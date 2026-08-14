# Database access boundary

Syntholo uses five PostgreSQL capability roles. They are group roles, not login
users: `syntholo_migrator`, `syntholo_member_api`, `syntholo_staff_api`,
`syntholo_system_api`, and `syntholo_worker` are all `NOLOGIN`, `NOSUPERUSER`,
and `NOBYPASSRLS`.
Environment-specific runtime login users are created with SQL in a controlled
direct administrative session, receive credentials through the deployment secret
manager, and are granted membership in exactly one runtime capability. Do not
create a runtime login through the Neon Console, CLI, or API: Neon-provisioned
roles inherit `neon_superuser`, whose `BYPASSRLS` capability invalidates this
boundary. No password or environment login name belongs in an application
migration.

Production migrations are different from runtime traffic. They run through a
dedicated direct Neon owner/migration login, never a transaction-pooled URL. The
login is operationally associated with `syntholo_migrator`; its direct connection
owns the migration session and can perform DDL. Member, staff, signed-provider
system, and worker URLs use separate least-privilege login members and may use
the appropriate Neon pooled endpoints. A runtime URL must never contain owner or
migration credentials.

## Current table access matrix

`scope` means the policy compares the row's `account_id` to the transaction-local
`app.account_id`; the `accounts` policy compares `accounts.id`. `cross-account
read` is a staff-only `SELECT` policy. `operational` is a worker policy limited by
the listed grants. A dash means the role has neither a table grant nor an allowing
policy.

| Table | Ownership | Migrator | Member API | Staff API | System API | Worker |
| --- | --- | --- | --- | --- | --- | --- |
| `accounts` | customer (`id`) | all current table privileges; admin policy | scoped `SELECT` and name update | `SELECT`; cross-account read policy | scoped `SELECT` for closed commands | — |
| `member_identities` | customer (`account_id`) | all; admin policy | scoped `SELECT` | `SELECT`; cross-account read policy | — | — |
| `memberships` | customer (`account_id`) | all; admin policy | scoped `SELECT` | `SELECT`; cross-account read policy | — | — |
| `audit_events` | customer/global fact | insert/select/trigger only; admin policy | scoped `INSERT` only | `SELECT`, attested `INSERT` | scoped attested `INSERT` | — |
| `outbox_events` | customer/global operation | all; admin policy | scoped canonical `INSERT` only | `SELECT`, attested canonical `INSERT` | scoped attested canonical `INSERT` | — |
| `jobs` | customer/global operation | all; admin policy | — | `SELECT` | — | — |
| `job_attempts` | attempt history | all; admin policy | — | `SELECT` | — | — |
| `event_handler_receipts` | delivery fence | all; admin policy | — | `SELECT` | — | — |
| `staff_identities` | global staff identity | all | — | `SELECT` for authorized identity lookup | — | — |
| `staff_sessions` | global staff secret | all | — | `SELECT`; mutations only through narrow security-definer functions | — | — |
| `staff_login_attempts` | global short-lived staff secret | all | — | no direct table grant; create/consume only through narrow security-definer functions | — | — |
| `provider_event_receipts` | global provider operation | all | — | — | — | `SELECT`, `INSERT`, `UPDATE` |
| `entitlement_grants`, `account_holds`, `seat_reservations` | customer (`account_id`) | explicit current privileges; admin policy | scoped `SELECT`; mutations use closed commands | no raw read/write | no raw read/write | — |
| Entitlement sources, commerce/setup receipts, reconciliations, cancellations, hold sources, invitations/tokens, administrative restorations, command ledger | customer (`account_id`) | explicit current privileges; admin policy | no raw read/write | no raw read/write | no raw read/write | — |
| `access_decision_audit` | append-only customer decision fact | `SELECT`, attested `INSERT` | scoped attested `INSERT` | attested `INSERT` | closed-function insert only | — |

Every customer-owned foundation table has RLS both enabled and forced. Member
policies fail closed when `app.account_id` is absent or empty. Member API has no
`DELETE` privilege or policy anywhere and no read access to audit, outbox, jobs,
staff identity, or provider receipt rows. Any future member operation must add
both its command-specific grant and matching scoped policy in the same migration;
an accidental grant alone must not activate an existing `FOR ALL` policy. Staff
domain/customer-table policies are read-only; Task 7 additionally permits only
provenance-attested initial audit/outbox inserts. Task 8 raw commerce and
entitlement tables are not staff-readable: admin plus `entitlements:manage`
uses narrow list/claim/resolve functions, while coaches receive no provider,
billing, invitation-token, or decision history. System API has no raw
entitlement-table access and invokes only its exact allowlisted closed commands.
Other cross-account writes require an explicitly authorized and audited use case. Worker has no
account, member identity, membership, or staff identity access, and cannot delete
operational rows. The migrator policy exists because a non-bypass capability with
table grants would otherwise still be blocked by forced RLS.

`staff_identities` and `provider_event_receipts` are deliberately global. They do
not receive a fictional account scope. Staff identity lookup belongs only to the
staff pool. Provider receipt processing belongs only to the worker pool. Their
privilege boundaries, uniqueness constraints, and application authorization are
the controls for these global rows.

The migration revokes `PUBLIC` schema creation, current table privileges, current
sequence privileges, and direct execution of the account-immutability trigger
function. Each capability receives explicit schema usage and only current table
privileges. Future tables receive no runtime privilege automatically; their owning
migration must make a new access decision.

Migration 0003 adds fixed-search-path functions for login-attempt creation and
consumption, atomic session issue/rotation, refresh lease/CAS transitions,
revocation, and bounded cleanup. Staff runtime receives no direct table insert,
update, or delete privilege for these secret tables. Worker receives only cleanup
execution. Direct attempts to clear revocation, extend hard expiry, steal a lease,
or reset one-time state fail at the ACL boundary.

## Pool selection boundary

The API verifies a token and resolves an internal actor before selecting a pool:

| Authorized execution path | Database pool |
| --- | --- |
| Clerk member actor with a resolved account | member login granted `syntholo_member_api` |
| WorkOS staff actor with route permission | staff login granted `syntholo_staff_api` |
| Signed provider fulfillment/lifecycle command | system login granted `syntholo_system_api` |
| Durable job/outbox/provider processing | worker login granted `syntholo_worker` |
| Versioned production migration | dedicated direct Neon owner/migration login |

The pools are separate objects with separate URLs. Code must not authenticate with
an owner URL and then use `SET ROLE` as a production pool-selection mechanism.
The integration suite connects through separate SQL-created member, staff,
system, and worker login users and proves
`session_user = current_user = runtime login`, safe
role attributes, exact membership options, and the absence of any reachable
owner, migrator, `neon_superuser`, or extra capability membership.

`createDatabase` rejects a connection URL containing the PostgreSQL `options`
query key, including encoded, case-varied, and duplicate spellings. It explicitly
sets safe internal startup options that force `row_security=on` and initialize
`app.account_id` to empty. This object-level value overrides ambient `PGOPTIONS`.
The connection starts fail-closed even when a host process tries to pre-seed an
account ID or turn row security off. Neon transport parameters such as `sslmode`
and `channel_binding` remain allowed.

## Runtime login provisioning and deployment gate

Create runtime login roles only through SQL on the direct administrative
connection. Start with no usable password, set the real password through a secure
interactive/parameterized secret-manager workflow, then grant exactly one
capability. PostgreSQL 16 membership options are explicit:

```sql
CREATE ROLE syntholo_member_runtime
  LOGIN PASSWORD NULL
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE syntholo_staff_runtime
  LOGIN PASSWORD NULL
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE syntholo_system_runtime
  LOGIN PASSWORD NULL
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE syntholo_worker_runtime
  LOGIN PASSWORD NULL
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT syntholo_member_api TO syntholo_member_runtime
  WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
GRANT syntholo_staff_api TO syntholo_staff_runtime
  WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
GRANT syntholo_system_api TO syntholo_system_runtime
  WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
GRANT syntholo_worker TO syntholo_worker_runtime
  WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
```

Use `\password syntholo_member_runtime` (and the corresponding staff/system/worker
command) in a direct `psql` session or an equivalent parameterized password
rotation operation. Put each generated password only in the deployment secret
manager and construct four separate runtime URLs. Never paste a password into a
checked-in SQL file, shell history, ticket, or log.

Before deployment, verify login attributes and direct memberships:

```sql
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
       rolreplication, rolbypassrls, rolconfig
FROM pg_roles
WHERE rolname IN (
  'syntholo_member_runtime',
  'syntholo_staff_runtime',
  'syntholo_system_runtime',
  'syntholo_worker_runtime'
)
ORDER BY rolname;

SELECT member_role.rolname AS member_role,
       parent_role.rolname AS granted_role,
       membership.inherit_option,
       membership.set_option,
       membership.admin_option
FROM pg_auth_members membership
JOIN pg_roles member_role ON member_role.oid = membership.member
JOIN pg_roles parent_role ON parent_role.oid = membership.roleid
WHERE member_role.rolname IN (
  'syntholo_member_runtime',
  'syntholo_staff_runtime',
  'syntholo_system_runtime',
  'syntholo_worker_runtime'
)
ORDER BY member_role.rolname, parent_role.rolname;
```

Each first query row must be login-enabled but false for every privileged flag,
with `rolconfig IS NULL`. The second query must contain exactly one row per login:
its intended runtime capability with `inherit_option=true`, `set_option=false`,
and `admin_option=false`. Recursively inspect parent memberships as well; the
capabilities themselves must not inherit another role. Stop deployment if any
runtime login can reach `neon_superuser`, a database owner, `syntholo_migrator`, a
second capability, or any other role, or if any role/default setting exists.
Application startup performs both halves of this audit: it attests the safe
LOGIN and exact membership edge, then independently resolves the expected
capability OID/name and requires NOLOGIN, no privileged flag, no global or
database-specific setting, and no direct or transitive outbound membership.

## Capability role migration behavior

Migration 0002 creates the original four capabilities with only
`NOLOGIN PASSWORD NULL`; migration 0005 applies the same pattern to
`syntholo_system_api`. Together they validate all five capabilities from
catalogs: no login, superuser, database/role creation,
replication, or RLS bypass; no global `rolconfig`; no global or database-specific
`pg_db_role_setting`; and no outbound membership in another role. Incoming
memberships are allowed because the creating migration actor receives an
administrative relationship and environment login roles inherit capabilities.

When a safe capability already exists, the migration actor must either be the
disposable local superuser or have direct `ADMIN OPTION` on that capability. The
migration performs only `ALTER ROLE ... PASSWORD NULL`, an operation the
non-superuser actor is authorized to perform, and repeats the catalog validation.
It never tries to set protected false attributes such as `NOSUPERUSER`. An unsafe
collision or missing administrative relationship aborts with
`SYNTHOLO_CAPABILITY_ROLE_PROVISIONING_REQUIRED`; operators must repair the role
topology explicitly before retrying.

The system capability receives no DDL, ownership, alternate-schema, column, or
non-allowlisted routine authority. Migration and startup attest all user schemas,
database `CREATE`/`TEMP`, object ownership, direct/transitive membership, table
and column ACLs, and exact routine signatures. A paid provider command runs only
through `createSystemUnitOfWork` after `attestSystemDatabase`; ordinary
`createUnitOfWork` rejects a system actor.

## Account-scoped transaction sequence

`createUnitOfWork` is the canonical member mutation boundary:

1. Validate `accountId` as a lowercase canonical UUID before opening or using a
   database transaction. Failure returns the stable, secret-free
   `ACCOUNT_ID_INVALID` error.
2. Begin a transaction on the member pool.
3. Execute the parameterized
   `select set_config('app.account_id', accountId, true)`. The third argument makes
   the setting transaction-local, equivalent to `SET LOCAL`.
4. Execute only its frozen transaction-bound domain repositories. Raw Drizzle,
   builders, pool clients, and `set_config` are not exposed. RLS remains
   an independent second check.
5. Commit or roll back. PostgreSQL clears the local setting in both cases before
   the pooled connection can serve another request.

The transaction also installs trusted `app.actor_id`, `app.actor_kind`, and
`app.correlation_id` provenance. Never concatenate an account ID into SQL, issue session-level `SET app.account_id`,
or run a member query outside this transaction. Back-to-back account A/account B,
success, rollback, and unset-scope cases are covered against a one-connection pool
to detect scope leakage.

`withAccountScope` and `DatabaseTransaction` remain package-internal mechanics;
they are not root exports and must not be offered to use-case callbacks.
The concrete transaction entitlement repository and its constructor are also
package-internal. Consumers receive only the frozen repository interface on the
canonical `TransactionContext`; an escaped or unawaited repository call fails
after the callback closes. Recent-auth provenance follows the same authority
boundary: only the verified Clerk/WorkOS authentication composition can register
the canonical millisecond instant. A structurally similar actor or caller-chosen
`Date` is never trusted as recent authentication.

`AccountRepository.getById({ accountId }, id)` is the only exported customer read
for accounts. It applies both the account scope and an explicit `accounts.id`
predicate and returns `null` for a cross-account ID, revealing neither whether the
other account exists nor any of its fields. There is no unscoped member-runtime
account read or list method.

The member effective-access reader pins one pool connection and acquires a
session-level shared account advisory lock before `BEGIN REPEATABLE READ, READ
ONLY`. It then revalidates account and membership, captures one trusted UTC
millisecond instant, loads grants/holds/seats, evaluates the frozen snapshot, and
commits before releasing the lock. Suspension, member revocation, and entitlement
mutations take the matching exclusive account-first lock, so a response is wholly
before or wholly after a writer and never a hybrid or post-commit stale snapshot.

## Identity bootstrap boundary

Task 6 resolves a verified Clerk user through
`member_actor_for_clerk_user(text)`, a fixed-search-path security-definer function
executable only by the member capability and migrator. It filters Clerk provider,
active account, active membership, and exact provider user ID; returns at most the
actor, account, membership, and role; and cannot enumerate accounts. It does not
weaken normal account RLS.

## Forbidden examples

- A member pool selecting `accounts` without a scoped repository: returns no rows.
- A member scoped to account A requesting account B through SQL or
  `AccountRepository`: returns no row/`null`.
- A member inserting an initial same-account attested audit/outbox row is allowed;
  reading those rows, inserting jobs, forging provenance/state, or deleting an
  account is denied.
- A staff pool updating any customer-owned foundation row: PostgreSQL permission
  denied even though staff can read across accounts.
- A coach, or a staff session with spoofed context, selecting raw Task 8 sources,
  receipts, holds, invitations/tokens, or decision history: PostgreSQL permission
  denied. Only an attested admin with `entitlements:manage` may use the narrow
  reconciliation projection and claim/resolve commands.
- A system pool reading raw entitlement or Task 6 staff-secret tables, owning an
  object, creating in any user schema, or executing a routine outside the exact
  signed-provider allowlist: startup and command-time attestation fail closed.
- A worker pool reading accounts or member identities, mutating an audit row, or
  deleting a provider receipt: PostgreSQL permission denied.
- A pooled runtime URL used for DDL, or a direct migration/owner URL used for
  member, staff, or worker requests: configuration error and deployment violation.

Audit UPDATE, DELETE, and TRUNCATE are rejected by `ENABLE ALWAYS` triggers even
for the table owner and migrator, and their table ACLs omit those commands. A
database owner can still disable/drop a trigger with DDL; owner/DDL credentials
are therefore a trusted operational boundary and never a runtime credential.

Migration 0004 adds leased `SKIP LOCKED` job/outbox claims, per-attempt random
fences, bounded retries/dead letters, atomic outbox-to-handler-job dispatch, and
recoverable `(handler_name,event_id)` receipts. Worker access to these tables is
only through the exact fixed-search-path claim, lease-renewal, transition,
dispatch, receipt, and fenced worker-audit functions; it has no direct table
read or write grant. During a rolling release, `outbox_events.id` is retained as
a synchronized compatibility identity while `event_id` is the primary domain
identity; the insert trigger and equality constraint keep old and new binaries
consistent. The worker startup attests the
exact `syntholo_worker` capability before polling; it drains active batches before
closing its database connection.
