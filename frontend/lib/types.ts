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
};

export type Contract = { columns: ColumnRule[]; max_rows?: number | null };

export type TableColumn = { name: string; type: string; nullable: boolean };

export type TargetType = "postgres" | "bigquery" | "oracle";

export type Target = {
  target_type: TargetType;
  database: string | null;
  schema_name: string | null;
  table: string;
  label: string;
  enabled: boolean;
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
  target_type: TargetType;
  database_name: string;
  schema_name: string | null;
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
};

export type AccessCheck = { name: string; ok: boolean; detail: string; hint: string; warning?: boolean };
export type AccessReport = { ok: boolean; checks: AccessCheck[] };

export type SourceTable = { schema_name: string | null; table: string; kind: string; onboarded_id: string | null };

export type ValidationError = { row: number | null; column: string | null; rule: string; message: string };

export type ValidationReport = {
  passed: boolean;
  contract_version?: number | null;
  contract_rules?: number;
  /** how the file was read, for the Validation stage */
  file?: { format: string; delimiter: string | null; version: number };
  errors: ValidationError[];
  summary: string;
  stats?: { file_rows: number; file_columns: number; unknown_columns: string[] };
};

export type UploadRequest = {
  id: string | null;
  file_id: string;
  file_name: string | null;
  file_version: number | null;
  target_type: string;
  target_database: string | null;
  target_schema: string | null;
  target_table: string;
  write_mode: "append" | "upsert" | "update";
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
  /** "studio" when the rows were edited in Data Studio rather than in a file */
  origin?: "file" | "studio";
  change_summary?: StudioChangeSummary | null;
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
