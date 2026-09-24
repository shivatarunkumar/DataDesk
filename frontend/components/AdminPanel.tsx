"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { api, errorText } from "@/lib/api";
import Link from "next/link";
import { TARGET_LABELS, dateTime, timeAgo } from "@/lib/format";
import { notifyPendingChanged } from "@/lib/pending";
import type { OnboardedTarget, PasswordReset, SessionUser, UploadRequest } from "@/lib/types";
import { SpinnerIcon } from "./icons";
import { ValidationReportView } from "./LoadToTable";
import { ruleCount } from "./ContractSummary";
import { RequestCard } from "./RequestList";
import { Alert, Dialog, EmptyState, Field, StatusPill, btn } from "./ui";

const TABS = [
  { key: "approvals", label: "Approvals" },
  { key: "history", label: "Load history" },
  { key: "people", label: "People" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export function AdminPanel({ adminId }: { adminId: string }) {
  const router = useRouter();
  // read the hook once, outside the callback: hooks must run the same number of times every render
  const requested = useSearchParams().get("tab");
  const tab = (TABS.find((t) => t.key === requested)?.key ?? "approvals") as Tab;

  return (
    <div className="mx-auto max-w-5xl px-4 pb-10 lg:px-6">
      <div className="py-4">
        <h1 className="text-2xl">Admin</h1>
        <p className="mt-1 text-sm text-muted">Approve accounts and loads into shared tables. Every decision is recorded.</p>
      </div>
      <div role="tablist" className="mb-5 flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => router.replace(t.key === "approvals" ? "/admin" : `/admin?tab=${t.key}`, { scroll: false })}
            className={`-mb-px border-b-2 px-3 py-2.5 text-sm font-medium ${
              tab === t.key ? "border-brand text-brand" : "border-transparent text-muted hover:text-fg"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "approvals" && <Approvals />}
      {tab === "history" && <History />}
      {tab === "people" && <People adminId={adminId} />}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
        {title}
        <span className="rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-brand-contrast tabular">{count}</span>
      </h2>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  );
}

function Loading() {
  return (
    <p className="flex items-center gap-2 text-sm text-muted">
      <SpinnerIcon /> Loading…
    </p>
  );
}

// ------------------------------------------------------------------ approvals
function Approvals() {
  const [loads, setLoads] = useState<UploadRequest[] | null>(null);
  const [tables, setTables] = useState<OnboardedTarget[]>([]);
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [resets, setResets] = useState<PasswordReset[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [rejecting, setRejecting] = useState<UploadRequest | null>(null);
  const [resetting, setResetting] = useState<PasswordReset | null>(null);
  const [report, setReport] = useState<UploadRequest | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, u, r, t] = await Promise.all([
        api<UploadRequest[]>("/admin/upload-requests"),
        api<SessionUser[]>("/admin/users?status=pending_approval"),
        api<PasswordReset[]>("/admin/password-resets"),
        api<OnboardedTarget[]>("/onboarding/targets"),
      ]);
      setLoads(l);
      setTables(t.filter((x) => x.onboarding_status === "pending"));
      setUsers(u);
      setResets(r);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError("");
    setNotice(null);
    try {
      await fn();
      await load();
      notifyPendingChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const approveLoad = (r: UploadRequest) =>
    act(`${r.id}-approve`, async () => {
      const done = await api<UploadRequest>(`/admin/upload-requests/${r.id}/approve`, { method: "POST" });
      if (done.status === "completed") {
        setNotice({ tone: "ok", text: `Loaded ${r.file_name} into ${r.target_database}.${r.target_table}.` });
      } else {
        setNotice({ tone: "bad", text: `The load failed: ${String(done.result?.error ?? "unknown error")}` });
        if (done.validation_report && !done.validation_report.passed) setReport(done);
      }
    });

  if (!loads) return error ? <Alert>{error}</Alert> : <Loading />;
  const total = loads.length + tables.length + users.length + resets.length;

  return (
    <>
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {notice && (
        <div className="mb-4">
          <Alert tone={notice.tone}>{notice.text}</Alert>
        </div>
      )}
      {total === 0 && <EmptyState title="All clear">Nothing is waiting for a decision.</EmptyState>}

      {loads.length > 0 && (
        <Section title="Loads into tables" count={loads.length}>
          {loads.map((r) => (
            <RequestCard key={r.id} request={r}>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={btn.primary} disabled={busy !== null} onClick={() => approveLoad(r)}>
                  {busy === `${r.id}-approve` ? (
                    <>
                      <SpinnerIcon /> Checking and loading…
                    </>
                  ) : (
                    "Approve & load"
                  )}
                </button>
                <button type="button" className={btn.danger} disabled={busy !== null} onClick={() => setRejecting(r)}>
                  Reject
                </button>
              </div>
            </RequestCard>
          ))}
        </Section>
      )}

      {tables.length > 0 && (
        <Section title="Tables to onboard" count={tables.length}>
          {tables.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4">
              <div className="min-w-0">
                <p className="font-medium">
                  {t.display_name} <span className="text-xs font-normal text-muted">({TARGET_LABELS[t.target_type]} · {t.location})</span>
                </p>
                <p className="text-xs text-muted">
                  Asked for by {t.requested_by_name} {timeAgo(t.created_at)} · {ruleCount(t.contract)} contract rule
                  {ruleCount(t.contract) === 1 ? "" : "s"}
                </p>
                {t.request_reason && <p className="mt-1 text-sm italic text-muted">&ldquo;{t.request_reason}&rdquo;</p>}
              </div>
              <Link href={`/onboarding/${t.id}`} className={btn.primary}>
                Review
              </Link>
            </li>
          ))}
        </Section>
      )}

      {users.length > 0 && (
        <Section title="New accounts" count={users.length}>
          {users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4">
              <div className="min-w-0">
                <p className="font-medium">{u.display_name}</p>
                <p className="text-xs text-muted">
                  {u.email} · @{u.username} · asked {timeAgo(u.created_at)}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={btn.primary}
                  disabled={busy !== null}
                  onClick={() => act(`${u.id}-ok`, () => api(`/admin/users/${u.id}/approve`, { method: "POST" }))}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className={btn.danger}
                  disabled={busy !== null}
                  onClick={() => act(`${u.id}-no`, () => api(`/admin/users/${u.id}/reject`, { method: "POST" }))}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </Section>
      )}

      {resets.length > 0 && (
        <Section title="Password resets" count={resets.length}>
          {resets.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4">
              <div className="min-w-0">
                <p className="font-medium">{r.user_name}</p>
                <p className="text-xs text-muted">
                  {r.user_email} · asked {timeAgo(r.created_at)}
                </p>
              </div>
              <button type="button" className={btn.primary} disabled={busy !== null} onClick={() => setResetting(r)}>
                Set a temporary password
              </button>
            </li>
          ))}
        </Section>
      )}

      {rejecting && (
        <RejectDialog
          request={rejecting}
          onClose={() => setRejecting(null)}
          onReject={(note) => {
            const r = rejecting;
            setRejecting(null);
            act(`${r.id}-reject`, () => api(`/admin/upload-requests/${r.id}/reject`, { method: "POST", json: { review_note: note || null } }));
          }}
        />
      )}
      {resetting && (
        <ResetDialog
          reset={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            setNotice({ tone: "ok", text: `Password set for ${resetting.user_email}. Give it to them securely.` });
            setResetting(null);
            load();
            notifyPendingChanged();
          }}
        />
      )}
      {report?.validation_report && (
        <Dialog title="Why the load failed" onClose={() => setReport(null)} wide>
          <ValidationReportView report={report.validation_report} />
        </Dialog>
      )}
    </>
  );
}

export function RejectDialog({ request, onClose, onReject }: { request: UploadRequest; onClose: () => void; onReject: (note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <Dialog title="Reject this load?" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onReject(note.trim());
        }}
        className="flex flex-col gap-4"
      >
        <p className="text-sm text-muted">
          {request.user_name} asked to load {request.file_name} into {request.target_database}.{request.target_table}.
        </p>
        <Field label="Note for them" value={note} onChange={setNote} hint="Optional, but it helps them fix it." autoFocus />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.secondary} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={btn.danger}>
            Reject
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ResetDialog({ reset, onClose, onDone }: { reset: PasswordReset; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError("Use at least 8 characters");
    setBusy(true);
    try {
      await api(`/admin/password-resets/${reset.id}/resolve`, { method: "POST", json: { new_password: password } });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title={`New password for ${reset.user_name}`} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="Temporary password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          error={error}
          hint="It also clears any sign-in lockout. Share it with them over a private channel."
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.secondary} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={btn.primary} disabled={busy}>
            Set password
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ history
function History() {
  const [rows, setRows] = useState<UploadRequest[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<UploadRequest[]>("/admin/upload-requests/history")
      .then(setRows)
      .catch((e) => setError(errorText(e)));
  }, []);
  if (error) return <Alert>{error}</Alert>;
  if (!rows) return <Loading />;
  if (rows.length === 0) return <EmptyState title="No decisions yet">Approved and rejected loads show up here.</EmptyState>;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <RequestCard key={r.id} request={r}>
          {r.reviewed_at && <p className="mt-2 text-xs text-muted">Decided {dateTime(r.reviewed_at)}</p>}
        </RequestCard>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ people
function People({ adminId }: { adminId: string }) {
  const [users, setUsers] = useState<SessionUser[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api<SessionUser[]>("/admin/users")
      .then(setUsers)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  async function setStatus(user: SessionUser, action: "approve" | "suspend") {
    setBusy(user.id);
    setError("");
    try {
      await api(`/admin/users/${user.id}/${action}`, { method: "POST" });
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (!users) return error ? <Alert>{error}</Alert> : <Loading />;
  return (
    <>
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-semibold">Person</th>
              <th className="px-4 py-2 font-semibold">Role</th>
              <th className="px-4 py-2 font-semibold">Status</th>
              <th className="px-4 py-2 font-semibold">Last sign-in</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-line">
                <td className="px-4 py-2.5">
                  <p className="font-medium">{u.display_name}</p>
                  <p className="text-xs text-muted">
                    {u.email} · @{u.username}
                  </p>
                </td>
                <td className="px-4 py-2.5 capitalize">{u.role}</td>
                <td className="px-4 py-2.5">
                  <StatusPill status={u.status} />
                </td>
                <td className="px-4 py-2.5 text-muted">{u.last_login_at ? timeAgo(u.last_login_at) : "Never"}</td>
                <td className="px-4 py-2.5 text-right">
                  {u.id !== adminId &&
                    (u.status === "active" ? (
                      <button type="button" className={btn.danger} disabled={busy !== null} onClick={() => setStatus(u, "suspend")}>
                        Suspend
                      </button>
                    ) : (
                      <button type="button" className={btn.secondary} disabled={busy !== null} onClick={() => setStatus(u, "approve")}>
                        {u.status === "pending_approval" ? "Approve" : "Reactivate"}
                      </button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
