-- Anyone can ask for a table to be onboarded; an admin approves it. Until then the table is
-- not offered in "Load to table". Admins' own onboardings are approved straight away.
-- created_by is who asked; reviewed_by is the admin who decided.

ALTER TABLE upload_targets
    ADD COLUMN onboarding_status text NOT NULL DEFAULT 'approved'
        CHECK (onboarding_status IN ('pending', 'approved', 'rejected')),
    -- why the requester needs this table
    ADD COLUMN request_reason text CHECK (length(request_reason) <= 2000),
    ADD COLUMN reviewed_by uuid REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN reviewed_at timestamptz,
    ADD COLUMN review_note text CHECK (length(review_note) <= 2000);

-- everything onboarded so far was onboarded by an admin, directly
UPDATE upload_targets SET reviewed_by = created_by, reviewed_at = created_at;

-- A pending request holds its table, so two people can't propose the same one; a rejected
-- request doesn't, so the table can be asked for again.
DROP INDEX upload_targets_table_key;
CREATE UNIQUE INDEX upload_targets_table_key
    ON upload_targets (target_type, database_name, coalesce(schema_name, ''), table_name)
    WHERE onboarding_status <> 'rejected';

-- the admin review queue
CREATE INDEX upload_targets_pending_idx ON upload_targets (created_at) WHERE onboarding_status = 'pending';
