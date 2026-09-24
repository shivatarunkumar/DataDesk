"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { SessionUser } from "@/lib/types";
import { UserIcon } from "./icons";

export function AccountMenu({ user }: { user: SessionUser | null }) {
  const pathname = usePathname();
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

  if (!user) {
    if (pathname === "/login") return null;
    return (
      <Link
        href="/login"
        className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-sm font-medium text-brand hover:bg-surface"
      >
        <UserIcon width={20} height={20} />
        Sign in
      </Link>
    );
  }

  async function signOut() {
    await fetch("/api/v1/auth/logout", { method: "POST" });
    setOpen(false);
    // a full load, so no client state from the session survives
    window.location.assign("/login");
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-sm font-semibold text-brand-contrast"
      >
        {user.display_name.trim().charAt(0).toUpperCase()}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 w-64 overflow-hidden rounded-xl border border-line bg-bg py-2 shadow-lg"
        >
          <div className="border-b border-line px-4 pb-3">
            <p className="truncate font-medium">{user.display_name}</p>
            <p className="truncate text-sm text-muted">@{user.username}</p>
            <p className="truncate text-xs text-muted">{user.email}</p>
            {user.role === "admin" && (
              <span className="mt-2 inline-block rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-brand">
                Admin
              </span>
            )}
          </div>
          <Link href="/" role="menuitem" onClick={() => setOpen(false)} className="block px-4 py-2 text-sm hover:bg-surface-hover">
            My files
          </Link>
          <Link
            href="/uploads"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-4 py-2 text-sm hover:bg-surface-hover"
          >
            My load requests
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            className="block w-full px-4 py-2 text-left text-sm hover:bg-surface-hover"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
