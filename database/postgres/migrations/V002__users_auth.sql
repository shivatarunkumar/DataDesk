-- Users and admin-resolved password resets.
-- Registration is gated: a new account is pending_approval until an admin approves it.

CREATE TABLE users (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- stored lowercase so the unique index and lookups agree; @ + domain required
    email               text NOT NULL CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    -- sign-in name, lowercase; derived from the email when the person doesn't pick one
    username            text NOT NULL CHECK (username ~ '^[a-z0-9][a-z0-9_.-]{1,49}$'),
    first_name          text CHECK (length(first_name) <= 100),
    last_name           text CHECK (length(last_name) <= 100),
    -- argon2id hash; never a plaintext password
    password_hash       text NOT NULL,
    password_changed_at timestamptz NOT NULL DEFAULT now(),
    role                text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    status              text NOT NULL DEFAULT 'pending_approval'
                        CHECK (status IN ('pending_approval', 'active', 'rejected', 'suspended', 'deactivated')),
    -- who let them in, and when
    reviewed_by         uuid REFERENCES users (id) ON DELETE SET NULL,
    reviewed_at         timestamptz,
    last_login_at       timestamptz,
    -- brute-force protection for the login endpoint
    failed_login_count  integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
    locked_until        timestamptz,
    -- soft delete: keeps their files and requests attributable
    deleted_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE UNIQUE INDEX users_username_key ON users (username);
-- the admin approval queue
CREATE INDEX users_status_idx ON users (status, created_at) WHERE deleted_at IS NULL;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- There is no mail server: "forgot password" files a request, and an admin sets a
-- temporary password from the Admin page.
CREATE TABLE password_reset_requests (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'cancelled')),
    resolved_by uuid REFERENCES users (id) ON DELETE SET NULL,
    resolved_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- at most one open request per person, however often they press the button
CREATE UNIQUE INDEX password_reset_requests_one_pending_idx
    ON password_reset_requests (user_id) WHERE status = 'pending';
