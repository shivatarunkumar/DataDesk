export function humanSize(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "3 days ago", "2 hours ago". */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const seconds = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
  const steps: [number, number, Intl.RelativeTimeFormatUnit][] = [
    [60, 1, "second"],
    [3600, 60, "minute"],
    [86400, 3600, "hour"],
    [604800, 86400, "day"],
    [2592000, 604800, "week"],
    [31536000, 2592000, "month"],
    [Infinity, 31536000, "year"],
  ];
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [limit, divisor, unit] of steps) {
    if (seconds < limit) return formatter.format(-Math.floor(seconds / divisor), unit);
  }
  return "";
}

/** "inserted 12, updated 3" / "12 rows, 15 affected" / the error. */
export function describeResult(result: Record<string, unknown> | null): string {
  if (!result) return "";
  if (typeof result.error === "string") return result.error;
  if (result.rows_loaded != null) return `Cloud Run loaded ${Number(result.rows_loaded).toLocaleString()} rows`;
  if (typeof result.landed === "string") return `In the landing bucket for Cloud Run`;
  if (result.inserted != null) return `Inserted ${result.inserted}, updated ${result.updated ?? 0}`;
  if (result.affected != null) return `${result.rows ?? "?"} rows merged, ${result.affected} affected`;
  return Object.entries(result)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
}

/** "append" / "upsert on id" / "edit in place" / "overwrite": a request's write mode in words. */
export function writeModeLabel(mode: string, keys?: string[] | null): string {
  if (mode === "upsert") return `upsert on ${(keys ?? []).join(", ")}`;
  if (mode === "update") return "edit in place";
  if (mode === "overwrite") return "overwrite";
  return "append";
}
