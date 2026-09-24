-- ──────────────────────────────────────────────────────────────────────────────
-- DataDesk metadata schema
--
--   createdb datadesk
--   psql -d datadesk -f database/schema.sql
--
-- Tables:
--   users, password_reset_requests            — auth + admin approval
--   pg_databases, pg_tables_catalog,
--   db_access_requests, db_access_grants      — which Postgres tables a user may upload into
--   bq_access_requests, bq_tables_cache,
--   bq_datasets_cache                         — which BigQuery tables a user may upload into
--   workspace_folders, workspace_files,
--   workspace_file_versions                   — personal files (blobs live in GCS)
--   upload_requests                           — governed file → table loads, admin-reviewed
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE bq_access_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    scope_type character varying(20) NOT NULL,
    dataset_id character varying(255),
    table_id character varying(255),
    justification text,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    duration_hours integer,
    expires_at timestamp with time zone,
    CONSTRAINT bq_access_requests_scope_type_check CHECK (((scope_type)::text = ANY (ARRAY[('dataset'::character varying)::text, ('table'::character varying)::text]))),
    CONSTRAINT bq_access_requests_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text])))
);

CREATE TABLE bq_datasets_cache (
    id text NOT NULL,
    description text,
    location text,
    table_count integer,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE bq_tables_cache (
    dataset_id text NOT NULL,
    id text NOT NULL,
    description text,
    num_rows bigint,
    num_bytes bigint,
    created_bq timestamp with time zone,
    modified_bq timestamp with time zone,
    synced_at timestamp with time zone DEFAULT now()
);

CREATE TABLE db_access_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    scope_type character varying(10) NOT NULL,
    database_id uuid,
    table_id uuid,
    source_request_id uuid,
    granted_by uuid NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    expires_at timestamp with time zone,
    CONSTRAINT db_access_grants_scope_type_check CHECK (((scope_type)::text = ANY (ARRAY[('database'::character varying)::text, ('table'::character varying)::text])))
);

CREATE TABLE db_access_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    scope_type character varying(10) NOT NULL,
    database_id uuid,
    table_id uuid,
    justification text,
    status character varying(10) DEFAULT 'pending'::character varying NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    review_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    duration_hours integer,
    CONSTRAINT db_access_requests_scope_type_check CHECK (((scope_type)::text = ANY (ARRAY[('database'::character varying)::text, ('table'::character varying)::text]))),
    CONSTRAINT db_access_requests_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text])))
);

CREATE TABLE password_reset_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE pg_databases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE pg_tables_catalog (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    database_id uuid NOT NULL,
    table_name character varying(255) NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE upload_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    file_id uuid NOT NULL,
    file_version integer NOT NULL,
    target_type character varying(20) NOT NULL,
    target_database character varying(255),
    target_schema character varying(255),
    target_table character varying(255) NOT NULL,
    write_mode character varying(10) NOT NULL,
    key_columns jsonb,
    justification text,
    validation_status character varying(10),
    validation_report jsonb,
    status character varying(15) DEFAULT 'pending'::character varying NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    review_note text,
    executed_at timestamp with time zone,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT upload_requests_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text]))),
    CONSTRAINT upload_requests_target_type_check CHECK (((target_type)::text = ANY (ARRAY[('postgres'::character varying)::text, ('bigquery'::character varying)::text, ('oracle'::character varying)::text]))),
    CONSTRAINT upload_requests_validation_status_check CHECK (((validation_status)::text = ANY (ARRAY[('passed'::character varying)::text, ('failed'::character varying)::text]))),
    CONSTRAINT upload_requests_write_mode_check CHECK (((write_mode)::text = ANY (ARRAY[('append'::character varying)::text, ('upsert'::character varying)::text])))
);

CREATE TABLE users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    email_verified_at timestamp with time zone,
    password_hash character varying(255) NOT NULL,
    password_algo character varying(20) DEFAULT 'bcrypt'::character varying NOT NULL,
    password_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    role character varying(10) DEFAULT 'user'::character varying NOT NULL,
    status character varying(20) DEFAULT 'pending_approval'::character varying NOT NULL,
    failed_login_attempts smallint DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    first_name character varying(100),
    last_name character varying(100),
    username character varying(100),
    CONSTRAINT users_role_check CHECK (((role)::text = ANY (ARRAY[('admin'::character varying)::text, ('user'::character varying)::text]))),
    CONSTRAINT users_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('pending_approval'::character varying)::text, ('rejected'::character varying)::text, ('suspended'::character varying)::text, ('deactivated'::character varying)::text])))
);

CREATE TABLE workspace_file_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_id uuid NOT NULL,
    version integer NOT NULL,
    gcs_path text NOT NULL,
    row_count integer,
    size_bytes bigint,
    note text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE workspace_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    username character varying(150) NOT NULL,
    original_name character varying(512) NOT NULL,
    format character varying(10) NOT NULL,
    current_version integer DEFAULT 1 NOT NULL,
    current_gcs_path text NOT NULL,
    row_count integer,
    column_meta jsonb,
    size_bytes bigint,
    is_permanent boolean DEFAULT false NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    folder_id uuid,
    CONSTRAINT workspace_files_format_check CHECK (((format)::text = ANY (ARRAY[('csv'::character varying)::text, ('xlsx'::character varying)::text, ('json'::character varying)::text]))),
    CONSTRAINT workspace_files_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])))
);

CREATE TABLE workspace_folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    parent_id uuid,
    name character varying(255) NOT NULL,
    path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY bq_access_requests
    ADD CONSTRAINT bq_access_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY bq_datasets_cache
    ADD CONSTRAINT bq_datasets_cache_pkey PRIMARY KEY (id);

ALTER TABLE ONLY bq_tables_cache
    ADD CONSTRAINT bq_tables_cache_pkey PRIMARY KEY (dataset_id, id);

ALTER TABLE ONLY db_access_grants
    ADD CONSTRAINT db_access_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY db_access_requests
    ADD CONSTRAINT db_access_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY password_reset_requests
    ADD CONSTRAINT password_reset_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY pg_databases
    ADD CONSTRAINT pg_databases_name_key UNIQUE (name);

ALTER TABLE ONLY pg_databases
    ADD CONSTRAINT pg_databases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY pg_tables_catalog
    ADD CONSTRAINT pg_tables_catalog_database_id_table_name_key UNIQUE (database_id, table_name);

ALTER TABLE ONLY pg_tables_catalog
    ADD CONSTRAINT pg_tables_catalog_pkey PRIMARY KEY (id);

ALTER TABLE ONLY upload_requests
    ADD CONSTRAINT upload_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_username_key UNIQUE (username);

ALTER TABLE ONLY workspace_file_versions
    ADD CONSTRAINT workspace_file_versions_file_id_version_key UNIQUE (file_id, version);

ALTER TABLE ONLY workspace_file_versions
    ADD CONSTRAINT workspace_file_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_files
    ADD CONSTRAINT workspace_files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_folders
    ADD CONSTRAINT workspace_folders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_folders
    ADD CONSTRAINT workspace_folders_user_id_path_key UNIQUE (user_id, path);

CREATE INDEX bq_access_requests_status_idx ON bq_access_requests USING btree (status);

CREATE INDEX bq_access_requests_user_idx ON bq_access_requests USING btree (user_id);

CREATE INDEX idx_db_access_grants_user ON db_access_grants USING btree (user_id) WHERE (revoked_at IS NULL);

CREATE INDEX idx_db_access_requests_status ON db_access_requests USING btree (status);

CREATE INDEX idx_db_access_requests_user ON db_access_requests USING btree (user_id, status);

CREATE INDEX idx_pg_tables_catalog_db ON pg_tables_catalog USING btree (database_id);

CREATE INDEX idx_users_email ON users USING btree (email) WHERE (deleted_at IS NULL);

CREATE INDEX idx_users_role ON users USING btree (role);

CREATE INDEX upload_requests_file_idx ON upload_requests USING btree (file_id);

CREATE INDEX upload_requests_status_idx ON upload_requests USING btree (status);

CREATE INDEX upload_requests_user_idx ON upload_requests USING btree (user_id);

CREATE INDEX workspace_file_versions_file_idx ON workspace_file_versions USING btree (file_id);

CREATE INDEX workspace_files_folder_idx ON workspace_files USING btree (folder_id);

CREATE INDEX workspace_files_status_idx ON workspace_files USING btree (status);

CREATE INDEX workspace_files_user_idx ON workspace_files USING btree (user_id);

CREATE INDEX workspace_folders_parent_idx ON workspace_folders USING btree (parent_id);

CREATE INDEX workspace_folders_user_idx ON workspace_folders USING btree (user_id);

ALTER TABLE ONLY db_access_grants
    ADD CONSTRAINT db_access_grants_database_id_fkey FOREIGN KEY (database_id) REFERENCES pg_databases(id);

ALTER TABLE ONLY db_access_grants
    ADD CONSTRAINT db_access_grants_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES users(id);

ALTER TABLE ONLY db_access_grants
    ADD CONSTRAINT db_access_grants_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES users(id);

ALTER TABLE ONLY db_access_grants
    ADD CONSTRAINT db_access_grants_source_request_id_fkey FOREIGN KEY (source_request_id) REFERENCES db_access_requests(id);

ALTER TABLE ONLY db_access_grants
    ADD CONSTRAINT db_access_grants_table_id_fkey FOREIGN KEY (table_id) REFERENCES pg_tables_catalog(id);

ALTER TABLE ONLY db_access_grants
    ADD CONSTRAINT db_access_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY db_access_requests
    ADD CONSTRAINT db_access_requests_database_id_fkey FOREIGN KEY (database_id) REFERENCES pg_databases(id);

ALTER TABLE ONLY db_access_requests
    ADD CONSTRAINT db_access_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id);

ALTER TABLE ONLY db_access_requests
    ADD CONSTRAINT db_access_requests_table_id_fkey FOREIGN KEY (table_id) REFERENCES pg_tables_catalog(id);

ALTER TABLE ONLY db_access_requests
    ADD CONSTRAINT db_access_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY password_reset_requests
    ADD CONSTRAINT password_reset_requests_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES users(id);

ALTER TABLE ONLY password_reset_requests
    ADD CONSTRAINT password_reset_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY pg_tables_catalog
    ADD CONSTRAINT pg_tables_catalog_database_id_fkey FOREIGN KEY (database_id) REFERENCES pg_databases(id) ON DELETE CASCADE;

ALTER TABLE ONLY upload_requests
    ADD CONSTRAINT upload_requests_file_id_fkey FOREIGN KEY (file_id) REFERENCES workspace_files(id) ON DELETE CASCADE;

ALTER TABLE ONLY upload_requests
    ADD CONSTRAINT upload_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id);

ALTER TABLE ONLY upload_requests
    ADD CONSTRAINT upload_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_file_versions
    ADD CONSTRAINT workspace_file_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE ONLY workspace_file_versions
    ADD CONSTRAINT workspace_file_versions_file_id_fkey FOREIGN KEY (file_id) REFERENCES workspace_files(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_files
    ADD CONSTRAINT workspace_files_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES workspace_folders(id) ON DELETE SET NULL;

ALTER TABLE ONLY workspace_files
    ADD CONSTRAINT workspace_files_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_folders
    ADD CONSTRAINT workspace_folders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES workspace_folders(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_folders
    ADD CONSTRAINT workspace_folders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ──────────────────────────────────────────────────────────────────────────────
-- Register upload targets (admins see every active catalog table; users need a
-- grant in db_access_grants). Example:
--
-- INSERT INTO pg_databases (name, description) VALUES ('retaildb', 'Retail data');
-- INSERT INTO pg_tables_catalog (database_id, table_name)
--   SELECT id, 'customers' FROM pg_databases WHERE name = 'retaildb';
-- ──────────────────────────────────────────────────────────────────────────────
