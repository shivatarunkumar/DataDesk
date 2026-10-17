"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { api, errorText } from "@/lib/api";
import { dateTime, describeResult, timeAgo, writeModeLabel } from "@/lib/format";
import type { UploadRequest } from "@/lib/types";
import { DeleteRequestButton } from "./DeleteRequest";
import { ChevronRightIcon, SpinnerIcon } from "./icons";
import { LoadFlowCompact, stagesFor, studioChanges } from "./LoadFlow";
import { Alert, EmptyState, StatusPill } from "./ui";

const STATUS_FILTERS = [
  { value: "", label: "Any status" },
  { value: "pending", label: "Pending" },
  { value: "reviewed", label: "Decided (history)" },
  { value: "completed", label: "Completed" },
  { value: "rejected", label: "Rejected" },
  { value: "failed", label: "Failed" },
];

/** The requests page: yours, or everyone's (so nobody files a load that is already waiting). */
export function RequestsBrowser({ isAdmin = false }: { isAdmin?: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const scope = params.get("scope") === "all" ? "all" : "mine";
  const status = params.get("status") ?? "";

  function go(next: { scope?: string; status?: string }) {
    const q = new URLSearchParams();
    const s = next.scope ?? scope;
    const st = next.status ?? status;
    if (s === "all") q.set("scope", "all");
    if (st) q.set("status", st);
    router.replace(q.size ? `/uploads?${q}` : "/uploads", { scroll: false });
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line">
        <div role="tablist" className="flex gap-1">
          {[
            { key: "mine", label: "Mine" },
            { key: "all", label: "Everyone" },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={scope === t.key}
              onClick={() => go({ scope: t.key })}
              className={`-mb-px border-b-2 px-3 py-2.5 text-sm font-medium ${
                scope === t.key ? "border-brand text-brand" : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <select
          value={status}
          onChange={(e) => go({ status: e.target.value })}
          aria-label="Filter by status"
          className="mb-2 h-9 rounded-lg border border-line bg-bg px-2 text-sm outline-none focus:border-brand"
        >
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      {scope === "all" && (
        <p className="mb-3 text-sm text-muted">
          {status === "reviewed"
            ? "Every load an admin has decided on: who asked, who decided and what happened."
            : "Every load anyone has asked for. Check here before sending data to a table someone is already loading."}
        </p>
      )}
      <RequestList scope={scope} status={status} isAdmin={isAdmin} />
    </>
  );
}

/** A list of load requests: yours by default, one file's when fileId is given. */
export function RequestList({
  fileId,
  scope = "mine",
  status = "",
  isAdmin = false,
}: {
  fileId?: string;
  scope?: "mine" | "all";
  status?: string;
  /** admins get a Delete button on each request */
  isAdmin?: boolean;
}) {
  const [requests, setRequests] = useState<UploadRequest[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setRequests(null);
    const q = new URLSearchParams({ scope });
    if (status) q.set("status", status);
    api<UploadRequest[]>(`/requests?${q}`)
      .then((all) => setRequests(fileId ? all.filter((r) => r.file_id === fileId) : all))
      .catch((e) => setError(errorText(e)));
  }, [fileId, scope, status]);

  if (error) return <Alert>{error}</Alert>;
  if (!requests)
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <SpinnerIcon /> Loading requests…
      </p>
    );
  if (requests.length === 0)
    return (
      <EmptyState title={status ? `No ${status === "reviewed" ? "decided" : status} requests` : "No load requests yet"}>
        {scope === "mine" && (
          <>
            Open a file and use <span className="font-medium text-fg">Load to table</span> to ask for one.
          </>
        )}
      </EmptyState>
    );

  return (
    <ul className="flex max-w-5xl flex-col gap-2">
      {requests.map((r) => (
        <RequestCard
          key={r.id}
          request={r}
          showFile={!fileId}
          onDeleted={isAdmin ? () => setRequests((rows) => rows?.filter((x) => x.id !== r.id) ?? null) : undefined}
        />
      ))}
    </ul>
  );
}

/** Who asked, who decided: "Requested by Ann · approved by Raj 2 hours ago". */
export function People({ r }: { r: UploadRequest }) {
  const decided =
    r.status === "pending"
      ? "waiting for an admin"
      : r.reviewed_by_name
        ? `${r.status === "rejected" ? "rejected" : "approved"} by ${r.reviewed_by_name} ${timeAgo(r.reviewed_at)} (${dateTime(r.reviewed_at)})`
        : r.status;
  return (
    <>
      Requested by <span className="font-medium text-fg">{r.is_mine ? "you" : r.user_name}</span> {timeAgo(r.created_at)} ·{" "}
      {decided}
    </>
  );
}

export function RequestCard({
  request: r,
  showFile = true,
  children,
  onDeleted,
}: {
  request: UploadRequest;
  showFile?: boolean;
  children?: ReactNode;
  /** set (admins only): a Delete button, and what to do once it's gone */
  onDeleted?: () => void;
}) {
  const outcome = describeResult(r.result);
  const target = r.target_label ?? `${r.target_database}.${r.target_table}`;
  return (
    <li className="rounded-xl border border-line transition hover:border-brand/40">
      <div className="flex items-start">
        <Link href={`/requests/${r.id}`} className="block min-w-0 flex-1 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">
                {showFile && (
                  <>
                    {r.origin === "studio" ? (
                      <>
                        Data Studio <span className="text-muted">({studioChanges(r.change_summary)})</span>
                      </>
                    ) : (
                      <>
                        {r.file_name ?? <span className="text-muted">deleted file</span>}
                        {r.file_version && <span className="text-muted"> v{r.file_version}</span>}
                        {r.origin === "pipeline" && r.landing_name && r.landing_name !== r.file_name && (
                          <span className="text-xs font-normal text-muted"> (as {r.landing_name})</span>
                        )}
                      </>
                    )}
                    <span className="text-muted"> → </span>
                  </>
                )}
                <span>{target}</span>
                {r.target_label && (
                  <span className="text-xs font-normal text-muted">
                    {" "}
                    ({r.target_database}.{r.target_table})
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                BigQuery ·{" "}
                {r.origin === "pipeline" ? "Cloud Run · " : ""}
                {writeModeLabel(r.write_mode, r.key_columns)}
                {r.contract_version ? ` · contract v${r.contract_version}` : ""} · {dateTime(r.created_at)}
              </p>
              <p className="mt-1 text-xs text-muted">
                <People r={r} />
              </p>
              <div className="mt-2.5">
                <LoadFlowCompact stages={stagesFor(r)} />
              </div>
            </div>
            <span className="flex items-center gap-2">
              <StatusPill status={r.origin === "pipeline" && r.status === "approved" && r.landing_uri ? "processing" : r.status} />
              <ChevronRightIcon width={18} height={18} className="text-muted" />
            </span>
          </div>

          {r.justification && <p className="mt-2 text-sm italic text-muted">“{r.justification}”</p>}
          {r.origin === "pipeline" && r.status === "approved" && r.pipeline?.message ? (
            <p className={`mt-2 text-sm ${r.pipeline.state === "not_picked_up" ? "text-warn" : "text-muted"}`}>{r.pipeline.message}</p>
          ) : (
            outcome && <p className={`mt-2 text-sm ${r.result?.error ? "text-bad" : "text-ok"}`}>{outcome}</p>
          )}
          {r.review_note && (
            <p className="mt-2 text-sm">
              <span className="font-medium">Admin note:</span> {r.review_note}
            </p>
          )}
        </Link>
        {/* admins: Delete sits in the top row, beside the status (outside the link) */}
        {onDeleted && (
          <span className="shrink-0 pr-2 pt-3">
            <DeleteRequestButton request={r} onDeleted={onDeleted} compact />
          </span>
        )}
      </div>
      {children && <div className="border-t border-line px-4 pb-4">{children}</div>}
    </li>
  );
}
