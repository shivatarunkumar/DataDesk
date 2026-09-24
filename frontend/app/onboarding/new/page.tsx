import { TargetEditor } from "@/components/TargetEditor";
import { requireUser } from "@/lib/guard";

export const metadata = { title: "Onboard a table · DataDesk" };

export default async function NewTargetPage() {
  const user = await requireUser("/onboarding/new");
  return <TargetEditor isAdmin={user.role === "admin"} />;
}
