import { redirect } from "next/navigation";

// Load history was merged into Load requests: Everyone, filtered to decided requests.
export default function HistoryPage() {
  redirect("/uploads?scope=all&status=reviewed");
}
