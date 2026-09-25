import { LoadHistory } from "@/components/AdminPanel";
import { requireUser } from "@/lib/guard";

export const metadata = { title: "Load history · DataDesk" };

export default async function HistoryPage() {
  await requireUser("/history");
  return <LoadHistory />;
}
