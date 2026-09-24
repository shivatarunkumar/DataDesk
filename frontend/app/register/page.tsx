import { RegisterForm } from "@/components/AuthForms";
import { redirectIfSignedIn } from "@/lib/guard";

export const metadata = { title: "Request an account · DataDesk" };

export default async function RegisterPage() {
  await redirectIfSignedIn();
  return <RegisterForm />;
}
