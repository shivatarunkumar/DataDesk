"use client";

import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText } from "@/lib/api";
import Link from "next/link";
import { TARGET_LABELS, dateTime, timeAgo } from "@/lib/format";
import { notifyPendingChanged } from "@/lib/pending";
import type { AdminRequest, OnboardedTarget, PasswordReset, SessionUser, UploadRequest } from "@/lib/types";
import { accessLabel } from "./AccountPanel";
import {
  DEFAULT_DURATION,
  type Duration,
  DurationPicker,
  formatDuration,
  fromMinutes,
  toMinutes,
} from "./DurationPicker";
import { SearchIcon, SpinnerIcon } from "./icons";
import { ValidationReportView } from "./LoadToTable";
import { ruleCount } from "./ContractSummary";
import { RequestCard } from "./RequestList";
import { Alert, Dialog, EmptyState, Field, StatusPill, btn, inputClass } from "./ui";

export function AdminPanel() {
  return (
    <div className="mx-auto max-w-5xl px-4 pb-10 lg:px-6">
      <div className="py-4">
        <h1 className="text-2xl">Approvals</h1>
        <p className="mt-1 text-sm text-muted">
          Accounts, admin access, password resets, tables to onboard and loads into shared tables. Every decision is
          recorded.
        </p>
      </div>
      <Approvals />
    </div>
  );
}

/** The heading every page in this file shares. */
function PageHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="py-4">
      <h1 className="text-2xl">{title}</h1>
      <p className="mt-1 text-sm text-muted">{children}</p>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
        {title}
        <span className="rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-brand-contrast tabular">
          {count}
        </span>
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
  // the role each new account will get, when the admin changes it from what was asked
  const [grantRole, setGrantRole] = useState<Record<string, SessionUser["role"]>>({});
  const [resets, setResets] = useState<PasswordReset[]>([]);
  const [adminRequests, setAdminRequests] = useState<AdminRequest[]>([]);
  const [confirming, setConfirming] = useState<AdminRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{
    tone: "ok" | "bad";
    text: string;
  } | null>(null);
  const [rejecting, setRejecting] = useState<UploadRequest | null>(null);
  const [resetting, setResetting] = useState<PasswordReset | null>(null);
  const [report, setReport] = useState<UploadRequest | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, u, r, t, a] = await Promise.all([
        api<UploadRequest[]>("/admin/upload-requests"),
        api<SessionUser[]>("/admin/users?status=pending_approval"),
        api<PasswordReset[]>("/admin/password-resets"),
        api<OnboardedTarget[]>("/onboarding/targets"),
        api<AdminRequest[]>("/admin/admin-requests"),
      ]);
      setLoads(l);
      setTables(t.filter((x) => x.onboarding_status === "pending"));
      setUsers(u);
      setResets(r);
      setAdminRequests(a);
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
        setNotice({
          tone: "ok",
          text: `Loaded ${r.file_name} into ${r.target_database}.${r.target_table}.`,
        });
      } else {
        setNotice({
          tone: "bad",
          text: `The load failed: ${String(done.result?.error ?? "unknown error")}`,
        });
        if (done.validation_report && !done.validation_report.passed) setReport(done);
      }
    });

  if (!loads) return error ? <Alert>{error}</Alert> : <Loading />;
  const total = loads.length + tables.length + users.length + resets.length + adminRequests.length;

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
            <li
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4"
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {t.display_name}{" "}
                  <span className="text-xs font-normal text-muted">
                    ({TARGET_LABELS[t.target_type]} · {t.location})
                  </span>
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
            <li
              key={u.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4"
            >
              <div className="min-w-0">
                <p className="font-medium">{u.display_name}</p>
                <p className="text-xs text-muted">
                  {u.email} · @{u.username} · asked for {u.requested_role === "admin" ? "an admin" : "a user"} account{" "}
                  {timeAgo(u.created_at)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  aria-label={`Account type for ${u.display_name}`}
                  className={`${inputClass} h-9 w-auto py-0 font-normal`}
                  value={grantRole[u.id] ?? u.requested_role}
                  onChange={(e) =>
                    setGrantRole((g) => ({
                      ...g,
                      [u.id]: e.target.value as SessionUser["role"],
                    }))
                  }
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  type="button"
                  className={btn.primary}
                  disabled={busy !== null}
                  onClick={() =>
                    act(`${u.id}-ok`, () =>
                      api(`/admin/users/${u.id}/approve`, {
                        method: "POST",
                        json: { role: grantRole[u.id] ?? u.requested_role },
                      }),
                    )
                  }
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

      {adminRequests.length > 0 && (
        <Section title="Admin access" count={adminRequests.length}>
          {adminRequests.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4"
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {r.user_name} asks to be an admin for {formatDuration(r.duration_minutes)}
                </p>
                <p className="text-xs text-muted">
                  {r.user_email} · asked {timeAgo(r.created_at)}
                </p>
                {r.reason && <p className="mt-1 text-sm">“{r.reason}”</p>}
              </div>
              <div className="flex gap-2">
                <button type="button" className={btn.primary} disabled={busy !== null} onClick={() => setConfirming(r)}>
                  {busy === `${r.id}-ok` ? <SpinnerIcon /> : "Approve"}
                </button>
                <button
                  type="button"
                  className={btn.danger}
                  disabled={busy !== null}
                  onClick={() =>
                    act(`${r.id}-no`, () =>
                      api(`/admin/admin-requests/${r.id}/reject`, {
                        method: "POST",
                      }),
                    )
                  }
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
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4"
            >
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
            act(`${r.id}-reject`, () =>
              api(`/admin/upload-requests/${r.id}/reject`, {
                method: "POST",
                json: { review_note: note || null },
              }),
            );
          }}
        />
      )}
      {confirming && (
        <ConfirmAdminDialog
          request={confirming}
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            const r = confirming;
            setConfirming(null);
            act(`${r.id}-ok`, () => api(`/admin/admin-requests/${r.id}/approve`, { method: "POST" }));
          }}
        />
      )}
      {resetting && (
        <ResetDialog
          reset={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            setNotice({
              tone: "ok",
              text: `Password set for ${resetting.user_email}. Give it to them securely.`,
            });
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

/** Everything about an admin-access request, to check before granting it as asked. */
function ConfirmAdminDialog({
  request,
  onClose,
  onConfirm,
}: {
  request: AdminRequest;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const until = new Date(Date.now() + request.duration_minutes * 60_000).toISOString();
  const rows: [string, string][] = [
    ["Person", request.user_name],
    ["Email", request.user_email],
    ["Asked for", formatDuration(request.duration_minutes)],
    ["Admin until", `about ${dateTime(until)}`],
    ["Asked", `${dateTime(request.created_at)} (${timeAgo(request.created_at)})`],
    ["Why", request.reason || "No reason given"],
  ];
  return (
    <Dialog title="Approve admin access?" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm();
        }}
        className="flex flex-col gap-4"
      >
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 rounded-lg bg-surface p-4 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="break-words">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted">
          They can approve accounts and loads and onboard tables until then, and go back to being a user on their own.
          You can change or end it at any time from People.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.secondary} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={btn.primary}>
            Approve for {formatDuration(request.duration_minutes)}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Admin for a while, admin for good, or back to user. */
function AccessDialog({
  title,
  person,
  initial,
  onClose,
  onSave,
}: {
  title: string;
  person: string;
  /** minutes: null for permanent */
  initial: { role: SessionUser["role"]; minutes: number | null };
  onClose: () => void;
  onSave: (role: SessionUser["role"], minutes: number | null) => void;
}) {
  const [role, setRole] = useState(initial.role);
  const [permanent, setPermanent] = useState(initial.role === "admin" && initial.minutes === null);
  const [duration, setDuration] = useState<Duration>(initial.minutes ? fromMinutes(initial.minutes) : DEFAULT_DURATION);

  return (
    <Dialog title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(role, role === "admin" && !permanent ? toMinutes(duration) : null);
        }}
        className="flex flex-col gap-4"
      >
        <p className="text-sm text-muted">{person}</p>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Access
          <select
            className={`${inputClass} font-normal`}
            value={role}
            onChange={(e) => setRole(e.target.value as SessionUser["role"])}
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        {role === "admin" && (
          <>
            <fieldset className="flex flex-col gap-2 text-sm">
              <legend className="mb-1.5 font-medium">How long</legend>
              <label className="flex items-center gap-2">
                <input type="radio" checked={!permanent} onChange={() => setPermanent(false)} />
                For a set time
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={permanent} onChange={() => setPermanent(true)} />
                Permanently
              </label>
            </fieldset>
            {!permanent && <DurationPicker value={duration} onChange={setDuration} label="Time from now" />}
          </>
        )}
        <p className="text-xs text-muted">
          {role === "user"
            ? "Their admin rights end now."
            : permanent
              ? "They stay an admin until someone changes it."
              : `They go back to being a user after ${formatDuration(toMinutes(duration))}. You can change this at any time.`}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.secondary} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={btn.primary}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function RejectDialog({
  request,
  onClose,
  onReject,
}: {
  request: UploadRequest;
  onClose: () => void;
  onReject: (note: string) => void;
}) {
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
        <Field
          label="Note for them"
          value={note}
          onChange={setNote}
          hint="Optional, but it helps them fix it."
          autoFocus
        />
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
      await api(`/admin/password-resets/${reset.id}/resolve`, {
        method: "POST",
        json: { new_password: password },
      });
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
/** Every decided load, for everyone. Row-level errors only reach the requester and admins. */
export function LoadHistory() {
  const [rows, setRows] = useState<UploadRequest[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<UploadRequest[]>("/requests?status=reviewed")
      .then(setRows)
      .catch((e) => setError(errorText(e)));
  }, []);
  return (
    <div className="mx-auto max-w-5xl px-4 pb-10 lg:px-6">
      <PageHeader title="Load history">
        Every load an admin has decided on: who asked, who decided and what happened.
      </PageHeader>
      {error ? (
        <Alert>{error}</Alert>
      ) : !rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="No decisions yet">Approved and rejected loads show up here.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <RequestCard key={r.id} request={r}>
              {r.reviewed_at && <p className="mt-2 text-xs text-muted">Decided {dateTime(r.reviewed_at)}</p>}
            </RequestCard>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ people
/** Everyone active, and who the admins are. Admins also see status and manage access. */
export function People({ viewer }: { viewer: SessionUser }) {
  const isAdmin = viewer.role === "admin";
  const [users, setUsers] = useState<SessionUser[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<SessionUser | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | SessionUser["role"]>("all");

  const load = useCallback(() => {
    // non-admins get the directory: active people only, no sign-in details
    api<SessionUser[]>(isAdmin ? "/admin/users" : "/people")
      .then(setUsers)
      .catch((e) => setError(errorText(e)));
  }, [isAdmin]);
  useEffect(load, [load]);

  async function setAccess(user: SessionUser, role: SessionUser["role"], minutes: number | null) {
    setEditing(null);
    setBusy(user.id);
    setError("");
    try {
      await api(`/admin/users/${user.id}/access`, {
        method: "PUT",
        json: { role, duration_minutes: minutes },
      });
      load();
      notifyPendingChanged(); // a waiting request for them is answered by this
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

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

  const shown = useMemo(() => {
    // every word must match somewhere: "jane doe" finds Jane Doe, "corp.com" everyone there
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (users ?? []).filter(
      (u) =>
        (roleFilter === "all" || u.role === roleFilter) &&
        words.every((w) => `${u.display_name} ${u.email} ${u.username}`.toLowerCase().includes(w)),
    );
  }, [users, query, roleFilter]);

  const header = (
    <PageHeader title="People">
      {isAdmin
        ? "Everyone with an account. Change someone's access, or suspend them."
        : "Everyone in DataDesk, and who the admins are. Ask an admin to approve your loads."}
    </PageHeader>
  );
  if (!users)
    return (
      <div className="mx-auto max-w-5xl px-4 pb-10 lg:px-6">
        {header}
        {error ? <Alert>{error}</Alert> : <Loading />}
      </div>
    );
  return (
    <div className="mx-auto max-w-5xl px-4 pb-10 lg:px-6">
      {header}
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="relative min-w-60 flex-1">
          <span className="sr-only">Search people</span>
          <SearchIcon
            width={18}
            height={18}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, email or username"
            className={`${inputClass} pl-9`}
            autoFocus
          />
        </label>
        <div role="group" aria-label="Show" className="flex gap-1 rounded-full bg-surface p-1">
          {(
            [
              ["all", "All"],
              ["admin", "Admins"],
              ["user", "Users"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={roleFilter === key}
              onClick={() => setRoleFilter(key)}
              className={`rounded-full px-3 py-1 text-sm font-medium ${
                roleFilter === key ? "bg-bg text-fg shadow-sm" : "text-muted hover:text-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-sm text-muted tabular" aria-live="polite">
          {shown.length === users.length ? `${users.length} people` : `${shown.length} of ${users.length}`}
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-semibold">Person</th>
              <th className="px-4 py-2 font-semibold">Access</th>
              {isAdmin && (
                <>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold">Last sign-in</th>
                  <th className="px-4 py-2" />
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {shown.map((u) => (
              <tr key={u.id} className="border-t border-line">
                <td className="px-4 py-2.5">
                  <p className="font-medium">
                    {u.display_name}
                    {u.id === viewer.id && <span className="ml-1.5 text-xs font-normal text-muted">(you)</span>}
                  </p>
                  <p className="text-xs text-muted">
                    {u.email} · @{u.username}
                  </p>
                </td>
                <td className="px-4 py-2.5">
                  {u.status === "pending_approval" ? (
                    <span className="capitalize">{u.requested_role} (asked)</span>
                  ) : (
                    accessLabel(u)
                  )}
                </td>
                {isAdmin && (
                  <>
                    <td className="px-4 py-2.5">
                      <StatusPill status={u.status} />
                    </td>
                    <td className="px-4 py-2.5 text-muted">{u.last_login_at ? timeAgo(u.last_login_at) : "Never"}</td>
                    <td className="px-4 py-2.5 text-right">
                      {u.id !== viewer.id &&
                        (u.status === "active" ? (
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              className={btn.secondary}
                              disabled={busy !== null}
                              onClick={() => setEditing(u)}
                            >
                              Change access
                            </button>
                            <button
                              type="button"
                              className={btn.danger}
                              disabled={busy !== null}
                              onClick={() => setStatus(u, "suspend")}
                            >
                              Suspend
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className={btn.secondary}
                            disabled={busy !== null}
                            onClick={() => setStatus(u, "approve")}
                          >
                            {u.status === "pending_approval" ? "Approve" : "Reactivate"}
                          </button>
                        ))}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <p className="border-t border-line px-4 py-8 text-center text-sm text-muted">
            Nobody matches{query.trim() ? ` “${query.trim()}”` : ""}.
          </p>
        )}
      </div>
      {editing && (
        <AccessDialog
          title="Change access"
          person={`${editing.display_name} · ${editing.email}`}
          initial={{
            role: editing.role,
            minutes:
              editing.role === "admin" && editing.admin_until
                ? Math.max(1, Math.round((new Date(editing.admin_until).getTime() - Date.now()) / 60_000))
                : null,
          }}
          onClose={() => setEditing(null)}
          onSave={(role, minutes) => setAccess(editing, role, minutes)}
        />
      )}
    </div>
  );
}
