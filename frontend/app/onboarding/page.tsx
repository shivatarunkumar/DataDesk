import { Suspense } from "react";
import { OnboardingList } from "@/components/OnboardingList";
import { requireUser } from "@/lib/guard";

export const metadata = { title: "Onboarding · DataDesk" };

export default async function OnboardingPage() {
  const user = await requireUser("/onboarding");
  return (
    <Suspense>
      <OnboardingList isAdmin={user.role === "admin"} />
    </Suspense>
  );
}
