Local-only seed files (run when `APP_ENV=local`), after `seeds/common/`.

Every file here must be idempotent (`INSERT ... ON CONFLICT ...`), because `make db-init`
runs them on every call. A good use is registering the upload targets that exist on your
own Postgres, for example:

```sql
-- 010_local_targets.sql
INSERT INTO pg_databases (name, description) VALUES ('retaildb', 'Local retail data')
ON CONFLICT (name) DO NOTHING;

INSERT INTO pg_tables_catalog (database_id, table_name)
SELECT id, 'customers' FROM pg_databases WHERE name = 'retaildb'
ON CONFLICT (database_id, table_name) DO NOTHING;
```

Seed files are not the place for users: create the first admin with
`make admin EMAIL=you@company.com`, which prompts for the password.
