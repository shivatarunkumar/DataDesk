-- Onboarded upload targets: an admin registers a table (a BigQuery dataset.table, a
-- Postgres database.schema.table, Oracle later) together with its data contract. Every
-- active onboarded table is offered to everyone in "Load to table"; a file sent to it is
-- validated against the table's live schema AND the contract before an admin approves it.
--
-- The contract is JSON so rules can grow without migrations:
--   {"columns": [{"name": "customer_id", "required": true, "unique": true,
--                 "regex": "^C[0-9]{6}$", "enum": [...], "min": 0, "max": 100,
--                 "min_length": 1, "max_length": 50, "description": "..."}],
--    "reject_unknown_columns": true, "max_rows": 50000}
-- contract_version goes up whenever the contract changes, and each load request records
-- the version it was checked against.

CREATE TABLE upload_targets (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    target_type      text NOT NULL CHECK (target_type IN ('bigquery', 'postgres', 'oracle')),
    -- BigQuery dataset, or Postgres/Oracle database
    database_name    text NOT NULL CHECK (database_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,1023}$'),
    -- Postgres/Oracle schema; NULL for BigQuery
    schema_name      text CHECK (schema_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'),
    table_name       text NOT NULL CHECK (table_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,1023}$'),
    -- what people see in the dropdown, e.g. "Customer master"
    display_name     text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
    description      text CHECK (length(description) <= 2000),
    -- which write modes people may pick, and the upsert key when upsert is allowed
    write_modes      text[] NOT NULL DEFAULT ARRAY['append']
                     CHECK (cardinality(write_modes) > 0 AND write_modes <@ ARRAY['append', 'upsert']),
    key_columns      jsonb NOT NULL DEFAULT '[]'::jsonb,
    contract         jsonb NOT NULL DEFAULT '{"columns": []}'::jsonb,
    contract_version integer NOT NULL DEFAULT 1 CHECK (contract_version >= 1),
    -- the table's columns when it was onboarded or last edited: [{name, type, nullable}]
    schema_snapshot  jsonb,
    is_active        boolean NOT NULL DEFAULT true,
    created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
    updated_by       uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CHECK ('upsert' <> ALL (write_modes) OR jsonb_array_length(key_columns) > 0)
);

-- one onboarding per physical table (schema is NULL for BigQuery, hence coalesce)
CREATE UNIQUE INDEX upload_targets_table_key
    ON upload_targets (target_type, database_name, coalesce(schema_name, ''), table_name);
-- what the "Load to table" dropdown lists
CREATE INDEX upload_targets_active_idx ON upload_targets (target_type, database_name) WHERE is_active;

CREATE TRIGGER upload_targets_set_updated_at BEFORE UPDATE ON upload_targets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which onboarded target a request was for, and the contract version it passed.
ALTER TABLE upload_requests
    ADD COLUMN target_id        uuid REFERENCES upload_targets (id) ON DELETE SET NULL,
    ADD COLUMN contract_version integer;

CREATE INDEX upload_requests_target_idx ON upload_requests (target_id);
