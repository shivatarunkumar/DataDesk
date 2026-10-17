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
  CloseIcon,
  InfoIcon,
  SpinnerIcon,
  UploadIcon,
} from "./icons";
import { LoadFlow, stagesFor } from "./LoadFlow";
import { FilePicker, useMyFiles } from "./MyFilePicker";
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
        <div>
          {config.targets.length === 0 ? (
            <Alert tone="info">
              No tables take files yet. Admins turn this on in{" "}
              <Link href="/onboarding" className="font-medium underline">
                Onboarding
              </Link>
              .
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
    <FileUploadForm targets={config.targets} onFiled={() => {}} fixedFile={file} />
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

  // My files, read afresh every time "From My files" is opened
  const { files: myFiles, groups, reload: reloadMyFiles, error: filesError } = useMyFiles(
    source === "existing",
    (f) => f.format === "csv" || f.format === "xlsx",
  );
  useEffect(() => {
    if (filesError) setError(filesError);
  }, [filesError]);

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
      reloadMyFiles(); // the list is stale now
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

        {/* the file */}
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Upload your file</legend>
          {!fixedFile && (
            <>
          <div className="inline-flex rounded-full bg-surface p-1">
            {(
              [
                ["new", "Upload file"],
                ["existing", "From My files"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setSource(value);
                  setFile(null);
                  if (value === "existing") reloadMyFiles(); // read the list again
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
                    <span className="text-xs text-muted">Saved to My files › File uploads</span>
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

        {/* destination */}
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Destination</legend>
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
                {target.load_mode === "overwrite" ? "replaces all rows" : "adds rows"}
              </span>
            </p>
          )}
        </fieldset>

        {/* the name Cloud Run expects */}
        {target && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">File name</legend>
            <div className="rounded-xl border border-line p-4 text-sm">
              <p>
                Expected name <span className="font-mono text-xs font-semibold">{target.expected_name}</span>
              </p>
              {file && (
                <>
                  {wrongFormat ? (
                    <p className="mt-3 flex items-start gap-2 text-bad">
                      <CloseIcon width={16} height={16} className="mt-0.5 shrink-0" />
                      Needs {target.formats.map((f) => f.toUpperCase()).join(" or ")}, not {file.format.toUpperCase()}
                    </p>
                  ) : matched ? (
                    <p className="mt-3 flex items-start gap-2 text-ok">
                      <CheckIcon width={16} height={16} className="mt-0.5 shrink-0" />
                      Name matches.
                    </p>
                  ) : (
                    <p className="mt-3 flex items-start gap-2">
                      <InfoIcon width={16} height={16} className="mt-0.5 shrink-0 text-warn" />
                      <span>
                        Will be sent as <span className="font-mono text-xs font-semibold">{name}</span>
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
                  </label>
                </>
              )}
            </div>
          </fieldset>
        )}

        {target && (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Reason
            <textarea
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              placeholder="e.g. daily CRM refresh"
              className={`${inputClass} h-16 py-2 font-normal`}
            />
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
          <h3 className="font-semibold">How it works</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
            <li>Checked against the contract</li>
            <li>Approved by an admin</li>
            <li>Loaded by Cloud Run</li>
            <li>Tracked on the request</li>
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
