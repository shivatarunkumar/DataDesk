import { About } from "@/components/About";
import { requireUser } from "@/lib/guard";

export const metadata = { title: "About · DataDesk" };

export default async function AboutPage() {
  await requireUser("/about");
  return <About />;
}
