-- Governed loads: a request to write one version of a workspace file into a target table.
-- It is created only after the file passes validation against the table's live schema;
-- nothing is written to the target until an admin approves, and the file is validated
-- again at that moment because the table may have changed.

CREATE TABLE upload_requests (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    file_id           uuid NOT NULL REFERENCES workspace_files (id) ON DELETE CASCADE,
    -- the exact version that was validated
    file_version      integer NOT NULL,
    target_type       text NOT NULL CHECK (target_type IN ('postgres', 'bigquery', 'oracle')),
    -- Postgres database name, or BigQuery dataset
    target_database   text,
    target_schema     text,
    target_table      text NOT NULL,
    write_mode        text NOT NULL CHECK (write_mode IN ('append', 'upsert')),
    key_columns       jsonb,
    justification     text,
    validation_status text CHECK (validation_status IN ('passed', 'failed')),
    validation_report jsonb,
    status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'completed', 'failed')),
    reviewed_by       uuid REFERENCES users (id),
    reviewed_at       timestamptz,
    review_note       text,
    executed_at       timestamptz,
    -- {inserted, updated} / {affected, rows} on success, {error} on failure
    result            jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CHECK (write_mode = 'append' OR jsonb_array_length(coalesce(key_columns, '[]'::jsonb)) > 0)
);

-- the admin review queue, and "my requests"
CREATE INDEX upload_requests_status_idx ON upload_requests (status, created_at);
CREATE INDEX upload_requests_user_idx ON upload_requests (user_id, created_at DESC);
CREATE INDEX upload_requests_file_idx ON upload_requests (file_id);
