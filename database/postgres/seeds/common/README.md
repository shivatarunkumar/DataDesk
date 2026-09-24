Seed data for every environment, run before seeds/$APP_ENV. Files must be idempotent
(`INSERT ... ON CONFLICT ...`). DataDesk needs none today: users come from registration
and `make admin`, upload targets from `seeds/local/` or your own SQL.
