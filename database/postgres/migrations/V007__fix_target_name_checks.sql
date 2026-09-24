-- V006's name checks used {0,1023}, but Postgres caps a regex repetition count at 255,
-- so every insert into upload_targets failed with "invalid repetition count(s)".
-- Same rule, written as a pattern plus a separate length limit.

ALTER TABLE upload_targets
    DROP CONSTRAINT upload_targets_database_name_check,
    DROP CONSTRAINT upload_targets_table_name_check,
    ADD CONSTRAINT upload_targets_database_name_check
        CHECK (database_name ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND length(database_name) <= 1024),
    ADD CONSTRAINT upload_targets_table_name_check
        CHECK (table_name ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND length(table_name) <= 1024);
