-- File upload: a file goes to BigQuery through the Cloud Run file processor instead of
-- being loaded by DataDesk. After approval DataDesk copies it into the landing bucket under
-- the name the table's contract expects; Cloud Run validates and loads it and records each
-- attempt in file_audit.job_metadata / validation_metadata, which DataDesk reads back.
--
-- origin 'pipeline' marks these requests. Their write mode comes from the contract:
-- 'append', or 'overwrite' (the table is replaced).

ALTER TABLE upload_requests DROP CONSTRAINT upload_requests_origin_check;
ALTER TABLE upload_requests ADD CONSTRAINT upload_requests_origin_check
    CHECK (origin IN ('file', 'studio', 'pipeline'));

ALTER TABLE upload_requests DROP CONSTRAINT upload_requests_write_mode_check;
ALTER TABLE upload_requests ADD CONSTRAINT upload_requests_write_mode_check
    CHECK (write_mode IN ('append', 'upsert', 'update', 'overwrite'));

ALTER TABLE upload_requests
    -- the business date in the landing name (customer_20261017.csv)
    ADD COLUMN file_date           date,
    -- the name the file lands under, as the contract's file pattern expects
    ADD COLUMN landing_name        text CHECK (length(landing_name) <= 512),
    -- where it was put after approval, and the object generation Cloud Run reports back
    ADD COLUMN landing_uri         text,
    ADD COLUMN landing_generation  text,
    ADD COLUMN landed_at           timestamptz,
    -- the last Cloud Run attempts and checks read from file_audit, and when
    ADD COLUMN pipeline            jsonb,
    ADD COLUMN pipeline_checked_at timestamptz,
    ADD CONSTRAINT upload_requests_pipeline_name_check CHECK (origin <> 'pipeline' OR landing_name IS NOT NULL);

-- what is still with Cloud Run: refreshed whenever someone looks
CREATE INDEX upload_requests_in_flight_idx ON upload_requests (landed_at)
    WHERE origin = 'pipeline' AND status = 'approved';

-- Where DataDesk last published the table's contract for Cloud Run:
-- {"uri": "gs://…/contracts/ds.table.yaml", "version": 3, "published_at": "…"}; NULL when not published.
ALTER TABLE upload_targets ADD COLUMN contract_published jsonb;
