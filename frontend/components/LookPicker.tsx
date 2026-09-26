"use client";

import { useEffect, useRef, useState } from "react";
import { LOOKS, type Look, applyLook, rememberLook } from "@/lib/theme";
import { CheckIcon } from "./icons";

function Swatch({ colors, size = "sm" }: { colors: string[]; size?: "sm" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 overflow-hidden rounded-full ring-1 ring-black/10 ${size === "lg" ? "h-7 w-7" : "h-4 w-4"}`}
    >
      {colors.map((color) => (
        <span key={color} className="flex-1" style={{ background: color }} />
      ))}
    </span>
  );
}

/**
 * The theme dropdown in the top bar: which look the whole app wears (OG, Aurora, Glass). It switches instantly and is remembered in a cookie, so the server renders the
 * same look on the next page load.
 */
export function LookPicker({ look: initial }: { look: Look }) {
  const [look, setLook] = useState<Look>(initial);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function choose(next: Look) {
    applyLook(next);
    rememberLook(next);
    setLook(next);
    setOpen(false);
  }

  const current = LOOKS.find((option) => option.value === look) ?? LOOKS[0];

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${current.label}`}
        title="Change the theme"
        className="flex h-9 items-center gap-2 rounded-full border border-line px-2.5 text-sm font-medium hover:bg-surface-hover sm:pr-2"
      >
        <Swatch colors={current.swatch} />
        <span className="hidden sm:inline">{current.label}</span>
        <svg viewBox="0 0 20 20" width={16} height={16} aria-hidden="true" className="text-muted">
          <path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-50 w-72 overflow-hidden rounded-xl border border-line bg-bg p-1.5 shadow-lg"
        >
          <p className="px-2.5 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Theme</p>
          {LOOKS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={look === option.value}
              onClick={() => choose(option.value)}
              className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-hover ${
                look === option.value ? "bg-surface" : ""
              }`}
            >
              <Swatch colors={option.swatch} size="lg" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{option.label}</span>
                <span className="block text-xs text-muted">{option.hint}</span>
              </span>
              {look === option.value && <CheckIcon width={16} height={16} className="shrink-0 text-brand" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
