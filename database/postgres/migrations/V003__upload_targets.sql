-- Where files may be loaded, and who may load into what.
--
-- Postgres targets are registered by hand (pg_databases + pg_tables_catalog); a user may
-- load into a table when they hold an active db_access_grants row for it or its database.
-- BigQuery targets come from a synced cache of datasets/tables; a user may load into a
-- table when they hold an approved, unexpired bq_access_requests row for it or its dataset.
-- Admins may load into every registered target.

-- ------------------------------------------------------------------ Postgres
CREATE TABLE pg_databases (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- the database name swapped into TARGET_DATABASE_URL
    name        text NOT NULL UNIQUE CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'),
    description text,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pg_tables_catalog (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    database_id uuid NOT NULL REFERENCES pg_databases (id) ON DELETE CASCADE,
    table_name  text NOT NULL CHECK (table_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'),
    description text,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (database_id, table_name)
);

CREATE INDEX pg_tables_catalog_database_idx ON pg_tables_catalog (database_id);

CREATE TABLE db_access_requests (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    scope_type     text NOT NULL CHECK (scope_type IN ('database', 'table')),
    database_id    uuid REFERENCES pg_databases (id),
    table_id       uuid REFERENCES pg_tables_catalog (id),
    justification  text,
    -- NULL means permanent
    duration_hours integer CHECK (duration_hours > 0),
    status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by    uuid REFERENCES users (id),
    reviewed_at    timestamptz,
    review_note    text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX db_access_requests_status_idx ON db_access_requests (status);
CREATE INDEX db_access_requests_user_idx ON db_access_requests (user_id, status);

CREATE TABLE db_access_grants (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    scope_type        text NOT NULL CHECK (scope_type IN ('database', 'table')),
    database_id       uuid REFERENCES pg_databases (id),
    table_id          uuid REFERENCES pg_tables_catalog (id),
    source_request_id uuid REFERENCES db_access_requests (id),
    granted_by        uuid NOT NULL REFERENCES users (id),
    granted_at        timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz,
    revoked_at        timestamptz,
    revoked_by        uuid REFERENCES users (id),
    -- a database grant names a database, a table grant names a table
    CHECK ((scope_type = 'database' AND database_id IS NOT NULL)
        OR (scope_type = 'table' AND table_id IS NOT NULL))
);

-- "what may this person load into right now"
CREATE INDEX db_access_grants_active_idx ON db_access_grants (user_id) WHERE revoked_at IS NULL;

-- ------------------------------------------------------------------ BigQuery
CREATE TABLE bq_datasets_cache (
    id          text PRIMARY KEY,
    description text,
    location    text,
    table_count integer,
    synced_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bq_tables_cache (
    dataset_id  text NOT NULL,
    id          text NOT NULL,
    description text,
    num_rows    bigint,
    num_bytes   bigint,
    created_bq  timestamptz,
    modified_bq timestamptz,
    synced_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (dataset_id, id)
);

CREATE TABLE bq_access_requests (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    scope_type     text NOT NULL CHECK (scope_type IN ('dataset', 'table')),
    dataset_id     text,
    table_id       text,
    justification  text,
    -- NULL means permanent
    duration_hours integer CHECK (duration_hours > 0),
    status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    -- set on approval from duration_hours
    expires_at     timestamptz,
    reviewed_by    uuid REFERENCES users (id),
    reviewed_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bq_access_requests_status_idx ON bq_access_requests (status);
CREATE INDEX bq_access_requests_user_idx ON bq_access_requests (user_id);
