import { redirect } from "next/navigation";
import { AdminPanel } from "@/components/AdminPanel";
import { requireAdmin } from "@/lib/guard";

export const metadata = { title: "Approvals · DataDesk" };

// Load history and People used to be tabs here; old links still land on them.
const MOVED: Record<string, string> = { history: "/history", people: "/people" };

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  if (tab && MOVED[tab]) redirect(MOVED[tab]);
  await requireAdmin("/admin");
  return <AdminPanel />;
}
