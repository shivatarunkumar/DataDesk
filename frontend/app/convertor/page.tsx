import { Convertor } from "@/components/Convertor";
import { requireUser } from "@/lib/guard";

export const metadata = { title: "Convertor · DataDesk" };

export default async function ConvertorPage() {
  await requireUser("/convertor");
  return (
    <div className="mx-auto max-w-6xl px-4 pb-10 lg:px-6">
      <div className="py-4">
        <h1 className="text-2xl">Convertor</h1>
        <p className="mt-1 text-sm text-muted">Turn Excel sheets into CSV files.</p>
      </div>
      <Convertor />
    </div>
  );
}
