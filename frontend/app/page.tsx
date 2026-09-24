import { Suspense } from "react";
import { FileBrowser } from "@/components/FileBrowser";
import { requireUser } from "@/lib/guard";

export const metadata = { title: "My files · DataDesk" };

export default async function HomePage() {
  await requireUser("/");
  return (
    <Suspense>
      <FileBrowser />
    </Suspense>
  );
}
