"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, errorText } from "@/lib/api";
import { humanSize, timeAgo } from "@/lib/format";
import type { FileUploadConfig, FileUploadTarget, Folder, UploadRequest, ValidationReport, WsFile } from "@/lib/types";
import { ContractSummary } from "./ContractSummary";
import { uploadWithProgress } from "./FileBrowser";
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
  InfoIcon,
  SearchIcon,
  SpinnerIcon,
  UploadIcon,
} from "./icons";
import { LoadFlow, stagesFor } from "./LoadFlow";
import { ValidationReportView, WarningsView } from "./ValidationReport";
import { RequestCard } from "./RequestList";
import { Alert, EmptyState, btn, inputClass } from "./ui";

const selectClass = `${inputClass} font-normal`;
const IN_FLIGHT_POLL_MS = 10_000;

// ------------------------------------------------------------------ naming, as the server does it
const DATE_IN_NAME = /(?<!\d)(\d{4})[-_]?(\d{2})[-_]?(\d{2})(?!\d)/g;

/** A date written into a file name (sales_20261015.csv, report-2026-10-15.xlsx), as YYYY-MM-DD. */
export function dateInName(name: string): string | null {
  for (const m of name.matchAll(DATE_IN_NAME)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return null;
}

const today = () => new Date().toISOString().slice(0, 10);

export function landingName(prefix: string, format: string, isoDate: string): string {
  return `${prefix}_${isoDate.replaceAll("-", "")}.${format === "xlsx" ? "xlsx" : "csv"}`;
}

// ------------------------------------------------------------------ the page
export function FileUploadPage({ isAdmin = false }: { isAdmin?: boolean }) {
  const [config, setConfig] = useState<FileUploadConfig | null>(null);
  const [error, setError] = useState("");
  const [listKey, setListKey] = useState(0);

  useEffect(() => {
    api<FileUploadConfig>("/file-uploads/config")
      .then(setConfig)
      .catch((e) => setError(errorText(e)));
  }, []);

  if (error) return <Alert>{error}</Alert>;
  if (!config)
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <SpinnerIcon /> Loading…
      </p>
    );
  if (!config.enabled)
    return (
      <EmptyState title="File upload is switched off">
        Set <code>FILE_UPLOAD_LANDING_BUCKET</code> and <code>FILE_UPLOAD_CONFIG_BUCKET</code> in <code>.env</code> and restart the
        API to send files through Cloud Run.
      </EmptyState>
    );

  return (
    <>
      <section className="mb-8 rounded-2xl border border-line p-5">
        <h2 className="display text-xl">Send a file</h2>
        <p className="mt-1 text-sm text-muted">
          It is checked here against the table&apos;s contract first, exactly as Cloud Run will check it. After an admin approves,
          it goes to <span className="font-medium text-fg">gs://{config.landing_bucket}</span> and Cloud Run loads it.
        </p>
        <div className="mt-5">
          {config.targets.length === 0 ? (
            <Alert tone="info">
              No table takes files through Cloud Run yet. An admin turns it on per table under{" "}
              <Link href="/onboarding" className="font-medium underline">
                Onboarding
              </Link>{" "}
              → File upload (Cloud Run).
            </Alert>
          ) : (
            <FileUploadForm targets={config.targets} onFiled={() => setListKey((k) => k + 1)} />
          )}
        </div>
      </section>
      <UploadList key={listKey} isAdmin={isAdmin} />
    </>
  );
}

/** A file's "Load to table" tab: the same form and the same Cloud Run process, for this file. */
export function SendFile({ file }: { file: WsFile }) {
  const [config, setConfig] = useState<FileUploadConfig | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<FileUploadConfig>("/file-uploads/config")
      .then(setConfig)
      .catch((e) => setError(errorText(e)));
  }, []);

  if (error) return <Alert>{error}</Alert>;
  if (!config)
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <SpinnerIcon /> Finding the tables you can load into…
      </p>
    );
  if (!config.enabled)
    return <Alert tone="info">Loading files is switched off: FILE_UPLOAD_* isn&apos;t set for this DataDesk.</Alert>;
  if (config.targets.length === 0)
    return (
      <Alert tone="info">
        No table takes files yet. An admin turns it on per table under{" "}
        <Link href="/onboarding" className="font-medium underline">
          Onboarding
        </Link>{" "}
        → File upload (Cloud Run).
      </Alert>
    );
  return (
    <div>
      <p className="mb-4 text-sm text-muted">
        Version {file.current_version} is checked here exactly as Cloud Run will check it. After an admin approves, it goes
        to <span className="font-medium text-fg">gs://{config.landing_bucket}</span> and Cloud Run loads it; the file then
        moves to My files › File uploads › Archive.
      </p>
      <FileUploadForm targets={config.targets} onFiled={() => {}} fixedFile={file} />
    </div>
  );
}

// ------------------------------------------------------------------ the form
type Source = "new" | "existing";

function FileUploadForm({
  targets,
  onFiled,
  fixedFile,
}: {
  targets: FileUploadTarget[];
  onFiled: () => void;
  /** sending one particular file (a file's Load to table tab): no picker */
  fixedFile?: WsFile;
}) {
  const [source, setSource] = useState<Source>("new");
  const [file, setFile] = useState<WsFile | null>(fixedFile ?? null);
  const [myFiles, setMyFiles] = useState<WsFile[] | null>(null);
  // folder id → its path, to group the picker like My files
  const [folders, setFolders] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<number | null>(null);
  const [dataset, setDataset] = useState("");
  const [targetId, setTargetId] = useState("");
  const [fileDate, setFileDate] = useState(today());
  const [justification, setJustification] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [filed, setFiled] = useState<UploadRequest | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  // read afresh every time "From My files" is opened, so moves and new files show up
  useEffect(() => {
    if (source !== "existing" || myFiles) return;
    Promise.all([api<WsFile[]>("/workspace/files"), api<Folder[]>("/workspace/folders")])
      .then(([files, list]) => {
        setFolders(Object.fromEntries(list.map((f) => [f.id, f.path])));
        setMyFiles(files);
      })
      .catch((e) => setError(errorText(e)));
  }, [source, myFiles]);

  // the picker's groups: the top of My files first, then each folder by path
  const groups = useMemo(() => {
    const byFolder = new Map<string, WsFile[]>();
    for (const f of myFiles ?? []) {
      if (!(f.format === "csv" || f.format === "xlsx")) continue;
      const path = f.folder_id ? (folders[f.folder_id] ?? "Other folder") : "";
      byFolder.set(path, [...(byFolder.get(path) ?? []), f]);
    }
    return [...byFolder.entries()]
      .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
      .map(([path, files]) => ({
        label: path ? path.replaceAll("/", " › ") : "My files (top level)",
        files: files.sort((x, y) => x.original_name.localeCompare(y.original_name)),
      }));
  }, [myFiles, folders]);

  const datasets = [...new Set(targets.map((t) => t.dataset))].sort();
  const tables = targets.filter((t) => t.dataset === dataset);
  const target = targets.find((t) => t.target_id === targetId);

  // a date in the file's name becomes the file date; otherwise today
  useEffect(() => {
    if (file) setFileDate(dateInName(file.original_name) ?? today());
  }, [file]);

  const usable = (f: WsFile) => target?.formats.includes(f.format as "csv" | "xlsx") ?? (f.format === "csv" || f.format === "xlsx");
  const name = target && file ? landingName(target.file_prefix, file.format, fileDate) : null;
  const matched = Boolean(name && file && name === file.original_name);
  const wrongFormat = Boolean(target && file && !target.formats.includes(file.format as "csv" | "xlsx"));
  const ready = Boolean(file && target && fileDate && !wrongFormat);

  function reset() {
    setReport(null);
    setError("");
  }

  async function onPick(list: FileList | null) {
    const chosen = list?.[0];
    if (!chosen) return;
    reset();
    setProgress(0);
    try {
      // new uploads go to My files › File uploads, not the top of My files
      const folder = await api<Folder>("/file-uploads/folder", { method: "POST" });
      setFile(await uploadWithProgress(chosen, folder.id, setProgress));
      setMyFiles(null); // the list is stale now
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
      if (picker.current) picker.current.value = "";
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file || !target) return;
    setBusy(true);
    reset();
    try {
      const request = await api<UploadRequest>("/file-uploads", {
        method: "POST",
        json: { file_id: file.id, target_id: target.target_id, file_date: fileDate, justification: justification.trim() || null },
      });
      setFiled(request);
      onFiled();
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as UploadRequest | null) : null;
      if (body?.validation_report) setReport(body.validation_report);
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (filed)
    return (
      <div>
        <h3 className="display text-lg">Sent: waiting for an admin to approve</h3>
        <p className="mt-1 text-sm text-muted">
          {filed.file_name} → <span className="font-medium text-fg">{filed.target_label}</span> as{" "}
          <span className="font-mono text-xs text-fg">{filed.landing_name}</span>
        </p>
        <div className="mt-5 overflow-x-auto">
          <LoadFlow stages={stagesFor(filed)} />
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link href={`/requests/${filed.id}`} className={btn.primary}>
            Follow this upload
          </Link>
          <button
            type="button"
            className={btn.secondary}
            onClick={() => {
              setFiled(null);
              setFile(fixedFile ?? null);
              setJustification("");
            }}
          >
            {fixedFile ? "Send it to another table" : "Send another file"}
          </button>
        </div>
      </div>
    );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]">
      <form onSubmit={submit} className="flex flex-col gap-5">
        {error && <Alert>{error}</Alert>}

        {/* 1. the file */}
        <fieldset>
          <legend className="mb-2 text-sm font-medium">1. The file</legend>
          {!fixedFile && (
            <>
          <div className="inline-flex rounded-full bg-surface p-1">
            {(
              [
                ["new", "Upload a file"],
                ["existing", "From My files"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setSource(value);
                  setFile(null);
                  if (value === "existing") setMyFiles(null); // read the list again
                  reset();
                }}
                className={`rounded-full px-4 py-1.5 text-sm font-medium ${
                  source === value ? "bg-chip-active text-chip-active-text" : "text-muted hover:text-fg"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {source === "new" ? (
            <div className="mt-3">
              <input
                ref={picker}
                type="file"
                accept=".csv,.xlsx"
                className="sr-only"
                id="file-upload-input"
                onChange={(e) => onPick(e.target.files)}
              />
              <label
                htmlFor="file-upload-input"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  onPick(e.dataTransfer.files);
                }}
                className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line px-4 py-6 text-center text-sm hover:border-brand hover:bg-brand/5"
              >
                {progress !== null ? (
                  <>
                    <SpinnerIcon /> Uploading… {progress}%
                  </>
                ) : (
                  <>
                    <UploadIcon width={22} height={22} className="text-muted" />
                    <span className="font-medium">Drop a CSV or Excel file, or click to choose</span>
                    <span className="text-xs text-muted">
                      It is saved in My files › File uploads, so you can fix it there if a check fails. Once sent, it moves
                      to File uploads › Archive.
                    </span>
                  </>
                )}
              </label>
            </div>
          ) : (
            <div className="mt-3">
              <FilePicker
                groups={groups.map((g) => ({ ...g, files: g.files.filter(usable) })).filter((g) => g.files.length > 0)}
                loading={!myFiles}
                value={file}
                onChange={(f) => {
                  reset();
                  setFile(f);
                }}
              />
              {myFiles && myFiles.filter(usable).length === 0 && (
                <span className="mt-1.5 block text-xs text-muted">No CSV or Excel files in My files yet.</span>
              )}
            </div>
          )}

            </>
          )}

          {file && (
            <p className="mt-2 flex items-center gap-2 text-sm">
              <CheckIcon width={16} height={16} className="text-ok" />
              <Link href={`/files/${file.id}`} className="font-medium text-brand hover:underline">
                {file.original_name}
              </Link>
              <span className="text-muted">
                {file.format.toUpperCase()} · {file.row_count?.toLocaleString() ?? "?"} rows · {humanSize(file.size_bytes)} · v
                {file.current_version}
              </span>
            </p>
          )}
        </fieldset>

        {/* 2. where to */}
        <fieldset>
          <legend className="mb-2 text-sm font-medium">2. Where to</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              BigQuery dataset
              <select
                className={selectClass}
                value={dataset}
                onChange={(e) => {
                  setDataset(e.target.value);
                  setTargetId("");
                  reset();
                }}
              >
                <option value="">Choose…</option>
                {datasets.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Table
              <select
                className={selectClass}
                value={targetId}
                disabled={!dataset}
                onChange={(e) => {
                  setTargetId(e.target.value);
                  reset();
                }}
              >
                <option value="">Choose…</option>
                {tables.map((t) => (
                  <option key={t.target_id} value={t.target_id}>
                    {t.label} ({t.table})
                  </option>
                ))}
              </select>
            </label>
          </div>
          {target?.description && <p className="mt-2 text-sm text-muted">{target.description}</p>}
          {target && (
            <p className="mt-2 text-sm">
              <span className="rounded-full bg-surface px-2.5 py-1 text-xs font-medium">
                {target.load_mode === "overwrite" ? "Overwrite" : "Append"}
              </span>{" "}
              <span className="text-muted">
                {target.load_mode === "overwrite"
                  ? "Set by the contract: the file replaces every row in the table."
                  : "Set by the contract: the rows are added to the table."}
              </span>
            </p>
          )}
        </fieldset>

        {/* 3. the name Cloud Run expects */}
        {target && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">3. File name</legend>
            <div className="rounded-xl border border-line p-4 text-sm">
              <p>
                Cloud Run expects <span className="font-mono text-xs font-semibold">{target.expected_name}</span>
                <span className="block text-xs text-muted">The date is the file&apos;s business date, in the name as YYYYMMDD.</span>
              </p>
              {file && (
                <>
                  {wrongFormat ? (
                    <p className="mt-3 flex items-start gap-2 text-bad">
                      <CloseIcon width={16} height={16} className="mt-0.5 shrink-0" />
                      This table takes {target.formats.map((f) => f.toUpperCase()).join(" or ")} files; {file.original_name} is{" "}
                      {file.format.toUpperCase()}.
                    </p>
                  ) : matched ? (
                    <p className="mt-3 flex items-start gap-2 text-ok">
                      <CheckIcon width={16} height={16} className="mt-0.5 shrink-0" />
                      {file.original_name} already has the right name.
                    </p>
                  ) : (
                    <p className="mt-3 flex items-start gap-2">
                      <InfoIcon width={16} height={16} className="mt-0.5 shrink-0 text-warn" />
                      <span>
                        <span className="font-medium">{file.original_name}</span> doesn&apos;t match, so it lands as{" "}
                        <span className="font-mono text-xs font-semibold">{name}</span>. Your copy keeps its name.
                      </span>
                    </p>
                  )}
                  <label className="mt-3 flex max-w-xs flex-col gap-1.5 font-medium">
                    File date
                    <input
                      type="date"
                      className={`${inputClass} font-normal`}
                      value={fileDate}
                      onChange={(e) => setFileDate(e.target.value)}
                      required
                    />
                    <span className="text-xs font-normal text-muted">
                      {dateInName(file.original_name) ? "Taken from the file name. Change it if that's wrong." : "Defaults to today."}
                    </span>
                  </label>
                </>
              )}
            </div>
          </fieldset>
        )}

        {target && (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Why is this data being loaded?
            <textarea
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              placeholder="Daily customer refresh from the CRM export"
              className={`${inputClass} h-20 py-2 font-normal`}
            />
            <span className="text-xs font-normal text-muted">The approving admin sees this.</span>
          </label>
        )}

        <div>
          <button type="submit" className={btn.primary} disabled={!ready || busy}>
            {busy ? (
              <>
                <SpinnerIcon /> Checking the file…
              </>
            ) : (
              "Check & request approval"
            )}
          </button>
        </div>
      </form>

      <aside className="flex h-fit flex-col gap-4">
        {target && (
          <ContractSummary contract={target.contract} columns={target.columns} version={target.contract_version} ordered />
        )}
        <div className="rounded-xl border border-line bg-surface p-4 text-sm">
          <h3 className="font-semibold">What happens</h3>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-muted">
            <li>DataDesk checks the name, the columns (all of them, in contract order) and every contract rule.</li>
            <li>If it passes, an admin gets a request. Nothing is sent yet.</li>
            <li>On approval it is checked again and put in the landing bucket under the expected name.</li>
            <li>Cloud Run picks it up, checks it again and loads it. Follow every step on the request.</li>
          </ol>
        </div>
      </aside>

      {report && !busy && (
        <div className="flex flex-col gap-3 lg:col-span-2">
          {!report.passed && (
            <ValidationReportView
              report={report}
              hint={file ? "Fix them in My files (Edit tab), save, and check again." : ""}
            />
          )}
          {report.warnings && report.warnings.length > 0 && <WarningsView warnings={report.warnings} />}
          {file && !report.passed && (
            <p className="text-sm">
              <Link href={`/files/${file.id}`} className="font-medium text-brand hover:underline">
                Open {file.original_name} in My files
              </Link>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the file picker
type FileGroup = { label: string; files: WsFile[] };

/** Choose a file from My files: grouped by folder (clear headings, unlike a native select's
 * grey ones), with a search box for long lists. */
function FilePicker({
  groups,
  loading,
  value,
  onChange,
}: {
  groups: FileGroup[];
  loading: boolean;
  value: WsFile | null;
  onChange: (f: WsFile) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);

  // close on a click outside, or Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown = groups
    .map((g) => ({ ...g, files: g.files.filter((f) => !q || f.original_name.toLowerCase().includes(q)) }))
    .filter((g) => g.files.length > 0);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        disabled={loading}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`${inputClass} flex items-center justify-between gap-2 text-left text-sm disabled:opacity-60`}
      >
        <span className={`truncate ${value ? "" : "text-muted"}`}>
          {loading ? "Loading your files…" : value ? value.original_name : "Choose a file…"}
        </span>
        <ChevronDownIcon width={16} height={16} className="shrink-0 text-muted" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-line bg-bg shadow-xl">
          <div className="flex items-center gap-2 border-b border-line px-3">
            <SearchIcon width={15} height={15} className="text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your files"
              aria-label="Search your files"
              className="h-10 w-full bg-transparent text-sm outline-none"
            />
          </div>
          <div role="listbox" aria-label="Your files" className="max-h-80 overflow-auto py-1">
            {shown.length === 0 && <p className="px-3 py-3 text-sm text-muted">No files match.</p>}
            {shown.map((g) => (
              <div key={g.label} role="group" aria-label={g.label}>
                <p className="sticky top-0 flex items-center gap-2 bg-surface px-3 py-1.5 text-xs font-semibold text-fg">
                  <FolderIcon width={14} height={14} className="text-brand" />
                  {g.label}
                </p>
                {g.files.map((f) => {
                  const selected = value?.id === f.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        onChange(f);
                        setOpen(false);
                        setQuery("");
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2 pl-8 text-left text-sm hover:bg-surface ${
                        selected ? "bg-brand/10 font-medium text-brand" : ""
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{f.original_name}</span>
                      <span className="shrink-0 text-xs text-muted">
                        v{f.current_version} · {f.row_count?.toLocaleString() ?? "?"} rows
                      </span>
                      {selected && <CheckIcon width={14} height={14} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the list
function UploadList({ isAdmin }: { isAdmin: boolean }) {
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [rows, setRows] = useState<UploadRequest[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api<UploadRequest[]>(`/file-uploads?scope=${scope}`)
      .then((r) => {
        setRows(r);
        setError("");
        setCheckedAt(new Date().toISOString());
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [scope]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  // keep the ones still with Cloud Run moving without a reload
  const inFlight = useMemo(() => (rows ?? []).some((r) => r.status === "approved"), [rows]);
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(load, IN_FLIGHT_POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, load]);

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line">
        <div role="tablist" className="flex gap-1">
          {(
            [
              ["mine", "My uploads"],
              ["all", "Everyone"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={scope === key}
              onClick={() => setScope(key)}
              className={`-mb-px border-b-2 px-3 py-2.5 text-sm font-medium ${
                scope === key ? "border-brand text-brand" : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mb-2 flex items-center gap-3 text-xs text-muted">
          {checkedAt && <span>Updated {timeAgo(checkedAt)}{inFlight ? " · refreshing while Cloud Run works" : ""}</span>}
          <button type="button" className={btn.secondary} onClick={load} disabled={loading}>
            {loading ? <SpinnerIcon /> : null} Refresh
          </button>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      {!rows && !error ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <SpinnerIcon /> Loading uploads…
        </p>
      ) : rows && rows.length === 0 ? (
        <EmptyState title={scope === "mine" ? "No file uploads yet" : "Nobody has sent a file yet"}>
          {scope === "mine" && "Send one above."}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {(rows ?? []).map((r) => (
            <RequestCard
              key={r.id}
              request={r}
              onDeleted={isAdmin ? () => setRows((all) => all?.filter((x) => x.id !== r.id) ?? null) : undefined}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
