-- The account type a person asks for when they register. It grants nothing on its own:
-- role stays 'user' until an admin approves the account, and the admin decides the role then.

ALTER TABLE users ADD COLUMN requested_role text NOT NULL DEFAULT 'user'
    CHECK (requested_role IN ('user', 'admin'));
