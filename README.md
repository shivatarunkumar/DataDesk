# DataDesk

DataDesk is a personal data workspace with governed loads. Everyone gets a OneDrive-style
space for their CSV, TSV, Excel and JSON files: kept in GCS, edited in the browser like a
spreadsheet, with every save kept as a version. When a file needs to go into a shared
**PostgreSQL** or **BigQuery** table, the owner asks for it; the file is validated against
the table's live schema, an admin approves, and only then is it loaded. Oracle is listed
as coming soon.

It shares its repository conventions and its look with [KnowHub](../KnowHub): the same
Makefile, database tooling, layered FastAPI backend, and Next.js + Tailwind front end in
the same forest-green palette.

## What works today

| Area | What you can do |
|---|---|
| **Accounts** | Request an account (an admin approves it), sign in with email or username, stay signed in (argon2id passwords, JWT in an httpOnly cookie), lockout after 5 wrong passwords |
| **Files** | Folders and sub-folders, drag-and-drop multi-file upload with progress, search across every folder, sort, rename, download, delete |
| **Edit** | Spreadsheet grid: edit cells, add rows and columns, rename a column (double-click its header), resize columns, open long values in a dialog, pick the CSV delimiter; every save is a new version with a note |
| **Versions** | The full history of a file, and a download of any version |
| **Load to table** | Pick BigQuery / PostgreSQL → dataset or database → an onboarded table, see its data contract, append or upsert, and get every schema and contract problem listed by row before anything reaches an admin |
| **Data Studio** | Pick BigQuery or PostgreSQL, browse the onboarded datasets and tables, query them with SQL (one read-only SELECT over onboarded tables only), change a few cells or add a few rows in the result grid, and send them for approval: they pass the same schema and contract checks and the same admin approval as a file. **Export to My files** turns a result into a CSV for bigger edits |
| **Onboarding** | Admins onboard a table (pick a BigQuery dataset or Postgres database and a table from live lists), write its **data contract** per column (required, unique, allowed values, regex, numeric range, text length, a note for uploaders, max rows per file), and choose the allowed write modes and the upsert key. **Test access** first checks that DataDesk's own account can read and write the table for those modes (BigQuery permissions and job rights; Postgres privileges and a unique index on the upsert key) and names the grant to fix anything missing. Every onboarded, open table appears in everyone's "Load to table" list; changing the contract bumps its version |
| **Approvals** | Admins approve or reject loads (the file is validated again at approval, then loaded), approve new accounts, set temporary passwords, suspend people, and see the full history |
| **Appearance** | Light, Dark or Auto, chosen in the top bar; the choice is a cookie, so the server renders the right palette from the first byte |

Not built yet: Oracle loads, moving files between folders.

## Run it locally

What you need: **Python 3.12+**, **Node 20+**, **PostgreSQL 13+** and **psql** on your
PATH, plus `gcloud` credentials for the bucket and BigQuery. `make check` tells you
what's missing.

```bash
cp .env.example .env     # then set the database URLs, JWT_SECRET, GCP_PROJECT_ID, GCS_BUCKET
make install             # .venv for the backend + npm packages for the frontend
make db-init             # creates the role, database and tables
make admin EMAIL=you@company.com   # the first admin (prompts for a password)
make api                 # http://localhost:8001  (leave it running)
make web                 # http://localhost:3001  (in a second terminal)
```

`make db-init` is idempotent: it runs `init_db.sql` (role, database, privileges), then
every pending migration, then the seeds, and it logs each step. Re-run it as often as you
like. `make db-reset` drops the database and rebuilds it from scratch.

| | URL |
|---|---|
| Web app | http://localhost:3001 |
| API docs (Swagger) | http://localhost:8001/docs |
| Health of every dependency | http://localhost:8001/api/v1/health |

Ports are 8001/3001 so DataDesk runs next to KnowHub (8000/3000).

### Settings to change on a new machine

`.env` is not in git (it holds your own passwords and project), so a fresh clone starts
from `.env.example`:

| Key | Set it to |
|---|---|
| `DATABASE_URL` | the app's own role and database, e.g. `postgresql+asyncpg://datadesk:<password>@localhost:5432/datadesk`. `make db-init` creates both from this URL |
| `POSTGRES_ADMIN_URL` | a superuser on the same server, e.g. `postgresql://postgres@localhost:5432/postgres` |
| `TARGET_DATABASE_URL` | a login on the server that holds the upload-target tables; the database at the end is swapped per target |
| `JWT_SECRET` | a fresh random value: `openssl rand -hex 32`. Never copy it between machines or into git |
| `GCP_PROJECT_ID` / `GCS_BUCKET` | the project and the bucket behind the workspace |

Then authenticate to GCP once (no service-account key needed):

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project <your-project>
```

### Check the connections before starting anything

```bash
make check-db     # Postgres: reachable, role, database, migrations, admins, upload targets
make check-gcp    # GCP: config, network, credentials, bucket read/write, BigQuery datasets
make check-all    # the two above, plus the tool check
```

Each prints one line per check and, when something fails, the command that fixes it.
They exit non-zero on failure. `check-gcp` uploads and deletes a small probe object to
prove writes work; `ARGS=--no-write` skips that.

**If the API answers 503 on `/api/v1/health`,** a *required* dependency is unreachable:

- `database` not ok → Postgres isn't running, `DATABASE_URL` is wrong, or `make db-init` hasn't been run
- `storage` not ok → `GCS_BUCKET` is unset or missing, or there are no Application Default Credentials
- `bigquery` not ok → only loads into BigQuery are affected, so the status is `degraded`, not down. `BQ_ENABLED=false` switches it off

## Upload targets

**Onboarding (Admin → Onboarding) is how a table becomes a target.** An admin picks the
table, writes its data contract and opens it for loads; from then on everyone can choose
it in "Load to table". A file sent to it must pass, in order:

1. the table's live schema — columns exist, values fit the types, NOT NULL is respected;
2. the data contract — required columns, unique values, allowed values, regex, ranges, lengths, max rows;
3. the load rules — only the write modes the admin allowed; upserts always match on the admin's key.

Only then is a request filed, recording the contract version it passed. When an admin
approves, the file is checked again against the table and the **current** contract (so
tightening a contract also applies to requests already waiting), then loaded. Pausing a
target hides it from the list without losing its contract.

Oracle is listed but not loadable yet.

The older per-person grants still work alongside onboarding: a `db_access_grants` row
(Postgres) or an approved `bq_access_requests` row (BigQuery) opens a table to one person,
checked against the schema and any file in [backend/data-contracts](backend/data-contracts/README.md).
Postgres targets must live on the server `TARGET_DATABASE_URL` points at.

## Data Studio

For small fixes made directly against a table (a few rows, a few values). Bigger edits
go through a file: **Export to My files** saves the query result as a CSV, which is edited
and loaded with Load to table.

- **Queries are read-only.** One `SELECT` (or `WITH`) statement, over onboarded tables only,
  run as DataDesk's own identity. Postgres runs it in a read-only transaction with a
  statement timeout, after checking the query plan for other tables. BigQuery dry-runs it
  first, to check the statement type, the tables it reads and the bytes it would scan.
  DataDesk's own database is never offered. Limits: `STUDIO_ROW_LIMIT` rows shown,
  `STUDIO_QUERY_TIMEOUT_SECONDS`, `STUDIO_MAX_BYTES_BILLED`.
- **What can be edited.** Existing rows can be edited when the table allows upsert and the
  query returns its upsert key. The key columns themselves are locked. New rows can be
  added whenever the table allows loads. Results from joins, or with computed or renamed
  columns, are read-only.
- **Submitting.** The server reads the edited rows again by key and refuses the submission
  if a changed value is no longer what the person saw, or if a "new" row already exists.
  It then writes the key, the changed columns and the table's required columns to a CSV in
  My files › Data Studio, and files an ordinary load request (`origin = 'studio'`). Up to
  `STUDIO_MAX_CHANGES` rows are sent at a time. The request page shows the approver every
  change as before → after, plus the query the rows came from.

## DataDesk's own identity

Loads never run as a person. Two accounts belong to the application:

| Where | Who DataDesk is | Set up |
|---|---|---|
| Postgres targets | `datadesk_loader` (from `TARGET_DATABASE_URL`): a login with no superuser rights and no table privileges of its own | `make db-init` creates it on the same server as `POSTGRES_ADMIN_URL`. Each onboarded table needs `GRANT SELECT, INSERT` (plus `UPDATE` for upsert) — Test access lists and copies the exact statements |
| BigQuery and GCS | the service account in `GCP_SERVICE_ACCOUNT`, impersonated (no key file) | it needs `roles/bigquery.dataEditor` on the datasets it loads, `roles/bigquery.jobUser` on the project and `roles/storage.objectAdmin` on the bucket; whoever runs the API needs `roles/iam.serviceAccountTokenCreator` on it |

Test access reports which identity it checked as and fails for a superuser or a personal
login. Asking for, onboarding or approving a table is refused — by the API, not just the
page — until every check passes, and changing a table's write modes or upsert key checks again.

## Everyday commands

`make help` lists them all.

| Command | What it does |
|---|---|
| `make check` | verify python3, node, npm and psql are installed |
| `make check-db` / `make check-gcp` / `make check-all` | verify the database and GCP without starting the API |
| `make install` | install every dependency (backend, database/infra tools, frontend) |
| `make db-init` / `make db-reset` | create or rebuild the database |
| `make db-status` / `make db-shell` | list migrations / open psql |
| `make dump-schema` | regenerate `database/postgres/schema/schema.sql` after a migration |
| `make admin EMAIL=…` | create an admin, or promote an existing account |
| `make reset-password LOGIN=…` | set anyone's password directly (e.g. a locked-out admin) |
| `make api` / `make web` | run the API / the web app |
| `make test` | backend + database tests and the frontend type check |
| `make lint` / `make format` | ruff lint and format check / apply |
| `make clean` | remove `.venv`, `node_modules` and build output |

## Logging

`LOG_LEVEL` in `.env` decides how much the API says. Every request gets an id, returned as
the `x-request-id` header and printed on every line it produced, next to the signed-in
username. A 401 names the missing cookie, a failed sign-in says why (while the response
stays identical), and loads log the table and the row counts.

| Setting | Effect |
|---|---|
| `LOG_LEVEL=INFO` | one line per request, plus decisions worth knowing about (default) |
| `LOG_LEVEL=DEBUG` | every SQL statement with its duration, every storage and BigQuery round-trip, each health check timed |
| `LOG_FORMAT=json` | one JSON object per line, for Cloud Logging |
| `SQL_ECHO=true` | every statement SQLAlchemy runs — enormous, so opt in |

## How it fits together

```
Browser ──▶ Next.js (web :3001) ──/api──▶ FastAPI (api :8001) ──▶ PostgreSQL   users, folders, files, versions, requests
                                                               ├─▶ GCS          file bytes, every version
                                                               ├─▶ Postgres     target tables (on approval)
                                                               └─▶ BigQuery     target tables (on approval)
```

The browser only ever calls same-origin `/api/*`; Next proxies it to FastAPI, so the
session cookie stays first-party and there is no CORS to configure. Every external
service sits behind an adapter in `backend/app/adapters/`.

## Repository layout

| Path | Contents |
|---|---|
| `frontend/` | Next.js app (App Router, Tailwind v4): `/` files, `/files/[id]` editor, `/uploads`, `/admin`, `/login`, `/register`, `/forgot-password` |
| `backend/` | FastAPI app: `core/` (config, db, logging, security), `api/v1/` (routes), `services/` (logic), `adapters/` (GCS, BigQuery, target Postgres), `models/`, `schemas/`. Every setting is in `backend/app/core/config.py` |
| `backend/data-contracts/` | optional per-table validation rules |
| `database/` | `init_db.sql`, migrations, seeds and the setup scripts ([README](database/README.md)) |
| `infra/` | `check_gcp.py` and the Python tools the scripts need |
| `scripts/` | `localenv.sh` (loads `.env` for host commands) |
| `.env.example` | every configuration key, documented |

## Tests

```bash
make test   # backend tests, database tests (including a throwaway-database run), frontend type check
make lint
```
