-- DataDesk loads into BigQuery only. Postgres and Oracle targets go:
--   * onboarded Postgres/Oracle tables (and any requests for them) are removed;
--   * the per-person Postgres grants (pg_databases, pg_tables_catalog, db_access_*) are dropped;
--   * target_type can only be 'bigquery' (it defaults to it), and the Postgres schema columns go.
-- DataDesk's own metadata database is still PostgreSQL; only load targets change.

DELETE FROM upload_requests WHERE target_type <> 'bigquery';
DELETE FROM upload_targets WHERE target_type <> 'bigquery';

DROP TABLE IF EXISTS db_access_grants;
DROP TABLE IF EXISTS db_access_requests;
DROP TABLE IF EXISTS pg_tables_catalog;
DROP TABLE IF EXISTS pg_databases;

-- upload_targets: one onboarding per dataset.table
DROP INDEX IF EXISTS upload_targets_table_key;
ALTER TABLE upload_targets DROP COLUMN schema_name;
CREATE UNIQUE INDEX upload_targets_table_key ON upload_targets (database_name, table_name)
    WHERE onboarding_status <> 'rejected';
ALTER TABLE upload_targets DROP CONSTRAINT upload_targets_target_type_check;
ALTER TABLE upload_targets ALTER COLUMN target_type SET DEFAULT 'bigquery';
ALTER TABLE upload_targets ADD CONSTRAINT upload_targets_target_type_check CHECK (target_type = 'bigquery');

-- upload_requests
ALTER TABLE upload_requests DROP COLUMN target_schema;
ALTER TABLE upload_requests DROP CONSTRAINT upload_requests_target_type_check;
ALTER TABLE upload_requests ALTER COLUMN target_type SET DEFAULT 'bigquery';
ALTER TABLE upload_requests ADD CONSTRAINT upload_requests_target_type_check CHECK (target_type = 'bigquery');
