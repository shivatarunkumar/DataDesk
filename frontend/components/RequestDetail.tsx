"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { api, errorText } from "@/lib/api";
import { TARGET_LABELS, dateTime, describeResult } from "@/lib/format";
import { notifyPendingChanged } from "@/lib/pending";
import type { UploadRequest } from "@/lib/types";
import { RejectDialog } from "./AdminPanel";
import { ArrowLeftIcon, CheckIcon, SpinnerIcon } from "./icons";
import { StudioChanges } from "./DataStudio";
import { LoadFlow, stagesFor, studioChanges } from "./LoadFlow";
import { ValidationReportView } from "./LoadToTable";
import { Alert, EmptyState, StatusPill, btn } from "./ui";

/** One load request: what, who asked, who decided, and what happened. Admins decide here. */
export function RequestDetail({ requestId, isAdmin }: { requestId: string; isAdmin: boolean }) {
  const router = useRouter();
  const [r, setR] = useState<UploadRequest | null>(null);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [rejecting, setRejecting] = useState(false);

  const load = useCallback(() => {
    api<UploadRequest>(`/requests/${requestId}`)
      .then(setR)
      .catch((e) => ((e as { status?: number }).status === 404 ? setMissing(true) : setError(errorText(e))));
  }, [requestId]);
  useEffect(load, [load]);

  // while it is still moving, keep the flow current without a reload
  const moving = r?.status === "pending" || r?.status === "approved";
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [moving, load]);

  async function decide(action: "approve" | "reject", note?: string) {
    setBusy(action);
    setError("");
    try {
      setR(
        await api<UploadRequest>(`/admin/upload-requests/${requestId}/${action}`, {
          method: "POST",
          json: action === "reject" ? { review_note: note || null } : undefined,
        }),
      );
      notifyPendingChanged();
    } catch (e) {
      setError(errorText(e));
      load();
    } finally {
      setBusy(null);
    }
  }

  if (missing) return <EmptyState title="Request not found">It may belong to a file that was deleted.</EmptyState>;
  if (!r)
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted">
        {error ? <Alert>{error}</Alert> : <><SpinnerIcon /> Loading…</>}
      </div>
    );

  const target = r.target_label ?? `${r.target_database}.${r.target_table}`;
  const location = [r.target_database, r.target_schema, r.target_table].filter(Boolean).join(".");
  const outcome = describeResult(r.result);
  const report = r.validation_report;
  const pending = r.status === "pending";

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 lg:px-6">
      <div className="flex flex-wrap items-start gap-3 py-4">
        <button type="button" onClick={() => router.back()} className={btn.icon} aria-label="Back">
          <ArrowLeftIcon width={20} height={20} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl">
            {r.origin === "studio" ? "Data Studio edits" : (r.file_name ?? "Deleted file")} <span className="text-muted">→</span>{" "}
            {target}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {TARGET_LABELS[r.target_type] ?? r.target_type} · {location}
          </p>
        </div>
        <StatusPill status={r.status} />
      </div>

      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}

      {/* where it stands, from submit to loaded */}
      <section className="mb-6 overflow-x-auto rounded-2xl border border-line p-5">
        <LoadFlow stages={stagesFor(r)} />
      </section>

      {isAdmin && pending && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-warn/40 bg-warn/10 p-4">
          <p className="min-w-0 flex-1 text-sm">
            Approving checks the file against the table{r.target_id ? " and its current data contract" : ""} once more, then
            loads it into <span className="font-medium">{location}</span>.
          </p>
          <button type="button" className={btn.primary} disabled={busy !== null} onClick={() => decide("approve")}>
            {busy === "approve" ? (
              <>
                <SpinnerIcon /> Checking and loading…
              </>
            ) : (
              "Approve & load"
            )}
          </button>
          <button type="button" className={btn.danger} disabled={busy !== null} onClick={() => setRejecting(true)}>
            Reject
          </button>
        </div>
      )}
      {!isAdmin && pending && !r.is_mine && (
        <div className="mb-6">
          <Alert tone="info">
            {r.user_name} is already loading into {target}. If you meant to send the same data, there&apos;s no need.
          </Alert>
        </div>
      )}

      {/* the facts */}
      <dl className="grid overflow-hidden rounded-xl border border-line sm:grid-cols-2">
        <Fact label={r.origin === "studio" ? "Source" : "File"}>
          {r.origin === "studio" && (
            <span className="block">
              Data Studio · <span className="text-muted">{studioChanges(r.change_summary)}</span>
            </span>
          )}
          {r.is_mine && r.file_name ? (
            <Link href={`/files/${r.file_id}`} className="font-medium text-brand hover:underline">
              {r.file_name}
            </Link>
          ) : (
            (r.file_name ?? "deleted")
          )}
          {r.file_version && <span className="text-muted"> · version {r.file_version}</span>}
          {report?.stats && (
            <span className="block text-xs text-muted">
              {report.stats.file_rows.toLocaleString()} rows · {report.stats.file_columns} columns
            </span>
          )}
        </Fact>
        <Fact label="Target">
          <span className="font-medium">{target}</span>
          <span className="block text-xs text-muted">
            {TARGET_LABELS[r.target_type] ?? r.target_type} · {location}
          </span>
        </Fact>
        <Fact label="Write mode">
          {r.write_mode === "upsert" ? (
            <>
              Upsert <span className="text-muted">on {(r.key_columns ?? []).join(", ")}</span>
            </>
          ) : r.write_mode === "update" ? (
            <>
              Edit in place{" "}
              <span className="text-muted">
                · {r.change_summary?.matched ?? r.change_summary?.edited} row{(r.change_summary?.matched ?? 0) === 1 ? "" : "s"} updated
                {r.change_summary?.added ? `, ${r.change_summary.added} added` : ""}
              </span>
            </>
          ) : (
            "Append"
          )}
        </Fact>
        <Fact label="Data contract">
          {r.contract_version ? (
            <>
              Passed v{r.contract_version}
              {r.target_id && (
                <Link href={`/onboarding/${r.target_id}`} className="ml-2 text-xs font-medium text-brand hover:underline">
                  Open contract
                </Link>
              )}
            </>
          ) : (
            <span className="text-muted">No contract: schema checks only</span>
          )}
        </Fact>
        <Fact label="Why" wide>
          {r.justification ? <span className="italic">“{r.justification}”</span> : <span className="text-muted">Not given</span>}
        </Fact>
        {r.review_note && (
          <Fact label="Admin note" wide>
            {r.review_note}
          </Fact>
        )}
        {outcome && (
          <Fact label="Result" wide>
            <span className={r.result?.error ? "text-bad" : "text-ok"}>{outcome}</span>
          </Fact>
        )}
      </dl>

      {r.origin === "studio" && r.change_summary && (
        <section className="mt-6">
          <h2 className="mb-2 font-semibold">Changes</h2>
          <StudioChanges request={r} />
          {r.change_summary.query && (
            <details className="mt-3 rounded-xl border border-line">
              <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">The query the rows came from</summary>
              <pre className="overflow-x-auto border-t border-line bg-surface px-4 py-3 font-mono text-xs">{r.change_summary.query}</pre>
            </details>
          )}
        </section>
      )}

      {/* validation */}
      <section className="mt-6">
        <h2 className="mb-2 font-semibold">Validation</h2>
        {report && !report.passed && report.errors.length > 0 ? (
          <ValidationReportView
            report={report}
            title={r.status === "failed" ? "It failed the check at approval" : "The file doesn't pass"}
            hint={r.is_mine ? "Fix them in the Edit tab, save, and ask again." : ""}
          />
        ) : report && !report.passed ? (
          <Alert>{report.summary} Only the requester and admins see the rows involved.</Alert>
        ) : (
          <p className="flex items-center gap-2 text-sm text-ok">
            <CheckIcon width={16} height={16} />
            Passed the table&apos;s schema{r.contract_version ? ` and data contract v${r.contract_version}` : ""} when it was
            requested.
          </p>
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

function Fact({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`border-b border-line px-4 py-3 last:border-b-0 sm:odd:border-r ${wide ? "sm:col-span-2 sm:!border-r-0" : ""}`}>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}
