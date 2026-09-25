-- Admin rights for a while or for good.
-- users.admin_until: when a delegated admin goes back to being a user; NULL means
-- permanent (or not an admin at all). It is only meaningful while role = 'admin'.
-- admin_access_requests: a user asking to be an admin for a set time; an admin decides.

ALTER TABLE users ADD COLUMN admin_until timestamptz;
ALTER TABLE users ADD CONSTRAINT users_admin_until_check CHECK (role = 'admin' OR admin_until IS NULL);

CREATE TABLE admin_access_requests (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- how long they asked for; at most 90 days
    duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 129600),
    reason           text CHECK (length(reason) <= 1000),
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    reviewed_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    reviewed_at      timestamptz,
    review_note      text CHECK (length(review_note) <= 2000),
    -- what was granted: the end of the admin window, NULL when granted permanently
    granted_until    timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- one open request per person
CREATE UNIQUE INDEX admin_access_requests_one_pending ON admin_access_requests (user_id) WHERE status = 'pending';
CREATE INDEX admin_access_requests_status_idx ON admin_access_requests (status, created_at);
