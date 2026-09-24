import { RequestDetail } from "@/components/RequestDetail";
import { requireUser } from "@/lib/guard";

export const metadata = { title: "Load request · DataDesk" };

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/requests/${id}`);
  return <RequestDetail requestId={id} isAdmin={user.role === "admin"} />;
}
