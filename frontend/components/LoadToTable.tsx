"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { ApiError, api, errorText } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import type { Target, UploadRequest, ValidationReport, WsFile } from "@/lib/types";
import { ContractSummary } from "./ContractSummary";
import { LoadFlow, flowSummary, stagesFor, stagesForSubmit } from "./LoadFlow";
import { SpinnerIcon } from "./icons";
import { Alert, btn, inputClass } from "./ui";

const TYPES: { value: Target["target_type"]; label: string; hint: string }[] = [
  { value: "bigquery", label: "BigQuery", hint: "Datasets in the GCP project" },
  { value: "postgres", label: "PostgreSQL", hint: "Registered databases" },
  { value: "oracle", label: "Oracle", hint: "Coming soon" },
];

const selectClass = `${inputClass} font-normal`;

const keyOf = (t: Target) => (t.schema_name && t.target_type !== "bigquery" ? `${t.schema_name}.${t.table}` : t.table);

export function LoadToTable({ file, onSubmitted }: { file: WsFile; onSubmitted: () => void }) {
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [type, setType] = useState<Target["target_type"] | "">("");
  const [database, setDatabase] = useState("");
  const [table, setTable] = useState("");
  const [mode, setMode] = useState<"append" | "upsert">("append");
  const [keys, setKeys] = useState<string[]>([]);
  const [justification, setJustification] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [filed, setFiled] = useState<UploadRequest | null>(null);

  useEffect(() => {
    api<Target[]>("/workspace/targets")
      .then(setTargets)
      .catch((e) => setError(errorText(e)));
  }, []);

  const columns = (file.column_meta ?? []).map((m) => m.name);
  const enabled = useMemo(() => (targets ?? []).filter((t) => t.enabled), [targets]);
  const databases = [...new Set(enabled.filter((t) => t.target_type === type && t.database).map((t) => t.database!))];
  const tables = enabled.filter((t) => t.target_type === type && t.database === database);
  const chosen = tables.find((t) => keyOf(t) === table);
  const onboarded = Boolean(chosen?.target_id);
  const modes = chosen?.write_modes ?? ["append", "upsert"];
  const ready = Boolean(chosen) && modes.includes(mode) && (mode === "append" || keys.length > 0);

  // what is already waiting for this table, so nobody sends the same data twice
  const [waiting, setWaiting] = useState<UploadRequest[]>([]);
  useEffect(() => {
    setWaiting([]);
    if (!chosen) return;
    const q = new URLSearchParams({ scope: "all", status: "pending" });
    if (chosen.target_id) q.set("target_id", chosen.target_id);
    else {
      q.set("target_type", chosen.target_type);
      q.set("database", chosen.database ?? "");
      q.set("table", chosen.table);
    }
    let active = true;
    api<UploadRequest[]>(`/requests?${q}`)
      .then((rows) => active && setWaiting(rows))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [chosen]);

  function choose(t: Target | undefined) {
    setTable(t ? keyOf(t) : "");
    setReport(null);
    if (!t) return;
    setMode(t.write_modes.includes("append") ? "append" : "upsert");
    // an onboarded table fixes its upsert key
    setKeys(t.target_id ? t.key_columns : []);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setError("");
    setReport(null);
    try {
      const request = await api<UploadRequest>("/workspace/upload-requests", {
        method: "POST",
        json: chosen.target_id
          ? {
              file_id: file.id,
              target_id: chosen.target_id,
              write_mode: mode,
              justification: justification.trim() || null,
            }
          : {
              file_id: file.id,
              target_type: chosen.target_type,
              database: chosen.database,
              schema_name: chosen.schema_name ?? "public",
              table: chosen.table,
              write_mode: mode,
              key_columns: mode === "upsert" ? keys : null,
              justification: justification.trim() || null,
            },
      });
      setFiled(request);
    } catch (err) {
      // 422 with a report: the file didn't pass, nothing was filed
      const body = err instanceof ApiError ? (err.body as UploadRequest | null) : null;
      if (body?.validation_report) setReport(body.validation_report);
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (filed) {
    return (
      <FiledRequest
        request={filed}
        onUpdate={setFiled}
        onSeeRequests={onSubmitted}
        onLoadElsewhere={() => {
          setFiled(null);
          setJustification("");
        }}
      />
    );
  }

  if (!targets && !error)
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <SpinnerIcon /> Finding the tables you can load into…
      </p>
    );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]">
      <form onSubmit={submit} className="flex flex-col gap-5">
        {error && <Alert>{error}</Alert>}
        {targets && enabled.length === 0 && (
          <Alert tone="info">
            No tables are open for loads yet.{" "}
            <Link href="/onboarding/new" className="font-medium underline">
              Ask for one to be onboarded
            </Link>
            .
          </Alert>
        )}

        <fieldset>
          <legend className="mb-2 flex w-full items-baseline justify-between text-sm font-medium">
            Where to
            <Link href="/onboarding/new" className="text-xs font-medium text-brand hover:underline">
              Table missing? Ask for it
            </Link>
          </legend>
          <div className="grid grid-cols-3 gap-2">
            {TYPES.map((t) => {
              const count = enabled.filter((x) => x.target_type === t.value).length;
              const available = t.value !== "oracle" && count > 0;
              return (
                <button
                  key={t.value}
                  type="button"
                  disabled={!available}
                  onClick={() => {
                    setType(t.value);
                    setDatabase("");
                    choose(undefined);
                  }}
                  className={`rounded-xl border px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-50 ${
                    type === t.value ? "border-brand bg-brand/5 ring-1 ring-brand" : "border-line hover:bg-surface"
                  }`}
                >
                  <span className="block text-sm font-semibold">{t.label}</span>
                  <span className="block text-xs text-muted">
                    {t.value === "oracle" ? t.hint : available ? `${count} table${count === 1 ? "" : "s"}` : "None open yet"}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {type && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              {type === "bigquery" ? "Dataset" : "Database"}
              <select
                className={selectClass}
                value={database}
                onChange={(e) => {
                  setDatabase(e.target.value);
                  choose(undefined);
                }}
              >
                <option value="">Choose…</option>
                {databases.map((d) => (
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
                value={table}
                disabled={!database}
                onChange={(e) => choose(tables.find((t) => keyOf(t) === e.target.value))}
              >
                <option value="">Choose…</option>
                {tables.map((t) => (
                  <option key={keyOf(t)} value={keyOf(t)}>
                    {t.target_id ? `${t.label} (${keyOf(t)})` : keyOf(t)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {chosen && (
          <>
            {chosen.description && <p className="-mt-2 text-sm text-muted">{chosen.description}</p>}

            {waiting.length > 0 && (
              <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">
                <p className="font-medium">
                  {waiting.length} request{waiting.length === 1 ? " is" : "s are"} already waiting for this table
                </p>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {waiting.map((w) => (
                    <li key={w.id}>
                      <Link href={`/requests/${w.id}`} className="hover:underline">
                        <span className="font-medium">{w.is_mine ? "You" : w.user_name}</span>
                        <span className="text-muted">
                          {" "}
                          · {w.file_name} · {w.write_mode} · {timeAgo(w.created_at)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-xs text-muted">Check it isn&apos;t the same data before sending yours.</p>
              </div>
            )}

            <fieldset>
              <legend className="mb-2 text-sm font-medium">How</legend>
              <div className="inline-flex rounded-full bg-surface p-1">
                {(["append", "upsert"] as const)
                  .filter((m) => modes.includes(m))
                  .map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={`rounded-full px-4 py-1.5 text-sm font-medium ${
                        mode === m ? "bg-chip-active text-chip-active-text" : "text-muted hover:text-fg"
                      }`}
                    >
                      {m === "append" ? "Append rows" : "Upsert"}
                    </button>
                  ))}
              </div>
              <p className="mt-1.5 text-xs text-muted">
                {mode === "append"
                  ? "Every row is inserted as a new row."
                  : "Rows whose key matches an existing row update it; the rest are inserted."}
                {modes.length === 1 && " It's the only mode this table accepts."}
              </p>
            </fieldset>

            {mode === "upsert" && (
              <fieldset>
                <legend className="mb-2 text-sm font-medium">Key columns</legend>
                {onboarded ? (
                  <p className="text-sm">
                    {keys.map((k) => (
                      <span key={k} className="mr-1.5 rounded-full bg-brand px-3 py-1 text-xs font-medium text-brand-contrast">
                        {k}
                      </span>
                    ))}
                    <span className="mt-1.5 block text-xs text-muted">Set by the admin who onboarded this table.</span>
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {columns.map((c) => {
                        const on = keys.includes(c);
                        return (
                          <button
                            key={c}
                            type="button"
                            aria-pressed={on}
                            onClick={() => setKeys((k) => (on ? k.filter((x) => x !== c) : [...k, c]))}
                            className={`rounded-full px-3 py-1 text-xs font-medium ${
                              on ? "bg-brand text-brand-contrast" : "bg-surface text-muted hover:bg-surface-hover hover:text-fg"
                            }`}
                          >
                            {c}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-1.5 text-xs text-muted">The columns that identify a row. Each key must be unique in the file.</p>
                  </>
                )}
              </fieldset>
            )}

            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Why is this data being loaded?
              <textarea
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Monthly refresh of the customer segments"
                className={`${inputClass} h-20 py-2 font-normal`}
              />
              <span className="text-xs font-normal text-muted">The approving admin sees this.</span>
            </label>

            <div>
              <button type="submit" className={btn.primary} disabled={!ready || busy}>
                {busy ? (
                  <>
                    <SpinnerIcon /> Checking the file…
                  </>
                ) : onboarded ? (
                  "Check contract & request approval"
                ) : (
                  "Validate & request approval"
                )}
              </button>
            </div>
          </>
        )}
      </form>

      <aside className="flex h-fit flex-col gap-4">
        {chosen &&
          (onboarded ? (
            <ContractSummary contract={chosen.contract} columns={chosen.columns} version={chosen.contract_version} />
          ) : (
            <Alert tone="info">
              This table has no data contract, so only its schema is checked: columns, types and NOT NULL.
            </Alert>
          ))}
        <div className="rounded-xl border border-line bg-surface p-4 text-sm">
          <h2 className="font-semibold">What happens</h2>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-muted">
            <li>
              Version {file.current_version} is checked against the table&apos;s live schema
              {onboarded ? " and its data contract" : ""}.
            </li>
            <li>If it passes, an admin gets a request. Nothing is written yet.</li>
            <li>On approval the file is checked again, then loaded. You see the outcome under Requests.</li>
          </ol>
        </div>
      </aside>

      {(busy || report) && (
        <section className="overflow-x-auto rounded-2xl border border-line p-5 lg:col-span-2">
          <LoadFlow stages={stagesForSubmit(busy ? "checking" : "failed", onboarded, report)} />
        </section>
      )}
      {report && !busy && (
        <div className="lg:col-span-2">
          <ValidationReportView report={report} />
        </div>
      )}
    </div>
  );
}

const RULE_LABELS: Record<string, string> = {
  type: "Wrong type",
  not_null: "Empty, but NOT NULL",
  missing_column: "Missing column",
  unknown_column: "Not in the table",
  key: "Key",
  key_unique: "Duplicate key",
  unique: "Contract: must be unique",
  rule: "Contract",
  max_rows: "Contract: too many rows",
  file: "File",
};

export function ValidationReportView({
  report,
  title = "The file doesn't pass — nothing was sent for approval",
  hint = "Fix them in the Edit tab, save, and try again.",
  rowLabel = (row) => String(row + 1),
}: {
  report: ValidationReport;
  title?: string;
  hint?: string;
  /** how a row is named: its number in a file, its key in Data Studio */
  rowLabel?: (row: number) => string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-bad/40">
      <div className="bg-bad/10 px-4 py-3">
        <h3 className="font-semibold text-bad">{title}</h3>
        <p className="text-sm text-muted">
          {report.summary}
          {report.contract_version ? ` Checked against data contract v${report.contract_version}.` : ""} {hint}
        </p>
      </div>
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-semibold">Row</th>
              <th className="px-4 py-2 font-semibold">Column</th>
              <th className="px-4 py-2 font-semibold">Check</th>
              <th className="px-4 py-2 font-semibold">Problem</th>
            </tr>
          </thead>
          <tbody>
            {report.errors.map((e, i) => (
              <tr key={i} className="border-t border-line">
                <td className="px-4 py-1.5 text-muted tabular">{e.row == null ? "—" : rowLabel(e.row)}</td>
                <td className="px-4 py-1.5 font-medium">{e.column ?? "—"}</td>
                <td className="whitespace-nowrap px-4 py-1.5 text-muted">{RULE_LABELS[e.rule] ?? e.rule}</td>
                <td className="px-4 py-1.5">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** After sending: where the request stands, kept current until it is loaded or stopped. */
function FiledRequest({
  request,
  onUpdate,
  onSeeRequests,
  onLoadElsewhere,
}: {
  request: UploadRequest;
  onUpdate: (r: UploadRequest) => void;
  onSeeRequests: () => void;
  onLoadElsewhere: () => void;
}) {
  const moving = request.status === "pending" || request.status === "approved";
  useEffect(() => {
    if (!moving || !request.id) return;
    const timer = setInterval(() => {
      api<UploadRequest>(`/requests/${request.id}`)
        .then(onUpdate)
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [moving, request.id, onUpdate]);

  const stages = stagesFor(request);
  const summary = flowSummary(stages);
  const target = request.target_label ?? `${request.target_database}.${request.target_table}`;
  const title =
    request.status === "pending"
      ? "Sent — waiting for an admin to approve"
      : request.status === "completed"
        ? "Loaded"
        : summary.text;

  return (
    <div className="max-w-5xl rounded-2xl border border-line p-5">
      <h2 className="display text-xl">{title}</h2>
      <p className="mt-1 text-sm text-muted">
        Version {request.file_version} of this file → <span className="font-medium text-fg">{target}</span>
        {request.status === "pending" && " · it is checked again when an admin approves it, then loaded"}
      </p>
      <div className="mt-5 overflow-x-auto">
        <LoadFlow stages={stages} />
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        {request.id && (
          <Link href={`/requests/${request.id}`} className={btn.primary}>
            Follow this request
          </Link>
        )}
        <button type="button" className={btn.secondary} onClick={onSeeRequests}>
          See my requests
        </button>
        <button type="button" className={btn.secondary} onClick={onLoadElsewhere}>
          Load somewhere else
        </button>
      </div>
    </div>
  );
}
