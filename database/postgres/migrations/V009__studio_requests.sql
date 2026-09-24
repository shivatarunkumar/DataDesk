-- Data Studio: people query an onboarded table, edit a few rows in place and submit them.
-- The edited rows are saved as a workspace file and go through the same checks and approval
-- as an uploaded file; these columns say a request came from the Studio and what it changes.

ALTER TABLE upload_requests
    ADD COLUMN origin text NOT NULL DEFAULT 'file' CHECK (origin IN ('file', 'studio')),
    -- {"edited": 3, "added": 1, "query": "SELECT ..."} for Studio requests
    ADD COLUMN change_summary jsonb;
