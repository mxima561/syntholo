# Database access boundary

Syntholo uses four PostgreSQL capability roles. They are group roles, not login
users: `syntholo_migrator`, `syntholo_member_api`, `syntholo_staff_api`, and
`syntholo_worker` are all `NOLOGIN`, `NOSUPERUSER`, and `NOBYPASSRLS`.
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
owns the migration session and can perform DDL. Member, staff, and worker URLs use
separate least-privilege login members and may use the appropriate Neon pooled
endpoints. A runtime URL must never contain owner or migration credentials.

## Current table access matrix

`scope` means the policy compares the row's `account_id` to the transaction-local
`app.account_id`; the `accounts` policy compares `accounts.id`. `cross-account
read` is a staff-only `SELECT` policy. `operational` is a worker policy limited by
the listed grants. A dash means the role has neither a table grant nor an allowing
policy.

| Table | Ownership | Migrator | Member API | Staff API | Worker |
| --- | --- | --- | --- | --- | --- |
| `accounts` | customer (`id`) | all current table privileges; admin policy | `SELECT`, `INSERT`, `UPDATE`; one command-specific scope policy each | `SELECT`; cross-account read policy | — |
| `member_identities` | customer (`account_id`) | all; admin policy | `SELECT`, `INSERT`, `UPDATE`; one command-specific scope policy each | `SELECT`; cross-account read policy | — |
| `memberships` | customer (`account_id`) | all; admin policy | `SELECT`, `INSERT`, `UPDATE`; one command-specific scope policy each | `SELECT`; cross-account read policy | — |
| `audit_events` | customer when `account_id` is set | all; admin policy | no grant and no policy | `SELECT`; cross-account read policy | `SELECT`, `INSERT`; operational read/insert policies |
| `outbox_events` | customer when `account_id` is set | all; admin policy | no grant and no policy | `SELECT`; cross-account read policy | `SELECT`, `INSERT`, `UPDATE`; operational policies |
| `jobs` | customer when `account_id` is set | all; admin policy | no grant and no policy | `SELECT`; cross-account read policy | `SELECT`, `INSERT`, `UPDATE`; operational policies |
| `staff_identities` | global staff identity | all | — | `SELECT` for authorized identity lookup | — |
| `provider_event_receipts` | global provider operation | all | — | — | `SELECT`, `INSERT`, `UPDATE` |

Every customer-owned foundation table has RLS both enabled and forced. Member
policies fail closed when `app.account_id` is absent or empty. Member API has no
`DELETE` privilege or policy anywhere and no direct access to audit, outbox, jobs,
staff identity, or provider receipt rows. A future Task 7 member operation must add
both its command-specific grant and matching scoped policy in the same migration;
an accidental grant alone must not activate an existing `FOR ALL` policy. Staff
policies are read-only; cross-account
writes require a future, explicitly authorized and audited use case. Worker has no
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

## Pool selection boundary

The API verifies a token and resolves an internal actor before selecting a pool:

| Authorized execution path | Database pool |
| --- | --- |
| Clerk member actor with a resolved account | member login granted `syntholo_member_api` |
| WorkOS staff actor with route permission | staff login granted `syntholo_staff_api` |
| Durable job/outbox/provider processing | worker login granted `syntholo_worker` |
| Versioned production migration | dedicated direct Neon owner/migration login |

The pools are separate objects with separate URLs. Code must not authenticate with
an owner URL and then use `SET ROLE` as a production pool-selection mechanism.
The integration suite connects through separate SQL-created member, staff, and
worker login users and proves `session_user = current_user = runtime login`, safe
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
CREATE ROLE syntholo_worker_runtime
  LOGIN PASSWORD NULL
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT syntholo_member_api TO syntholo_member_runtime
  WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
GRANT syntholo_staff_api TO syntholo_staff_runtime
  WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
GRANT syntholo_worker TO syntholo_worker_runtime
  WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
```

Use `\password syntholo_member_runtime` (and the corresponding staff/worker
command) in a direct `psql` session or an equivalent parameterized password
rotation operation. Put each generated password only in the deployment secret
manager and construct three separate runtime URLs. Never paste a password into a
checked-in SQL file, shell history, ticket, or log.

Before deployment, verify login attributes and direct memberships:

```sql
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
       rolreplication, rolbypassrls, rolconfig
FROM pg_roles
WHERE rolname IN (
  'syntholo_member_runtime',
  'syntholo_staff_runtime',
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

## Capability role migration behavior

Migration 0002 creates a missing capability with only `NOLOGIN PASSWORD NULL`,
whose remaining safe flags are PostgreSQL defaults. It then validates all four
capabilities from catalogs: no login, superuser, database/role creation,
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

## Account-scoped transaction sequence

`withAccountScope` is the canonical member transaction boundary:

1. Validate `accountId` as a lowercase canonical UUID before opening or using a
   database transaction. Failure returns the stable, secret-free
   `ACCOUNT_ID_INVALID` error.
2. Begin a transaction on the member pool.
3. Execute the parameterized
   `select set_config('app.account_id', accountId, true)`. The third argument makes
   the setting transaction-local, equivalent to `SET LOCAL`.
4. Execute repository queries with parameterized Drizzle predicates. RLS remains
   an independent second check.
5. Commit or roll back. PostgreSQL clears the local setting in both cases before
   the pooled connection can serve another request.

Never concatenate an account ID into SQL, issue session-level `SET app.account_id`,
or run a member query outside this transaction. Back-to-back account A/account B,
success, rollback, and unset-scope cases are covered against a one-connection pool
to detect scope leakage.

The `withAccountScope` callback is a trusted package/server-code boundary. Never
pass it untrusted SQL, a plugin callback, or a user-supplied function: the callback
receives the transaction and trusted code could deliberately overwrite a GUC.

`AccountRepository.getById({ accountId }, id)` is the only exported customer read
for accounts. It applies both the account scope and an explicit `accounts.id`
predicate and returns `null` for a cross-account ID, revealing neither whether the
other account exists nor any of its fields. There is no unscoped member-runtime
account read or list method.

## Identity bootstrap boundary

Task 6 must resolve a verified Clerk user to an internal member actor before normal
account-scoped access is possible. This migration intentionally does not weaken
account RLS and does not add an unscoped member identity query. Bootstrap must use
a narrowly privileged identity-resolution path, such as a carefully reviewed
security-definer function with a fixed search path, or a separately authorized
server path and pool. That path must return only the identity data needed to create
the actor and must receive its own audit and authorization review in Task 6.

## Forbidden examples

- A member pool selecting `accounts` without `withAccountScope`: returns no rows.
- A member scoped to account A requesting account B through SQL or
  `AccountRepository`: returns no row/`null`.
- A member inserting audit/outbox/job rows, reading staff/provider rows, or deleting
  an account: PostgreSQL permission denied.
- A staff pool updating any customer-owned foundation row: PostgreSQL permission
  denied even though staff can read across accounts.
- A worker pool reading accounts or member identities, mutating an audit row, or
  deleting a provider receipt: PostgreSQL permission denied.
- A pooled runtime URL used for DDL, or a direct migration/owner URL used for
  member, staff, or worker requests: configuration error and deployment violation.
