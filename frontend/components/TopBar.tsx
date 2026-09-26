"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import type { Look, Theme } from "@/lib/theme";
import type { SessionUser } from "@/lib/types";
import { AccountMenu } from "./AccountMenu";
import { LookPicker } from "./LookPicker";
import { ThemeToggle } from "./ThemeToggle";
import { LogoMark, MenuIcon, SearchIcon } from "./icons";

export function TopBar({
  onMenu,
  user,
  theme,
  look,
}: {
  onMenu?: () => void;
  user: SessionUser | null;
  theme: Theme;
  look: Look;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const current = useSearchParams().get("q") ?? "";
  const [query, setQuery] = useState(current);

  // keep the box in step with the URL (back button, "clear search")
  useEffect(() => setQuery(current), [current]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    router.push(q ? `/?q=${encodeURIComponent(q)}` : "/");
  }

  return (
    <header data-ui="topbar" className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between gap-4 bg-bg px-4">
      <div className="flex shrink-0 items-center gap-3">
        {onMenu && (
          <button
            type="button"
            onClick={onMenu}
            aria-label="Toggle navigation"
            title="Collapse or expand the menu"
            className="rounded-full p-2 hover:bg-surface-hover"
          >
            <MenuIcon />
          </button>
        )}
        <Link href="/" className="flex items-center gap-1.5" aria-label="DataDesk home">
          <LogoMark />
          <span className="display text-lg tracking-tight">DataDesk</span>
        </Link>
      </div>

      {user && pathname !== "/login" && (
        <form onSubmit={submit} role="search" data-ui="search" className="hidden max-w-xl flex-1 sm:flex">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your files and folders"
            aria-label="Search"
            className="h-10 w-full rounded-l-full border border-line bg-bg px-4 outline-none focus:border-brand"
          />
          <button
            type="submit"
            aria-label="Search"
            className="flex h-10 w-16 items-center justify-center rounded-r-full border border-l-0 border-line bg-surface hover:bg-surface-hover"
          >
            <SearchIcon width={20} height={20} />
          </button>
        </form>
      )}

      <div className="flex items-center gap-1">
        <LookPicker look={look} />
        <ThemeToggle theme={theme} />
        <AccountMenu user={user} />
      </div>
    </header>
  );
}
