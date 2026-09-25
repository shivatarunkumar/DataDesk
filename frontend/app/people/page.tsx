import { People } from "@/components/AdminPanel";
import { requireUser } from "@/lib/guard";

export const metadata = { title: "People · DataDesk" };

export default async function PeoplePage() {
  const user = await requireUser("/people");
  return <People viewer={user} />;
}
