# database/

All DataDesk database work lives here: Postgres migrations (DDL), seed data, and the
scripts that apply them. The backend only *uses* the schema; it never creates it.

This is DataDesk's own metadata database (users, folders, files, versions, load requests).
The tables people load files *into* live elsewhere, on the server `TARGET_DATABASE_URL`
points at, or in BigQuery.

## Layout
```
postgres/
  init_db.sql   FIRST script: creates the role, database and privileges
  migrations/   V<NNN>__<name>.sql: the only way the schema changes (forward-only)
  seeds/
    common/     seed data for every environment (idempotent)
    local/      local-only seed data, e.g. the upload targets on your machine
  schema/       schema.sql: generated snapshot for reading/review (don't edit)
scripts/
  setup_db.py     the one command: init_db.sql → migrations → seeds → verify
  init_db.sh      run init_db.sql with the values from DATABASE_URL
  migrate.py      apply pending migrations (`up`) or show `status`
  seed.py         run seeds/common then seeds/$APP_ENV
  check_db.py     check connection, schema, migrations, admins and targets
  reset_local.py  drop + recreate + migrate + seed (APP_ENV=local only, needs --yes)
  dump_schema.sh  regenerate postgres/schema/schema.sql
tests/            migration runner tests
```

## Tables

| Migration | Tables |
|---|---|
| `V001__helpers` | `set_updated_at()` trigger function |
| `V002__users_auth` | `users` (admin-approved registration, lockout), `password_reset_requests` |
| `V003__upload_targets` | `pg_databases`, `pg_tables_catalog`, `db_access_requests`, `db_access_grants`, `bq_datasets_cache`, `bq_tables_cache`, `bq_access_requests` |
| `V004__workspace` | `workspace_folders`, `workspace_files`, `workspace_file_versions` |
| `V005__upload_requests` | `upload_requests` |
| `V006__onboarded_targets` | `upload_targets` (onboarded tables + data contract + version); `upload_requests.target_id`, `contract_version` |
| `V007__fix_target_name_checks` | fixes V006's name CHECKs (Postgres caps regex repetition at 255) |

## How to run the scripts

### The one command (recommended)
```bash
make db-init        # = python database/scripts/setup_db.py
```

| Step | What runs | As | Creates |
|---|---|---|---|
| 1 | `postgres/init_db.sql` | admin (`POSTGRES_ADMIN_URL`) | role, database, privileges |
| 2 | `postgres/migrations/V*.sql` | app user (`DATABASE_URL`) | tables, indexes, triggers |
| 3 | `postgres/seeds/**` | app user | whatever the seed files hold |
| 4 | verify | app user | reports tables, migrations, admins and upload targets |

Useful flags (pass them as `make db-init ARGS="…"`):

| Flag | Effect |
|---|---|
| `--skip-seed` | schema only, no data |
| `--reset --yes` | DROP the database first, then rebuild it (only when `APP_ENV=local`); also `make db-reset` |
| `--database-url`, `--admin-url` | use a different database than `.env` |
| `--wait 60` | wait longer for a server that is still starting |
| `-v` | verbose: show every statement's output |

Example run:
```
12:00:28  INFO    DataDesk database setup → datadesk@localhost/datadesk
12:00:28  INFO    server: PostgreSQL 17.11 (Homebrew)
12:00:28  INFO    running init_db.sql (role datadesk, database datadesk)
12:00:29  INFO    step 1/3 done: role, database, privileges and extensions are in place
[db] applied V001__helpers.sql (23 ms)
…
12:00:29  INFO    verify: database=datadesk tables=14 migrations=5 (latest V005) admins=0 upload_targets=0
12:00:29  INFO    next: create the first admin with  make admin EMAIL=you@company.com
```

It needs Python with `psycopg` (installed by `make install`) and `psql` on the PATH.

### Running a single step
```bash
bash   database/scripts/init_db.sh        # 1. role + database + privileges
python database/scripts/migrate.py up     # 2. tables
python database/scripts/seed.py           # 3. seed data
```
(Run them with `.env` loaded: `source scripts/localenv.sh` first, in bash.)

Settings come from `.env`:
- `POSTGRES_ADMIN_URL`: superuser, used only by `init_db` and resets
- `DATABASE_URL`: the app role, password and database; `init_db.sql` creates them from this URL
- `APP_ENV`: selects the seed folder

## Adding a schema change
1. Create the next file, e.g. `postgres/migrations/V008__file_sharing.sql`. Use lowercase snake_case names.
2. `make db-init`, then `make dump-schema`, and commit both.
3. Never edit a migration that has been applied anywhere. The runner stores a checksum per file and refuses to run if an applied file changes. Fix mistakes with a new migration.
4. Each file runs in one transaction. For statements that can't run in a transaction (e.g. `CREATE INDEX CONCURRENTLY`), make the first line `-- migrate:no-transaction`.
5. Add any table the app can't work without to `required` in `scripts/check_db.py`, and a model in `backend/app/models/`.

Conventions: `uuid` primary keys (`gen_random_uuid()`), `timestamptz` timestamps,
`created_at`/`updated_at` on mutable tables with the `set_updated_at()` trigger (V001),
and `text` + `CHECK` instead of enum types (easier to evolve).

## Tests
`make test` runs `database/tests`. The integration tests create and drop a throwaway
database when `TEST_POSTGRES_ADMIN_URL` is set (the Make target sets it from `.env`).
