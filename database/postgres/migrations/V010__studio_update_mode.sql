-- Data Studio edits change rows in place: each edited row is found by the values it had
-- when it was queried and updated (write_mode 'update'), rather than upserted on a key.

ALTER TABLE upload_requests DROP CONSTRAINT upload_requests_write_mode_check;
ALTER TABLE upload_requests ADD CONSTRAINT upload_requests_write_mode_check
    CHECK (write_mode IN ('append', 'upsert', 'update'));

-- only upserts need a key
ALTER TABLE upload_requests DROP CONSTRAINT upload_requests_check;
ALTER TABLE upload_requests ADD CONSTRAINT upload_requests_upsert_key_check
    CHECK (write_mode <> 'upsert' OR jsonb_array_length(coalesce(key_columns, '[]'::jsonb)) > 0);
