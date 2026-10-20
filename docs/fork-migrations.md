# Fork migrations

This fork keeps its own database migrations separate from upstream Dokploy's.

| Folder | Owner | Tracking table |
|---|---|---|
| `apps/dokploy/drizzle/` | Upstream. Never edit it here. | `drizzle.__drizzle_migrations` |
| `apps/dokploy/drizzle-fork/` | This fork | `drizzle.__drizzle_fork_migrations` |

At startup (`migration.ts`, `server/db/migration.ts`) upstream migrations run first, then fork migrations.

## Why

Drizzle doesn't apply migrations by number. It records the `when` timestamp of the last applied migration and only runs migrations with a later timestamp. Sharing one folder with upstream means:

- An upstream migration generated before one of ours, but merged after it, is silently skipped on every database that already ran ours.
- `_journal.json` and the snapshot chain conflict on every merge, and `drizzle-kit generate` then diffs against the wrong snapshot.

Tracking the two sets in separate tables removes both problems.

## Rules

- **Additive only.** Fork migrations may add tables, columns, enums, enum values and indexes. They must not drop, rename or change upstream columns, or upstream migrations that touch them will break on fork databases. Leave the upstream column in place and stop reading it instead (see `serverType` / `serverRoles`).
- **Distinct names.** Avoid table and column names upstream is likely to pick for the same concept.
- **Never edit `drizzle/`.** `git diff upstream/canary -- apps/dokploy/drizzle` should always be empty.

## Generating a migration

Change the Drizzle schema as usual, then:

```sh
cd apps/dokploy
pnpm migration:generate:fork <snake_case_name>
```

The script builds a baseline snapshot (upstream's latest snapshot plus the changes already in `drizzle-fork/`), has `drizzle-kit` diff the schema against it, and writes only the new changes to `drizzle-fork/NNNN_<name>.sql`.

Always review the SQL before committing:

- Remove statements that only exist because upstream's schema and snapshot have drifted (for example, at the time of writing, a `whitelabelingConfig` default change). Those belong to upstream.
- Add any data backfill by hand.

Running it with no schema changes prints `No fork schema changes`.

## After merging upstream

Nothing to do. Upstream migrations apply through their own table, and the next fork generation picks up upstream's new latest snapshot automatically: each fork journal entry records the upstream snapshot it was based on (`upstreamSnapshotId`), and the script three-way merges from there.

If upstream adds something that conflicts with a fork change (for example, its own version of a column we added), resolve it by hand. Usually that means a fork migration that migrates our data onto upstream's column and stops using ours.
