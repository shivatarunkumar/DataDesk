"use client";

import { useState } from "react";
import { api, errorText } from "@/lib/api";
import { notifyPendingChanged } from "@/lib/pending";
import type { UploadRequest } from "@/lib/types";
import { SpinnerIcon, TrashIcon } from "./icons";
import { Alert, Dialog, btn } from "./ui";

/** Admins only: delete a request of any kind and status, after saying what it does and doesn't undo. */
export function DeleteRequestButton({
  request: r,
  onDeleted,
  compact = false,
}: {
  request: UploadRequest;
  onDeleted: () => void;
  /** an icon button, for request cards */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api(`/admin/upload-requests/${r.id}`, { method: "DELETE" });
      setOpen(false);
      notifyPendingChanged();
      onDeleted();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const withCloudRun = r.origin === "pipeline" && r.status === "approved" && r.landing_uri;
  const name = r.origin === "studio" ? "Data Studio edits" : (r.file_name ?? "a deleted file");

  return (
    <>
      {compact ? (
        <button
          type="button"
          className={btn.icon}
          aria-label="Delete this request"
          title="Delete this request"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }}
        >
          <TrashIcon width={16} height={16} />
        </button>
      ) : (
        <button type="button" className={btn.danger} onClick={() => setOpen(true)}>
          <TrashIcon width={16} height={16} /> Delete
        </button>
      )}
      {open && (
        <Dialog title="Delete this request?" onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-4 text-sm">
            <p>
              {name} → {r.target_label ?? `${r.target_database}.${r.target_table}`}, asked by {r.is_mine ? "you" : r.user_name},{" "}
              <span className="font-medium">{r.status === "approved" && withCloudRun ? "with Cloud Run" : r.status}</span>.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-muted">
              <li>The request and its history are removed from DataDesk for everyone. This can&apos;t be undone.</li>
              <li>The file stays in My files, and rows already loaded stay in the table.</li>
              {withCloudRun && <li className="text-warn">Cloud Run still has the file and will finish loading it.</li>}
            </ul>
            {error && <Alert>{error}</Alert>}
            <div className="flex justify-end gap-2">
              <button type="button" className={btn.secondary} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" className={btn.danger} onClick={remove} disabled={busy}>
                {busy ? <SpinnerIcon /> : <TrashIcon width={16} height={16} />} Delete request
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
