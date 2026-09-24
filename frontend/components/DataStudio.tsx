"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, errorText } from "@/lib/api";
import { humanSize, timeAgo } from "@/lib/format";
import { notifyPendingChanged } from "@/lib/pending";
import type { Folder, StudioResult, Target, UploadRequest, ValidationReport, WsFile } from "@/lib/types";
import { ContractSummary } from "./ContractSummary";
import { LoadFlow, flowSummary, stagesFor, stagesForSubmit, studioChanges } from "./LoadFlow";
import { ValidationReportView } from "./LoadToTable";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DatabaseIcon,
  DownloadIcon,
  InfoIcon,
  KeyIcon,
  PanelLeftIcon,
  PlayIcon,
  PlusIcon,
  SpinnerIcon,
  TrashIcon,
  UndoIcon,
} from "./icons";
import { Alert, Dialog, EmptyState, Field, btn, inputClass } from "./ui";

/**
 * Data Studio: pick an onboarded table, query it with SQL, change a few cells or add a few
 * rows, and send the changes through the same checks and approval as a file.
 *
 * It is meant for small fixes. Bigger edits go through a file: "Export to My files" saves
 * the result as a CSV, which is edited and loaded like any other.
 */

type Source = "bigquery" | "postgres";
const SOURCES: { value: Source; label: string }[] = [
  { value: "bigquery", label: "BigQuery" },
  { value: "postgres", label: "PostgreSQL" },
];

type Cell = string | null;
/** an edited existing row: its column → new value */
type RowEdits = Record<string, Cell>;

const PANEL_KEY = "datadesk:studio-panel";
// nested BigQuery columns hold structures, not text a cell can edit
const nested = (type: string | null) => /^(RECORD|STRUCT|ARRAY)\b|\[\]$/i.test(type ?? "");

const same = (a: Cell, b: Cell) => (a ?? "") === (b ?? "");

function starterQuery(t: Target): string {
  if (t.target_type === "bigquery") return `SELECT *\nFROM \`${t.database}.${t.table}\`\nLIMIT 100`;
  const order = t.key_columns.length ? `\nORDER BY ${t.key_columns.join(", ")}` : "";
  return `SELECT *\nFROM ${t.schema_name ?? "public"}.${t.table}${order}\nLIMIT 100`;
}

export function DataStudio() {
  const [tables, setTables] = useState<Target[] | null>(null);
  const [source, setSource] = useState<Source>("bigquery");
  const [database, setDatabase] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [sql, setSql] = useState("");
  const [running, setRunning] = useState(false);
  const [queryError, setQueryError] = useState("");
  const [result, setResult] = useState<StudioResult | null>(null);
  const [ranSql, setRanSql] = useState("");
  const [edits, setEdits] = useState<Record<number, RowEdits>>({});
  const [added, setAdded] = useState<Record<string, Cell>[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [filed, setFiled] = useState<UploadRequest | null>(null);
  const [exported, setExported] = useState<{ file: WsFile; truncated: boolean; folder: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState("");
  // kept here so closing the review to fix a value doesn't lose it
  const [justification, setJustification] = useState("");
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const lastStarter = useRef("");
  // the table last picked in the list, highlighted until a query says otherwise
  const [picked, setPicked] = useState<string | null>(null);
  // the table list can be folded away to give the grid the width
  const [panelOpen, setPanelOpen] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(PANEL_KEY) === "closed") setPanelOpen(false);
    } catch {}
  }, []);
  function togglePanel(open: boolean) {
    setPanelOpen(open);
    try {
      window.localStorage.setItem(PANEL_KEY, open ? "open" : "closed");
    } catch {}
  }
  // cells the last check refused, "e:<row>:<column>" or "a:<new row>:<column>" → why
  const [problems, setProblems] = useState<Record<string, string>>({});
  // the grid is read-only until the Edit switch is on
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    api<Target[]>("/studio/tables")
      .then((rows) => {
        setTables(rows);
        // start on a source that has tables
        if (!rows.some((t) => t.target_type === "bigquery") && rows.some((t) => t.target_type === "postgres")) {
          setSource("postgres");
        }
      })
      .catch((e) => setQueryError(errorText(e)));
  }, []);

  const bySource = useMemo(() => (tables ?? []).filter((t) => t.target_type === source), [tables, source]);
  const databases = useMemo(() => [...new Set(bySource.map((t) => t.database ?? ""))].sort(), [bySource]);
  useEffect(() => {
    if (databases.length && !databases.includes(database)) setDatabase(databases[0]);
  }, [databases, database]);

  const target = useMemo(
    () => (result?.target_id ? (tables ?? []).find((t) => t.target_id === result.target_id) : undefined),
    [result, tables],
  );
  const editedRows = Object.keys(edits).length;
  const changeCount = editedRows + added.length;
  const dirty = changeCount > 0;
  const overLimit = result ? changeCount > result.max_changes : false;

  // leaving with changes that were never submitted asks first
  useEffect(() => {
    if (!dirty || filed) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, filed]);

  const discardChanges = useCallback(() => {
    setEdits({});
    setAdded([]);
    setProblems({});
  }, []);

  /** Mark the cells a failed check names; the submitted rows are the edited ones, then the new ones. */
  function markProblems(report: ValidationReport) {
    const edited = Object.keys(edits).map(Number);
    const next: Record<string, string> = {};
    for (const e of report.errors) {
      if (e.row == null || !e.column) continue;
      const key = e.row < edited.length ? `e:${edited[e.row]}:${e.column}` : `a:${e.row - edited.length}:${e.column}`;
      next[key] ??= e.message;
    }
    setProblems(next);
  }

  const clearProblem = (key: string) =>
    setProblems((p) => {
      if (!(key in p)) return p;
      const { [key]: _drop, ...rest } = p;
      return rest;
    });

  function confirmDiscard(): boolean {
    return !dirty || window.confirm("Discard your unsent changes?");
  }

  /** Picking a table only writes a starting query; the person edits it and runs it. */
  function pickTable(t: Target) {
    const starter = starterQuery(t);
    // don't throw away a query someone wrote themselves
    if (sql.trim() && sql !== lastStarter.current && sql !== starter && !window.confirm("Replace your query with one for this table?")) return;
    setDatabase(t.database ?? "");
    setSql(starter);
    setPicked(t.target_id);
    lastStarter.current = starter;
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(starter.length, starter.length);
    });
  }

  async function runQuery(text = sql, db = database) {
    if (!text.trim()) return;
    setRunning(true);
    setQueryError("");
    setNotice("");
    setExported(null);
    try {
      const out = await api<StudioResult>("/studio/query", {
        method: "POST",
        json: { target_type: source, database: db || null, sql: text },
      });
      setResult(out);
      setRanSql(text);
      discardChanges();
      setEditing(false);
    } catch (e) {
      setQueryError(errorText(e));
    } finally {
      setRunning(false);
    }
  }

  function exportResult() {
    const text = ranSql || sql;
    if (!text.trim()) return;
    if (dirty && !window.confirm("The export is the data as it is in the table; your unsent edits aren't in it. Export anyway?")) return;
    setQueryError("");
    setExporting(true);
  }

  function setCell(rowIndex: number, column: string, value: string) {
    if (!result) return;
    clearProblem(`e:${rowIndex}:${column}`);
    const ci = result.columns.findIndex((c) => c.name === column);
    const original = result.rows[rowIndex][ci];
    setEdits((prev) => {
      const row = { ...(prev[rowIndex] ?? {}) };
      if (same(original, value)) delete row[column];
      else row[column] = value === "" && original === null ? null : value;
      const next = { ...prev };
      if (Object.keys(row).length) next[rowIndex] = row;
      else delete next[rowIndex];
      return next;
    });
  }

  if (filed) {
    return (
      <Page>
        <StudioFiled
          request={filed}
          onUpdate={setFiled}
          onKeepEditing={() => {
            setFiled(null);
            runQuery(ranSql);
          }}
        />
      </Page>
    );
  }

  const canEdit = editing && result?.edit_mode === "edit";
  const canAdd = editing && (result?.edit_mode === "edit" || result?.edit_mode === "append");

  return (
    <Page>
      <div className={`grid gap-4 ${panelOpen ? "lg:grid-cols-[16rem_minmax(0,1fr)]" : ""}`}>
        {/* ---------------------------------------------------------------- tables */}
        {panelOpen && (
        <aside className="flex h-fit flex-col gap-3 rounded-2xl border border-line p-3 lg:sticky lg:top-4">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Tables</span>
            <button
              type="button"
              className={btn.icon}
              onClick={() => togglePanel(false)}
              aria-label="Hide the table list"
              title="Hide the table list"
            >
              <PanelLeftIcon width={17} height={17} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-full bg-surface p-1">
            {SOURCES.map((s) => {
              const count = (tables ?? []).filter((t) => t.target_type === s.value).length;
              return (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => {
                    if (s.value === source || !confirmDiscard()) return;
                    setSource(s.value);
                    setResult(null);
                    discardChanges();
                    setSql("");
                  }}
                  className={`rounded-full px-2 py-1.5 text-xs font-semibold ${
                    source === s.value ? "bg-chip-active text-chip-active-text" : "text-muted hover:text-fg"
                  }`}
                >
                  {s.label} <span className="font-normal opacity-70 tabular">{count}</span>
                </button>
              );
            })}
          </div>

          {!tables ? (
            <p className="flex items-center gap-2 px-2 py-3 text-sm text-muted">
              <SpinnerIcon /> Loading tables…
            </p>
          ) : bySource.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted">
              No {source === "bigquery" ? "BigQuery" : "PostgreSQL"} tables are onboarded yet.{" "}
              <Link href="/onboarding/new" className="font-medium text-brand hover:underline">
                Ask for one
              </Link>
            </p>
          ) : (
            <nav aria-label="Onboarded tables" className="flex flex-col gap-1">
              <p className="px-2 pt-1 text-xs font-semibold uppercase tracking-wide text-muted">
                {source === "bigquery" ? "Datasets" : "Databases"}
              </p>
              {databases.map((db) => {
                const expanded = open[db] ?? true;
                const inDb = bySource.filter((t) => (t.database ?? "") === db);
                return (
                  <div key={db}>
                    <button
                      type="button"
                      onClick={() => setOpen((o) => ({ ...o, [db]: !expanded }))}
                      aria-expanded={expanded}
                      className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm font-medium hover:bg-surface ${
                        db === database ? "text-brand" : ""
                      }`}
                    >
                      {expanded ? <ChevronDownIcon width={15} height={15} /> : <ChevronRightIcon width={15} height={15} />}
                      <DatabaseIcon width={15} height={15} className="shrink-0 text-muted" />
                      <span className="truncate">{db}</span>
                      <span className="ml-auto text-xs font-normal text-muted tabular">{inDb.length}</span>
                    </button>
                    {expanded && (
                      <ul className="ml-4 border-l border-line pl-2">
                        {inDb.map((t) => {
                          const active = (picked ?? result?.target_id) === t.target_id;
                          return (
                            <li key={t.target_id}>
                              <button
                                type="button"
                                onClick={() => pickTable(t)}
                                title={`Write a query for ${t.table}`}
                                className={`w-full rounded-lg px-2 py-1.5 text-left hover:bg-surface ${active ? "bg-surface" : ""}`}
                              >
                                <span className={`block truncate text-sm ${active ? "font-semibold text-brand" : ""}`}>{t.table}</span>
                                <span className="block truncate text-xs text-muted">
                                  {t.label}
                                  {t.write_modes.includes("upsert") ? " · editable" : " · add rows"}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </nav>
          )}
        </aside>
        )}

        {/* ---------------------------------------------------------------- query + results */}
        <div className="flex min-w-0 flex-col gap-4">
          <form
            className="overflow-hidden rounded-2xl border border-line"
            onSubmit={(e) => {
              e.preventDefault();
              if (confirmDiscard()) runQuery();
            }}
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
              {!panelOpen && (
                <button
                  type="button"
                  className={`${btn.secondary} h-8 px-3`}
                  onClick={() => togglePanel(true)}
                  title="Show the table list"
                >
                  <PanelLeftIcon width={16} height={16} />
                  {source === "bigquery" ? "BigQuery" : "PostgreSQL"} tables
                </button>
              )}
              <label className="flex items-center gap-2 text-xs font-medium text-muted">
                {source === "bigquery" ? "Default dataset" : "Database"}
                <select
                  value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                  className="h-8 rounded-lg border border-line bg-bg px-2 text-sm text-fg"
                  disabled={!databases.length}
                >
                  {databases.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <span className="ml-auto hidden text-xs text-muted sm:inline">⌘/Ctrl + Enter to run · read-only SELECT</span>
              <button type="button" className={btn.secondary} onClick={exportResult} disabled={!(ranSql || sql).trim()}>
                <DownloadIcon width={16} height={16} />
                Export to My files
              </button>
              <button type="submit" className={btn.primary} disabled={running || !sql.trim()}>
                {running ? <SpinnerIcon /> : <PlayIcon width={15} height={15} />}
                Run
              </button>
            </div>
            <textarea
              ref={editorRef}
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (confirmDiscard()) runQuery();
                }
              }}
              spellCheck={false}
              aria-label="SQL query"
              placeholder={bySource.length ? "Pick a table on the left for a starting query, or write a SELECT… then Run" : "SELECT …"}
              className="block h-40 w-full resize-y bg-bg px-4 py-3 font-mono text-sm leading-6 outline-none"
            />
          </form>

          {queryError && <Alert>{queryError}</Alert>}
          {exported && (
            <Alert tone="ok">
              Saved {exported.file.row_count?.toLocaleString()} rows as{" "}
              <Link href={`/files/${exported.file.id}`} className="font-semibold underline">
                {exported.file.original_name}
              </Link>{" "}
              in {exported.folder}. Edit it there, then use <span className="font-medium">Load to table</span>.
              {exported.truncated && " The result was longer than a file can hold, so only the first rows were saved."}
            </Alert>
          )}
          {notice && <Alert tone="warn">{notice}</Alert>}

          {!result && !running && !queryError && (
            <EmptyState title="Query an onboarded table">
              Pick a table for a starting query, change it as you like and press Run. Then change a few values or add a few
              rows and send them for approval: they go through the table&apos;s data contract and an admin before anything is
              written.
            </EmptyState>
          )}

          {result && (
            <ResultGrid
              result={result}
              edits={edits}
              added={added}
              canEdit={canEdit}
              canAdd={canAdd}
              editing={editing}
              onEditing={(on) => {
                if (!on && !confirmDiscard()) return;
                if (!on) discardChanges();
                setEditing(on);
              }}
              onCell={setCell}
              onRevert={(i) =>
                setEdits(({ [i]: _drop, ...rest }) => rest)
              }
              problems={problems}
              onAddRow={() => setAdded((a) => [...a, {}])}
              onAddedCell={(i, c, v) => {
                clearProblem(`a:${i}:${c}`);
                setAdded((a) => a.map((r, j) => (j === i ? { ...r, [c]: v } : r)));
              }}
              onRemoveAdded={(i) => {
                setProblems({});
                setAdded((a) => a.filter((_, j) => j !== i));
              }}
            />
          )}
        </div>
      </div>

      {/* ---------------------------------------------------------------- the change bar */}
      {result && dirty && (
        <div className="sticky bottom-3 z-30 mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-bg/95 p-3 shadow-lg backdrop-blur">
          <p className="min-w-0 flex-1 text-sm">
            <span className="font-semibold">
              {editedRows > 0 && `${editedRows} row${editedRows === 1 ? "" : "s"} changed`}
              {editedRows > 0 && added.length > 0 && " · "}
              {added.length > 0 && `${added.length} new row${added.length === 1 ? "" : "s"}`}
            </span>
            <span className="text-muted"> → {result.target_label}</span>
            {overLimit && (
              <span className="block text-xs text-bad">
                That&apos;s more than the {result.max_changes} rows Data Studio sends at once. Export to My files and load the file
                instead.
              </span>
            )}
          </p>
          <button type="button" className={btn.secondary} onClick={() => confirmDiscard() && discardChanges()}>
            Discard
          </button>
          <button type="button" className={btn.primary} disabled={overLimit} onClick={() => setReviewing(true)}>
            Review &amp; submit
          </button>
        </div>
      )}

      {exporting && (
        <ExportDialog
          query={{ target_type: source, database: database || null, sql: ranSql || sql }}
          suggested={`${(tables ?? []).find((t) => t.target_id === (picked ?? result?.target_id))?.table ?? "query"}-export`}
          onClose={() => setExporting(false)}
          onSaved={(out) => {
            setExporting(false);
            setExported(out);
          }}
        />
      )}

      {reviewing && result && target && (
        <ReviewDialog
          result={result}
          target={target}
          sql={ranSql}
          edits={edits}
          added={added}
          justification={justification}
          onJustification={setJustification}
          onReport={markProblems}
          onClose={() => setReviewing(false)}
          onFiled={(r) => {
            setReviewing(false);
            discardChanges();
            setJustification("");
            setFiled(r);
            notifyPendingChanged();
          }}
          onConflict={(message) => {
            setReviewing(false);
            setNotice(message);
          }}
        />
      )}
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 pb-10 lg:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 pb-4 pt-4">
        <div>
          <h1 className="text-2xl">Data Studio</h1>
          <p className="mt-1 text-sm text-muted">Query onboarded tables and make small, approved edits in place.</p>
        </div>
        <p className="flex max-w-md items-start gap-2 rounded-xl bg-surface px-3 py-2 text-xs text-muted">
          <InfoIcon width={15} height={15} className="mt-0.5 shrink-0 text-brand" />
          <span>
            For a handful of changes. Editing many rows? <span className="font-medium text-fg">Export to My files</span>, edit
            the file there and load it with Load to table.
          </span>
        </p>
      </div>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ the grid
function ResultGrid({
  result,
  edits,
  added,
  canEdit,
  canAdd,
  editing,
  onEditing,
  onCell,
  onRevert,
  problems,
  onAddRow,
  onAddedCell,
  onRemoveAdded,
}: {
  result: StudioResult;
  edits: Record<number, RowEdits>;
  added: Record<string, Cell>[];
  canEdit: boolean;
  canAdd: boolean;
  editing: boolean;
  onEditing: (on: boolean) => void;
  problems: Record<string, string>;
  onCell: (row: number, column: string, value: string) => void;
  onRevert: (row: number) => void;
  onAddRow: () => void;
  onAddedCell: (row: number, column: string, value: string) => void;
  onRemoveAdded: (row: number) => void;
}) {
  const numeric = (type: string | null) => /int|numeric|decimal|float|double|real/i.test(type ?? "");
  const stats = [
    `${result.rows.length.toLocaleString()} row${result.rows.length === 1 ? "" : "s"}${result.truncated ? ` (first ${result.row_limit.toLocaleString()})` : ""}`,
    `${result.elapsed_ms.toLocaleString()} ms`,
    result.bytes_processed ? `${humanSize(result.bytes_processed)} scanned` : "",
  ].filter(Boolean);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {result.target_label && <span className="font-medium">{result.target_label}</span>}
        <span className="text-xs text-muted tabular">{stats.join(" · ")}</span>
        <EditSwitch
          on={editing}
          onChange={onEditing}
          disabled={!result.edit_mode}
          label={result.edit_mode === "append" ? "Add rows" : "Edit"}
          title={result.edit_reason ?? undefined}
        />
      </div>

      <div className="max-h-[calc(100vh-24rem)] min-h-40 overflow-auto rounded-xl border border-line">
        <table className="border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 w-12 border-b border-r border-line bg-surface px-2 py-2 text-xs font-semibold text-muted">
                #
              </th>
              {result.columns.map((c) => (
                <th
                  key={c.name}
                  className="sticky top-0 z-20 min-w-36 max-w-80 border-b border-r border-line bg-surface px-3 py-1.5 text-left"
                >
                  <span className="flex items-center gap-1 font-semibold">
                    {c.key && <KeyIcon width={13} height={13} className="shrink-0 text-brand" aria-label="key" />}
                    <span className="truncate">{c.name}</span>
                  </span>
                  {c.type && <span className="block text-[11px] font-normal text-muted">{c.type}</span>}
                </th>
              ))}
              <th className="sticky top-0 z-20 w-10 border-b border-line bg-surface" aria-label="Row actions" />
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, ri) => {
              const rowEdits = edits[ri];
              return (
                <tr key={ri} className="group/row odd:bg-bg even:bg-surface/40">
                  <td
                    className={`sticky left-0 z-10 border-b border-r border-line px-2 text-center text-xs tabular ${
                      rowEdits ? "bg-warn/20 font-semibold text-warn" : "bg-surface text-muted"
                    }`}
                  >
                    {ri + 1}
                  </td>
                  {result.columns.map((c, ci) => {
                    const original = row[ci];
                    const changed = rowEdits && c.name in rowEdits;
                    const value = changed ? rowEdits[c.name] : original;
                    const editable = canEdit && !nested(c.type);
                    const problem = problems[`e:${ri}:${c.name}`];
                    return (
                      <td
                        key={c.name}
                        className={`border-b border-r border-line p-0 ${
                          problem ? "bg-bad/10 ring-2 ring-inset ring-bad" : changed ? "bg-warn/15" : ""
                        }`}
                        title={problem ?? (changed ? `was: ${original ?? "NULL"}` : undefined)}
                      >
                        {editable ? (
                          <input
                            value={value ?? ""}
                            placeholder={value === null ? "NULL" : undefined}
                            onChange={(e) => onCell(ri, c.name, e.target.value)}
                            aria-label={`${c.name}, row ${ri + 1}`}
                            className={`h-8 w-full min-w-36 cursor-text bg-transparent px-3 outline-none placeholder:italic placeholder:text-muted/60 hover:bg-brand/5 focus:bg-bg focus:ring-2 focus:ring-inset focus:ring-brand ${
                              numeric(c.type) ? "text-right tabular" : ""
                            } ${changed ? "font-medium" : ""}`}
                          />
                        ) : (
                          <span
                            className={`block h-8 max-w-80 truncate px-3 leading-8 ${numeric(c.type) ? "text-right tabular" : ""} ${
                              original === null ? "italic text-muted/60" : ""
                            }`}
                          >
                            {original ?? "NULL"}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="border-b border-line p-0 text-center">
                    {rowEdits && (
                      <button
                        type="button"
                        onClick={() => onRevert(ri)}
                        aria-label={`Undo changes to row ${ri + 1}`}
                        title="Undo this row's changes"
                        className="mx-auto flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-hover hover:text-fg"
                      >
                        <UndoIcon width={14} height={14} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {added.map((row, ai) => (
              <tr key={`new-${ai}`} className="bg-ok/10">
                <td className="sticky left-0 z-10 border-b border-r border-line bg-ok/20 px-2 text-center text-[10px] font-semibold uppercase text-ok">
                  new
                </td>
                {result.columns.map((c) => (
                  <td
                    key={c.name}
                    className={`border-b border-r border-line p-0 ${problems[`a:${ai}:${c.name}`] ? "bg-bad/10 ring-2 ring-inset ring-bad" : ""}`}
                    title={problems[`a:${ai}:${c.name}`]}
                  >
                    <input
                      value={row[c.name] ?? ""}
                      disabled={nested(c.type)}
                      placeholder={nested(c.type) ? "—" : undefined}
                      onChange={(e) => onAddedCell(ai, c.name, e.target.value)}
                      aria-label={`${c.name}, new row ${ai + 1}`}
                      className={`h-8 w-full min-w-36 bg-transparent px-3 outline-none placeholder:text-muted/60 focus:bg-bg focus:ring-2 focus:ring-inset focus:ring-brand ${
                        numeric(c.type) ? "text-right tabular" : ""
                      }`}
                    />
                  </td>
                ))}
                <td className="border-b border-line p-0 text-center">
                  <button
                    type="button"
                    onClick={() => onRemoveAdded(ai)}
                    aria-label={`Remove new row ${ai + 1}`}
                    className="mx-auto flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-bad/10 hover:text-bad"
                  >
                    <TrashIcon width={14} height={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {result.rows.length === 0 && added.length === 0 && (
          <p className="p-6 text-center text-sm text-muted">The query returned no rows.</p>
        )}
      </div>
      {canAdd && (
        <div>
          <button type="button" className={btn.quiet} onClick={onAddRow}>
            <PlusIcon width={16} height={16} /> Add a row
          </button>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ review + submit
type Diff = { label: string; cells: { column: string; before: Cell; after: Cell }[] };

function ReviewDialog({
  result,
  target,
  sql,
  edits,
  added,
  justification,
  onJustification,
  onReport,
  onClose,
  onFiled,
  onConflict,
}: {
  result: StudioResult;
  target: Target;
  sql: string;
  edits: Record<number, RowEdits>;
  added: Record<string, Cell>[];
  justification: string;
  onJustification: (text: string) => void;
  onReport: (report: ValidationReport) => void;
  onClose: () => void;
  onFiled: (r: UploadRequest) => void;
  onConflict: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [waiting, setWaiting] = useState<UploadRequest[]>([]);
  const outcome = useRef<HTMLDivElement>(null);

  // a failed check is the thing to read next: bring it into view
  useEffect(() => {
    if (report || error) outcome.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [report, error]);

  const col = (name: string) => result.columns.findIndex((c) => c.name === name);
  // a row is named by the table's key when the query returned it, else by its number
  const keys = result.key_columns.filter((k) => col(k) >= 0);
  const editList = Object.entries(edits).map(([i, cells]) => {
    const row = result.rows[Number(i)];
    // the row as the query showed it: how the table finds it again
    const match = Object.fromEntries(result.columns.map((c, ci) => [c.name, row[ci]]));
    return { index: Number(i), match, row, cells };
  });
  const diffs: Diff[] = editList.map(({ index, row, cells }) => ({
    label: keys.length ? keys.map((k) => `${k} ${row[col(k)] ?? "NULL"}`).join(", ") : `Row ${index + 1}`,
    cells: Object.entries(cells).map(([column, after]) => ({ column, before: row[col(column)], after })),
  }));
  // the submitted rows are the edited ones, then the new ones: name report rows the same way
  const rowLabel = (i: number) =>
    i < diffs.length ? diffs[i].label : `new row ${i - diffs.length + 1}`;

  useEffect(() => {
    if (!result.target_id) return;
    const q = new URLSearchParams({ scope: "all", status: "pending", target_id: result.target_id });
    api<UploadRequest[]>(`/requests?${q}`)
      .then(setWaiting)
      .catch(() => {});
  }, [result.target_id]);

  async function submit() {
    setBusy(true);
    setError("");
    setReport(null);
    try {
      const request = await api<UploadRequest>("/studio/submit", {
        method: "POST",
        json: {
          target_id: result.target_id,
          sql,
          columns: result.columns.map((c) => c.name),
          edits: editList.map(({ match, row, cells }) => ({
            match,
            changes: Object.fromEntries(Object.entries(cells).map(([c, after]) => [c, { from: row[col(c)], to: after }])),
          })),
          added: added.map((r) => Object.fromEntries(Object.entries(r).map(([c, v]) => [c, v === "" ? null : v]))),
          justification: justification.trim() || null,
        },
      });
      onFiled(request);
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as UploadRequest | null) : null;
      if (body?.validation_report) {
        setReport(body.validation_report);
        onReport(body.validation_report);
      } else if (err instanceof ApiError && err.status === 409) onConflict(errorText(err));
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const hasContract = Boolean(target.contract_version);
  return (
    <Dialog title={`Send changes to ${target.label}`} onClose={onClose} wide="xl">
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1 [&>*]:shrink-0">
        {waiting.length > 0 && (
          <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">
            <p className="font-medium">
              {waiting.length} request{waiting.length === 1 ? " is" : "s are"} already waiting for this table
            </p>
            <ul className="mt-1 flex flex-col gap-0.5 text-xs">
              {waiting.map((w) => (
                <li key={w.id}>
                  <Link href={`/requests/${w.id}`} className="hover:underline" target="_blank">
                    <span className="font-medium">{w.is_mine ? "You" : w.user_name}</span>
                    <span className="text-muted">
                      {" "}
                      · {w.origin === "studio" ? `Data Studio (${studioChanges(w.change_summary)})` : w.file_name} ·{" "}
                      {timeAgo(w.created_at)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        <ChangeList diffs={diffs} added={added} columns={result.columns.map((c) => c.name)} />

        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Why are you making these changes?
          <textarea
            value={justification}
            onChange={(e) => onJustification(e.target.value)}
            placeholder="Correcting the March quantities reported by the warehouse"
            className={`${inputClass} h-20 py-2 font-normal`}
          />
          <span className="text-xs font-normal text-muted">The approving admin sees this.</span>
        </label>

        <details className="rounded-xl border border-line">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">
            {hasContract ? `Data contract v${target.contract_version}` : "No data contract: schema checks only"}
          </summary>
          <div className="p-3 pt-0">
            <ContractSummary contract={target.contract} columns={target.columns} version={target.contract_version} />
          </div>
        </details>

        {(busy || report) && (
          <div ref={outcome} className="scroll-mt-2 overflow-x-auto rounded-xl border border-line p-4">
            <LoadFlow stages={stagesForSubmit(busy ? "checking" : "failed", hasContract, report, rowLabel)} />
          </div>
        )}
        {report && !busy && (
          <ValidationReportView
            report={report}
            title="These changes don't pass — nothing was sent for approval"
            hint="Go back to the grid: the cells to fix are outlined in red."
            rowLabel={rowLabel}
          />
        )}
        {error && (
          <div ref={report ? undefined : outcome}>
            <Alert>{error}</Alert>
          </div>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
        <p className="mr-auto text-xs text-muted">Nothing is written until an admin approves.</p>
        <button type="button" className={btn.secondary} onClick={onClose}>
          Back to the grid
        </button>
        <button type="button" className={btn.primary} onClick={submit} disabled={busy}>
          {busy ? (
            <>
              <SpinnerIcon /> Checking…
            </>
          ) : hasContract ? (
            "Check contract & request approval"
          ) : (
            "Validate & request approval"
          )}
        </button>
      </div>
    </Dialog>
  );
}

/** Each change as before → after, and each new row: what the approver will see too. */
export function ChangeList({
  diffs,
  added,
  columns,
}: {
  diffs: Diff[];
  added: Record<string, Cell>[];
  columns: string[];
}) {
  const show = (v: Cell) => (v === null || v === "" ? <span className="italic text-muted">NULL</span> : v);
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <table className="w-full text-sm">
        <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 font-semibold">Row</th>
            <th className="px-3 py-2 font-semibold">Column</th>
            <th className="px-3 py-2 font-semibold">Before</th>
            <th className="px-3 py-2 font-semibold">After</th>
          </tr>
        </thead>
        <tbody>
          {diffs.flatMap((d) =>
            d.cells.map((c, i) => (
              <tr key={`${d.label}-${c.column}`} className="border-t border-line">
                <td className="px-3 py-1.5 font-medium">{i === 0 ? d.label : ""}</td>
                <td className="px-3 py-1.5">{c.column}</td>
                <td className="px-3 py-1.5 text-bad line-through decoration-bad/40">{show(c.before)}</td>
                <td className="px-3 py-1.5 font-medium text-ok">{show(c.after)}</td>
              </tr>
            )),
          )}
          {added.map((r, i) => (
            <tr key={`new-${i}`} className="border-t border-line bg-ok/5">
              <td className="px-3 py-1.5 font-medium text-ok">New row</td>
              <td className="px-3 py-1.5 text-muted" colSpan={3}>
                {columns
                  .filter((c) => r[c] != null && r[c] !== "")
                  .map((c) => (
                    <span key={c} className="mr-3 inline-block">
                      <span className="text-xs">{c}</span> <span className="font-medium text-fg">{r[c]}</span>
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

/** Changes a request carries, as the request detail page shows them. */
export function StudioChanges({ request }: { request: UploadRequest }) {
  const s = request.change_summary;
  if (!s) return null;
  const diffs: Diff[] = (s.changes ?? []).map((c) => ({
    label:
      Object.entries(c.label ?? c.key ?? {})
        .map(([k, v]) => `${k} ${v ?? "NULL"}`)
        .join(", ") + (c.rows && c.rows > 1 ? ` (${c.rows} identical rows)` : ""),
    cells: Object.entries(c.cells).map(([column, [before, after]]) => ({ column, before, after })),
  }));
  return <ChangeList diffs={diffs} added={s.added_rows ?? []} columns={s.columns} />;
}

// ------------------------------------------------------------------ after sending
function StudioFiled({
  request,
  onUpdate,
  onKeepEditing,
}: {
  request: UploadRequest;
  onUpdate: (r: UploadRequest) => void;
  onKeepEditing: () => void;
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
  const title =
    request.status === "pending" ? "Sent — waiting for an admin to approve" : request.status === "completed" ? "Changes applied" : flowSummary(stages).text;
  return (
    <div className="max-w-5xl rounded-2xl border border-line p-5">
      <h2 className="display text-xl">{title}</h2>
      <p className="mt-1 text-sm text-muted">
        {studioChanges(request.change_summary)} → <span className="font-medium text-fg">{request.target_label}</span>
        {request.status === "pending" && " · checked again against the contract when an admin approves, then written"}
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
        <button type="button" className={btn.secondary} onClick={onKeepEditing}>
          Back to Data Studio
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ export
const NEW_FOLDER = "__new__";

/** Save a query's result as a CSV: the person names the file and picks the folder. */
function ExportDialog({
  query,
  suggested,
  onClose,
  onSaved,
}: {
  query: { target_type: Source; database: string | null; sql: string };
  suggested: string;
  onClose: () => void;
  onSaved: (out: { file: WsFile; truncated: boolean; folder: string }) => void;
}) {
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [folderId, setFolderId] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [name, setName] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; field?: string } | null>(null);

  useEffect(() => {
    api<Folder[]>("/workspace/folders")
      .then(setFolders)
      .catch(() => setFolders([]));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    const fileName = name.trim();
    if (!fileName) return setError({ text: "Give the file a name", field: "name" });
    if (folderId === NEW_FOLDER && !newFolder.trim()) return setError({ text: "Name the new folder", field: "folder" });
    setBusy(true);
    setError(null);
    try {
      let target = folders?.find((f) => f.id === folderId) ?? null;
      if (folderId === NEW_FOLDER) {
        try {
          target = await api<Folder>("/workspace/folders", { method: "POST", json: { name: newFolder.trim(), parent_id: null } });
        } catch (err) {
          setError({ text: errorText(err), field: "folder" });
          return;
        }
        // a retry shouldn't try to make it again
        setFolders((list) => [...(list ?? []), target!]);
        setFolderId(target.id);
      }
      const out = await api<{ file: WsFile; truncated: boolean }>("/studio/export", {
        method: "POST",
        json: { ...query, name: fileName, folder_id: target?.id ?? null },
      });
      onSaved({ ...out, folder: target ? `My files › ${target.path.replaceAll("/", " › ")}` : "My files" });
    } catch (err) {
      const field = err instanceof ApiError ? err.field : undefined;
      setError({ text: errorText(err), field: field ?? undefined });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Export to My files" onClose={onClose}>
      <form onSubmit={save} className="flex flex-col gap-4">
        <p className="-mt-2 text-sm text-muted">
          The whole result of the query is saved as a CSV (up to the file row limit). Edit it there, then load it with Load to
          table.
        </p>
        <Field
          label="File name"
          value={name}
          onChange={setName}
          hint=".csv is added if you leave it out"
          error={error?.field === "name" ? error.text : undefined}
          autoFocus
        />
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Save in
          <select
            className={`${inputClass} font-normal`}
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            disabled={!folders}
          >
            <option value="">My files (top level)</option>
            {(folders ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.path.replaceAll("/", " › ")}
              </option>
            ))}
            <option value={NEW_FOLDER}>+ New folder…</option>
          </select>
        </label>
        {folderId === NEW_FOLDER && (
          <Field
            label="New folder name"
            value={newFolder}
            onChange={setNewFolder}
            error={error?.field === "folder" ? error.text : undefined}
          />
        )}
        {error && error.field !== "name" && error.field !== "folder" && <Alert>{error.text}</Alert>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.secondary} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={btn.primary} disabled={busy}>
            {busy ? <SpinnerIcon /> : <DownloadIcon width={16} height={16} />}
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The Edit switch above the grid: off, every cell is read-only. */
function EditSwitch({
  on,
  onChange,
  disabled,
  label,
  title,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled: boolean;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      title={disabled ? title : undefined}
      onClick={() => onChange(!on)}
      className="ml-auto inline-flex items-center gap-2 rounded-full px-1 py-1 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${on ? "bg-brand" : "bg-line"}`}
      >
        <span
          className={`absolute h-4 w-4 rounded-full bg-bg shadow transition-transform ${on ? "translate-x-[18px]" : "translate-x-0.5"}`}
        />
      </span>
    </button>
  );
}
