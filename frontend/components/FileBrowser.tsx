"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type DragEvent, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "@/lib/api";
import { humanSize, shortDate, timeAgo } from "@/lib/format";
import type { Folder, WsFile } from "@/lib/types";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  FolderPlusIcon,
  MoveIcon,
  PlusIcon,
  SpinnerIcon,
  TrashIcon,
  UploadIcon,
} from "./icons";
import { FileGlyph } from "./FileGlyph";
import { Alert, Dialog, EmptyState, Field, btn } from "./ui";

type SortKey = "name" | "modified" | "size";
type Upload = { id: number; name: string; progress: number; error?: string; done?: boolean };

const ACCEPT = ".csv,.tsv,.xlsx,.json";

/** Upload with progress: fetch() can't report upload progress, XMLHttpRequest can. */
function uploadWithProgress(file: File, folderId: string | null, onProgress: (pct: number) => void): Promise<WsFile> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    if (folderId) form.append("folder_id", folderId);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/v1/workspace/files");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let body: { detail?: { message?: string } | string } | WsFile | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as WsFile);
      if (xhr.status === 401) window.location.assign("/login?next=/");
      const detail = (body as { detail?: { message?: string } | string } | null)?.detail;
      reject(new Error(typeof detail === "string" ? detail : (detail?.message ?? `Upload failed (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new Error("Can't reach the server. Is the API running?"));
    xhr.send(form);
  });
}

export function FileBrowser() {
  const router = useRouter();
  const params = useSearchParams();
  const folderId = params.get("folder");
  const query = (params.get("q") ?? "").trim().toLowerCase();

  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<WsFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  const [menuOpen, setMenuOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: "file" | "folder"; id: string; name: string } | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  // selected rows: "d:<folder id>" and "f:<file id>"
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [transfer, setTransfer] = useState<"move" | "copy" | null>(null);
  const [bulkDelete, setBulkDelete] = useState(false);
  const [notice, setNotice] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const nextUploadId = useRef(1);

  const load = useCallback(async () => {
    try {
      const [f, fl] = await Promise.all([api<WsFile[]>("/workspace/files"), api<Folder[]>("/workspace/folders")]);
      setFiles(f);
      setFolders(fl);
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenuOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const current = folders.find((f) => f.id === folderId) ?? null;
  // a folder id that isn't ours (or was deleted) falls back to the root
  const inFolder = current ? current.id : null;

  const crumbs = useMemo(() => {
    const chain: Folder[] = [];
    let walk = current;
    while (walk) {
      chain.unshift(walk);
      walk = folders.find((f) => f.id === walk!.parent_id) ?? null;
    }
    return chain;
  }, [current, folders]);

  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);

  // Searching looks across every folder; browsing shows the current one.
  const shownFolders = folders
    .filter((f) => (query ? f.name.toLowerCase().includes(query) : f.parent_id === inFolder))
    .sort((a, b) => a.name.localeCompare(b.name));
  const shownFiles = files
    .filter((f) => (query ? f.original_name.toLowerCase().includes(query) : (f.folder_id ?? null) === inFolder))
    .sort((a, b) => {
      let cmp = 0;
      if (sort.key === "name") cmp = a.original_name.localeCompare(b.original_name);
      else if (sort.key === "size") cmp = (a.size_bytes ?? 0) - (b.size_bytes ?? 0);
      else cmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
      return sort.asc ? cmp : -cmp;
    });

  const openFolder = (id: string | null) => router.push(id ? `/?folder=${id}` : "/");

  // a selection belongs to what is on screen: moving elsewhere starts afresh
  useEffect(() => {
    setSelected(new Set());
  }, [inFolder, query]);

  const shownKeys = [...shownFolders.map((f) => `d:${f.id}`), ...shownFiles.map((f) => `f:${f.id}`)];
  const allSelected = shownKeys.length > 0 && shownKeys.every((k) => selected.has(k));
  const toggle = (key: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const selectedFolders = folders.filter((f) => selected.has(`d:${f.id}`));
  const selectedFiles = files.filter((f) => selected.has(`f:${f.id}`));
  const selectionLabel = [
    selectedFolders.length && `${selectedFolders.length} folder${selectedFolders.length === 1 ? "" : "s"}`,
    selectedFiles.length && `${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" and ");

  async function deleteSelected() {
    setBulkDelete(false);
    const failures: string[] = [];
    for (const f of selectedFiles) {
      try {
        await api(`/workspace/files/${f.id}`, { method: "DELETE" });
      } catch (e) {
        failures.push(`${f.original_name}: ${errorText(e)}`);
      }
    }
    // deepest first, so a folder emptied by this delete can go too
    for (const f of [...selectedFolders].sort((a, b) => b.path.length - a.path.length)) {
      try {
        await api(`/workspace/folders/${f.id}`, { method: "DELETE" });
      } catch (e) {
        failures.push(`${f.name}: ${errorText(e)}`);
      }
    }
    setSelected(new Set());
    if (failures.length) setError(failures.join(" "));
    load();
  }

  async function uploadFiles(list: FileList | File[]) {
    const chosen = Array.from(list);
    if (!chosen.length) return;
    const target = inFolder;
    await Promise.all(
      chosen.map(async (file) => {
        const id = nextUploadId.current++;
        setUploads((u) => [...u, { id, name: file.name, progress: 0 }]);
        const update = (patch: Partial<Upload>) =>
          setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...patch } : x)));
        try {
          await uploadWithProgress(file, target, (progress) => update({ progress }));
          update({ progress: 100, done: true });
          setTimeout(() => setUploads((u) => u.filter((x) => x.id !== id)), 2500);
        } catch (e) {
          update({ error: errorText(e) });
        }
      }),
    );
    load();
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  }

  async function doDelete() {
    if (!confirmDelete) return;
    const { kind, id } = confirmDelete;
    try {
      await api(kind === "file" ? `/workspace/files/${id}` : `/workspace/folders/${id}`, { method: "DELETE" });
      setConfirmDelete(null);
      load();
    } catch (e) {
      setConfirmDelete(null);
      setError(errorText(e));
    }
  }

  const isEmpty = !loading && shownFolders.length === 0 && shownFiles.length === 0;

  return (
    <div
      className="relative min-h-[calc(100vh-3.5rem)] px-4 pb-10 lg:px-6"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      {/* header: breadcrumb + actions */}
      <div className="sticky top-14 z-20 -mx-4 flex flex-wrap items-center justify-between gap-3 bg-bg px-4 py-3 lg:-mx-6 lg:px-6">
        <nav aria-label="Folder path" className="flex min-w-0 flex-wrap items-center gap-1">
          {query ? (
            <h1 className="text-2xl">
              Results for “{params.get("q")}”{" "}
              <Link href={current ? `/?folder=${current.id}` : "/"} className="ml-2 align-middle text-sm font-medium text-brand hover:underline" style={{ fontFamily: "var(--font-sans)" }}>
                Clear search
              </Link>
            </h1>
          ) : (
            <>
              <Crumb label="My files" active={!current} onClick={() => openFolder(null)} />
              {crumbs.map((c) => (
                <span key={c.id} className="flex min-w-0 items-center gap-1">
                  <ChevronRightIcon width={18} height={18} className="shrink-0 text-muted" />
                  <Crumb label={c.name} active={c.id === current?.id} onClick={() => openFolder(c.id)} />
                </span>
              ))}
            </>
          )}
        </nav>

        <div className="relative" ref={menuRef}>
          <button type="button" className={btn.primary} onClick={() => setMenuOpen((v) => !v)} aria-haspopup="menu" aria-expanded={menuOpen}>
            <PlusIcon width={18} height={18} />
            New
          </button>
          {menuOpen && (
            <div role="menu" className="absolute right-0 top-11 z-30 w-52 overflow-hidden rounded-xl border border-line bg-bg py-1 shadow-lg">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  picker.current?.click();
                }}
                className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-surface-hover"
              >
                <UploadIcon width={18} height={18} className="text-muted" />
                Upload files
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setNewFolderOpen(true);
                }}
                className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-surface-hover"
              >
                <FolderPlusIcon width={18} height={18} className="text-muted" />
                New folder
              </button>
            </div>
          )}
          <input
            ref={picker}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {selected.size > 0 && (
        <div className="sticky top-[7.5rem] z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand/30 bg-bg px-3 py-2 shadow-sm">
          <button type="button" className={btn.icon} onClick={() => setSelected(new Set())} aria-label="Clear selection" title="Clear selection">
            <CloseIcon width={17} height={17} />
          </button>
          <span className="mr-auto text-sm font-medium">{selectionLabel} selected</span>
          <button type="button" className={btn.secondary} onClick={() => setTransfer("move")}>
            <MoveIcon width={16} height={16} /> Move to…
          </button>
          <button type="button" className={btn.secondary} onClick={() => setTransfer("copy")}>
            <CopyIcon width={16} height={16} /> Copy to…
          </button>
          <button type="button" className={btn.danger} onClick={() => setBulkDelete(true)}>
            <TrashIcon width={16} height={16} /> Delete
          </button>
        </div>
      )}

      {notice && (
        <div className="mb-3">
          <Alert tone="ok">
            {notice}{" "}
            <button type="button" className="font-medium underline" onClick={() => setNotice("")}>
              Dismiss
            </button>
          </Alert>
        </div>
      )}

      {error && (
        <div className="mb-3">
          <Alert>
            {error}{" "}
            <button type="button" className="font-medium underline" onClick={() => setError("")}>
              Dismiss
            </button>
          </Alert>
        </div>
      )}

      {uploads.length > 0 && <UploadTray uploads={uploads} onDismiss={(id) => setUploads((u) => u.filter((x) => x.id !== id))} />}

      {/* the list */}
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="grid grid-cols-[minmax(0,1fr)_7rem_6rem_2.5rem] items-center gap-3 border-b border-line bg-surface px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted sm:grid-cols-[minmax(0,1fr)_9rem_6rem_4rem_5.5rem]">
          <span className="flex items-center gap-3">
            <Check
              checked={allSelected}
              partial={!allSelected && shownKeys.some((k) => selected.has(k))}
              label="Select all"
              onChange={() => setSelected(allSelected ? new Set() : new Set(shownKeys))}
              visible
            />
            <SortHeader label="Name" k="name" sort={sort} setSort={setSort} />
          </span>
          <SortHeader label="Modified" k="modified" sort={sort} setSort={setSort} />
          <SortHeader label="Size" k="size" sort={sort} setSort={setSort} align="right" />
          <span className="hidden sm:block">Type</span>
          <span className="sr-only">Actions</span>
        </div>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <SpinnerIcon /> Loading your files…
          </div>
        )}

        {isEmpty &&
          (query ? (
            <EmptyState title="No matches">Nothing in your workspace is called that.</EmptyState>
          ) : (
            <EmptyState title={current ? "This folder is empty" : "Your workspace is empty"}>
              <p>Drop CSV, Excel or JSON files anywhere on this page, or use New → Upload files.</p>
              <button type="button" className={`${btn.primary} mt-5`} onClick={() => picker.current?.click()}>
                <UploadIcon width={18} height={18} />
                Upload files
              </button>
            </EmptyState>
          ))}

        <ul>
          {shownFolders.map((folder) => (
            <li
              key={folder.id}
              aria-selected={selected.has(`d:${folder.id}`)}
              className="group grid cursor-pointer aria-selected:bg-brand/5 grid-cols-[minmax(0,1fr)_7rem_6rem_2.5rem] items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-surface sm:grid-cols-[minmax(0,1fr)_9rem_6rem_4rem_5.5rem]"
              onClick={() => openFolder(folder.id)}
            >
              <span className="flex min-w-0 items-center gap-3">
                <Check
                  checked={selected.has(`d:${folder.id}`)}
                  label={`Select folder ${folder.name}`}
                  onChange={() => toggle(`d:${folder.id}`)}
                  visible={selected.size > 0}
                />
                <FolderIcon width={28} height={28} className="shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{folder.name}</span>
                  {query && <span className="block truncate text-xs text-muted">{folder.path}</span>}
                </span>
              </span>
              <span className="text-sm text-muted">{shortDate(folder.created_at)}</span>
              <span className="text-right text-sm text-muted">—</span>
              <span className="hidden text-sm text-muted sm:block">Folder</span>
              <span className="flex justify-end">
                <button
                  type="button"
                  className={`${btn.icon} opacity-0 group-hover:opacity-100 focus:opacity-100`}
                  aria-label={`Delete folder ${folder.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDelete({ kind: "folder", id: folder.id, name: folder.name });
                  }}
                >
                  <TrashIcon width={17} height={17} />
                </button>
              </span>
            </li>
          ))}

          {shownFiles.map((file) => (
            <li
              key={file.id}
              aria-selected={selected.has(`f:${file.id}`)}
              className="group grid cursor-pointer aria-selected:bg-brand/5 grid-cols-[minmax(0,1fr)_7rem_6rem_2.5rem] items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-surface sm:grid-cols-[minmax(0,1fr)_9rem_6rem_4rem_5.5rem]"
              onClick={() => router.push(`/files/${file.id}`)}
            >
              <span className="flex min-w-0 items-center gap-3">
                <Check
                  checked={selected.has(`f:${file.id}`)}
                  label={`Select ${file.original_name}`}
                  onChange={() => toggle(`f:${file.id}`)}
                  visible={selected.size > 0}
                />
                <FileGlyph format={file.format} size={28} />
                <span className="min-w-0">
                  <Link href={`/files/${file.id}`} className="block truncate font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                    {file.original_name}
                  </Link>
                  <span className="block truncate text-xs text-muted tabular">
                    v{file.current_version} · {(file.row_count ?? 0).toLocaleString()} rows
                    {query && file.folder_id && ` · in ${folderById.get(file.folder_id)?.path ?? "a folder"}`}
                  </span>
                </span>
              </span>
              <span className="text-sm text-muted" title={shortDate(file.updated_at)}>
                {timeAgo(file.updated_at)}
              </span>
              <span className="text-right text-sm text-muted tabular">{humanSize(file.size_bytes)}</span>
              <span className="hidden text-sm uppercase text-muted sm:block">{file.format}</span>
              <span className="flex justify-end gap-0.5">
                <a
                  href={`/api/v1/workspace/files/${file.id}/download`}
                  className={`${btn.icon} hidden opacity-0 group-hover:opacity-100 focus:opacity-100 sm:flex`}
                  aria-label={`Download ${file.original_name}`}
                  title="Download"
                  onClick={(e) => e.stopPropagation()}
                >
                  <DownloadIcon width={17} height={17} />
                </a>
                <button
                  type="button"
                  className={`${btn.icon} opacity-0 group-hover:opacity-100 focus:opacity-100`}
                  aria-label={`Delete ${file.original_name}`}
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDelete({ kind: "file", id: file.id, name: file.original_name });
                  }}
                >
                  <TrashIcon width={17} height={17} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-brand/10 lg:left-60">
          <div className="rounded-2xl border-2 border-dashed border-brand bg-bg px-10 py-8 text-center shadow-xl">
            <UploadIcon className="mx-auto text-brand" width={36} height={36} />
            <p className="mt-2 font-medium">Drop to upload to {current ? current.name : "My files"}</p>
            <p className="text-sm text-muted">CSV, TSV, Excel or JSON</p>
          </div>
        </div>
      )}

      {transfer && (
        <TransferDialog
          mode={transfer}
          folders={folders}
          selectedFolders={selectedFolders}
          selectedFiles={selectedFiles}
          current={inFolder}
          onClose={() => setTransfer(null)}
          onDone={(message) => {
            setTransfer(null);
            setSelected(new Set());
            setNotice(message);
            load();
          }}
        />
      )}

      {bulkDelete && (
        <Dialog title={`Delete ${selectionLabel}?`} onClose={() => setBulkDelete(false)}>
          <p className="text-sm">
            Selected files are deleted with every saved version. Load requests that used them keep their history.
            {selectedFolders.length > 0 && " Folders are deleted only if they are empty (or become empty with this delete)."}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={btn.secondary} onClick={() => setBulkDelete(false)}>
              Cancel
            </button>
            <button type="submit" className={btn.danger} onClick={deleteSelected}>
              <TrashIcon width={16} height={16} />
              Delete
            </button>
          </div>
        </Dialog>
      )}

      {newFolderOpen && (
        <NewFolderDialog
          parent={current}
          onClose={() => setNewFolderOpen(false)}
          onCreated={() => {
            setNewFolderOpen(false);
            load();
          }}
        />
      )}

      {confirmDelete && (
        <Dialog title={`Delete ${confirmDelete.kind}?`} onClose={() => setConfirmDelete(null)}>
          <p className="text-sm">
            <span className="font-medium">{confirmDelete.name}</span>{" "}
            {confirmDelete.kind === "file"
              ? "and every saved version of it will be deleted. Load requests that used it keep their history."
              : "will be deleted. Only empty folders can be deleted."}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={btn.secondary} onClick={() => setConfirmDelete(null)}>
              Cancel
            </button>
            <button type="submit" className={btn.danger} onClick={doDelete}>
              <TrashIcon width={16} height={16} />
              Delete
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Crumb({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return active ? (
    <h1 className="truncate text-2xl">{label}</h1>
  ) : (
    <button type="button" onClick={onClick} className="display truncate rounded-md px-1 text-2xl text-muted hover:bg-surface hover:text-fg">
      {label}
    </button>
  );
}

function SortHeader({
  label,
  k,
  sort,
  setSort,
  align,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; asc: boolean };
  setSort: (s: { key: SortKey; asc: boolean }) => void;
  align?: "right";
}) {
  const active = sort.key === k;
  return (
    <button
      type="button"
      onClick={() => setSort({ key: k, asc: active ? !sort.asc : true })}
      className={`flex items-center gap-1 uppercase hover:text-fg ${align === "right" ? "justify-end" : ""} ${active ? "text-fg" : ""}`}
      aria-sort={active ? (sort.asc ? "ascending" : "descending") : undefined}
    >
      {label}
      {active && (sort.asc ? <ChevronUpIcon width={14} height={14} /> : <ChevronDownIcon width={14} height={14} />)}
    </button>
  );
}

function UploadTray({ uploads, onDismiss }: { uploads: Upload[]; onDismiss: (id: number) => void }) {
  return (
    <div className="mb-3 flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
      {uploads.map((u) => (
        <div key={u.id} className="text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate font-medium">{u.name}</span>
            <span className={`shrink-0 text-xs ${u.error ? "text-bad" : u.done ? "text-ok" : "text-muted"}`}>
              {u.error ? "Failed" : u.done ? "Uploaded" : u.progress < 100 ? `${u.progress}%` : "Checking the file…"}
            </span>
          </div>
          {u.error ? (
            <p className="mt-1 text-xs text-bad">
              {u.error}{" "}
              <button type="button" className="underline" onClick={() => onDismiss(u.id)}>
                Dismiss
              </button>
            </p>
          ) : (
            <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
              <div
                className={`relative h-full overflow-hidden rounded-full bg-brand transition-[width] ${u.done ? "" : "upload-sheen"}`}
                style={{ width: `${Math.max(u.progress, 4)}%` }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function NewFolderDialog({ parent, onClose, onCreated }: { parent: Folder | null; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the folder a name");
    setBusy(true);
    try {
      await api("/workspace/folders", { method: "POST", json: { name: name.trim(), parent_id: parent?.id ?? null } });
      onCreated();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title="New folder" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="Name"
          value={name}
          onChange={(v) => {
            setName(v);
            setError("");
          }}
          error={error}
          hint={parent ? `Inside ${parent.path}` : "In My files"}
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.secondary} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={btn.primary} disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** A row's checkbox: shown on hover (and always once something is selected or on touch screens). */
function Check({
  checked,
  partial = false,
  label,
  onChange,
  visible,
}: {
  checked: boolean;
  partial?: boolean;
  label: string;
  onChange: () => void;
  visible: boolean;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = partial;
      }}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
      className={`h-4 w-4 shrink-0 cursor-pointer accent-[var(--brand)] ${
        visible || checked ? "" : "sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
      }`}
    />
  );
}

/** Pick where selected items go: My files or any folder, or a new folder made here. */
function TransferDialog({
  mode,
  folders,
  selectedFolders,
  selectedFiles,
  current,
  onClose,
  onDone,
}: {
  mode: "move" | "copy";
  folders: Folder[];
  selectedFolders: Folder[];
  selectedFiles: WsFile[];
  current: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [list, setList] = useState(folders);
  const [target, setTarget] = useState<string | null>(current);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // a folder can't go into itself or anything inside it
  const blocked = (f: Folder) => selectedFolders.some((s) => f.path === s.path || f.path.startsWith(`${s.path}/`));
  const count = selectedFolders.length + selectedFiles.length;
  const tree = [...list].sort((a, b) => a.path.localeCompare(b.path));
  const where = target ? (list.find((f) => f.id === target)?.path ?? "") : "";
  const verb = mode === "move" ? "Move" : "Copy";

  async function makeFolder(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const made = await api<Folder>("/workspace/folders", { method: "POST", json: { name: newName.trim(), parent_id: target } });
      setList((l) => [...l, made]);
      setTarget(made.id);
      setCreating(false);
      setNewName("");
      setError("");
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const out = await api<{ files: number; folders: number; renamed: string[] }>(`/workspace/${mode}`, {
        method: "POST",
        json: { file_ids: selectedFiles.map((f) => f.id), folder_ids: selectedFolders.map((f) => f.id), destination_id: target },
      });
      const done = mode === "move" ? "Moved" : "Copied";
      const what = count === 1 ? (selectedFiles[0]?.original_name ?? selectedFolders[0]?.name) : `${count} items`;
      const renamed = out.renamed.length ? ` Renamed because the name was taken: ${out.renamed.join(", ")}.` : "";
      const nothing = out.files + out.folders === 0 ? " They were already there." : "";
      onDone(`${done} ${what} to ${where ? where.replaceAll("/", " › ") : "My files"}.${nothing}${renamed}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const row = (id: string | null, name: string, depth: number, disabled: boolean, note?: string) => (
    <li key={id ?? "root"}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setTarget(id)}
        aria-pressed={target === id}
        className={`flex w-full items-center gap-2 rounded-lg py-1.5 pr-3 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
          target === id ? "bg-brand/10 font-semibold text-brand" : "hover:bg-surface"
        }`}
        style={{ paddingLeft: 12 + depth * 18 }}
      >
        <FolderIcon width={18} height={18} className="shrink-0" />
        <span className="truncate">{name}</span>
        {note && <span className="ml-auto shrink-0 text-xs font-normal text-muted">{note}</span>}
      </button>
    </li>
  );

  return (
    <Dialog title={`${verb} ${count === 1 ? `“${selectedFiles[0]?.original_name ?? selectedFolders[0]?.name}”` : `${count} items`} to…`} onClose={onClose}>
      <ul className="max-h-72 overflow-y-auto rounded-xl border border-line p-1">
        {row(null, "My files", 0, false, current === null ? "here now" : undefined)}
        {tree.map((f) =>
          row(f.id, f.name, f.path.split("/").length, blocked(f), blocked(f) ? "selected" : f.id === current ? "here now" : undefined),
        )}
      </ul>

      {creating ? (
        <form onSubmit={makeFolder} className="mt-3 flex items-end gap-2">
          <div className="flex-1">
            <Field label={`New folder in ${where ? where.replaceAll("/", " › ") : "My files"}`} value={newName} onChange={setNewName} autoFocus />
          </div>
          <button type="submit" className={btn.secondary}>
            Create
          </button>
        </form>
      ) : (
        <button type="button" className="mt-3 flex items-center gap-2 text-sm font-medium text-brand hover:underline" onClick={() => setCreating(true)}>
          <FolderPlusIcon width={16} height={16} /> New folder here
        </button>
      )}

      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}
      {mode === "copy" && (
        <p className="mt-3 text-xs text-muted">Copies start their own history from each file&apos;s current version. Nothing is overwritten.</p>
      )}
      {mode === "move" && (
        <p className="mt-3 text-xs text-muted">Files keep their versions and load requests. Nothing is overwritten.</p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className={btn.primary} disabled={busy} onClick={submit}>
          {busy ? <SpinnerIcon /> : mode === "move" ? <MoveIcon width={16} height={16} /> : <CopyIcon width={16} height={16} />}
          {verb} here
        </button>
      </div>
    </Dialog>
  );
}
