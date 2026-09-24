import { Suspense } from "react";
import { RequestsBrowser } from "@/components/RequestList";
import { requireUser } from "@/lib/guard";

export const metadata = { title: "Load requests · DataDesk" };

export default async function UploadsPage() {
  await requireUser("/uploads");
  return (
    <div className="mx-auto max-w-5xl px-4 pb-10 lg:px-6">
      <div className="py-4">
        <h1 className="text-2xl">Load requests</h1>
        <p className="mt-1 text-sm text-muted">
          Requests to load a file into a table, who asked for them, and what an admin decided.
        </p>
      </div>
      <Suspense>
        <RequestsBrowser />
      </Suspense>
    </div>
  );
}
