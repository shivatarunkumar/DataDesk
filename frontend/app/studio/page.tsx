import { DataStudio } from "@/components/DataStudio";
import { requireUser } from "@/lib/guard";

export const metadata = { title: "Data Studio · DataDesk" };

export default async function StudioPage() {
  await requireUser("/studio");
  return <DataStudio />;
}
