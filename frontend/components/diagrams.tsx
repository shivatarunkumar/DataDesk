import type { ReactNode } from "react";

/**
 * A small kit for the diagrams on the About page: boxes, arrows and labels drawn in SVG
 * with the palette's tokens, so they follow light and dark mode like everything else.
 * Coordinates are in the diagram's own viewBox; the SVG scales to the page width and
 * scrolls sideways on a phone rather than shrinking the text to nothing.
 */

export type Tone = "base" | "brand" | "accent" | "warn" | "bad" | "muted";

const FILL: Record<Tone, string> = {
  base: "var(--surface)",
  brand: "color-mix(in srgb, var(--brand) 14%, var(--bg))",
  accent: "color-mix(in srgb, var(--accent) 18%, var(--bg))",
  warn: "color-mix(in srgb, var(--warn) 14%, var(--bg))",
  bad: "color-mix(in srgb, var(--bad) 12%, var(--bg))",
  muted: "var(--bg)",
};
const STROKE: Record<Tone, string> = {
  base: "var(--border)",
  brand: "var(--brand)",
  accent: "var(--accent)",
  warn: "var(--warn)",
  bad: "var(--bad)",
  muted: "var(--border)",
};

export function Diagram({
  id,
  width,
  height,
  title,
  minWidth = 720,
  children,
}: {
  id: string;
  width: number;
  height: number;
  title: string;
  /** below this many pixels the diagram scrolls instead of shrinking */
  minWidth?: number;
  children: ReactNode;
}) {
  return (
    <figure className="my-5 overflow-x-auto rounded-2xl border border-line bg-bg p-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={title}
        className="block h-auto w-full"
        style={{ minWidth, fontFamily: "var(--font-sans)" }}
      >
        <defs>
          {(["base", "brand", "bad"] as const).map((tone) => (
            <marker
              key={tone}
              id={`${id}-arrow-${tone}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0 10 5 0 10z" style={{ fill: tone === "base" ? "var(--muted)" : STROKE[tone] }} />
            </marker>
          ))}
        </defs>
        {children}
      </svg>
      <figcaption className="px-1 pt-2 text-xs text-muted">{title}</figcaption>
    </figure>
  );
}

/** A box with a bold title and up to a few lines under it. */
export function Box({
  x,
  y,
  w,
  h,
  title,
  lines = [],
  tone = "base",
  dashed = false,
  align = "center",
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  lines?: string[];
  tone?: Tone;
  dashed?: boolean;
  align?: "center" | "left";
}) {
  const cx = align === "center" ? x + w / 2 : x + 14;
  const anchor = align === "center" ? "middle" : "start";
  const block = 18 + lines.length * 16;
  const top = y + (h - block) / 2 + 13;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={12}
        style={{ fill: FILL[tone], stroke: STROKE[tone], strokeWidth: 1.5, strokeDasharray: dashed ? "6 5" : undefined }}
      />
      <text x={cx} y={top} textAnchor={anchor} style={{ fill: "var(--text)", fontSize: 14, fontWeight: 600 }}>
        {title}
      </text>
      {lines.map((line, i) => (
        <text key={i} x={cx} y={top + 18 + i * 16} textAnchor={anchor} style={{ fill: "var(--muted)", fontSize: 12 }}>
          {line}
        </text>
      ))}
    </g>
  );
}

/** A frame around a group of boxes, labelled at its top left. */
export function Group({ x, y, w, h, label, tone = "muted" }: { x: number; y: number; w: number; h: number; label: string; tone?: Tone }) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={16}
        style={{ fill: tone === "muted" ? "none" : FILL[tone], stroke: STROKE[tone], strokeWidth: 1.2, strokeDasharray: "4 4" }}
      />
      <text x={x + 14} y={y + 20} style={{ fill: "var(--muted)", fontSize: 11, fontWeight: 600, letterSpacing: 0.8 }}>
        {label.toUpperCase()}
      </text>
    </g>
  );
}

/** An arrow along a path ("M x y L x y …"), with an optional label at (lx, ly). */
export function Arrow({
  id,
  d,
  label,
  lx,
  ly,
  tone = "base",
  dashed = false,
  both = false,
}: {
  id: string;
  d: string;
  label?: string;
  lx?: number;
  ly?: number;
  tone?: "base" | "brand" | "bad";
  dashed?: boolean;
  both?: boolean;
}) {
  const color = tone === "base" ? "var(--muted)" : STROKE[tone];
  return (
    <g>
      <path
        d={d}
        markerEnd={`url(#${id}-arrow-${tone})`}
        markerStart={both ? `url(#${id}-arrow-${tone})` : undefined}
        style={{ fill: "none", stroke: color, strokeWidth: 1.6, strokeDasharray: dashed ? "5 4" : undefined }}
      />
      {label && lx != null && ly != null && (
        <text x={lx} y={ly} textAnchor="middle" style={{ fill: color, fontSize: 11.5, fontWeight: 500 }}>
          {label}
        </text>
      )}
    </g>
  );
}

/** A numbered dot, for walking through a diagram in the text next to it. */
export function Step({ x, y, n }: { x: number; y: number; n: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={11} style={{ fill: "var(--brand)" }} />
      <text x={x} y={y + 4} textAnchor="middle" style={{ fill: "var(--brand-contrast)", fontSize: 12, fontWeight: 700 }}>
        {n}
      </text>
    </g>
  );
}
