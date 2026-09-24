"use client";

import { Fragment } from "react";
import { describeResult, timeAgo } from "@/lib/format";
import type { UploadRequest, ValidationReport } from "@/lib/types";
import { CheckIcon, CloseIcon } from "./icons";

/**
 * The life of a load, from the moment someone submits it to the rows landing in the table:
 *
 *   Initiated → Validation → Data contract → Approval → Load → Completed
 *
 * Finished stages are green, the stage in progress pulses (amber, so "waiting" never reads
 * as done), a failed stage is red with the reason, and what hasn't happened yet is grey.
 */

export type StageState = "done" | "current" | "failed" | "pending" | "skipped";

export type Stage = {
  key: string;
  label: string;
  state: StageState;
  /** one or two short lines under the label */
  lines: string[];
  when?: string | null;
};

const LABELS = {
  initiated: "Initiated",
  validation: "Validation",
  contract: "Data contract",
  approval: "Approval",
  load: "Load",
  completed: "Completed",
} as const;

// errors the contract raises; everything else is the file or the table's schema
const CONTRACT_RULES = new Set(["rule", "unique", "max_rows"]);
const isContractError = (e: ValidationReport["errors"][number]) =>
  CONTRACT_RULES.has(e.rule) || (e.rule === "missing_column" && /data contract/i.test(e.message));

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
// the stage shows the gist; the full message is in the report table underneath
const clip = (text: string, max = 70) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const DELIMITERS: Record<string, string> = { ",": "comma", "\t": "tab", ";": "semicolon", "|": "pipe" };

function fileLines(report: ValidationReport | null | undefined): string[] {
  if (!report) return ["File read, delimiter and columns checked"];
  const file = report.file;
  const read = file
    ? `${file.format.toUpperCase()}${file.delimiter ? ` · ${DELIMITERS[file.delimiter] ?? `“${file.delimiter}”`} delimited` : ""}`
    : "File read";
  const cols = report.stats
    ? `${plural(report.stats.file_columns, "column")} · ${plural(report.stats.file_rows, "row")}`
    : "";
  return [read, cols || "Columns and types match the table"].filter(Boolean);
}

/** "2 rows edited · 1 added" for a Data Studio request. */
export function studioChanges(summary: UploadRequest["change_summary"]): string {
  if (!summary) return "edited rows";
  const parts = [summary.edited && `${plural(summary.edited, "row")} edited`, summary.added && `${summary.added} added`];
  return parts.filter(Boolean).join(" · ") || "no changes";
}

/** The stages of a request that exists. */
export function stagesFor(r: UploadRequest): Stage[] {
  const report = r.validation_report;
  const who = (name: string | null) => name ?? "an admin";
  const approval: Stage =
    r.status === "pending"
      ? { key: "approval", label: LABELS.approval, state: "current", lines: ["Waiting for an admin"] }
      : r.status === "rejected"
        ? {
            key: "approval",
            label: LABELS.approval,
            state: "failed",
            lines: [`Rejected by ${who(r.reviewed_by_name)}`, ...(r.review_note ? [`“${r.review_note}”`] : [])],
            when: r.reviewed_at,
          }
        : { key: "approval", label: LABELS.approval, state: "done", lines: [`Approved by ${who(r.reviewed_by_name)}`], when: r.reviewed_at };

  const loadError = r.status === "failed" ? String(r.result?.error ?? "The load failed") : "";
  const load: Stage =
    r.status === "approved"
      ? { key: "load", label: LABELS.load, state: "current", lines: ["Loading the rows…"] }
      : r.status === "completed"
        ? { key: "load", label: LABELS.load, state: "done", lines: [describeResult(r.result)], when: r.executed_at }
        : r.status === "failed"
          ? { key: "load", label: LABELS.load, state: "failed", lines: [clip(loadError, 90)], when: r.reviewed_at }
          : { key: "load", label: LABELS.load, state: "pending", lines: [r.status === "rejected" ? "Not loaded" : "After approval"] };

  return [
    {
      key: "initiated",
      label: LABELS.initiated,
      state: "done",
      lines: [
        `by ${r.is_mine ? "you" : (r.user_name ?? "someone")}`,
        ...(r.origin === "studio"
          ? ["in Data Studio", studioChanges(r.change_summary)]
          : [`version ${r.file_version ?? "?"} of ${r.file_name ?? "the file"}`]),
      ],
      when: r.created_at,
    },
    // a filed request passed both checks when it was sent; a failure at approval shows at Load
    { key: "validation", label: LABELS.validation, state: "done", lines: fileLines(report) },
    r.contract_version
      ? {
          key: "contract",
          label: LABELS.contract,
          state: "done",
          lines: [`v${r.contract_version} passed`, plural(report?.contract_rules ?? 0, "rule")],
        }
      : { key: "contract", label: LABELS.contract, state: "skipped", lines: ["No contract on this table"] },
    approval,
    load,
    r.status === "completed"
      ? { key: "completed", label: LABELS.completed, state: "done", lines: ["Loading completed"], when: r.executed_at }
      : { key: "completed", label: LABELS.completed, state: "pending", lines: [r.status === "rejected" || r.status === "failed" ? "—" : "When the rows are in"] },
  ];
}

/** The stages while a file is being sent (no request yet), or after it failed the checks. */
export function stagesForSubmit(
  phase: "checking" | "failed",
  hasContract: boolean,
  report: ValidationReport | null,
  rowLabel: (row: number) => string = (row) => `row ${row + 1}`,
): Stage[] {
  const pending = (key: keyof typeof LABELS, line: string): Stage => ({ key, label: LABELS[key], state: "pending", lines: [line] });
  const initiated: Stage = { key: "initiated", label: LABELS.initiated, state: "done", lines: ["just now"] };
  const tail = [pending("approval", "Waiting to be sent"), pending("load", "After approval"), pending("completed", "When the rows are in")];

  if (phase === "checking") {
    return [
      initiated,
      { key: "validation", label: LABELS.validation, state: "current", lines: ["Reading the file", "Checking delimiter and columns"] },
      hasContract ? pending("contract", "Next") : { ...pending("contract", "No contract on this table"), state: "skipped" },
      ...tail,
    ];
  }

  const errors = report?.errors ?? [];
  const schemaErrors = errors.filter((e) => !isContractError(e));
  const contractErrors = errors.filter(isContractError);
  const firstMessages = (list: typeof errors) => [
    plural(list.length, "problem"),
    list[0] ? clip(list[0].row != null ? `${rowLabel(list[0].row)}: ${list[0].message}` : list[0].message) : "",
  ];
  const validationFailed = schemaErrors.length > 0;
  return [
    initiated,
    validationFailed
      ? { key: "validation", label: LABELS.validation, state: "failed", lines: firstMessages(schemaErrors) }
      : { key: "validation", label: LABELS.validation, state: "done", lines: fileLines(report) },
    !hasContract
      ? { ...pending("contract", "No contract on this table"), state: "skipped" }
      : contractErrors.length > 0
        ? { key: "contract", label: LABELS.contract, state: "failed", lines: firstMessages(contractErrors) }
        : pending("contract", validationFailed ? "Not reached" : "Passed"),
    { ...tail[0], lines: ["Not sent"] },
    tail[1],
    tail[2],
  ];
}

/** What the flow says in one line: "Waiting for approval", "Load failed", "Completed". */
export function flowSummary(stages: Stage[]): { text: string; tone: "ok" | "warn" | "bad" | "muted" } {
  const failed = stages.find((s) => s.state === "failed");
  if (failed) return { text: failed.key === "approval" ? "Rejected" : `${failed.label} failed`, tone: "bad" };
  const current = stages.find((s) => s.state === "current");
  if (current) return { text: current.key === "approval" ? "Waiting for approval" : `${current.label} in progress`, tone: "warn" };
  if (stages[stages.length - 1].state === "done") return { text: "Completed", tone: "ok" };
  return { text: "Not started", tone: "muted" };
}

const NODE = {
  done: "border-ok bg-ok text-brand-contrast",
  current: "border-warn bg-warn/15 text-warn flow-current",
  failed: "border-bad bg-bad text-brand-contrast",
  pending: "border-line bg-bg text-muted",
  skipped: "border-dashed border-line bg-bg text-muted",
} satisfies Record<StageState, string>;

function Node({ stage, index, size }: { stage: Stage; index: number; size: "lg" | "sm" }) {
  const dim = size === "lg" ? "h-10 w-10 text-sm" : "h-4 w-4 text-[9px]";
  const icon = size === "lg" ? 18 : 10;
  return (
    <span
      className={`relative z-10 flex shrink-0 items-center justify-center rounded-full border-2 font-semibold ${dim} ${NODE[stage.state]}`}
      aria-hidden="true"
    >
      {stage.state === "done" ? (
        <CheckIcon width={icon} height={icon} className="flow-pop" strokeWidth={2.6} />
      ) : stage.state === "failed" ? (
        <CloseIcon width={icon} height={icon} className="flow-pop" strokeWidth={2.6} />
      ) : size === "lg" ? (
        stage.state === "current" ? (
          <span className="h-2.5 w-2.5 rounded-full bg-warn" />
        ) : (
          index + 1
        )
      ) : null}
    </span>
  );
}

/** The line between two stages: solid once reached, running into the stage in progress. */
function Connector({ from, to, vertical }: { from: Stage; to: Stage; vertical?: boolean }) {
  const reached = from.state === "done" || from.state === "skipped";
  const cls =
    reached && to.state === "current"
      ? vertical
        ? "flow-running-y"
        : "flow-running"
      : reached && (to.state === "done" || to.state === "skipped")
        ? "bg-ok"
        : reached && to.state === "failed"
          ? "bg-bad"
          : "bg-line";
  return vertical ? (
    <span className={`ml-[19px] block h-6 w-1 rounded-full ${cls}`} aria-hidden="true" />
  ) : (
    <span className={`mt-[18px] h-1 min-w-4 flex-1 rounded-full ${cls}`} aria-hidden="true" />
  );
}

function StageText({ stage }: { stage: Stage }) {
  const tone =
    stage.state === "failed"
      ? "text-bad"
      : stage.state === "current"
        ? "text-warn"
        : stage.state === "done"
          ? "text-fg"
          : "text-muted";
  return (
    <>
      <p className={`text-sm font-semibold ${tone}`}>{stage.label}</p>
      {stage.lines.filter(Boolean).map((line, i) => (
        <p key={i} className={`text-xs ${stage.state === "failed" && i > 0 ? "text-bad" : "text-muted"} break-words`}>
          {line}
        </p>
      ))}
      {stage.when && <p className="text-xs text-muted">{timeAgo(stage.when)}</p>}
    </>
  );
}

/** The full flow: across the page on wide screens, down it on narrow ones. */
export function LoadFlow({ stages }: { stages: Stage[] }) {
  const summary = flowSummary(stages);
  return (
    <div role="group" aria-label={`Load progress: ${summary.text}`}>
      {/* wide: a row of stages joined by lines */}
      <ol className="hidden md:flex md:items-start">
        {stages.map((stage, i) => (
          <Fragment key={stage.key}>
            {i > 0 && <Connector from={stages[i - 1]} to={stage} />}
            <li className="flex w-28 shrink-0 flex-col items-center text-center lg:w-32">
              <Node stage={stage} index={i} size="lg" />
              <div className="mt-2 px-1">
                <StageText stage={stage} />
              </div>
            </li>
          </Fragment>
        ))}
      </ol>
      {/* narrow: the same, stacked */}
      <ol className="md:hidden">
        {stages.map((stage, i) => (
          <Fragment key={stage.key}>
            {i > 0 && <Connector from={stages[i - 1]} to={stage} vertical />}
            <li className="flex items-start gap-3">
              <Node stage={stage} index={i} size="lg" />
              <div className="min-w-0 pt-1">
                <StageText stage={stage} />
              </div>
            </li>
          </Fragment>
        ))}
      </ol>
    </div>
  );
}

/** A one-line version for request cards: six dots and where it stands. */
export function LoadFlowCompact({ stages }: { stages: Stage[] }) {
  const summary = flowSummary(stages);
  const tone = { ok: "text-ok", warn: "text-warn", bad: "text-bad", muted: "text-muted" }[summary.tone];
  return (
    <div className="flex items-center gap-3" role="group" aria-label={`Load progress: ${summary.text}`}>
      <ol className="flex items-center" aria-hidden="true">
        {stages.map((stage, i) => (
          <Fragment key={stage.key}>
            {i > 0 && (
              <span
                className={`h-0.5 w-5 ${
                  stages[i - 1].state === "done" || stages[i - 1].state === "skipped"
                    ? stage.state === "current"
                      ? "flow-running"
                      : stage.state === "failed"
                        ? "bg-bad"
                        : stage.state === "pending"
                          ? "bg-line"
                          : "bg-ok"
                    : "bg-line"
                }`}
              />
            )}
            <li title={`${stage.label}: ${stage.lines[0] ?? ""}`}>
              <Node stage={stage} index={i} size="sm" />
            </li>
          </Fragment>
        ))}
      </ol>
      <span className={`text-xs font-semibold ${tone}`}>{summary.text}</span>
    </div>
  );
}
