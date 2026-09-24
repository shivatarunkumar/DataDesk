import Link from "next/link";

export default function NotFound() {
  return (
    <section className="mx-auto mt-24 max-w-md px-4 text-center">
      <h1 className="text-xl font-semibold">Nothing here</h1>
      <p className="mt-2 text-sm text-muted">That page doesn&apos;t exist, or it isn&apos;t yours to see.</p>
      <Link
        href="/"
        className="mt-6 inline-block rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-contrast hover:bg-brand-hover"
      >
        Back to my files
      </Link>
    </section>
  );
}
