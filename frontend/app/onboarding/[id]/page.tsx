import { TargetEditor } from "@/components/TargetEditor";
import { requireUser } from "@/lib/guard";

export const metadata = { title: "Onboarded table · DataDesk" };

export default async function TargetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/onboarding/${id}`);
  return <TargetEditor targetId={id} isAdmin={user.role === "admin"} />;
}
