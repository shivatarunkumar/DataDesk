"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, errorText } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import type { AdminRequest, SessionUser } from "@/lib/types";
import { DEFAULT_DURATION, type Duration, DurationPicker, formatDuration, toMinutes } from "./DurationPicker";
import { Alert, Field, StatusPill, btn } from "./ui";

/** "Admin until 3 Oct 2026, 14:00", "Admin (permanent)", "User" */
export function accessLabel(user: Pick<SessionUser, "role" | "admin_until">): string {
  if (user.role !== "admin") return "User";
  return user.admin_until ? `Admin until ${dateTime(user.admin_until)}` : "Admin (permanent)";
}

export function AccountPanel({ user }: { user: SessionUser }) {
  const router = useRouter();
  const [requests, setRequests] = useState<AdminRequest[] | null>(null);
  const [duration, setDuration] = useState<Duration>(DEFAULT_DURATION);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<AdminRequest[]>("/account/admin-requests")
      .then(setRequests)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      load();
      router.refresh(); // the role may have changed: re-render the shell
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    run(async () => {
      await api("/account/admin-requests", {
        method: "POST",
        json: { duration_minutes: toMinutes(duration), reason: reason.trim() || null },
      });
      setReason("");
    });
  }

  const pending = requests?.find((r) => r.status === "pending");
  const permanentAdmin = user.role === "admin" && !user.admin_until;

  return (
    <div className="flex flex-col gap-6">
      {error && <Alert>{error}</Alert>}

      <section className="rounded-xl border border-line p-5">
        <h2 className="mb-3 text-base font-semibold">Profile</h2>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted">Name</dt>
          <dd>{user.display_name}</dd>
          <dt className="text-muted">Username</dt>
          <dd>@{user.username}</dd>
          <dt className="text-muted">Email</dt>
          <dd className="break-all">{user.email}</dd>
          <dt className="text-muted">Access</dt>
          <dd className="font-medium">{accessLabel(user)}</dd>
        </dl>
        {user.admin_until && (
          <p className="mt-3 text-xs text-muted">
            Your admin rights end on their own at that time. Ask again below to extend them.
          </p>
        )}
      </section>

      {!permanentAdmin && (
        <section className="rounded-xl border border-line p-5">
          <h2 className="text-base font-semibold">{user.role === "admin" ? "Extend admin rights" : "Ask to be an admin"}</h2>
          <p className="mb-4 mt-1 text-sm text-muted">
            Admins approve accounts and loads, and onboard tables. An admin decides how long you get; the rights end on
            their own when the time is up.
          </p>
          {pending ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface p-4">
              <p className="text-sm">
                You asked for <b>{formatDuration(pending.duration_minutes)}</b> {timeAgo(pending.created_at)}. Waiting for an
                admin.
              </p>
              <button
                type="button"
                className={btn.secondary}
                disabled={busy}
                onClick={() => run(() => api(`/account/admin-requests/${pending.id}/cancel`, { method: "POST" }))}
              >
                Cancel request
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              <DurationPicker value={duration} onChange={setDuration} />
              <Field
                label="Why"
                value={reason}
                onChange={setReason}
                placeholder="e.g. covering approvals while the team is away"
                hint="Optional, but it helps the admin decide."
              />
              <div>
                <button type="submit" className={btn.primary} disabled={busy}>
                  {busy ? "Sending…" : `Ask for ${formatDuration(toMinutes(duration))}`}
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      {requests && requests.some((r) => r.status !== "pending") && (
        <section>
          <h2 className="mb-3 text-base font-semibold">Earlier requests</h2>
          <ul className="flex flex-col gap-2">
            {requests
              .filter((r) => r.status !== "pending")
              .map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4">
                  <div className="min-w-0 text-sm">
                    <p>
                      Asked for {formatDuration(r.duration_minutes)} · {timeAgo(r.created_at)}
                    </p>
                    <p className="text-xs text-muted">
                      {r.status === "approved" &&
                        `${r.reviewed_by_name ?? "An admin"} granted it ${r.granted_until ? `until ${dateTime(r.granted_until)}` : "permanently"}`}
                      {r.status === "rejected" &&
                        `${r.reviewed_by_name ?? "An admin"} said no${r.review_note ? `: ${r.review_note}` : ""}`}
                      {r.status === "cancelled" && "You cancelled it"}
                    </p>
                  </div>
                  <StatusPill status={r.status} />
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}
