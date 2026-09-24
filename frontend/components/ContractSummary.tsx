import type { ColumnRule, Contract, TableColumn } from "@/lib/types";

/** One column's rules in plain words: "required · unique · 1–50 characters · one of: a, b". */
export function describeRule(rule: ColumnRule): string[] {
  const parts: string[] = [];
  if (rule.required) parts.push("required");
  if (rule.unique) parts.push("unique in the file");
  if (rule.enum?.length) parts.push(`one of: ${rule.enum.join(", ")}`);
  if (rule.regex) parts.push(`matches ${rule.regex}`);
  const hasMin = rule.min != null;
  const hasMax = rule.max != null;
  if (hasMin && hasMax) parts.push(`between ${rule.min} and ${rule.max}`);
  else if (hasMin) parts.push(`at least ${rule.min}`);
  else if (hasMax) parts.push(`at most ${rule.max}`);
  const hasMinLen = rule.min_length != null;
  const hasMaxLen = rule.max_length != null;
  if (hasMinLen && hasMaxLen) parts.push(`${rule.min_length}–${rule.max_length} characters`);
  else if (hasMinLen) parts.push(`at least ${rule.min_length} characters`);
  else if (hasMaxLen) parts.push(`up to ${rule.max_length} characters`);
  return parts;
}

export function ruleCount(contract: Contract | null | undefined): number {
  return (contract?.columns ?? []).filter((c) => describeRule(c).length > 0).length;
}

/**
 * The contract as a table people can read before they send a file: every column of the
 * target, its type, and what the contract adds on top of the schema.
 */
export function ContractSummary({
  contract,
  columns,
  version,
}: {
  contract: Contract | null | undefined;
  columns?: TableColumn[] | null;
  version?: number | null;
}) {
  const byName = new Map((contract?.columns ?? []).map((c) => [c.name, c]));
  const rows: { name: string; type?: string; nullable?: boolean; rule?: ColumnRule }[] = columns?.length
    ? columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, rule: byName.get(c.name) }))
    : (contract?.columns ?? []).map((rule) => ({ name: rule.name, rule }));

  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="flex items-center justify-between gap-3 bg-surface px-4 py-2">
        <h3 className="text-sm font-semibold">
          Data contract{version ? <span className="ml-1.5 font-normal text-muted">v{version}</span> : null}
        </h3>
        <span className="text-xs text-muted">
          {ruleCount(contract)} rule{ruleCount(contract) === 1 ? "" : "s"}
          {contract?.max_rows ? ` · up to ${contract.max_rows.toLocaleString()} rows per file` : ""}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted">No column rules: only the table&apos;s own schema is checked.</p>
      ) : (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-sm">
            <tbody>
              {rows.map(({ name, type, nullable, rule }) => {
                const parts = rule ? describeRule(rule) : [];
                return (
                  <tr key={name} className="border-t border-line align-top first:border-t-0">
                    <td className="w-1/3 px-4 py-2">
                      <span className="font-medium">{name}</span>
                      {type && (
                        <span className="block text-xs text-muted">
                          {type.toLowerCase()}
                          {nullable === false ? " · not null" : ""}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {parts.length ? (
                        <span className="flex flex-wrap gap-1">
                          {parts.map((p) => (
                            <span key={p} className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
                              {p}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                      {rule?.description && <span className="mt-1 block text-xs text-muted">{rule.description}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
