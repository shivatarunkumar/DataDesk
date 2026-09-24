import { Suspense } from "react";
import { FileWorkspace } from "@/components/FileWorkspace";
import { requireUser } from "@/lib/guard";

export const metadata = { title: "File · DataDesk" };

export default async function FilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireUser(`/files/${id}`);
  return (
    <Suspense>
      <FileWorkspace fileId={id} />
    </Suspense>
  );
}
