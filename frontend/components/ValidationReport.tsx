"use client";

import type { ValidationReport } from "@/lib/types";

/** What a validation report says, row by row: used wherever a file or an edit was checked. */

const RULE_LABELS: Record<string, string> = {
  type: "Wrong type",
  not_null: "Empty, but NOT NULL",
  missing_column: "Missing column",
  unknown_column: "Not in the table",
  key: "Key",
  key_unique: "Duplicate key",
  unique: "Contract: must be unique",
  rule: "Contract",
  max_rows: "Contract: too many rows",
  min_rows: "Contract: too few rows",
  header: "Header",
  file: "File",
};

/** Contract rules marked "warning" that failed: shown, but they don't stop the file. */
export function WarningsView({ warnings }: { warnings: ValidationReport["errors"] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-warn/40">
      <div className="bg-warn/10 px-4 py-3">
        <h3 className="font-semibold text-warn">
          {warnings.length} warning{warnings.length === 1 ? "" : "s"}
        </h3>
        <p className="text-sm text-muted">These columns&apos; rules are warnings in the contract: the file still goes through.</p>
      </div>
      <div className="max-h-60 overflow-auto">
        <table className="w-full text-sm">
          <tbody>
            {warnings.map((w, i) => (
              <tr key={i} className="border-t border-line first:border-t-0">
                <td className="px-4 py-1.5 text-muted tabular">{w.row == null ? "—" : w.row + 1}</td>
                <td className="px-4 py-1.5 font-medium">{w.column ?? "—"}</td>
                <td className="px-4 py-1.5">{w.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ValidationReportView({
  report,
  title = "The file doesn't pass — nothing was sent for approval",
  hint = "Fix them in the Edit tab, save, and try again.",
  rowLabel = (row) => String(row + 1),
}: {
  report: ValidationReport;
  title?: string;
  hint?: string;
  /** how a row is named: its number in a file, its key in Data Studio */
  rowLabel?: (row: number) => string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-bad/40">
      <div className="bg-bad/10 px-4 py-3">
        <h3 className="font-semibold text-bad">{title}</h3>
        <p className="text-sm text-muted">
          {report.summary}
          {report.contract_version ? ` Checked against data contract v${report.contract_version}.` : ""} {hint}
        </p>
      </div>
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-semibold">Row</th>
              <th className="px-4 py-2 font-semibold">Column</th>
              <th className="px-4 py-2 font-semibold">Check</th>
              <th className="px-4 py-2 font-semibold">Problem</th>
            </tr>
          </thead>
          <tbody>
            {report.errors.map((e, i) => (
              <tr key={i} className="border-t border-line">
                <td className="px-4 py-1.5 text-muted tabular">{e.row == null ? "—" : rowLabel(e.row)}</td>
                <td className="px-4 py-1.5 font-medium">{e.column ?? "—"}</td>
                <td className="whitespace-nowrap px-4 py-1.5 text-muted">{RULE_LABELS[e.rule] ?? e.rule}</td>
                <td className="px-4 py-1.5">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
