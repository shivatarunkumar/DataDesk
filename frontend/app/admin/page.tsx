import { Suspense } from "react";
import { AdminPanel } from "@/components/AdminPanel";
import { requireAdmin } from "@/lib/guard";

export const metadata = { title: "Admin · DataDesk" };

export default async function AdminPage() {
  const admin = await requireAdmin("/admin");
  return (
    <Suspense>
      <AdminPanel adminId={admin.id} />
    </Suspense>
  );
}
