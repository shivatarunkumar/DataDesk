"use client";

import { useEffect, useState } from "react";
import { api, errorText } from "@/lib/api";
import { dateTime, humanSize } from "@/lib/format";
import type { FileContent, FileVersion, WsFile } from "@/lib/types";
import { DownloadIcon, EyeIcon, HistoryIcon, SpinnerIcon } from "./icons";
import { Alert, Dialog, btn } from "./ui";

const PREVIEW_ROWS = 100;

export function VersionList({ file, onRestored }: { file: WsFile; onRestored: (file: WsFile) => void }) {
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<FileVersion | null>(null);
  const [restoring, setRestoring] = useState<FileVersion | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<FileVersion[]>(`/workspace/files/${file.id}/versions`)
      .then(setVersions)
      .catch((e) => setError(errorText(e)));
  }, [file.id, file.current_version]);

  async function restore(v: FileVersion) {
    setBusy(true);
    setError("");
    try {
      const updated = await api<WsFile>(`/workspace/files/${file.id}/versions/${v.version}/restore`, { method: "POST" });
      setRestoring(null);
      setViewing(null);
      onRestored(updated);
    } catch (e) {
      setError(errorText(e));
      setRestoring(null);
    } finally {
      setBusy(false);
    }
  }

  if (!versions)
    return error ? (
      <Alert>{error}</Alert>
    ) : (
      <p className="flex items-center gap-2 text-sm text-muted">
        <SpinnerIcon /> Loading versions…
      </p>
    );

  return (
    <div className="max-w-3xl">
      <p className="mb-3 text-sm text-muted">
        Every save keeps the previous version. Restoring one saves it again as the newest version, so nothing in this
        list is ever lost. A load request always uses the version that was validated.
      </p>
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      <ol className="overflow-hidden rounded-xl border border-line">
        {versions.map((v) => {
          const current = v.version === file.current_version;
          return (
            <li key={v.version} className="flex flex-wrap items-center gap-4 border-b border-line px-4 py-3 last:border-b-0">
              <span className="flex h-9 w-12 shrink-0 items-center justify-center rounded-lg bg-surface text-sm font-semibold text-brand tabular">
                v{v.version}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{v.note ?? "Saved"}</p>
                <p className="text-xs text-muted tabular">
                  {(v.row_count ?? 0).toLocaleString()} rows · {humanSize(v.size_bytes)} · {dateTime(v.created_at)}
                </p>
              </div>
              {current ? (
                <span className="rounded-full bg-ok/15 px-2 py-0.5 text-xs font-semibold text-ok">Current</span>
              ) : (
                <span className="flex gap-2">
                  <button type="button" className={btn.secondary} onClick={() => setViewing(v)}>
                    <EyeIcon width={16} height={16} /> View
                  </button>
                  <button type="button" className={btn.secondary} onClick={() => setRestoring(v)}>
                    <HistoryIcon width={16} height={16} /> Restore
                  </button>
                </span>
              )}
              <a
                href={`/api/v1/workspace/files/${file.id}/download?version=${v.version}`}
                className={btn.icon}
                aria-label={`Download version ${v.version}`}
                title="Download this version"
              >
                <DownloadIcon width={17} height={17} />
              </a>
            </li>
          );
        })}
      </ol>

      {viewing && (
        <VersionPreview
          file={file}
          version={viewing}
          onClose={() => setViewing(null)}
          onRestore={() => setRestoring(viewing)}
        />
      )}

      {restoring && (
        <Dialog title={`Restore version ${restoring.version}?`} onClose={() => !busy && setRestoring(null)}>
          <p className="text-sm">
            Version {restoring.version} ({(restoring.row_count ?? 0).toLocaleString()} rows
            {restoring.note ? `, “${restoring.note}”` : ""}) becomes the current file, saved as{" "}
            <span className="font-medium">version {file.current_version + 1}</span>.
          </p>
          <p className="mt-2 text-sm text-muted">
            Version {file.current_version} stays in the history, so you can switch back to it at any time.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={btn.secondary} onClick={() => setRestoring(null)} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className={btn.primary} onClick={() => restore(restoring)} disabled={busy}>
              {busy ? <SpinnerIcon /> : <HistoryIcon width={16} height={16} />}
              Restore v{restoring.version}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** A read-only look at an earlier version, to be sure it is the one to go back to. */
function VersionPreview({
  file,
  version,
  onClose,
  onRestore,
}: {
  file: WsFile;
  version: FileVersion;
  onClose: () => void;
  onRestore: () => void;
}) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<FileContent>(`/workspace/files/${file.id}/content?version=${version.version}`)
      .then(setContent)
      .catch((e) => setError(errorText(e)));
  }, [file.id, version.version]);

  return (
    <Dialog title={`Version ${version.version}${version.note ? ` — ${version.note}` : ""}`} onClose={onClose} wide>
      <p className="-mt-2 mb-3 text-xs text-muted">
        {dateTime(version.created_at)} · {(version.row_count ?? 0).toLocaleString()} rows · read-only
      </p>
      {error && <Alert>{error}</Alert>}
      {!content && !error && (
        <p className="flex items-center gap-2 py-6 text-sm text-muted">
          <SpinnerIcon /> Loading…
        </p>
      )}
      {content && (
        <>
          <div className="max-h-[55vh] overflow-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface text-left">
                <tr>
                  <th className="px-3 py-2 text-xs font-semibold text-muted">#</th>
                  {content.columns.map((c) => (
                    <th key={c} className="whitespace-nowrap px-3 py-2 font-semibold">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {content.rows.slice(0, PREVIEW_ROWS).map((row, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="px-3 py-1.5 text-xs text-muted tabular">{i + 1}</td>
                    {content.columns.map((c) => (
                      <td key={c} className="whitespace-nowrap px-3 py-1.5">
                        {row[c] ?? <span className="text-muted">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {content.rows.length > PREVIEW_ROWS && (
            <p className="mt-2 text-xs text-muted">
              Showing the first {PREVIEW_ROWS} of {content.rows.length.toLocaleString()} rows.
            </p>
          )}
        </>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={onClose}>
          Close
        </button>
        <button type="button" className={btn.primary} onClick={onRestore} disabled={!content}>
          <HistoryIcon width={16} height={16} /> Restore this version
        </button>
      </div>
    </Dialog>
  );
}
