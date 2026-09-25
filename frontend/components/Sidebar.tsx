"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { type ComponentType, type SVGProps, useEffect, useState } from "react";
import { PENDING_CHANGED } from "@/lib/pending";
import type { PendingCounts, SessionUser } from "@/lib/types";
import { ApiStatus } from "./ApiStatus";
import {
  DatabaseIcon,
  FilesIcon,
  HistoryIcon,
  InfoIcon,
  PanelLeftIcon,
  PeopleIcon,
  QueueIcon,
  ShieldIcon,
  StudioIcon,
} from "./icons";

type NavItem = { href: string; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> };

const MAIN: NavItem[] = [
  { href: "/", label: "My files", icon: FilesIcon },
  { href: "/studio", label: "Data Studio", icon: StudioIcon },
  { href: "/uploads", label: "Load requests", icon: QueueIcon },
  { href: "/onboarding", label: "Onboarding", icon: DatabaseIcon },
  { href: "/history", label: "Load history", icon: HistoryIcon },
  { href: "/people", label: "People", icon: PeopleIcon },
];

const ADMIN: NavItem[] = [{ href: "/admin", label: "Approvals", icon: ShieldIcon }];

const POLL_MS = 30_000;

/** How much is waiting for an admin; refreshed on navigation, on a timer, and after a decision. */
function usePendingCount(enabled: boolean, pathname: string): PendingCounts | null {
  const [counts, setCounts] = useState<PendingCounts | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = () =>
      fetch("/api/v1/admin/pending-counts", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((c) => active && c && setCounts(c))
        .catch(() => {});
    load();
    const timer = setInterval(load, POLL_MS);
    window.addEventListener(PENDING_CHANGED, load);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(PENDING_CHANGED, load);
    };
  }, [enabled, pathname]);
  return counts;
}

function Badge({ counts, mini }: { counts: PendingCounts | null; mini?: boolean }) {
  if (!counts?.total) return null;
  const title = [
    counts.loads && `${counts.loads} load${counts.loads === 1 ? "" : "s"}`,
    counts.tables && `${counts.tables} table${counts.tables === 1 ? "" : "s"} to onboard`,
    counts.accounts && `${counts.accounts} account${counts.accounts === 1 ? "" : "s"}`,
    counts.password_resets && `${counts.password_resets} password reset${counts.password_resets === 1 ? "" : "s"}`,
    counts.admin_access && `${counts.admin_access} admin access request${counts.admin_access === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <span
      title={`Waiting: ${title}`}
      aria-label={`${counts.total} waiting for approval`}
      className={`rounded-full bg-accent font-semibold text-accent-contrast tabular ${
        mini ? "absolute -right-1 -top-1 px-1.5 text-[10px] leading-4" : "ml-auto px-2 py-0.5 text-xs"
      }`}
    >
      {counts.total > 99 ? "99+" : counts.total}
    </span>
  );
}

export function Sidebar({
  expanded,
  user,
  onNavigate,
  onToggle,
}: {
  expanded: boolean;
  user: SessionUser;
  onNavigate?: () => void;
  /** collapse to the icon rail, or open again (desktop only) */
  onToggle?: () => void;
}) {
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  const isActive = (href: string) => {
    const [path, query] = href.split("?");
    if (pathname === "/files" || pathname.startsWith("/files/")) return path === "/";
    if (pathname.startsWith("/onboarding")) return path === "/onboarding";
    if (path !== pathname) return false;
    return query ? query === `tab=${tab}` : !tab;
  };
  const items = user.role === "admin" ? [...MAIN, ...ADMIN] : MAIN;
  const pending = usePendingCount(user.role === "admin", pathname);
  const badgeFor = (href: string) => (href === "/admin" ? pending : null);

  if (!expanded) {
    // Mini rail (desktop): icon + tiny label, for when the sidebar is collapsed.
    return (
      <nav aria-label="Main" className="flex flex-col items-center gap-1 px-1 pt-1">
        {items.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-label={label}
            className={`group relative flex h-12 w-12 items-center justify-center rounded-lg hover:bg-surface-hover ${
              isActive(href) ? "bg-surface text-brand" : ""
            }`}
          >
            <Icon />
            <RailTip>{label}</RailTip>
            <Badge counts={badgeFor(href)} mini />
          </Link>
        ))}
        <Link
          href="/about"
          aria-label="About DataDesk"
          className={`group relative mt-2 flex h-12 w-12 items-center justify-center rounded-lg hover:bg-surface-hover ${
            pathname === "/about" ? "bg-surface text-brand" : "text-muted hover:text-fg"
          }`}
        >
          <InfoIcon />
          <RailTip>About DataDesk</RailTip>
        </Link>
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-label="Expand the menu"
            className="group relative mt-2 flex h-12 w-12 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-fg"
          >
            <PanelLeftIcon />
            <RailTip>Expand the menu</RailTip>
          </button>
        )}
      </nav>
    );
  }

  return (
    <nav aria-label="Main" className="flex h-full flex-col px-3 pb-4 text-sm">
      <Section items={MAIN} isActive={isActive} onNavigate={onNavigate} />
      {user.role === "admin" && (
        <>
          <Divider />
          <h2 className="px-3 pb-1 pt-2 text-base font-semibold">Admin</h2>
          <Section items={ADMIN} isActive={isActive} onNavigate={onNavigate} badgeFor={badgeFor} />
        </>
      )}
      <Divider />
      <div className="px-3 py-2 text-xs leading-relaxed text-muted">
        Files you upload stay private to you. Loading one into a shared table needs an
        admin&apos;s approval.
      </div>

      <div className="mt-auto pt-4">
        <Link
          href="/about"
          onClick={onNavigate}
          className={`flex items-center gap-5 rounded-lg px-3 py-2 hover:bg-surface-hover ${
            pathname === "/about" ? "bg-surface font-semibold" : "text-muted hover:text-fg"
          }`}
        >
          <InfoIcon width={22} height={22} />
          About DataDesk
        </Link>
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            title="Collapse the menu to icons"
            className="flex w-full items-center gap-5 rounded-lg px-3 py-2 text-muted hover:bg-surface-hover hover:text-fg"
          >
            <PanelLeftIcon width={22} height={22} />
            Collapse menu
          </button>
        )}
        <Divider />
        <ApiStatus />
      </div>
    </nav>
  );
}

function Section({
  items,
  isActive,
  onNavigate,
  badgeFor,
}: {
  items: NavItem[];
  isActive: (href: string) => boolean;
  onNavigate?: () => void;
  badgeFor?: (href: string) => PendingCounts | null;
}) {
  return (
    <>
      {items.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          onClick={onNavigate}
          className={`flex items-center gap-5 rounded-lg px-3 py-2 hover:bg-surface-hover ${
            isActive(href) ? "bg-surface font-semibold" : ""
          }`}
        >
          <Icon width={22} height={22} />
          {label}
          <Badge counts={badgeFor?.(href) ?? null} />
        </Link>
      ))}
    </>
  );
}

/** The label of an icon in the collapsed rail, shown beside it while hovered or focused. */
function RailTip({ children }: { children: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-fg px-2 py-1 text-xs font-medium text-bg opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      {children}
    </span>
  );
}

function Divider() {
  return <hr className="my-3 border-line" />;
}
