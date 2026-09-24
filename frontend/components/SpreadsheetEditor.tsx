"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import { api, errorText } from "@/lib/api";
import type { FileContent, WsFile } from "@/lib/types";
import { ExpandIcon, PlusIcon, SaveIcon, SpinnerIcon, TrashIcon } from "./icons";
import { Alert, Dialog, Field, btn, inputClass } from "./ui";

type Row = Record<string, string | null>;
type Delim = "auto" | "comma" | "tab" | "semicolon" | "pipe" | "custom";

const COL_MIN = 110;
const COL_MAX = 340;
const CHAR_W = 7.5; // rough px per character at 13px
const PAGE = 500; // rows rendered at once; the rest on "Show more"
const DELIM_NAMES: Record<string, string> = { ",": "comma", "\t": "tab", ";": "semicolon", "|": "pipe" };

export function SpreadsheetEditor({
  file,
  onSaved,
  onDirtyChange,
}: {
  file: WsFile;
  onSaved: (file: WsFile) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const isDelimited = file.format === "csv";
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [dirty, setDirtyState] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [headerEdit, setHeaderEdit] = useState<{ idx: number; value: string } | null>(null);
  const [cellEdit, setCellEdit] = useState<{ ri: number; col: string; value: string } | null>(null);
  const [delimMode, setDelimMode] = useState<Delim>("auto");
  const [customDelim, setCustomDelim] = useState("");
  const [usedDelim, setUsedDelim] = useState<string | null>(null);

  const setDirty = (value: boolean) => {
    setDirtyState(value);
    onDirtyChange(value);
  };

  const delimParam = delimMode === "auto" ? undefined : delimMode === "custom" ? customDelim || undefined : delimMode;

  useEffect(() => {
    let active = true;
    setLoading(true);
    const qs = isDelimited && delimParam ? `?delimiter=${encodeURIComponent(delimParam)}` : "";
    api<FileContent>(`/workspace/files/${file.id}/content${qs}`)
      .then((c) => {
        if (!active) return;
        setColumns(c.columns);
        setRows(c.rows);
        setUsedDelim(c.delimiter);
        setError("");
      })
      .catch((e) => active && setError(errorText(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [file.id, isDelimited, delimParam]);

  // warn before closing the tab with unsaved edits
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Content-aware widths: fit the longest of the header and a sample of values, clamped
  // so one huge value doesn't blow out the layout (it gets the expand dialog instead).
  const autoWidths = useMemo(() => {
    const sample = rows.slice(0, 60);
    const out: Record<string, number> = {};
    for (const c of columns) {
      let longest = c.length;
      for (const r of sample) longest = Math.max(longest, r[c] == null ? 0 : String(r[c]).length);
      out[c] = Math.max(COL_MIN, Math.min(COL_MAX, longest * CHAR_W + 28));
    }
    return out;
  }, [columns, rows]);

  // Numeric columns are right-aligned, spreadsheet-style, so values compare at a glance.
  const numeric = useMemo(() => {
    const set = new Set<string>();
    for (const c of columns) {
      let seen = false;
      let all = true;
      for (const r of rows.slice(0, 60)) {
        const v = r[c];
        if (v == null || String(v).trim() === "") continue;
        seen = true;
        if (Number.isNaN(Number(String(v).replace(/,/g, "")))) {
          all = false;
          break;
        }
      }
      if (seen && all) set.add(c);
    }
    return set;
  }, [columns, rows]);

  const widthOf = (c: string) => widths[c] ?? autoWidths[c] ?? COL_MIN;

  function setCell(ri: number, col: string, value: string) {
    setRows((prev) => {
      const next = [...prev];
      next[ri] = { ...next[ri], [col]: value };
      return next;
    });
    setDirty(true);
  }

  function addRow() {
    setRows((prev) => [...prev, Object.fromEntries(columns.map((c) => [c, ""]))]);
    setShown((s) => Math.max(s, rows.length + 1));
    setDirty(true);
  }

  function addColumn() {
    let n = columns.length + 1;
    while (columns.includes(`column_${n}`)) n++;
    const name = `column_${n}`;
    setColumns((prev) => [...prev, name]);
    setRows((prev) => prev.map((r) => ({ ...r, [name]: "" })));
    setDirty(true);
    setHeaderEdit({ idx: columns.length, value: name });
  }

  function deleteRow(ri: number) {
    setRows((prev) => prev.filter((_, i) => i !== ri));
    setDirty(true);
  }

  function applyHeaderEdit(e?: FormEvent) {
    e?.preventDefault();
    if (!headerEdit) return;
    const name = headerEdit.value.trim();
    const old = columns[headerEdit.idx];
    if (!name || name === old) return setHeaderEdit(null);
    if (columns.includes(name)) return; // the dialog shows why
    setColumns((prev) => prev.map((c, i) => (i === headerEdit.idx ? name : c)));
    setRows((prev) =>
      prev.map((r) => {
        const { [old]: value, ...rest } = r;
        return { ...rest, [name]: value ?? null };
      }),
    );
    setWidths((w) => (w[old] ? { ...w, [name]: w[old] } : w));
    setHeaderEdit(null);
    setDirty(true);
  }

  // Excel-style drag on a header's right edge to resize the column.
  function startResize(col: string, startX: number) {
    const startW = widthOf(col);
    const onMove = (ev: MouseEvent) => setWidths((w) => ({ ...w, [col]: Math.max(60, Math.round(startW + ev.clientX - startX)) }));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  async function save(note: string) {
    setSaveOpen(false);
    setSaved("");
    try {
      const updated = await api<WsFile>(`/workspace/files/${file.id}/content`, {
        method: "PUT",
        json: {
          columns,
          rows,
          note: note.trim() || null,
          // keep the file's own delimiter, so a TSV stays tab-separated
          delimiter: isDelimited ? (usedDelim ?? undefined) : undefined,
        },
      });
      setDirty(false);
      setSaved(`Saved as version ${updated.current_version}`);
      onSaved(updated);
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (loading)
    return (
      <p className="flex items-center gap-2 py-10 text-sm text-muted">
        <SpinnerIcon /> Loading the data…
      </p>
    );

  const detected = usedDelim ? (DELIM_NAMES[usedDelim] ?? `“${usedDelim}”`) : null;
  const tableWidth = 56 + columns.reduce((sum, c) => sum + widthOf(c), 0) + 44;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn.quiet} onClick={addRow}>
          <PlusIcon width={16} height={16} /> Row
        </button>
        <button type="button" className={btn.quiet} onClick={addColumn}>
          <PlusIcon width={16} height={16} /> Column
        </button>
        <button type="button" className={btn.primary} onClick={() => setSaveOpen(true)} disabled={!dirty}>
          <SaveIcon width={16} height={16} /> Save version
        </button>
        {dirty && <span className="text-xs font-medium text-warn">Unsaved changes</span>}
        {!dirty && saved && <span className="text-xs font-medium text-ok">{saved}</span>}

        <span className="ml-auto flex items-center gap-2">
          {isDelimited && (
            <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Delimiter
              <select
                value={delimMode}
                disabled={dirty}
                title={dirty ? "Save or discard your edits before re-reading with another delimiter" : undefined}
                onChange={(e) => setDelimMode(e.target.value as Delim)}
                className="h-8 rounded-lg border border-line bg-bg px-2 text-sm font-normal normal-case tracking-normal text-fg outline-none focus:border-brand"
              >
                <option value="auto">{detected && delimMode === "auto" ? `Auto (${detected})` : "Auto-detect"}</option>
                <option value="comma">Comma ,</option>
                <option value="tab">Tab ⇥</option>
                <option value="semicolon">Semicolon ;</option>
                <option value="pipe">Pipe |</option>
                <option value="custom">Custom…</option>
              </select>
              {delimMode === "custom" && (
                <input
                  value={customDelim}
                  onChange={(e) => setCustomDelim(e.target.value.slice(0, 1))}
                  maxLength={1}
                  aria-label="Custom delimiter"
                  className="h-8 w-10 rounded-lg border border-line bg-bg text-center text-sm text-fg outline-none focus:border-brand"
                />
              )}
            </label>
          )}
          <span className="text-xs text-muted tabular">
            {rows.length.toLocaleString()} rows · {columns.length} columns
          </span>
        </span>
      </div>

      {error && <Alert>{error}</Alert>}

      <div className="max-h-[calc(100vh-17rem)] overflow-auto rounded-xl border border-line">
        <table className="border-separate border-spacing-0 text-sm" style={{ width: tableWidth, tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: 56 }} />
            {columns.map((c) => (
              <col key={c} style={{ width: widthOf(c) }} />
            ))}
            <col style={{ width: 44 }} />
          </colgroup>
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 border-b border-r border-line bg-surface px-2 py-2 text-xs font-semibold text-muted">#</th>
              {columns.map((c, ci) => (
                <th
                  key={c}
                  className="group relative sticky top-0 z-20 border-b border-r border-line bg-surface px-3 py-2 text-left font-semibold"
                  onDoubleClick={() => setHeaderEdit({ idx: ci, value: c })}
                  title="Double-click to rename"
                >
                  <span className="block truncate">{c}</span>
                  <span
                    className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize group-hover:bg-brand/30"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      startResize(c, e.clientX);
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setWidths(({ [c]: _drop, ...rest }) => rest);
                    }}
                    title="Drag to resize · double-click to fit"
                  />
                </th>
              ))}
              <th className="sticky top-0 z-20 border-b border-line bg-surface" aria-label="Row actions" />
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((r, ri) => (
              <tr key={ri} className="group/row odd:bg-bg even:bg-surface/50">
                <td className="sticky left-0 z-10 border-b border-r border-line bg-surface px-2 text-center text-xs text-muted tabular">
                  {ri + 1}
                </td>
                {columns.map((c) => {
                  const raw = r[c] == null ? "" : String(r[c]);
                  return (
                    <td key={c} className="relative border-b border-r border-line p-0">
                      <input
                        value={raw}
                        onChange={(e) => setCell(ri, c, e.target.value)}
                        aria-label={`${c}, row ${ri + 1}`}
                        className={`h-8 w-full bg-transparent px-3 outline-none focus:bg-bg focus:ring-2 focus:ring-inset focus:ring-brand ${
                          numeric.has(c) ? "text-right tabular" : ""
                        } ${raw.length > 40 ? "pr-8" : ""}`}
                      />
                      {raw.length > 40 && (
                        <button
                          type="button"
                          className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-hover hover:text-fg"
                          onClick={() => setCellEdit({ ri, col: c, value: raw })}
                          aria-label="Edit the full value"
                        >
                          <ExpandIcon width={13} height={13} />
                        </button>
                      )}
                    </td>
                  );
                })}
                <td className="border-b border-line p-0 text-center">
                  <button
                    type="button"
                    onClick={() => deleteRow(ri)}
                    aria-label={`Delete row ${ri + 1}`}
                    className="mx-auto flex h-7 w-7 items-center justify-center rounded text-muted opacity-0 hover:bg-bad/10 hover:text-bad group-hover/row:opacity-100 focus:opacity-100"
                  >
                    <TrashIcon width={14} height={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-6 text-center text-sm text-muted">No rows yet. Use “+ Row”.</p>}
        {rows.length > shown && (
          <div className="sticky left-0 flex items-center gap-3 p-3 text-sm text-muted">
            Showing {shown.toLocaleString()} of {rows.length.toLocaleString()} rows.
            <button type="button" className={btn.secondary} onClick={() => setShown((s) => s + PAGE)}>
              Show {Math.min(PAGE, rows.length - shown)} more
            </button>
          </div>
        )}
      </div>

      {headerEdit && (
        <Dialog title="Rename column" onClose={() => setHeaderEdit(null)}>
          <form onSubmit={applyHeaderEdit} className="flex flex-col gap-4">
            <Field
              label="Column name"
              value={headerEdit.value}
              onChange={(value) => setHeaderEdit((h) => (h ? { ...h, value } : h))}
              error={
                headerEdit.value.trim() !== columns[headerEdit.idx] && columns.includes(headerEdit.value.trim())
                  ? "Another column already has that name"
                  : undefined
              }
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button type="button" className={btn.secondary} onClick={() => setHeaderEdit(null)}>
                Cancel
              </button>
              <button type="submit" className={btn.primary}>
                Rename
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {cellEdit && (
        <Dialog title={`Edit “${cellEdit.col}”`} onClose={() => setCellEdit(null)} wide>
          <p className="-mt-2 mb-3 text-xs text-muted">Row {cellEdit.ri + 1}</p>
          <textarea
            value={cellEdit.value}
            onChange={(e) => setCellEdit((c) => (c ? { ...c, value: e.target.value } : c))}
            className={`${inputClass} h-48 py-2`}
            autoFocus
          />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={btn.secondary} onClick={() => setCellEdit(null)}>
              Cancel
            </button>
            <button
              type="submit"
              className={btn.primary}
              onClick={() => {
                setCell(cellEdit.ri, cellEdit.col, cellEdit.value);
                setCellEdit(null);
              }}
            >
              Apply
            </button>
          </div>
        </Dialog>
      )}

      {saveOpen && <SaveDialog version={file.current_version + 1} onClose={() => setSaveOpen(false)} onSave={save} />}
    </div>
  );
}

function SaveDialog({ version, onClose, onSave }: { version: number; onClose: () => void; onSave: (note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <Dialog title={`Save as version ${version}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(note);
        }}
        className="flex flex-col gap-4"
      >
        <Field
          label="What changed?"
          value={note}
          onChange={setNote}
          placeholder="Fixed the March totals"
          hint="Optional. Shown in the version history."
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.secondary} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={btn.primary}>
            <SaveIcon width={16} height={16} /> Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
