"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { CloseIcon, EyeIcon, EyeOffIcon } from "./icons";

/* Class names shared by every screen, so buttons and inputs look the same everywhere. */
export const btn = {
  primary:
    "inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-brand px-4 text-sm font-medium text-brand-contrast hover:bg-brand-hover disabled:opacity-60",
  secondary:
    "inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-line px-4 text-sm font-medium hover:bg-surface disabled:opacity-60",
  quiet:
    "inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-surface px-4 text-sm font-medium hover:bg-surface-hover disabled:opacity-60",
  danger:
    "inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-bad/40 px-4 text-sm font-medium text-bad hover:bg-bad/10 disabled:opacity-60",
  icon: "flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-fg",
};

export const inputClass =
  "h-10 w-full rounded-lg border border-line bg-bg px-3 outline-none focus:border-brand aria-[invalid=true]:border-bad";

export function Alert({ tone = "bad", children }: { tone?: "bad" | "ok" | "warn" | "info"; children: ReactNode }) {
  const tones = {
    bad: "border-bad/40 bg-bad/10 text-bad",
    ok: "border-ok/40 bg-ok/10 text-ok",
    warn: "border-warn/40 bg-warn/10 text-warn",
    info: "border-line bg-surface text-fg",
  };
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={`rounded-lg border px-3 py-2 text-sm ${tones[tone]}`}>
      {children}
    </div>
  );
}

export function Field({
  label,
  value,
  onChange,
  error,
  type = "text",
  action,
  hint,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  type?: string;
  /** shown on the right of the label row, e.g. a "Forgot password?" link */
  action?: ReactNode;
  hint?: string;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === "password";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {action}
      </div>
      <div className="relative">
        <input
          id={id}
          type={isPassword && revealed ? "text" : type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          className={`${inputClass} ${isPassword ? "pr-11" : ""}`}
          {...rest}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? "Hide password" : "Show password"}
            aria-pressed={revealed}
            className="absolute right-1 top-1 flex h-8 w-9 items-center justify-center rounded-md text-muted hover:bg-surface-hover hover:text-fg"
          >
            {revealed ? <EyeOffIcon width={18} height={18} /> : <EyeIcon width={18} height={18} />}
          </button>
        )}
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-xs text-bad">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-muted">{hint}</p>
      )}
    </div>
  );
}

/** A modal dialog: Escape and a click outside close it; focus starts inside. */
export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** true: room for a form; "xl": room for tables and the load flow */
  wide?: boolean | "xl";
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    const first = panel.current?.querySelector<HTMLElement>("input, textarea, select, button[type=submit]");
    first?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" data-ui="scrim" className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full ${wide === "xl" ? "max-w-4xl" : wide ? "max-w-2xl" : "max-w-md"} rounded-2xl border border-line bg-bg p-5 shadow-xl`}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="display text-xl">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className={btn.icon}>
            <CloseIcon width={18} height={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-warn/15 text-warn",
  pending_approval: "bg-warn/15 text-warn",
  approved: "bg-ok/15 text-ok",
  completed: "bg-ok/15 text-ok",
  active: "bg-ok/15 text-ok",
  passed: "bg-ok/15 text-ok",
  rejected: "bg-bad/15 text-bad",
  failed: "bg-bad/15 text-bad",
  suspended: "bg-bad/15 text-bad",
  paused: "bg-surface text-muted",
  pending_review: "bg-warn/15 text-warn",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${
        STATUS_STYLES[status] ?? "bg-surface text-muted"
      }`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="mx-auto max-w-md py-16 text-center">
      <h2 className="display text-xl">{title}</h2>
      {children && <div className="mt-2 text-sm text-muted">{children}</div>}
    </section>
  );
}
