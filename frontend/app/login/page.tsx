import { Suspense } from "react";
import { LoginForm } from "@/components/AuthForms";
import { redirectIfSignedIn } from "@/lib/guard";

export const metadata = { title: "Sign in · DataDesk" };

export default async function LoginPage() {
  await redirectIfSignedIn();
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
