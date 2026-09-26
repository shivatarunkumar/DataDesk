import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { getCurrentUser } from "@/lib/session";
import { LOOK_COOKIE, type Look, THEME_COOKIE, type Theme, isLook } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "DataDesk",
  description: "Your data files in one place: edit them, version them, and load them into governed tables.",
};

export const dynamic = "force-dynamic"; // the signed-in user comes from the API at request time

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [user, jar] = await Promise.all([getCurrentUser(), cookies()]);

  // The chosen theme rides in a cookie so the server renders it on <html> itself: no
  // flash of the wrong palette, nothing to run before paint. No cookie means "Auto".
  const saved = jar.get(THEME_COOKIE)?.value;
  const theme: Theme = saved === "dark" || saved === "light" ? saved : "system";
  // the look rides the same way; no cookie means the original ("OG") look
  const savedLook = jar.get(LOOK_COOKIE)?.value;
  const look: Look = isLook(savedLook) ? savedLook : "og";

  return (
    <html lang="en" data-theme={theme === "system" ? undefined : theme} data-look={look === "og" ? undefined : look}>
      <head>
        {/* A plain stylesheet link rather than next/font: if Google Fonts is blocked the
            page still renders on the fallbacks in globals.css instead of failing the build. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&display=swap"
        />
        {/* The other looks' type (Aurora, and Inter for Glass off Apple devices). Browsers only download a font file once
            a rule uses it, so a look pays for its own fonts and OG for none of them. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&family=Inter:opsz,wght@14..32,400..700&display=swap"
        />
      </head>
      <body className="font-sans antialiased">
        <AppShell user={user} theme={theme} look={look}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
