export type SessionUser = {
  id: string;
  email: string;
  username: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string;
  role: "user" | "admin";
  requested_role: "user" | "admin";
  /** when a delegated admin goes back to being a user; null when permanent */
  admin_until: string | null;
  status: string;
  last_login_at: string | null;
  created_at: string;
};

export type Folder = {
  id: string;
  parent_id: string | null;
  name: string;
  path: string;
  created_at: string;
};

export type WsFile = {
  id: string;
  folder_id: string | null;
  original_name: string;
  format: "csv" | "xlsx" | "json";
  current_version: number;
  row_count: number | null;
  column_meta: { name: string; inferred_type: string | null }[] | null;
  size_bytes: number | null;
  is_permanent: boolean;
  status: string;
  created_at: string;
  updated_at: string;
};

export type FileVersion = {
  version: number;
  row_count: number | null;
  size_bytes: number | null;
  note: string | null;
  created_at: string;
};

export type FileContent = {
  columns: string[];
  rows: Record<string, string | null>[];
  version: number;
  inferred_types: Record<string, string> | null;
  delimiter: string | null;
};

export type ColumnRule = {
  name: string;
  description?: string | null;
  required?: boolean;
  unique?: boolean;
  regex?: string | null;
  enum?: string[] | null;
  min?: number | null;
  max?: number | null;
  min_length?: number | null;
  max_length?: number | null;
  /** strptime format for dates and timestamps that aren't ISO 8601, e.g. %d/%m/%Y */
  format?: string | null;
  /** "warning": failures are shown but don't stop the file */
  severity?: "error" | "warning";
};

/** How files reach a BigQuery table through the Cloud Run file processor (File upload). */
export type FileUploadSettings = {
  enabled: boolean;
  /** files land as {file_prefix}_{YYYYMMDD}.{csv|xlsx}; empty → the table name */
  file_prefix: string | null;
  load_mode: "append" | "overwrite";
  formats: ("csv" | "xlsx")[];
};

export type Contract = {
  columns: ColumnRule[];
  min_rows?: number | null;
  max_rows?: number | null;
  file_upload?: FileUploadSettings | null;
};

/** Where DataDesk last published a table's contract for Cloud Run. */
export type ContractPublished = { uri: string; version: number; published_at: string; replaced?: string[] };

/** A contract Cloud Run already had for a table, turned into DataDesk's form. */
export type CloudRunContract = { source: string; contract: Contract; notes: string[] };

export type TableColumn = { name: string; type: string; nullable: boolean };

/** A BigQuery table someone may load into. */
export type Target = {
  /** the BigQuery dataset */
  database: string | null;
  table: string;
  label: string;
  /** set for onboarded targets */
  target_id: string | null;
  description: string | null;
  write_modes: ("append" | "upsert")[];
  key_columns: string[];
  contract: Contract | null;
  contract_version: number | null;
  columns: TableColumn[] | null;
};

/** A table an admin onboarded, with its data contract. */
export type OnboardedTarget = {
  id: string;
  /** the BigQuery dataset */
  database_name: string;
  table_name: string;
  location: string;
  display_name: string;
  description: string | null;
  write_modes: ("append" | "upsert")[];
  key_columns: string[];
  contract: Contract;
  contract_version: number;
  schema_snapshot: TableColumn[] | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  request_count: number;
  /** pending until an admin approves someone's request */
  onboarding_status: "pending" | "approved" | "rejected";
  request_reason: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  requested_by_name: string | null;
  reviewed_by_name: string | null;
  is_mine: boolean;
  can_edit: boolean;
  contract_published: ContractPublished | null;
};

export type AccessCheck = { name: string; ok: boolean; detail: string; hint: string; warning?: boolean };
export type AccessReport = { ok: boolean; checks: AccessCheck[] };

export type SourceTable = { table: string; kind: string; onboarded_id: string | null };

export type ValidationError = { row: number | null; column: string | null; rule: string; message: string };

export type ValidationReport = {
  passed: boolean;
  contract_version?: number | null;
  contract_rules?: number;
  /** how the file was read, for the Validation stage */
  file?: { format: string; delimiter: string | null; version: number };
  errors: ValidationError[];
  /** contract rules with severity "warning": shown, never blocking */
  warnings?: ValidationError[];
  summary: string;
  stats?: { file_rows: number; file_columns: number; unknown_columns: string[] };
  /** File upload: the name it lands under, and whether the file already had it */
  pipeline?: {
    landing_name: string;
    file_date: string;
    name_matched: boolean;
    original_name: string;
    expected_name: string;
    load_mode: "append" | "overwrite";
  };
};

export type UploadRequest = {
  id: string | null;
  file_id: string;
  file_name: string | null;
  file_version: number | null;
  /** the BigQuery dataset */
  target_database: string | null;
  target_table: string;
  write_mode: "append" | "upsert" | "update" | "overwrite";
  key_columns: string[] | null;
  justification: string | null;
  validation_status: string | null;
  validation_report: ValidationReport | null;
  status: "pending" | "approved" | "rejected" | "completed" | "failed";
  result: Record<string, unknown> | null;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string | null;
  target_id: string | null;
  target_label: string | null;
  contract_version: number | null;
  executed_at: string | null;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  reviewed_by_id: string | null;
  reviewed_by_name: string | null;
  /** the viewer asked for it: they may open the file and see every validation error */
  is_mine: boolean;
  /** "studio": rows edited in Data Studio · "pipeline": sent through Cloud Run (File upload) */
  origin?: "file" | "studio" | "pipeline";
  change_summary?: StudioChangeSummary | null;
  /** pipeline: the name it lands under, where it landed, and what Cloud Run did with it */
  file_date?: string | null;
  landing_name?: string | null;
  landing_uri?: string | null;
  landed_at?: string | null;
  pipeline?: PipelineSnapshot | null;
  pipeline_checked_at?: string | null;
};

/** One Cloud Run attempt: a row of file_audit.job_metadata. */
export type PipelineJob = {
  job_id: string;
  status: "IN_PROGRESS" | "SUCCESS" | "REJECTED" | "FAILED" | "DUPLICATE_SKIPPED";
  status_reason: string | null;
  attempt_number: number | null;
  delivery_attempt: number | null;
  start_time: string | null;
  end_time: string | null;
  duration_seconds: number | null;
  final_file_path: string | null;
  contract_name: string | null;
  contract_version: string | null;
  target_table: string | null;
  load_mode: string | null;
  bq_load_job_id: string | null;
  rows_in_file: number | null;
  rows_loaded: number | null;
  rows_failed_validation: number | null;
  validation_status: string | null;
  validation_rules_executed: number | null;
  validation_rules_failed: number | null;
  recon_status: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string | null;
};

/** One failing rule inside a Cloud Run check. Samples are hidden from everyone but the requester and admins. */
export type PipelineFailure = {
  column: string | null;
  check: string;
  severity: "ERROR" | "WARNING" | null;
  failed: number | null;
  evaluated: number | null;
  expected: string | null;
  actual: string | null;
  error: string | null;
  samples: { row_number: number; value: unknown }[];
};

/** One row of file_audit.validation_metadata. */
export type PipelineCheck = {
  job_id: string;
  check_name: string;
  check_type: string;
  stage: "PRE_LOAD" | "POST_LOAD";
  result: "PASS" | "WARN" | "FAIL";
  severity: string | null;
  summary: string;
  records_evaluated: number | null;
  records_failed: number | null;
  records_warned: number | null;
  checks_evaluated: number | null;
  checks_failed: number | null;
  failed_checks: string[];
  failures: PipelineFailure[];
  validated_at: string | null;
};

export type PipelineState = "waiting" | "not_picked_up" | "processing" | "retrying" | "succeeded" | "rejected" | "failed";

export type PipelineSnapshot = {
  state: PipelineState;
  message: string;
  jobs: PipelineJob[];
  checks: PipelineCheck[];
  /** set when file_audit couldn't be read on the last refresh */
  read_error?: string;
};

/** A BigQuery table that takes files through Cloud Run, as the File upload form shows it. */
export type FileUploadTarget = {
  target_id: string;
  dataset: string;
  table: string;
  label: string;
  description: string | null;
  file_prefix: string;
  /** "customer_YYYYMMDD.csv or .xlsx" */
  expected_name: string;
  load_mode: "append" | "overwrite";
  formats: ("csv" | "xlsx")[];
  contract: Contract;
  contract_version: number;
  /** the columns a file must have, in order */
  columns: TableColumn[];
  published: ContractPublished | null;
};

export type FileUploadConfig = {
  enabled: boolean;
  landing_bucket: string | null;
  config_bucket: string | null;
  pickup_minutes: number;
  targets: FileUploadTarget[];
};

export type StudioChangeSummary = {
  edited: number;
  added: number;
  cells: number;
  columns: string[];
  query: string | null;
  /** rows the edits change (more than edited when identical rows share the values) */
  matched?: number;
  /** each edited row: what it is called, how many table rows it matched, every changed cell as [before, after] */
  changes?: {
    label?: Record<string, string | null>;
    key?: Record<string, string>;
    rows?: number;
    cells: Record<string, [string | null, string | null]>;
  }[];
  added_rows?: Record<string, string | null>[];
};

export type StudioColumn = { name: string; type: string | null; key: boolean };

/** A query's result in Data Studio, and whether (and how) it can be edited. */
export type StudioResult = {
  columns: StudioColumn[];
  rows: (string | null)[][];
  row_limit: number;
  truncated: boolean;
  elapsed_ms: number;
  bytes_processed: number | null;
  tables: string[];
  /** "edit": change any cell and add rows · "append": add rows only · null: read-only */
  edit_mode: "edit" | "append" | null;
  edit_reason: string | null;
  target_id: string | null;
  target_label: string | null;
  key_columns: string[];
  max_changes: number;
};

export type PendingCounts = {
  loads: number;
  tables: number;
  accounts: number;
  password_resets: number;
  admin_access: number;
  total: number;
};

export type PasswordReset = {
  id: string;
  user_id: string;
  user_email: string;
  user_name: string;
  status: string;
  created_at: string;
};

export type AdminRequest = {
  id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  duration_minutes: number;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  granted_until: string | null;
  created_at: string;
};
