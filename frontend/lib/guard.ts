import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "./session";
import type { SessionUser } from "./types";

/** The signed-in user, or a redirect to sign-in that comes back to `path`. */
export async function requireUser(path: string): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect(path === "/" ? "/login" : `/login?next=${encodeURIComponent(path)}`);
  return user;
}

/** Admin pages answer 404 to everyone else, like the API answers 403. */
export async function requireAdmin(path: string): Promise<SessionUser> {
  const user = await requireUser(path);
  if (user.role !== "admin") notFound();
  return user;
}

/** Sign-in pages send someone who is already signed in to their files. */
export async function redirectIfSignedIn(): Promise<void> {
  if (await getCurrentUser()) redirect("/");
}
