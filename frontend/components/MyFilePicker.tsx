"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "@/lib/api";
import type { Folder, WsFile } from "@/lib/types";
import { CheckIcon, ChevronDownIcon, FolderIcon, SearchIcon } from "./icons";
import { inputClass } from "./ui";

/**
 * Choosing one of your own files: used by File upload and the Convertor.
 *
 * useMyFiles reads My files (and its folders) while `active`, keeping the ones `accept` lets
 * through, grouped by folder: the top of My files first, then each folder by path.
 */
export function useMyFiles(active: boolean, accept: (f: WsFile) => boolean) {
  const [files, setFiles] = useState<WsFile[] | null>(null);
  const [folders, setFolders] = useState<Record<string, string>>({});
  const [folderList, setFolderList] = useState<Folder[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active || files) return;
    Promise.all([api<WsFile[]>("/workspace/files"), api<Folder[]>("/workspace/folders")])
      .then(([all, list]) => {
        setFolders(Object.fromEntries(list.map((f) => [f.id, f.path])));
        setFolderList(list);
        setFiles(all);
      })
      .catch((e) => setError(errorText(e)));
  }, [active, files]);

  const groups = useMemo(() => {
    const byFolder = new Map<string, WsFile[]>();
    for (const f of files ?? []) {
      if (!accept(f)) continue;
      const path = f.folder_id ? (folders[f.folder_id] ?? "Other folder") : "";
      byFolder.set(path, [...(byFolder.get(path) ?? []), f]);
    }
    return [...byFolder.entries()]
      .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
      .map(([path, list]) => ({
        label: path ? path.replaceAll("/", " › ") : "My files (top level)",
        files: list.sort((x, y) => x.original_name.localeCompare(y.original_name)),
      }));
    // accept is a fresh closure each render; the filter it applies doesn't change
  }, [files, folders]);

  return { files, groups, folders: folderList, error, reload: () => setFiles(null) };
}

// ------------------------------------------------------------------ the file picker
export type FileGroup = { label: string; files: WsFile[] };

/** Choose a file from My files: grouped by folder (clear headings, unlike a native select's
 * grey ones), with a search box for long lists. */
export function FilePicker({
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

