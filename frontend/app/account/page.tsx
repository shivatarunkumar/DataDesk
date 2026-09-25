import { AccountPanel } from "@/components/AccountPanel";
import { requireUser } from "@/lib/guard";

export const metadata = { title: "My account · DataDesk" };

export default async function AccountPage() {
  const user = await requireUser("/account");
  return (
    <div className="mx-auto max-w-3xl px-4 pb-10 lg:px-6">
      <div className="py-4">
        <h1 className="text-2xl">My account</h1>
        <p className="mt-1 text-sm text-muted">Who you are in DataDesk, what you can do, and asking for admin rights.</p>
      </div>
      <AccountPanel user={user} />
    </div>
  );
}
