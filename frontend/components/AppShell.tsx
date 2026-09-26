"use client";

import { type ReactNode, useEffect, useState } from "react";
import type { Look, Theme } from "@/lib/theme";
import type { SessionUser } from "@/lib/types";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

const SIDEBAR_KEY = "datadesk:sidebar";

// App frame: fixed top bar, sidebar (full ↔ mini on desktop, slide-over drawer on small
// screens), scrolling content area. Signed out, there is only the top bar.
export function AppShell({
  user,
  theme,
  look,
  children,
}: {
  user: SessionUser | null;
  theme: Theme;
  look: Look;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // the desktop sidebar stays the way it was left, in this browser
  useEffect(() => {
    try {
      if (window.localStorage.getItem(SIDEBAR_KEY) === "mini") setExpanded(false);
    } catch {}
  }, []);

  function setDesktop(open: boolean) {
    setExpanded(open);
    try {
      window.localStorage.setItem(SIDEBAR_KEY, open ? "full" : "mini");
    } catch {}
  }

  function toggle() {
    if (window.matchMedia("(min-width: 1024px)").matches) setDesktop(!expanded);
    else setDrawerOpen((v) => !v);
  }

  if (!user) {
    return (
      <>
        <TopBar user={null} theme={theme} look={look} />
        <main data-ui="main" className="min-h-screen pt-14">
          {children}
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar onMenu={toggle} user={user} theme={theme} look={look} />

      <aside
        data-ui="sidebar"
        data-expanded={expanded}
        className={`fixed bottom-0 left-0 top-14 z-30 hidden bg-bg lg:block ${
          // the rail's labels are tooltips that sit outside it, so it mustn't clip
          expanded ? "w-60 overflow-y-auto" : "w-[72px] overflow-visible"
        }`}
      >
        <Sidebar expanded={expanded} user={user} onToggle={() => setDesktop(!expanded)} />
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            data-ui="scrim"
            className="absolute inset-0 bg-black/50"
            onClick={() => setDrawerOpen(false)}
          />
          <aside data-ui="sidebar" data-drawer className="absolute bottom-0 left-0 top-0 w-60 overflow-y-auto bg-bg pt-3">
            <Sidebar expanded user={user} onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      <main data-ui="main" className={`min-h-screen pt-14 ${expanded ? "lg:pl-60" : "lg:pl-[72px]"}`}>
        {children}
      </main>
    </>
  );
}
