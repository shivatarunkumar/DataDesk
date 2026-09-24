"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "@/lib/api";
import { TARGET_LABELS, timeAgo } from "@/lib/format";
import type { OnboardedTarget, TargetType } from "@/lib/types";
import { ruleCount } from "./ContractSummary";
import { onboardingState } from "./TargetEditor";
import { DatabaseIcon, PlusIcon, SearchIcon, SpinnerIcon } from "./icons";
import { Alert, EmptyState, StatusPill, btn } from "./ui";

const CREATED: Record<string, string> = {
  onboarded: "Table onboarded. It now appears in everyone's “Load to table” list.",
  requested: "Request sent. An admin reviews it; you'll see it here as “pending” until then.",
  approved: "Approved and onboarded. It now appears in everyone's “Load to table” list.",
  rejected: "Request rejected. The requester sees your note.",
};

export function OnboardingList({ isAdmin }: { isAdmin: boolean }) {
  const created = useSearchParams().get("created");
  const [targets, setTargets] = useState<OnboardedTarget[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [source, setSource] = useState<"" | TargetType>("");
  const [state, setState] = useState<"" | "active" | "paused" | "pending">("");
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    api<OnboardedTarget[]>("/onboarding/targets")
      .then(setTargets)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  async function toggle(t: OnboardedTarget) {
    setBusy(t.id);
    setError("");
    try {
      await api(`/onboarding/targets/${t.id}`, { method: "PATCH", json: { is_active: !t.is_active } });
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const q = query.trim().toLowerCase();
  const shown = (targets ?? []).filter(
    (t) =>
      (!source || t.target_type === source) &&
      (!state || onboardingState(t) === state) &&
      (!q || `${t.display_name} ${t.location} ${t.description ?? ""}`.toLowerCase().includes(q)),
  );
  const countOf = (type: TargetType) => (targets ?? []).filter((t) => t.target_type === type).length;
  const filtered = Boolean(source || state || q);

  return (
    <div className="mx-auto max-w-6xl px-4 pb-10 lg:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 py-4">
        <div>
          <h1 className="text-2xl">Onboarding</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Tables people can load their files into. Each has a data contract: a file must pass it, and the
            table&apos;s schema, before a load request reaches an admin.
            {!isAdmin && " Missing a table? Ask for it; an admin approves it before it opens for loads."}
          </p>
        </div>
        <Link href="/onboarding/new" className={btn.primary}>
          <PlusIcon width={18} height={18} />
          {isAdmin ? "Onboard a table" : "Ask for a table"}
        </Link>
      </div>

      {created && CREATED[created] && (
        <div className="mb-4">
          <Alert tone={created === "rejected" ? "info" : "ok"}>{CREATED[created]}</Alert>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}

      {!targets ? (
        !error && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <SpinnerIcon /> Loading…
          </p>
        )
      ) : targets.length === 0 ? (
        <EmptyState title="Nothing onboarded yet">
          <p>Onboard a BigQuery or PostgreSQL table so people can send data to it.</p>
          <Link href="/onboarding/new" className={`${btn.primary} mt-5`}>
            <PlusIcon width={18} height={18} />
            {isAdmin ? "Onboard a table" : "Ask for a table"}
          </Link>
        </EmptyState>
      ) : (
        <>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as "" | TargetType)}
            aria-label="Filter by source"
            className="h-9 rounded-lg border border-line bg-bg px-2 text-sm outline-none focus:border-brand"
          >
            <option value="">All sources ({targets.length})</option>
            {(["bigquery", "postgres", "oracle"] as const).map((type) => (
              <option key={type} value={type} disabled={countOf(type) === 0}>
                {TARGET_LABELS[type]} ({countOf(type)})
              </option>
            ))}
          </select>
          <select
            value={state}
            onChange={(e) => setState(e.target.value as typeof state)}
            aria-label="Filter by status"
            className="h-9 rounded-lg border border-line bg-bg px-2 text-sm outline-none focus:border-brand"
          >
            <option value="">Any status</option>
            <option value="active">Open for loads</option>
            <option value="paused">Paused</option>
            <option value="pending">Waiting for approval</option>
          </select>
          <label className="flex h-9 min-w-56 flex-1 items-center gap-2 rounded-lg border border-line px-3 focus-within:border-brand sm:max-w-xs">
            <SearchIcon width={16} height={16} className="text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, dataset, table"
              aria-label="Search onboarded tables"
              className="w-full bg-transparent text-sm outline-none"
            />
          </label>
          {filtered && (
            <button
              type="button"
              className="text-sm font-medium text-brand hover:underline"
              onClick={() => {
                setSource("");
                setState("");
                setQuery("");
              }}
            >
              Clear
            </button>
          )}
          <span className="ml-auto text-xs text-muted">
            {shown.length} of {targets.length}
          </span>
        </div>
        {shown.length === 0 ? (
          <EmptyState title="Nothing matches those filters" />
        ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-semibold">Table</th>
                <th className="px-4 py-2 font-semibold">Contract</th>
                <th className="px-4 py-2 font-semibold">Loads</th>
                <th className="px-4 py-2 font-semibold">Requests</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id} className="border-t border-line align-top hover:bg-surface/60">
                  <td className="px-4 py-3">
                    <Link href={`/onboarding/${t.id}`} className="flex items-start gap-3">
                      <DatabaseIcon width={20} height={20} className="mt-0.5 shrink-0 text-brand" />
                      <span className="min-w-0">
                        <span className="block font-medium hover:underline">{t.display_name}</span>
                        <span className="block text-xs text-muted">
                          {TARGET_LABELS[t.target_type]} · {t.location}
                        </span>
                        {t.onboarding_status !== "approved" && (
                          <span className="block text-xs text-muted">
                            Asked for by {t.is_mine ? "you" : t.requested_by_name} {timeAgo(t.created_at)}
                          </span>
                        )}
                      </span>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-medium">v{t.contract_version}</span>
                    <span className="block text-xs text-muted">
                      {ruleCount(t.contract)} rule{ruleCount(t.contract) === 1 ? "" : "s"} · edited {timeAgo(t.updated_at)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {t.write_modes.map((m) => (m === "upsert" ? `upsert on ${t.key_columns.join(", ")}` : "append")).join(" · ")}
                  </td>
                  <td className="px-4 py-3 text-muted tabular">{t.request_count}</td>
                  <td className="px-4 py-3">
                    <StatusPill status={onboardingState(t)} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="flex justify-end gap-2">
                      <Link
                        href={`/onboarding/${t.id}`}
                        className={isAdmin && t.onboarding_status === "pending" ? btn.primary : btn.secondary}
                      >
                        {isAdmin && t.onboarding_status === "pending" ? "Review" : t.can_edit ? "Edit" : "View"}
                      </Link>
                      {isAdmin && t.onboarding_status === "approved" && (
                        <button type="button" className={btn.quiet} disabled={busy !== null} onClick={() => toggle(t)}>
                          {t.is_active ? "Pause" : "Open"}
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
        </>
      )}
    </div>
  );
}
