"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, errorText } from "@/lib/api";
import { humanSize, timeAgo } from "@/lib/format";
import type { Folder, WsFile } from "@/lib/types";
import { FileGlyph } from "./FileGlyph";
import { ArrowLeftIcon, DatabaseIcon, DownloadIcon, HistoryIcon, PencilIcon, QueueIcon, SpinnerIcon, TrashIcon } from "./icons";
import { LoadToTable } from "./LoadToTable";
import { RequestList } from "./RequestList";
import { SpreadsheetEditor } from "./SpreadsheetEditor";
import { Alert, Dialog, EmptyState, Field, btn } from "./ui";
import { VersionList } from "./VersionList";

const TABS = [
  { key: "edit", label: "Edit", icon: PencilIcon },
  { key: "versions", label: "Versions", icon: HistoryIcon },
  { key: "load", label: "Load to table", icon: DatabaseIcon },
  { key: "requests", label: "Requests", icon: QueueIcon },
] as const;
type Tab = (typeof TABS)[number]["key"];

export function FileWorkspace({ fileId }: { fileId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get("tab"))?.key ?? "edit") as Tab;

  const [file, setFile] = useState<WsFile | null>(null);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Leaving the Edit tab with unsaved changes asks first; the editor reports its state here.
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      const f = await api<WsFile>(`/workspace/files/${fileId}`);
      setFile(f);
      if (f.folder_id) {
        const folders = await api<Folder[]>("/workspace/folders");
        setFolder(folders.find((x) => x.id === f.folder_id) ?? null);
      }
    } catch (e) {
      if ((e as { status?: number }).status === 404) setMissing(true);
      else setError(errorText(e));
    }
  }, [fileId]);

  useEffect(() => {
    load();
  }, [load]);

  function go(next: Tab) {
    if (dirty && tab === "edit" && !window.confirm("You have unsaved edits. Leave without saving?")) return;
    setDirty(false);
    router.replace(next === "edit" ? `/files/${fileId}` : `/files/${fileId}?tab=${next}`, { scroll: false });
  }

  if (missing) {
    return (
      <EmptyState title="File not found">
        It may have been deleted.{" "}
        <Link href="/" className="font-medium text-brand hover:underline">
          Back to my files
        </Link>
      </EmptyState>
    );
  }
  if (!file) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted">
        {error ? <Alert>{error}</Alert> : <><SpinnerIcon /> Opening…</>}
      </div>
    );
  }

  const back = folder ? `/?folder=${folder.id}` : "/";

  return (
    <div className="px-4 pb-10 lg:px-6">
      <div className="flex flex-wrap items-center gap-3 pt-4">
        <Link href={back} className={btn.icon} aria-label={`Back to ${folder?.name ?? "My files"}`} title="Back">
          <ArrowLeftIcon width={20} height={20} />
        </Link>
        <FileGlyph format={file.format} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <h1 className="truncate text-2xl">{file.original_name}</h1>
            <button type="button" className={btn.icon} onClick={() => setRenaming(true)} aria-label="Rename" title="Rename">
              <PencilIcon width={16} height={16} />
            </button>
          </div>
          <p className="text-xs text-muted tabular">
            {folder ? `${folder.path} · ` : "My files · "}v{file.current_version} · {(file.row_count ?? 0).toLocaleString()} rows ·{" "}
            {humanSize(file.size_bytes)} · edited {timeAgo(file.updated_at)}
          </p>
        </div>
        <a href={`/api/v1/workspace/files/${file.id}/download`} className={btn.secondary}>
          <DownloadIcon width={17} height={17} />
          Download
        </a>
        <button type="button" className={btn.danger} onClick={() => setDeleting(true)}>
          <TrashIcon width={16} height={16} />
          Delete
        </button>
      </div>

      <div role="tablist" className="no-scrollbar mt-4 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => go(key)}
            className={`-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium ${
              tab === key ? "border-brand text-brand" : "border-transparent text-muted hover:text-fg"
            }`}
          >
            <Icon width={17} height={17} />
            {label}
          </button>
        ))}
      </div>

      <div className="pt-4">
        {tab === "edit" && (
          <SpreadsheetEditor
            key={`${file.id}-${file.current_version}`}
            file={file}
            onDirtyChange={setDirty}
            onSaved={(updated) => {
              setFile(updated);
              setDirty(false);
            }}
          />
        )}
        {tab === "versions" && (
          <VersionList
            file={file}
            onRestored={(updated) => {
              // carry on editing from the restored version
              setFile(updated);
              setDirty(false);
              router.replace(`/files/${fileId}`, { scroll: false });
            }}
          />
        )}
        {tab === "load" && <LoadToTable file={file} onSubmitted={() => go("requests")} />}
        {tab === "requests" && <RequestList fileId={file.id} />}
      </div>

      {renaming && (
        <RenameDialog
          file={file}
          onClose={() => setRenaming(false)}
          onRenamed={(f) => {
            setFile(f);
            setRenaming(false);
          }}
        />
      )}

      {deleting && (
        <Dialog title="Delete file?" onClose={() => setDeleting(false)}>
          <p className="text-sm">
            <span className="font-medium">{file.original_name}</span> and all {file.current_version} saved version
            {file.current_version === 1 ? "" : "s"} will be deleted. Load requests that used it keep their history.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={btn.secondary} onClick={() => setDeleting(false)}>
              Cancel
            </button>
            <button
              type="submit"
              className={btn.danger}
              onClick={async () => {
                try {
                  await api(`/workspace/files/${file.id}`, { method: "DELETE" });
                  router.push(back);
                } catch (e) {
                  setDeleting(false);
                  setError(errorText(e));
                }
              }}
            >
              Delete
            </button>
          </div>
        </Dialog>
      )}
      {error && (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm">
          <Alert>{error}</Alert>
        </div>
      )}
    </div>
  );
}

function RenameDialog({ file, onClose, onRenamed }: { file: WsFile; onClose: () => void; onRenamed: (f: WsFile) => void }) {
  const [name, setName] = useState(file.original_name);
  const [error, setError] = useState("");
  const ext = `.${file.original_name.split(".").pop()}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError("The name can't be empty");
    // keep the extension: it is what the format is detected from on download
    const finalName = trimmed.toLowerCase().endsWith(ext.toLowerCase()) ? trimmed : `${trimmed}${ext}`;
    try {
      onRenamed(await api<WsFile>(`/workspace/files/${file.id}`, { method: "PATCH", json: { original_name: finalName } }));
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Dialog title="Rename" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="File name" value={name} onChange={setName} error={error} autoFocus />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.secondary} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={btn.primary}>
            Rename
          </button>
        </div>
      </form>
    </Dialog>
  );
}
