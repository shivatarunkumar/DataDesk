"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "@/lib/api";
import { dateTime, shortDate, timeAgo } from "@/lib/format";
import { notifyPendingChanged } from "@/lib/pending";
import type { PipelineCheck, PipelineFailure, PipelineJob, UploadRequest } from "@/lib/types";
import { RejectDialog } from "./AdminPanel";
import { DeleteRequestButton } from "./DeleteRequest";
import { ArrowLeftIcon, CheckIcon, SpinnerIcon } from "./icons";
import { LoadFlow, stagesFor } from "./LoadFlow";
import { WarningsView } from "./ValidationReport";
import { Fact } from "./RequestDetail";
import { Alert, StatusPill, btn } from "./ui";

/** While Cloud Run has the file, look again this often. */
const POLL_MS = 5000;

const JOB_TONE: Record<string, string> = {
  SUCCESS: "text-ok",
  REJECTED: "text-bad",
  FAILED: "text-bad",
  IN_PROGRESS: "text-warn",
};

/**
 * A File upload request, start to finish: the checks here, the approval, the landing bucket,
 * and every Cloud Run attempt and check read back from file_audit. Admins decide here too.
 */
export function FileUploadDetail({
  initial,
  isAdmin,
  onChange,
}: {
  initial: UploadRequest;
  isAdmin: boolean;
  onChange: (r: UploadRequest) => void;
}) {
  const router = useRouter();
  const [r, setR] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notYet, setNotYet] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [rejecting, setRejecting] = useState(false);

  const update = useCallback(
    (next: UploadRequest) => {
      setR(next);
      onChange(next);
    },
    [onChange],
  );

  const refresh = useCallback(async () => {
    if (!r.id) return;
    setRefreshing(true);
    try {
      update(await api<UploadRequest>(`/file-uploads/${r.id}/refresh`, { method: "POST" }));
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRefreshing(false);
    }
  }, [r.id, update]);

  // read Cloud Run's progress on arrival, and keep reading while it has the file
  const withCloudRun = r.status === "approved" && Boolean(r.landing_uri);
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    // once on arrival; after that the timer and the button read it
    if (arrived) return;
    setArrived(true);
    if (r.landing_uri) refresh();
  }, [arrived, r.landing_uri, refresh]);
  useEffect(() => {
    if (!withCloudRun) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [withCloudRun, refresh]);

  async function decide(action: "approve" | "reject", note?: string) {
    setBusy(action);
    setError("");
    setNotYet("");
    try {
      update(
        await api<UploadRequest>(`/admin/upload-requests/${r.id}/${action}`, {
          method: "POST",
          json: action === "reject" ? { review_note: note || null } : undefined,
        }),
      );
      notifyPendingChanged();
    } catch (e) {
      // 409: Cloud Run may still have the old contract; approving works in a few minutes
      if ((e as { status?: number }).status === 409) setNotYet(errorText(e));
      else setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const p = r.pipeline;
  const jobs = p?.jobs ?? [];
  const latest = jobs.length ? jobs[jobs.length - 1] : null;
  const failedChecks = (p?.checks ?? []).filter((c) => c.result === "FAIL");
  const warnChecks = (p?.checks ?? []).filter((c) => c.result === "WARN");
  const target = r.target_label ?? `${r.target_database}.${r.target_table}`;
  const location = `${r.target_database}.${r.target_table}`;
  const pill = r.status === "approved" ? (r.landing_uri ? "processing" : "approved") : r.status;
  const preWarnings = r.validation_report?.warnings ?? [];
  // completed, failed or rejected: nothing more will change
  const finished = ["completed", "failed", "rejected"].includes(r.status);
  // the rows this job loaded, in Data Studio (Cloud Run tags every row with _job_id)
  const jobId = String(r.result?.job_id ?? latest?.job_id ?? "");
  const checkData =
    r.status === "completed" && r.target_id && jobId
      ? `/studio?${new URLSearchParams({
          target: r.target_id,
          sql: `SELECT *\nFROM \`${location}\`\nWHERE _job_id = '${jobId}'\nLIMIT 100`,
        })}`
      : null;

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 lg:px-6">
      <div className="flex flex-wrap items-start gap-3 py-4">
        <button type="button" onClick={() => router.back()} className={btn.icon} aria-label="Back">
          <ArrowLeftIcon width={20} height={20} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl">
            {r.file_name ?? "Deleted file"} <span className="text-muted">→</span> {target}
          </h1>
          <p className="mt-1 text-sm text-muted">
            File upload · BigQuery {location} · through Cloud Run as <span className="font-mono text-xs">{r.landing_name}</span>
          </p>
        </div>
        <StatusPill status={pill} />
        {isAdmin && <DeleteRequestButton request={r} onDeleted={() => router.push("/file-upload")} />}
      </div>

      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {notYet && (
        <div className="mb-4">
          <Alert tone="warn">Not yet: {notYet}</Alert>
        </div>
      )}

      <section className="mb-6 rounded-2xl border border-line p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            {finished
              ? `Finished ${timeAgo(r.executed_at ?? r.reviewed_at)}: this is final`
              : r.pipeline_checked_at
                ? `Cloud Run status read ${timeAgo(r.pipeline_checked_at)}`
                : "Not with Cloud Run yet"}
            {withCloudRun && " · refreshing every few seconds"}
          </p>
          {checkData ? (
            <Link href={checkData} className={btn.primary}>
              Check the data
            </Link>
          ) : (
            !finished && (
              <button type="button" className={btn.secondary} onClick={refresh} disabled={refreshing || !r.landing_uri}>
                {refreshing ? <SpinnerIcon /> : null} Refresh status
              </button>
            )
          )}
        </div>
        <div className="overflow-x-auto">
          <LoadFlow stages={stagesFor(r)} />
        </div>
      </section>

      {isAdmin && r.status === "pending" && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-warn/40 bg-warn/10 p-4">
          <p className="min-w-0 flex-1 text-sm">
            Approving checks the file against the current contract once more, then puts it in the landing bucket as{" "}
            <span className="font-mono text-xs">{r.landing_name}</span>. Cloud Run{" "}
            {r.write_mode === "overwrite" ? "replaces every row of" : "adds the rows to"} <span className="font-medium">{location}</span>.
          </p>
          <button type="button" className={btn.primary} disabled={busy !== null} onClick={() => decide("approve")}>
            {busy === "approve" ? (
              <>
                <SpinnerIcon /> Checking and sending…
              </>
            ) : (
              "Approve & send to Cloud Run"
            )}
          </button>
          <button type="button" className={btn.danger} disabled={busy !== null} onClick={() => setRejecting(true)}>
            Reject
          </button>
        </div>
      )}

      <Outcome r={r} failedChecks={failedChecks} showSamples={r.is_mine || isAdmin} />

      <dl className="mt-6 grid overflow-hidden rounded-xl border border-line sm:grid-cols-2">
        <Fact label="File">
          {r.is_mine && r.file_name ? (
            <Link href={`/files/${r.file_id}`} className="font-medium text-brand hover:underline">
              {r.file_name}
            </Link>
          ) : (
            (r.file_name ?? "deleted")
          )}
          {r.file_version && <span className="text-muted"> · version {r.file_version}</span>}
          {r.validation_report?.stats && (
            <span className="block text-xs text-muted">
              {r.validation_report.stats.file_rows.toLocaleString()} rows · {r.validation_report.stats.file_columns} columns
            </span>
          )}
        </Fact>
        <Fact label="Lands as">
          <span className="font-mono text-xs">{r.landing_name}</span>
          {r.file_date && <span className="block text-xs text-muted">file date {shortDate(r.file_date)}</span>}
        </Fact>
        <Fact label="Target">
          <span className="font-medium">{target}</span>
          <span className="block text-xs text-muted">BigQuery · {location}</span>
        </Fact>
        <Fact label="Load mode">
          {r.write_mode === "overwrite" ? "Overwrite: replaces the table" : "Append"}
          <span className="block text-xs text-muted">set by the contract</span>
        </Fact>
        <Fact label="Data contract">
          {r.contract_version ? `Passed v${r.contract_version} here` : "—"}
          {latest?.contract_version && (
            <span className={`block text-xs ${String(latest.contract_version) !== String(r.contract_version) ? "text-warn" : "text-muted"}`}>
              Cloud Run applied v{latest.contract_version}
            </span>
          )}
          {r.target_id && (
            <Link href={`/onboarding/${r.target_id}`} className="text-xs font-medium text-brand hover:underline">
              Open contract
            </Link>
          )}
        </Fact>
        <Fact label="Landing">
          {r.landing_uri ? (
            <>
              <span className="break-all font-mono text-xs">{r.landing_uri}</span>
              <span className="block text-xs text-muted">{dateTime(r.landed_at)}</span>
            </>
          ) : (
            <span className="text-muted">After approval</span>
          )}
        </Fact>
        {latest && (
          <Fact label="Cloud Run job" wide>
            <span className="font-mono text-xs">{latest.job_id}</span>
            {latest.bq_load_job_id && <span className="block text-xs text-muted">BigQuery load job {latest.bq_load_job_id}</span>}
            {latest.final_file_path && (
              <span className="block break-all text-xs text-muted">File now at {latest.final_file_path}</span>
            )}
          </Fact>
        )}
        <Fact label="Why" wide>
          {r.justification ? <span className="italic">“{r.justification}”</span> : <span className="text-muted">Not given</span>}
        </Fact>
        {r.review_note && (
          <Fact label="Admin note" wide>
            {r.review_note}
          </Fact>
        )}
      </dl>

      {jobs.length > 0 && <Attempts jobs={jobs} />}

      {(p?.checks ?? []).length > 0 && <Checks checks={p!.checks} showSamples={r.is_mine || isAdmin} />}

      <section className="mt-6">
        <h2 className="mb-2 font-semibold">Checked in DataDesk before sending</h2>
        <p className="flex items-center gap-2 text-sm text-ok">
          <CheckIcon width={16} height={16} />
          The name, the header (every column, in contract order) and data contract v{r.contract_version} passed.
        </p>
        {preWarnings.length > 0 && (
          <div className="mt-3">
            <WarningsView warnings={preWarnings} />
          </div>
        )}
        {warnChecks.length > 0 && preWarnings.length === 0 && (
          <p className="mt-2 text-sm text-warn">Cloud Run reported warnings: see its checks above.</p>
        )}
      </section>

      {rejecting && (
        <RejectDialog
          request={r}
          onClose={() => setRejecting(false)}
          onReject={(note) => {
            setRejecting(false);
            decide("reject", note);
          }}
        />
      )}
    </div>
  );
}

/** What happened, in a sentence, with the reason when it failed. */
function Outcome({
  r,
  failedChecks,
  showSamples,
}: {
  r: UploadRequest;
  failedChecks: PipelineCheck[];
  showSamples: boolean;
}) {
  const p = r.pipeline;
  if (p?.read_error)
    return <Alert tone="warn">{p.read_error}. The status below is from the last successful read.</Alert>;
  if (r.status === "pending") return <Alert tone="info">Waiting for an admin. Nothing has been sent to Cloud Run yet.</Alert>;
  if (r.status === "rejected")
    return <Alert>Rejected by {r.reviewed_by_name ?? "an admin"}{r.review_note ? `: “${r.review_note}”` : "."}</Alert>;
  if (r.status === "failed" && !r.landing_uri)
    return <Alert>{String(r.result?.error ?? "It failed before reaching Cloud Run.")}</Alert>;
  if (!p) return null;

  if (p.state === "succeeded")
    return (
      <Alert tone="ok">
        {p.message}. {p.jobs.at(-1)?.final_file_path ? "The file was archived by Cloud Run." : ""}
      </Alert>
    );
  if (p.state === "rejected" || p.state === "failed")
    return (
      <div className="overflow-hidden rounded-xl border border-bad/40">
        <div className="bg-bad/10 px-4 py-3">
          <h2 className="font-semibold text-bad">Why it failed</h2>
          <p className="text-sm">{p.message}</p>
          {p.state === "rejected" && (
            <p className="mt-1 text-xs text-muted">
              Nothing was loaded. Fix the file in My files, save it, and send it again from File upload.
            </p>
          )}
        </div>
        {failedChecks.flatMap((c) => c.failures).length > 0 && (
          <FailureTable failures={failedChecks.flatMap((c) => c.failures)} showSamples={showSamples} />
        )}
      </div>
    );
  return <Alert tone={p.state === "not_picked_up" ? "warn" : "info"}>{p.message}</Alert>;
}

function FailureTable({ failures, showSamples }: { failures: PipelineFailure[]; showSamples: boolean }) {
  return (
    <div className="max-h-96 overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-4 py-2 font-semibold">Column</th>
            <th className="px-4 py-2 font-semibold">Check</th>
            <th className="px-4 py-2 font-semibold">Rows</th>
            <th className="px-4 py-2 font-semibold">Expected</th>
            <th className="px-4 py-2 font-semibold">{showSamples ? "Examples (row: value)" : "Detail"}</th>
          </tr>
        </thead>
        <tbody>
          {failures.map((f, i) => (
            <tr key={i} className="border-t border-line align-top">
              <td className="px-4 py-1.5 font-medium">{f.column ?? "file"}</td>
              <td className="whitespace-nowrap px-4 py-1.5">
                {f.check}
                {f.severity === "WARNING" && <span className="ml-1 text-xs text-warn">warning</span>}
              </td>
              <td className="px-4 py-1.5 tabular">{f.failed ?? "—"}</td>
              <td className="break-all px-4 py-1.5 font-mono text-xs">{f.expected ?? "—"}</td>
              <td className="px-4 py-1.5 text-xs">
                {f.error && <span className="block">{f.error}</span>}
                {showSamples && f.actual && <span className="block text-muted">got: {f.actual}</span>}
                {showSamples &&
                  f.samples.slice(0, 5).map((s, j) => (
                    <span key={j} className="block font-mono">
                      {s.row_number}: {JSON.stringify(s.value)}
                    </span>
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Attempts({ jobs }: { jobs: PipelineJob[] }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 font-semibold">Cloud Run attempts</h2>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-semibold">#</th>
              <th className="px-4 py-2 font-semibold">Status</th>
              <th className="px-4 py-2 font-semibold">Started</th>
              <th className="px-4 py-2 font-semibold">Took</th>
              <th className="px-4 py-2 font-semibold">Rows (file / loaded)</th>
              <th className="px-4 py-2 font-semibold">Reason</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.job_id} className="border-t border-line align-top">
                <td className="px-4 py-1.5 tabular">{j.attempt_number ?? "—"}</td>
                <td className={`px-4 py-1.5 font-medium ${JOB_TONE[j.status] ?? ""}`}>{j.status.replace("_", " ").toLowerCase()}</td>
                <td className="whitespace-nowrap px-4 py-1.5 text-muted">{dateTime(j.start_time ?? j.created_at)}</td>
                <td className="px-4 py-1.5 tabular text-muted">{j.duration_seconds != null ? `${j.duration_seconds.toFixed(1)}s` : "—"}</td>
                <td className="px-4 py-1.5 tabular">
                  {j.rows_in_file ?? "—"} / {j.rows_loaded ?? "—"}
                </td>
                <td className="px-4 py-1.5 text-xs">
                  {j.error_code && <span className="mr-1 font-mono text-bad">{j.error_code}</span>}
                  {j.status_reason ?? j.error_message ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const RESULT_TONE = { PASS: "bg-ok/15 text-ok", WARN: "bg-warn/15 text-warn", FAIL: "bg-bad/15 text-bad" } as const;

function Checks({ checks, showSamples }: { checks: PipelineCheck[]; showSamples: boolean }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 font-semibold">Cloud Run checks</h2>
      <p className="mb-2 text-sm text-muted">From file_audit.validation_metadata, for the latest attempt.</p>
      <ul className="flex flex-col gap-2">
        {checks.map((c, i) => (
          <li key={`${c.check_name}-${i}`} className="overflow-hidden rounded-xl border border-line">
            <div className="flex flex-wrap items-start gap-3 px-4 py-3">
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${RESULT_TONE[c.result] ?? "bg-surface text-muted"}`}>
                {c.result}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {c.check_name} <span className="text-xs font-normal text-muted">{c.stage === "POST_LOAD" ? "after load" : "before load"}</span>
                </p>
                <p className="text-sm text-muted">{c.summary}</p>
              </div>
              {c.records_evaluated != null && (
                <span className="text-xs text-muted tabular">
                  {c.records_evaluated.toLocaleString()} rows
                  {c.records_failed ? ` · ${c.records_failed} failed` : ""}
                  {c.records_warned ? ` · ${c.records_warned} warned` : ""}
                </span>
              )}
            </div>
            {c.result !== "PASS" && c.failures.length > 0 && (
              <div className="border-t border-line">
                <FailureTable failures={c.failures} showSamples={showSamples} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
