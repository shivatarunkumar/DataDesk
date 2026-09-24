-- Each user's personal workspace: folders, files and every saved version of a file.
-- Only metadata lives here; the bytes are in GCS under
--   {GCS_WORKSPACE_PREFIX}/{user_id}/{folder path}/v{n}_{file name}

CREATE TABLE workspace_folders (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    parent_id  uuid REFERENCES workspace_folders (id) ON DELETE CASCADE,
    name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 255 AND position('/' IN name) = 0),
    -- full path under the user's root, e.g. "finance/2026"; unique per user
    path       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, path)
);

CREATE INDEX workspace_folders_parent_idx ON workspace_folders (parent_id);

CREATE TABLE workspace_files (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- NULL = the root of the workspace; deleting a folder moves nothing, it is blocked
    -- while files remain (see the API), and SET NULL is only a safety net
    folder_id        uuid REFERENCES workspace_folders (id) ON DELETE SET NULL,
    original_name    text NOT NULL CHECK (length(btrim(original_name)) BETWEEN 1 AND 512),
    format           text NOT NULL CHECK (format IN ('csv', 'xlsx', 'json')),
    current_version  integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
    current_gcs_path text NOT NULL,
    row_count        integer,
    -- [{name, inferred_type}] from the latest version
    column_meta      jsonb,
    size_bytes       bigint,
    is_permanent     boolean NOT NULL DEFAULT false,
    status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- "my files, newest first"
CREATE INDEX workspace_files_user_idx ON workspace_files (user_id, updated_at DESC) WHERE status = 'active';
CREATE INDEX workspace_files_folder_idx ON workspace_files (folder_id);

CREATE TRIGGER workspace_files_set_updated_at BEFORE UPDATE ON workspace_files
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every save is a new version; old versions stay readable, so a load request can point
-- at exactly the bytes that were validated.
CREATE TABLE workspace_file_versions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id    uuid NOT NULL REFERENCES workspace_files (id) ON DELETE CASCADE,
    version    integer NOT NULL CHECK (version >= 1),
    gcs_path   text NOT NULL,
    row_count  integer,
    size_bytes bigint,
    note       text,
    created_by uuid REFERENCES users (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (file_id, version)
);
