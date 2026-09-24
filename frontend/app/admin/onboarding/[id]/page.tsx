import { redirect } from "next/navigation";

export default async function OldTargetPage({ params }: { params: Promise<{ id: string }> }) {
  redirect(`/onboarding/${(await params).id}`);
}
