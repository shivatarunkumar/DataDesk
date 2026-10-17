"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, errorText } from "@/lib/api";
import type { Folder, WsFile } from "@/lib/types";
import { uploadWithProgress } from "./FileBrowser";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, SpinnerIcon, UploadIcon } from "./icons";
import { FilePicker, useMyFiles } from "./MyFilePicker";
import { Alert, btn, inputClass } from "./ui";

type SheetInfo = { name: string; rows: number; columns: number; preview: string[][] };
type Workbook = { file_id: string; workbook: string; folder_id: string | null; sheets: SheetInfo[] };
type Converted = { files: WsFile[]; renamed: string[] };

const DELIMITERS = [
  { value: "comma", label: "Comma ( , )" },
  { value: "tab", label: "Tab" },
  { value: "semicolon", label: "Semicolon ( ; )" },
  { value: "pipe", label: "Pipe ( | )" },
] as const;

const stem = (name: string) => name.replace(/\.[^.]+$/, "");

/** Excel → CSV: one CSV per chosen sheet, saved in a folder of My files. */
export function Convertor() {
  const [source, setSource] = useState<"new" | "existing">("new");
  const [file, setFile] = useState<WsFile | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [book, setBook] = useState<Workbook | null>(null);
  const [reading, setReading] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [naming, setNaming] = useState<"sheet" | "workbook">("sheet");
  const [delimiter, setDelimiter] = useState<(typeof DELIMITERS)[number]["value"]>("comma");
  const [folderId, setFolderId] = useState<string>("");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Converted | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const isExcel = (f: WsFile) => f.format === "xlsx";
  const { groups, folders, reload, error: filesError } = useMyFiles(true, isExcel);
  useEffect(() => {
    if (filesError) setError(filesError);
  }, [filesError]);

  // a workbook chosen: read its sheets; every sheet ticked, named after itself
  useEffect(() => {
    setBook(null);
    setDone(null);
    if (!file) return;
    setReading(true);
    setError("");
    api<Workbook>(`/convertor/files/${file.id}/sheets`)
      .then((b) => {
        setBook(b);
        setPicked(Object.fromEntries(b.sheets.map((s) => [s.name, true])));
        setFolderId(b.folder_id ?? "");
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setReading(false));
  }, [file]);

  // one sheet: the CSV is named after the workbook, no questions asked; several: after each
  // sheet (or workbook + sheet), until someone types their own
  useEffect(() => {
    if (!book) return;
    const base = stem(book.workbook);
    if (book.sheets.length === 1) {
      setNames({ [book.sheets[0].name]: base });
      return;
    }
    setNames(Object.fromEntries(book.sheets.map((s) => [s.name, naming === "sheet" ? s.name : `${base} - ${s.name}`])));
  }, [book, naming]);
  const single = book?.sheets.length === 1;

  async function onPick(list: FileList | null) {
    const chosen = list?.[0];
    if (!chosen) return;
    if (!chosen.name.toLowerCase().endsWith(".xlsx")) {
      setError(
        chosen.name.toLowerCase().endsWith(".xls")
          ? "Old .xls files aren't supported: open it in Excel and save it as .xlsx."
          : "Choose an Excel workbook (.xlsx).",
      );
      return;
    }
    setError("");
    setProgress(0);
    try {
      const folder = await api<Folder>("/convertor/folder", { method: "POST" });
      setFile(await uploadWithProgress(chosen, folder.id, setProgress));
      reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
      if (picker.current) picker.current.value = "";
    }
  }

  async function newFolder() {
    const name = window.prompt("New folder name");
    if (!name?.trim()) return;
    try {
      const made = await api<Folder>("/workspace/folders", {
        method: "POST",
        json: { name: name.trim(), parent_id: folderId || null },
      });
      reload();
      setFolderId(made.id);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function convert() {
    if (!book) return;
    const sheets = book.sheets.filter((s) => picked[s.name]).map((s) => ({ sheet: s.name, name: names[s.name] ?? s.name }));
    setBusy(true);
    setError("");
    try {
      setDone(
        await api<Converted>("/convertor/convert", {
          method: "POST",
          json: { file_id: book.file_id, sheets, delimiter, folder_id: folderId || null },
        }),
      );
      reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const chosenCount = book ? book.sheets.filter((s) => picked[s.name]).length : 0;
  const folderLabel = (id: string) => {
    const path = folders.find((f) => f.id === id)?.path;
    return path ? `My files › ${path.replaceAll("/", " › ")}` : "My files (top level)";
  };

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      {error && <Alert>{error}</Alert>}

      {/* the workbook */}
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Excel file</legend>
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
                if (value === "existing") reload();
              }}
              className={`rounded-full px-4 py-1.5 text-sm font-medium ${
                source === value ? "bg-chip-active text-chip-active-text" : "text-muted hover:text-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-3 max-w-xl">
          {source === "new" ? (
            <>
              <input
                ref={picker}
                type="file"
                accept=".xlsx"
                className="sr-only"
                id="convertor-input"
                onChange={(e) => onPick(e.target.files)}
              />
              <label
                htmlFor="convertor-input"
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
                    <span className="font-medium">Drop an Excel file (.xlsx), or click to choose</span>
                    <span className="text-xs text-muted">Saved to My files › Convertor</span>
                  </>
                )}
              </label>
            </>
          ) : (
            <FilePicker groups={groups.filter((g) => g.files.length > 0)} loading={false} value={file} onChange={setFile} />
          )}
          {file && (
            <p className="mt-2 flex items-center gap-2 text-sm">
              <CheckIcon width={16} height={16} className="text-ok" />
              <span className="font-medium">{file.original_name}</span>
            </p>
          )}
        </div>
      </fieldset>

      {reading && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <SpinnerIcon /> Reading the sheets…
        </p>
      )}

      {book && !done && (
        <>
          {single && (
            <p className="-mt-2 text-sm text-muted">
              Saves as <span className="font-medium text-fg">{names[book.sheets[0].name]}.csv</span>
            </p>
          )}
          {/* the sheets: only asked about when there are several */}
          {!single && (
          <fieldset>
            <legend className="mb-2 flex w-full items-center justify-between text-sm font-medium">
              <span>
                Sheets <span className="font-normal text-muted">({chosenCount} of {book.sheets.length})</span>
              </span>
              <span className="inline-flex rounded-full bg-surface p-1 text-xs">
                {(
                  [
                    ["sheet", "Sheet name"],
                    ["workbook", "Workbook + sheet"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setNaming(value)}
                    className={`rounded-full px-3 py-1 font-medium ${
                      naming === value ? "bg-chip-active text-chip-active-text" : "text-muted hover:text-fg"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </legend>
            <ul className="overflow-hidden rounded-xl border border-line">
              {book.sheets.map((s) => (
                <li key={s.name} className="border-t border-line first:border-t-0">
                  <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--brand)]"
                      checked={Boolean(picked[s.name])}
                      onChange={(e) => setPicked((p) => ({ ...p, [s.name]: e.target.checked }))}
                      aria-label={`Convert ${s.name}`}
                    />
                    <button
                      type="button"
                      onClick={() => setOpen((o) => (o === s.name ? null : s.name))}
                      className="flex min-w-40 items-center gap-1.5 text-left text-sm font-medium"
                      aria-expanded={open === s.name}
                    >
                      {open === s.name ? <ChevronDownIcon width={14} height={14} /> : <ChevronRightIcon width={14} height={14} />}
                      {s.name}
                      <span className="text-xs font-normal text-muted">
                        {s.rows.toLocaleString()} rows · {s.columns} cols
                      </span>
                    </button>
                    <label className="ml-auto flex min-w-56 flex-1 items-center gap-2 text-xs text-muted">
                      Save as
                      <input
                        className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm text-fg outline-none focus:border-brand"
                        value={names[s.name] ?? ""}
                        disabled={!picked[s.name]}
                        onChange={(e) => setNames((n) => ({ ...n, [s.name]: e.target.value }))}
                        aria-label={`File name for ${s.name}`}
                      />
                      <span>.csv</span>
                    </label>
                  </div>
                  {open === s.name && (
                    <div className="overflow-x-auto border-t border-line bg-surface px-4 py-2">
                      {s.preview.length === 0 ? (
                        <p className="text-xs text-muted">Empty sheet.</p>
                      ) : (
                        <table className="text-xs">
                          <tbody>
                            {s.preview.map((row, i) => (
                              <tr key={i} className={i === 0 ? "font-semibold" : "text-muted"}>
                                {row.map((c, j) => (
                                  <td key={j} className="max-w-48 truncate whitespace-nowrap py-0.5 pr-4">
                                    {c}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </fieldset>
          )}

          {/* options */}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Delimiter
              <select
                className={`${inputClass} font-normal`}
                value={delimiter}
                onChange={(e) => setDelimiter(e.target.value as typeof delimiter)}
              >
                {DELIMITERS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-1.5 text-sm font-medium">
              <span className="flex items-baseline justify-between">
                Save to
                <button type="button" onClick={newFolder} className="text-xs font-medium text-brand hover:underline">
                  New folder
                </button>
              </span>
              <select
                className={`${inputClass} font-normal`}
                value={folderId}
                onChange={(e) => setFolderId(e.target.value)}
                aria-label="Folder to save the CSV files in"
              >
                <option value="">My files (top level)</option>
                {[...folders]
                  .sort((a, b) => a.path.localeCompare(b.path))
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.path.replaceAll("/", " › ")}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <div>
            <button
              type="button"
              className={btn.primary}
              disabled={busy || chosenCount === 0 || book.sheets.some((s) => picked[s.name] && !(names[s.name] ?? "").trim())}
              onClick={convert}
            >
              {busy ? <SpinnerIcon /> : null}
              {single ? "Convert to CSV" : `Convert ${chosenCount} sheet${chosenCount === 1 ? "" : "s"} to CSV`}
            </button>
          </div>
        </>
      )}

      {done && (
        <div className="rounded-2xl border border-ok/40 bg-ok/5 p-5">
          <h2 className="flex items-center gap-2 font-semibold text-ok">
            <CheckIcon width={18} height={18} />
            {done.files.length} CSV file{done.files.length === 1 ? "" : "s"} saved in {folderLabel(folderId)}
          </h2>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {done.files.map((f) => (
              <li key={f.id}>
                <Link href={`/files/${f.id}`} className="font-medium text-brand hover:underline">
                  {f.original_name}
                </Link>{" "}
                <span className="text-muted">· {f.row_count?.toLocaleString() ?? "?"} rows</span>
              </li>
            ))}
          </ul>
          {done.renamed.length > 0 && (
            <p className="mt-2 text-xs text-muted">Renamed because the name was taken: {done.renamed.join(", ")}</p>
          )}
          <div className="mt-4 flex gap-2">
            <button type="button" className={btn.secondary} onClick={() => setDone(null)}>
              Convert again
            </button>
            <button
              type="button"
              className={btn.secondary}
              onClick={() => {
                setFile(null);
                setDone(null);
              }}
            >
              Another file
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
