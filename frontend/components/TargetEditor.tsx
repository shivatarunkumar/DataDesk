"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { api, errorText } from "@/lib/api";
import { TARGET_LABELS, timeAgo } from "@/lib/format";
import { notifyPendingChanged } from "@/lib/pending";
import type { AccessReport, ColumnRule, OnboardedTarget, SourceTable, TableColumn, TargetType } from "@/lib/types";
import { ArrowLeftIcon, CheckIcon, CloseIcon, SaveIcon, ShieldIcon, SpinnerIcon } from "./icons";
import { ContractSummary } from "./ContractSummary";
import { Alert, Dialog, Field, StatusPill, btn, inputClass } from "./ui";

/** What the inputs hold: text, so a half-typed number doesn't vanish. */
type Draft = {
  required: boolean;
  unique: boolean;
  enum: string;
  regex: string;
  min: string;
  max: string;
  min_length: string;
  max_length: string;
  description: string;
};

const EMPTY: Draft = {
  required: false,
  unique: false,
  enum: "",
  regex: "",
  min: "",
  max: "",
  min_length: "",
  max_length: "",
  description: "",
};

const SOURCES: { value: TargetType; hint: string }[] = [
  { value: "bigquery", hint: "A table in a BigQuery dataset" },
  { value: "postgres", hint: "A table on the target Postgres server" },
  { value: "oracle", hint: "Coming soon" },
];

const cell = "h-8 w-full rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-brand";

function isNumeric(type: string) {
  return /int|numeric|decimal|float|double|real|bignumeric/i.test(type);
}
function isText(type: string) {
  return /char|text|string/i.test(type);
}

function toDraft(rule: ColumnRule | undefined): Draft {
  if (!rule) return EMPTY;
  const str = (v: number | null | undefined) => (v == null ? "" : String(v));
  return {
    required: Boolean(rule.required),
    unique: Boolean(rule.unique),
    enum: (rule.enum ?? []).join(", "),
    regex: rule.regex ?? "",
    min: str(rule.min),
    max: str(rule.max),
    min_length: str(rule.min_length),
    max_length: str(rule.max_length),
    description: rule.description ?? "",
  };
}

function toRule(name: string, d: Draft): ColumnRule {
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  return {
    name,
    required: d.required,
    unique: d.unique,
    enum: d.enum.trim() ? d.enum.split(",").map((v) => v.trim()).filter(Boolean) : null,
    regex: d.regex.trim() || null,
    min: num(d.min),
    max: num(d.max),
    min_length: num(d.min_length),
    max_length: num(d.max_length),
    description: d.description.trim() || null,
  };
}

function humanize(table: string) {
  const words = table.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function TargetEditor({ targetId, isAdmin }: { targetId?: string; isAdmin: boolean }) {
  const router = useRouter();
  const editing = Boolean(targetId);

  const [existing, setExisting] = useState<OnboardedTarget | null>(null);
  const [type, setType] = useState<TargetType | "">("");
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [database, setDatabase] = useState("");
  const [tables, setTables] = useState<SourceTable[] | null>(null);
  const [tableKey, setTableKey] = useState(""); // "schema.table" or "table"
  const [columns, setColumns] = useState<TableColumn[] | null>(null);
  const [loadingColumns, setLoadingColumns] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [maxRows, setMaxRows] = useState("");
  const [modes, setModes] = useState<("append" | "upsert")[]>(["append"]);
  const [keys, setKeys] = useState<string[]>([]);
  const [active, setActive] = useState(true);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [access, setAccess] = useState<AccessReport | null>(null);
  const [testing, setTesting] = useState(false);
  const [reason, setReason] = useState("");
  const [deciding, setDeciding] = useState<"approve" | "reject" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [triedSubmit, setTriedSubmit] = useState(false);

  // editing: load the target, its columns and its contract
  useEffect(() => {
    if (!targetId) return;
    api<OnboardedTarget>(`/onboarding/targets/${targetId}`)
      .then((t) => {
        setExisting(t);
        setType(t.target_type);
        setDatabase(t.database_name);
        setTableKey(t.schema_name ? `${t.schema_name}.${t.table_name}` : t.table_name);
        setColumns(t.schema_snapshot ?? []);
        setDisplayName(t.display_name);
        setDescription(t.description ?? "");
        setDrafts(Object.fromEntries(t.contract.columns.map((c) => [c.name, toDraft(c)])));
        setMaxRows(t.contract.max_rows ? String(t.contract.max_rows) : "");
        setModes(t.write_modes);
        setKeys(t.key_columns);
        setActive(t.is_active);
        setReason(t.request_reason ?? "");
      })
      .catch((e) => setError(errorText(e)));
  }, [targetId]);

  // creating: the source pickers, each step loading the next list
  useEffect(() => {
    if (editing || !type || type === "oracle") return;
    setDatabases(null);
    api<string[]>(`/onboarding/sources/${type}/databases`)
      .then(setDatabases)
      .catch((e) => setError(errorText(e)));
  }, [type, editing]);

  useEffect(() => {
    if (editing || !type || !database) return;
    setTables(null);
    api<SourceTable[]>(`/onboarding/sources/${type}/databases/${encodeURIComponent(database)}/tables`)
      .then(setTables)
      .catch((e) => setError(errorText(e)));
  }, [type, database, editing]);

  const chosenTable = tables?.find((t) => (t.schema_name ? `${t.schema_name}.${t.table}` : t.table) === tableKey);

  useEffect(() => {
    if (editing || !chosenTable) return;
    setLoadingColumns(true);
    setColumns(null);
    const qs = chosenTable.schema_name ? `?schema=${encodeURIComponent(chosenTable.schema_name)}` : "";
    api<TableColumn[]>(
      `/onboarding/sources/${type}/databases/${encodeURIComponent(database)}/tables/${encodeURIComponent(chosenTable.table)}/columns${qs}`,
    )
      .then((cols) => {
        setColumns(cols);
        setDrafts({});
        setKeys([]);
        setDisplayName((name) => name || humanize(chosenTable.table));
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoadingColumns(false));
  }, [chosenTable, type, database, editing]);

  const draftOf = (name: string) => drafts[name] ?? EMPTY;
  const setDraft = (name: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [name]: { ...(d[name] ?? EMPTY), ...patch } }));

  const ruleColumns = (columns ?? []).map((c) => toRule(c.name, draftOf(c.name)));

  const pending = existing?.onboarding_status === "pending";
  const reviewing = isAdmin && pending;
  const asking = !isAdmin && (!editing || pending);

  /** Save what is on screen; returns the saved target, or null when something was wrong. */
  async function persist(): Promise<OnboardedTarget | null> {
    setError("");
    setSaved("");
    if (!columns) return (setError("Pick a table first."), null);
    if (modes.includes("upsert") && keys.length === 0) return (setError("Upsert needs key columns: pick them under Loading."), null);
    if (asking && !reason.trim()) {
      setTriedSubmit(true);
      setError("Say why this table is needed: the admin reviewing it sees this.");
      document.getElementById("request-reason")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return null;
    }
    const contract = { columns: ruleColumns, max_rows: maxRows.trim() ? Number(maxRows) : null };
    try {
      if (editing && existing) {
        const updated = await api<OnboardedTarget>(`/onboarding/targets/${existing.id}`, {
          method: "PATCH",
          json: {
            display_name: displayName,
            description,
            write_modes: modes,
            key_columns: keys,
            contract,
            ...(isAdmin ? { is_active: active } : {}),
            ...(pending ? { request_reason: reason } : {}),
          },
        });
        setExisting(updated);
        return updated;
      }
      return await api<OnboardedTarget>("/onboarding/targets", {
        method: "POST",
        json: {
          target_type: type,
          database_name: database,
          schema_name: chosenTable?.schema_name ?? null,
          table_name: chosenTable?.table,
          display_name: displayName,
          description: description || null,
          write_modes: modes,
          key_columns: keys,
          contract,
          is_active: active,
          request_reason: reason.trim() || null,
        },
      });
    } catch (err) {
      setError(errorText(err));
      if ((err as { field?: string }).field === "access") testAccess();
      return null;
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    const before = existing;
    const result = await persist();
    setSaving(false);
    if (!result) return;
    if (!editing) {
      router.push(`/onboarding?created=${isAdmin ? "onboarded" : "requested"}`);
      return;
    }
    setSaved(
      before && result.contract_version !== before.contract_version
        ? `Saved. The contract is now v${result.contract_version}; new requests are checked against it.`
        : "Saved.",
    );
  }

  async function decide(action: "approve" | "reject", note?: string) {
    if (!existing) return;
    setDeciding(action);
    // approving takes the contract as it is on screen, so an admin can adjust it first
    const current = action === "approve" ? await persist() : existing;
    if (current) {
      try {
        const done = await api<OnboardedTarget>(`/onboarding/targets/${existing.id}/${action}`, {
          method: "POST",
          json: { review_note: note || null },
        });
        setExisting(done);
        notifyPendingChanged();
        router.push(`/onboarding?created=${action === "approve" ? "approved" : "rejected"}`);
      } catch (err) {
        setError(errorText(err));
      }
    }
    setDeciding(null);
  }

  // a result is only true for the table, modes and key it was run with
  const accessKey = `${type}|${database}|${tableKey}|${modes.join()}|${keys.join()}`;
  useEffect(() => setAccess(null), [accessKey]);

  async function testAccess() {
    setTesting(true);
    setError("");
    try {
      const [schemaName, tableName] = existing
        ? [existing.schema_name, existing.table_name]
        : [chosenTable?.schema_name ?? null, chosenTable?.table ?? ""];
      setAccess(
        await api<AccessReport>(`/onboarding/sources/${type}/access-check`, {
          method: "POST",
          json: { database_name: database, schema_name: schemaName, table_name: tableName, write_modes: modes, key_columns: keys },
        }),
      );
      setTimeout(() => document.getElementById("access-report")?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setTesting(false);
    }
  }

  const location = existing?.location ?? [database, chosenTable?.schema_name, chosenTable?.table].filter(Boolean).join(".");

  // Sending, onboarding or approving needs a passing access check for exactly what is on
  // screen (the result clears when the table, modes or key change). The server checks again.
  const loadsChanged =
    !!existing && (modes.join() !== existing.write_modes.join() || keys.join() !== existing.key_columns.join());
  const needsAccess = !editing || reviewing || loadsChanged;
  const accessOk = access?.ok === true;
  const blocked = needsAccess && !accessOk;

  if (editing && existing && !existing.can_edit) return <TargetView target={existing} />;

  return (
    <form onSubmit={save} className="mx-auto max-w-6xl px-4 pb-16 lg:px-6">
      <div className="flex flex-wrap items-center gap-3 py-4">
        <Link href="/onboarding" className={btn.icon} aria-label="Back to onboarding">
          <ArrowLeftIcon width={20} height={20} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl">
            {editing ? (existing?.display_name ?? "…") : isAdmin ? "Onboard a table" : "Ask for a table to be onboarded"}
          </h1>
          <p className="text-sm text-muted">
            {editing && existing
              ? `${TARGET_LABELS[existing.target_type]} · ${existing.location}${pending ? "" : ` · contract v${existing.contract_version}`}`
              : isAdmin
                ? "Choose the table, write its data contract, and open it for loads."
                : "Choose the table and propose its data contract. An admin reviews it before anyone can load into it."}
          </p>
        </div>
        {existing && <StatusPill status={onboardingState(existing)} />}
      </div>

      {existing && pending && (
        <div className="mb-4 rounded-xl border border-warn/40 bg-warn/10 p-4 text-sm">
          <p className="font-medium">
            {reviewing
              ? `${existing.requested_by_name ?? "Someone"} asked for this table ${timeAgo(existing.created_at)}`
              : "Waiting for an admin to review it. You can still change it until then."}
          </p>
          {reviewing && existing.request_reason && <p className="mt-1 italic">&ldquo;{existing.request_reason}&rdquo;</p>}
          {reviewing && (
            <p className="mt-1 text-muted">
              Check the contract and loading rules, run Test access, then approve it (your edits are saved with it) or
              reject it with a note.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}

      {/* 1. source */}
      <Section step={1} title="Source">
        {editing ? (
          <p className="text-sm">
            <span className="font-medium">{existing && TARGET_LABELS[existing.target_type]}</span>{" "}
            <span className="text-muted">·</span> {existing?.location}
            <span className="block text-xs text-muted">To point at another table, onboard it separately.</span>
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-2 sm:grid-cols-3">
              {SOURCES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  disabled={s.value === "oracle"}
                  onClick={() => {
                    setType(s.value);
                    setDatabase("");
                    setTableKey("");
                    setColumns(null);
                    setError("");
                  }}
                  className={`rounded-xl border px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-50 ${
                    type === s.value ? "border-brand bg-brand/5 ring-1 ring-brand" : "border-line hover:bg-surface"
                  }`}
                >
                  <span className="block text-sm font-semibold">{TARGET_LABELS[s.value]}</span>
                  <span className="block text-xs text-muted">{s.hint}</span>
                </button>
              ))}
            </div>
            {type && type !== "oracle" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  {type === "bigquery" ? "Dataset" : "Database"}
                  <select
                    className={`${inputClass} font-normal`}
                    value={database}
                    disabled={!databases}
                    onChange={(e) => {
                      setDatabase(e.target.value);
                      setTableKey("");
                      setColumns(null);
                    }}
                  >
                    <option value="">{databases ? "Choose…" : "Loading…"}</option>
                    {(databases ?? []).map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Table
                  <select
                    className={`${inputClass} font-normal`}
                    value={tableKey}
                    disabled={!database || !tables}
                    onChange={(e) => setTableKey(e.target.value)}
                  >
                    <option value="">{database && !tables ? "Loading…" : "Choose…"}</option>
                    {(tables ?? []).map((t) => {
                      const key = t.schema_name ? `${t.schema_name}.${t.table}` : t.table;
                      return (
                        <option key={key} value={key} disabled={Boolean(t.onboarded_id)}>
                          {key}
                          {t.onboarded_id ? " — already onboarded" : ""}
                        </option>
                      );
                    })}
                  </select>
                </label>
              </div>
            )}
            {loadingColumns && (
              <p className="flex items-center gap-2 text-sm text-muted">
                <SpinnerIcon /> Reading the table&apos;s columns…
              </p>
            )}
          </div>
        )}
      </Section>

      {columns && (
        <>
          {/* 2. details */}
          <Section step={2} title="How people will see it">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name in the dropdown" value={displayName} onChange={setDisplayName} placeholder="Customer master" />
              <Field
                label="Description"
                value={description}
                onChange={setDescription}
                placeholder="What belongs in this table, who owns it"
              />
            </div>
            <p className="mt-2 text-xs text-muted">Location: {location}</p>
            {asking && (
              <label id="request-reason" className="mt-4 flex flex-col gap-1.5 text-sm font-medium">
                <span>
                  Why is this table needed? <span className="text-bad">*</span>
                </span>
                <textarea
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setError("");
                  }}
                  placeholder="Our team sends the monthly customer segment file here"
                  aria-invalid={triedSubmit && !reason.trim()}
                  className={`${inputClass} h-20 py-2 font-normal`}
                />
                <span className={`text-xs font-normal ${triedSubmit && !reason.trim() ? "text-bad" : "text-muted"}`}>
                  {triedSubmit && !reason.trim()
                    ? "Required: the admin reviewing the request needs to know why."
                    : "Required. The admin reviewing the request sees this."}
                </span>
              </label>
            )}
          </Section>

          {/* 3. contract */}
          <Section
            step={3}
            title="Data contract"
            hint="Checked on every file, on top of the table's own schema (types, NOT NULL). Leave a field empty for no rule."
          >
            {columns.length === 0 ? (
              <p className="text-sm text-muted">The table has no columns.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full min-w-[1000px] text-sm">
                  <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Column</th>
                      <th className="px-2 py-2 text-center font-semibold" title="The column must be in the file and every value filled">
                        Required
                      </th>
                      <th className="px-2 py-2 text-center font-semibold" title="No value may repeat within the file">
                        Unique
                      </th>
                      <th className="px-2 py-2 font-semibold">Allowed values</th>
                      <th className="px-2 py-2 font-semibold">Pattern (regex)</th>
                      <th className="px-2 py-2 font-semibold">Range / length</th>
                      <th className="px-2 py-2 font-semibold">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns.map((c) => {
                      const d = draftOf(c.name);
                      const numeric = isNumeric(c.type);
                      const text = isText(c.type);
                      return (
                        <tr key={c.name} className="border-t border-line align-top">
                          <td className="px-3 py-2">
                            <span className="font-medium">{c.name}</span>
                            <span className="block text-xs text-muted">
                              {c.type.toLowerCase()}
                              {c.nullable ? "" : " · not null"}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              className="mt-2 h-4 w-4 accent-[var(--brand)]"
                              checked={d.required || !c.nullable}
                              disabled={!c.nullable}
                              title={c.nullable ? undefined : "NOT NULL in the table already"}
                              onChange={(e) => setDraft(c.name, { required: e.target.checked })}
                              aria-label={`${c.name} required`}
                            />
                          </td>
                          <td className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              className="mt-2 h-4 w-4 accent-[var(--brand)]"
                              checked={d.unique}
                              onChange={(e) => setDraft(c.name, { unique: e.target.checked })}
                              aria-label={`${c.name} unique`}
                            />
                          </td>
                          <td className="px-2 py-2">
                            <input
                              className={cell}
                              value={d.enum}
                              onChange={(e) => setDraft(c.name, { enum: e.target.value })}
                              placeholder="a, b, c"
                              aria-label={`${c.name} allowed values`}
                            />
                          </td>
                          <td className="px-2 py-2">
                            <input
                              className={`${cell} font-mono text-xs`}
                              value={d.regex}
                              onChange={(e) => setDraft(c.name, { regex: e.target.value })}
                              placeholder="regex"
                              aria-label={`${c.name} pattern`}
                            />
                          </td>
                          <td className="px-2 py-2">
                            {numeric ? (
                              <RangeInputs
                                label="value"
                                min={d.min}
                                max={d.max}
                                onMin={(v) => setDraft(c.name, { min: v })}
                                onMax={(v) => setDraft(c.name, { max: v })}
                                name={c.name}
                              />
                            ) : text ? (
                              <RangeInputs
                                label="length"
                                min={d.min_length}
                                max={d.max_length}
                                onMin={(v) => setDraft(c.name, { min_length: v })}
                                onMax={(v) => setDraft(c.name, { max_length: v })}
                                name={c.name}
                                integer
                              />
                            ) : (
                              <span className="block pt-2 text-xs text-muted">checked by type</span>
                            )}
                          </td>
                          <td className="px-2 py-2">
                            <input
                              className={cell}
                              value={d.description}
                              onChange={(e) => setDraft(c.name, { description: e.target.value })}
                              placeholder="Shown to uploaders"
                              aria-label={`${c.name} note`}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-4 max-w-xs">
              <Field
                label="Most rows per file"
                type="number"
                value={maxRows}
                onChange={setMaxRows}
                placeholder="No limit"
                hint="Optional. Larger files are refused before review."
              />
            </div>
          </Section>

          {/* 4. loading */}
          <Section step={4} title="Loading">
            <div className="flex flex-wrap gap-4">
              {(["append", "upsert"] as const).map((m) => (
                <label key={m} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-[var(--brand)]"
                    checked={modes.includes(m)}
                    onChange={(e) =>
                      setModes((cur) => {
                        const next = e.target.checked ? [...cur, m] : cur.filter((x) => x !== m);
                        return next.length ? next : cur; // at least one
                      })
                    }
                  />
                  <span>
                    <span className="font-medium">{m === "append" ? "Append" : "Upsert"}</span>
                    <span className="block text-xs text-muted">
                      {m === "append" ? "Every row is inserted as new" : "Matching keys update, the rest insert"}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {modes.includes("upsert") && (
              <div className="mt-4">
                <p className="mb-2 text-sm font-medium">Key columns</p>
                <div className="flex flex-wrap gap-1.5">
                  {columns.map((c) => {
                    const on = keys.includes(c.name);
                    return (
                      <button
                        key={c.name}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setKeys((k) => (on ? k.filter((x) => x !== c.name) : [...k, c.name]))}
                        className={`rounded-full px-3 py-1 text-xs font-medium ${
                          on ? "bg-brand text-brand-contrast" : "bg-surface text-muted hover:bg-surface-hover hover:text-fg"
                        }`}
                      >
                        {c.name}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-xs text-muted">Uploaders can&apos;t change these: every upsert matches on them.</p>
              </div>
            )}
            {isAdmin && (
            <label className="mt-5 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-[var(--brand)]"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              <span>
                <span className="font-medium">Open for loads</span>
                <span className="block text-xs text-muted">
                  Everyone can pick it in &ldquo;Load to table&rdquo;. Untick to pause it without losing the contract.
                </span>
              </span>
            </label>
            )}
          </Section>

          {access && <AccessResults report={access} upsert={modes.includes("upsert")} />}

          <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-3 border-t border-line bg-bg px-4 py-3 lg:-mx-6 lg:px-6">
            <button type="button" className={btn.secondary} onClick={testAccess} disabled={testing}>
              {testing ? <SpinnerIcon /> : <ShieldIcon width={16} height={16} />}
              {testing ? "Testing…" : access ? "Test again" : "Test access"}
            </button>
            <button
              type="submit"
              className={reviewing ? btn.secondary : btn.primary}
              disabled={saving || deciding !== null || !displayName.trim() || (blocked && !reviewing)}
              title={blocked && !reviewing ? "Run Test access first: every check must pass" : undefined}
            >
              {saving ? <SpinnerIcon /> : <SaveIcon width={16} height={16} />}
              {editing ? "Save changes" : isAdmin ? "Onboard table" : "Send for approval"}
            </button>
            {reviewing && (
              <>
                <button
                  type="button"
                  className={btn.primary}
                  disabled={deciding !== null || !accessOk}
                  title={accessOk ? undefined : "Run Test access first: every check must pass"}
                  onClick={() => decide("approve")}
                >
                  {deciding === "approve" ? <SpinnerIcon /> : <CheckIcon width={16} height={16} />}
                  Approve &amp; onboard
                </button>
                <button type="button" className={btn.danger} disabled={deciding !== null} onClick={() => setRejecting(true)}>
                  Reject
                </button>
              </>
            )}
            <Link href="/onboarding" className={btn.secondary}>
              Cancel
            </Link>
            {error && (
              <span role="alert" className="flex items-center gap-1 text-sm text-bad">
                <CloseIcon width={16} height={16} /> {error}
              </span>
            )}
            {!error && asking && !reason.trim() && (
              <span className="text-sm text-muted">
                Fill in <span className="font-medium text-fg">why this table is needed</span> to send it.
              </span>
            )}
            {!error && needsAccess && !access && !saved && (
              <span className="text-sm text-muted">
                Run <span className="font-medium text-fg">Test access</span> first: every check must pass before{" "}
                {reviewing ? "you can approve" : editing ? "these loading changes can be saved" : "it can be sent"}.
              </span>
            )}
            {!error && access && !saved && (
              <span className={`flex items-center gap-1 text-sm ${access.ok ? "text-ok" : "text-bad"}`}>
                {access.ok ? <CheckIcon width={16} height={16} /> : <CloseIcon width={16} height={16} />}
                {access.ok
                  ? access.checks.some((c) => c.warning)
                    ? "Access checks passed, with a warning"
                    : "DataDesk has every access these loads need"
                  : `${access.checks.filter((c) => !c.ok).length} access check(s) failed: fix them, then test again`}
              </span>
            )}
            {saved && (
              <span className="flex items-center gap-1 text-sm text-ok">
                <CheckIcon width={16} height={16} /> {saved}
              </span>
            )}
          </div>
        </>
      )}
      {rejecting && existing && (
        <RejectTargetDialog
          target={existing}
          onClose={() => setRejecting(false)}
          onReject={(note) => {
            setRejecting(false);
            decide("reject", note);
          }}
        />
      )}
    </form>
  );
}

/** "active", "paused", "pending", "rejected": what the status pill says. */
export function onboardingState(t: OnboardedTarget): string {
  if (t.onboarding_status !== "approved") return t.onboarding_status;
  return t.is_active ? "active" : "paused";
}

function RejectTargetDialog({
  target,
  onClose,
  onReject,
}: {
  target: OnboardedTarget;
  onClose: () => void;
  onReject: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <Dialog title="Reject this request?" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          {target.requested_by_name ?? "Someone"} asked to onboard {target.location}.
        </p>
        <Field label="Note for them" value={note} onChange={setNote} hint="Say what would make it acceptable." autoFocus />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.secondary} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btn.danger} onClick={() => onReject(note.trim())}>
            Reject
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** What someone who can't change an onboarded table sees: everything about it, read-only. */
function TargetView({ target: t }: { target: OnboardedTarget }) {
  const open = t.onboarding_status === "approved" && t.is_active;
  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 lg:px-6">
      <div className="flex flex-wrap items-start gap-3 py-4">
        <Link href="/onboarding" className={btn.icon} aria-label="Back to onboarding">
          <ArrowLeftIcon width={20} height={20} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl">{t.display_name}</h1>
          <p className="text-sm text-muted">
            {TARGET_LABELS[t.target_type]} · {t.location}
            {t.onboarding_status === "approved" ? ` · contract v${t.contract_version}` : ""}
          </p>
        </div>
        <StatusPill status={onboardingState(t)} />
      </div>

      {t.onboarding_status === "rejected" && (
        <div className="mb-4">
          <Alert>
            {t.reviewed_by_name ?? "An admin"} rejected this request {timeAgo(t.reviewed_at)}
            {t.review_note ? `: “${t.review_note}”` : "."} You can ask again with a changed contract.
          </Alert>
        </div>
      )}
      {t.onboarding_status === "approved" && (
        <div className="mb-4">
          <Alert tone={open ? "ok" : "info"}>
            {open
              ? "Open for loads: pick it in a file's “Load to table” tab. Files must pass the contract below."
              : "Paused by an admin: it isn't offered for loads right now."}
          </Alert>
        </div>
      )}

      <dl className="mb-6 grid gap-4 rounded-xl border border-line p-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Asked for by</dt>
          <dd className="mt-1">
            {t.requested_by_name ?? "—"} <span className="text-muted">{timeAgo(t.created_at)}</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t.onboarding_status === "rejected" ? "Rejected by" : "Approved by"}
          </dt>
          <dd className="mt-1">
            {t.reviewed_by_name ?? "Waiting for an admin"}{" "}
            <span className="text-muted">{t.reviewed_at ? timeAgo(t.reviewed_at) : ""}</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Loads</dt>
          <dd className="mt-1">
            {t.write_modes.map((m) => (m === "upsert" ? `upsert on ${t.key_columns.join(", ")}` : "append")).join(" · ")}
          </dd>
        </div>
        {t.description && (
          <div className="sm:col-span-3">
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Description</dt>
            <dd className="mt-1">{t.description}</dd>
          </div>
        )}
      </dl>

      <ContractSummary
        contract={t.contract}
        columns={t.schema_snapshot}
        version={t.onboarding_status === "approved" ? t.contract_version : null}
      />
    </div>
  );
}

const CHECK_LABELS: Record<string, string> = {
  identity: "Identity",
  credentials: "Credentials",
  connect: "Connection",
  dataset: "Dataset",
  schema: "Schema",
  table: "Table",
  permissions: "Permissions",
  read: "Read",
  write: "Write",
  select: "SELECT",
  insert: "INSERT",
  update: "UPDATE",
  jobs: "Jobs",
  "upsert key": "Upsert key",
  "staging table": "Staging table",
};

/** One line per check: what DataDesk's own account can do with the table, and the fix. */
function AccessResults({ report, upsert }: { report: AccessReport; upsert: boolean }) {
  // the SQL fixes, gathered so a database owner can run them in one go
  const statements = report.checks
    .filter((c) => !c.ok && /^(GRANT|CREATE|ALTER)\b/.test(c.hint))
    .map((c) => (c.hint.endsWith(";") ? c.hint : c.hint.split(";")[0] + ";"));
  const [copied, setCopied] = useState(false);
  return (
    <section
      id="access-report"
      className={`mb-6 overflow-hidden rounded-2xl border ${report.ok ? "border-ok/40" : "border-bad/40"}`}
    >
      <div className={`flex items-center gap-2 px-5 py-3 ${report.ok ? "bg-ok/10" : "bg-bad/10"}`}>
        <ShieldIcon width={18} height={18} className={report.ok ? "text-ok" : "text-bad"} />
        <h2 className="font-semibold">
          {!report.ok
            ? "Access check found problems"
            : report.checks.some((c) => c.warning)
              ? "Access check passed, with a warning"
              : "Access check passed"}
        </h2>
        <span className="text-sm text-muted">
          — for {upsert ? "append and upsert" : "append"} loads, as DataDesk&apos;s own account
        </span>
      </div>
      <ul>
        {report.checks.map((c, i) => (
          <li key={`${c.name}-${i}`} className="flex gap-3 border-t border-line px-5 py-2.5 text-sm">
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                c.warning ? "bg-warn/15 text-warn" : c.ok ? "bg-ok/15 text-ok" : "bg-bad/15 text-bad"
              }`}
            >
              {c.warning ? "!" : c.ok ? <CheckIcon width={13} height={13} /> : <CloseIcon width={13} height={13} />}
            </span>
            <span className="w-28 shrink-0 font-medium">{CHECK_LABELS[c.name] ?? c.name}</span>
            <span className="min-w-0 flex-1">
              <span className={c.ok && !c.warning ? "text-muted" : ""}>{c.detail}</span>
              {c.hint && (
                <code className="mt-1 block w-fit rounded bg-surface px-2 py-1 text-xs text-fg">{c.hint}</code>
              )}
            </span>
          </li>
        ))}
      </ul>
      {statements.length > 0 && (
        <div className="border-t border-line bg-surface px-5 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Run as the table&apos;s owner or a DBA to fix these</p>
            <button
              type="button"
              className={btn.secondary}
              onClick={() => {
                navigator.clipboard?.writeText(statements.join("\n")).then(() => setCopied(true));
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? "Copied" : "Copy SQL"}
            </button>
          </div>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-bg p-3 text-xs">{statements.join("\n")}</pre>
        </div>
      )}
    </section>
  );
}

function Section({ step, title, hint, children }: { step: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-6 rounded-2xl border border-line p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-xs text-brand-contrast">{step}</span>
        {title}
      </h2>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function RangeInputs({
  label,
  min,
  max,
  onMin,
  onMax,
  name,
  integer,
}: {
  label: string;
  min: string;
  max: string;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
  name: string;
  integer?: boolean;
}) {
  return (
    <span className="flex items-center gap-1">
      <input
        className={cell}
        type="number"
        step={integer ? 1 : "any"}
        min={integer ? 0 : undefined}
        value={min}
        onChange={(e) => onMin(e.target.value)}
        placeholder="min"
        aria-label={`${name} min ${label}`}
      />
      <span className="text-muted">–</span>
      <input
        className={cell}
        type="number"
        step={integer ? 1 : "any"}
        min={integer ? 1 : undefined}
        value={max}
        onChange={(e) => onMax(e.target.value)}
        placeholder="max"
        aria-label={`${name} max ${label}`}
      />
    </span>
  );
}
