# Database access boundary

Syntholo uses four PostgreSQL capability roles. They are group roles, not login
users: `syntholo_migrator`, `syntholo_member_api`, `syntholo_staff_api`, and
`syntholo_worker` are all `NOLOGIN`, `NOSUPERUSER`, and `NOBYPASSRLS`.
Environment-specific login users are created outside application migrations,
receive credentials through the deployment platform, and are granted membership
in exactly one runtime capability. No password or environment login name belongs
in a migration.

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
| `accounts` | customer (`id`) | all current table privileges; admin policy | `SELECT`, `INSERT`, `UPDATE`; scope policy | `SELECT`; cross-account read policy | — |
| `member_identities` | customer (`account_id`) | all; admin policy | `SELECT`, `INSERT`, `UPDATE`; scope policy | `SELECT`; cross-account read policy | — |
| `memberships` | customer (`account_id`) | all; admin policy | `SELECT`, `INSERT`, `UPDATE`; scope policy | `SELECT`; cross-account read policy | — |
| `audit_events` | customer when `account_id` is set | all; admin policy | no grant; defense-in-depth scope policy | `SELECT`; cross-account read policy | `SELECT`, `INSERT`; operational read/insert policies |
| `outbox_events` | customer when `account_id` is set | all; admin policy | no grant; defense-in-depth scope policy | `SELECT`; cross-account read policy | `SELECT`, `INSERT`, `UPDATE`; operational policies |
| `jobs` | customer when `account_id` is set | all; admin policy | no grant; defense-in-depth scope policy | `SELECT`; cross-account read policy | `SELECT`, `INSERT`, `UPDATE`; operational policies |
| `staff_identities` | global staff identity | all | — | `SELECT` for authorized identity lookup | — |
| `provider_event_receipts` | global provider operation | all | — | — | `SELECT`, `INSERT`, `UPDATE` |

Every customer-owned foundation table has RLS both enabled and forced. Member
policies fail closed when `app.account_id` is absent or empty. Member API has no
`DELETE` privilege anywhere and no direct access to audit, outbox, jobs, staff
identity, or provider receipt rows. Staff policies are read-only; cross-account
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
Tests may use a disposable owner connection with startup
`options=-c role=syntholo_member_api`; the integration suite proves the resulting
`current_user`, `session_user`, `rolsuper`, and `rolbypassrls` state so an owner
bypass cannot make the denial tests pass accidentally.

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
